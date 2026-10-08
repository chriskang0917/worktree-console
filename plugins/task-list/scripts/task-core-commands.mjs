import { randomUUID, createHash } from "node:crypto";
import { commitTask, withTaskLock, readTask, fail } from "./task-store.mjs";
import { evaluateCompletion, propagateCompletion, acceptReport, currentReport } from "./task-completion.mjs";
import { generateCoreViews } from "./task-core-generated.mjs";
import { allTaskEvents, historyPage, compactionPlan, compactState, restoreState, readCleanupConfig } from "./task-history.mjs";
import { closePlan, archiveEvidence, finishEvidenceArchive } from "./task-archive.mjs";

const text = (value, name) => { if (typeof value !== "string" || !value.trim()) fail("INVALID_COMMAND", `${name} 必須是非空字串`); return value; };
function keys(value, allowed) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_COMMAND", "指令資料必須是物件"); for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("INVALID_COMMAND", `不支援欄位：${key}`); }
function find(state, collection, id) { const row = state[collection].find((entry) => entry.id === id); if (!row) fail("NOT_FOUND", `找不到 ${collection}：${id}`); return row; }
function add(state, collection, row) { text(row.id, "id"); if (state[collection].some((entry) => entry.id === row.id)) fail("DUPLICATE_ID", "ID 已存在"); state[collection].push(row); return { id: row.id }; }
const editable = ["title", "nextAction", "waitingOn", "sourceRef", "lineId", "scheduledFor", "dueAt", "revisitAt", "blockedBy"];
export function applyTaskOperation(root, state, command, data, now) {
  switch (command) {
    case "item add": {
      keys(data, ["id", "kind", "parentId", "lineId", "title", "order", "nextAction", "waitingOn", "sourceRef", "attemptId", "specRevision", "blockedBy", "completionPolicy", "scheduledFor", "dueAt", "revisitAt"]);
      const row = { ...data, id: data.id ?? randomUUID(), status: "queued", attemptId: data.attemptId ?? randomUUID(), specRevision: data.specRevision ?? 1, blockedBy: data.blockedBy ?? [] };
      return add(state, "items", row);
    }
    case "item update": {
      keys(data, ["id", "changes"]); keys(data.changes, editable);
      const item = find(state, "items", data.id);
      if (["done", "cancelled"].includes(item.status)) fail("REOPEN_REQUIRED", "已完成或取消項目須先重開");
      Object.assign(item, data.changes);
      if (data.changes.waitingOn === null) delete item.waitingOn;
      return { id: item.id };
    }
    case "item move": {
      keys(data, ["id", "parentId", "order"]);
      const item = find(state, "items", data.id);
      if (data.parentId === null) delete item.parentId;
      else if (data.parentId !== undefined) item.parentId = data.parentId;
      item.order = data.order;
      return { id: item.id };
    }
    case "item reopen": {
      keys(data, ["id", "reason", "attemptId", "specRevision", "completionPolicy"]);
      const item = find(state, "items", data.id);
      const reason = text(data.reason, "reason");
      const previousAttemptId = item.attemptId;
      item.attemptId = data.attemptId ?? randomUUID();
      if (item.attemptId === previousAttemptId || state.reports.some((report) => report.itemId === item.id && report.attemptId === item.attemptId)) fail("REUSED_ATTEMPT", "重開不可重用 attempt");
      if (data.specRevision !== undefined) {
        if (data.specRevision <= item.specRevision) fail("SPEC_REVISION", "新規格 revision 必須增加");
        item.specRevision = data.specRevision;
      }
      if (data.completionPolicy !== undefined) {
        if (data.specRevision === undefined) fail("SPEC_REVISION", "更改條件須增加 specRevision");
        item.completionPolicy = data.completionPolicy;
      }
      item.reopened = { reason, previousAttemptId };
      item.status = "queued"; item.nextAction = "依重開理由重新執行";
      delete item.review;
      for (const report of state.reports) if (report.itemId === item.id && !currentReport(item, report)) report.history = true;
      return { id: item.id, attemptId: item.attemptId };
    }
    case "item cancel": {
      keys(data, ["id", "reason"]);
      const item = find(state, "items", data.id);
      if (item.kind === "group" && state.items.some((child) => child.parentId === item.id && !["done", "cancelled"].includes(child.status))) fail("ACTIVE_CHILDREN", "請先明確取消有效子項");
      item.cancellationReason = text(data.reason, "reason");
      item.status = "cancelled"; delete item.nextAction; delete item.review;
      return { id: item.id };
    }
    case "report accept": {
      keys(data, ["id", "by"]);
      const report = find(state, "reports", data.id);
      acceptReport(root, state, report, text(data.by, "by"), now);
      return { id: report.id };
    }
    case "report reject": {
      keys(data, ["id", "by", "reason"]);
      const report = find(state, "reports", data.id);
      const item = find(state, "items", report.itemId);
      if (report.history || !currentReport(item, report) || item.review?.reportId !== report.id || item.status !== "review") fail("NOT_REVIEW", "報告不是目前待驗收交付");
      if (text(data.by, "by") !== item.review.reviewer) fail("REVIEWER_MISMATCH", "必須由指定驗收者拒絕");
      report.acceptance = { status: "rejected", by: data.by, at: now, reason: text(data.reason, "reason") };
      item.status = "blocked"; item.nextAction = "依拒絕理由修正交付"; delete item.review;
      return { id: report.id };
    }
    case "report ack": {
      keys(data, ["id"]);
      const report = find(state, "reports", data.id); report.ack = true;
      return { id: report.id };
    }
    case "report submit": {
      keys(data, ["id", "itemId", "attemptId", "specRevision", "outcome", "evidence", "review"]);
      const item = find(state, "items", data.itemId);
      if (item.kind !== "leaf") fail("REPORT_ITEM", "報告必須指向小項");
      const report = { id: data.id ?? randomUUID(), itemId: item.id, attemptId: data.attemptId ?? item.attemptId, specRevision: data.specRevision ?? item.specRevision, outcome: data.outcome, evidence: data.evidence ?? [], ack: false, acceptance: { status: "pending" } };
      add(state, "reports", report);
      evaluateCompletion(root, item, report, now, data.review);
      return { id: report.id, history: report.history ?? false, status: item.status };
    }
    default: fail("UNKNOWN_COMMAND", "不支援的 task 指令");
  }
}
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
export function executeCoreCommand(root, command, envelope = {}, options = {}) {
  const generate = (state) => generateCoreViews(root, state, options.viewFault);
  if (["history", "history verify", "compact preview", "history restore preview", "close preview", "archive preview"].includes(command)) return withTaskLock(root, state => {
    const { history } = readCleanupConfig(root);
    if (command === "history") return historyPage(root, state, envelope);
    if (command === "history verify") return { ok: true, revision: state.revision, count: allTaskEvents(root, state).length, archives: state.history ?? [] };
    if (command === "compact preview") { const { candidates, ...plan } = compactionPlan(state, history); return { ...plan, revision: state.revision, preview: true }; }
    if (command === "history restore preview") {
      const entry = (state.history ?? []).find(entry => entry.id === envelope.archive);
      if (!entry) fail("NOT_FOUND", "找不到歷史封存");
      return { ...entry, revision: state.revision, preview: true };
    }
    return closePlan(root, state);
  });
  if (["read", "validate"].includes(command)) return withTaskLock(root, (state) => { const viewErrors = generate(state); return command === "read" ? { state, revision: state.revision, viewErrors } : { ok: true, revision: state.revision, viewErrors }; });
  keys(envelope, ["commandId", "expectedRevision", "actor", "data"]);
  keys(envelope.actor, ["host", "id"]); text(envelope.actor.host, "actor.host"); text(envelope.actor.id, "actor.id");
  const requestHash = createHash("sha256").update(JSON.stringify(canonical({ command, actor: envelope.actor, data: envelope.data }))).digest("hex");
  const transaction = { ...envelope, command, requestHash, fault: options.fault, generate, apply(state, now) {
    if (command === "compact") { keys(envelope.data, []); return compactState(root, state, readCleanupConfig(root).history, options.fault); }
    if (command === "history restore") { keys(envelope.data, ["archive"]); return restoreState(root, state, text(envelope.data.archive, "archive")); }
    if (command === "migrate") { keys(envelope.data, []); return { schemaVersion: state.schemaVersion }; }
    if (["close", "archive"].includes(command)) { keys(envelope.data, ["expectedEvidence"]); return archiveEvidence(root, state, options.fault, envelope.data.expectedEvidence); }
    const result = applyTaskOperation(root, state, command, envelope.data, now); propagateCompletion(state); return result;
  } };
  if (["close", "archive"].includes(command)) return withTaskLock(root, (_state, commit) => {
    const result = commit(transaction);
    result.archiveErrors = finishEvidenceArchive(root, readTask(root));
    return result;
  });
  return commitTask(root, transaction);
}
