import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCoreTask } from "../scripts/task-core-home.mjs";
import { executeCoreCommand } from "../scripts/task-core-commands.mjs";
import { readTask } from "../scripts/task-store.mjs";
import { renderTaskGraph } from "../scripts/task-core-generated.mjs";

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-cleanup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, CLAUDE_HOME: path.join(dir, "claude-home"), CLAUDE_CONFIG_DIR: path.join(dir, "claude-config"), WORKTREE_CONSOLE_HOME: path.join(dir, "console"), WORKTREE_CONSOLE_TASKS_DIR: path.join(dir, "tasks") };
  return { root: createCoreTask("清理驗收", { env }), env };
}
function command(root, operation, data = {}, options = {}) {
  return executeCoreCommand(root, operation, { commandId: randomUUID(), expectedRevision: readTask(root).revision, actor: { host: "local", id: "驗收者" }, data }, options);
}
function save(root, state) { fs.writeFileSync(path.join(root, "task-state.json"), JSON.stringify(state)); }
function group(id, order, status = "queued") { return { id, kind: "group", title: id, status, order, attemptId: randomUUID(), specRevision: 1, sourceRef: "README.md", nextAction: "處理工作" }; }

test("28 個完成項收合但 3 個未完成項與完整展開仍可見", t => {
  const { root } = setup(t);
  const state = readTask(root);
  state.items = [group("完成群組", 0, "done"), ...Array.from({ length: 28 }, (_, i) => ({ ...group(`完成${i}`, i, "done"), kind: "leaf", parentId: "完成群組" })), ...Array.from({ length: 3 }, (_, i) => group(`未完成${i}`, 1 + i))];
  const graph = renderTaskGraph(state);
  assert.match(graph, /已完成 28 項/);
  assert.doesNotMatch(graph, /✓ 完成0/);
  for (let i = 0; i < 3; i++) assert.match(graph, new RegExp(`未完成${i}`));
  const expanded = renderTaskGraph(state, { includeCompleted: true });
  for (let i = 0; i < 28; i++) assert.match(expanded, new RegExp(`✓ 完成${i}(?: |$)`, "m"));
});

function aged(root, count = 1001) {
  const state = readTask(root);
  const time = "2020-01-01T00:00:00.000Z";
  state.events = Array.from({ length: count }, (_, i) => ({ id: randomUUID(), revision: i, entity: { type: "task", id: state.taskId }, actor: { host: "local", id: "驗收者" }, occurredAt: time, recordedAt: time, commandId: randomUUID(), command: "item update", requestHash: `歷史${i}`, result: { id: `結果${i}` } }));
  state.revision = count - 1;
  save(root, state);
  return state;
}

test("超過千筆自動無損壓縮，保留最近 200 與七天聯集並可跨冷熱分頁還原", t => {
  const { root } = setup(t);
  const old = aged(root);
  old.items = [group("工作", 0)];
  old.events[10].recordedAt = new Date().toISOString();
  save(root, old);
  const result = command(root, "item update", { id: "工作", changes: { title: "更新工作" } });
  const state = readTask(root);
  assert.equal(result.compaction.count, 801);
  assert.equal(state.events.length, 202);
  assert.equal(state.revision, old.revision + 2);
  assert.ok(state.events.some(event => event.id === old.events[10].id));
  const all = executeCoreCommand(root, "history", { limit: 2000 }).events;
  assert.equal(all.length, 1003);
  for (const event of old.events) assert.deepEqual(all.find(row => row.id === event.id), event);
  const first = executeCoreCommand(root, "history", { limit: 7 });
  const second = executeCoreCommand(root, "history", { limit: 7, beforeRevision: first.nextBeforeRevision });
  assert.deepEqual([...first.events, ...second.events], all.slice(0, 14));
  const before = state.items;
  command(root, "history restore", { archive: state.history[0].id });
  const restored = readTask(root);
  assert.deepEqual(restored.items, before);
  assert.equal(restored.revision, state.revision + 1);
  assert.equal(restored.events.length, 1004);
  assert.equal(executeCoreCommand(root, "history verify").count, 1004);
  assert.ok(fs.existsSync(path.join(root, state.history[0].manifest)));
});

test("壓縮後舊指令同內容回原結果，不同內容拒絕且不重複實體", t => {
  const { root } = setup(t);
  const envelope = { commandId: randomUUID(), expectedRevision: 0, actor: { host: "local", id: "驗收者" }, data: { id: "工作", kind: "group", title: "工作", order: 0, nextAction: "執行", sourceRef: "README.md" } };
  const first = executeCoreCommand(root, "item add", envelope);
  const receipt = readTask(root).events.at(-1);
  const state = aged(root);
  state.events[1] = { ...receipt, occurredAt: state.events[1].occurredAt, recordedAt: state.events[1].recordedAt };
  save(root, state);
  command(root, "compact");
  const before = readTask(root);
  const replay = executeCoreCommand(root, "item add", envelope);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.revision, first.revision);
  assert.equal(readTask(root).revision, before.revision);
  assert.equal(readTask(root).items.length, 1);
  assert.throws(() => executeCoreCommand(root, "item add", { ...envelope, data: { ...envelope.data, title: "不同內容" } }), { code: "COMMAND_ID_CONFLICT" });
});

for (const boundary of ["snapshot", "events", "manifest", "switch"]) test(`壓縮於 ${boundary} 寫入中斷仍保留完整正本`, t => {
  const { root } = setup(t);
  const before = aged(root);
  assert.throws(() => command(root, "compact", {}, { fault(point, file) {
    const name = path.basename(file);
    if (point === "beforeRename" && (boundary === "switch" ? name === "task-state.json" : name.startsWith(boundary))) throw Object.assign(new Error("模擬磁碟已滿"), { code: "ENOSPC" });
  } }), { code: "ENOSPC" });
  assert.deepEqual(readTask(root), before);
  assert.equal(executeCoreCommand(root, "history verify").count, 1001);
});

test("切換後生成前中斷，新正本與歷史仍可讀且可同 revision 補建", t => {
  const { root } = setup(t);
  const before = aged(root);
  assert.throws(() => command(root, "compact", {}, { fault(point, file) {
    if (point === "afterRename" && path.basename(file) === "task-state.json") throw new Error("模擬程序中斷");
  } }), /模擬程序中斷/);
  const state = readTask(root);
  assert.equal(state.revision, before.revision + 1);
  assert.equal(executeCoreCommand(root, "history verify").count, 1002);
  executeCoreCommand(root, "read");
  assert.ok(fs.readFileSync(path.join(root, "board.md"), "utf8").includes(`revision=${state.revision}`));
});

for (const damage of ["missing", "checksum"]) test(`歷史 ${damage} 阻擋寫入並保留最後看板，不把故障當空歷史`, t => {
  const { root } = setup(t);
  aged(root);
  command(root, "compact");
  const state = readTask(root);
  const board = fs.readFileSync(path.join(root, "board.md"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, state.history[0].manifest), "utf8"));
  const segment = path.join(root, manifest.segment.path);
  if (damage === "missing") fs.unlinkSync(segment); else fs.appendFileSync(segment, "損壞");
  assert.throws(() => executeCoreCommand(root, "history verify"), { code: "HISTORY_CORRUPT" });
  assert.throws(() => executeCoreCommand(root, "item add", { commandId: randomUUID(), expectedRevision: state.revision, actor: { host: "local", id: "驗收者" }, data: {} }), { code: "HISTORY_CORRUPT" });
  assert.equal(fs.readFileSync(path.join(root, "board.md"), "utf8"), board);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "task-state.json"))).revision, state.revision);
});

test("compact 與重開競爭由鎖及 revision 拒絕，舊 attempt 遲到結果只入歷史", t => {
  const { root } = setup(t);
  command(root, "item add", { id: "工作", kind: "leaf", title: "工作", order: 0, nextAction: "執行", sourceRef: "README.md", completionPolicy: [{ criterion: "通過", target: "證據", evidenceType: "report", verifier: "human" }] });
  const attemptId = readTask(root).items[0].attemptId;
  const old = aged(root);
  const stale = { commandId: randomUUID(), expectedRevision: old.revision, actor: { host: "local", id: "驗收者" }, data: { id: "工作", reason: "重做" } };
  let competed = false;
  command(root, "compact", {}, { fault(point, file) {
    if (!competed && point === "beforeRename" && path.basename(file).startsWith("snapshot")) {
      competed = true;
      assert.throws(() => executeCoreCommand(root, "item reopen", stale), { code: "LOCKED" });
      assert.throws(() => executeCoreCommand(root, "report submit", { ...stale, data: { itemId: "工作", outcome: "success" } }), { code: "LOCKED" });
    }
  } });
  assert.equal(competed, true);
  assert.throws(() => executeCoreCommand(root, "item reopen", stale), { code: "REVISION_CONFLICT" });
  command(root, "item reopen", stale.data);
  command(root, "report submit", { itemId: "工作", attemptId, outcome: "success", evidence: [] });
  const state = readTask(root);
  assert.equal(state.items[0].status, "queued");
  assert.equal(state.reports[0].history, true);
  assert.equal(state.reports[0].ack, false);
});

test("v1 首次寫入遷移 v2，保留不可變恢復點及 fork 擴充", t => {
  const { root } = setup(t);
  const state = readTask(root);
  state.schemaVersion = 1; delete state.history;
  state.questions = [{ id: "問題", status: "open" }];
  state.claims = [{ id: "所有權", status: "active" }];
  state.runs = [{ id: "執行", status: "unknown" }];
  state.authorizations = [{ id: "授權", allowed: true }];
  save(root, state);
  const preview = executeCoreCommand(root, "compact preview");
  assert.equal(preview.revision, 0);
  assert.equal(readTask(root).schemaVersion, 1);
  command(root, "migrate");
  const migrated = readTask(root);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.revision, 1);
  for (const key of ["questions", "claims", "runs", "authorizations"]) assert.deepEqual(migrated[key], state[key]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, migrated.migration.path)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, manifest.snapshot.path))), state);
  const events = aged(root);
  events.claims[0].commandId = events.events[0].commandId;
  save(root, events);
  command(root, "compact");
  assert.ok(readTask(root).events.some(event => event.id === events.events[0].id));
  for (const key of ["questions", "claims", "runs", "authorizations"]) assert.deepEqual(readTask(root)[key], events[key]);
});

test("七天內事件超門檻不強行搬移；位元組門檻與無效設定明確處理", t => {
  const { root } = setup(t);
  const state = aged(root);
  for (const event of state.events) event.recordedAt = new Date().toISOString();
  state.items = [group("工作", 0)];
  save(root, state);
  const result = command(root, "item update", { id: "工作", changes: { title: "新工作" } });
  assert.equal(result.compaction.count, 0);
  assert.equal(readTask(root).history.length, 0);
  const bytes = aged(root, 300);
  bytes.events[0].result = { text: "證".repeat(750000) };
  save(root, bytes);
  assert.equal(executeCoreCommand(root, "compact preview").triggered, true);
  command(root, "item update", { id: "工作", changes: { title: "位元組壓縮" } });
  assert.equal(readTask(root).history.length, 1);
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ history: { keepRecentEvents: 0 } }));
  assert.throws(() => command(root, "item update", { id: "工作", changes: { title: "拒絕" } }), { code: "INVALID_CONFIG" });
});

test("自動壓縮磁碟失敗不撤銷原交易，重送仍可去重", t => {
  const { root } = setup(t);
  const state = aged(root); state.items = [group("工作", 0)]; save(root, state);
  const result = command(root, "item update", { id: "工作", changes: { title: "已提交" } }, { fault(point, file) {
    if (point === "write" && path.basename(file).startsWith("snapshot")) throw Object.assign(new Error("磁碟已滿"), { code: "ENOSPC" });
  } });
  assert.match(result.compactionError, /ENOSPC/);
  assert.equal(readTask(root).items[0].title, "已提交");
  assert.equal(readTask(root).revision, state.revision + 1);
  assert.equal(readTask(root).events.length, 1002);
});

test("完成未 ack 與歷史未 ack、很舊的阻塞驗收問題及未知執行都不被收合", t => {
  const { root } = setup(t);
  const state = aged(root, 50);
  state.items = [{ ...group("已完成", 0, "done"), kind: "leaf" }, group("阻塞", 1, "blocked"), { ...group("驗收", 2, "review"), review: { reviewer: "人", revisitAt: "2020-01-01T00:00:00Z" } }];
  state.reports = [{ id: "當前證據", itemId: "已完成", ack: false, evidence: ["報告.md"] }, { id: "舊證據", itemId: "已完成", ack: false, history: true, evidence: ["舊報告.md"] }];
  state.questions = [{ id: "舊問題", status: "open" }];
  state.runs = ["busy", "unknown", "interrupted"].map(status => ({ id: status, status }));
  const graph = renderTaskGraph(state);
  for (const phrase of ["已完成 1 項", "待核對：當前證據", "歷史證據待核對：舊證據", "阻塞", "驗收", "舊問題", "busy", "unknown", "interrupted"]) assert.ok(graph.includes(phrase), phrase);
  assert.equal(graph.split("\n").filter(line => /^2020-.* r\d+ /.test(line)).length, 20);
  assert.doesNotMatch(graph, / r29 /);
  assert.match(graph, /30 筆較早事件未展開；0 筆已封存/);
});

function completedEvidence(root) {
  command(root, "item add", { id: "工作", kind: "leaf", title: "工作", order: 0, nextAction: "執行", sourceRef: "README.md", completionPolicy: [{ criterion: "通過", target: "report.md", evidenceType: "report", verifier: "human" }] });
  fs.writeFileSync(path.join(root, "report.md"), "完整報告");
  fs.mkdirSync(path.join(root, "attachments")); fs.writeFileSync(path.join(root, "attachments/proof.txt"), "完整附件");
  const report = command(root, "report submit", { itemId: "工作", outcome: "success", evidence: ["report.md", "attachments/proof.txt"], review: { reviewer: "驗收者", revisitAt: new Date(Date.now() + 86400000).toISOString(), nextAction: "核對" } }).result.id;
  command(root, "report accept", { id: report, by: "驗收者" });
  return report;
}

test("結案預設預覽、未 ack 或 unknown 拒絕，套用才搬報告附件且更新引用", t => {
  const { root } = setup(t);
  const report = completedEvidence(root);
  assert.throws(() => command(root, "close"), { code: "CLOSE_BLOCKED" });
  assert.equal(fs.readFileSync(path.join(root, "report.md"), "utf8"), "完整報告");
  command(root, "report ack", { id: report });
  const state = readTask(root); state.runs = [{ id: "執行", status: "unknown" }]; save(root, state);
  assert.throws(() => command(root, "close"), { code: "CLOSE_BLOCKED" });
  state.runs = []; save(root, state);
  const preview = executeCoreCommand(root, "close preview");
  assert.equal(preview.files.length, 2);
  assert.equal(readTask(root).revision, state.revision);
  const result = command(root, "close");
  assert.deepEqual(result.archiveErrors, []);
  assert.equal(fs.existsSync(path.join(root, "report.md")), false);
  assert.equal(fs.existsSync(path.join(root, "attachments/proof.txt")), false);
  const archived = readTask(root);
  assert.equal(fs.readFileSync(path.join(root, archived.reports[0].evidence[0]), "utf8"), "完整報告");
  assert.equal(fs.readFileSync(path.join(root, archived.reports[0].evidence[1]), "utf8"), "完整附件");
  assert.equal(archived.items[0].completionPolicy[0].target, archived.reports[0].evidence[0]);
  assert.equal(archived.reports[0].ack, true);
});

test("結案切換前失敗不刪原證據，切換後中斷可再次結案完成搬移", t => {
  const { root } = setup(t);
  const report = completedEvidence(root); command(root, "report ack", { id: report });
  const before = readTask(root);
  assert.throws(() => command(root, "close", {}, { fault(point, file) {
    if (point === "beforeRename" && path.basename(file) === "task-state.json") throw new Error("切換前中斷");
  } }), /切換前中斷/);
  assert.deepEqual(readTask(root), before);
  assert.equal(fs.readFileSync(path.join(root, "report.md"), "utf8"), "完整報告");
  assert.throws(() => command(root, "close", {}, { fault(point, file) {
    if (point === "afterRename" && path.basename(file) === "task-state.json") throw new Error("切換後中斷");
  } }), /切換後中斷/);
  assert.equal(fs.existsSync(path.join(root, "report.md")), true);
  assert.deepEqual(command(root, "close").archiveErrors, []);
  assert.equal(fs.existsSync(path.join(root, "report.md")), false);
});

test("壓縮中真正終止程序後可回收鎖，未提交 segment 不進歷史", t => {
  const { root } = setup(t);
  const before = aged(root);
  const module = new URL("../scripts/task-core-commands.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { executeCoreCommand } from ${JSON.stringify(module)};
    executeCoreCommand(${JSON.stringify(root)}, "compact", ${JSON.stringify({ commandId: randomUUID(), expectedRevision: before.revision, actor: { host: "local", id: "中斷驗收" }, data: {} })}, {
      fault(point, file) { if (point === "afterRename" && file.endsWith(".jsonl")) process.kill(process.pid, "SIGKILL"); }
    });
  `], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL");
  assert.deepEqual(readTask(root), before);
  command(root, "compact");
  assert.equal(executeCoreCommand(root, "history verify").count, 1002);
  assert.equal(readTask(root).history.length, 1);
});

test("CLI 結案預览不寫入，open 與 blocked 拒絕，歷史故障保留畫面並標未知", t => {
  const { root, env } = setup(t);
  const script = fileURLToPath(new URL("../scripts/task-list.mjs", import.meta.url));
  const state = readTask(root);
  state.items = [group("尚未處理", 0), group("仍被阻塞", 1, "blocked")]; save(root, state);
  const preview = spawnSync(process.execPath, [script, "task", "close", "--dir", root], { env, encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(JSON.parse(preview.stdout).blockers.length, 2);
  assert.equal(readTask(root).revision, state.revision);
  const refused = spawnSync(process.execPath, [script, "task", "close", "--dir", root, "--yes"], { env, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).code, "CLOSE_BLOCKED");
  aged(root); command(root, "compact");
  const current = readTask(root);
  fs.unlinkSync(path.join(root, current.history[0].manifest));
  const failed = spawnSync(process.execPath, [script, "task-todos", "--dir", root], { env, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /狀態未知/);
  assert.match(failed.stdout, /尚未處理/);
  assert.match(failed.stdout, /仍被阻塞/);
  assert.match(failed.stderr, /HISTORY_CORRUPT/);
});

test("生成路徑不得覆寫 history，結案不跟隨符號連結搬外部檔", t => {
  const { root } = setup(t);
  aged(root); command(root, "compact");
  const before = readTask(root);
  const target = before.history[0].manifest;
  const original = fs.readFileSync(path.join(root, target), "utf8");
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: target }));
  assert.equal(executeCoreCommand(root, "read").viewErrors.length, 1);
  assert.equal(fs.readFileSync(path.join(root, target), "utf8"), original);
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: "board.md" }));
  const report = completedEvidence(root); command(root, "report ack", { id: report });
  fs.unlinkSync(path.join(root, "report.md"));
  fs.symlinkSync(path.join(root, "README.md"), path.join(root, "report.md"));
  assert.throws(() => command(root, "close"), { code: "UNSAFE_PATH" });
  assert.equal(fs.lstatSync(path.join(root, "report.md")).isSymbolicLink(), true);
});

test("停用並移除已安裝插件仍保留正本、snapshot、冷歷史與證據", t => {
  const { root, env } = setup(t);
  const report = completedEvidence(root); command(root, "report ack", { id: report });
  aged(root); command(root, "compact"); command(root, "close");
  const state = readTask(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, state.history[0].manifest)));
  const files = ["task-state.json", state.history[0].manifest, manifest.snapshot.path, manifest.segment.path, ...state.reports[0].evidence];
  const original = files.map(file => fs.readFileSync(path.join(root, file)));
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  function plugin(...args) {
    const result = spawnSync("claude", ["plugin", ...args], { env, encoding: "utf8", timeout: 60000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  plugin("marketplace", "add", repo);
  plugin("install", "task-list@worktree-console");
  plugin("disable", "task-list@worktree-console");
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(root, file)), original[i]));
  plugin("uninstall", "task-list@worktree-console");
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(root, file)), original[i]));
  assert.equal(executeCoreCommand(root, "history verify").count, 1003);
});

test("v1 寫入遷移的前版備份不得被新交易連帶修改", t => {
  const { root } = setup(t);
  const old = readTask(root); old.schemaVersion = 1; delete old.history; save(root, old);
  command(root, "item add", { id: "新增", kind: "group", title: "新工作", order: 0, nextAction: "執行", sourceRef: "README.md" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".console/previous-0.json"))), old);
  assert.equal(readTask(root).items[0].id, "新增");
});

test("自訂只留一筆熱事件時，最近二十筆時間線仍跨冷歷史顯示", t => {
  const { root, env } = setup(t);
  aged(root, 30);
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ history: { keepRecentEvents: 1 } }));
  command(root, "compact");
  const script = fileURLToPath(new URL("../scripts/task-list.mjs", import.meta.url));
  const graph = spawnSync(process.execPath, [script, "task-todos", "--dir", root], { env, encoding: "utf8" });
  assert.equal(graph.status, 0, graph.stdout + graph.stderr);
  assert.equal(graph.stdout.split("\n").filter(line => /^\d{4}-.* r\d+ /.test(line)).length, 20);
  assert.match(graph.stdout, / r11 /);
  assert.doesNotMatch(graph.stdout, / r10 /);
});

test("未知指令與事件引用保留在熱資料，重複壓縮還原不重複歷史事件", t => {
  const { root } = setup(t);
  const state = aged(root);
  state.events[0].command = "擴充恢復";
  state.questions = [{ id: "問題", status: "open", eventId: state.events[1].id }];
  save(root, state);
  command(root, "compact");
  const first = readTask(root);
  assert.ok(first.events.some(event => event.id === state.events[0].id));
  assert.ok(first.events.some(event => event.id === state.events[1].id));
  command(root, "history restore", { archive: first.history[0].id });
  command(root, "compact");
  const history = executeCoreCommand(root, "history", { limit: 2000 }).events;
  assert.equal(history.length, 1004);
  assert.equal(new Set(history.map(event => event.id)).size, 1004);
  assert.equal(readTask(root).history.length, 2);
});
