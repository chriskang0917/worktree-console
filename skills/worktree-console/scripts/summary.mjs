#!/usr/bin/env node
// A plain-language recap of each managed child session's last reply: the Stop hook hands it to a detached worker, which asks
// `claude -p` once and saves the newest recap per tab. The child tab and the console pane draw it; every call's usage is logged.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MS = 120_000;
// A worker that died without clearing its marker stops counting as running after its timeout and this much more.
const PENDING_SLACK_MS = 60_000;
const INPUT_MAX = 40_000;
const TAIL_BYTES = 2 * 1024 * 1024;
const TERMINAL_ENV = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY"];

export const SYSTEM_PROMPT = [
  "你把一個 coding agent 剛結束的這一輪回覆，摘要成給開發者本人看的繁體中文白話摘要。",
  "只寫這四行，照這個順序，每行用標籤開頭：",
  "前提：這一輪在做什麼、現在的狀況。",
  "問題：卡住或要開發者決定的事；沒有就整行省略。",
  "解法：做了什麼，或打算怎麼做。",
  "建議：回覆裡建議的下一步或選擇，選項寫出內容不只寫字母；回覆沒有給建議時寫「要你決定：<要回答什麼>」，不要自己替開發者選。",
  "寫法：",
  "1. 每行只講一件事，不超過 30 個中文字（反引號裡的內容、英文技術名詞各算 1 字）。",
  "2. 用主動語態和動詞，寫「檢查」不寫「進行檢查」，少用「被」「由…」。",
  "3. 只留做決定需要的資訊：檔名、測試數字、指令細節不重要就省略；只有這次對話懂的代號不要出現。",
  "4. 不加標題、前言或結語，不用 Markdown。",
  "只輸出這幾行。",
].join("\n");

export const summaryHome = () => process.env.WORKTREE_CONSOLE_HOME || path.join(os.homedir(), ".config", "worktree-console");
const dirOf = (home) => path.join(home, "summaries");
const slug = (handle) => encodeURIComponent(handle);
export const summaryFile = (home, handle) => path.join(dirOf(home), `${slug(handle)}.json`);
export const pendingFile = (home, handle) => path.join(dirOf(home), `${slug(handle)}.pending.json`);
export const usageFile = (home) => path.join(home, "summary-usage.jsonl");
const timeoutMs = () => Number(process.env.WORKTREE_CONSOLE_SUMMARY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// config.json's `summaryModel`, so the model changes without touching code.
export function summaryModel(home = summaryHome()) {
  const value = readJson(path.join(home, "config.json"), {})?.summaryModel;
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_MODEL;
}

export function modelCommand(model) {
  const custom = process.env.WORKTREE_CONSOLE_SUMMARY_CMD;
  if (custom) return { cmd: "sh", args: ["-c", custom] };
  return {
    cmd: "claude",
    args: [
      "-p",
      "--model", model,
      "--output-format", "json",
      "--system-prompt", SYSTEM_PROMPT,
      "--tools", "",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--settings", '{"disableAllHooks":true}',
    ],
  };
}

// The tab's newest recap and whether a newer one is being written: { text, at, sessionId, pending }.
export function readSummary(home, handle, now = Date.now()) {
  if (!handle) return { text: null, at: null, sessionId: null, pending: false };
  const saved = readJson(summaryFile(home, handle));
  const marker = readJson(pendingFile(home, handle));
  const pending = !!marker && now - (marker.since ?? 0) < (marker.timeoutMs ?? timeoutMs()) + PENDING_SLACK_MS;
  return { text: saved?.text ?? null, at: saved?.at ?? null, sessionId: saved?.sessionId ?? null, pending };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

function lastReply(transcript) {
  let text = "";
  try {
    const fd = fs.openSync(transcript, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const t = e.type === "assistant" && !e.isSidechain ? textOf(e.message?.content).trim() : "";
      if (t) return t;
    } catch {}
  }
  return "";
}

function clipInput(text) {
  const chars = Array.from(text);
  return chars.length > INPUT_MAX ? `${chars.slice(0, INPUT_MAX).join("")}…（後面截掉）` : text;
}

export function summaryPrompt(reply) {
  return `以下是這一輪的回覆原文，請照規則摘要：\n\n<reply>\n${clipInput(reply)}\n</reply>`;
}

function usageLine(parsed) {
  const u = parsed?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    totalCostUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
    models: Object.keys(parsed.modelUsage ?? {}),
  };
}

function parseOutput(stdout) {
  try {
    return JSON.parse(String(stdout ?? "").trim());
  } catch {
    return null;
  }
}

// One call, never retried: a recap only replaces the saved one when it has text; a call that reported usage is logged either way.
export function runSummary({ home = summaryHome(), handle, sessionId, since }) {
  const marker = readJson(pendingFile(home, handle));
  if (!marker || marker.since !== since) return { ok: false, reason: "superseded" };
  const model = marker.model ?? summaryModel(home);
  const { cmd, args } = modelCommand(model);
  const env = { ...process.env, WORKTREE_CONSOLE_SUMMARY_MODEL: model, WORKTREE_CONSOLE_SUMMARY_CHILD: "1" };
  for (const k of TERMINAL_ENV) delete env[k];
  const res = spawnSync(cmd, args, { input: summaryPrompt(marker.reply ?? ""), encoding: "utf8", env, cwd: os.tmpdir(), timeout: marker.timeoutMs ?? timeoutMs(), killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  const timedOut = res.error?.code === "ETIMEDOUT" || !!res.signal;
  const parsed = timedOut ? null : parseOutput(res.stdout);
  const text = !timedOut && res.status === 0 && parsed && !parsed.is_error && typeof parsed.result === "string" ? parsed.result.trim() : "";
  const ok = !!text;
  const reason = ok ? null : timedOut ? "timeout" : res.status !== 0 ? `exit ${res.status}` : "empty";
  const usage = usageLine(parsed);
  if (usage) {
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.appendFileSync(usageFile(home), `${JSON.stringify({ ts: new Date().toISOString(), sessionId, handle, model, ok, ...(reason ? { reason } : {}), ...usage })}\n`);
    } catch {}
  }
  const saved = readJson(summaryFile(home, handle));
  if (ok && !(saved?.since > since)) writeJson(summaryFile(home, handle), { text, at: Date.now(), since, sessionId, handle, model });
  if (readJson(pendingFile(home, handle))?.since === since) fs.rmSync(pendingFile(home, handle), { force: true });
  return { ok, reason, text };
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function terminalHandle() {
  if (process.env.HERDR_ENV === "1") return process.env.HERDR_PANE_ID || null;
  return process.env.ORCA_TERMINAL_HANDLE || null;
}

function consoleHandles(home) {
  const list = readJson(path.join(home, "consoles.json"), []);
  return Array.isArray(list) ? list : [];
}

// A tab a console hands over to is the console before it registers.
function consoleTakeover(handle) {
  const dir = path.join(process.env.AUTO_HANDOFF_HOME || path.join(os.homedir(), ".config", "claude-handoff"), "events");
  try {
    return fs.readdirSync(dir).some((f) => {
      const ev = readJson(path.join(dir, f), {});
      return ev?.isConsole === true && ev.newHandle === handle && ev.status !== "failed";
    });
  } catch {
    return false;
  }
}

// Stop hook: only a child session the console manages, never the console; writes the marker, starts the worker, prints nothing.
export async function stopHook(input, { home = summaryHome(), now = Date.now() } = {}) {
  if (process.env.WORKTREE_CONSOLE_SUMMARY_CHILD === "1") return null;
  const handle = terminalHandle();
  if (!handle || !input?.cwd || !input.session_id) return null;
  if (consoleHandles(home).includes(handle) || consoleTakeover(handle)) return null;
  const { managedTarget } = await import("./log.mjs");
  if (!managedTarget(realpath(input.cwd), handle)) return null;
  const reply = String(input.last_assistant_message ?? "").trim() || (input.transcript_path ? lastReply(input.transcript_path) : "");
  if (!reply) return null;
  const since = now;
  writeJson(pendingFile(home, handle), { since, sessionId: input.session_id, model: summaryModel(home), timeoutMs: timeoutMs(), reply });
  const child = spawn(process.execPath, [SELF, "run", "--handle", handle, "--session", input.session_id, "--since", String(since)], {
    detached: true,
    stdio: "ignore",
    cwd: os.tmpdir(),
    env: { ...process.env, WORKTREE_CONSOLE_HOME: home },
  });
  child.unref();
  return { handle, since };
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "stop") await stopHook(readStdin());
    else if (command === "run") runSummary({ handle: flag(rest, "--handle"), sessionId: flag(rest, "--session"), since: Number(flag(rest, "--since")) });
  } catch {}
}
