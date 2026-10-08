import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clip, isConsoleSession, readEvents, transcriptFor, writeManaged } from "./log.mjs";
import { CACHE_HANDOFF_TEXT, KEEPALIVE_TEXT, TAKEOVER_HEAD } from "../../../hooks/auto-handoff.mjs";
import { habitCell, habitFor, itemScene, memoryContext, memoryNotes, proposalLines, unreadableNotes } from "./memory.mjs";
import { maybeTerminals, terminals } from "./terminals.mjs";

export { orcaBin, runOrca } from "./terminals.mjs";

export const LABEL = {
  busy: "🔄 執行中",
  waiting: "💬 等待回應",
  permission: "🔐 等待授權",
  done: "⏸ 回覆完畢",
  idle: "💤 閒置",
};

// herdr mode adds a sixth state: herdr says the session is stuck and its transcript cannot tell on what.
export const LABELS = { ...LABEL, anomaly: "⚠️ session 異常，需手動排程" };

const URGENCY = ["anomaly", "permission", "busy", "waiting", "done", "idle"];
const NEEDS_YOU = new Set(["anomaly", "permission", "waiting", "done"]);
const CELL_MAX = 30;
export const BOARD_WIDTH = 100;
export const STAGE = { idle: "未開工", planning: "規劃中", implementing: "實作中", pushed: "已推送" };
const PLAN_DIR = "docs/dev-flow";
const NOT_PLAN = [":(top)", `:(top,exclude)${PLAN_DIR}`];
const BOARD_HEAD = ["狀態", "票號", "摘要", "階段", "最後動態"];
const MIN_CLIP = 8;
const KEY_STOPWORDS = new Set(["release", "hotfix", "v", "rc", "build", "version"]);
const MENU_TOOL = "AskUserQuestion";
const menuOpen = (agent) => agent?.toolName === MENU_TOOL && agent.state !== "done";
const NICKNAME = /^[a-z]{3,8}$/i;
export const ALIAS = /^[a-z]{3,5}$/;
const CLIP_BRANCH = 8;

export function consoleHome() {
  return process.env.WORKTREE_CONSOLE_HOME || path.join(os.homedir(), ".config", "worktree-console");
}

const REGISTRY = "consoles.json";

function readRegistry() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(consoleHome(), REGISTRY), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function isConsole(handle) {
  return !!handle && readRegistry().includes(handle);
}

// Handles of other console sessions; `register` records this one (only a real console, see isConsoleSession)
// and drops handles Orca no longer lists.
export function consoleHandles(terminals, self, register = false) {
  const alive = new Set(terminals.map((t) => t.handle));
  const handles = readRegistry().filter((h) => alive.has(h));
  if (register && self.handle && isConsoleSession()) {
    try {
      fs.mkdirSync(consoleHome(), { recursive: true });
      fs.writeFileSync(path.join(consoleHome(), REGISTRY), JSON.stringify([...new Set([...handles, self.handle])]));
    } catch {}
  }
  return new Set(handles.filter((h) => h !== self.handle));
}

const ARCHIVE = "archive.json";

// Orca and herdr consoles share the record files; each only prunes its own records, and unmarked ones predate herdr.
export const ownRecord = (rec, source) => (rec?.source ?? "orca") === source;

export function readArchive() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(consoleHome(), ARCHIVE), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function writeArchive(list) {
  fs.mkdirSync(consoleHome(), { recursive: true });
  fs.writeFileSync(path.join(consoleHome(), ARCHIVE), JSON.stringify(list, null, 2));
}

const DISPOSABLE = "disposable.json";

// Throwaway sessions the console opened: a temporary worktree (kind "worktree") or an extra tab in a kept worktree (kind "tab").
export function readDisposable() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(consoleHome(), DISPOSABLE), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function writeDisposable(list) {
  fs.mkdirSync(consoleHome(), { recursive: true });
  fs.writeFileSync(path.join(consoleHome(), DISPOSABLE), JSON.stringify(list, null, 2));
}

const NAMES = "nicknames.json";

// Nicknames the console's model gave worktrees with no ticket or Orca nickname (or sharing a ticket), by worktree path.
export function readNames() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(consoleHome(), NAMES), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeNames(names) {
  fs.mkdirSync(consoleHome(), { recursive: true });
  fs.writeFileSync(path.join(consoleHome(), NAMES), JSON.stringify(names, null, 2));
}

const TASKS = "tasks.json";
export const TASK_MAX = 15;

// Task titles the console wrote when it opened a session, by paneKey.
export function readTasks() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(consoleHome(), TASKS), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeTasks(tasks) {
  fs.mkdirSync(consoleHome(), { recursive: true });
  fs.writeFileSync(path.join(consoleHome(), TASKS), JSON.stringify(tasks, null, 2));
}

function applyDisposable(rows) {
  const list = readDisposable();
  const tasks = readTasks();
  for (const row of rows) {
    row.disposable = list.find((d) => d.kind === "worktree" && d.path === row.path) ?? null;
    for (const s of row.sessions) {
      const tab = list.find((d) => d.kind === "tab" && d.paneKey === s.paneKey);
      s.disposable = !!row.disposable || !!tab;
      s.task = tasks[s.paneKey]?.title ?? tab?.title ?? null;
    }
  }
}

const ASKING = new Set(["waiting", "permission"]);

// Marks archived sessions; a new 💬 or 🔐 stop lifts the archive, and a worktree that is gone takes its records with it.
function applyArchive(rows, source) {
  const list = readArchive();
  if (list.length === 0) return;
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const keep = [];
  for (const a of list) {
    if (!ownRecord(a, source)) {
      keep.push(a);
      continue;
    }
    const row = byPath.get(a.path);
    if (!row) continue;
    const s = row.sessions.find((x) => x.paneKey === a.paneKey);
    if (s && ASKING.has(s.status.kind) && (s.status.kind !== a.kind || (s.agent?.stateStartedAt ?? null) !== a.since)) continue;
    if (s) s.archived = true;
    keep.push(a);
  }
  if (keep.length !== list.length) {
    try {
      writeArchive(keep);
    } catch {}
  }
}

export { KEEPALIVE_REPLY, KEEPALIVE_TEXT } from "../../../hooks/auto-handoff.mjs";
export const RECYCLED = "♻️";
const KEEPALIVE = "keepalive.json";

export function readKeepalive() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(consoleHome(), KEEPALIVE), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeKeepalive(state) {
  try {
    fs.mkdirSync(consoleHome(), { recursive: true });
    fs.writeFileSync(path.join(consoleHome(), KEEPALIVE), JSON.stringify(state, null, 2));
  } catch {}
}

// The keepalive and cache handoff messages the watcher sends are not replies from you.
export function watcherPrompt(prompt) {
  const text = (prompt ?? "").trim();
  return !!text && (text === KEEPALIVE_TEXT || text === CACHE_HANDOFF_TEXT);
}

export const takeoverPrompt = (prompt) => (prompt ?? "").trim().startsWith(TAKEOVER_HEAD);

// From the watcher's message until you reply, the session keeps showing the stop it kept alive (same text, same place in the focus queue);
// a permission prompt or an open menu still shows. A session that took over from an expiring cache is marked ♻️ until you reply to it.
export function applyKeepalive(rows, state = readKeepalive()) {
  for (const row of rows) {
    for (const s of row.sessions) {
      const rec = state[s.paneKey];
      if (!rec || !s.agent || s.archived) continue;
      if (rec.phase === "fresh") {
        s.recycled = !s.agent.prompt || takeoverPrompt(s.agent.prompt);
        continue;
      }
      if (!watcherPrompt(s.agent.prompt) || s.agent.stateStartedAt === rec.stopAt) continue;
      s.since = rec.stopAt;
      if (["busy", "done", "waiting"].includes(s.status.kind) && !s.status.menu && !menuOpen(s.agent) && rec.status) {
        s.realStatus = s.status;
        s.status = { ...rec.status };
      }
    }
  }
}

const HANDOFF_TTL = 24 * 60 * 60 * 1000;

function handoffDir() {
  return path.join(process.env.AUTO_HANDOFF_HOME || path.join(os.homedir(), ".config", "claude-handoff"), "events");
}

// Records the auto-handoff Stop hook writes while a session hands over to a new tab; stale ones are dropped.
export function handoffEvents() {
  let files;
  try {
    files = fs.readdirSync(handoffDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const file = path.join(handoffDir(), f);
    try {
      const ev = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Date.now() - (ev.updatedAt ?? 0) > HANDOFF_TTL) fs.rmSync(file, { force: true });
      else out.push({ ...ev, file });
    } catch {}
  }
  return out;
}

export function markHandoffReported(ev) {
  try {
    const { file, ...rest } = ev;
    fs.writeFileSync(file, JSON.stringify({ ...rest, reported: true }));
  } catch {}
}

// Old tab from the moment it starts writing the note, new tab until the switch is confirmed.
function handoffHidden(events) {
  const handles = new Set();
  const panes = new Set();
  for (const ev of events) {
    if (ev.status === "failed") continue;
    if (ev.oldHandle) handles.add(ev.oldHandle);
    if (ev.oldPaneKey) panes.add(ev.oldPaneKey);
    if (ev.status !== "switching") continue;
    if (ev.newHandle) handles.add(ev.newHandle);
    if (ev.newPaneKey) panes.add(ev.newPaneKey);
  }
  return { handles, panes };
}

export function git(cwd, args) {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: res.status === 0, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
}

export function stripRef(branch) {
  return (branch || "").replace(/^refs\/heads\//, "");
}

export function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function paragraphs(text) {
  return (text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== ""))
    .filter((p) => p.length > 0);
}

function clipChars(text, max = CELL_MAX) {
  const chars = Array.from((text || "").replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;
const ZERO = /[\u200B-\u200F\uFE00-\uFE0F]|\p{Mn}/u;

function charWidth(ch) {
  return ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
}

// Terminal columns: CJK and emoji count as 2, so does a symbol drawn as emoji (followed by U+FE0F).
export function displayWidth(text) {
  const chars = Array.from(String(text ?? ""));
  return chars.reduce((n, ch, i) => n + (chars[i + 1] === "\uFE0F" && charWidth(ch) === 1 ? 2 : charWidth(ch)), 0);
}

// Clips an escaped table cell to `max` columns, never splitting an escaped pipe.
function clipWidth(text, max) {
  const tokens = String(text ?? "").match(/\\\||[\s\S]/gu) ?? [];
  if (displayWidth(text) <= max) return tokens.join("");
  let out = "";
  let used = 0;
  for (const t of tokens) {
    const w = displayWidth(t);
    if (used + w > max - 1) break;
    out += t;
    used += w;
  }
  return `${out}…`;
}

function sentences(text) {
  return (text || "").split(/(?<=[。！？!?])|(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);
}

// Reply lines outside fenced code blocks and quote boxes.
export function proseLines(text) {
  const out = [];
  let fenced = false;
  for (const line of (text || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && !/^\s*>/.test(line)) out.push(line);
  }
  return out;
}

function askLines(text) {
  return proseLines(text).filter((l) => /[?？]/.test(l)).map((l) => l.trim());
}

// Returns { kind, text, tool, input, menu } for one ps agent; text/input are verbatim.
export function agentStatus(agent) {
  const state = agent?.state;
  if (state === "anomaly") return { kind: "anomaly", text: "", raw: agent.herdr?.raw ?? null, screen: agent.screen ?? [] };
  if (state === "working") return { kind: "busy", text: agent.prompt ?? "" };
  if ((state === "waiting" || state === "blocked") && agent.toolName === MENU_TOOL) {
    return { kind: "waiting", menu: parseMenu(agent.toolInput), text: "" };
  }
  if (state === "waiting" || state === "blocked") {
    const input = typeof agent.toolInput === "string" ? agent.toolInput : agent.toolInput ? JSON.stringify(agent.toolInput, null, 2) : "";
    return { kind: "permission", tool: agent.toolName ?? "tool", input };
  }
  if (state === "done") {
    const text = paragraphs(agent.lastAssistantMessage).map((p) => p.join("\n")).join("\n\n");
    return { kind: askLines(text).length > 0 ? "waiting" : "done", text };
  }
  return { kind: "idle", text: "" };
}

export function parseMenu(input) {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return Array.isArray(value?.questions) && value.questions.length > 0 ? value.questions : null;
}

export function lastActivity(status) {
  if (status.kind === "anomaly") return clipChars(`herdr 回報 ${status.raw ?? "?"}，讀不到對話紀錄`);
  if (status.kind === "busy") return clipChars(status.text) || "—";
  if (status.kind === "permission") return clipChars(`${status.tool} ${status.input}`);
  if (status.kind === "waiting" && status.menu) return clipChars(status.menu[0].question);
  if (status.kind === "waiting") return clipChars(askLines(status.text).at(-1) ?? (paragraphs(status.text).at(-1) ?? []).at(-1)) || "—";
  if (status.kind === "done") return clipChars(sentences((paragraphs(status.text).at(-1) ?? []).join(" ")).at(-1)) || "—";
  return "—";
}

export function claudeProjectDir(worktreePath) {
  const base = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
  return path.join(base, worktreePath.replace(/[^a-zA-Z0-9]/g, "-"));
}

function recentTranscripts(worktreePath) {
  const dir = claudeProjectDir(worktreePath);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files.slice(0, 20);
}

function readEntries(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

// Orca does not expose AskUserQuestion input; read the pending call from the session's Claude Code transcript.
function menuFromTranscript(worktreePath, prompt) {
  const pending = [];
  for (const file of recentTranscripts(worktreePath)) {
    const hit = pendingMenu(file);
    if (hit) pending.push(hit);
  }
  const want = (prompt || "").trim();
  const match = want ? pending.find((p) => p.prompts.some((x) => x.includes(want) || want.includes(x))) : null;
  return (match ?? (pending.length === 1 ? pending[0] : null))?.questions ?? null;
}

function pendingMenu(file) {
  let call = null;
  const prompts = [];
  for (const entry of readEntries(file)) {
    const content = entry.message?.content;
    if (entry.type === "user" && typeof content === "string") prompts.push(content.trim());
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (entry.type === "assistant" && part.type === "tool_use") call = part.name === MENU_TOOL ? part : null;
      if (entry.type === "user" && part.type === "tool_result" && part.tool_use_id === call?.id) call = null;
      if (entry.type === "user" && part.type === "text" && part.text) prompts.push(part.text.trim());
    }
  }
  const questions = parseMenu(call?.input);
  return questions ? { questions, prompts } : null;
}

function userTexts(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (part.type === "text") return [part.text ?? ""];
    if (part.type !== "tool_result") return [];
    if (typeof part.content === "string") return [part.content];
    return Array.isArray(part.content) ? part.content.filter((c) => c.type === "text").map((c) => c.text ?? "") : [];
  });
}

function instructionText(entry) {
  if (entry.type !== "user" || entry.isMeta) return null;
  const content = entry.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n") : "";
  if (!text.trim() || /^<(task-notification|local-command-)/.test(text.trimStart())) return null;
  return text.trim();
}

export function lastInstruction(entries) {
  let last = null;
  for (const entry of entries) last = instructionText(entry) ?? last;
  return last;
}

const HEAD_BYTES = 512 * 1024;

// The first thing typed into the session; only the head of the transcript is read.
export function firstInstruction(file) {
  if (!file) return null;
  let head;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  }
  for (const line of head.split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = instructionText(entry);
    if (text) return typedPrompt(text);
  }
  return null;
}

const TICKET_ID = "[A-Za-z][A-Za-z0-9]{0,9}-\\d+";
const SLASH_HEAD = /^\/[\w:.-]+\s*/;
const GOAL_HEAD = /^本次任務依\s*\S*?([^/\s]+?)(?:\.md)?\s*執行(?:[:：]|$)/;
const TICKET_HEAD = new RegExp(`^${TICKET_ID}\\s*(?:[（(]\\s*母票\\s*${TICKET_ID}\\s*[）)])?\\s*[:：]?\\s*`);
const NICK_HEAD = /^[A-Za-z]{3,8}\s*[:：]\s*/;
const BRIEF_TAIL = /[；;]\s*slug\s*用[\s\S]*$/;

// A first instruction without its shell: the slash command, ticket and parent ticket, and the fixed brief the console appends.
export function stripPrompt(text) {
  let s = typedPrompt(String(text ?? "")).replace(/\s+/g, " ").trim().replace(SLASH_HEAD, "");
  const goal = s.match(GOAL_HEAD);
  if (goal) return goal[1];
  s = TICKET_HEAD.test(s) ? s.replace(TICKET_HEAD, "") : s.replace(NICK_HEAD, "");
  return s.replace(BRIEF_TAIL, "").trim();
}

export const CARD_FIRST_MAX = 40;

function clipColumns(text, max) {
  if (displayWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of Array.from(text)) {
    if (used + displayWidth(ch) > max) break;
    out += ch;
    used += displayWidth(ch);
  }
  return `${out}…`;
}

// What tells apart sessions sharing a worktree on a card: the console's task title, else the stripped first instruction, else the start of the last reply.
export function sessionCaption(session, first) {
  if (session.task) return clipChars(session.task, TASK_MAX);
  const bare = stripPrompt(first);
  if (bare) return clipColumns(bare, CARD_FIRST_MAX);
  const last = (session.agent?.lastAssistantMessage ?? "").trim();
  return last ? promptHead(last, 20) : null;
}

const REPO_LEAD_MIN = 3;

// `<repo 名稱開頭> <問題>`: a session tag wins; otherwise the word must be the start of exactly one repo name (a full name always counts).
export function repoLead(word, repos, rows = []) {
  const w = String(word ?? "").trim();
  if (matchSessions(rows, w).length > 0) return { match: "session" };
  const lower = w.toLowerCase();
  const exact = repos.filter((r) => r.name.toLowerCase() === lower);
  if (exact.length === 1) return { match: "one", repo: exact[0] };
  if (Array.from(w).length < REPO_LEAD_MIN || !/^[\w.-]+$/.test(w)) return { match: "none" };
  const hits = repos.filter((r) => r.name.toLowerCase().startsWith(lower));
  if (hits.length === 1) return { match: "one", repo: hits[0] };
  return hits.length > 1 ? { match: "many", repos: hits } : { match: "none" };
}

const LAUNCHED = /Async agent launched[\s\S]*?agentId: ([\w-]+)|Workflow launched in background\. Task ID: ([\w-]+)/;

function pendingTasks(entries) {
  const open = new Set();
  for (const entry of entries) {
    if (entry.type !== "user") continue;
    for (const text of userTexts(entry)) {
      for (const id of open) {
        if (text.includes(`<task-id>${id}</task-id>`) || text.includes(`"task_id":"${id}"`)) open.delete(id);
      }
      const hit = text.match(LAUNCHED);
      if (hit) open.add(hit[1] ?? hit[2]);
    }
  }
  return open.size;
}

const PROMPT_MAX = 200;

// Transcripts store a slash command as <command-name>/x</command-name><command-args>y</command-args>; Orca keeps the typed `/x y`.
export function typedPrompt(text) {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (!name) return text;
  return `${name[1]} ${text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? ""}`.trim();
}

// Orca clips `prompt` at 200 chars, so a full-length prompt only has to be a prefix of the instruction.
function samePrompt(instruction, want) {
  if (instruction === null) return false;
  const have = squash(typedPrompt(instruction));
  const need = squash(typedPrompt(want));
  return have === need || (Array.from(want).length >= PROMPT_MAX && have.startsWith(need));
}

// Unknown counts as running: no registered transcript, no prompt, no transcript whose last instruction is the prompt, or unreadable.
// Several matches settle only when none of them has background work left.
function subagentsRunning(worktreePath, prompt, handle) {
  try {
    const registered = transcriptFor(handle);
    if (registered && fs.existsSync(registered)) return pendingTasks(readEntries(registered)) > 0;
    const want = (prompt || "").trim();
    if (!want) return true;
    const matches = recentTranscripts(worktreePath).map(readEntries).filter((e) => samePrompt(lastInstruction(e), want));
    return matches.length === 0 || matches.some((e) => pendingTasks(e) > 0);
  } catch {
    return true;
  }
}

// Orca reports `working` while only background work runs after the main turn ended; trust mainAgent then.
export function sessionStatus(agent, worktreePath, handle = null, now = Date.now()) {
  const settled =
    agent?.state === "working" &&
    agent.workingMode === "monitoring" &&
    agent.mainAgent?.state === "done" &&
    !subagentsRunning(worktreePath, agent.prompt, handle);
  const a = settled ? { ...agent, state: "done" } : agent;
  const since = settled ? agent.mainAgent.stateStartedAt : agent?.stateStartedAt;
  if (a?.state === "done" && goalRunning(a, worktreePath, handle, now - (typeof since === "number" ? since : -Infinity))) {
    return { kind: "busy", text: agent.prompt ?? "" };
  }
  return withApiError(withMenu(agentStatus(a), a, worktreePath), a, handle);
}

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const LOG_REUSE_MS = 2000;
let logged = null;

// Every stopped session asks which transcript its tab runs; one read of the log serves a whole poll.
function loggedTranscript(handle) {
  if (!logged || Date.now() - logged.at > LOG_REUSE_MS) logged = { at: Date.now(), events: readEvents() };
  return transcriptFor(handle, logged.events);
}

// A turn the API refused leaves Orca an empty last message or an earlier failed tool's output; the transcript holds the error itself.
function withApiError(status, agent, handle) {
  if (agent?.state !== "done" || !handle) return status;
  const error = lastApiError(loggedTranscript(handle));
  return error ? { kind: "done", text: `⚠️ ${error}` } : status;
}

function lastApiError(file) {
  if (!file) return null;
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= (start > 0 ? 1 : 0); i--) {
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (e.type !== "assistant" || e.isSidechain) continue;
      if (!e.isApiErrorMessage) return null;
      const content = e.message?.content;
      const text = typeof content === "string" ? content : (content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
      return text.trim() || "API Error";
    }
  } catch {}
  return null;
}

const GOAL_GRACE_MS = 60 * 1000;
const GOAL_MAX_MS = 5 * 60 * 1000;
const GOAL_FOOTER = /^\s{10,}\S{0,2}\s*\/goal active\b/;
const GOAL_FOOTER_LINES = 10;

// A stop between /goal judge rounds counts as running: transcript and footer both must say /goal is on, either
// alone decides when the other is unreadable, neither readable holds the stop 60s; a stop past 5 minutes never.
function goalRunning(agent, worktreePath, handle, elapsed) {
  if (elapsed >= GOAL_MAX_MS) return false;
  const file = agent.transcript && fs.existsSync(agent.transcript) ? agent.transcript : goalTranscript(handle, worktreePath, agent.prompt);
  const logged = file ? goalInTranscript(file) : null;
  if (logged === false) return false;
  const shown = goalOnScreen(handle);
  if (shown !== null) return shown;
  return logged === true || elapsed < GOAL_GRACE_MS;
}

export function sessionTranscript(handle, worktreePath, prompt) {
  return goalTranscript(handle, worktreePath, prompt);
}

function goalTranscript(handle, worktreePath, prompt) {
  const logged = transcriptFor(handle);
  if (logged && fs.existsSync(logged)) return logged;
  const want = (prompt || "").trim();
  if (!want) return null;
  try {
    const hits = recentTranscripts(worktreePath).filter((f) => samePrompt(lastInstruction(readEntries(f)), want));
    return hits.length === 1 ? hits[0] : null;
  } catch {
    return null;
  }
}

// true while the last goal_status is unmet, false without one, null when unreadable.
export function goalInTranscript(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"goal_status"')) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === "attachment" && e.attachment?.type === "goal_status") return e.attachment.met === false;
    } catch {}
  }
  return false;
}

export function goalOnScreen(handle) {
  const manager = maybeTerminals();
  if (!handle || !manager) return null;
  const res = manager.readScreen(handle);
  const tail = res.ok ? res.terminal?.tail : null;
  return Array.isArray(tail) ? tail.slice(-GOAL_FOOTER_LINES).some((l) => GOAL_FOOTER.test(l)) : null;
}

function withMenu(status, agent, worktreePath) {
  if (status.kind !== "waiting" || status.menu || agent?.toolName !== MENU_TOOL || agent?.state === "done") return status;
  return { ...status, menu: menuFromTranscript(worktreePath, agent.prompt) };
}

export function pickUrgent(statuses) {
  if (statuses.length === 0) return { kind: "idle", text: "" };
  return [...statuses].sort((a, b) => URGENCY.indexOf(a.kind) - URGENCY.indexOf(b.kind))[0];
}

export function needsYou(kind) {
  return NEEDS_YOU.has(kind);
}

function linkedIssueId(value) {
  if (!value) return null;
  if (typeof value === "string") return value.toUpperCase();
  return (value.identifier || value.id || null)?.toUpperCase() ?? null;
}

const KEY_NUM = /(?:^|[^a-z0-9])([a-z][a-z0-9]{0,9})-(\d+)(?!\d|[-.]\d)/gi;

// Ticket keys: from linked Linear issues, plus branch prefixes seen with at least two distinct numbers.
export function ticketKeys(linkedIds, branches) {
  const keys = new Set(linkedIds.filter(Boolean).map((id) => id.split("-")[0].toUpperCase()));
  const numbers = new Map();
  for (const branch of branches) {
    for (const m of branch.matchAll(KEY_NUM)) {
      const key = m[1].toUpperCase();
      if (KEY_STOPWORDS.has(m[1].toLowerCase())) continue;
      if (!numbers.has(key)) numbers.set(key, new Set());
      numbers.get(key).add(m[2]);
    }
  }
  for (const [key, nums] of numbers) if (nums.size >= 2) keys.add(key);
  return keys;
}

export function ticketFromBranch(branch, keys) {
  for (const m of (branch || "").matchAll(KEY_NUM)) {
    const key = m[1].toUpperCase();
    if (keys.has(key)) return { ticket: `${key}-${m[2]}`, end: m.index + m[0].length };
  }
  return null;
}

function shortBranch(branch, keys) {
  const hit = ticketFromBranch(branch, keys);
  const rest = hit ? branch.slice(hit.end).replace(/^[-_/]+/, "") : "";
  return rest || branch;
}

// What a worktree is called until the console names it: the branch without its type prefix, cut to 8 columns with "…".
export function clipBranch(branch) {
  const rest = Array.from((branch || "").replace(/^[^/]+\//, ""));
  if (rest.length <= CLIP_BRANCH) return rest.join("");
  return `${rest.slice(0, CLIP_BRANCH).join("").replace(/[-_/.]+$/, "")}…`;
}

export function mainCheckout(p) {
  const common = git(p, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common.ok ? realpath(path.dirname(common.out)) : realpath(p);
}

export function gitWorktrees(repo) {
  const res = git(repo, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return [];
  const rows = [];
  let cur = null;
  for (const line of res.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: realpath(line.slice(9)), branch: "", isMain: rows.length === 0 };
      rows.push(cur);
    } else if (line.startsWith("branch ") && cur) cur.branch = stripRef(line.slice(7));
  }
  return rows;
}

export function selfInfo(terminals, handle = maybeTerminals()?.selfHandle() ?? null) {
  const t = handle ? terminals.find((x) => x.handle === handle) : null;
  return {
    handle: handle || null,
    paneKey: t ? `${t.tabId}:${t.leafId}` : null,
    worktreePath: t?.worktreePath ? realpath(t.worktreePath) : null,
  };
}

export function repoBase(p, baseRef) {
  const candidates = [];
  if (baseRef) candidates.push(baseRef, `origin/${baseRef}`);
  const head = git(p, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok) candidates.push(head.out);
  for (const c of candidates) if (git(p, ["rev-parse", "--verify", "--quiet", `${c}^{commit}`]).ok) return c;
  return null;
}

export function gitFacts(p, baseRef) {
  const unpushedOut = git(p, ["rev-list", "HEAD", "--not", "--remotes"]).out;
  const unpushed = unpushedOut ? unpushedOut.split("\n").length : 0;
  const base = repoBase(p, baseRef);
  const ahead = base ? Number(git(p, ["rev-list", "--count", `${base}..HEAD`]).out || 0) : unpushed;
  return { unpushed, ahead, base };
}

export function runFolder(p, branch) {
  return path.join(p, PLAN_DIR, (branch || "").replace(/\//g, "-"));
}

function frontmatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }
  const m = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  return m ? m[1] : "";
}

// Git facts for the stage column; files under docs/dev-flow/ are planning, not code.
export function stageFacts(p, baseRef, branch) {
  const lines = (args) => git(p, args).out.split("\n").filter(Boolean).length;
  const base = repoBase(p, baseRef);
  const folder = branch ? runFolder(p, branch) : null;
  const hasRun = !!folder && fs.existsSync(folder);
  const head = hasRun ? frontmatter(path.join(folder, "plan.md")) : null;
  const unpushed = lines(["rev-list", "HEAD", "--not", "--remotes", "--", ...NOT_PLAN]);
  return {
    dirty: lines(["status", "--porcelain", "--untracked-files=all", "--", ...NOT_PLAN]) > 0,
    unpushed,
    ahead: base ? lines(["rev-list", `${base}..HEAD`, "--", ...NOT_PLAN]) : unpushed,
    hasBase: !!base,
    upstream: git(p, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok,
    runFolder: hasRun,
    planApproved: !!head && /^status:\s*["']?approved["']?\s*$/m.test(head),
  };
}

// The goal file's 「實作方案」 line once a flow has taken over: null without a goal file.
export function goalPlan(main, id) {
  if (!main || !id) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(main, ".goals", `${id.toLowerCase()}.md`), "utf8");
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/).find((l) => l.includes("實作方案")) ?? "";
  return { handedOff: /直接實作|-spec\.md/.test(line) };
}

export function deriveStage({ facts, goal = null, comment = "" }) {
  if (facts.dirty) return STAGE.implementing;
  const pushed = facts.hasBase === false ? facts.upstream && facts.unpushed === 0 : facts.ahead > 0 && facts.unpushed === 0;
  if (pushed) return STAGE.pushed;
  if (facts.ahead > 0 || facts.planApproved || goal?.handedOff) return STAGE.implementing;
  if (facts.runFolder || goal || /define-goal|interview/i.test(comment || "")) return STAGE.planning;
  return STAGE.idle;
}

function linearTitle(id) {
  return maybeTerminals()?.linearIssue(id)?.title ?? null;
}

// Every worktree of every repo the terminal manager knows (plus git-only worktrees of the launch repo), with sessions
// and ticket ids. Throws when the manager is unreachable, or when the console runs in neither Orca nor herdr.
export function collect(repoArg = null, { withStage = true, withTitles = false, register = false } = {}) {
  const manager = terminals();
  const launch = repoArg ? mainCheckout(realpath(repoArg)) : null;
  const snap = manager.snapshot();
  const repos = snap.repos.map((r) => ({ id: r.id, name: r.displayName || path.basename(r.path), main: realpath(r.path) }));
  const terminalRows = snap.terminals.map((t) => ({ ...t, realPath: t.worktreePath ? realpath(t.worktreePath) : null }));
  const self = selfInfo(terminalRows, manager.selfHandle());
  const handoff = handoffHidden(handoffEvents());
  const hidden = new Set([self.handle, ...consoleHandles(terminalRows, self, register), ...handoff.handles].filter(Boolean));
  const hiddenPanes = new Set([...terminalRows.filter((t) => hidden.has(t.handle)).map((t) => `${t.tabId}:${t.leafId}`), ...handoff.panes]);
  const claude = terminalRows.filter((t) => t.agentIdentity === "claude" && !hidden.has(t.handle));

  const orcaByPath = new Map(snap.worktrees.map((w) => [realpath(w.path), w]));
  const psByPath = new Map(snap.ps.map((w) => [realpath(w.path), w]));
  const launchRepo = launch ? repos.find((r) => r.main === launch) ?? null : null;
  const byPath = new Map();
  if (launch) {
    for (const g of gitWorktrees(launch)) byPath.set(g.path, { path: g.path, branch: g.branch, isMain: g.isMain, repoId: launchRepo?.id ?? null });
  }
  for (const [p, w] of [...orcaByPath, ...psByPath]) {
    if (!byPath.has(p)) byPath.set(p, { path: p, branch: stripRef(w.branch), isMain: !!w.isMainWorktree, repoId: w.repoId ?? null });
  }

  const rows = [];
  for (const row of byPath.values()) {
    if (!fs.existsSync(row.path)) continue;
    const o = orcaByPath.get(row.path);
    const p = psByPath.get(row.path);
    const info = repos.find((r) => r.id === row.repoId) ?? (launch && row.repoId === null ? { name: path.basename(launch), main: launch } : null);
    const agents = (p?.agents ?? []).filter((a) => !hiddenPanes.has(a.paneKey));
    const here = claude.filter((t) => t.realPath === row.path);
    const sessions = buildSessions(agents, here, row.path);
    const statuses = agents.map((a) => ({ ...sessions.find((s) => s.paneKey === a.paneKey).status, agent: a }));
    rows.push({
      ...row,
      repo: info?.name ?? p?.repo ?? path.basename(row.path),
      main: info?.main ?? null,
      linkedId: linkedIssueId(o?.linkedLinearIssue ?? p?.linkedLinearIssue),
      unmanaged: !o && !p,
      displayName: o?.displayName ?? p?.displayName ?? row.branch,
      baseRef: o?.baseRef ?? null,
      comment: o?.comment ?? p?.comment ?? "",
      agents,
      statuses,
      status: o || p ? pickUrgent(statuses) : { kind: "idle", text: "" },
      handles: here.map((t) => ({ handle: t.handle, paneKey: `${t.tabId}:${t.leafId}` })),
      sessions,
    });
  }
  const order = (r) => {
    const i = repos.findIndex((x) => x.id === r.repoId);
    return i < 0 ? repos.length : i;
  };
  rows.sort((a, b) => order(a) - order(b));

  const mains = [...new Set(rows.filter((r) => r.sessions.length > 0).map((r) => r.main ?? mainCheckout(r.path)))];
  const recent = mains.flatMap((m) => {
    const res = git(m, ["for-each-ref", "--sort=-committerdate", "--count=50", "--format=%(refname:short)", "refs/heads"]);
    return res.ok ? res.out.split("\n") : [];
  });
  const linked = [...orcaByPath.values(), ...psByPath.values()].map((w) => linkedIssueId(w.linkedLinearIssue));
  const keys = ticketKeys(linked, [...rows.filter((r) => !r.unmanaged).map((r) => r.branch), ...recent]);
  for (const r of rows) r.ticket = r.linkedId ?? ticketFromBranch(r.branch, keys)?.ticket ?? null;
  applyArchive(rows, manager.name);
  applyKeepalive(rows);
  applyDisposable(rows);

  const data = { repo: launch, main: launch, launchRepo: launchRepo?.name ?? (launch ? path.basename(launch) : null), repos, rows, self, keys, terminals: terminalRows };
  decorate(data, { withStage, withTitles });
  manager.audit(rows);
  if (register) writeManaged(managedState(data, [...hidden]));
  return data;
}

// Worktrees, repos and tabs the console manages, for the logging hooks and scripts that only know a path or handle.
function managedState(data, consoles) {
  const rows = data.rows.filter((r) => !r.unmanaged);
  return {
    consoles,
    repos: data.repos.map((r) => ({ name: r.name, main: r.main })),
    worktrees: rows.map((r) => ({ path: r.path, repo: r.repo, ticket: r.label, main: !!r.isMain })),
    handles: Object.fromEntries(
      rows.flatMap((r) => r.sessions.filter((s) => s.handle).map((s) => [s.handle, { repo: r.repo, ticket: sessionTag(r, s), paneKey: s.paneKey, path: r.path }])),
    ),
  };
}

// Labels get a `<repo>/` prefix only when the same label shows up in another repo: board rows against board rows, the rest
// against everything. A nickname the console gave is unique across repos, so it never gets one.
export function decorate(data, { withStage = true, withTitles = false } = {}) {
  const { rows, keys } = data;
  const names = readNames();
  const counts = new Map();
  const dupKey = (r) => `${r.repo}\u0000${r.ticket}`;
  for (const r of rows) if (r.ticket && !r.unmanaged) counts.set(dupKey(r), (counts.get(dupKey(r)) ?? 0) + 1);
  for (const r of rows) {
    const saved = names[r.path];
    r.nickname = !r.ticket && r.displayName !== r.branch && NICKNAME.test(r.displayName ?? "") ? r.displayName : null;
    r.shared = !!r.ticket && counts.get(dupKey(r)) > 1;
    r.alias = !r.isMain && !r.nickname && (!r.ticket || r.shared) && saved?.branch === r.branch ? saved.nickname : null;
    const clip = !r.isMain && r.sessions.length > 0;
    r.id = r.ticket ?? r.nickname ?? r.alias ?? (clip ? clipBranch(r.branch) : r.branch);
    r.base = r.shared ? `${r.ticket}(${r.alias ?? (clip ? clipBranch : (b) => b)(shortBranch(r.branch, keys))})` : r.id;
  }
  const prefixed = (r) => !r.alias;
  const reposBy = (list) => {
    const map = new Map();
    for (const r of list.filter(prefixed)) map.set(r.base.toUpperCase(), (map.get(r.base.toUpperCase()) ?? new Set()).add(r.repo));
    return map;
  };
  const shown = reposBy(rows.filter((r) => r.sessions.length > 0));
  const all = reposBy(rows);
  for (const r of rows) {
    const repos = prefixed(r) ? (r.sessions.length > 0 ? shown : all).get(r.base.toUpperCase()) : null;
    r.label = repos?.size > 1 ? `${r.repo}/${r.base}` : r.base;
    if (r.sessions.length === 0) continue;
    if (withStage && !r.stage) r.stage = stageOf(r);
    if (withTitles) fillTitle(r, keys);
  }
  return data;
}

// Worktrees on the board still waiting for the console to give them a nickname.
export function unnamedRows(rows) {
  return rows.filter((r) => r.sessions.length > 0 && !r.unmanaged && !r.isMain && !r.nickname && !r.alias && (!r.ticket || r.shared));
}

export function nameLines(rows) {
  const list = unnamedRows(rows);
  if (list.length === 0) return [];
  return [`待取暱稱：${list.map((r) => `${r.branch}（${r.repo}）`).join("、")}`];
}

export function fillTitle(r, keys) {
  if (r.title) return;
  const title = r.linkedId ? linearTitle(r.linkedId) : null;
  const fallback = r.displayName && r.displayName !== r.branch && !r.nickname ? r.displayName : shortBranch(r.branch, keys);
  r.title = title ?? (fallback === r.id ? "—" : fallback);
}

function buildSessions(agents, terminals, worktreePath) {
  const byPane = new Map();
  for (const a of agents) byPane.set(a.paneKey, { paneKey: a.paneKey, agent: a, handle: null, createdAt: null });
  for (const t of terminals) {
    const paneKey = `${t.tabId}:${t.leafId}`;
    const s = byPane.get(paneKey) ?? { paneKey, agent: null, handle: null, createdAt: null };
    s.handle = t.handle;
    s.createdAt = t.createdAt ?? null;
    byPane.set(paneKey, s);
  }
  const order = (s) => (typeof s.createdAt === "number" ? s.createdAt : Number.POSITIVE_INFINITY);
  const sessions = [...byPane.values()].sort((x, y) => order(x) - order(y) || (x.paneKey < y.paneKey ? -1 : x.paneKey > y.paneKey ? 1 : 0));
  sessions.forEach((s, i) => {
    s.n = sessions.length >= 2 ? i + 1 : null;
    s.status = s.agent ? sessionStatus(s.agent, worktreePath, s.handle) : { kind: "idle", text: "" };
  });
  return sessions;
}

export function sessionTag(row, session) {
  return session?.n ? `${row.label}#${session.n}` : row.label;
}

export function promptHead(prompt, max = 20) {
  const chars = Array.from((prompt || "").replace(/\s+/g, " ").trim());
  if (chars.length === 0) return "（無）";
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

// Empty prompt (e.g. a resumed session) falls back to what the session last said.
export function sessionHint(agent, max = 20) {
  if ((agent?.prompt || "").trim()) return promptHead(agent.prompt, max);
  const last = paragraphs(agent?.lastAssistantMessage).at(-1);
  return last ? `說：${promptHead(last.join(" "), max)}` : "（無）";
}

export function stageOf(row) {
  const goal = goalPlan(row.main ?? mainCheckout(row.path), row.ticket ?? row.nickname);
  return deriveStage({ facts: stageFacts(row.path, row.baseRef, row.branch), goal, comment: row.comment });
}

export function snapshot(rows) {
  const snap = new Map();
  for (const r of rows) for (const s of r.sessions) if (s.agent) snap.set(s.paneKey, s.status.kind);
  return snap;
}

export function formatBaseline(snap) {
  return [...snap].map(([k, v]) => `${k}=${v}`).join(",");
}

export function parseBaseline(text) {
  const snap = new Map();
  for (const part of (text || "").split(",")) {
    const i = part.lastIndexOf("=");
    if (i > 0) snap.set(part.slice(0, i), part.slice(i + 1));
  }
  return snap;
}

const TITLE = { waiting: "等你回應", menu: "等你選擇", permission: "等你授權", done: "回覆完畢", anomaly: "session 異常，需手動排程" };
const RECOMMENDED = /recommended|建議|推薦/i;

export const isRecommended = (o) => RECOMMENDED.test(`${o.label} ${o.description ?? ""}`);

function cell(text) {
  return String(text ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
}

function quote(text) {
  return String(text || "").split("\n").map((l) => (l.trim() ? `> ${l}` : ">"));
}

// One table row per claude session; worktrees without a session stay off the board.
function boardRows(rows) {
  return rows.flatMap((row) =>
    row.sessions.map((session) => ({
      repo: row.repo,
      tag: sessionTag(row, session),
      title: row.title ?? "—",
      stage: row.stage ?? "—",
      kind: session.status.kind,
      archived: !!session.archived,
      state: LABELS[session.status.kind],
      activity: recycledMark(session, lastActivity(session.status)),
    })),
  );
}

export function recycledMark(session, text) {
  return session?.recycled ? `${RECYCLED} ${text}` : text;
}

// A ticket still being aligned in the console conversation, shown as the last row of its repo's table.
export function aligningRow(ticket, title, repo) {
  return { repo, tag: ticket, title: title || "—", stage: STAGE.idle, kind: "waiting", state: LABEL.waiting, activity: "等你確認開工" };
}

// The prompt the console reads when it loads: your own copy in the console home wins over the one shipped here.
export function promptFile() {
  const custom = path.join(consoleHome(), "prompt.md");
  const found = fs.existsSync(custom);
  const file = found ? custom : fileURLToPath(new URL("../references/prompt.md", import.meta.url));
  return { file, custom: found, interview: /^## 需求訪談\s*$/m.test(fs.readFileSync(file, "utf8")) };
}

// Splits the columns left after state/tag/stage between summary and last activity, so every row fits `width`.
function fitBoard(cells, width) {
  const widest = (i) => Math.max(displayWidth(BOARD_HEAD[i]), ...cells.map((c) => displayWidth(c[i])));
  const frame = 3 * BOARD_HEAD.length + 1;
  const room = width - frame - widest(0) - widest(1) - widest(3);
  const need = [widest(2), widest(4)];
  let [title, activity] = need;
  if (title + activity > room) {
    const half = Math.floor(room / 2);
    title = need[0] <= half ? need[0] : need[1] <= room - half ? room - need[1] : half;
    activity = room - title;
  }
  title = Math.max(title, MIN_CLIP);
  activity = Math.max(activity, MIN_CLIP);
  return cells.map((c) => [c[0], c[1], clipWidth(c[2], title), c[3], clipWidth(c[4], activity)]);
}

// One table per repo, each under a line with the repo name; idle and archived sessions only count in one line below the whole board.
export function boardLines(rows, extra = [], width = BOARD_WIDTH) {
  const list = [...boardRows(rows), ...extra];
  if (list.length === 0) return ["目前沒有 claude session"];
  const out = [];
  for (const repo of new Set(list.map((r) => r.repo))) {
    const shown = list.filter((r) => r.repo === repo && r.kind !== "idle" && !r.archived);
    if (out.length > 0) out.push("");
    out.push(`**${repo}**`, "");
    if (shown.length === 0) {
      out.push("全部閒置／封存");
      continue;
    }
    const cells = fitBoard(shown.map((r) => [r.state, r.tag, r.title, r.stage, r.activity].map(cell)), width);
    out.push(`| ${BOARD_HEAD.join(" | ")} |`, "| --- | --- | --- | --- | --- |", ...cells.map((c) => `| ${c.join(" | ")} |`));
  }
  const tally = hiddenTally(list);
  return tally ? [...out, "", tally] : out;
}

// `封存 N 個、閒置 M 個` across every repo; a zero part is left out, and nothing at all when both are zero.
export function hiddenTally(list) {
  const archived = list.filter((r) => r.archived).length;
  const idle = list.filter((r) => !r.archived && r.kind === "idle").length;
  return [archived ? `封存 ${archived} 個` : "", idle ? `閒置 ${idle} 個` : ""].filter(Boolean).join("、");
}

// After replies land in `exclude`: the reply list while any question or permission still waits, else the full board.
export function afterSendLines(rows, exclude, extra = []) {
  const items = pendingItems(rows, exclude);
  if (items.some((x) => x.session.status.kind !== "done")) return pendingLines(items);
  const notes = habitNotes();
  return [...boardLines(rows, extra), ...(notes.length > 0 ? ["", ...notes] : [])];
}

const PENDING_HEAD = ["狀態", "代號", "問題", "選項", "建議", "你通常會回"];
const RECOMMENDED_MARK = /\s*[(（]\s*(recommended|建議|推薦)\s*[)）]/gi;
const OPTION_MARK = /\s*[(（]\s*(?:recommended|我的建議|建議|推薦)\s*[)）]/i;
const MARK_NEXT = "(?=\\s*[(（]\\s*(?:[Rr]ecommended|我的建議|建議|推薦)\\s*[)）])";
const OPTION_HEAD = new RegExp(
  `^\\s*(?:[-*+]\\s+)?(?:\\*\\*\\s*(?:([A-Za-z])(?:\\s*[.)）:：、]\\s*|\\s*(\\*\\*)|${MARK_NEXT})|(\\d{1,2})(?:\\s*[.)）:：、]\\s*|\\s*(\\*\\*)|${MARK_NEXT}|\\s+))|([A-Za-z]|\\d{1,2})(?:\\s*[.)）:：、]\\s*|${MARK_NEXT}))`,
);
const OPTION_STOP = /[，：。—（,:(]/;
const OPTION_MAX = 16;
const SUGGEST = /(?:我建議|建議是|建議答案|建議(?=選|[:：])|推薦)\s*(?:選擇|選|用)?\s*[:：]?\s*\**\s*([^。！!\n*]+)/;
const NEXT_STEP = /下一步建議\s*(?:是)?\s*[:：]?\s*\**\s*([^。！!\n*]+)/;
// `B`, `a`, `2` or a combination like `A＋C`, ending the suggestion or followed by punctuation.
const REC_CODE = /^([A-Za-z]|\d{1,2})(?:\s*[＋+、和]\s*(?:[A-Za-z]|\d{1,2}))*(?=$|[\s，。,.：:；;！!）)]*$|[，。,.：:；;！!）)])/;
const TOPIC = /^\s*\**\s*第\s*[一二三四五六七八九十\d]+\s*題/;
const PICK = /選哪|哪一(?:個|種|項)|哪個|哪幾(?:個|項)|你要哪|選\s*\**\s*[A-Za-z\d]{1,2}\s*\**\s*還是|要選\s*\**\s*[A-Za-z\d]{1,2}(?![A-Za-z\d])/;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

// Options are shown as a, b, c everywhere; the digits are kept for switching questions on the focus band.
const letter = (i) => LETTERS[i] ?? String(i + 1);

function menuEntries(tag, questions) {
  const entries = questions.map((q, i) => {
    const options = q.options ?? [];
    const rec = options.findIndex((o) => isRecommended(o));
    const name = (o) => String(o.label ?? "").replace(RECOMMENDED_MARK, "").trim();
    return {
      code: questions.length > 1 ? `${tag}${String.fromCodePoint(0x2460 + i)}` : tag,
      question: q.question ?? "",
      options: [...options.map((o, j) => `${letter(j)} ${name(o)}`), "其他"].join("／"),
      suggest: rec >= 0 ? `${letter(rec)} ${name(options[rec])}` : "—",
    };
  });
  return { entries };
}

// Up to 8 CJK characters (16 columns); longer ends in「…」.
function clipOption(text) {
  if (displayWidth(text) <= OPTION_MAX) return text;
  let out = "";
  for (const ch of Array.from(text)) {
    if (displayWidth(out + ch) > OPTION_MAX) break;
    out += ch;
  }
  return `${out}…`;
}

// `- **A**：…`, `1. **粗體**，…`, `2. 文字，…` → { code, label, marked }: label is the bold part, else the text up to the first ，：。—（.
export function optionLine(line) {
  const m = String(line).match(OPTION_HEAD);
  if (!m) return null;
  const code = m[1] ?? m[3] ?? m[5];
  if (/^[i-z]$/.test(code)) return null;
  const insideBold = /^\s*(?:[-*+]\s+)?\*\*/.test(line) && !(m[2] ?? m[4]);
  const rest = line.slice(m[0].length);
  const marked = OPTION_MARK.test(rest);
  const plain = rest.replace(OPTION_MARK, "");
  let label;
  if (insideBold && /^\s*\*\*/.test(plain)) label = plain.replace(/^\s*\*\*\s*/, "").split(OPTION_STOP)[0];
  else if (insideBold) label = plain.split("**")[0].replace(/^\s*[:：、.]+\s*/, "");
  else if (/^\s*[:：、.]*\s*\*\*/.test(plain)) label = plain.replace(/^\s*[:：、.]*\s*\*\*/, "").split("**")[0];
  else label = plain.replace(/^\s*[:：、.]+\s*/, "").split(OPTION_STOP)[0];
  return { code, label: label.replace(/\*\*/g, "").trim(), marked };
}

const family = (code) => (/\d/.test(code) ? "digit" : /[a-z]/.test(code) ? "lower" : "upper");

// Every list of two or more option lines; blank and indented lines stay inside a list, a switch between numbers, capitals and small letters starts a new one.
function optionLists(prose) {
  const lists = [];
  let group = [];
  const flush = () => {
    const seen = new Set();
    const list = group.filter((o) => !seen.has(o.code) && seen.add(o.code));
    if (list.length >= 2) lists.push(list);
    group = [];
  };
  for (const line of prose) {
    const hit = optionLine(line);
    if (hit && group.length > 0 && family(hit.code) !== family(group[0].code)) flush();
    if (hit) group.push(hit);
    else if (line.trim() && !/^\s/.test(line)) flush();
  }
  flush();
  return lists;
}

// The option list of a text reply and which one the child suggested: { list, at, code, said }, `at` -1 when none is listed.
// Only after the last「第 N 題」, and only when the child asks to pick (選哪個…), names a listed code as its suggestion or marks an option（建議）; a list of reasons or a yes/no question gives no options.
function textChoices(text) {
  let prose = proseLines(text);
  const topic = prose.findLastIndex((l) => TOPIC.test(l));
  if (topic >= 0) prose = prose.slice(topic);
  const said = prose.filter((l) => !/[?？]/.test(l) && !optionLine(l)).map((l) => l.match(SUGGEST)?.[1].trim()).filter(Boolean).at(-1);
  const rec = said?.match(REC_CODE);
  const lists = optionLists(prose);
  let list = [];
  const marked = lists.filter((g) => g.some((o) => o.marked)).at(-1);
  if (rec) list = lists.filter((g) => g.some((o) => o.code === rec[1])).at(-1) ?? [];
  else if (marked) list = marked;
  else if (prose.some((l) => /[?？]/.test(l) && PICK.test(l)) && new Set(lists.map((g) => family(g[0].code))).size === 1) list = lists.at(-1) ?? [];
  const single = rec && rec[0].trim() === rec[1] ? rec[1] : null;
  const code = list.find((o) => o.marked)?.code ?? (single && list.length > 0 ? single : null);
  const at = code ? list.findIndex((o) => o.code === code) : -1;
  return { list, at, code, said };
}

// Options and the child's own suggestion are only read from fixed phrasings; anything else stays "—".
function textEntry(tag, text) {
  const { list, at, code, said } = textChoices(text);
  const pick = at >= 0 ? letter(at) : code;
  const suggest = pick ?? said;
  return {
    entries: [
      {
        code: tag,
        question: askLines(text).at(-1) ?? "—",
        options: list.length > 0 ? list.map((o, i) => (o.label ? `${letter(i)} ${clipOption(o.label)}` : letter(i))).join("／") : "—",
        suggest: suggest || "—",
      },
    ],
    choices: list.map((o) => o.code),
  };
}

// A reply as the child expects it: a, b, c become its own option codes (`B`, `2`), or the menu's numbers.
export function childAnswer(item, text) {
  const t = String(text ?? "").trim();
  const at = (s) => (/^[a-z]$/i.test(s) ? LETTERS.indexOf(s.toLowerCase()) : -1);
  if (item.kind === "menu") return t.split(/[；;]/).map((p) => (at(p.trim()) >= 0 ? String(at(p.trim()) + 1) : p.trim())).join("；");
  if (item.kind === "text" && at(t) >= 0 && at(t) < (item.choices?.length ?? 0)) return item.choices[at(t)];
  return t;
}

// ⏸: the next step the child wrote in its last paragraph as 「下一步建議…」.
function doneEntry(tag, status) {
  const said = (paragraphs(status.text).at(-1) ?? []).join("\n").match(NEXT_STEP)?.[1].trim();
  return { entries: [{ code: tag, question: lastActivity(status), options: "—", suggest: said || "—" }] };
}

function pendingEntry(tag, status, agent) {
  if (status.kind === "done") return doneEntry(tag, status);
  if (status.kind === "anomaly") return { entries: [{ code: tag, question: TITLE.anomaly, options: "—", suggest: "—" }] };
  if (status.kind === "permission") {
    return { entries: [{ code: tag, question: `${status.tool} ${status.input}`, options: "允許／拒絕", suggest: "—" }] };
  }
  if (status.menu) return menuEntries(tag, status.menu);
  if (menuOpen(agent)) {
    return { entries: [{ code: tag, question: "（讀不到選單內容）", options: "—", suggest: "—" }] };
  }
  return textEntry(tag, status.text);
}

// A turn that ended without a question still waits on you, whatever the stage.
function awaitsYou(row, session) {
  const kind = session.status.kind;
  return kind === "anomaly" || kind === "waiting" || kind === "permission" || (kind === "done" && !!row.stage);
}

// Fields of a stop event: what the session waits on (permission: tool and first 80 chars) and its own suggestion.
export function stopFields(row, session) {
  const status = session.status;
  const base = { repo: row.repo, ticket: sessionTag(row, session), handle: session.handle, paneKey: session.paneKey, status: status.kind };
  if (status.kind === "permission") return { ...base, question: clip(`${status.tool} ${clip(status.input, 80) ?? ""}`), suggestion: null };
  if (status.kind === "anomaly") return { ...base, question: TITLE.anomaly, suggestion: null };
  if (status.menu) {
    const recs = status.menu.map((q) => (q.options ?? []).find((o) => isRecommended(o))?.label ?? null);
    return {
      ...base,
      question: clip(status.menu.map((q) => q.question ?? "").join(" / ")),
      suggestion: recs.some(Boolean) ? clip(recs.map((r) => r ?? "—").join("；")) : null,
    };
  }
  if (status.kind === "done") return { ...base, question: clip(lastSentence(status.text)), suggestion: null };
  const said = proseLines(status.text).filter((l) => !/[?？]/.test(l)).map((l) => l.match(SUGGEST)?.[1].trim()).filter(Boolean).at(-1);
  return { ...base, question: clip(askLines(status.text).at(-1) ?? lastSentence(status.text)), suggestion: said ? clip(said) : null };
}

function lastSentence(text) {
  return sentences((paragraphs(text).at(-1) ?? []).join(" ")).at(-1) ?? "";
}

// Sessions in ⚠️, 💬, 🔐, or ⏸, in board order with ⚠️ first; `exclude` holds tags just replied to.
export function pendingItems(rows, exclude = new Set()) {
  const items = [];
  for (const row of rows) {
    for (const session of row.sessions) {
      if (session.archived || !awaitsYou(row, session)) continue;
      const tag = sessionTag(row, session);
      if (exclude.has(tag)) continue;
      const kind = ["permission", "anomaly"].includes(session.status.kind) ? session.status.kind : menuOpen(session.agent) ? "menu" : "text";
      items.push({ tag, row, session, kind, ...pendingEntry(tag, session.status, session.agent) });
    }
  }
  return items.sort((a, b) => (b.kind === "anomaly") - (a.kind === "anomaly"));
}

// Shrinks the widest of the remaining columns first until the row fits.
function shareRoom(needs, room) {
  let level = Math.max(...needs);
  while (level > MIN_CLIP && needs.reduce((n, x) => n + Math.min(x, level), 0) > room) level--;
  return needs.map((x) => Math.min(x, level));
}

// Shortens every option's label alike before dropping any, so each a, b, c stays readable in a narrow column.
function clipOptions(text, max) {
  if (displayWidth(text) <= max) return text;
  const parts = text.split("／").map((p) => {
    const m = p.match(/^([a-z]) (.+)$/);
    return m ? { code: m[1], label: m[2] } : { code: p, label: null };
  });
  const fit = (label, level) => (displayWidth(label) <= level ? label : clipWidth(label.replace(/…$/, ""), level));
  const draw = (level) => parts.map((p) => (p.label ? `${p.code} ${fit(p.label, level)}` : p.code)).join("／");
  for (let level = Math.max(...parts.map((p) => displayWidth(p.label ?? ""))); level >= 3; level--) {
    if (displayWidth(draw(level)) <= max) return draw(level);
  }
  return clipWidth(draw(3), max);
}

// What you usually answer for each pending item, copied from your past replies; never a judgement of its own.
export function withHabits(items) {
  let ctx = null;
  try {
    ctx = memoryContext();
  } catch {}
  return items.map((x) => {
    let habit = null;
    let scene = null;
    try {
      scene = ctx ? itemScene(x) : null;
      habit = ctx ? habitFor(ctx, x, scene) : null;
    } catch {}
    return { ...x, habit, scene };
  });
}

// 「要記住這個習慣嗎？」 for every scene, for the bottom of the reply list.
export function habitNotes() {
  try {
    return memoryNotes(memoryContext());
  } catch {
    return [];
  }
}

// 「要記住這個習慣嗎？」 for one scene, to hang under a question of that scene.
export function sceneNotes(scene) {
  if (!scene) return [];
  try {
    return proposalLines(memoryContext(), scene);
  } catch {
    return [];
  }
}

// memory.md entries the script cannot read; only 狀態 shows them.
export function unreadableMemory() {
  try {
    return unreadableNotes(memoryContext());
  } catch {
    return [];
  }
}

function pendingLines(items, width = BOARD_WIDTH) {
  const rows = withHabits(items).flatMap((x) =>
    x.entries.map((e, i) => [LABELS[x.session.status.kind], e.code, i === 0 ? recycledMark(x.session, e.question) : e.question, e.options, e.suggest, i === 0 ? habitCell(x.habit) : "—"].map(cell)),
  );
  const widest = (i) => Math.max(displayWidth(PENDING_HEAD[i]), ...rows.map((c) => displayWidth(c[i])));
  const room = width - (3 * PENDING_HEAD.length + 1) - widest(0) - widest(1);
  const caps = shareRoom([2, 3, 4, 5].map(widest), room);
  const notes = habitNotes();
  return [
    "### 📋 待回覆",
    "",
    `| ${PENDING_HEAD.join(" | ")} |`,
    `|${" --- |".repeat(PENDING_HEAD.length)}`,
    ...rows.map((c) => `| ${[c[0], c[1], ...caps.map((w, k) => (k === 1 ? clipOptions(c[3], w) : clipWidth(c[k + 2], w)))].join(" | ")} |`),
    ...(notes.length > 0 ? ["", ...notes] : []),
  ];
}

export function pendingBlock(rows, exclude = new Set()) {
  const items = pendingItems(rows, exclude);
  if (items.length > 0) return pendingLines(items);
  return habitNotes();
}

// Pending todo tickets as a 代號｜票號｜標題 table (代號 a, b, c…) clipped to `width`; nothing at all when there are none.
export function todoLines(issues, width = BOARD_WIDTH) {
  if (issues.length === 0) return [];
  const ids = issues.map((i) => cell(i.identifier));
  const room = width - 10 - displayWidth("代號") - Math.max(displayWidth("票號"), ...ids.map(displayWidth));
  return [
    "### 待開工",
    "",
    "| 代號 | 票號 | 標題 |",
    "| --- | --- | --- |",
    ...issues.map((i, k) => `| ${String.fromCharCode(97 + k)} | ${ids[k]} | ${clipWidth(cell(i.title), room)} |`),
  ];
}

function stamp(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// A two-column-plus table clipped to `width`: every column but `flex` keeps its text, `flex` takes what is left.
function plainTable(head, rows, flex, width = BOARD_WIDTH) {
  const cells = rows.map((r) => r.map(cell));
  const widest = (i) => Math.max(displayWidth(head[i]), ...cells.map((c) => displayWidth(c[i])));
  const fixed = head.reduce((n, _, i) => (i === flex ? n : n + widest(i)), 0);
  const room = Math.max(MIN_CLIP, width - (3 * head.length + 1) - fixed);
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...cells.map((c) => `| ${c.map((x, i) => (i === flex ? clipWidth(x, room) : x)).join(" | ")} |`),
  ];
}

// Archived sessions still in Orca, oldest archive first; nothing when there are none.
export function archivedLines(rows, list = readArchive()) {
  const hits = [];
  for (const a of list) {
    const row = rows.find((r) => r.path === a.path);
    const session = row?.sessions.find((s) => s.paneKey === a.paneKey && s.archived);
    if (session) hits.push([sessionTag(row, session), row.title ?? a.title ?? "—", stamp(a.at)]);
  }
  return hits.length > 0 ? ["### 封存", "", ...plainTable(["代號", "摘要", "封存時間"], hits, 1)] : [];
}

function menuLines(questions) {
  const lines = [];
  questions.forEach((q, i) => {
    if (i > 0) lines.push("");
    const head = questions.length > 1 ? `第 ${i + 1} 題 **${q.header ?? ""}**　` : q.header ? `**${q.header}**　` : "";
    lines.push(`> ${head}${q.question ?? ""}${q.multiSelect ? "（可複選）" : ""}`, "");
    lines.push("| # | 選項 | 說明 |", "| --- | --- | --- |");
    (q.options ?? []).forEach((o, j) => {
      const label = isRecommended(o) ? `**${cell(o.label)}**` : cell(o.label);
      lines.push(`| ${letter(j)} | ${label} | ${cell(o.description ?? "")} |`);
    });
    lines.push(`| ${letter((q.options ?? []).length)} | 其他 | 自行輸入 |`);
  });
  return lines;
}

export function reportLines(row, status, session = null, { again = false } = {}) {
  const tag = sessionTag(row, session);
  const title = (status.kind === "waiting" && status.menu ? TITLE.menu : TITLE[status.kind]) + (again ? "（先前已回報，尚未回覆）" : "");
  const lines = [`### ${LABELS[status.kind].split(" ")[0]} ${tag} ${title}`, ""];
  if (status.kind === "waiting" && status.menu) return [...lines, ...menuLines(status.menu)];
  if (status.kind === "waiting" && menuOpen(session?.agent)) {
    return [...lines, "> （讀不到選單內容，請到 Orca 分頁查看）"];
  }
  if (status.kind === "permission") return [...lines, `> **${status.tool}**`, ...quote(status.input)];
  if (status.kind === "anomaly") {
    const screen = (status.screen ?? []).filter((l) => l.trim());
    const where = session?.handle ? `請到 herdr 分頁 ${session.handle} 看畫面後手動處理` : "請到 herdr 分頁看畫面後手動處理";
    return [...lines, `> herdr 回報 ${status.raw ?? "?"}，但讀不到這個 session 的對話紀錄，分不出在等什麼；${where}。`, "", "子 session 畫面：", "```", ...(screen.length > 0 ? screen : ["（讀不到畫面）"]), "```"];
  }
  const { list, at } = status.kind === "waiting" ? textChoices(status.text) : { list: [] };
  const choices = list.map((o, i) => `- ${letter(i)}. ${o.label || o.code}${i === at ? "（建議）" : ""}`);
  return [...lines, ...quote(status.text || "（沒有輸出）"), ...(choices.length > 0 ? ["", ...choices] : [])];
}

export function reportBlock(reports, rows) {
  const list = pendingBlock(rows);
  return [...reports.flatMap((r) => [...r, "", "---", ""]), ...boardLines(rows), ...(list.length > 0 ? ["", ...list] : [])];
}

// One line per finished handoff, labelled like the board (the worktree the session ran in), or 中控台 when the console handed off.
export function handoffLines(rows, events) {
  return events
    .filter((ev) => ["done", "failed"].includes(ev.status) && !ev.reported)
    .map((ev) => {
      const cwd = realpath(ev.cwd ?? "");
      const row = rows.filter((r) => cwd === r.path || cwd.startsWith(`${r.path}${path.sep}`)).sort((a, b) => b.path.length - a.path.length)[0];
      const label = ev.isConsole ? "中控台" : row?.label ?? path.basename(cwd);
      const tagged = ev.isConsole ? { ...row, label } : row;
      if (ev.status === "failed") return { ev, row: tagged, line: `[${label}] 自動交棒失敗：卡在「${ev.step ?? "未知步驟"}」，舊 session 保留` };
      if (ev.cache) return { ev, row: tagged, line: `[${label}] 已自動交棒（快取將到期）` };
      return { ev, row: tagged, line: ev.percent == null ? `[${label}] 已交棒（手動）` : `[${label}] 已自動交棒（context ${ev.percent}%）` };
    });
}

export function parseQuery(query) {
  const m = String(query).trim().match(/^(.+?)#(\d+)$/);
  return m ? { base: m[1], n: Number(m[2]) } : { base: String(query).trim(), n: null };
}

// Each hit is { row, session }; session is null only for a worktree with no claude session.
export function matchSessions(rows, query) {
  const { base, n } = parseQuery(query);
  const hits = [];
  for (const row of matchRows(rows, base)) {
    if (n !== null) {
      const session = row.sessions.find((s) => (s.n ?? 1) === n);
      if (session) hits.push({ row, session });
    } else if (row.sessions.length === 0) hits.push({ row, session: null });
    else for (const session of row.sessions) hits.push({ row, session });
  }
  return hits;
}

// An exact tag wins; `<repo>/<rest>` narrows to that repo; otherwise ticket, number, branch or tag without the repo prefix.
function matchRows(rows, query) {
  const q = String(query).trim();
  const exact = rows.filter((r) => r.label.toUpperCase() === q.toUpperCase());
  if (exact.length > 0) return exact;
  const slash = q.indexOf("/");
  const scoped = slash > 0 ? rows.filter((r) => (r.repo ?? "").toUpperCase() === q.slice(0, slash).toUpperCase()) : [];
  return scoped.length > 0 ? looseMatch(scoped, q.slice(slash + 1)) : looseMatch(rows, q);
}

function looseMatch(rows, q) {
  if (/^\d+$/.test(q)) return rows.filter((r) => r.ticket && r.ticket.split("-")[1] === q);
  const upper = q.toUpperCase();
  return rows.filter((r) => r.ticket === upper || r.branch === q || (r.base ?? r.label).toUpperCase() === upper || [r.nickname, r.alias].some((n) => n?.toUpperCase() === upper));
}

const RULE = /^─{20,}/;
const QUEUED = /ctrl\+enter to send now/;
const VIEW_PAGE = /^\s*Esc to (close|go back|cancel|exit)\b/i;
const PASTED = /\[Pasted text #\d+/;
const SPINNER = /^\S\s+\S.*…\s*\(\d+[hms]\b/;
export const UNSEEN = "畫面上沒看到這句話";
const NEEDLE_MAX = 40;
const squash = (text) => String(text ?? "").replace(/\s+/g, "");

// The newest user prompt block; a prompt whose `❯` line scrolled off shows up as the leading unmarked block.
function lastPrompt(lines) {
  let found = null;
  let current = null;
  let leading = true;
  for (const line of lines) {
    if (line.startsWith("❯")) found = current = [line.slice(1)];
    else if (/^\S/.test(line)) current = null;
    else if (current) current.push(line);
    else if (leading) found = current = [line];
    if (/^\S/.test(line)) leading = false;
  }
  return found;
}

// `terminal` is `orca terminal read --screen` result.terminal. Verdicts: delivered, queued,
// retry (not the chat screen, so the transcript above is stale: Esc then resend once), failed (chat screen without the text).
export function deliveryVerdict(terminal, text) {
  const lines = terminal?.tail ?? [];
  const draft = terminal?.draft ?? "";
  const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []));
  const view = lines.slice((rules.at(-1) ?? lines.length) + 1).some((l) => VIEW_PAGE.test(l));
  const [a, b] = rules.length >= 2 ? rules.slice(-2) : [-1, -1];
  const inputBox = a >= 0 && lines[a + 1]?.startsWith("❯") && b - a <= 12;
  const chat = inputBox && !view;
  if (!chat) return { verdict: "retry", reason: view ? "畫面停在檢視頁" : "畫面上看不到對話輸入框" };
  const block = lastPrompt(lines.slice(0, a)) ?? [];
  const needle = squash(text).slice(-NEEDLE_MAX);
  const queued = block.some((l) => QUEUED.test(l));
  if (needle && squash(block.filter((l) => !QUEUED.test(l)).join("")).includes(needle)) {
    return { verdict: queued ? "queued" : "delivered" };
  }
  if (PASTED.test(draft)) return { verdict: "failed", reason: "被當成貼上內容收起，還留在輸入框" };
  if (needle && squash(draft).includes(needle)) return { verdict: "failed", reason: "還留在輸入框沒送出" };
  return { verdict: "failed", reason: UNSEEN };
}

// A spinner line such as `✢ Moonwalking… (3s · …)` means the child is mid-turn.
export function screenRunning(lines) {
  return (lines ?? []).some((l) => SPINNER.test(l));
}
