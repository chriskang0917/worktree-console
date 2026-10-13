import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCoreTask, tasksDirectory, writeTaskMode } from "../scripts/task-core-home.mjs";
import { executeCoreCommand } from "../scripts/task-core-commands.mjs";
import { readTask } from "../scripts/task-store.mjs";
import { renderTaskGraph } from "../scripts/task-core-generated.mjs";

const script = fileURLToPath(new URL("../scripts/task-list.mjs", import.meta.url));
function isolated(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-core-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_HOME: path.join(dir, "claude"), WORKTREE_CONSOLE_HOME: path.join(dir, "console"), WORKTREE_CONSOLE_TASKS_DIR: path.join(dir, "tasks") };
  return { dir, env };
}
function run(env, ...args) { return spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" }); }
function cli(env, ...args) {
  const result = run(env, ...args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}
function command(root, operation, data, options) {
  return executeCoreCommand(root, operation, { commandId: randomUUID(), expectedRevision: readTask(root).revision, actor: { host: "local", id: "驗收者" }, data }, options);
}
function add(root, id, parentId) {
  const state = readTask(root);
  return command(root, "item add", {
    id, kind: parentId ? "leaf" : "group", title: id,
    order: state.items.filter(item => item.parentId === parentId).length,
    nextAction: "執行工作", sourceRef: "README.md",
    ...(parentId ? { parentId, completionPolicy: [{ criterion: "證據經驗收", target: "report.md", evidenceType: "report", verifier: "human" }] } : {}),
  });
}
function submit(env, item = "leaf") {
  return JSON.parse(cli(env, "task", "report", "submit", "--item", item, "--reviewer", "驗收者", "--evidence", "report.md")).result.id;
}

test("建立、加入、查看三步預設呈現線圖與已提交時間線", t => {
  const { env } = isolated(t);
  const root = JSON.parse(cli(env, "task-new", "登入改善任務")).task;
  cli(env, "task", "item", "add", "--title", "登入改善", "--id", "login");
  cli(env, "task", "item", "add", "--title", "整理錯誤訊息", "--parent", "login", "--criterion", "訊息清楚");
  cli(env, "task", "item", "add", "--title", "修正重複送出", "--parent", "login", "--criterion", "只送一次");
  const output = cli(env, "task-todos");
  assert.match(output, /登入改善 0\/2/);
  assert.match(output, /├─ ○ 整理錯誤訊息/);
  assert.match(output, /╰─ ○ 修正重複送出/);
  assert.match(output, /建立任務/);
  const state = readTask(root);
  const events = state.events;
  assert.throws(() => command(root, "item add", { id: "未提交", kind: "leaf", parentId: "missing", title: "未提交", order: 0, nextAction: "驗收", sourceRef: "README.md", completionPolicy: [{ criterion: "證據", target: "report.md", evidenceType: "report", verifier: "human" }] }), { code: "INVALID_STATE" });
  assert.deepEqual(readTask(root).events, events);
  assert.doesNotMatch(cli(env, "task-todos"), /未提交/);
});
test("子項沒給 --criterion 時直接說要補完成條件", t => {
  const { env } = isolated(t);
  const root = createCoreTask("子項條件", { env });
  add(root, "parent");
  const result = run(env, "task", "item", "add", "--parent", "parent", "--title", "沒條件");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, "CRITERION_REQUIRED");
  assert.equal(readTask(root).items.length, 1);
});

test("ack 不完成工作；指定驗收者 accept 同交易完成父項", t => {
  const { env } = isolated(t);
  const root = createCoreTask("驗收工作", { env });
  add(root, "parent"); add(root, "leaf", "parent");
  const report = submit(env);
  cli(env, "task", "report", "ack", "--id", report);
  assert.equal(readTask(root).items[1].status, "review");
  const wrong = run(env, "task", "report", "accept", "--id", report, "--by", "其他人");
  assert.equal(wrong.status, 1);
  assert.equal(JSON.parse(wrong.stdout).code, "REVIEWER_MISMATCH");
  const accepted = JSON.parse(cli(env, "task", "report", "accept", "--id", report, "--by", "驗收者"));
  const state = readTask(root);
  assert.equal(state.revision, accepted.revision);
  assert.deepEqual(state.items.map(item => item.status), ["done", "done"]);
  assert.equal(state.reports[0].acceptance.status, "accepted");
});
test("拒絕保留原因並阻止父項完成；重開後新交付可驗收", t => {
  const { env } = isolated(t);
  const root = createCoreTask("拒絕工作", { env });
  add(root, "parent"); add(root, "leaf", "parent");
  const report = submit(env);
  cli(env, "task", "report", "reject", "--id", report, "--by", "驗收者", "--reason", "證據不足");
  assert.deepEqual(readTask(root).items.map(item => item.status), ["queued", "blocked"]);
  assert.equal(readTask(root).reports[0].acceptance.reason, "證據不足");
  cli(env, "task", "item", "reopen", "--id", "leaf", "--reason", "補足證據");
  const replacement = submit(env);
  cli(env, "task", "report", "accept", "--id", replacement, "--by", "驗收者");
  assert.deepEqual(readTask(root).items.map(item => item.status), ["done", "done"]);
});
test("重開撤銷父項完成；舊 attempt 與舊規格報告只入歷史", t => {
  const { env } = isolated(t);
  const root = createCoreTask("重開工作", { env });
  add(root, "parent"); add(root, "leaf", "parent");
  const report = submit(env);
  cli(env, "task", "report", "accept", "--id", report, "--by", "驗收者");
  const attempt = readTask(root).items[1].attemptId;
  command(root, "item reopen", { id: "leaf", reason: "修改範圍", specRevision: 2 });
  command(root, "report submit", { itemId: "leaf", attemptId: attempt, outcome: "success", evidence: [] });
  command(root, "report submit", { itemId: "leaf", specRevision: 1, outcome: "success", evidence: [] });
  const state = readTask(root);
  assert.deepEqual(state.items.map(item => item.status), ["queued", "queued"]);
  assert.ok(state.reports.every(entry => entry.history));
  assert.throws(() => command(root, "report accept", { id: state.reports[1].id, by: "驗收者" }), { code: "STALE_REPORT" });
});
test("空或全取消父項不冒稱完成", t => {
  const { env } = isolated(t);
  const root = createCoreTask("取消工作", { env });
  add(root, "parent");
  assert.equal(readTask(root).items[0].status, "queued");
  add(root, "leaf", "parent");
  cli(env, "task", "item", "cancel", "--id", "leaf", "--reason", "不再需要");
  assert.deepEqual(readTask(root).items.map(item => item.status), ["queued", "cancelled"]);
  assert.match(cli(env, "task-todos"), /parent 0\/0/);
});
test("生成看板由正本補建並使用任務內自訂路徑", t => {
  const { env } = isolated(t);
  const root = createCoreTask("生成工作", { env });
  add(root, "parent");
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: "snapshots/board.md" }));
  executeCoreCommand(root, "read");
  const file = path.join(root, "snapshots/board.md");
  fs.writeFileSync(file, "錯誤手寫內容");
  const result = executeCoreCommand(root, "read");
  assert.deepEqual(result.viewErrors, []);
  assert.match(fs.readFileSync(file, "utf8"), /parent 0\/0/);
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`revision=${result.revision}`));
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /錯誤手寫內容/);
});
test("任務位置依環境、全域設定、Claude 目錄優先；失效選取拒絕退回全機", t => {
  const { dir, env } = isolated(t);
  const clean = { ...env }; delete clean.WORKTREE_CONSOLE_TASKS_DIR;
  assert.equal(tasksDirectory(clean), path.join(env.CLAUDE_HOME, "worktree-console/tasks"));
  writeTaskMode({ tasksDir: path.join(dir, "configured") }, env);
  assert.equal(tasksDirectory(clean), path.join(dir, "configured"));
  assert.equal(tasksDirectory(env), env.WORKTREE_CONSOLE_TASKS_DIR);
  writeTaskMode({ task: path.join(dir, "missing") }, env);
  const result = run(env, "task-todos");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, "INVALID_BINDING");
});
test("生成路徑禁止覆寫正本，task-todos 回報原因並退出 2", t => {
  const { env } = isolated(t);
  const root = createCoreTask("生成失敗任務", { env });
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: "task-state.json" }));
  const before = fs.readFileSync(path.join(root, "task-state.json"), "utf8");
  const result = run(env, "task-todos");
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /看板.*不可覆寫.*正本/);
  assert.equal(fs.readFileSync(path.join(root, "task-state.json"), "utf8"), before);
});
test("生成失敗不撤銷已提交驗收；修正路徑後可補建", t => {
  const { env } = isolated(t);
  const root = createCoreTask("提交後生成失敗", { env });
  add(root, "parent"); add(root, "leaf", "parent");
  const report = submit(env);
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: "task-state.json" }));
  const result = run(env, "task", "report", "accept", "--id", report, "--by", "驗收者");
  assert.equal(result.status, 2);
  assert.deepEqual(readTask(root).items.map(item => item.status), ["done", "done"]);
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: "board.md" }));
  const regenerated = executeCoreCommand(root, "read");
  assert.deepEqual(regenerated.viewErrors, []);
  assert.match(fs.readFileSync(path.join(root, "board.md"), "utf8"), new RegExp(`revision=${regenerated.revision}`));
});

test("正本提交前磁碟失敗不新增時間線或改變待辦", t => {
  const { env } = isolated(t);
  const root = createCoreTask("提交失敗", { env });
  add(root, "parent");
  const before = readTask(root);
  assert.throws(() => command(root, "item update", { id: "parent", changes: { title: "未提交名稱" } }, {
    fault(point, file) {
      if (point === "beforeRename" && path.basename(file) === "task-state.json") throw Object.assign(new Error("合成磁碟失敗"), { code: "EIO" });
    },
  }), { code: "EIO" });
  assert.deepEqual(readTask(root), before);
  assert.doesNotMatch(cli(env, "task-todos"), /未提交名稱/);
});

test("重送已提交指令不重複新增；相同 ID 不可換內容或跳過 revision 衝突", t => {
  const { env } = isolated(t);
  const root = createCoreTask("重送工作", { env });
  add(root, "parent");
  const old = readTask(root);
  const envelope = { commandId: randomUUID(), expectedRevision: old.revision, actor: { host: "local", id: "驗收者" }, data: { id: "parent", changes: { title: "新名稱" } } };
  const first = executeCoreCommand(root, "item update", envelope);
  const replay = executeCoreCommand(root, "item update", envelope);
  assert.equal(replay.replay, true);
  assert.equal(replay.revision, first.revision);
  assert.equal(readTask(root).revision, old.revision + 1);
  assert.throws(() => executeCoreCommand(root, "item update", { ...envelope, data: { id: "parent", changes: { title: "不同名稱" } } }), { code: "COMMAND_ID_CONFLICT" });
  assert.throws(() => executeCoreCommand(root, "item update", { ...envelope, commandId: randomUUID() }), { code: "REVISION_CONFLICT" });
  assert.equal(readTask(root).items[0].title, "新名稱");
});

test("摘要不重算群組、保持狀態順序與完整子項，完成證據仍留在樹上", () => {
  const statuses = ["parked", "queued", "doing", "review", "blocked", "waiting"];
  const state = {
    title: "文字線圖", taskId: "graph", revision: 7, events: [],
    items: [
      { id: "active", kind: "group", title: "進行群組", status: "doing", order: 0 },
      ...statuses.map((status, order) => ({ id: status, kind: "leaf", parentId: "active", title: `${status}子項`, status, order })),
      { id: "starred", kind: "leaf", parentId: "active", title: "完成待核對", status: "done", order: 6 },
      { id: "hidden", kind: "leaf", parentId: "active", title: "完成已核對", status: "done", order: 7 },
      { id: "done-group", kind: "group", title: "完成群組", status: "done", order: 1 },
      { id: "done-child", kind: "leaf", parentId: "done-group", title: "群組完成子項", status: "done", order: 0 },
      { id: "next", kind: "group", title: "下一組", status: "queued", order: 2 },
      { id: "next-child", kind: "leaf", parentId: "next", title: "下一個工作", status: "queued", order: 0 },
    ],
    reports: [
      { id: "current", itemId: "starred", ack: false, evidence: ["報告.md"] },
      { id: "history", itemId: "starred", ack: false, history: true, evidence: ["舊報告.md"] },
      { id: "read", itemId: "hidden", ack: true, evidence: ["已讀.md"] },
    ],
  };
  const graph = renderTaskGraph(state);
  assert.equal(graph.split("\n")[2], "◆ 1 待回答 · ! 1 受阻 · ◇ 1 待驗收 · ▶ 1 進行 · ○ 2 待辦 · = 1 停泊 · ★ 2 未核對");
  for (const status of statuses) assert.ok(graph.includes(`${status}子項`));
  assert.match(graph, /╰─ ✓ 完成待核對 ★/);
  assert.match(graph, /\n\n○ 下一組/);
  assert.match(graph, /已完成 3 項（task-todos --include-completed 展開）/);
  assert.doesNotMatch(graph, /✓ 完成已核對|✓ 完成群組|還有 \d+ 項|\u001b/);
  const expanded = renderTaskGraph(state, { includeCompleted: true });
  assert.match(expanded, /✓ 完成已核對/);
  assert.match(expanded, /✓ 完成群組/);
  assert.doesNotMatch(expanded, /已完成 \d+ 項/);
});

test("全完成摘要保留未核對報告，空清單不列零項狀態", () => {
  const state = {
    title: "完成任務", taskId: "done", revision: 1, events: [],
    items: [{ id: "done", kind: "leaf", title: "完成工作", status: "done", order: 0 }],
    reports: [{ id: "report", itemId: "done", ack: false, evidence: ["報告.md"] }],
  };
  assert.equal(renderTaskGraph(state).split("\n")[2], "沒有未完成項目 · ★ 1 未核對");
  state.items = [];
  state.reports = [];
  assert.equal(renderTaskGraph(state).split("\n")[2], "沒有未完成項目");
});
