#!/usr/bin/env node
// Tells the model its own context usage when it crosses a band (30/50/70% by default), so a session that nobody watches can wrap up in time. Off until `enable`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handoffHome, interactive, measure, readConfig, readEntries, readJson, throwaway, truthy } from "./auto-handoff.mjs";

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_BANDS = [30, 50, 70];

const configFile = () => path.join(handoffHome(), "config.json");
const stateFile = (id) => path.join(handoffHome(), "context", `${id}.json`);

// Temp file plus rename: a hook that dies halfway never leaves a torn file for the next call.
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function validBands(list) {
  const bands = [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 99))].sort((a, b) => a - b);
  return bands.length > 0 ? bands : null;
}

export function readNotice() {
  const n = readJson(configFile(), {}).notice;
  return { enabled: n?.enabled === true, bands: validBands(n?.bands) ?? DEFAULT_BANDS };
}

// Which bands this reading newly crosses. A drop (/compact, /clear) forgets the bands above the new level so they can fire again.
export function crossing(bands, percent, notified = []) {
  const kept = notified.filter((b) => b <= percent);
  const reached = bands.filter((b) => b <= percent);
  const fresh = reached.filter((b) => !kept.includes(b));
  return { notified: reached, top: fresh.length > 0 ? fresh[fresh.length - 1] : null };
}

export function noticeText(m, handoffRatio) {
  const handoff = handoffRatio ? `自動交棒門檻 ${Math.round(handoffRatio * 100)}%，到了會要你寫交棒說明。` : "";
  return `（中控台自動訊息，不是使用者的新指令）context 已用 ${m.percent}%（${m.used.toLocaleString("en-US")} / ${m.window.toLocaleString("en-US")} tokens）。${handoff}只是讓你知道用量，不用回覆這則訊息，照原本的工作繼續；用量越高，越該先收斂手上的步驟並把進度寫下來。`;
}

function postToolOrPrompt(event, input) {
  const session = input.session_id;
  if (!session || !input.transcript_path) return;
  if (truthy(process.env.AUTO_HANDOFF_OFF) || throwaway(input.cwd)) return;
  const notice = readNotice();
  if (!notice.enabled) return;

  if (!fs.existsSync(input.transcript_path)) return;
  const size = fs.statSync(input.transcript_path).size;
  const prev = readJson(stateFile(session), {});
  if (prev.size === size) return;

  const entries = readEntries(input.transcript_path, true);
  const m = measure(entries);
  if (!m) return;
  const { notified, top } = crossing(notice.bands, m.percent, prev.notified);
  writeAtomic(stateFile(session), { ...m, at: new Date().toISOString(), size, notified });
  if (top === null) return;
  const cfg = readConfig();
  const handoffRatio = cfg.enabled === true && interactive(entries) ? cfg.ratio : null;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: noticeText(m, handoffRatio) } }));
}

function newestState() {
  const dir = path.join(handoffHome(), "context");
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
    return files.map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f ?? null;
  } catch {
    return null;
  }
}

function show(id) {
  const file = id ? stateFile(id) : newestState();
  const s = file ? readJson(file, null) : null;
  if (!s) return console.log("還沒有 context 用量紀錄（要先開啟通知，且 session 至少用過一次工具或送過一則訊息）。");
  console.log(`context 用量：${s.percent}%（${s.used.toLocaleString("en-US")} / ${s.window.toLocaleString("en-US")} tokens，${s.model}），已通知門檻：${s.notified.length > 0 ? s.notified.join("、") + "%" : "無"}，更新於 ${s.at}（${file}）`);
}

function configure(command, args) {
  const c = readJson(configFile(), {});
  const notice = { ...c.notice };
  if (command === "enable") notice.enabled = true;
  if (command === "disable") notice.enabled = false;
  if (command === "bands") {
    const bands = validBands(args.join(",").split(/[\s,]+/).filter(Boolean));
    if (!bands) {
      console.log("用法：context-notice.mjs bands <1~99 的百分比，用逗號或空白隔開，例如 30,50,70>");
      process.exit(1);
    }
    notice.bands = bands;
  }
  if (command !== "status") writeAtomic(configFile(), { ...c, notice });
  const now = readNotice();
  console.log(`context 用量通知：${now.enabled ? "開啟" : "關閉"}，門檻 ${now.bands.join("、")}%（設定檔 ${configFile()}）`);
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const [command, ...args] = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    if (command === "post-tool-use") postToolOrPrompt("PostToolUse", readStdin());
    else if (command === "user-prompt") postToolOrPrompt("UserPromptSubmit", readStdin());
    else if (command === "show") show(args[0]);
    else if (["enable", "disable", "bands", "status"].includes(command)) configure(command, args);
    else {
      console.log("用法：context-notice.mjs <post-tool-use|user-prompt|show [session id]|enable|disable|bands <n,n,n>|status>");
      process.exit(1);
    }
  } catch (error) {
    if (["post-tool-use", "user-prompt"].includes(command)) process.stderr.write(`context-notice: ${error?.message ?? error}\n`);
    else throw error;
  }
}
