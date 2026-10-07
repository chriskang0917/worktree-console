import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "skills", "worktree-console", "scripts", "console.mjs");
let tmp;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-prune-")));
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sh = (cwd, ...args) => {
  const res = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
};

const branches = (main) => sh(main, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");

// A main checkout on main with a bare origin, main pushed.
function repo(name) {
  const base = fs.mkdtempSync(path.join(tmp, `${name}-`));
  const remote = path.join(base, "remote.git");
  const main = path.join(base, "main");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  spawnSync("git", ["init", "-q", "-b", "main", main]);
  sh(main, "commit", "-q", "--allow-empty", "-m", "init");
  sh(main, "remote", "add", "origin", remote);
  sh(main, "push", "-q", "origin", "main");
  return { base, main };
}

// A branch with one commit of its own, left unmerged; the main checkout stays on main.
function topic(main, name) {
  sh(main, "checkout", "-q", "-b", name);
  fs.writeFileSync(path.join(main, `${name.replace(/\//g, "-")}.txt`), name);
  sh(main, "add", "-A");
  sh(main, "commit", "-q", "-m", name);
  sh(main, "checkout", "-q", "main");
}

const merged = (main, name) => {
  topic(main, name);
  sh(main, "merge", "-q", "--no-ff", name, "-m", `merge ${name}`);
};

const squashed = (main, name) => {
  topic(main, name);
  sh(main, "merge", "-q", "--squash", name);
  sh(main, "commit", "-q", "-m", `squash ${name}`);
};

function run(main, args = [], { cwd = main, env = {} } = {}) {
  return spawnSync(process.execPath, [script, "prune", "--repo", main, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, WORKTREE_CONSOLE_HOME: path.join(tmp, "home"), WORKTREE_CONSOLE_LOG_DIR: path.join(tmp, "log"), ...env },
  });
}

// The listing line for one branch.
const line = (res, branch) => res.stdout.split("\n").find((l) => l.split(/\s+/)[1]?.replace(/（.*/, "") === branch) ?? "";
const verdict = (res, branch) => line(res, branch).split(/\s+/)[0];

test("prune：已用 merge commit 合進 main 的 branch 是 CANDIDATE，理由寫 ancestor", () => {
  const { main } = repo("merged");
  merged(main, "feat/a");
  const res = run(main);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(verdict(res, "feat/a"), "CANDIDATE");
  assert.match(line(res, "feat/a"), /已合進 main（branch 是它的祖先）/);
});

test("prune：squash 合併過的 branch 是 CANDIDATE，理由寫 squash 並說明要用 -D", () => {
  const { main } = repo("squash");
  squashed(main, "feat/s");
  const res = run(main);
  assert.equal(verdict(res, "feat/s"), "CANDIDATE");
  assert.match(line(res, "feat/s"), /squash 合併進 main.*-D/);
});

test("prune：還沒合併的 branch 是 KEEP", () => {
  const { main } = repo("unmerged");
  topic(main, "feat/u");
  const res = run(main);
  assert.equal(verdict(res, "feat/u"), "KEEP");
  assert.match(line(res, "feat/u"), /還沒合進 main/);
});

test("prune：已合併但 worktree 有未 commit 的改動是 KEEP", () => {
  const { base, main } = repo("dirty");
  merged(main, "feat/d");
  const wt = path.join(base, "wt-d");
  sh(main, "worktree", "add", "-q", wt, "feat/d");
  fs.writeFileSync(path.join(wt, "scratch.txt"), "x");
  const res = run(main);
  assert.equal(verdict(res, "feat/d"), "KEEP");
  assert.match(line(res, "feat/d"), /工作區有未 commit 的改動/);
  assert.match(line(res, "feat/d"), new RegExp(wt));
});

test("prune：預設分支、主 checkout 目前所在的 branch、你現在所在的 worktree 都是 KEEP，即使已合併", () => {
  const { base, main } = repo("current");
  merged(main, "feat/here");
  merged(main, "feat/main-head");
  merged(main, "feat/other");
  const wt = path.join(base, "wt-here");
  sh(main, "worktree", "add", "-q", wt, "feat/here");
  sh(main, "checkout", "-q", "feat/main-head");
  const res = run(main, [], { cwd: wt });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(verdict(res, "main"), "KEEP");
  assert.match(line(res, "main"), /預設分支/);
  assert.match(line(res, "feat/main-head"), /KEEP.*主 checkout 目前所在的 branch/);
  assert.match(line(res, "feat/here"), /KEEP.*你現在所在的 worktree/);
  assert.equal(verdict(res, "feat/other"), "CANDIDATE");
});

test("prune：剛開、和 main 指向同一個 commit 的 branch 是 KEEP，不當成已合併", () => {
  const { main } = repo("fresh");
  sh(main, "branch", "feat/fresh");
  const res = run(main);
  assert.equal(verdict(res, "feat/fresh"), "KEEP");
  assert.match(line(res, "feat/fresh"), /沒有自己的 commit/);
});

test("prune：有 session 開著的 worktree 是 KEEP", () => {
  const { base, main } = repo("session");
  merged(main, "feat/live");
  const wt = path.join(base, "wt-live");
  sh(main, "worktree", "add", "-q", wt, "feat/live");
  const orca = path.join(base, "orca");
  fs.writeFileSync(
    orca,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
const state = JSON.parse(process.env.FAKE_ORCA_STATE);
console.log(JSON.stringify({ ok: true, result: { worktrees: args.startsWith("worktree ps") ? state.ps : [] } }));
`,
  );
  fs.chmodSync(orca, 0o755);
  const env = { ORCA_BIN: orca, ORCA_TERMINAL_HANDLE: "term_none", FAKE_ORCA_STATE: JSON.stringify({ ps: [{ path: wt, agents: [{ paneKey: "t:1", state: "idle" }] }] }) };
  let res = run(main, [], { env });
  assert.equal(verdict(res, "feat/live"), "KEEP");
  assert.match(line(res, "feat/live"), /有 session 開著/);
  env.FAKE_ORCA_STATE = JSON.stringify({ ps: [{ path: wt, agents: [] }] });
  res = run(main, [], { env });
  assert.equal(verdict(res, "feat/live"), "CANDIDATE");
});

test("prune：預設是 dry run，什麼都不刪", () => {
  const { base, main } = repo("dry");
  merged(main, "feat/a");
  squashed(main, "feat/s");
  merged(main, "feat/w");
  const wt = path.join(base, "wt-w");
  sh(main, "worktree", "add", "-q", wt, "feat/w");
  const before = branches(main);
  const res = run(main);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /預覽：3 個可清理.*沒有刪任何東西/);
  assert.deepEqual(branches(main), before);
  assert.equal(fs.existsSync(wt), true);
});

test("prune --apply：只清 CANDIDATE（worktree 不加 --force 移除、squash 用 -D），KEEP 與遠端 branch 原封不動", () => {
  const { base, main } = repo("apply");
  merged(main, "feat/a");
  squashed(main, "feat/s");
  merged(main, "feat/w");
  topic(main, "feat/u");
  merged(main, "feat/d");
  const wt = path.join(base, "wt-w");
  const dirty = path.join(base, "wt-d");
  sh(main, "worktree", "add", "-q", wt, "feat/w");
  sh(main, "worktree", "add", "-q", dirty, "feat/d");
  fs.writeFileSync(path.join(dirty, "scratch.txt"), "x");
  sh(main, "push", "-q", "origin", "feat/a", "feat/u");
  const remoteBefore = sh(main, "ls-remote", "--heads", "origin");
  const res = run(main, ["--apply"]);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(branches(main).sort(), ["feat/d", "feat/u", "main"]);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(fs.existsSync(dirty), true);
  assert.match(res.stdout, /\[feat\/a\] 已清理：branch 已刪\n/);
  assert.match(res.stdout, /\[feat\/s\] 已清理：branch 已刪（squash 合併，改用 -D；刪前已重新確認內容在 main 裡）/);
  assert.match(res.stdout, /\[feat\/w\] 已清理：worktree 已移除，branch 已刪/);
  assert.equal(sh(main, "ls-remote", "--heads", "origin"), remoteBefore);
});

test("prune --apply：squash 的 branch 在刪除前再確認一次證明，之後又有新 commit 就保留", () => {
  const { base, main } = repo("recheck");
  squashed(main, "feat/s");
  const wt = path.join(base, "wt-s");
  sh(main, "worktree", "add", "-q", wt, "feat/s");
  // A commit that main does not have, built without touching the worktree.
  const tip = sh(main, "rev-parse", "feat/s");
  const index = path.join(base, "late-index");
  const withIndex = { GIT_INDEX_FILE: index };
  const git = (...args) => {
    const res = spawnSync("git", ["-C", main, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", env: { ...process.env, ...withIndex } });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  git("read-tree", tip);
  const blob = spawnSync("git", ["-C", main, "hash-object", "-w", "--stdin"], { encoding: "utf8", input: "late" }).stdout.trim();
  git("update-index", "--add", "--cacheinfo", `100644,${blob},late.txt`);
  const late = git("commit-tree", git("write-tree"), "-p", tip, "-m", "late");
  // A git shim that moves the branch right after `worktree remove`, i.e. between the listing and the delete.
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh
"${real}" "$@"
rc=$?
case " $* " in
  *" worktree remove "*) "${real}" -C "${main}" update-ref refs/heads/feat/s ${late} ;;
esac
exit $rc
`,
  );
  fs.chmodSync(path.join(bin, "git"), 0o755);
  const res = run(main, ["--apply"], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /\[feat\/s\] branch 保留：刪除前重新確認，內容已不在 main 裡/);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(sh(main, "rev-parse", "feat/s"), late);
});
