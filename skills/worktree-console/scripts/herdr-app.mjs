// The Herdr app as the console's terminal manager: herdr-core (`hc`) runs the terminals, `herdr-app` arranges spaces
// and tabs. Its state is read into herdr's snapshot shape, so herdr's status rules apply unchanged.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectDir, consoleHome, realpath, sessionTag } from "./lib.mjs";
import { readEvents, transcriptFor } from "./log.mjs";
import { auditRows, draftOf, herdrAgent, isPrompt, linear, promptText, readTranscript, repoName, snapshotFrom, tabRenames, workspaceNamed } from "./herdr.mjs";
import { terminalError } from "./terminals.mjs";

export const NAME = "herdr-app";
const SESSIONS = "herdr-app-sessions.json";
export const BOARD = "herdr-app-board.json";
export const BOARD_MOD = "worktree-board";
const MOD_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "herdr-app", "mods", BOARD_MOD);
// hc's statuses; `error` and none at all leave the state to the transcript, like herdr's unknown.
const STATUS = { idle: "idle", working: "working", blocked: "blocked", done: "done" };
const KEY = "hc";

export function hcBin() {
  return process.env.HC_BIN || "hc";
}

export function appBin() {
  return process.env.HERDR_APP_BIN || "herdr-app";
}

export function appHome() {
  return process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
}

// The Herdr app's worktree menu puts checkouts in ~/.herdr/worktrees/<repo>/<branch as a folder name>.
export function appWorktreeHome() {
  return process.env.HERDR_APP_WORKTREES || path.join(os.homedir(), ".herdr", "worktrees");
}

export const branchFolder = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// hc prints JSON when piped and `{error: {kind, message}}` on stderr. A send from inside a Herdr app terminal is
// wrapped in `<hc from=…>`, which keeps a slash command from running, so sends go without the caller's address.
export function runHc(args, { raw = false, anonymous = false } = {}) {
  const env = { ...process.env };
  if (anonymous) for (const k of ["HC_TERMINAL_ID", "HC_SCOPE"]) delete env[k];
  const res = spawnSync(hcBin(), raw ? args : [args[0], "--json", ...args.slice(1)], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { ok: false, error: { code: "unreachable", message: res.error.message } };
  if (res.status === 0) return raw ? { ok: true, text: res.stdout } : { ok: true, result: parse(res.stdout) ?? {} };
  const err = (parse(res.stderr) ?? parse(res.stdout))?.error;
  return { ok: false, error: { code: err?.kind ?? "unreachable", message: err?.message ?? (res.stderr || res.stdout || "").trim() } };
}

// `herdr-app do <command> <json>` prints what it made, or `{error}` with exit 1; `herdr-app ls` prints the spaces.
export function runApp(args) {
  const res = spawnSync(appBin(), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { ok: false, error: { code: "unreachable", message: res.error.message } };
  const out = parse(res.stdout) ?? parse(res.stderr);
  if (res.status === 0 && out && !out.error) return { ok: true, result: out };
  return { ok: false, error: { code: typeof out?.error === "string" ? out.error : out?.error?.kind ?? "unreachable", message: (res.stderr || res.stdout || "").trim() } };
}

const run = (command, args) => runApp(["do", command, JSON.stringify(args)]);
const ok = (res) => (res.ok ? { ok: true } : { ok: false, code: res.error?.code ?? "unknown" });
const pollMs = () => Number(process.env.HERDR_APP_POLL_MS ?? 500);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const paneKeyOf = (handle) => `${KEY}:${handle}`;
const order = (id) => {
  const n = Number.parseInt(String(id).replace(/^t/, ""), 36);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
};

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(consoleHome(), name), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  fs.mkdirSync(consoleHome(), { recursive: true });
  fs.writeFileSync(path.join(consoleHome(), name), JSON.stringify(value, null, 2));
}

// Sessions the console started with `--session-id` (or resumed): hc never reports Claude's session id.
function rememberSession(handle, sessionId, cwd) {
  try {
    writeJson(SESSIONS, { ...readJson(SESSIONS, {}), [handle]: { sessionId, cwd, at: new Date().toISOString() } });
  } catch {}
}

function transcriptOf(sessionId, cwd) {
  const direct = path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  const base = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
  try {
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return -1;
  }
};

// The session in a tab: the one the console started it with, or the one the console-log hook registered for it,
// whichever wrote last (a /clear starts a new one only the hook sees). Without a transcript yet, the started one.
function sessionIdOf(handle, events = readEvents()) {
  const rec = readJson(SESSIONS, {})[handle] ?? null;
  const hooked = transcriptFor(handle, events);
  const files = [rec ? transcriptOf(rec.sessionId, rec.cwd) : null, hooked && fs.existsSync(hooked) ? hooked : null].filter(Boolean);
  const newest = files.sort((a, b) => mtime(b) - mtime(a))[0];
  return newest ? path.basename(newest, ".jsonl") : rec?.sessionId ?? null;
}

// The Herdr app's spaces, tabs and terminals in herdr's snapshot shape; claude is the agent that reports `claude-code`.
function appSnapshot({ sessions = true } = {}) {
  const ls = runApp(["ls"]);
  if (!ls.ok) throw terminalError(NAME, ls.error);
  const live = runHc(["ls"]);
  if (!live.ok) throw terminalError(NAME, live.error);
  const byAddress = new Map((live.result.terminals ?? []).map((t) => [t.address, t]));
  const events = sessions ? readEvents() : [];
  const snap = { workspaces: [], tabs: [], panes: [], agents: [] };
  for (const space of ls.result.spaces ?? []) {
    snap.workspaces.push({ workspace_id: space.id, label: space.name });
    for (const tab of space.tabs ?? []) {
      snap.tabs.push({ tab_id: tab.id, label: tab.name, workspace_id: space.id });
      for (const t of tab.terminals ?? []) {
        const h = byAddress.get(t.terminal);
        if (!h || h.state === "finished") continue;
        const claude = (h.agent ?? t.app) === "claude-code";
        const pane = { pane_id: t.terminal, app_pane: t.pane, workspace_id: space.id, tab_id: tab.id, cwd: h.cwd || space.folder, agent: claude ? "claude" : h.agent ?? null };
        snap.panes.push(pane);
        if (!claude) continue;
        const id = sessions ? sessionIdOf(t.terminal, events) : null;
        snap.agents.push({ ...pane, agent_status: STATUS[h.status] ?? "unknown", agent_session: id ? { kind: "id", value: id } : null, name: t.name ?? null });
      }
    }
  }
  return snap;
}

export function screenLines(handle) {
  const res = runHc(["read", handle], { raw: true });
  return res.ok ? res.text.replace(/\n+$/, "").split("\n").map((l) => l.trimEnd()) : null;
}

const agentOf = (a) => ({ ...herdrAgent(a, screenLines), paneKey: paneKeyOf(a.pane_id) });
const split = (id) => ({ tabId: KEY, leafId: id });
const inside = (p, root) => p === root || p.startsWith(`${root}${path.sep}`);

function focusedTab() {
  const res = runApp(["status"]);
  return res.ok ? res.result.tab ?? null : null;
}

// tab.new and space.new focus the new tab; the person stays where they were, as herdr's --no-focus kept them.
function unfocused(make) {
  const before = focusedTab();
  const made = make();
  if (before && made.ok && made.result?.tab !== before) run("tab.select", { id: before });
  return made;
}

function gone(handles, ms = Number(process.env.HERDR_APP_CLOSE_MS ?? 10000)) {
  const deadline = Date.now() + ms;
  for (;;) {
    const res = runHc(["ls"]);
    const live = new Set(res.ok ? (res.result.terminals ?? []).filter((t) => t.state !== "finished").map((t) => t.address) : []);
    if (res.ok && handles.every((h) => !live.has(h))) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(pollMs());
  }
}

// A tab whose terminals all go is closed whole; a terminal sharing its tab with others loses only its pane.
function closePanes(snap, panes) {
  if (panes.length === 0) return { ok: true };
  const closing = new Set(panes.map((p) => p.pane_id));
  for (const tab of new Set(panes.map((p) => p.tab_id))) {
    const all = snap.panes.filter((p) => p.tab_id === tab);
    const res = all.every((p) => closing.has(p.pane_id))
      ? run("tab.close", { id: tab, confirmed: true })
      : panes.filter((p) => p.tab_id === tab).reduce((r, p) => (r.ok ? run("pane.close", { pane: p.app_pane }) : r), { ok: true });
    if (!res.ok) return ok(res);
  }
  return gone([...closing]) ? { ok: true } : { ok: false, code: "still-open" };
}

const typed = new Map();
const titles = new Map();

// What the board mod shows: one line per session on the board, rewritten on every read so its age tells whether
// a console still runs.
export function boardState(rows, now = Date.now()) {
  const list = rows.flatMap((r) =>
    r.sessions.filter((s) => s.handle && !s.archived).map((s) => ({ tag: sessionTag(r, s), kind: s.status.kind, since: s.agent?.stateStartedAt ?? null, terminal: s.handle })),
  );
  return { at: now, rows: list };
}

// Copies the board mod into the Herdr app's mods folder when it is missing or differs, and tells it where the
// console's state file is. Only its own files: `herdr-app check` leaves jsconfig.json and .d.ts files beside them.
export function installBoardMod(home = appHome()) {
  const dest = path.join(home, "mods", BOARD_MOD);
  const own = fs.readdirSync(MOD_SOURCE).filter((f) => f.endsWith(".js") || f === "mod.json");
  const files = { ...Object.fromEntries(own.map((f) => [f, fs.readFileSync(path.join(MOD_SOURCE, f), "utf8")])), ".board-path": path.join(consoleHome(), BOARD) };
  const changed = [];
  fs.mkdirSync(dest, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    const file = path.join(dest, f);
    let now = null;
    try {
      now = fs.readFileSync(file, "utf8");
    } catch {}
    if (now === text) continue;
    fs.writeFileSync(file, text);
    changed.push(f);
  }
  return { dest, changed };
}

export const herdrAppTerminals = {
  name: NAME,
  selfHandle: () => process.env.HC_TERMINAL_ID || null,
  snapshot({ agents = true } = {}) {
    return snapshotFrom(appSnapshot({ sessions: agents }), { agents, split, order, agentOf });
  },
  terminalList() {
    try {
      return { ok: true, terminals: this.snapshot({ agents: false }).terminals };
    } catch (error) {
      return { ok: false, code: error.message };
    }
  },
  ps() {
    try {
      return { ok: true, worktrees: this.snapshot().ps };
    } catch (error) {
      return { ok: false, code: error.message };
    }
  },
  agentAt(paneKey) {
    try {
      const a = appSnapshot().agents.find((x) => paneKeyOf(x.pane_id) === paneKey);
      return a ? agentOf(a) : null;
    } catch {
      return null;
    }
  },
  agentOf(handle) {
    return this.agentAt(paneKeyOf(handle));
  },
  lastPrompt(handle) {
    let a;
    try {
      a = appSnapshot().agents.find((x) => x.pane_id === handle);
    } catch {
      return null;
    }
    const id = a?.agent_session?.value;
    const file = id ? transcriptOf(id, a.cwd) : null;
    const read = file ? readTranscript(file) : null;
    const last = (read?.entries ?? []).filter((e) => e.type === "user" && !e.isSidechain && isPrompt(e)).at(-1);
    return last ? promptText(last) : null;
  },
  readScreen(handle) {
    const tail = screenLines(handle);
    return tail ? { ok: true, terminal: { tail, draft: draftOf(tail) } } : { ok: false, code: "unreadable" };
  },
  // With Enter it goes through `hc send`, which refuses a session waiting at a permission or menu.
  send(handle, text, { enter = false } = {}) {
    if (!enter) return this.type(handle, text);
    return ok(runHc(["send", handle, "--", text], { anonymous: true }));
  },
  // hc can't type without Enter (and `hc keys` takes no CJK), so typed text waits for the Enter that sends it.
  type(handle, text) {
    typed.set(handle, `${typed.get(handle) ?? ""}${text}`);
    return { ok: true };
  },
  key(handle, key) {
    if (key === "enter" && typed.has(handle)) {
      const text = typed.get(handle);
      typed.delete(handle);
      return ok(runHc(["send", "--force", handle, "--", text], { anonymous: true }));
    }
    return ok(runHc(["keys", handle, key]));
  },
  // Every tab it opens has a name; a repo without its space gets one named after it. The session id is chosen here,
  // so its transcript is known before any hook runs.
  create(worktreePath, { args = [], label = null, name = null, workspace = null, timeoutMs = 60000 } = {}) {
    let snap;
    try {
      snap = appSnapshot({ sessions: false });
    } catch (error) {
      return { ok: false, code: error.message };
    }
    const tabLabel = label ?? name ?? path.basename(worktreePath);
    const space = workspace ?? workspaceNamed(snap, repoName(worktreePath));
    const at = args.indexOf("--resume");
    const resumed = at >= 0 ? args[at + 1] ?? null : null;
    const sessionId = resumed ?? (args.includes("--continue") ? null : crypto.randomUUID());
    const argv = ["claude", ...(name ? ["--name", name] : []), ...(sessionId && !resumed ? ["--session-id", sessionId] : []), ...args];
    const made = unfocused(() =>
      space
        ? run("tab.new", { name: tabLabel, space, folder: worktreePath, argv })
        : run("space.new", { name: repoName(worktreePath), folder: worktreePath, tab: tabLabel, argv }),
    );
    const handle = made.ok ? made.result?.terminal : null;
    if (!handle) return { ok: false, code: made.error?.code ?? "沒有 terminal" };
    if (sessionId) rememberSession(handle, sessionId, realpath(worktreePath));
    const ready = this.waitReady(handle, timeoutMs);
    return { ok: true, handle, ready: ready.ok, code: ready.ok ? null : ready.code };
  },
  moveTarget(handle, worktreePath, to = null) {
    let snap;
    try {
      snap = appSnapshot({ sessions: false });
    } catch (error) {
      return { ok: false, code: error.message };
    }
    const name = to ?? repoName(worktreePath);
    const workspace = workspaceNamed(snap, name);
    if (to && !workspace) return { ok: false, code: "no-workspace", name };
    const here = snap.panes.find((p) => p.pane_id === handle)?.workspace_id ?? null;
    return { ok: true, name, workspace, already: !!workspace && workspace === here };
  },
  sessionOf(handle) {
    return sessionIdOf(handle);
  },
  // Ready once Claude Code reports idle; before it reports (a trust dialog), it isn't.
  waitReady(handle, ms = 60000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const res = runHc(["get", handle]);
      if (res.ok && res.result.state === "finished") return { ok: false, code: "exited" };
      const state = res.ok ? res.result.status?.state : null;
      if (state === "idle" || state === "done") return { ok: true };
      if (Date.now() >= deadline) return { ok: false, code: res.ok ? "timeout" : res.error?.code ?? "unknown" };
      sleepSync(pollMs());
    }
  },
  closeWorktree(worktreePath) {
    let snap;
    try {
      snap = appSnapshot({ sessions: false });
    } catch (error) {
      return { ok: false, code: error.message };
    }
    const self = this.selfHandle();
    const root = realpath(worktreePath);
    return closePanes(snap, snap.panes.filter((p) => p.pane_id !== self && inside(realpath(p.cwd || "/"), root)));
  },
  closeTab(handle) {
    let snap;
    try {
      snap = appSnapshot({ sessions: false });
    } catch (error) {
      return { ok: false, code: error.message };
    }
    const pane = snap.panes.find((p) => p.pane_id === handle);
    return pane ? closePanes(snap, [pane]) : { ok: false, code: "terminal_not_found" };
  },
  renameTab(handle, label) {
    let snap;
    try {
      snap = appSnapshot({ sessions: false });
    } catch (error) {
      return { ok: false, code: error.message };
    }
    const tab = snap.panes.find((p) => p.pane_id === handle)?.tab_id;
    return tab ? ok(run("tab.rename", { id: tab, name: label })) : { ok: false, code: "terminal_not_found" };
  },
  nameTabs(rows, terminals, self) {
    const done = [];
    for (const { tab, label } of tabRenames(rows, terminals, self)) if (run("tab.rename", { id: tab, name: label }).ok) done.push({ tab, label });
    return done;
  },
  linearIssue(id) {
    if (!titles.has(id)) {
      const res = linear(["issue", id]);
      titles.set(id, res.ok ? res.issue : null);
    }
    return titles.get(id);
  },
  linearTodo() {
    const res = linear(["todo"]);
    return res.ok ? { ok: true, issues: res.issues ?? [] } : { ok: false, code: res.error?.code ?? "linear-error" };
  },
  audit(rows) {
    auditRows(rows, { terminal: NAME });
  },
  // Every read refreshes the board mod's state file; the mod itself is put in place once per read too.
  publish(data) {
    try {
      writeJson(BOARD, boardState(data.rows));
      installBoardMod();
    } catch {}
  },
};
