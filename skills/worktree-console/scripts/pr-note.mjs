// Once a ticket's draft PR or MR is open, its description gets the review sheet and the answers given during implementation, once, inside 請先看.
import { spawnSync } from "node:child_process";
import { readNames } from "./lib.mjs";
import { append, sheetMarkdown, stateOf, tagOf, worktreeOf } from "./review.mjs";

const CHECK_EVERY_MS = 10 * 60_000;
const lastCheck = new Map();
export const NOTE_HEAD = "請先看";

function run(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 20_000, input });
  return r.status === 0 ? r.stdout : null;
}

// The open draft PR (GitHub) or MR (GitLab) of a worktree's branch: its number, body and how to rewrite it; null when there is none.
export function draftOf(wt) {
  const remote = run("git", ["-C", wt.path, "remote", "get-url", "origin"], wt.path) ?? "";
  if (/github\.com/.test(remote)) {
    const out = run("gh", ["pr", "list", "--head", wt.branch, "--state", "open", "--json", "number,body,isDraft"], wt.path);
    const pr = out ? JSON.parse(out)[0] : null;
    if (!pr?.isDraft) return null;
    return { label: `PR #${pr.number}`, body: pr.body ?? "", update: (body) => run("gh", ["pr", "edit", String(pr.number), "--body-file", "-"], wt.path, body) !== null };
  }
  if (/gitlab/.test(remote)) {
    const out = run("glab", ["mr", "list", "--source-branch", wt.branch, "--output", "json"], wt.path);
    const mr = out ? JSON.parse(out)[0] : null;
    if (!mr || !(mr.draft || mr.work_in_progress)) return null;
    return { label: `MR !${mr.iid}`, body: mr.description ?? "", update: (body) => run("glab", ["mr", "update", String(mr.iid), "--description", body], wt.path) !== null };
  }
  return null;
}

// The description with the sheet joined into its 請先看 section (one is added at the end when it has none), so there is a single list to read first.
export function mergeBody(body, lines) {
  const text = String(body ?? "").replace(/\r\n?/g, "\n");
  const rows = text.split("\n");
  const at = rows.findIndex((l) => /^#{1,6}\s.*請先看/.test(l));
  if (at < 0) return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}## ${NOTE_HEAD}\n\n${lines.join("\n").trimEnd()}\n`;
  const level = rows[at].match(/^#+/)[0].length;
  let end = rows.findIndex((l, i) => i > at && new RegExp(`^#{1,${level}}\\s`).test(l));
  if (end < 0) end = rows.length;
  const before = rows.slice(0, end);
  while (before.length && !before.at(-1).trim()) before.pop();
  return [...before, "", ...lines, ...(end < rows.length ? ["", ...rows.slice(end)] : [])].join("\n").trimEnd() + "\n";
}

// The watcher's poll, at most once every ten minutes per worktree: each worktree with review records and no note yet gets one when its draft is open.
export function prNoteStep(rows, { now = Date.now(), find = draftOf } = {}) {
  const out = [];
  for (const row of rows) {
    if (now - (lastCheck.get(row.path) ?? 0) < CHECK_EVERY_MS) continue;
    lastCheck.set(row.path, now);
    let wt;
    let st;
    try {
      wt = worktreeOf(row.path);
      st = wt ? stateOf(wt) : null;
    } catch {
      continue;
    }
    if (!st || st.items.length === 0 || st.lines.some((l) => l.event === "pr-noted")) continue;
    const draft = find(wt);
    if (!draft) continue;
    const md = sheetMarkdown({ tag: tagOf(wt, readNames()), items: st.items });
    if (draft.update(mergeBody(draft.body, md))) {
      append(wt, { event: "pr-noted", pr: draft.label });
      out.push(`[${tagOf(wt, readNames())}] 已把審核單補進 ${draft.label} 的說明`);
    }
  }
  return out;
}

export const resetChecks = () => lastCheck.clear();
