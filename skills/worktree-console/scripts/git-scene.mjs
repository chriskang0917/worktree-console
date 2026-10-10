import { spawnSync } from "node:child_process";
import fs from "node:fs";

const PLAN_DIR = ":(top,exclude)docs/dev-flow";

function git(cwd, args) {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: res.status === 0, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
}

function defaultBase(dir) {
  const head = git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const name = head.ok ? head.out.replace(/^origin\//, "") : null;
  return [...new Set([name, "main", "master"].filter(Boolean))];
}

function bases(dir, baseRef) {
  const names = [];
  const add = (n) => n && !names.includes(n) && git(dir, ["rev-parse", "--verify", "--quiet", `${n}^{commit}`]).ok && names.push(n);
  const want = baseRef ? [baseRef.replace(/^origin\//, "")] : [];
  for (const n of [...want, ...defaultBase(dir)]) {
    add(n);
    add(`origin/${n}`);
  }
  return names;
}

// Merging `head` into `base` would change nothing: a squash or plain merge already brought it in.
export function alreadyIn(dir, base, head) {
  const merged = git(dir, ["merge-tree", "--write-tree", base, head]);
  if (!merged.ok) return false;
  return merged.out.split("\n")[0] === git(dir, ["rev-parse", `${base}^{tree}`]).out;
}

function mergedAsParent(dir, base, head) {
  return git(dir, ["rev-list", "--merges", "--parents", "-n", "200", base]).out.split("\n").some((l) => l.split(" ").slice(2).includes(head));
}

// A (uncommitted changes), B (commits not in base yet), C (all of it in base), or null.
export function gitScene(dir, baseRef = null) {
  if (!dir || !fs.existsSync(dir)) return null;
  if (!git(dir, ["rev-parse", "--git-dir"]).ok) return null;
  if (git(dir, ["status", "--porcelain", "--untracked-files=all", "--", ":(top)", PLAN_DIR]).out) return "A";
  const list = bases(dir, baseRef);
  if (list.length === 0) return null;
  const head = git(dir, ["rev-parse", "HEAD"]).out;
  return sceneOfCommits(dir, list, head);
}

function sceneOfCommits(dir, list, head) {
  if (!head) return null;
  const ahead = Number(git(dir, ["rev-list", "--count", `${list[0]}..${head}`, "--", ":(top)", PLAN_DIR]).out || 0);
  if (ahead > 0) return list.some((b) => alreadyIn(dir, b, head)) ? "C" : "B";
  return list.some((b) => mergedAsParent(dir, b, head)) ? "C" : null;
}
