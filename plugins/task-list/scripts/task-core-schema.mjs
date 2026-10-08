import { displayWidth } from "./display-width.mjs";

export const SCHEMA_VERSION = 2;
export const ITEM_STATUSES = Object.freeze(["queued", "doing", "waiting", "blocked", "parked", "review", "done", "cancelled"]);
export const ITEM_KINDS = Object.freeze(["group", "leaf"]);

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const collections = ["items", "reports", "events"];

function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function datetime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  return !!match && dateOnly(match[1]) && +match[2] < 24 && +match[3] < 60 && +match[4] < 60
    && (match[5] === "Z" || (+match[6] <= 14 && +match[7] < 60 && (+match[6] !== 14 || +match[7] === 0)))
    && Number.isFinite(Date.parse(value));
}

/** Validate a JSON task snapshot without mutating it. Paths use JSONPath notation. */
export function validateTaskState(state, { validateFields = () => {}, displayLimit = () => Infinity, extraCollections = [] } = {}) {
  const errors = [];
  const error = (path, code, message) => errors.push({ path, code, message });
  const requireValue = (value, path, predicate, message) => {
    if (!predicate(value)) error(path, value === undefined ? "required" : "invalid_value", message);
  };
  const string = (value, path) => requireValue(value, path, text, "必須是非空字串");
  const displayText = (value, path) => {
    string(value, path);
    if (typeof value !== "string") return;
    if (/[\p{Cc}\p{Zl}\p{Zp}\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) {
      error(path, "invalid_display_text", "必須是單行文字，不可含換行、tab、ANSI 或控制字元");
      return;
    }
    const width = displayWidth(value);
    const limit = displayLimit(path);
    if (width > limit) error(path, "display_width_exceeded", `${width} 格，最多 ${limit} 格；請縮短名稱，細節移到證據。`);
  };
  const number = (value, path) => requireValue(value, path, integer, "必須是非負安全整數");
  const time = (value, path) => requireValue(value, path, datetime, "必須是含時區位移的有效日期時間");
  const enumValue = (value, path, values) => requireValue(value, path, (v) => values.includes(v), `必須是 ${values.join(" / ")}`);
  const record = (value, path) => {
    requireValue(value, path, object, "必須是物件");
    return object(value);
  };
  const array = (value, path) => {
    requireValue(value, path, Array.isArray, "必須是陣列");
    return Array.isArray(value) ? value : [];
  };
  const strings = (value, path) => array(value, path).forEach((v, i) => string(v, `${path}[${i}]`));
  const identity = (value, path) => {
    if (!record(value, path)) return;
    string(value.host, `${path}.host`);
    string(value.id, `${path}.id`);
  };
  if (!record(state, "$")) return { ok: false, errors };
  if (state.schemaVersion !== SCHEMA_VERSION) error("$.schemaVersion", "unknown_schema_version", "未知 schemaVersion，拒絕寫入");
  for (const key of ["taskId", "timezone"]) string(state[key], `$.${key}`);
  displayText(state.title, "$.title");
  number(state.revision, "$.revision");
  time(state.createdAt, "$.createdAt");
  time(state.updatedAt, "$.updatedAt");
  if (datetime(state.createdAt) && datetime(state.updatedAt) && Date.parse(state.updatedAt) < Date.parse(state.createdAt)) {
    error("$.updatedAt", "time_order", "更新時間不可早於建立時間");
  }
  if (text(state.timezone)) {
    try { new Intl.DateTimeFormat("en", { timeZone: state.timezone }); }
    catch { error("$.timezone", "invalid_timezone", "必須是有效的任務時區"); }
  }
  array(state.history, "$.history").forEach((entry, i) => {
    const p = `$.history[${i}]`;
    if (!record(entry, p)) return;
    string(entry.id, `${p}.id`);
    string(entry.manifest, `${p}.manifest`);
    requireValue(entry.sha256, `${p}.sha256`, value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "必須是 SHA-256 摘要");
    number(entry.count, `${p}.count`);
    if (entry.restored !== undefined) requireValue(entry.restored, `${p}.restored`, value => typeof value === "boolean", "必須是布林值");
  });
  if (state.evidenceArchives !== undefined) array(state.evidenceArchives, "$.evidenceArchives").forEach((entry, i) => {
    const p = `$.evidenceArchives[${i}]`;
    if (!record(entry, p)) return;
    string(entry.id, `${p}.id`);
    array(entry.files, `${p}.files`).forEach((file, j) => {
      const f = `${p}.files[${j}]`;
      if (!record(file, f)) return;
      string(file.source, `${f}.source`);
      requireValue(file.destination, `${f}.destination`, value => text(file.source) && value === `history/task-list/${entry.id}/evidence/${file.source}`, "封存位置必須符合證據對照");
      requireValue(file.sha256, `${f}.sha256`, value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "必須是 SHA-256 摘要");
    });
  });

  const rows = {};
  const indexes = {};
  for (const name of [...collections, ...extraCollections]) {
    rows[name] = array(state[name], `$.${name}`);
    indexes[name] = new Map();
    rows[name].forEach((row, i) => {
      const path = `$.${name}[${i}]`;
      if (!record(row, path)) return;
      string(row.id, `${path}.id`);
      if (!text(row.id)) return;
      if (indexes[name].has(row.id)) error(`${path}.id`, "duplicate_id", "同類實體 ID 不可重複");
      else indexes[name].set(row.id, row);
    });
  }
  const reference = (value, path, name) => {
    string(value, path);
    if (text(value) && !indexes[name].has(value)) error(path, "missing_reference", `找不到 ${name} 引用`);
  };
  const references = (value, path, name) => {
    const seen = new Set();
    array(value, path).forEach((v, i) => {
      reference(v, `${path}[${i}]`, name);
      if (seen.has(v)) error(`${path}[${i}]`, "duplicate_reference", "引用不可重複");
      seen.add(v);
    });
  };
  const each = (name, fn) => rows[name].forEach((row, i) => {
    if (object(row)) fn(row, `$.${name}[${i}]`);
  });
  const orders = new Map();
  each("items", (item, path) => {
    enumValue(item.kind, `${path}.kind`, ITEM_KINDS);
    enumValue(item.status, `${path}.status`, ITEM_STATUSES);
    for (const key of ["sourceRef", "attemptId"]) string(item[key], `${path}.${key}`);
    displayText(item.title, `${path}.title`);
    if (item.nextAction !== undefined || !["done", "cancelled"].includes(item.status)) displayText(item.nextAction, `${path}.nextAction`);
    if (item.waitingOn !== undefined) displayText(item.waitingOn, `${path}.waitingOn`);
    number(item.specRevision, `${path}.specRevision`);
    number(item.order, `${path}.order`);
    if (item.parentId !== undefined) {
      reference(item.parentId, `${path}.parentId`, "items");
      const parent = indexes.items.get(item.parentId);
      if (item.kind !== "leaf" || (parent && (parent.kind !== "group" || parent.parentId !== undefined))) {
        error(`${path}.parentId`, "invalid_hierarchy", "僅允許根層 group 與其 leaf 子項");
      }
    }
    if (integer(item.order)) {
      const parentKey = item.parentId ?? null;
      if (!orders.has(parentKey)) orders.set(parentKey, new Set());
      if (orders.get(parentKey).has(item.order)) error(`${path}.order`, "duplicate_order", "同層順序不可重複");
      orders.get(parentKey).add(item.order);
    }
    if (item.blockedBy !== undefined) references(item.blockedBy, `${path}.blockedBy`, "items");
    if (item.scheduledFor !== undefined) requireValue(item.scheduledFor, `${path}.scheduledFor`, dateOnly, "必須是任務時區的有效 YYYY-MM-DD 日期");
    for (const key of ["dueAt", "revisitAt"]) if (item[key] !== undefined) time(item[key], `${path}.${key}`);
    if (item.status === "cancelled" || item.cancellationReason !== undefined) string(item.cancellationReason, `${path}.cancellationReason`);
    if (item.reopened !== undefined && record(item.reopened, `${path}.reopened`)) {
      string(item.reopened.reason, `${path}.reopened.reason`);
      string(item.reopened.previousAttemptId, `${path}.reopened.previousAttemptId`);
      if (text(item.attemptId) && item.attemptId === item.reopened.previousAttemptId) error(`${path}.attemptId`, "reused_attempt", "重開必須使用新的 attemptId");
    }
    if (item.status === "review" || item.review !== undefined) {
      if (record(item.review, `${path}.review`)) {
        string(item.review.reviewer, `${path}.review.reviewer`);
        displayText(item.review.nextAction, `${path}.review.nextAction`);
        for (const key of ["requestedAt", "revisitAt"]) time(item.review[key], `${path}.review.${key}`);
      }
    }
    if (item.kind === "leaf") {
      const policy = array(item.completionPolicy, `${path}.completionPolicy`);
      if (Array.isArray(item.completionPolicy) && !policy.length) error(`${path}.completionPolicy`, "empty_policy", "小項至少需要一個完成條件");
      policy.forEach((criterion, i) => {
        const p = `${path}.completionPolicy[${i}]`;
        if (record(criterion, p)) for (const key of ["criterion", "target", "evidenceType", "verifier"]) string(criterion[key], `${p}.${key}`);
        if (object(criterion) && criterion.verifier === "sha256") {
          enumValue(criterion.evidenceType, `${p}.evidenceType`, ["file"]);
          requireValue(criterion.expectedSha256, `${p}.expectedSha256`, (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v), "必須是 SHA-256 小寫十六進位摘要");
        }
      });
    }
  });

  // Iterative DFS avoids stack overflow on long malformed dependency chains.
  const cycles = (key, code) => {
    const colors = new Map();
    const edges = (item) => key === "parentId" ? (text(item.parentId) ? [item.parentId] : [])
      : (Array.isArray(item[key]) ? item[key].filter(text) : []);
    for (const [id, item] of indexes.items) {
      if (colors.has(id)) continue;
      colors.set(id, 1);
      const stack = [{ id, edges: edges(item), cursor: 0 }];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.cursor === frame.edges.length) { colors.set(frame.id, 2); stack.pop(); continue; }
        const next = frame.edges[frame.cursor++];
        if (!indexes.items.has(next)) continue;
        if (colors.get(next) === 1) error(`$.items[${rows.items.indexOf(indexes.items.get(frame.id))}].${key}`, code, "引用形成循環");
        else if (!colors.has(next)) {
          colors.set(next, 1);
          stack.push({ id: next, edges: edges(indexes.items.get(next)), cursor: 0 });
        }
      }
    }
  };
  cycles("parentId", "hierarchy_cycle");
  cycles("blockedBy", "blocked_by_cycle");

  each("reports", (report, path) => {
    reference(report.itemId, `${path}.itemId`, "items");
    string(report.attemptId, `${path}.attemptId`);
    displayText(report.outcome, `${path}.outcome`);
    number(report.specRevision, `${path}.specRevision`);
    strings(report.evidence, `${path}.evidence`);
    requireValue(report.ack, `${path}.ack`, (v) => typeof v === "boolean", "必須明示是否已核對");
    if (report.history !== undefined) requireValue(report.history, `${path}.history`, (v) => typeof v === "boolean", "必須是布林值");
    const item = indexes.items.get(report.itemId);
    if (item && report.history !== true) {
      if (report.attemptId !== item.attemptId) error(`${path}.attemptId`, "attempt_mismatch", "舊 attempt 報告必須標記 history");
      if (report.specRevision !== item.specRevision) error(`${path}.specRevision`, "spec_mismatch", "舊規格報告必須標記 history");
    }
    if (record(report.acceptance, `${path}.acceptance`)) {
      enumValue(report.acceptance.status, `${path}.acceptance.status`, ["pending", "accepted", "rejected"]);
      if (["accepted", "rejected"].includes(report.acceptance.status) || report.acceptance.by !== undefined) string(report.acceptance.by, `${path}.acceptance.by`);
      if (["accepted", "rejected"].includes(report.acceptance.status) || report.acceptance.at !== undefined) time(report.acceptance.at, `${path}.acceptance.at`);
      if (report.acceptance.status === "rejected" || report.acceptance.reason !== undefined) string(report.acceptance.reason, `${path}.acceptance.reason`);
    }
  });
  each("events", (event, path) => {
    number(event.revision, `${path}.revision`);
    if (integer(event.revision) && integer(state.revision) && event.revision > state.revision) error(`${path}.revision`, "future_revision", "事件 revision 不可超過正本");
    identity(event.actor, `${path}.actor`);
    for (const key of ["occurredAt", "recordedAt"]) time(event[key], `${path}.${key}`);
    if (datetime(event.occurredAt) && datetime(event.recordedAt) && Date.parse(event.recordedAt) < Date.parse(event.occurredAt)) error(`${path}.recordedAt`, "time_order", "記錄時間不可早於發生時間");
    string(event.commandId, `${path}.commandId`);
    if (record(event.entity, `${path}.entity`)) {
      string(event.entity.type, `${path}.entity.type`);
      if (event.entity.type === "task") {
        string(event.entity.id, `${path}.entity.id`);
        if (event.entity.id !== state.taskId) error(`${path}.entity.id`, "missing_reference", "事件必須屬於本任務");
      } else if ([...collections, ...extraCollections].includes(event.entity.type)) reference(event.entity.id, `${path}.entity.id`, event.entity.type);
    }
  });
  validateFields({ state, rows, indexes, each, reference, references, string, displayText, time, number, identity, enumValue, record, array, strings, error, datetime, integer, text, requireValue });
  return { ok: errors.length === 0, errors };
}

/** Progress for a validated group; cancelled leaf IDs remain visible separately. */
export function computeProgress(state, groupId) {
  const group = state.items.find((item) => item.id === groupId && item.kind === "group");
  if (!group) throw new RangeError("找不到指定的大項");
  let total = 0;
  let done = 0;
  let review = 0;
  const cancelled = [];
  for (const item of state.items) {
    if (item.kind !== "leaf" || item.parentId !== groupId) continue;
    if (item.status === "cancelled") { cancelled.push(item.id); continue; }
    total++;
    if (item.status === "done") done++;
    if (item.status === "review") review++;
  }
  return { done, total, review, cancelled, percent: total === 0 ? 0 : done / total * 100 };
}
