import fs from "node:fs";
import { git, ownRecord, readDisposable, readTasks, realpath, writeDisposable, writeTasks } from "./lib.mjs";
import { terminalKind } from "./terminals.mjs";

// A tab that has not shown up this long after the worktree was opened counts as closed.
export const UNSEEN_MS = 5 * 60 * 1000;
const TASK_PRUNE_MS = 24 * 60 * 60 * 1000;

// Commits made in a temporary worktree since it was opened.
export function commitsSince(rec) {
  if (!rec.start) return 0;
  const res = git(rec.path, ["rev-list", "--count", `${rec.start}..HEAD`]);
  return res.ok ? Number(res.out) || 0 : 0;
}

// Why a temporary worktree must stay: uncommitted changes or commits of its own; null when it can go.
export function keepReason(rec) {
  if (git(rec.path, ["status", "--porcelain"]).out !== "") return "有未 commit 的改動";
  const n = commitsSince(rec);
  return n > 0 ? `有 ${n} 個 commit` : null;
}

// The fallback branch goes with the worktree, only when it holds nothing beyond where it was opened.
export function dropBranch(rec, commits = commitsSince(rec)) {
  if (!rec.branch || commits > 0) return false;
  return git(rec.main, ["branch", "-D", rec.branch]).ok;
}

export function removeTemp(rec) {
  const commits = commitsSince(rec);
  const removed = git(rec.main, ["worktree", "remove", rec.path]);
  if (!removed.ok) return { ok: false, reason: `移除 worktree 失敗：${removed.err}` };
  return { ok: true, branchKept: rec.branch && !dropBranch(rec, commits) ? rec.branch : null, commits };
}

/**
 * One watcher pass over the throwaway records: a temporary worktree whose last tab was closed is removed when clean,
 * otherwise reported once as `[<代號>] 未移除：…`; a closed throwaway tab just drops its record. Records of the other
 * terminal manager are left alone: its tabs are not in `terminals`.
 */
export function sweepDisposable(terminals, now = Date.now(), { remove = removeTemp, reasonOf = keepReason, source = terminalKind() ?? "orca" } = {}) {
  const list = readDisposable();
  const open = new Set(terminals.map((t) => (t.worktreePath ? realpath(t.worktreePath) : null)).filter(Boolean));
  const panes = new Set(terminals.map((t) => `${t.tabId}:${t.leafId}`));
  const keep = [];
  const lines = [];
  for (const rec of list) {
    if (!ownRecord(rec, source)) {
      keep.push(rec);
      continue;
    }
    if (rec.kind === "tab") {
      if (panes.has(rec.paneKey)) keep.push(rec);
      continue;
    }
    if (!fs.existsSync(rec.path)) continue;
    if (open.has(rec.path)) {
      keep.push({ ...rec, seen: true, warned: null });
      continue;
    }
    if (!rec.seen && now - (rec.at ?? 0) < UNSEEN_MS) {
      keep.push(rec);
      continue;
    }
    const why = reasonOf(rec);
    const gone = why ? null : remove(rec);
    const reason = why ?? (gone.ok ? null : gone.reason);
    if (!reason) continue;
    if (rec.warned !== reason) lines.push(`[${rec.nickname}] 未移除：${reason}`);
    keep.push({ ...rec, warned: reason });
  }
  if (JSON.stringify(keep) !== JSON.stringify(list)) writeDisposable(keep);
  const tasks = readTasks();
  const live = Object.fromEntries(Object.entries(tasks).filter(([k, v]) => !ownRecord(v, source) || panes.has(k) || now - (v.at ?? 0) < TASK_PRUNE_MS));
  if (Object.keys(live).length !== Object.keys(tasks).length) writeTasks(live);
  return lines;
}
