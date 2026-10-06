// herdr as the console's terminal manager: herdr's own state, read back into the shapes Orca's listings have.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentStatus, claudeProjectDir, consoleHome, git, gitWorktrees, goalInTranscript, lastInstruction, realpath, sessionTag, typedPrompt } from "./lib.mjs";
import { transcriptFor } from "./log.mjs";
import { terminalError } from "./terminals.mjs";

const MENU_TOOL = "AskUserQuestion";
const REPOS = "herdr-repos.json";
const WORKTREES = "herdr-worktrees.json";
export const AUDIT = "herdr-audit.jsonl";
const TAIL_BYTES = 2 * 1024 * 1024;
const ENDED = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);
const INTERRUPTED = /^\[Request interrupted by user/;
const PROMPT_UI = /Do you want to |Enter to select|Esc to cancel/;
const PROMPT_UI_LINES = 25;
const LINEAR = path.join(path.dirname(fileURLToPath(import.meta.url)), "linear.mjs");

export function herdrBin() {
  return process.env.HERDR_BIN || "herdr";
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// herdr prints `{result}` on success (nothing at all for pane send-text/send-keys) and `{error}` on stderr with exit 1;
// `raw` keeps stdout as text (pane read).
export function runHerdr(args, { raw = false } = {}) {
  const res = spawnSync(herdrBin(), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { ok: false, error: { code: "unreachable", message: res.error.message } };
  if (res.status === 0) {
    if (raw) return { ok: true, text: res.stdout };
    if (!res.stdout.trim()) return { ok: true, result: {} };
    const out = parse(res.stdout);
    if (out && "result" in out) return { ok: true, result: out.result ?? {} };
  }
  const err = parse(res.stderr) ?? parse(res.stdout);
  return { ok: false, error: err?.error ?? { code: "unreachable", message: (res.stderr || res.stdout || "").trim() } };
}

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

// Repos the console has met: workspaces herdr had open, and repos a ticket was started in.
export function knownRepos() {
  const list = readJson(REPOS, []);
  return Array.isArray(list) ? list : [];
}

export function rememberRepo(main) {
  const list = knownRepos();
  if (!main || list.some((r) => r.main === main)) return;
  try {
    writeJson(REPOS, [...list, { name: path.basename(main), main }]);
  } catch {}
}

export function repoByName(name) {
  const want = String(name ?? "").trim().toLowerCase();
  return knownRepos().find((r) => r.name.toLowerCase() === want)?.main ?? null;
}

// What the console wrote down when it started a ticket: worktree path → { ticket, displayName, interview }.
export function worktreeRecords() {
  const value = readJson(WORKTREES, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function recordWorktree(p, fields) {
  writeJson(WORKTREES, { ...worktreeRecords(), [p]: { ...fields, at: new Date().toISOString() } });
}

export function forgetWorktree(p) {
  const all = worktreeRecords();
  if (!(p in all)) return;
  delete all[p];
  try {
    writeJson(WORKTREES, all);
  } catch {}
}

// herdr's own default for new worktrees, `[worktrees] directory` in its config.
export function worktreeHome() {
  const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr", "config.toml");
  let dir = "~/.herdr/worktrees";
  try {
    const section = fs.readFileSync(file, "utf8").split(/^\[/m).find((s) => s.startsWith("worktrees]"));
    dir = section?.match(/^\s*directory\s*=\s*"([^"]+)"/m)?.[1] ?? dir;
  } catch {}
  return dir.replace(/^~(?=$|\/)/, os.homedir());
}

const inside = (p, root) => p === root || p.startsWith(`${root}${path.sep}`);
const paneCwd = (p) => realpath(p.foreground_cwd || p.cwd || "/");
const worktreeOf = (cwd, paths) => paths.filter((w) => inside(cwd, w)).sort((a, b) => b.length - a.length)[0] ?? null;
// Pane ids count up past p9 as pA, pB…; never reused, so they give the opening order.
const paneOrder = (id) => {
  const n = parseInt(String(id).split(":p")[1] ?? "", 36);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
};

const mains = new Map();

function repoMain(cwd) {
  if (!mains.has(cwd)) {
    const res = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    mains.set(cwd, res.ok ? realpath(path.dirname(res.out)) : null);
  }
  return mains.get(cwd);
}

function herdrSnapshot() {
  const res = runHerdr(["api", "snapshot"]);
  if (!res.ok || !res.result?.snapshot) throw terminalError("herdr", res.error ?? { code: "unreachable" });
  return res.result.snapshot;
}

function findTranscript(sessionId) {
  const base = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
  try {
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

// The session herdr reports in the pane first, then the one the console-log hook registered for it.
function transcriptFile(agent) {
  const id = agent.agent_session?.kind === "id" ? agent.agent_session.value : null;
  if (id) {
    const direct = path.join(claudeProjectDir(agent.cwd || paneCwd(agent)), `${id}.jsonl`);
    if (fs.existsSync(direct)) return direct;
    const found = findTranscript(id);
    if (found) return found;
  }
  const logged = transcriptFor(agent.pane_id);
  return logged && fs.existsSync(logged) ? logged : null;
}

// Last 2 MB of a transcript; null when nothing in it parses.
export function readTranscript(file) {
  let text;
  let truncated = false;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) {
        truncated = true;
        text = text.slice(text.indexOf("\n") + 1);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries.length > 0 ? { entries, truncated } : null;
}

function promptText(entry) {
  const content = entry.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n") : "";
  return text.trim();
}

function isPrompt(entry) {
  const text = promptText(entry);
  return !entry.isMeta && !!text && !INTERRUPTED.test(text) && !/^<(task-notification|local-command-)/.test(text);
}

// Where the main conversation stands: fresh (no instruction yet), running, tool (a call without its result), replied.
export function transcriptState(entries, { truncated = false } = {}) {
  const open = new Map();
  let last = null;
  let prompted = truncated;
  let text = "";
  let at = null;
  for (const e of entries) {
    if (e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
    const parts = Array.isArray(e.message?.content) ? e.message.content : [];
    if (e.type === "user") {
      for (const p of parts) if (p.type === "tool_result") open.delete(p.tool_use_id);
      if (isPrompt(e)) {
        prompted = true;
        text = "";
      }
    } else {
      for (const p of parts) if (p.type === "tool_use") open.set(p.id, p);
      const said = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim();
      if (said) text = said;
    }
    last = e;
    const t = Date.parse(e.timestamp ?? "");
    if (!Number.isNaN(t)) at = t;
  }
  const pending = [...open.values()].at(-1) ?? null;
  const ended = last?.type === "assistant" ? ENDED.has(last.message?.stop_reason) : !!last && INTERRUPTED.test(promptText(last));
  const phase = pending ? "tool" : !prompted ? "fresh" : ended ? "replied" : "running";
  return { phase, pending: pending ? { name: pending.name, input: pending.input } : null, text, at, prompt: typedPrompt(lastInstruction(entries) ?? "") };
}

export function promptOnScreen(lines) {
  return (lines ?? []).slice(-PROMPT_UI_LINES).some((l) => PROMPT_UI.test(l));
}

// A permission request shows its command or file, not the whole input object.
function toolInput(name, input) {
  if (name === MENU_TOOL || !input || typeof input !== "object") return input ?? "";
  return input.command ?? input.file_path ?? input.url ?? input.pattern ?? input;
}

// What the transcript and screen alone say, without herdr's state: the third opinion of the audit.
function inferredKind(t, file, onScreen) {
  if (!t) return "unknown";
  if (t.phase === "fresh") return "idle";
  if (t.phase === "running") return "busy";
  if (t.phase === "tool") return promptOnScreen(onScreen()) ? (t.pending.name === MENU_TOOL ? "waiting" : "permission") : "busy";
  if (goalInTranscript(file) === true) return "busy";
  return agentStatus({ state: "done", lastAssistantMessage: t.text }).kind;
}

// herdr's idle/working/blocked/done/unknown turned into Orca's agent shape: blocked is told apart by the pending tool
// in the transcript, unknown is filled in from it, and neither readable makes the session an anomaly.
export function herdrAgent(a, readScreen = screenLines) {
  const raw = a.agent_status ?? "unknown";
  const file = transcriptFile(a);
  const read = file ? readTranscript(file) : null;
  const t = read ? transcriptState(read.entries, { truncated: read.truncated }) : null;
  let lines;
  const onScreen = () => (lines ??= readScreen(a.pane_id) ?? []);
  let state;
  if (raw === "working") state = "working";
  else if (raw === "blocked") state = t?.phase === "tool" ? "blocked" : "anomaly";
  else if (raw === "done" || raw === "idle") state = !t ? raw : t.phase === "fresh" ? "idle" : "done";
  else if (!t) state = "anomaly";
  else if (t.phase === "tool") state = promptOnScreen(onScreen()) ? "blocked" : "working";
  else state = t.phase === "replied" ? "done" : t.phase === "fresh" ? "idle" : "working";
  const blocked = state === "blocked";
  return {
    paneKey: a.pane_id,
    state,
    prompt: t?.prompt ?? "",
    lastAssistantMessage: t?.text ?? "",
    stateStartedAt: t?.at ?? null,
    toolName: blocked ? t.pending.name : null,
    toolInput: blocked ? toolInput(t.pending.name, t.pending.input) : null,
    transcript: t ? file : null,
    ...(state === "anomaly" ? { screen: onScreen() } : {}),
    herdr: { raw, inferred: inferredKind(t, file, onScreen), transcript: !!t, name: a.name ?? null },
  };
}

export function screenLines(handle) {
  const res = runHerdr(["pane", "read", handle, "--source", "visible"], { raw: true });
  return res.ok ? res.text.replace(/\n+$/, "").split("\n").map((l) => l.trimEnd()) : null;
}

// What sits in Claude Code's input box, between the last two rules.
function draftOf(lines) {
  const rules = lines.flatMap((l, i) => (/^─{20,}/.test(l) ? [i] : []));
  if (rules.length < 2) return "";
  const [a, b] = rules.slice(-2);
  return lines.slice(a + 1, b).map((l, i) => (i === 0 ? l.replace(/^❯\s?/, "") : l.trim())).join("\n").trim();
}

function panesIn(snap, worktreePath) {
  return (snap.panes ?? []).filter((p) => inside(paneCwd(p), worktreePath));
}

const repoName = (worktreePath) => path.basename(repoMain(worktreePath) ?? worktreePath);
const workspaceOrder = (id) => {
  const n = parseInt(String(id).replace(/^w/, ""), 36);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
};

// Only the name counts: a pane's folder follows every cd, a workspace's label doesn't.
export function workspaceNamed(snap, name) {
  const ids = (snap.workspaces ?? []).filter((w) => w.label === name).map((w) => w.workspace_id);
  return ids.sort((a, b) => workspaceOrder(a) - workspaceOrder(b))[0] ?? null;
}

const agentName = (pane) => `c-${pane.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 32);
const ok = (res) => (res.ok ? { ok: true } : { ok: false, code: res.error?.code ?? "unknown" });

function linear(args) {
  const res = spawnSync(process.execPath, [LINEAR, ...args, "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return parse(res.stdout) ?? { ok: false, error: { code: "linear-error" } };
}

const titles = new Map();

export const herdrTerminals = {
  name: "herdr",
  selfHandle: () => process.env.HERDR_PANE_ID || null,
  snapshot({ agents = true } = {}) {
    const snap = herdrSnapshot();
    const panes = snap.panes ?? [];
    for (const main of new Set(panes.map((p) => repoMain(paneCwd(p))).filter(Boolean))) rememberRepo(main);
    const repos = knownRepos().filter((r) => fs.existsSync(r.main));
    const records = worktreeRecords();
    const worktrees = repos.flatMap((r) =>
      gitWorktrees(r.main).map((w) => {
        const rec = records[w.path] ?? {};
        return {
          path: w.path,
          branch: w.branch,
          isMainWorktree: w.isMain,
          repoId: r.main,
          linkedLinearIssue: rec.ticket ?? null,
          displayName: rec.displayName ?? w.branch,
          comment: rec.interview || rec.defineGoal ? "interview" : "",
          baseRef: rec.baseRef ?? null,
        };
      }),
    );
    const paths = worktrees.map((w) => w.path);
    const kinds = new Map((snap.agents ?? []).map((a) => [a.pane_id, a.agent]));
    const terminals = panes.map((p) => {
      const ws = String(p.pane_id).split(":")[0];
      return {
        handle: p.pane_id,
        tabId: ws,
        leafId: String(p.pane_id).slice(ws.length + 1),
        worktreePath: worktreeOf(paneCwd(p), paths),
        agentIdentity: kinds.get(p.pane_id) ?? p.agent ?? null,
        createdAt: paneOrder(p.pane_id),
        tab: p.tab_id,
        workspace: p.workspace_id,
      };
    });
    const claude = agents ? (snap.agents ?? []).filter((a) => a.agent === "claude") : [];
    const where = new Map(claude.map((a) => [a.pane_id, worktreeOf(paneCwd(a), paths)]));
    const ps = worktrees.map((w) => ({ ...w, agents: claude.filter((a) => where.get(a.pane_id) === w.path).map((a) => herdrAgent(a)) }));
    return { repos: repos.map((r) => ({ id: r.main, displayName: r.name, path: r.main })), worktrees, ps, terminals };
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
      const a = (herdrSnapshot().agents ?? []).find((x) => x.pane_id === paneKey && x.agent === "claude");
      return a ? herdrAgent(a) : null;
    } catch {
      return null;
    }
  },
  agentOf(handle) {
    return this.agentAt(handle);
  },
  // The newest instruction as the transcript stored it: a long paste arrives wrapped in <pasted_content>.
  lastPrompt(handle) {
    let a;
    try {
      a = (herdrSnapshot().agents ?? []).find((x) => x.pane_id === handle);
    } catch {
      return null;
    }
    const file = a ? transcriptFile(a) : null;
    const read = file ? readTranscript(file) : null;
    const last = (read?.entries ?? []).filter((e) => e.type === "user" && !e.isSidechain && isPrompt(e)).at(-1);
    return last ? promptText(last) : null;
  },
  readScreen(handle) {
    const res = runHerdr(["pane", "read", handle, "--source", "visible"], { raw: true });
    if (!res.ok) return { ok: false, code: res.error?.code ?? "unknown" };
    const tail = res.text.replace(/\n+$/, "").split("\n").map((l) => l.trimEnd());
    return { ok: true, terminal: { tail, draft: draftOf(tail) } };
  },
  // With Enter it goes through `agent prompt`, which refuses a session waiting at a permission or menu.
  send(handle, text, { enter = false } = {}) {
    return ok(enter ? runHerdr(["agent", "prompt", handle, text]) : runHerdr(["pane", "send-text", handle, text]));
  },
  type(handle, text) {
    return ok(runHerdr(["pane", "send-text", handle, text]));
  },
  key(handle, key) {
    return ok(runHerdr(["pane", "send-keys", handle, key]));
  },
  create(worktreePath, { args = [], label = null, workspace = null, timeoutMs = 60000 } = {}) {
    let snap;
    try {
      snap = herdrSnapshot();
    } catch (error) {
      return { ok: false, code: error.message };
    }
    const ws = workspace ?? workspaceNamed(snap, repoName(worktreePath));
    const opened = ws
      ? runHerdr(["tab", "create", "--workspace", ws, "--cwd", worktreePath, ...(label ? ["--label", label] : []), "--no-focus"])
      : runHerdr(["workspace", "create", "--cwd", worktreePath, "--label", repoName(worktreePath), "--no-focus"]);
    const pane = opened.ok ? opened.result?.root_pane?.pane_id : null;
    if (!pane) return { ok: false, code: opened.error?.code ?? "沒有 pane" };
    const started = runHerdr(["agent", "start", agentName(pane), "--kind", "claude", "--pane", pane, "--timeout", String(timeoutMs), ...(args.length ? ["--", ...args] : [])]);
    return { ok: true, handle: pane, ready: started.ok, code: started.ok ? null : started.error?.code ?? "unknown" };
  },
  // A named workspace must already exist; without a name the repo's own one, null when it still has to be opened.
  moveTarget(handle, worktreePath, to = null) {
    let snap;
    try {
      snap = herdrSnapshot();
    } catch (error) {
      return { ok: false, code: error.message };
    }
    const name = to ?? repoName(worktreePath);
    const workspace = workspaceNamed(snap, name);
    if (to && !workspace) return { ok: false, code: "no-workspace", name };
    const here = (snap.panes ?? []).find((p) => p.pane_id === handle)?.workspace_id ?? null;
    return { ok: true, name, workspace, already: !!workspace && workspace === here };
  },
  sessionOf(handle) {
    try {
      const a = (herdrSnapshot().agents ?? []).find((x) => x.pane_id === handle);
      return a?.agent_session?.kind === "id" ? a.agent_session.value : null;
    } catch {
      return null;
    }
  },
  waitReady(handle, ms = 60000) {
    return ok(runHerdr(["agent", "wait", handle, "--until", "idle", "--until", "done", "--timeout", String(ms)]));
  },
  closeWorktree(worktreePath) {
    let snap;
    try {
      snap = herdrSnapshot();
    } catch (error) {
      return { ok: false, code: error.message };
    }
    const self = this.selfHandle();
    for (const p of panesIn(snap, worktreePath).filter((p) => p.pane_id !== self)) {
      const res = runHerdr(["pane", "close", p.pane_id]);
      if (!res.ok) return { ok: false, code: res.error?.code ?? "unknown" };
    }
    return { ok: true };
  },
  closeTab(handle) {
    return ok(runHerdr(["pane", "close", handle]));
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
  // One line per session read: herdr's state, what the console shows, and what the transcript and screen say.
  audit(rows) {
    const ts = new Date().toISOString();
    const lines = [];
    for (const row of rows) {
      for (const s of row.sessions) {
        const h = s.agent?.herdr;
        if (!h) continue;
        const shown = s.status.kind;
        lines.push(
          JSON.stringify({ ts, event: "read", repo: row.repo, ticket: sessionTag(row, s), handle: s.handle ?? s.paneKey, herdr: h.raw, shown, inferred: h.inferred, transcript: h.transcript, mismatch: mismatch(h.raw, shown, h.inferred) }),
        );
      }
    }
    if (lines.length === 0) return;
    try {
      fs.mkdirSync(consoleHome(), { recursive: true });
      fs.appendFileSync(path.join(consoleHome(), AUDIT), `${lines.join("\n")}\n`);
    } catch {}
  },
};

const RAW_SHOWN = { working: ["busy"], blocked: ["waiting", "permission"], done: ["done", "waiting"], idle: ["idle", "done", "waiting"], unknown: [] };

export function mismatch(raw, shown, inferred) {
  return shown !== inferred || !(RAW_SHOWN[raw] ?? []).includes(shown);
}

export function recordMisjudge(fields) {
  fs.mkdirSync(consoleHome(), { recursive: true });
  fs.appendFileSync(path.join(consoleHome(), AUDIT), `${JSON.stringify({ ts: new Date().toISOString(), event: "misjudge", ...fields })}\n`);
}

export function readAudit(since = 0) {
  let text;
  try {
    text = fs.readFileSync(path.join(consoleHome(), AUDIT), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (Date.parse(e.ts) >= since) out.push(e);
    } catch {}
  }
  return out;
}
