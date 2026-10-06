#!/usr/bin/env node
// Past a share of the real context window: the model writes a handoff note, then a fresh session takes over.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SMALL_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;
const DEFAULT_RATIO = 0.4;
const NOTE_STOPS = 2;
const TAIL_BYTES = 4 * 1024 * 1024;
const NATIVE_1M = /claude-(opus-4-[78]|opus-5|sonnet-5|fable-5|mythos)/i;
const MANUAL_COMMAND = /<command-name>\/(?:worktree-console:)?handoff<\/command-name>/;
const GOAL_SET = /Goal set/;
const GOAL_EVIDENCE = "收工前須在本 session 重新執行並貼出 `/goal` 全部證據";
const UNSUPPORTED = "自動交棒只支援 Orca 與 herdr：這個終端機兩者都不是（沒有 HERDR_ENV=1，也沒有 ORCA_TERMINAL_HANDLE），沒辦法自動開新 session。";
const ENDED = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);
const SELF = fileURLToPath(import.meta.url);
export const CACHE_HANDOFF_TEXT = "（中控台自動交棒，不是使用者的新指令）你的 prompt 快取快到期了，接下來會換新 session 接手：先不要做任何事，直接結束這一輪。";
export const KEEPALIVE_REPLY = "收到";
export const KEEPALIVE_TEXT = `（中控台自動訊息，不是使用者的新指令）只回「${KEEPALIVE_REPLY}」兩個字，不要做任何事，也不要呼叫任何工具。`;
export const TAKEOVER_HEAD = "接手交棒：";

export function handoffHome() {
  return process.env.AUTO_HANDOFF_HOME || path.join(os.homedir(), ".config", "claude-handoff");
}

function consoleRegistry() {
  return path.join(process.env.WORKTREE_CONSOLE_HOME || path.join(os.homedir(), ".config", "worktree-console"), "consoles.json");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const configFile = () => path.join(handoffHome(), "config.json");
const stateFile = (id) => path.join(handoffHome(), "sessions", `${id}.json`);
export const notePath = (id) => path.join(handoffHome(), "notes", `${id}.md`);
const eventFile = (id) => path.join(handoffHome(), "events", `${id}.json`);

export function readConfig() {
  const c = readJson(configFile(), {});
  const ratio = Number(c.ratio);
  return { enabled: c.enabled, ratio: ratio > 0 && ratio < 1 ? ratio : DEFAULT_RATIO };
}

function truthy(v) {
  return !!v && !/^(0|false|no|off)$/i.test(String(v).trim());
}

function optedOut() {
  return truthy(process.env.AUTO_HANDOFF_OFF);
}

// Sessions the worktree console opened as throwaway (a temporary worktree or an extra tab) never hand off.
export function throwaway(cwd, handle = process.env.ORCA_TERMINAL_HANDLE) {
  const list = readJson(path.join(path.dirname(consoleRegistry()), "disposable.json"), []);
  if (!Array.isArray(list)) return false;
  let here = cwd ?? "";
  try {
    here = fs.realpathSync(here);
  } catch {}
  return list.some((d) => (d.kind === "tab" && handle && d.handle === handle) || (d.kind === "worktree" && (here === d.path || here.startsWith(`${d.path}${path.sep}`))));
}

function readEntries(file, tailOnly = false) {
  let text;
  try {
    if (!tailOnly) text = fs.readFileSync(file, "utf8");
    else {
      const fd = fs.openSync(file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - TAIL_BYTES);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString("utf8");
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function settingsModel() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return readJson(path.join(dir, "settings.json"), {}).model ?? "";
}

// Same rule as Claude Code: [1m] or a native-1M model gets 1M; anything above 200k proves 1M.
export function contextWindow(model, used) {
  if (truthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)) return SMALL_WINDOW;
  const named = [model, process.env.ANTHROPIC_MODEL, settingsModel()].filter(Boolean);
  if (named.some((m) => /\[1m\]/i.test(m)) || NATIVE_1M.test(model || "") || used > SMALL_WINDOW) return LARGE_WINDOW;
  return SMALL_WINDOW;
}

export function measure(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const u = e.message?.usage;
    if (e.type !== "assistant" || e.isSidechain || !u || e.message.model === "<synthetic>") continue;
    const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const window = contextWindow(e.message.model, used);
    return { used, window, percent: Math.round((used / window) * 100), model: e.message.model };
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

// The last `/handoff` the user typed (or the handoff skill the model loaded), by entry uuid.
export function manualTrigger(entries) {
  let hit = null;
  for (const e of entries) {
    const content = e.message?.content;
    if (e.type === "user" && MANUAL_COMMAND.test(textOf(content))) hit = e.uuid ?? `line-${entries.indexOf(e)}`;
    if (e.type === "assistant" && Array.isArray(content)) {
      for (const p of content) {
        if (p.type === "tool_use" && p.name === "Skill" && /(^|:)handoff$/.test(p.input?.skill ?? "")) hit = e.uuid ?? `line-${entries.indexOf(e)}`;
      }
    }
  }
  return hit;
}

// Mirrors Claude Code's --resume rule: the last goal_status wins; met or failed means no goal.
export function activeGoal(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const a = entries[i].type === "attachment" ? entries[i].attachment : null;
    if (a?.type !== "goal_status") continue;
    if (a.met || a.failed) return null;
    return typeof a.condition === "string" && a.condition.length > 0 ? a.condition : null;
  }
  return null;
}

function proseLines(text) {
  const out = [];
  let fenced = false;
  for (const line of (text || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && !/^\s*>/.test(line)) out.push(line);
  }
  return out;
}

// The watcher's cache handoff message, when it is the last prompt: { id, question } with the reply it came after.
export function cacheTrigger(entries) {
  let at = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "user" || e.isSidechain || e.isMeta) continue;
    const text = textOf(e.message?.content).trim();
    if (!text || text.startsWith("<")) continue;
    if (text === CACHE_HANDOFF_TEXT) at = i;
    break;
  }
  if (at < 0) return null;
  return { id: entries[at].uuid ?? `line-${at}`, question: lastAssistantText(entries.slice(0, beforeKeepalive(entries, at))) || null };
}

// The keepalive exchange right before the handoff message is not the question; the reply before it is.
function beforeKeepalive(entries, at) {
  for (let i = at - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "user" || e.isSidechain || e.isMeta) continue;
    const text = textOf(e.message?.content).trim();
    if (!text || text.startsWith("<")) continue;
    return text === KEEPALIVE_TEXT ? i : at;
  }
  return at;
}

export function isQuestion(text) {
  return proseLines(text).some((l) => /[?？]/.test(l));
}

function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "assistant" && !e.isSidechain) {
      const t = textOf(e.message?.content).trim();
      if (t) return t;
    }
  }
  return "";
}

function interactive(entries) {
  return !entries.some((e) => e.entrypoint && e.entrypoint !== "cli");
}

function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…（截斷）` : text;
}

function conversation(entries) {
  return entries
    .filter((e) => (e.type === "user" || e.type === "assistant") && !e.isSidechain && !e.isMeta)
    .map((e) => ({ role: e.type, text: textOf(e.message?.content).trim() }))
    .filter((m) => m.text && !m.text.startsWith("<local-command") && !m.text.startsWith("<system-reminder>"));
}

function gitStatus(cwd) {
  const res = spawnSync("git", ["-C", cwd, "status", "--short", "--branch"], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() || "（乾淨）" : `（無法取得：${(res.stderr || "").trim() || "不是 git 目錄"}）`;
}

export function fallbackNote(entries, cwd, goal) {
  const talk = conversation(entries);
  const first = talk.find((m) => m.role === "user");
  const recent = talk.slice(-8);
  return [
    "# 交棒說明（hook 自動擷取）",
    "",
    "前一個 session 被要求寫交棒說明但連續兩次沒寫，以下由 hook 從對話紀錄機械式擷取，細節以對話原文與工作目錄現況為準。",
    "",
    "## 最初指令",
    "",
    first ? clip(first.text, 4000) : "（找不到）",
    "",
    ...(goal ? ["## /goal 原文", "", `/goal ${goal}`, ""] : []),
    "## 最後幾則對話",
    "",
    ...recent.flatMap((m) => [`### ${m.role === "user" ? "使用者" : "助理"}`, "", clip(m.text, 2000), ""]),
    "## git status",
    "",
    "```",
    gitStatus(cwd),
    "```",
    "",
  ].join("\n");
}

const APPENDIX = "## 交棒附錄（hook 自動附加）";

export function appendix({ reason, cwd, question, goal }) {
  return [
    "",
    "---",
    "",
    APPENDIX,
    "",
    `- 交棒原因：${reason}`,
    `- 工作目錄：${cwd}`,
    ...(question
      ? ["", "### 待答問題（原文）", "", "前一個 session 最後一則回覆在等使用者回答。新 session 開場先把下面這段原樣重問使用者，等使用者回答後再繼續：", "", question]
      : []),
    ...(goal
      ? ["", "### /goal", "", "新 session 會收到同一段 /goal：", "", `/goal ${goal}`, "", `${GOAL_EVIDENCE}；前一個 session 貼過的證據不算。`]
      : []),
    "",
  ].join("\n");
}

function askReason(p) {
  const why = p.manual ? "使用者要求現在交棒" : p.cache ? "prompt 快取快到期，使用者還沒回來" : `context 用量 ${p.percent}%（門檻 ${Math.round(p.ratio * 100)}%，上限 ${p.window.toLocaleString("en-US")} tokens）`;
  return [
    `自動交棒：${why}。不要再開始新的工作；把交棒說明用 Write 寫到 ${p.note}（Markdown），寫完就結束這一輪，不必回覆其他內容。`,
    "交棒說明是給接手的新 session 看的，要讓它不回頭問就能接著做，至少包含：",
    "1. 任務目標與範圍（含使用者原始要求的關鍵原話、非目標）",
    "2. 已完成的事與證據（改了哪些檔、跑過哪些指令與結果）",
    "3. 進行中、還沒做完的事",
    "4. 下一步（具體到第一個動作）",
    "5. 已做的決定與理由、踩過的坑、不要再試的方法",
    "6. 使用者的偏好與限制",
    ...(p.question ? ["你最後一則回覆在等使用者回答；hook 會把那則原文附在交棒說明最後，新 session 會先原樣重問，你不用重寫。"] : []),
    ...(p.goal ? ["本 session 有進行中的 /goal，新 session 會收到同一段 /goal；說明裡寫清楚哪些證據已經展示過、哪些還沒。"] : []),
  ].join("\n");
}

function remindReason(p) {
  return `自動交棒：還沒看到交棒說明 ${p.note}。請現在用 Write 寫好（內容要求同上一則），寫完就結束這一輪；再停一次仍沒有檔案，hook 會自己擷取一份並照樣交棒。`;
}

export function takeoverInstruction({ note, question, goal, isConsole, cache = false }) {
  if (cache && question && !goal && !isConsole) {
    return `${TAKEOVER_HEAD}先完整讀 ${note} 。讀完後第一則回覆只原樣貼出交棒說明最後〈待答問題（原文）〉那段，不加任何前言、說明或結語，貼完就停下等使用者回答，回答後再照交棒說明接著做。`;
  }
  const parts = [`${TAKEOVER_HEAD}先完整讀 ${note} ，第一則回覆先用兩三句引用交棒說明裡的進度與下一步（標明「依交棒說明」），不要回頭問說明裡已經講清楚的事。`];
  if (isConsole) parts.push("你是 worktree-console 中控台：讀完後載入 worktree-console:worktree-console skill，照〈硬需求與啟動〉重新啟動，第 6 步掛 watcher 時直接加 --takeover。");
  if (question) parts.push("交棒說明最後有〈待答問題（原文）〉：引用完先把那段原文原樣重問使用者，等使用者回答再繼續，不要自己往下做。");
  if (goal) parts.push(question ? "之後會收到 /goal 指令，照它做，但先等使用者回答這題。" : "引用完就停下，接著會收到 /goal 指令，收到後照它做。");
  else if (!isConsole) parts.push("引用完照交棒說明的下一步接著做。");
  return parts.join("");
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

function tellUser(message) {
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

// The tab this session runs in: herdr first, then Orca; null in any other terminal.
export function terminalOf(env = process.env) {
  if (env.HERDR_ENV === "1") return { kind: "herdr", handle: env.HERDR_PANE_ID ?? null, paneKey: env.HERDR_PANE_ID ?? null };
  if (env.ORCA_TERMINAL_HANDLE) return { kind: "orca", handle: env.ORCA_TERMINAL_HANDLE, paneKey: env.ORCA_PANE_KEY ?? null };
  return null;
}

function orcaBin() {
  return process.env.ORCA_BIN || "orca";
}

function orca(args) {
  const res = spawnSync(orcaBin(), [...args, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { ok: false, error: { code: "unreachable", message: res.error.message } };
  try {
    const parsed = JSON.parse(res.stdout);
    if (parsed.ok === false) return { ok: false, error: parsed.error ?? { code: "unknown" } };
    return { ok: true, result: parsed.result ?? {} };
  } catch {
    return { ok: false, error: { code: "unreachable", message: (res.stderr || res.stdout || "").trim() } };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = () => Number(process.env.AUTO_HANDOFF_POLL_MS || 2000);

async function until(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = check();
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await sleep(POLL());
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function findTerminal(handle) {
  const res = orca(["terminal", "list"]);
  return res.ok ? (res.result.terminals ?? []).find((t) => t.handle === handle) ?? null : null;
}

function paneAgent(paneKey) {
  const res = orca(["worktree", "ps"]);
  if (!res.ok) return null;
  return (res.result.worktrees ?? []).flatMap((w) => w.agents ?? []).find((a) => a.paneKey === paneKey) ?? null;
}

// Orca keeps only the first 200 characters of a prompt.
function sameInstruction(prompt, instruction) {
  const got = (prompt ?? "").trim();
  return got === instruction || (Array.from(got).length >= 40 && instruction.startsWith(got));
}

function screen(handle) {
  const res = orca(["terminal", "read", "--terminal", handle, "--screen"]);
  return res.ok ? (res.result.terminal?.tail ?? []).join("\n") : "";
}

function updateEvent(id, patch) {
  const file = eventFile(id);
  writeJson(file, { ...readJson(file, {}), ...patch, updatedAt: Date.now() });
}

function isRegisteredConsole(handle) {
  const list = readJson(consoleRegistry(), []);
  return Array.isArray(list) && list.includes(handle);
}

function swapConsole(oldHandle, newHandle) {
  const list = readJson(consoleRegistry(), []);
  const next = [...new Set([...(Array.isArray(list) ? list : []).filter((h) => h !== oldHandle), newHandle])];
  writeJson(consoleRegistry(), next);
}

function failer(ctx) {
  const { session, note, goal } = ctx;
  return (step, detail) => {
    updateEvent(session, { status: "failed", step, detail });
    tellUser(
      [
        `自動交棒失敗：卡在「${step}」${detail ? `（${detail}）` : ""}。舊分頁保留，可以繼續在這裡工作。`,
        `交棒說明：${note}`,
        ...(ctx.newHandle ? [`新分頁 ${ctx.newHandle} 已開，不需要就自行關掉。`] : []),
        ...(goal ? [`/goal 原文：/goal ${goal}`] : []),
      ].join("\n"),
    );
  };
}

// Every step must succeed before the old tab closes; on failure the old tab stays and the step is named.
async function orcaHandoff(ctx) {
  const { session, oldHandle, cwd, mode, note, goal, question, isConsole, cache } = ctx;
  const steps = [];
  const fail = failer(ctx);

  const term = findTerminal(oldHandle);
  const worktree = term?.worktreePath || cwd;
  const command = `cd ${shellQuote(cwd)} && claude${mode ? ` --permission-mode ${shellQuote(mode)}` : ""}`;
  steps.push("開新分頁");
  const created = orca(["terminal", "create", "--worktree", `path:${worktree}`, "--command", command]);
  const newTerm = created.ok ? created.result.terminal : null;
  if (!newTerm?.handle) return fail("開新分頁", created.error?.code);
  ctx.newHandle = newTerm.handle;
  const listed = newTerm.paneKey || newTerm.leafId ? newTerm : findTerminal(newTerm.handle) ?? {};
  const newPane = newTerm.paneKey ?? (listed.tabId && listed.leafId ? `${listed.tabId}:${listed.leafId}` : null);
  updateEvent(session, { status: "switching", newHandle: newTerm.handle, newPaneKey: newPane });

  const ready = orca(["terminal", "wait", "--terminal", newTerm.handle, "--for", "tui-idle", "--timeout-ms", String(Number(process.env.AUTO_HANDOFF_READY_MS || 60000))]);
  if (!ready.ok || JSON.stringify(ready.result).includes('"satisfied":false')) return fail("等新分頁就緒", ready.error?.code ?? "not-ready");

  const instruction = takeoverInstruction({ note, question, goal, isConsole, cache });
  const sent = orca(["terminal", "send", "--terminal", newTerm.handle, "--text", instruction, "--enter"]);
  if (!sent.ok || sent.result?.send?.accepted === false) return fail("送出接手指令", sent.error?.code ?? "not-accepted");

  const arrived = await until(() => {
    const a = newPane ? paneAgent(newPane) : null;
    return a && sameInstruction(a.prompt, instruction) ? a : null;
  }, Number(process.env.AUTO_HANDOFF_DELIVER_MS || 60000));
  if (!arrived) return fail("確認接手指令送達", "新 session 沒收到接手指令");

  if (goal) {
    const read = await until(() => paneAgent(newPane)?.state === "done", Number(process.env.AUTO_HANDOFF_FIRST_TURN_MS || 600000));
    if (!read) return fail("等新 session 讀完交棒說明", "逾時");
    const goalSent = orca(["terminal", "send", "--terminal", newTerm.handle, "--text", `/goal ${goal}`, "--enter"]);
    if (!goalSent.ok || goalSent.result?.send?.accepted === false) return fail("送出 /goal", goalSent.error?.code ?? "not-accepted");
    const set = await until(() => GOAL_SET.test(screen(newTerm.handle)), Number(process.env.AUTO_HANDOFF_GOAL_MS || 30000));
    if (!set) {
      const pasted = /Pasted text|paste again to expand/i.test(screen(newTerm.handle));
      return fail("確認 Goal set", pasted ? "/goal 被當成貼上內容收起，請先清空新分頁的輸入框再貼" : "新分頁畫面沒出現 Goal set");
    }
  }

  if (isConsole) swapConsole(oldHandle, newTerm.handle);
  updateEvent(session, { status: "done" });
  const closer = spawn(orcaBin(), ["terminal", "close", "--terminal", oldHandle, "--tab", "--json"], { detached: true, stdio: "ignore" });
  closer.unref();
}

function herdrBin() {
  return process.env.HERDR_BIN || "herdr";
}

function herdr(args, { raw = false } = {}) {
  const res = spawnSync(herdrBin(), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { ok: false, error: { code: "unreachable", message: res.error.message } };
  const parse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };
  if (res.status === 0) {
    if (raw) return { ok: true, text: res.stdout };
    const out = parse(res.stdout);
    if (out && "result" in out) return { ok: true, result: out.result ?? {} };
  }
  return { ok: false, error: (parse(res.stderr) ?? parse(res.stdout))?.error ?? { code: "unreachable" } };
}

function projectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

// The new pane's conversation, through the session id herdr reports for it.
function paneTranscript(pane) {
  const got = herdr(["agent", "get", pane]);
  const id = got.ok && got.result?.agent?.agent_session?.kind === "id" ? got.result.agent.agent_session.value : null;
  if (!id) return { status: got.ok ? got.result?.agent?.agent_status : null, entries: [] };
  let entries = [];
  try {
    for (const d of fs.readdirSync(projectsDir())) {
      const f = path.join(projectsDir(), d, `${id}.jsonl`);
      if (fs.existsSync(f)) entries = readEntries(f);
    }
  } catch {}
  return { status: got.result.agent.agent_status, entries: entries.filter((e) => !e.isSidechain && (e.type === "user" || e.type === "assistant")) };
}

const received = (entries, instruction) => entries.some((e) => e.type === "user" && !e.isMeta && textOf(e.message?.content).trim() === instruction.trim());

function herdrScreen(pane) {
  const res = herdr(["pane", "read", pane, "--source", "visible"], { raw: true });
  return res.ok ? res.text : "";
}

// herdr's version of the same steps: a tab in this workspace, claude started in it, prompts through `agent prompt`.
async function herdrHandoff(ctx) {
  const { session, oldHandle, cwd, mode, note, goal, question, isConsole, cache } = ctx;
  const fail = failer(ctx);
  const ws = process.env.HERDR_WORKSPACE_ID;
  const tab = herdr(["tab", "create", ...(ws ? ["--workspace", ws] : []), "--cwd", cwd, "--no-focus"]);
  const pane = tab.ok ? tab.result?.root_pane?.pane_id : null;
  if (!pane) return fail("開新分頁", tab.error?.code);
  ctx.newHandle = pane;
  updateEvent(session, { status: "switching", newHandle: pane, newPaneKey: pane });

  const name = `h-${pane.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 32);
  const ready = herdr(["agent", "start", name, "--kind", "claude", "--pane", pane, "--timeout", String(Number(process.env.AUTO_HANDOFF_READY_MS || 60000)), ...(mode ? ["--", "--permission-mode", mode] : [])]);
  if (!ready.ok) return fail("等新分頁就緒", ready.error?.code ?? "not-ready");

  const instruction = takeoverInstruction({ note, question, goal, isConsole, cache });
  const sent = herdr(["agent", "prompt", pane, instruction]);
  if (!sent.ok) return fail("送出接手指令", sent.error?.code ?? "not-accepted");

  const arrived = await until(() => received(paneTranscript(pane).entries, instruction), Number(process.env.AUTO_HANDOFF_DELIVER_MS || 60000));
  if (!arrived) return fail("確認接手指令送達", "新 session 沒收到接手指令");

  if (goal) {
    const read = await until(() => {
      const t = paneTranscript(pane);
      const last = t.entries.at(-1);
      return ["done", "idle"].includes(t.status) && last?.type === "assistant" && ENDED.has(last.message?.stop_reason);
    }, Number(process.env.AUTO_HANDOFF_FIRST_TURN_MS || 600000));
    if (!read) return fail("等新 session 讀完交棒說明", "逾時");
    const goalSent = herdr(["agent", "prompt", pane, `/goal ${goal}`]);
    if (!goalSent.ok) return fail("送出 /goal", goalSent.error?.code ?? "not-accepted");
    const set = await until(() => GOAL_SET.test(herdrScreen(pane)), Number(process.env.AUTO_HANDOFF_GOAL_MS || 30000));
    if (!set) {
      const pasted = /Pasted text|paste again to expand/i.test(herdrScreen(pane)) || /<pasted_content/.test(textOf(paneTranscript(pane).entries.filter((e) => e.type === "user" && !e.isMeta).at(-1)?.message?.content));
      return fail("確認 Goal set", pasted ? "/goal 被當成貼上內容收起，請先清空新分頁的輸入框再貼" : "新分頁畫面沒出現 Goal set");
    }
  }

  if (isConsole) swapConsole(oldHandle, pane);
  updateEvent(session, { status: "done" });
  const closer = spawn(herdrBin(), ["pane", "close", oldHandle], { detached: true, stdio: "ignore" });
  closer.unref();
}

async function stop(input) {
  const session = input.session_id;
  if (!session || !input.transcript_path) return;
  let st = readJson(stateFile(session), {});
  const entries = readEntries(input.transcript_path, true);
  if (!interactive(entries)) return;
  const trigger = manualTrigger(entries);
  const cacheHit = cacheTrigger(entries);
  const cache = !!cacheHit && cacheHit.id !== st.consumed;
  const manual = !cache && !!trigger && trigger !== st.consumed;
  if (st.done && !manual && !cache) return;
  if (st.done) st = { consumed: st.consumed };

  if (!st.pending) {
    const m = measure(entries);
    const cfg = readConfig();
    if (!manual && !cache) {
      if (optedOut() || cfg.enabled !== true || !m || throwaway(input.cwd)) return;
      if (m.used < cfg.ratio * m.window) return;
    }
    const last = input.last_assistant_message ?? lastAssistantText(entries);
    st.pending = {
      since: Date.now(),
      stops: 0,
      manual,
      cache,
      percent: m?.percent ?? null,
      window: m?.window ?? null,
      ratio: cfg.ratio,
      question: cache ? cacheHit.question : !manual && isQuestion(last) ? last : null,
    };
    if (manual) st.consumed = trigger;
    if (cache) st.consumed = cacheHit.id;
    const full = readEntries(input.transcript_path);
    st.pending.goal = activeGoal(full);
    writeJson(stateFile(session), st);
    const term = terminalOf();
    if (term?.handle) {
      updateEvent(session, {
        status: "writing",
        oldHandle: term.handle,
        oldPaneKey: term.paneKey,
        cwd: input.cwd,
        percent: st.pending.percent,
        cache,
        isConsole: isRegisteredConsole(term.handle),
      });
    }
    return block(askReason({ ...st.pending, note: notePath(session) }));
  }

  const p = st.pending;
  const note = notePath(session);
  const written = fs.existsSync(note) && fs.statSync(note).mtimeMs >= p.since - 1000;
  if (!written) {
    p.stops += 1;
    if (p.stops < NOTE_STOPS) {
      writeJson(stateFile(session), st);
      return block(remindReason({ note }));
    }
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, fallbackNote(readEntries(input.transcript_path), input.cwd, p.goal));
    p.fallback = true;
  }
  const reason = p.manual ? "使用者手動交棒" : p.cache ? "prompt 快取將到期" : `context 用量 ${p.percent}%（上限 ${p.window} tokens）`;
  if (!fs.readFileSync(note, "utf8").includes(APPENDIX)) {
    fs.appendFileSync(note, appendix({ reason, cwd: input.cwd, question: p.question, goal: p.goal }));
  }
  st.done = true;
  writeJson(stateFile(session), st);

  const term = terminalOf();
  const oldHandle = term?.handle;
  if (!oldHandle) {
    return tellUser(
      [
        UNSUPPORTED,
        `自動交棒：${reason}，交棒說明已寫好：${note}`,
        `請開一個新的 claude session（同一個工作目錄），第一句輸入：讀 ${note} 接手`,
        ...(p.goal ? ["接著送出同一段 /goal：", `/goal ${p.goal}`] : []),
        "本 session 之後不會再提示。",
      ].join("\n"),
    );
  }
  await (term.kind === "herdr" ? herdrHandoff : orcaHandoff)({
    session,
    oldHandle,
    cwd: input.cwd,
    mode: input.permission_mode,
    note,
    goal: p.goal,
    question: p.question,
    isConsole: isRegisteredConsole(oldHandle),
    cache: !!p.cache,
  });
}

// The note lives outside the project, so default permission mode would stop to ask before writing it.
function preToolUse(input) {
  const file = input.tool_input?.file_path;
  if (!input.session_id || !file || path.resolve(file) !== notePath(input.session_id)) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "auto-handoff note" } }),
  );
}

function sessionStart() {
  if (optedOut()) return;
  if (readConfig().enabled !== undefined) return;
  const cmd = `node ${shellQuote(SELF)}`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: [
          "auto-handoff（自動交棒）還沒設定過。先照常處理使用者的要求，在你這個 session 第一則回覆的最後用一句話問使用者一次：",
          "「要不要開啟自動交棒？開啟後 context 用到模型上限的 40% 時，會先寫交棒說明，再自動開新 session 接手並關掉舊的（Orca 與 herdr 以外只寫說明並提示你）。」",
          `使用者回答要就執行 \`${cmd} enable\`，不要就執行 \`${cmd} disable\`；答案會永久記住，之後的 session 不再問。比例可用 \`${cmd} ratio 0.3\` 調整。`,
        ].join("\n"),
      },
    }),
  );
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function configure(command, value) {
  const c = readJson(configFile(), {});
  if (command === "enable") c.enabled = true;
  if (command === "disable") c.enabled = false;
  if (command === "ratio") {
    const n = Number(String(value ?? "").replace("%", ""));
    const ratio = n >= 1 ? n / 100 : n;
    if (!(ratio > 0 && ratio < 1)) {
      console.log("用法：auto-handoff.mjs ratio <0~1 之間的小數，或 1~99 的百分比>");
      process.exit(1);
    }
    c.ratio = ratio;
  }
  if (command !== "status") writeJson(configFile(), c);
  const cfg = readConfig();
  console.log(`auto-handoff：${cfg.enabled === true ? "開啟" : cfg.enabled === false ? "關閉" : "未設定"}，門檻 ${Math.round(cfg.ratio * 100)}%（設定檔 ${configFile()}）`);
}

const [command, value] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    if (command === "stop") await stop(readStdin());
    else if (command === "session-start") sessionStart();
    else if (command === "pre-tool-use") preToolUse(readStdin());
    else if (["enable", "disable", "ratio", "status"].includes(command)) configure(command, value);
    else {
      console.log("用法：auto-handoff.mjs <stop|session-start|enable|disable|ratio <n>|status>");
      process.exit(1);
    }
  } catch (error) {
    if (["stop", "session-start", "pre-tool-use"].includes(command)) process.stderr.write(`auto-handoff: ${error?.message ?? error}\n`);
    else throw error;
  }
}
