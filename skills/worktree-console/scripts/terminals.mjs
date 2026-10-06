// The terminal manager the console runs in: Orca or herdr, picked from the environment, never from a setting.
import { spawnSync } from "node:child_process";
import { herdrTerminals } from "./herdr.mjs";

export const UNSUPPORTED = "worktree-console 只支援 Orca 與 herdr：請在 Orca 或 herdr 的分頁裡執行（環境裡沒有 HERDR_ENV=1，也沒有 ORCA_TERMINAL_HANDLE）";

export function terminalKind(env = process.env) {
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.ORCA_TERMINAL_HANDLE) return "orca";
  return null;
}

export function terminals(env = process.env) {
  const kind = terminalKind(env);
  if (!kind) {
    const e = new Error(UNSUPPORTED);
    e.unsupported = true;
    throw e;
  }
  return kind === "herdr" ? herdrTerminals : orcaTerminals;
}

// The manager when there is one; helpers that only read a screen treat no manager as unreadable.
export function maybeTerminals() {
  try {
    return terminals();
  } catch {
    return null;
  }
}

export function terminalError(name, error) {
  const e = new Error(`${name}-unreachable: ${error?.code ?? "unknown"}`);
  e.terminal = name;
  return e;
}

export function orcaBin() {
  return process.env.ORCA_BIN || "orca";
}

export function runOrca(args) {
  const res = spawnSync(orcaBin(), [...args, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { ok: false, error: { code: "unreachable", message: res.error.message } };
  try {
    const parsed = JSON.parse(res.stdout);
    if (parsed.ok === false) return { ok: false, error: parsed.error ?? { code: "unknown" } };
    return { ok: true, result: parsed.result };
  } catch {
    return { ok: false, error: { code: "unreachable", message: (res.stderr || res.stdout || "").trim() } };
  }
}

const ESC = "\u001b";
const sent = (res) => (res.ok && res.result?.send?.accepted !== false ? { ok: true } : { ok: false, code: res.error?.code ?? "not-accepted" });
const KEYS = { esc: ESC, enter: "\r" };

const orcaTerminals = {
  name: "orca",
  selfHandle: () => process.env.ORCA_TERMINAL_HANDLE || null,
  // Orca's own listings, in the shapes collect() reads; throws when any of them fails.
  snapshot() {
    const [repoRes, list, ps, term] = [["repo", "list"], ["worktree", "list"], ["worktree", "ps"], ["terminal", "list"]].map(runOrca);
    for (const res of [repoRes, list, ps, term]) if (!res.ok) throw terminalError("orca", res.error);
    return {
      repos: repoRes.result.repos ?? [],
      worktrees: list.result.worktrees ?? [],
      ps: ps.result.worktrees ?? [],
      terminals: term.result.terminals ?? [],
    };
  },
  terminalList() {
    const res = runOrca(["terminal", "list"]);
    return res.ok ? { ok: true, terminals: res.result.terminals ?? [] } : { ok: false, code: res.error?.code };
  },
  ps() {
    const res = runOrca(["worktree", "ps"]);
    return res.ok ? { ok: true, worktrees: res.result.worktrees ?? [] } : { ok: false, code: res.error?.code };
  },
  agentAt(paneKey) {
    const ps = this.ps();
    return ps.ok ? ps.worktrees.flatMap((w) => w.agents ?? []).find((a) => a.paneKey === paneKey) ?? null : null;
  },
  agentOf(handle) {
    const term = this.terminalList();
    const t = term.ok ? term.terminals.find((x) => x.handle === handle) : null;
    return t ? this.agentAt(`${t.tabId}:${t.leafId}`) : null;
  },
  readScreen(handle) {
    const res = runOrca(["terminal", "read", "--terminal", handle, "--screen"]);
    return res.ok ? { ok: true, terminal: res.result?.terminal ?? {} } : { ok: false, code: res.error?.code ?? "unknown" };
  },
  send(handle, text, { enter = false } = {}) {
    return sent(runOrca(["terminal", "send", "--terminal", handle, "--text", text, ...(enter ? ["--enter"] : [])]));
  },
  type(handle, text) {
    return this.send(handle, text);
  },
  key(handle, key) {
    return this.send(handle, KEYS[key] ?? key);
  },
  create(worktreePath, { args = [] } = {}) {
    const res = runOrca(["terminal", "create", "--worktree", `path:${worktreePath}`, "--command", ["claude", ...args].join(" ")]);
    const handle = res.ok ? res.result?.terminal?.handle ?? res.result?.handle : null;
    return handle ? { ok: true, handle } : { ok: false, code: res.error?.code ?? "沒有 handle" };
  },
  waitReady(handle, ms = 60000) {
    const res = runOrca(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", String(ms)]);
    return res.ok && res.result?.satisfied !== false ? { ok: true } : { ok: false, code: res.error?.code ?? "未就緒" };
  },
  closeWorktree(worktreePath) {
    const res = runOrca(["terminal", "close", "--worktree", `path:${worktreePath}`, "--all"]);
    return res.ok ? { ok: true } : { ok: false, code: res.error?.code ?? "unknown" };
  },
  closeTab(handle) {
    const res = runOrca(["terminal", "close", "--terminal", handle, "--tab"]);
    return res.ok ? { ok: true } : { ok: false, code: res.error?.code ?? "unknown" };
  },
  linearIssue(id) {
    const res = runOrca(["linear", "issue", id]);
    if (!res.ok) return null;
    const r = res.result ?? {};
    return { title: r.issue?.title ?? r.title ?? null };
  },
  linearTodo() {
    const res = runOrca(["linear", "list-issues", "--assignee", "me", "--state", "unstarted"]);
    return res.ok ? { ok: true, issues: res.result.issues ?? [] } : { ok: false, code: res.error?.code ?? "linear-error" };
  },
  audit() {},
};
