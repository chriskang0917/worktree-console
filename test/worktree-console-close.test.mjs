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
let orca;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-close-")));
  orca = path.join(tmp, "orca");
  fs.writeFileSync(
    orca,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
const state = process.env.FAKE_ORCA_STATE ? JSON.parse(process.env.FAKE_ORCA_STATE) : {};
let result = {};
if (args.startsWith("repo list")) result = { repos: [] };
else if (args.startsWith("worktree list")) result = { worktrees: [] };
else if (args.startsWith("worktree ps")) result = { worktrees: state.ps ?? [] };
else if (args.startsWith("terminal list")) result = { terminals: [] };
console.log(JSON.stringify({ ok: true, result }));
`,
  );
  fs.chmodSync(orca, 0o755);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sh = (cwd, ...args) => {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
};

function repoWithWorktree(name) {
  const base = fs.mkdtempSync(path.join(tmp, `${name}-`));
  const remote = path.join(base, "remote.git");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  spawnSync("git", ["init", "-q", "-b", "main", main]);
  sh(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  sh(main, "remote", "add", "origin", remote);
  sh(main, "push", "-q", "origin", "main");
  sh(main, "worktree", "add", "-q", "-b", "fix/a", wt);
  return { main, wt };
}

const commit = (wt, msg) => sh(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", msg);

function run(command, wt, state = {}) {
  return spawnSync(process.execPath, [script, command, "--path", wt], {
    encoding: "utf8",
    env: {
      ...process.env,
      ORCA_BIN: orca,
      ORCA_TERMINAL_HANDLE: "term_none",
      FAKE_ORCA_STATE: JSON.stringify(state),
      WORKTREE_CONSOLE_HOME: path.join(tmp, "home"),
      WORKTREE_CONSOLE_LOG_DIR: path.join(tmp, "log"),
      CLAUDE_PROJECTS_DIR: path.join(tmp, "projects"),
    },
  });
}

test("close-check does not block on unpushed commits", () => {
  const { wt } = repoWithWorktree("check");
  commit(wt, "one");
  const res = run("close-check", wt);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trim(), "ok");
});

test("close removes the worktree and keeps the branch with its unpushed commits", () => {
  const { main, wt } = repoWithWorktree("unpushed");
  commit(wt, "one");
  commit(wt, "two");
  const res = run("close", wt);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trim(), "[fix/a] 已關閉：worktree 已移除，branch fix/a 保留（含 2 個未 push commit）");
  assert.equal(fs.existsSync(wt), false);
  assert.equal(sh(main, "rev-list", "--count", "main..fix/a"), "2");
});

test("close without unpushed commits keeps the plain result line", () => {
  const { wt } = repoWithWorktree("pushed");
  const res = run("close", wt);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trim(), "[fix/a] 已關閉：worktree 已移除，branch fix/a 保留");
});

test("close still blocks on uncommitted changes, the main checkout and a working session", () => {
  const dirty = repoWithWorktree("dirty");
  commit(dirty.wt, "one");
  fs.writeFileSync(path.join(dirty.wt, "x.txt"), "x");
  let res = run("close", dirty.wt);
  assert.equal(res.status, 1);
  assert.equal(res.stdout.trim(), "[fix/a] 未關閉：工作區有未 commit 的改動");
  assert.equal(fs.existsSync(dirty.wt), true);

  res = run("close", dirty.main);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /未關閉：這是主 checkout/);

  const busy = repoWithWorktree("busy");
  res = run("close", busy.wt, { ps: [{ path: busy.wt, agents: [{ paneKey: "t:1", state: "working" }] }] });
  assert.equal(res.status, 1);
  assert.equal(res.stdout.trim(), "[a] 未關閉：session 執行中");
  assert.equal(fs.existsSync(busy.wt), true);
});
