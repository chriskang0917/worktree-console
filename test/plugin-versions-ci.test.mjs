import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, ".github", "scripts", "plugin-versions.mjs");
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

let tmp;
before(() => (tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-versions-")))));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sh(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const manifest = (name, version) => `${JSON.stringify({ name, version }, null, 2)}\n`;
const versionOf = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).version;
const ROOT = ".claude-plugin/plugin.json";
const FOCUS = "mods/focus-show/.claude-plugin/plugin.json";
const TASKS = "plugins/task-list/.claude-plugin/plugin.json";
const DOTS = "mods/tool-dots/.claude-plugin/plugin.json";

// A repo shaped like this one: main with four plugins, and a PR branch.
function repo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  write(dir, ROOT, manifest("worktree-console", "1.2.0"));
  write(dir, FOCUS, manifest("focus-show", "0.1.2"));
  write(dir, TASKS, manifest("task-list", "0.1.0"));
  write(dir, DOTS, manifest("tool-dots", "0.1.0"));
  write(dir, "CHANGELOG.md", "# Changelog\n\n## 1.2.0\n\n- 舊的\n");
  write(dir, "skills/a.md", "a\n");
  write(dir, "mods/focus-show/x.tsx", "x\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  sh(dir, "checkout", "-qb", "pr");
  return dir;
}

function bump(dir, title, extra = []) {
  const res = spawnSync(process.execPath, [script, "--base", "main", "--title", title, ...extra], { cwd: dir, encoding: "utf8" });
  return { code: res.status, out: res.stdout.trim() };
}

function commitAll(dir, msg) {
  sh(dir, "add", ".");
  if (sh(dir, "status", "--porcelain")) sh(dir, "commit", "-qm", msg);
}

test("CI 升版：PR 改到哪個 plugin 就升哪個，feat 升 minor、其他升 patch、標題有 ! 升 major；沒改到的不動", () => {
  const dir = repo("levels");
  write(dir, "skills/a.md", "b\n");
  commitAll(dir, "feat: x");
  assert.equal(bump(dir, "feat(console): 加名稱").code, 0);
  assert.deepEqual([versionOf(dir, ROOT), versionOf(dir, FOCUS), versionOf(dir, TASKS), versionOf(dir, DOTS)], ["1.3.0", "0.1.2", "0.1.0", "0.1.0"]);
  assert.match(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), /^# Changelog\n\n## 1\.3\.0\n\n- feat\(console\): 加名稱\n\n## 1\.2\.0/);
  assert.equal(bump(dir, "fix: x").code, 0);
  assert.equal(versionOf(dir, ROOT), "1.2.1");
  assert.equal(bump(dir, "feat!: 大改").code, 0);
  assert.equal(versionOf(dir, ROOT), "2.0.0");
  write(dir, "mods/focus-show/x.tsx", "y\n");
  commitAll(dir, "fix: focus");
  assert.equal(bump(dir, "fix: focus").code, 0);
  assert.deepEqual([versionOf(dir, ROOT), versionOf(dir, FOCUS), versionOf(dir, TASKS), versionOf(dir, DOTS)], ["1.2.1", "0.1.3", "0.1.0", "0.1.0"]);
  write(dir, "mods/tool-dots/hooks/register.tsx", "y\n");
  commitAll(dir, "fix: dots");
  assert.equal(bump(dir, "fix: dots").code, 0);
  assert.equal(versionOf(dir, DOTS), "0.1.1");
  const log = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  assert.match(log, /## focus-show 0\.1\.3/);
  assert.match(log, /## tool-dots 0\.1\.1/);
  assert.equal((log.match(/^## 1\.2\.1$/gm) ?? []).length, 1, "重算只改標題，不疊新段落");
});

test("CI 升版：同一個 PR 推三次 commit 仍是同一個版號，手寫的 CHANGELOG 說明保留", () => {
  const dir = repo("again");
  for (let i = 1; i <= 3; i++) {
    write(dir, "skills/a.md", `v${i}\n`);
    commitAll(dir, `feat: 第 ${i} 次`);
    assert.equal(bump(dir, "feat: 加名稱").code, 0);
    if (i === 1) {
      const text = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8").replace("- feat: 加名稱", "- 我自己寫的說明");
      fs.writeFileSync(path.join(dir, "CHANGELOG.md"), text);
    }
    commitAll(dir, "chore: bump plugin versions");
    assert.equal(versionOf(dir, ROOT), "1.3.0", `第 ${i} 次`);
  }
  const log = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  assert.equal((log.match(/^## 1\.3\.0$/gm) ?? []).length, 1);
  assert.match(log, /## 1\.3\.0\n\n- 我自己寫的說明\n/);
  assert.doesNotMatch(log, /## 1\.4\.0/);
});

test("CI 升版：別的 PR 先 merge、main 版號變了，以新的 main 重算，不撞號也不空號，手寫說明照樣保留", () => {
  const dir = repo("moved");
  write(dir, "skills/a.md", "pr\n");
  commitAll(dir, "feat: mine");
  bump(dir, "feat: mine");
  const text = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8").replace("- feat: mine", "- 我的說明");
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), text);
  commitAll(dir, "chore: bump plugin versions");
  assert.equal(versionOf(dir, ROOT), "1.3.0");
  sh(dir, "checkout", "-q", "main");
  write(dir, ROOT, manifest("worktree-console", "1.3.0"));
  write(dir, "CHANGELOG.md", "# Changelog\n\n## 1.3.0\n\n- 別人的\n\n## 1.2.0\n\n- 舊的\n");
  commitAll(dir, "feat: other (#9)");
  sh(dir, "checkout", "-q", "pr");
  assert.equal(bump(dir, "feat: mine").code, 0);
  assert.equal(versionOf(dir, ROOT), "1.4.0");
  const log = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  assert.match(log, /## 1\.4\.0\n\n- 我的說明\n/);
  assert.doesNotMatch(log, /## 1\.3\.0\n\n- 我的說明/);
});

test("CI 升版：從 fork 開的 PR 只檢查，沒升或升錯就失敗並印出每個 plugin 該升成幾號", () => {
  const dir = repo("fork");
  write(dir, "skills/a.md", "fork\n");
  write(dir, "mods/focus-show/x.tsx", "fork\n");
  commitAll(dir, "fix: fork");
  const missing = bump(dir, "fix: fork", ["--check"]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /worktree-console：應升成 1\.2\.1/);
  assert.match(missing.out, /focus-show：應升成 0\.1\.3/);
  assert.equal(versionOf(dir, ROOT), "1.2.0", "只檢查，不改檔");
  write(dir, ROOT, manifest("worktree-console", "1.3.0"));
  write(dir, FOCUS, manifest("focus-show", "0.1.3"));
  write(dir, "CHANGELOG.md", "# Changelog\n\n## focus-show 0.1.3\n\n- 修\n\n## 1.3.0\n\n- 修\n\n## 1.2.0\n\n- 舊的\n");
  commitAll(dir, "chore: bump");
  const wrong = bump(dir, "fix: fork", ["--check"]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /worktree-console：應升成 1\.2\.1（main 是 1\.2\.0，目前 plugin\.json 是 1\.3\.0/);
  assert.doesNotMatch(wrong.out, /focus-show：應升成/);
  write(dir, ROOT, manifest("worktree-console", "1.2.1"));
  write(dir, "CHANGELOG.md", "# Changelog\n\n## focus-show 0.1.3\n\n- 修\n\n## 1.2.1\n\n- 修\n\n## 1.2.0\n\n- 舊的\n");
  commitAll(dir, "chore: fix bump");
  assert.equal(bump(dir, "fix: fork", ["--check"]).code, 0);
});
