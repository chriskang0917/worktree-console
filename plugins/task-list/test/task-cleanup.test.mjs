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
  if (["close", "archive"].includes(operation)) data = { expectedEvidence: executeCoreCommand(root, `${operation} preview`).evidenceSha256, ...data };
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


test("完成未 ack 與歷史未 ack、很舊的阻塞與驗收項目都不被收合", t => {
  const { root } = setup(t);
  const state = aged(root, 50);
  state.items = [{ ...group("已完成", 0, "done"), kind: "leaf" }, group("阻塞", 1, "blocked"), { ...group("驗收", 2, "review"), review: { reviewer: "人", revisitAt: "2020-01-01T00:00:00Z" } }];
  state.reports = [{ id: "當前證據", itemId: "已完成", ack: false, evidence: ["報告.md"] }, { id: "舊證據", itemId: "已完成", ack: false, history: true, evidence: ["舊報告.md"] }];
  const graph = renderTaskGraph(state);
  for (const phrase of ["已完成 1 項", "待核對：當前證據", "歷史證據待核對：舊證據", "阻塞", "驗收"]) assert.ok(graph.includes(phrase), phrase);
  assert.equal(graph.split("\n").filter(line => /^2020-.* r\d+ /.test(line)).length, 20);
  assert.doesNotMatch(graph, / r29 /);
  assert.match(graph, /30 筆較早事件未展開/);
});

function completedEvidence(root) {
  command(root, "item add", { id: "工作", kind: "leaf", title: "工作", order: 0, nextAction: "執行", sourceRef: "README.md", completionPolicy: [{ criterion: "通過", target: "report.md", evidenceType: "report", verifier: "human" }] });
  fs.writeFileSync(path.join(root, "report.md"), "完整報告");
  fs.mkdirSync(path.join(root, "attachments")); fs.writeFileSync(path.join(root, "attachments/proof.txt"), "完整附件");
  const report = command(root, "report submit", { itemId: "工作", outcome: "success", evidence: ["report.md", "attachments/proof.txt"], review: { reviewer: "驗收者", revisitAt: new Date(Date.now() + 86400000).toISOString(), nextAction: "核對" } }).result.id;
  command(root, "report accept", { id: report, by: "驗收者" });
  return report;
}

test("結案預設預覽、未 ack 拒絕，套用才搬報告附件且更新引用", t => {
  const { root } = setup(t);
  const report = completedEvidence(root);
  assert.throws(() => command(root, "close"), { code: "CLOSE_BLOCKED" });
  assert.equal(fs.readFileSync(path.join(root, "report.md"), "utf8"), "完整報告");
  command(root, "report ack", { id: report });
  const state = readTask(root);
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


test("CLI 結案預覽不寫入，open 與 blocked 拒絕", t => {
  const { root, env } = setup(t);
  const script = fileURLToPath(new URL("../scripts/task-list.mjs", import.meta.url));
  const state = readTask(root);
  state.items = [group("尚未處理", 0), group("仍被阻塞", 1, "blocked")]; save(root, state);
  const preview = spawnSync(process.execPath, [script, "task", "close", "--dir", root], { env, encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(JSON.parse(preview.stdout).blockers.length, 2);
  assert.equal(readTask(root).revision, state.revision);
  const plan = JSON.parse(preview.stdout);
  const refused = spawnSync(process.execPath, [script, "task", "close", "--dir", root, ...plan.applyArgs.split(" ")], { env, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).code, "CLOSE_BLOCKED");
});

test("生成路徑不得覆寫 history，結案不跟隨符號連結搬外部檔", t => {
  const { root } = setup(t);
  const target = "history/task-list/證據/proof.md";
  fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
  fs.writeFileSync(path.join(root, target), "封存證據");
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

test("看板碰撞登錄報告或任務控制路徑時讀取與重建不改證據", t => {
  const { root } = setup(t);
  completedEvidence(root);
  const bytes = fs.readFileSync(path.join(root, "report.md"));
  for (const boardPath of ["report.md", ".console/previous-0.json"]) {
    fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath }));
    for (const operation of ["read", "validate"]) {
      assert.match(executeCoreCommand(root, operation).viewErrors[0], /BOARD_PATH_COLLISION/);
      assert.deepEqual(fs.readFileSync(path.join(root, "report.md")), bytes);
    }
  }
});

test("兩個完成群組的未核對子項各自保留所屬標題", t => {
  const { root } = setup(t);
  const state = readTask(root);
  state.items = [group("第一組", 0, "done"), { ...group("第一子項", 0, "done"), kind: "leaf", parentId: "第一組" }, group("第二組", 1, "done"), { ...group("第二子項", 0, "done"), kind: "leaf", parentId: "第二組" }];
  state.reports = ["第一子項", "第二子項"].map(itemId => ({ id: itemId, itemId, ack: false, evidence: [] }));
  const graph = renderTaskGraph(state);
  assert.match(graph, /✓ 第一組 1\/1[^\n]*\n╰─ ✓ 第一子項 ★[^\n]*\n\n✓ 第二組 1\/1[^\n]*\n╰─ ✓ 第二子項 ★/);
});

for (const operation of ["close", "archive"]) test(`${operation} 套用綁定預覽版本與證據清單摘要，未變更才搬移`, t => {
  const { root, env } = setup(t);
  const report = completedEvidence(root);
  command(root, "report ack", { id: report });
  const script = fileURLToPath(new URL("../scripts/task-list.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, "task", operation, "--dir", root, ...args], { env, encoding: "utf8" });
  const preview = JSON.parse(run().stdout);
  const missing = run("--yes");
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).code, "REVISION_REQUIRED");
  fs.writeFileSync(path.join(root, "extra.md"), "新增證據");
  const current = readTask(root);
  command(root, "report submit", { itemId: "工作", attemptId: current.items[0].attemptId, specRevision: current.items[0].specRevision, outcome: "success", evidence: ["extra.md"], review: { reviewer: "驗收者", revisitAt: new Date(Date.now() + 86400000).toISOString(), nextAction: "核對" } });
  const stale = run(...preview.applyArgs.split(" "));
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).code, "REVISION_CONFLICT");
  assert.equal(fs.readFileSync(path.join(root, "report.md"), "utf8"), "完整報告");
  assert.equal(fs.readFileSync(path.join(root, "extra.md"), "utf8"), "新增證據");
  assert.equal(fs.existsSync(path.join(root, "history/task-list")), false);
  command(root, "report ack", { id: readTask(root).reports.at(-1).id });
  const approved = JSON.parse(run().stdout);
  const sameRevision = readTask(root);
  fs.writeFileSync(path.join(root, "other.md"), "額外附件");
  sameRevision.reports[0].evidence.push("other.md");
  save(root, sameRevision);
  const changedList = run(...approved.applyArgs.split(" "));
  assert.equal(changedList.status, 1);
  assert.equal(JSON.parse(changedList.stdout).code, "EVIDENCE_CHANGED");
  assert.equal(fs.existsSync(path.join(root, "history/task-list")), false);
  sameRevision.reports[0].evidence.pop();
  save(root, sameRevision);
  fs.writeFileSync(path.join(root, "report.md"), "變更內容");
  const changed = run(...approved.applyArgs.split(" "));
  assert.equal(changed.status, 1);
  assert.equal(JSON.parse(changed.stdout).code, "EVIDENCE_CHANGED");
  assert.equal(fs.existsSync(path.join(root, "history/task-list")), false);
  fs.writeFileSync(path.join(root, "report.md"), "完整報告");
  const applied = run(...approved.applyArgs.split(" "));
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(fs.existsSync(path.join(root, "report.md")), false);
  assert.equal(fs.existsSync(path.join(root, "extra.md")), false);
  const archived = readTask(root);
  assert.equal(fs.readFileSync(path.join(root, archived.reports[0].evidence[0]), "utf8"), "完整報告");
});

for (const evidence of ["npm test passed", "npm test passed / 12 tests passed", "npm test passed // all checks passed", "npm test passed \\ all checks passed"]) test(`文字證據「${evidence}」驗收並核對後可結案，引用保持不變`, t => {
  const { root } = setup(t);
  command(root, "item add", { id: "工作", kind: "leaf", title: "工作", order: 0, nextAction: "執行", sourceRef: "README.md", completionPolicy: [{ criterion: "通過", target: "測試結果", evidenceType: "report", verifier: "human" }] });
  const report = command(root, "report submit", { itemId: "工作", outcome: "success", evidence: [evidence], review: { reviewer: "驗收者", revisitAt: new Date(Date.now() + 86400000).toISOString(), nextAction: "核對" } }).result.id;
  command(root, "report accept", { id: report, by: "驗收者" });
  command(root, "report ack", { id: report });
  const preview = executeCoreCommand(root, "close preview");
  assert.deepEqual(preview.files, []);
  command(root, "close");
  assert.deepEqual(readTask(root).reports[0].evidence, [evidence]);
  assert.equal(readTask(root).items[0].status, "done");
});

test("重開前的文字證據不阻擋新報告結案，兩份證據均保留", t => {
  const { root } = setup(t);
  command(root, "item add", { id: "工作", kind: "leaf", title: "工作", order: 0, nextAction: "執行", sourceRef: "README.md", completionPolicy: [{ criterion: "通過", target: "測試結果", evidenceType: "report", verifier: "human" }] });
  const submit = evidence => command(root, "report submit", { itemId: "工作", outcome: "success", evidence: [evidence], review: { reviewer: "驗收者", revisitAt: new Date(Date.now() + 86400000).toISOString(), nextAction: "核對" } }).result.id;
  const first = submit("npm test passed // all checks passed");
  command(root, "report accept", { id: first, by: "驗收者" });
  command(root, "report ack", { id: first });
  command(root, "item reopen", { id: "工作", reason: "補驗收" });
  const second = submit("補驗收通過");
  command(root, "report accept", { id: second, by: "驗收者" });
  command(root, "report ack", { id: second });
  command(root, "close");
  const state = readTask(root);
  assert.equal(state.reports[0].history, true);
  assert.deepEqual(state.reports.map(report => report.evidence), [["npm test passed // all checks passed"], ["補驗收通過"]]);
  assert.equal(state.items[0].status, "done");
});

test("文字證據略過不放行真實 symlink 或任務外檔案", t => {
  const { root } = setup(t);
  const report = completedEvidence(root);
  command(root, "report ack", { id: report });
  const outside = path.join(path.dirname(root), "外部證據.txt");
  fs.writeFileSync(outside, "不可搬移的外部證據");
  fs.symlinkSync(outside, path.join(root, "連結證據.txt"));
  fs.symlinkSync(path.join(root, "不存在.txt"), path.join(root, "失效連結.txt"));
  for (const ref of ["連結證據.txt", "失效連結.txt", "../外部證據.txt", outside]) {
    const state = readTask(root);
    state.reports[0].evidence = ["npm test passed // all checks passed", ref];
    save(root, state);
    assert.throws(() => executeCoreCommand(root, "close preview"), error => error.code === "UNSAFE_PATH" && error.message.includes(ref), ref);
    assert.equal(fs.readFileSync(outside, "utf8"), "不可搬移的外部證據");
    assert.equal(fs.existsSync(path.join(root, "history/task-list")), false);
  }
});

test("真實證據含冒號檔名仍綁定摘要，控制檔與自訂 board 路徑不能搬移，URI 保留", t => {
  const { root } = setup(t);
  const report = completedEvidence(root);
  command(root, "report ack", { id: report });
  fs.writeFileSync(path.join(root, "attachments/proof:結果.txt"), "原始內容");
  const state = readTask(root);
  state.reports[0].evidence.push("npm test passed", "attachments/proof:結果.txt", "https://example.com/evidence");
  save(root, state);
  const plan = executeCoreCommand(root, "close preview");
  assert.ok(plan.files.some(file => file.source === "attachments/proof:結果.txt"));
  fs.writeFileSync(path.join(root, "attachments/proof:結果.txt"), "改變內容");
  assert.throws(() => command(root, "close", { expectedEvidence: plan.evidenceSha256 }), { code: "EVIDENCE_CHANGED" });
  assert.equal(fs.readFileSync(path.join(root, "report.md"), "utf8"), "完整報告");
  for (const protectedFile of ["README.md", "task-state.json", "board.md", ".console/config.json", "custom-board.md"]) {
    fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: "custom-board.md" }));
    if (protectedFile === "custom-board.md") fs.writeFileSync(path.join(root, protectedFile), "生成看板");
    state.reports[0].evidence = [protectedFile, "npm test passed"];
    save(root, state);
    assert.throws(() => executeCoreCommand(root, "close preview"), { code: "UNSAFE_ARCHIVE" });
  }
  state.reports[0].evidence = ["attachments/proof:結果.txt", "https://example.com/evidence", "npm test passed"];
  save(root, state);
  command(root, "close");
  const references = readTask(root).reports[0].evidence;
  assert.equal(fs.readFileSync(path.join(root, references[0]), "utf8"), "改變內容");
  assert.deepEqual(references.slice(1), ["https://example.com/evidence", "npm test passed"]);
});

test("真實 URI 保留原引用，即使 URI 可對應同名本機檔也不搬移", t => {
  const { root } = setup(t);
  const report = completedEvidence(root);
  command(root, "report ack", { id: report });
  const refs = ["https://example.com/proof.txt", "mailto:reviewer@example.com", "urn:example:proof"];
  const local = path.resolve(root, refs[0]);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, "URI 不可搬移的同名本機檔");
  const state = readTask(root);
  state.reports[0].evidence = refs;
  save(root, state);
  assert.deepEqual(executeCoreCommand(root, "close preview").files, []);
  command(root, "close");
  assert.deepEqual(readTask(root).reports[0].evidence, refs);
  assert.equal(fs.readFileSync(local, "utf8"), "URI 不可搬移的同名本機檔");
});

test("根目錄冒號證據列入結案預覽、綁定內容摘要並封存", t => {
  const { root } = setup(t);
  const report = completedEvidence(root);
  command(root, "report ack", { id: report });
  const ref = "proof:結果.txt";
  fs.writeFileSync(path.join(root, ref), "原始冒號證據");
  const state = readTask(root);
  state.reports[0].evidence.push(ref);
  save(root, state);
  const preview = executeCoreCommand(root, "close preview");
  assert.ok(preview.files.some(file => file.source === ref));
  fs.writeFileSync(path.join(root, ref), "更新冒號證據");
  assert.throws(() => command(root, "close", { expectedEvidence: preview.evidenceSha256 }), { code: "EVIDENCE_CHANGED" });
  command(root, "close");
  const archivedRef = readTask(root).reports[0].evidence.at(-1);
  assert.match(archivedRef, /^history\/task-list\/.*\/evidence\/proof:結果\.txt$/);
  assert.equal(fs.readFileSync(path.join(root, archivedRef), "utf8"), "更新冒號證據");
  assert.equal(fs.existsSync(path.join(root, ref)), false);
});

test("自訂看板不可覆寫已登錄的根目錄冒號證據", t => {
  const { root } = setup(t);
  completedEvidence(root);
  const ref = "proof:結果.txt";
  fs.writeFileSync(path.join(root, ref), "不可覆寫的冒號證據");
  const state = readTask(root);
  state.reports[0].evidence.push(ref);
  save(root, state);
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: ref }));
  for (const operation of ["read", "validate"]) {
    assert.match(executeCoreCommand(root, operation).viewErrors[0], /BOARD_PATH_COLLISION/);
    assert.equal(fs.readFileSync(path.join(root, ref), "utf8"), "不可覆寫的冒號證據");
  }
});

test("結案預覽後刪除證據，確認回傳 EVIDENCE_CHANGED 且不搬其餘檔案", t => {
  const { root, env } = setup(t);
  const report = completedEvidence(root);
  command(root, "report ack", { id: report });
  const script = fileURLToPath(new URL("../scripts/task-list.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, "task", "close", "--dir", root, ...args], { env, encoding: "utf8" });
  const preview = run();
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const plan = JSON.parse(preview.stdout);
  const before = readTask(root);
  fs.unlinkSync(path.join(root, "report.md"));
  const confirmed = run(...plan.applyArgs.split(" "));
  assert.equal(confirmed.status, 1);
  assert.equal(JSON.parse(confirmed.stdout).code, "EVIDENCE_CHANGED");
  assert.deepEqual(readTask(root), before);
  assert.equal(fs.readFileSync(path.join(root, "attachments/proof.txt"), "utf8"), "完整附件");
  assert.equal(fs.existsSync(path.join(root, "history/task-list")), false);
});

for (const failure of ["missing", "failed"]) test(`ps ${failure} 時 task-new 安全停止並只回傳一個明確需求訊息`, t => {
  const { env } = setup(t);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "task-ps-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  if (failure === "failed") {
    const executable = path.join(bin, "ps");
    fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stderr.write("模擬 ps 失敗\\n"); process.exit(1);\n`);
    fs.chmodSync(executable, 0o755);
  }
  const script = fileURLToPath(new URL("../scripts/task-list.mjs", import.meta.url));
  const tasks = path.join(bin, "tasks");
  const result = spawnSync(process.execPath, [script, "task-new", "程序身分驗收"], { env: { ...env, PATH: bin, WORKTREE_CONSOLE_TASKS_DIR: tasks }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const error = JSON.parse(result.stdout);
  assert.equal(error.code, "LOCK_IDENTITY");
  assert.match(error.message, /macOS／Linux.*ps -p <pid> -o lstart=.*安全停止/);
  const roots = fs.readdirSync(tasks);
  assert.ok(roots.every(root => !fs.existsSync(path.join(tasks, root, "task-state.json"))));
});

function addLeaf(root, id = "工作") {
  command(root, "item add", { id, kind: "leaf", title: id, order: 0, nextAction: "執行", sourceRef: "README.md", completionPolicy: [{ criterion: "通過", target: "測試結果", evidenceType: "report", verifier: "human" }] });
}
function submit(root, evidence) {
  return command(root, "report submit", { itemId: "工作", outcome: "success", evidence, review: { reviewer: "驗收者", revisitAt: new Date(Date.now() + 86400000).toISOString(), nextAction: "核對" } }).result.id;
}
function settle(root, report) {
  command(root, "report accept", { id: report, by: "驗收者" });
  command(root, "report ack", { id: report });
}

test("冒號開頭的長文字證據不會讓任何指令失敗，之後仍可結案", t => {
  const { root, env } = setup(t);
  const script = fileURLToPath(new URL("../scripts/task-list.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args, "--dir", root], { env, encoding: "utf8" });
  const ok = (...args) => { const result = run(...args); assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`); return result; };
  ok("task", "item", "add", "--id", "工作", "--title", "工作", "--criterion", "通過");
  const submitted = JSON.parse(ok("task", "report", "submit", "--item", "工作", "--reviewer", "驗收者", "--evidence", `note: ${"a".repeat(300)}`).stdout);
  ok("task", "read"); ok("task", "validate"); ok("task-todos");
  ok("task", "item", "add", "--id", "另一項", "--title", "另一項", "--criterion", "通過");
  ok("task", "report", "accept", "--id", submitted.result.id, "--by", "驗收者");
  ok("task", "report", "ack", "--id", submitted.result.id);
  const preview = JSON.parse(ok("task", "close").stdout);
  assert.deepEqual(preview.files, []);
  ok("task", "item", "reopen", "--id", "工作", "--reason", "補驗收");
});

for (const [name, evidence] of [["300 字元的單一路徑段", "a".repeat(300)], ["含 NUL 字元", "結果\u0000通過"]]) test(`文字證據（${name}）可結案，重開前的舊報告也不阻擋`, t => {
  const { root } = setup(t);
  addLeaf(root);
  settle(root, submit(root, [evidence]));
  command(root, "item reopen", { id: "工作", reason: "補驗收" });
  settle(root, submit(root, ["補驗收通過"]));
  assert.deepEqual(executeCoreCommand(root, "close preview").files, []);
  command(root, "close");
  assert.deepEqual(readTask(root).reports.map(report => report.evidence), [[evidence], ["補驗收通過"]]);
  assert.equal(readTask(root).items[0].status, "done");
});

test("已登錄但尚未存在的冒號證據仍擋住同名看板路徑", t => {
  const { root } = setup(t);
  addLeaf(root);
  submit(root, ["proof:r.txt"]);
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: "proof:r.txt" }));
  for (const operation of ["read", "validate"]) assert.match(executeCoreCommand(root, operation).viewErrors[0], /BOARD_PATH_COLLISION/);
  assert.equal(fs.existsSync(path.join(root, "proof:r.txt")), false);
});

test("提交時拒絕永遠無法封存的既有檔案引用，文字、URL、缺檔與任務內檔案照常接受", t => {
  const { root, env } = setup(t);
  addLeaf(root);
  fs.writeFileSync(path.join(root, "report.md"), "報告");
  fs.mkdirSync(path.join(root, "attachments"));
  fs.writeFileSync(path.join(root, "attachments/proof.txt"), "附件");
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: "custom-board.md" }));
  fs.writeFileSync(path.join(root, "custom-board.md"), "看板");
  const outside = path.join(path.dirname(root), "外部證據.txt");
  fs.writeFileSync(outside, "外部");
  fs.symlinkSync(outside, path.join(root, "連結.txt"));
  const rejected = ["./report.md", path.join(root, "report.md"), outside, "../外部證據.txt", "連結.txt", "attachments", "README.md", "task-state.json", "board.md", ".console/config.json", "custom-board.md"];
  const before = readTask(root);
  for (const ref of rejected) {
    assert.throws(() => submit(root, ["npm test passed", ref]), error => error.code === "INVALID_EVIDENCE" && /文字.*URL.*相對路徑.*report\.md.*不加 \.\/.*不用絕對路徑/.test(error.message), ref);
    assert.deepEqual(readTask(root), before, ref);
  }
  const script = fileURLToPath(new URL("../scripts/task-list.mjs", import.meta.url));
  const file = path.join(path.dirname(root), "envelope.json");
  fs.writeFileSync(file, JSON.stringify({ commandId: randomUUID(), expectedRevision: before.revision, actor: { host: "local", id: "x" }, data: { itemId: "工作", outcome: "success", evidence: ["README.md"] } }));
  const viaFile = spawnSync(process.execPath, [script, "task", "report", "submit", "--dir", root, "--file", file], { env, encoding: "utf8" });
  assert.equal(viaFile.status, 1);
  assert.equal(JSON.parse(viaFile.stdout).code, "INVALID_EVIDENCE");
  assert.deepEqual(readTask(root), before);
  const report = submit(root, ["npm test passed", "https://example.com/r", "missing.txt", "report.md", "attachments/proof.txt"]);
  settle(root, report);
  assert.deepEqual(executeCoreCommand(root, "close preview").files.map(entry => entry.source), ["attachments/proof.txt", "report.md"]);
  command(root, "close");
});

test("控制檔、看板與 history 的保護在不分大小寫的檔案系統上也成立", t => {
  const { root } = setup(t);
  fs.writeFileSync(path.join(root, "PROBE.txt"), "");
  if (!fs.existsSync(path.join(root, "probe.txt"))) return t.skip("此檔案系統區分大小寫，無法建立大小寫別名");
  addLeaf(root);
  settle(root, submit(root, ["npm test passed"]));
  fs.writeFileSync(path.join(root, ".console/config.json"), JSON.stringify({ boardPath: "custom-board.md" }));
  fs.writeFileSync(path.join(root, "custom-board.md"), "看板");
  const archived = "history/task-list/舊/evidence/a.txt";
  fs.mkdirSync(path.dirname(path.join(root, archived)), { recursive: true });
  fs.writeFileSync(path.join(root, archived), "已封存");
  const state = readTask(root);
  for (const ref of [".Console/config.json", ".CONSOLE/previous-0.json", "Custom-Board.md", "readme.MD"]) {
    state.reports[0].evidence = [ref];
    save(root, state);
    assert.throws(() => executeCoreCommand(root, "close preview"), { code: "UNSAFE_ARCHIVE" }, ref);
    assert.throws(() => submit(root, [ref]), { code: "INVALID_EVIDENCE" }, ref);
  }
  state.reports[0].evidence = [`History/${archived.slice(8)}`];
  save(root, state);
  assert.deepEqual(executeCoreCommand(root, "close preview").files, []);
  command(root, "close");
  assert.equal(fs.readFileSync(path.join(root, archived), "utf8"), "已封存");
  assert.equal(fs.readFileSync(path.join(root, ".console/config.json"), "utf8").includes("custom-board.md"), true);
});

test("非字串或空的證據項目由 schema 回報，而不是原生錯誤或 INVALID_EVIDENCE", t => {
  const { root } = setup(t);
  addLeaf(root);
  for (const evidence of [[123], [null], [""]]) assert.throws(() => submit(root, evidence), error => error.code === "INVALID_STATE" && /evidence/.test(error.message), JSON.stringify(evidence));
});

test("decisions.md 與 policy.md 是一般證據檔，可提交並封存", t => {
  const { root } = setup(t);
  addLeaf(root);
  for (const name of ["decisions.md", "policy.md"]) fs.writeFileSync(path.join(root, name), name);
  settle(root, submit(root, ["decisions.md", "policy.md"]));
  assert.deepEqual(executeCoreCommand(root, "close preview").files.map(entry => entry.source), ["decisions.md", "policy.md"]);
  command(root, "close");
  assert.equal(fs.existsSync(path.join(root, "decisions.md")), false);
  assert.ok(readTask(root).reports[0].evidence.every(ref => ref.startsWith("history/task-list/")));
});

test("區分大小寫的檔案系統上，History、.Console、Readme.md 與 BOARD.md 都是一般檔案", t => {
  const { root } = setup(t);
  fs.writeFileSync(path.join(root, "PROBE.txt"), "");
  if (fs.existsSync(path.join(root, "probe.txt"))) return t.skip("此檔案系統不分大小寫，History 等名稱會是控制路徑的別名");
  addLeaf(root);
  const refs = ["History/notes.md", ".Console/log.txt", "Readme.md", "BOARD.md"];
  for (const ref of refs) {
    fs.mkdirSync(path.dirname(path.join(root, ref)), { recursive: true });
    fs.writeFileSync(path.join(root, ref), ref);
  }
  settle(root, submit(root, refs));
  assert.deepEqual(executeCoreCommand(root, "close preview").files.map(entry => entry.source), [...refs].sort((a, b) => a.localeCompare(b)));
  command(root, "close");
  for (const ref of refs) assert.equal(fs.existsSync(path.join(root, ref)), false, ref);
});
