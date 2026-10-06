import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIP = 120;
const STATE = ".state";
const ARCHIVE = "transcripts";
const DISTILL_EVERY = 20;
const COMMIT_EVERY = 30 * 60 * 1000;
const DUP_WINDOW = 30 * 1000;
const PREFIX = 20;

function logDir() {
  return process.env.WORKTREE_CONSOLE_LOG_DIR || path.join(os.homedir(), ".worktree-console");
}

function projectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
}

function gitIn(dir, args) {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return { ok: res.status === 0, out: (res.stdout || "").trim() };
}

export const archiveDir = () => path.join(logDir(), ARCHIVE);

// Local-only history: created on first write, never given a remote; transcript copies stay out of git.
export function ensureLogRepo() {
  const dir = logDir();
  fs.mkdirSync(path.join(dir, STATE), { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) gitIn(dir, ["init", "-q"]);
  const file = path.join(dir, ".gitignore");
  const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const missing = [`${STATE}/`, `${ARCHIVE}/`].filter((p) => !have.split("\n").includes(p));
  if (missing.length) fs.writeFileSync(file, `${have}${have && !have.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  return dir;
}

const SECRETS = [
  [/\b([a-z][\w+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1[帳密已遮罩]@"],
  [/\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, "[JWT 已遮罩]"],
  [/\bBearer\s+[\w.~+/-]+=*/g, "Bearer [已遮罩]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[私鑰已遮罩]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[AWS key 已遮罩]"],
  [/\bglpat-[\w-]{20,}/g, "[GitLab token 已遮罩]"],
  [/\bsk-[\w-]{16,}/g, "[sk- key 已遮罩]"],
  [/([\w-]*(?:password|passwd|secret|token)[\w-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[已遮罩]"],
];

function mask(text) {
  return SECRETS.reduce((t, [re, to]) => t.replace(re, to), String(text));
}

export function clip(text, max = CLIP) {
  if (text === null || text === undefined) return null;
  return Array.from(mask(text).replace(/\s+/g, " ").trim()).slice(0, max).join("");
}

export function scrub(value) {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}

function day(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The Claude session a tab runs now, from SessionStart registrations; `/clear`, handoff or `--continue` swap it.
export function sessionFor(handle, events = readEvents()) {
  if (!handle) return null;
  return events.filter((e) => e.event === "session" && e.handle === handle).at(-1)?.sessionId ?? null;
}

export function transcriptFor(handle, events = readEvents()) {
  if (!handle) return null;
  return events.filter((e) => e.event === "session" && e.handle === handle).at(-1)?.transcript ?? null;
}

function sessionsAt(worktree, events = readEvents()) {
  if (!worktree) return [];
  return [...new Set(events.filter((e) => e.event === "session" && e.role !== "console" && e.path === worktree).map((e) => e.sessionId))];
}

// Never throws: logging must not break the command that triggered it.
export function logEvent(event, fields = {}) {
  try {
    const dir = ensureLogRepo();
    const extra = {};
    if (fields.sessionId === undefined && fields.handle) extra.sessionId = sessionFor(fields.handle);
    else if (fields.sessionId === undefined && fields.sessionIds === undefined && fields.path) extra.sessionIds = sessionsAt(fields.path);
    const line = JSON.stringify(scrub({ ts: new Date().toISOString(), event, repo: null, ticket: null, ...fields, ...extra }));
    fs.appendFileSync(path.join(dir, `${day()}.jsonl`), `${line}\n`);
  } catch {}
}

export function readEvents(since = 0) {
  let files;
  try {
    files = fs.readdirSync(logDir()).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const from = since ? day(new Date(since - 24 * 3600 * 1000)) : "";
  const out = [];
  for (const f of files.filter((f) => f.slice(0, 10) >= from)) {
    for (const line of fs.readFileSync(path.join(logDir(), f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (Date.parse(ev.ts) >= since) out.push(ev);
      } catch {}
    }
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

// Latest stop of a terminal tab not yet answered, for the suggestion and labels an answer goes with.
export function lastStop(handle) {
  if (!handle) return null;
  const events = readEvents(Date.now() - 7 * 24 * 3600 * 1000).filter((e) => e.handle === handle);
  const stop = events.filter((e) => e.event === "stop").at(-1);
  if (!stop) return null;
  const answered = events.some((e) => e.event === "answer" && e.ts > stop.ts && /^(delivered|queued|unconfirmed)$/.test(e.delivery ?? ""));
  return answered ? { ...stop, suggestion: null } : stop;
}

// Tabs whose last stop already got a reply: a new question there is a new stop even if the state never left 💬.
export function answeredStops(now = Date.now()) {
  const events = readEvents(now - 2 * 24 * 3600 * 1000);
  const out = new Map();
  for (const stop of events.filter((e) => e.event === "stop")) out.set(stop.handle, stop);
  for (const [handle, stop] of out) {
    const replied = events.some(
      (e) => e.handle === handle && e.ts > stop.ts && ((e.event === "answer" && /^(delivered|queued|unconfirmed)$/.test(e.delivery ?? "")) || e.event === "prompt"),
    );
    if (!replied) out.delete(handle);
  }
  return out;
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
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const managedFile = () => path.join(logDir(), STATE, "managed.json");

// What the console currently manages; the hooks read it to decide whether to write anything.
export function writeManaged(value) {
  try {
    ensureLogRepo();
    writeJson(managedFile(), { ...value, updatedAt: new Date().toISOString() });
  } catch {}
}

export function readManaged() {
  return readJson(managedFile(), null);
}

function inside(p, root) {
  return p === root || p.startsWith(`${root}${path.sep}`);
}

// { repo, ticket, path } for a cwd inside a worktree the console manages, else null.
export function managedTarget(cwd, handle = null) {
  const m = readManaged();
  if (!m || !cwd) return null;
  if (handle && (m.consoles ?? []).includes(handle)) return null;
  const hit = (m.worktrees ?? []).filter((w) => inside(cwd, w.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (hit) return { repo: hit.repo, ticket: hit.ticket, path: hit.path };
  const common = gitIn(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const main = path.dirname(common.out);
  const repo = (m.repos ?? []).find((r) => r.main === main || realpathSafe(r.main) === realpathSafe(main));
  if (!repo) return null;
  const top = gitIn(cwd, ["rev-parse", "--show-toplevel"]).out;
  const branch = gitIn(cwd, ["branch", "--show-current"]).out;
  return { repo: repo.name, ticket: branch || path.basename(top), path: top };
}

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function transcriptOf(sessionId) {
  if (!sessionId) return null;
  try {
    for (const d of fs.readdirSync(projectsDir())) {
      const f = path.join(projectsDir(), d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

// Sessions and prompts the tab logged as a plain session since it last started, which may span midnight.
function dropBeforeConsole(handle, events) {
  const mine = events.filter((e) => e.event === "session" && e.handle === handle && e.role !== "console");
  const start = mine.filter((e) => e.source === "startup").at(-1) ?? mine.filter((e) => e.source === "resume").at(-1);
  if (!start) return;
  const from = Date.parse(start.ts);
  const drop = (e) => (e.event === "session" || e.event === "prompt") && e.handle === handle && e.role !== "console" && Date.parse(e.ts) >= from;
  try {
    for (const f of fs.readdirSync(logDir()).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= day(new Date(from)))) {
      const file = path.join(logDir(), f);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const kept = lines.filter((line) => {
        try {
          return !drop(JSON.parse(line));
        } catch {
          return true;
        }
      });
      if (kept.length !== lines.length) fs.writeFileSync(file, kept.join("\n"));
    }
  } catch {}
}

// Only a session whose own conversation loaded the worktree-console skill is a console: one that merely runs
// `board` or the watcher (a dev session testing the scripts, or its subagents sharing its session id) is not.
export function isConsoleSession(sessionId = process.env.CLAUDE_CODE_SESSION_ID) {
  if (!sessionId) return false;
  return (readEntries(transcriptOf(sessionId)) ?? []).some((e) => !e.isSidechain && loadedConsoleSkill(e));
}

// Registers the console's own Claude session once, so its tokens are counted apart from the tickets.
export function registerConsole({ handle, paneKey, repo }) {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return;
  const events = readEvents();
  if (events.some((e) => e.event === "session" && e.role === "console" && e.sessionId === sessionId)) return;
  if (!isConsoleSession(sessionId)) return;
  if (handle) dropBeforeConsole(handle, events);
  logEvent("session", { role: "console", repo, ticket: "中控台", handle, paneKey, sessionId, transcript: transcriptOf(sessionId) });
}

// Per million tokens; cache writes cost 1.25x input for 5 minutes and 2x for 1 hour.
const PRICES = [
  ["claude-fable-5", { input: 10, output: 50, read: 0.25 }],
  ["claude-mythos-5", { input: 10, output: 50, read: 0.25 }],
  ["claude-opus-5-5", { input: 4, output: 20, read: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, read: 0.5 }],
  ["claude-opus-4", { input: 5, output: 25, read: 0.5 }],
  ["claude-sonnet-5", { input: 2, output: 10, read: 0.2 }],
  ["claude-sonnet-4", { input: 3, output: 15, read: 0.3 }],
  ["claude-haiku-4", { input: 1, output: 5, read: 0.1 }],
].sort((a, b) => b[0].length - a[0].length);

const modelName = (m) => String(m || "unknown").replace(/\[.*\]$/, "");

function price(model) {
  return PRICES.find(([k]) => model.startsWith(k))?.[1] ?? null;
}

const emptyUsage = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0 });

function addUsage(models, model, u, usd) {
  const m = (models[model] ??= emptyUsage());
  m.input += u.input;
  m.output += u.output;
  m.cacheWrite += u.cacheWrite;
  m.cacheRead += u.cacheRead;
  m.usd += usd;
}

// Tokens and estimated USD of one assistant reply.
export function messageUsage(msg) {
  const u = msg.usage;
  const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
  const model = modelName(msg.model);
  const p = price(model);
  const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write = p ? (hour * 2 + (usage.cacheWrite - hour) * 1.25) * p.input : 0;
  const usd = p ? (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.read + write) / 1e6 : 0;
  return { model, usage, usd, tokens: usage.input + usage.output + usage.cacheWrite + usage.cacheRead };
}

export function readEntries(file) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function subagentFiles(file) {
  const dir = path.join(file.replace(/\.jsonl$/, ""), "subagents");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Usage of one session (subagents included): its last `cost-state` when nothing came after it, else
// assistant usage summed once per message.id, since every content block of a reply repeats the same usage.
export function transcriptUsage(file) {
  const entries = readEntries(file);
  if (!entries) return null;
  const at = entries.findLastIndex((e) => e.type === "cost-state");
  const later = at >= 0 && entries.slice(at + 1).some((e) => e.type === "assistant" && e.message?.usage);
  if (at >= 0 && !later) {
    const models = {};
    for (const [name, u] of Object.entries(entries[at].modelUsage ?? {})) {
      const usage = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0 };
      addUsage(models, modelName(name), usage, u.costUSD ?? 0);
    }
    return { source: "cost-state", models };
  }
  const models = {};
  const seen = new Set();
  for (const list of [entries, ...subagentFiles(file).map(readEntries).filter(Boolean)]) {
    for (const e of list) {
      const msg = e.message;
      if (e.type !== "assistant" || !msg?.usage) continue;
      const id = msg.id ?? e.uuid;
      if (seen.has(id)) continue;
      seen.add(id);
      const { model, usage, usd } = messageUsage(msg);
      addUsage(models, model, usage, usd);
    }
  }
  return { source: "message-id", models };
}

export const SKIP_PROMPT = /^\s*<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|bash-input)/;
export const NOTIFICATION = /^\s*<task-notification>/;
const COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/;

// Text of a user entry that is a message rather than a tool result; null otherwise.
export function promptText(entry) {
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary) return null;
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((p) => p.type === "tool_result")) return null;
  const text = content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
  return text || null;
}

function skillCalls(entries) {
  const out = [];
  for (const e of entries) {
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const part of e.message.content) {
      if (part.type === "tool_use" && part.name === "Skill" && part.input?.skill) out.push({ name: part.input.skill, at: e.timestamp });
    }
  }
  return out;
}

// What one session did, from its transcript: skills (tool calls, subagents included) and slash commands with
// first use, turns you sent, each stretch of work from a message to its last reply or tool result, and the
// stop events of this session moved back to the last reply before them.
export function transcriptActivity(file, stops = []) {
  const entries = readEntries(file);
  if (!entries) return null;
  const skills = new Map();
  const commands = new Map();
  const segments = [];
  const replies = [];
  let current = null;
  let turns = 0;
  for (const e of entries) {
    const at = e.timestamp;
    if (!at) continue;
    const text = promptText(e);
    if (text !== null && !SKIP_PROMPT.test(text)) {
      const cmd = text.match(COMMAND);
      if (cmd && !commands.has(cmd[1])) commands.set(cmd[1], at);
      current = { start: at, end: at, prompt: !NOTIFICATION.test(text) };
      if (current.prompt) turns++;
      segments.push(current);
      continue;
    }
    if (e.type === "assistant") replies.push(at);
    const toolResult = e.type === "user" && Array.isArray(e.message?.content) && e.message.content.some((p) => p.type === "tool_result");
    if (current && (e.type === "assistant" || toolResult) && at > current.end) current.end = at;
  }
  for (const list of [entries, ...subagentFiles(file).map(readEntries).filter(Boolean)]) {
    for (const { name, at } of skillCalls(list)) if (!skills.has(name) || at < skills.get(name)) skills.set(name, at);
  }
  const stopTimes = {};
  for (const stop of stops) {
    const before = replies.filter((r) => r <= stop.ts).at(-1);
    if (before) stopTimes[stop.ts] = before;
  }
  const stamps = entries.map((e) => e.timestamp).filter(Boolean).sort();
  return {
    skills: [...skills].map(([name, at]) => ({ name, at })),
    commands: [...commands].map(([name, at]) => ({ name, at })),
    turns,
    segments,
    firstAt: stamps[0] ?? null,
    lastAt: stamps.at(-1) ?? null,
    stopTimes,
  };
}

const totalTokens = (models) => Object.values(models ?? {}).reduce((n, m) => n + m.input + m.output + m.cacheWrite + m.cacheRead, 0);

const tokensFile = () => path.join(logDir(), "tokens.json");

export function readTokens() {
  return readJson(tokensFile(), { computedAt: null, buckets: {} });
}

function projectTranscripts(worktree) {
  const dir = path.join(projectsDir(), worktree.replace(/[^a-zA-Z0-9]/g, "-"));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Recounts every session still on disk into tokens.json: registered ones by their own transcript path,
// older unregistered ones by the worktree's transcript folder (not for main checkouts, whose folder holds
// unrelated history); a smaller recount keeps the old numbers.
export function computeTokens(now = new Date()) {
  const stamp = now.toISOString();
  const prev = readTokens();
  const buckets = structuredClone(prev.buckets ?? {});
  const events = readEvents();
  const sessions = events.filter((e) => e.event === "session");
  const stopsOf = new Map();
  for (const e of events.filter((e) => e.event === "stop" && e.sessionId)) stopsOf.set(e.sessionId, [...(stopsOf.get(e.sessionId) ?? []), e]);
  const consoleIds = new Set(sessions.filter((e) => e.role === "console").map((e) => e.sessionId));
  const plan = new Map();
  const want = (key, meta, sessionId, file) => {
    if (!plan.has(key)) plan.set(key, { meta, files: new Map() });
    if (meta.main) plan.get(key).meta.main = true;
    if (file) plan.get(key).files.set(sessionId, file);
  };
  for (const e of sessions) {
    if (e.role === "console") want("中控台", { repo: null, ticket: "中控台", path: null }, e.sessionId, e.transcript ?? transcriptOf(e.sessionId));
    else if (e.path) want(`${e.repo}/${e.ticket}`, { repo: e.repo, ticket: e.ticket, path: e.path }, e.sessionId, e.transcript);
  }
  for (const w of readManaged()?.worktrees ?? []) want(`${w.repo}/${w.ticket}`, { repo: w.repo, ticket: w.ticket, path: w.path, main: !!w.main });
  for (const [key, b] of Object.entries(buckets)) if (b.path) want(key, { repo: b.repo, ticket: b.ticket, path: b.path, main: !!b.main });
  for (const [key, { meta, files }] of plan) {
    if (meta.path && !meta.main) {
      for (const f of projectTranscripts(meta.path)) {
        const id = path.basename(f, ".jsonl");
        if (!consoleIds.has(id) && !files.has(id)) files.set(id, f);
      }
    }
    const bucket = (buckets[key] ??= { ...meta, sessions: {}, models: {}, computedAt: null });
    if (meta.main) bucket.main = true;
    let changed = false;
    for (const [id, file] of files) {
      const usage = file ? transcriptUsage(file) : null;
      const old = bucket.sessions[id];
      if (!usage || (old && totalTokens(usage.models) < totalTokens(old.models))) continue;
      const activity = transcriptActivity(file, stopsOf.get(id) ?? []);
      if (old && JSON.stringify([old.models, old.activity]) === JSON.stringify([usage.models, activity])) continue;
      bucket.sessions[id] = { transcript: file, source: usage.source, models: usage.models, activity, computedAt: stamp };
      changed = true;
    }
    if (!changed) continue;
    bucket.models = {};
    for (const s of Object.values(bucket.sessions)) {
      for (const [m, u] of Object.entries(s.models)) addUsage(bucket.models, m, u, u.usd);
    }
    bucket.computedAt = stamp;
  }
  if (JSON.stringify(buckets) === JSON.stringify(prev.buckets ?? {})) return prev;
  const next = { computedAt: stamp, buckets };
  try {
    ensureLogRepo();
    writeJson(tokensFile(), next);
  } catch {}
  return next;
}

let known = null;

// Subcommands console.mjs dispatches, read from its `commands` table.
export function consoleSubcommands() {
  if (known) return known;
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "console.mjs"), "utf8");
  const body = src.slice(src.indexOf("const commands = {"));
  known = [...body.slice(0, body.indexOf("};")).matchAll(/^\s*"?([a-z][a-z-]*)"?\s*[:,]/gm)].map((m) => m[1]);
  return known;
}

// `console.mjs <subcommand>` calls in one shell command, also through a variable holding the script path.
export function consoleCalls(command) {
  const vars = [...String(command).matchAll(/\b([A-Za-z_]\w*)=(["']?)[^\s;"'&|]*console\.mjs\2/g)].map((m) => m[1]);
  const ref = ["console\\.mjs", ...vars.map((v) => `\\$\\{?${v}\\}?`)].join("|");
  const subs = new Set(consoleSubcommands());
  return [...String(command).matchAll(new RegExp(`(?:${ref})["']?\\s+([a-z][a-z-]*)`, "g"))].map((m) => m[1]).filter((x) => subs.has(x));
}

function bashCommands(entry) {
  if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) return [];
  return entry.message.content.filter((p) => p.type === "tool_use" && p.name === "Bash").map((p) => ({ id: p.id, command: String(p.input?.command ?? "") }));
}

const SKILL_LOADED = /^Base directory for this skill: \S*\/skills\/worktree-console\s*$/m;

function loadedConsoleSkill(entry) {
  if (entry.type !== "user") return false;
  const content = entry.message?.content;
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text ?? "") : [];
  return texts.some((t) => SKILL_LOADED.test(t.split("\n")[0]));
}

// Consoles that ran before registration existed: a transcript that loaded the worktree-console skill and ran `board`.
// Runs once; later consoles register themselves.
export function backfillConsoles() {
  const marker = path.join(logDir(), STATE, "backfill.json");
  if (fs.existsSync(marker)) return [];
  const known = new Set(readEvents().filter((e) => e.event === "session").map((e) => e.sessionId));
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir());
  } catch {}
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(projectsDir(), d)).filter((f) => f.endsWith(".jsonl"));
    } catch {}
    for (const f of files) {
      const file = path.join(projectsDir(), d, f);
      const id = path.basename(f, ".jsonl");
      if (known.has(id)) continue;
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!text.includes("skills/worktree-console")) continue;
      const entries = text.split("\n").flatMap((line) => {
        try {
          return line.trim() ? [JSON.parse(line)] : [];
        } catch {
          return [];
        }
      });
      if (!entries.some(loadedConsoleSkill) || !entries.some((e) => bashCommands(e).some((c) => consoleCalls(c.command).includes("board")))) continue;
      const cwd = entries.find((e) => e.cwd)?.cwd;
      found.push({ sessionId: id, transcript: file, repo: cwd ? path.basename(cwd) : null });
    }
  }
  for (const c of found) logEvent("session", { role: "console", repo: c.repo, ticket: "中控台", handle: null, paneKey: null, sessionId: c.sessionId, transcript: c.transcript, source: "backfill" });
  try {
    writeJson(marker, { at: new Date().toISOString(), sessionIds: found.map((c) => c.sessionId) });
  } catch {}
  return found;
}

const archiveState = () => path.join(logDir(), STATE, "archive.json");

function lineCount(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// A transcript line with only its text values masked, so usage numbers and field names stay as they were.
export function scrubLine(line) {
  try {
    return JSON.stringify(scrub(JSON.parse(line)));
  } catch {
    return mask(line);
  }
}

// Copies every registered session (its subagents appended) into transcripts/<sessionId>.jsonl, masked. A newer
// copy replaces the old one; a missing source or a copy with fewer lines keeps the old one. Never deletes.
export function archiveTranscripts(events = readEvents()) {
  const state = readJson(archiveState(), { order: [], sources: {} });
  const latest = new Map();
  for (const e of events.filter((e) => e.event === "session" && e.sessionId)) latest.set(e.sessionId, e.transcript ?? latest.get(e.sessionId) ?? null);
  const copied = [];
  for (const [id, registered] of latest) {
    const file = registered && fs.existsSync(registered) ? registered : transcriptOf(id);
    if (!file) continue;
    const files = [file, ...subagentFiles(file).sort()];
    let sig;
    try {
      sig = files.map((f) => `${f}:${fs.statSync(f).size}:${fs.statSync(f).mtimeMs}`).join("|");
    } catch {
      continue;
    }
    const out = path.join(archiveDir(), `${id}.jsonl`);
    if (state.sources[id] === sig && fs.existsSync(out)) continue;
    const lines = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()));
    if (lines.length < lineCount(out)) continue;
    fs.mkdirSync(archiveDir(), { recursive: true });
    fs.writeFileSync(`${out}.tmp`, `${lines.map(scrubLine).join("\n")}\n`);
    fs.renameSync(`${out}.tmp`, out);
    state.sources[id] = sig;
    if (!state.order.includes(id)) state.order.push(id);
    copied.push(id);
  }
  writeJson(archiveState(), state);
  return copied;
}

export function archiveAll() {
  try {
    ensureLogRepo();
    backfillConsoles();
    return archiveTranscripts();
  } catch {
    return [];
  }
}

const distillState = () => path.join(logDir(), STATE, "distill.json");
export const distillList = () => path.join(logDir(), "distill-batch.txt");

function distillBatch() {
  const order = readJson(archiveState(), { order: [] }).order;
  const s = readJson(distillState(), { mark: 0, reminded: false });
  return { order, s, batch: order.slice(s.mark, s.mark + DISTILL_EVERY) };
}

// One line once the copies since the last mark reach 20: when the 20th lands, and again on every console start
// until `已蒸餾` is marked.
export function distillReminder({ start = false } = {}) {
  try {
    const { order, s, batch } = distillBatch();
    if (batch.length < DISTILL_EVERY || (s.reminded && !start)) return null;
    fs.writeFileSync(distillList(), `${batch.map((id) => path.join(archiveDir(), `${id}.jsonl`)).join("\n")}\n`);
    writeJson(distillState(), { ...s, reminded: true });
    return `[蒸餾] 已保存 ${order.length - s.mark} 份對話紀錄待蒸餾，這批 ${DISTILL_EVERY} 份的路徑清單：${distillList()}；處理完打「已蒸餾」`;
  } catch {
    return null;
  }
}

export function markDistilled(now = new Date()) {
  const { order, s, batch } = distillBatch();
  if (batch.length < DISTILL_EVERY) return `[蒸餾] 還沒累積到 ${DISTILL_EVERY} 份（目前 ${order.length - s.mark} 份），不用標記`;
  const mark = s.mark + DISTILL_EVERY;
  ensureLogRepo();
  writeJson(distillState(), { mark, reminded: false, markedAt: now.toISOString() });
  return `[蒸餾] 已標記處理到第 ${mark} 份，下一批從第 ${mark + 1} 份起算（目前累積 ${order.length - mark} 份）`;
}

// Commits when forced (console start, a ticket closed) or every 30 minutes; tokens are recounted right before.
export function commitLog({ force = false, reason = "", now = Date.now() } = {}) {
  try {
    const dir = ensureLogRepo();
    const last = Number(gitIn(dir, ["log", "-1", "--format=%ct"]).out || 0) * 1000;
    const closed = readEvents(last + 1).some((e) => e.event === "close");
    if (!force && !closed && now - last < COMMIT_EVERY) return false;
    archiveAll();
    computeTokens(new Date(now));
    if (!gitIn(dir, ["status", "--porcelain"]).out) return false;
    gitIn(dir, ["add", "-A"]);
    const why = reason || (closed ? "關票" : "定時");
    const res = spawnSync(
      "git",
      ["-C", dir, "-c", "user.name=worktree-console", "-c", "user.email=worktree-console@localhost", "commit", "-q", "-m", `log: ${new Date(now).toISOString()} ${why}`],
      { encoding: "utf8" },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

// ---- report ----

export function parseSince(text, now = Date.now()) {
  if (!text) return 0;
  const m = String(text).match(/^(\d+)\s*([hdw])$/i);
  if (m) return now - Number(m[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2].toLowerCase()];
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`看不懂期間「${text}」：請用 24h、7d、2w 或日期`);
  return t;
}

function cell(text) {
  return String(text ?? "—").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|") || "—";
}

function table(head, rows) {
  if (rows.length === 0) return ["（沒有資料）"];
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

const ticketOf = (e) => (e.repo ? `${e.repo}/${e.ticket}` : e.ticket ?? "—");

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 時 ${Math.floor((s % 3600) / 60)} 分`;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Answers from the console plus what was typed straight into the tab; a typed line that repeats a console
// answer to the same tab within seconds is the same reply seen twice.
export function replies(events) {
  const sent = events.filter((e) => e.event === "answer");
  const typed = events.filter(
    (e) =>
      e.event === "prompt" &&
      !sent.some((a) => a.handle === e.handle && clip(a.answer) === clip(e.text) && Math.abs(Date.parse(a.ts) - Date.parse(e.ts)) <= DUP_WINDOW),
  );
  return [...sent, ...typed.map((e) => ({ ...e, via: "typed", answer: e.text, delivery: "delivered" }))].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

const landed = (r) => ["delivered", "queued", "unconfirmed"].includes(r.delivery);

// Stop time moved back to the session's last reply before it, when a recount found one.
export function stopTime(stop, tokens) {
  for (const b of Object.values(tokens?.buckets ?? {})) {
    const fixed = b.sessions?.[stop.sessionId]?.activity?.stopTimes?.[stop.ts];
    if (fixed) return Date.parse(fixed);
  }
  return Date.parse(stop.ts);
}

// Each stop paired with the first reply that reached the same tab before the tab stopped again.
export function pairStops(events, all = replies(events)) {
  const stops = events.filter((e) => e.event === "stop");
  const answers = all.filter(landed);
  return stops.map((stop) => {
    const t = Date.parse(stop.ts);
    const next = stops.find((s) => s !== stop && s.handle === stop.handle && Date.parse(s.ts) > t);
    const end = next ? Date.parse(next.ts) : Infinity;
    const reply = answers.find((a) => a.handle === stop.handle && Date.parse(a.ts) >= t && Date.parse(a.ts) <= end) ?? null;
    return { stop, reply };
  });
}

const STATUS = { waiting: "💬 等待回應", permission: "🔐 等待授權", done: "⏸ 回覆完畢" };
const VIA = { text: "文字", menu: "選單", permission: "授權", typed: "Orca 分頁直接輸入" };

export function reportLines(events, tokens, since = 0) {
  const out = [];
  const answers = replies(events);
  const pairs = pairStops(events, answers);

  out.push("### 常卡的問題", "");
  const groups = new Map();
  for (const { stop } of pairs) {
    const head = Array.from(stop.question ?? "").slice(0, PREFIX).join("") || "—";
    const key = `${ticketOf(stop)}\u0000${head}\u0000${stop.status}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const stuck = [...groups].map(([k, n]) => [...k.split("\u0000"), n]).sort((a, b) => b[3] - a[3] || a[0].localeCompare(b[0]));
  out.push(...table(["票號", "問題開頭", "狀態", "次數"], stuck.map(([t, h, s, n]) => [t, h, STATUS[s] ?? s, n])), "");

  out.push("### 等待時間（停下到回答送達）", "");
  const waits = new Map();
  for (const { stop, reply } of pairs) {
    if (!reply) continue;
    const list = waits.get(ticketOf(stop)) ?? [];
    list.push(Date.parse(reply.ts) - stopTime(stop, tokens));
    waits.set(ticketOf(stop), list);
  }
  const unanswered = (t) => pairs.filter((p) => !p.reply && ticketOf(p.stop) === t).length;
  out.push(
    ...table(
      ["票號", "回答次數", "中位數", "最長", "未回答"],
      [...waits].map(([t, xs]) => [t, xs.length, duration(median(xs)), duration(Math.max(...xs)), unanswered(t)]),
    ),
    "",
  );

  out.push("### token 與費用", "");
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const rows = [];
  const buckets = Object.entries(tokens?.buckets ?? {}).sort(([a], [b]) => (a === "中控台") - (b === "中控台") || a.localeCompare(b));
  for (const [key, b] of buckets) {
    for (const [model, u] of Object.entries(b.models ?? {})) {
      if (u.input + u.output + u.cacheWrite + u.cacheRead === 0) continue;
      rows.push([key, model, fmt(u.input), fmt(u.output), fmt(u.cacheWrite), fmt(u.cacheRead), `$${u.usd.toFixed(2)}`, b.computedAt ?? "—"]);
    }
  }
  out.push(...table(["票號", "模型", "輸入", "輸出", "cache 寫入", "cache 讀取", "估算美元", "計算時間"], rows), "");

  out.push("### 偏離建議的回答", "");
  const off = [];
  for (const r of answers.filter(landed)) {
    const pair = pairs.find((p) => p.reply === r);
    const suggestion = r.via === "menu" ? r.suggestion : pair ? pair.stop.suggestion : null;
    if (r.via === "menu" && r.offSuggestion) off.push([r.ts, ticketOf(r), VIA.menu, suggestion, r.answer, "選了非建議選項"]);
    else if (["text", "typed"].includes(r.via) && suggestion) off.push([r.ts, ticketOf(pair?.stop ?? r), VIA[r.via], suggestion, r.answer, "文字題，待比對"]);
  }
  out.push(...table(["時間", "票號", "方式", "建議", "我的回答", "標記"], off), "");

  out.push("### 每個 session", "");
  out.push(...table(SESSION_HEAD, sessionRows(events, tokens, pairs, answers, since)));
  return out;
}

const SESSION_HEAD = ["票號", "session", "觸發", "skill", "停下", "回應中位數", "處理時間", "完畢後再指令", "總時間", "產出"];
const START_WINDOW = 2 * 60 * 1000;
const SOURCE = { startup: "新開", resume: "恢復", clear: "清空後", compact: "壓縮後", backfill: "補登記" };

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function outputText(o) {
  if (!o) return "—";
  const parts = [`${o.commits} commit`, `${o.files} 檔 +${o.insertions}/-${o.deletions}`, o.pushed ? "已 push" : "未 push"];
  if (o.stage) parts.push(o.stage);
  return parts.join("，");
}

// One row per session the recount knows about and the period touches, labelled with its ticket.
function sessionRows(events, tokens, pairs, answers, since) {
  const starts = events.filter((e) => e.event === "start");
  const registered = new Map(events.filter((e) => e.event === "session").map((e) => [e.sessionId, e]));
  const handoffs = events.filter((e) => e.event === "handoff" && e.newSessionId);
  const closes = events.filter((e) => e.event === "close" && e.output);
  const rows = [];
  for (const [key, b] of Object.entries(tokens?.buckets ?? {})) {
    for (const [id, s] of Object.entries(b.sessions ?? {})) {
      const a = s.activity;
      if (!a?.lastAt || Date.parse(a.lastAt) < since) continue;
      const reg = registered.get(id);
      const mine = pairs.filter((p) => p.stop.sessionId === id);
      const waits = mine.filter((p) => p.reply).map((p) => [stopTime(p.stop, tokens), Date.parse(p.reply.ts)]);
      const work = a.segments.reduce((n, g) => {
        const [g0, g1] = [Date.parse(g.start), Date.parse(g.end)];
        return n + (g1 - g0) - waits.reduce((m, [w0, w1]) => m + overlap(g0, g1, w0, w1), 0);
      }, 0);
      const first = answers.find((r) => r.sessionId === id) ?? null;
      const from = handoffs.find((h) => h.newSessionId === id);
      const started = first && starts.some((st) => (st.sessionIds ?? []).includes(id) && Math.abs(Date.parse(st.ts) - Date.parse(first.ts)) <= START_WINDOW);
      const by = !first ? null : from && first.via === "typed" ? "交棒指令" : started && first.via === "typed" ? "開工指令" : VIA[first.via] ?? first.via;
      const trigger = [SOURCE[reg?.source] ?? reg?.source, by ? `首句：${by}` : null, from ? `接手自 ${String(from.oldSessionId ?? "?").slice(0, 8)}` : null]
        .filter(Boolean)
        .join("，");
      const again = mine.filter((p) => p.stop.status === "done" && p.reply).length;
      const close = closes.filter((c) => (c.sessionIds ?? []).includes(id) || (b.path && c.path === b.path)).at(-1);
      rows.push([
        key,
        id.slice(0, 8),
        trigger || "—",
        [...a.skills.map((x) => x.name), ...a.commands.map((x) => `/${x.name}`)].join("、") || "—",
        mine.length,
        waits.length ? duration(median(waits.map(([w0, w1]) => w1 - w0))) : "—",
        duration(work),
        again,
        duration(Date.parse(a.lastAt) - Date.parse(a.firstAt)),
        outputText(close?.output),
      ]);
    }
  }
  return rows.sort((x, y) => (x[0] === "中控台") - (y[0] === "中控台") || x[0].localeCompare(y[0]));
}
