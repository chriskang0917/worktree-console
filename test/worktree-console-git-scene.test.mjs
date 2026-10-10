import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills/worktree-console/scripts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-git-scene-"));
process.env.WORKTREE_CONSOLE_LOG_DIR = path.join(tmp, "log");
process.env.WORKTREE_CONSOLE_HOME = path.join(tmp, "home");

const { alreadyIn, gitScene } = await import(path.join(scripts, "git-scene.mjs"));

const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(res.status, 0, `${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function repoWithWorktree(branch) {
  const main = fs.mkdtempSync(path.join(tmp, "repo-"));
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "a.txt"), "1\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const wt = path.join(tmp, `wt-${path.basename(main)}`);
  git(main, "worktree", "add", "-q", "-b", branch, wt);
  return { main, wt };
}

test("gitScene：還沒動工是 null、未 commit 是 A、已 commit 未合進 base 是 B、squash 合進 base 是 C；不是 git 目錄是 null", () => {
  const { main, wt } = repoWithWorktree("feat/x");
  assert.equal(gitScene(wt), null);
  fs.writeFileSync(path.join(wt, "b.txt"), "2\n");
  assert.equal(gitScene(wt), "A");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "feat");
  assert.equal(gitScene(wt), "B");
  git(main, "merge", "--squash", "feat/x");
  git(main, "commit", "-q", "-m", "squash feat/x");
  assert.equal(gitScene(wt), "C");
  assert.equal(gitScene(path.join(tmp, "nowhere")), null);
  assert.equal(gitScene(fs.mkdtempSync(path.join(tmp, "plain-"))), null);
});

test("alreadyIn：squash 合併過的 branch 算已合進，還沒合的不算", () => {
  const { main, wt } = repoWithWorktree("feat/y");
  fs.writeFileSync(path.join(wt, "c.txt"), "3\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "feat");
  assert.equal(alreadyIn(main, "main", "refs/heads/feat/y"), false);
  git(main, "merge", "--squash", "feat/y");
  git(main, "commit", "-q", "-m", "squash feat/y");
  assert.equal(alreadyIn(main, "main", "refs/heads/feat/y"), true);
});

test("回覆習慣記憶已移除：腳本不再讀寫 memory.md，也沒有 replay／remember／decline 指令", () => {
  assert.equal(fs.existsSync(path.join(scripts, "memory.mjs")), false);
  for (const file of fs.readdirSync(scripts)) {
    const src = fs.readFileSync(path.join(scripts, file), "utf8");
    assert.doesNotMatch(src, /memory\.md|memory\.mjs|你通常會回|要記住這個習慣/, file);
  }
});

test("專注面板資料：既有的 memory.md 不影響卡片與印出的題目，payload 沒有 unreadable", async () => {
  const { focusPayload } = await import(path.join(scripts, "focus.mjs"));
  fs.mkdirSync(process.env.WORKTREE_CONSOLE_LOG_DIR, { recursive: true });
  const file = path.join(process.env.WORKTREE_CONSOLE_LOG_DIR, "memory.md");
  const text = ["# 回覆習慣", "", "## 其他", "- 看心情（記住 2026-09-01）", ""].join("\n");
  fs.writeFileSync(file, text);
  const { wt } = repoWithWorktree("feat/z");
  const row = (label, status, extra = {}) => ({ repo: "app", label, ticket: label, branch: label.toLowerCase(), title: "x", stage: "實作中", ...extra,
    sessions: [{ n: null, handle: `h-${label}`, paneKey: `p-${label}`, agent: { state: "done" }, status }] });
  const rows = [row("PROJ-1", { kind: "done", text: "做完了。" }, { path: wt }), row("PROJ-2", { kind: "waiting", text: "要定稿嗎？" })];
  const { payload } = focusPayload(rows, { current: null, queue: [], wait: null, state: { titles: {} } }, { home: tmp });
  assert.equal("unreadable" in payload, false);
  for (const s of payload.sessions) {
    assert.ok(!("habit" in s), s.tag);
    assert.doesNotMatch(s.report, /要記住|看不懂|記住 [A-E]/, s.tag);
  }
  assert.equal(fs.readFileSync(file, "utf8"), text);
});
