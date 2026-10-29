import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveStage, homeRunFolder, stageFacts, stageWithSource } from "../skills/worktree-console/scripts/lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consoleScript = path.join(root, "skills", "worktree-console", "scripts", "console.mjs");
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

let tmp;
const savedHome = process.env.SARA_DEV_FLOW_HOME;
const app = () => path.join(tmp, "app");
const flowHome = () => path.join(tmp, "sara-dev-flow");
const consoleHome = () => path.join(tmp, "console-home");
const logDir = () => path.join(tmp, "log");

function sh(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const plan = (status) => `---\nstatus: ${status}\n---\n\n# plan\n`;

function withWorktree(branch, fn) {
  const dir = path.join(tmp, "wt", branch.replace(/\//g, "-"));
  sh(app(), "worktree", "add", "-q", "-b", branch, dir, "main");
  try {
    fn(dir);
  } finally {
    sh(app(), "worktree", "remove", "--force", dir);
    sh(app(), "branch", "-D", branch);
    fs.rmSync(flowHome(), { recursive: true, force: true });
  }
}

function stageCli(p, env = {}) {
  const res = spawnSync(process.execPath, [consoleScript, "stage", "--path", p], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: {
      ...process.env,
      SARA_DEV_FLOW_HOME: flowHome(),
      WORKTREE_CONSOLE_HOME: consoleHome(),
      WORKTREE_CONSOLE_LOG_DIR: logDir(),
      ORCA_BIN: "/nonexistent/orca",
      ...env,
    },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const lines = res.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "只印一行");
  return JSON.parse(lines[0]);
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-stage-")));
  process.env.SARA_DEV_FLOW_HOME = flowHome();
  sh(tmp, "init", "--bare", "-b", "main", "remote.git");
  sh(tmp, "clone", "-q", "remote.git", "app");
  writeFile(path.join(app(), "README.md"), "hi\n");
  writeFile(path.join(app(), ".gitignore"), ".goals\n");
  sh(app(), "add", ".");
  sh(app(), "commit", "-qm", "init");
  sh(app(), "push", "-q", "origin", "main");
});

after(() => {
  if (savedHome === undefined) delete process.env.SARA_DEV_FLOW_HOME;
  else process.env.SARA_DEV_FLOW_HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("階段（repo 外的 run folder）：路徑是 SARA_DEV_FLOW_HOME/<主 checkout 資料夾名>/<branch 斜線換破折號>", () => {
  assert.equal(
    homeRunFolder("sara-v2-frontend", "feature/SARA-7882-schedule-board-search-and-resource-counts"),
    path.join(flowHome(), "sara-v2-frontend", "feature-SARA-7882-schedule-board-search-and-resource-counts"),
  );
});

test("階段（repo 外的 run folder）：plan.md 是 draft → 規劃中；approved → 實作中；兩處都沒有 → 照舊未開工", () => {
  const branch = "feature/PROJ-7882-board-search";
  withWorktree(branch, (dir) => {
    const before = stageFacts(dir, null, branch);
    assert.deepEqual([before.runFolder, before.planApproved], [false, false]);
    assert.equal(deriveStage({ facts: before }), "未開工");
    const folder = path.join(flowHome(), "app", "feature-PROJ-7882-board-search");
    writeFile(path.join(folder, "goal.md"), "# goal\n");
    assert.equal(deriveStage({ facts: stageFacts(dir, null, branch) }), "規劃中", "只有 goal.md、沒有 plan.md");
    writeFile(path.join(folder, "plan.md"), plan("draft"));
    const draft = stageFacts(dir, null, branch);
    assert.deepEqual([draft.runFolder, draft.planApproved], [true, false]);
    assert.deepEqual(stageWithSource({ facts: draft }), { stage: "規劃中", source: "dev-flow-plan" });
    writeFile(path.join(folder, "plan.md"), plan("approved"));
    assert.deepEqual(stageWithSource({ facts: stageFacts(dir, null, branch) }), { stage: "實作中", source: "dev-flow-plan" });
    assert.equal(deriveStage({ facts: stageFacts(dir, null, branch, "other-repo") }), "未開工", "別的 repo 名稱下的 run folder 不算");
  });
});

test("階段（repo 外的 run folder）：worktree 裡的 docs/dev-flow 照舊認得；任一處批准就算實作中", () => {
  const branch = "chris/proj-7883-both";
  withWorktree(branch, (dir) => {
    writeFile(path.join(dir, "docs", "dev-flow", "chris-proj-7883-both", "plan.md"), plan("draft"));
    assert.equal(deriveStage({ facts: stageFacts(dir, null, branch) }), "規劃中");
    writeFile(path.join(flowHome(), "app", "chris-proj-7883-both", "plan.md"), plan("approved"));
    assert.equal(deriveStage({ facts: stageFacts(dir, null, branch) }), "實作中");
  });
});

test("stage --path：印一行 JSON，source 寫出判斷依據；不需要 Orca，也不寫中控台的登記檔", () => {
  const branch = "feature/PROJ-7884-stage";
  withWorktree(branch, (dir) => {
    assert.deepEqual(stageCli(dir), { stage: "未開工", source: "none" });
    writeFile(path.join(flowHome(), "app", "feature-PROJ-7884-stage", "plan.md"), plan("draft"));
    assert.deepEqual(stageCli(dir), { stage: "規劃中", source: "dev-flow-plan" });
    writeFile(path.join(flowHome(), "app", "feature-PROJ-7884-stage", "plan.md"), plan("approved"));
    assert.deepEqual(stageCli(dir), { stage: "實作中", source: "dev-flow-plan" });
    writeFile(path.join(dir, "src", "a.js"), "x\n");
    assert.deepEqual(stageCli(dir), { stage: "實作中", source: "dirty" });
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    assert.deepEqual(stageCli(path.join(dir, "sub")), { stage: "實作中", source: "dirty" }, "子資料夾也找得到 worktree");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "code");
    assert.deepEqual(stageCli(dir), { stage: "實作中", source: "ahead" });
    sh(dir, "push", "-q", "-u", "origin", branch);
    assert.deepEqual(stageCli(dir), { stage: "已推送", source: "pushed" });
    sh(dir, "push", "-q", "origin", "--delete", branch);
  });
  assert.equal(fs.existsSync(logDir()), false, "沒有寫 managed.json");
  assert.equal(fs.existsSync(path.join(consoleHome(), "consoles.json")), false, "沒有登記成中控台");
});

test("stage --path：目標檔與開工標記的 source", () => {
  const goals = path.join(app(), ".goals");
  sh(app(), "branch", "proj-1-seed");
  try {
    withWorktree("feat/proj-7885-goal", (dir) => {
      writeFile(path.join(goals, "proj-7885.md"), "## 目標：x\n\n**實作方案**：（未定）\n");
      assert.deepEqual(stageCli(dir), { stage: "規劃中", source: "goal-file" });
      writeFile(path.join(goals, "proj-7885.md"), "## 目標：x\n\n**實作方案**：直接實作\n");
      assert.deepEqual(stageCli(dir), { stage: "實作中", source: "goal-file" });
      fs.rmSync(path.join(goals, "proj-7885.md"));
      writeFile(path.join(consoleHome(), "herdr-worktrees.json"), JSON.stringify({ [dir]: { ticket: "PROJ-7885", interview: true } }));
      assert.deepEqual(stageCli(dir), { stage: "規劃中", source: "interview-comment" });
    });
  } finally {
    fs.rmSync(path.join(consoleHome(), "herdr-worktrees.json"), { force: true });
    sh(app(), "branch", "-D", "proj-1-seed");
  }
});

test("stage --path：不是 git worktree → unknown／not-a-worktree，照樣 exit 0", () => {
  const plain = path.join(tmp, "plain");
  fs.mkdirSync(plain, { recursive: true });
  assert.deepEqual(stageCli(plain), { stage: "unknown", source: "not-a-worktree" });
  assert.deepEqual(stageCli(path.join(tmp, "missing")), { stage: "unknown", source: "not-a-worktree" });
});
