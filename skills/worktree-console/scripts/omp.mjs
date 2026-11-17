// omp (oh-my-pi) sessions read back in Claude Code's shapes: its transcript as Claude transcript entries, its screen's input box.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OMP_GOAL_SET = /Goal mode (?:enabled|resumed)\.|Goal set\./;
// omp takes a goal as `/goal set <objective>`; Claude Code as `/goal <condition>`.
export const ompGoal = (text) => String(text).replace(/^\/goal\s+(?!set\b)/, "/goal set ");
const LARGE_WINDOW = 1_000_000;
const SMALL_WINDOW = 200_000;
const NATIVE_1M = /claude-(opus-[45]|sonnet-[45]|fable-5|mythos)/i;
const TOOL_NAMES = { ask: "AskUserQuestion", bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", glob: "Glob", task: "Task", todo: "TodoWrite" };
const STOP = { stop: "end_turn", length: "max_tokens", toolUse: "tool_use" };
const STATUS_BAR = /^\s*π\s*>/;
const BOX_HEAD = /^╰─\s?/;
const BOX_HINT = /\s{3,}\S.*$/;

export const ompHome = () => process.env.OMP_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
export const sessionsDir = () => path.join(ompHome(), "sessions");

// omp names its files <time>_<session id>.jsonl; Claude Code names them <session id>.jsonl.
export function sessionIdOf(file) {
  const base = path.basename(String(file ?? ""), ".jsonl");
  return base.match(/_([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1] ?? base;
}

export function isOmpFile(file) {
  const rel = path.relative(sessionsDir(), path.resolve(String(file ?? "")));
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return isOmpEntries(buf.toString("utf8", 0, n).split("\n").slice(0, 3).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    }));
  } catch {
    return false;
  }
}

export function isOmpEntries(entries) {
  return entries.some((e) => e?.type === "session" && typeof e.cwd === "string") || entries.some((e) => e?.type === "message" && typeof e.message?.role === "string");
}

// The transcript a session id names, searched across every project folder omp keeps.
export function findSession(id) {
  if (!id) return null;
  const walk = (dir, depth = 0) => {
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isFile() && d.name.endsWith(".jsonl") && sessionIdOf(d.name) === id) return p;
    }
    if (depth > 2) return null;
    for (const d of list) if (d.isDirectory()) {
      const hit = walk(path.join(dir, d.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(sessionsDir());
}

// herdr reports an omp session as its transcript path or as its id.
export function sessionFile(ref) {
  if (!ref) return null;
  if (ref.kind === "path") return fs.existsSync(ref.value) ? ref.value : null;
  if (ref.kind === "id") return findSession(ref.value);
  return null;
}

export function modelWindow(model) {
  return NATIVE_1M.test(String(model ?? "")) ? LARGE_WINDOW : SMALL_WINDOW;
}

const textParts = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n") : "");

function toolInput(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const file = a.path ?? a.file_path;
  if (name === "read" || name === "write" || name === "edit") return { ...a, ...(file ? { file_path: file } : {}) };
  if (name === "bash") return { ...a, command: a.command ?? a.cmd ?? "" };
  return a;
}

// Claude Code counts input, cache writes and cache reads as the prompt; omp's contextSnapshot.promptTokens is that sum.
function usageOf(m) {
  const u = m.usage ?? {};
  const read = u.cacheRead ?? 0;
  const write = u.cacheWrite ?? 0;
  const prompt = m.contextSnapshot?.promptTokens ?? (u.input ?? 0) + read + write;
  return { input_tokens: Math.max(0, prompt - read - write), cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: u.output ?? 0 };
}

// One omp transcript entry as the Claude Code entries it stands for: prompts, replies with their tool calls, tool results.
// An aborted reply is followed by Claude Code's interruption note; a failed one is an API error message.
export function claudeEntry(e, sessionId = null) {
  if (e?.type !== "message" || !e.message) return [];
  const m = e.message;
  const base = { uuid: e.id, timestamp: e.timestamp, sessionId, isSidechain: false };
  if (m.role === "user" || m.role === "developer") {
    const text = textParts(m.content);
    if (!text.trim()) return [];
    return [{ ...base, type: "user", ...(m.role === "developer" || m.attribution === "agent" ? { isMeta: true } : {}), message: { role: "user", content: [{ type: "text", text }] } }];
  }
  if (m.role === "toolResult") {
    return [{ ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: textParts(m.content), ...(m.isError ? { is_error: true } : {}) }] } }];
  }
  if (m.role !== "assistant") return [];
  const parts = Array.isArray(m.content) ? m.content : [];
  const content = parts.flatMap((p) => {
    if (p.type === "text" && p.text) return [{ type: "text", text: p.text }];
    if (p.type === "toolCall") return [{ type: "tool_use", id: p.id, name: TOOL_NAMES[p.name] ?? p.name, input: toolInput(p.name, p.arguments) }];
    return [];
  });
  const failed = m.stopReason === "error";
  if (failed) content.push({ type: "text", text: m.errorMessage || "API Error" });
  const out = [{
    ...base,
    type: "assistant",
    ...(failed ? { isApiErrorMessage: true } : {}),
    message: { role: "assistant", model: m.model, provider: m.provider, content, stop_reason: failed ? "end_turn" : STOP[m.stopReason] ?? null, usage: usageOf(m), context_window: modelWindow(m.model) },
  }];
  if (m.stopReason === "aborted") out.push({ ...base, uuid: `${e.id}-abort`, type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
  return out;
}

export function claudeEntries(entries, sessionId = null) {
  const id = sessionId ?? entries.find((e) => e?.type === "session")?.id ?? null;
  return entries.flatMap((e) => claudeEntry(e, id));
}

// Cache numbers of one omp reply, as keepalive reads Claude Code's.
export function cacheNumbers(m) {
  const u = m?.usage ?? {};
  return { cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, input: u.input ?? 0 };
}

// What sits in omp's input box: the lines after its status bar (`π > …`), the first one led by `╰─`, without the right-hand hint.
export function ompDraftOf(lines) {
  const at = (lines ?? []).findLastIndex((l) => STATUS_BAR.test(l));
  if (at < 0) return null;
  const box = lines.slice(at + 1);
  if (!BOX_HEAD.test(box[0] ?? "")) return null;
  return box
    .map((l, i) => (i === 0 ? l.replace(BOX_HEAD, "").replace(BOX_HINT, "") : l.replace(/^[│\s]+/, "")))
    .join("\n")
    .trim();
}

export const ompScreen = (lines) => ompDraftOf(lines) !== null;

// The newest omp transcript started in `cwd` at or after `since`: how a tab just opened finds its session.
export function newestSession(cwd, since = 0) {
  let want = cwd;
  try {
    want = fs.realpathSync(cwd);
  } catch {}
  const hits = [];
  const walk = (dir, depth = 0) => {
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < 2) walk(p, depth + 1);
      if (!d.isFile() || !d.name.endsWith(".jsonl")) continue;
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < since) continue;
        const head = JSON.parse(fs.readFileSync(p, "utf8").split("\n").find((l) => l.includes('"type":"session"')) ?? "null");
        let at = head?.cwd ?? null;
        try {
          at = fs.realpathSync(at);
        } catch {}
        if (at === want && Date.parse(head.timestamp ?? "") >= since - 5000) hits.push({ p, t: Date.parse(head.timestamp) });
      } catch {}
    }
  };
  walk(sessionsDir());
  return hits.sort((a, b) => b.t - a.t)[0]?.p ?? null;
}
