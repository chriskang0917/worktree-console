import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { atomicWrite, taskPath, fail, checked } from "./task-store.mjs";

const defaults = { autoCompact: true, triggerEvents: 1000, triggerBytes: 2097152, keepRecentEvents: 200, keepRecentDays: 7 };
const digest = content => createHash("sha256").update(content).digest("hex");
export function readCleanupConfig(root) {
  const file = taskPath(root, ".console/config.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const history = { ...defaults, ...config.history };
  const view = { completed: "collapsed", timelineLimit: 20, ...config.view };
  if ((config.history !== undefined && (!config.history || typeof config.history !== "object" || Array.isArray(config.history))) || (config.view !== undefined && (!config.view || typeof config.view !== "object" || Array.isArray(config.view)))) fail("INVALID_CONFIG", "清理設定必須是物件");
  if (typeof history.autoCompact !== "boolean" || !["collapsed", "expanded"].includes(view.completed) || !Number.isSafeInteger(view.timelineLimit) || view.timelineLimit < 1) fail("INVALID_CONFIG", "顯示或自動壓縮設定無效");
  for (const key of ["triggerEvents", "triggerBytes", "keepRecentEvents", "keepRecentDays"]) if (!Number.isSafeInteger(history[key]) || history[key] < 1) fail("INVALID_CONFIG", `${key} 必須是正整數`);
  return { history, view };
}
function writeImmutable(root, relative, content, fault) {
  const file = taskPath(root, relative, true);
  if (fs.existsSync(file)) fail("HISTORY_EXISTS", "歷史檔不可覆寫");
  atomicWrite(file, content, fault);
  if (digest(fs.readFileSync(file)) !== digest(content)) fail("HISTORY_CORRUPT", "歷史寫入校驗失敗");
  // Persist newly-created directory entries as well as file contents.
  const parts = relative.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const fd = fs.openSync(taskPath(root, parts.slice(0, i).join("/")), "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const fd = fs.openSync(root, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { path: relative, sha256: digest(content) };
}
function verified(root, descriptor) {
  if (!descriptor || typeof descriptor.path !== "string" || !descriptor.path.startsWith("history/task-list/") || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) fail("HISTORY_CORRUPT", "歷史描述無效");
  try {
    const content = fs.readFileSync(taskPath(root, descriptor.path));
    if (digest(content) !== descriptor.sha256) fail("HISTORY_CORRUPT", `歷史 checksum 錯誤：${descriptor.path}`);
    return content.toString("utf8");
  } catch (error) { fail("HISTORY_CORRUPT", `歷史無法驗證：${descriptor.path}；${error.message}`); }
}
export function archiveEvents(root, state, entry) {
  try {
    const manifest = JSON.parse(verified(root, { path: entry.manifest, sha256: entry.sha256 }));
    if (manifest.schemaVersion !== 2 || manifest.taskId !== state.taskId || manifest.id !== entry.id || manifest.count !== entry.count || manifest.sourceRevision >= state.revision) fail("HISTORY_CORRUPT", "歷史 manifest 與正本不符");
    const snapshot = JSON.parse(verified(root, manifest.snapshot));
    checked(snapshot.schemaVersion === 1 ? { ...snapshot, schemaVersion: 2, history: [] } : snapshot);
    if (snapshot.taskId !== state.taskId || snapshot.revision !== manifest.sourceRevision) fail("HISTORY_CORRUPT", "恢復點身分不符");
    const content = verified(root, manifest.segment);
    const events = content.trim() ? content.trimEnd().split("\n").map(line => JSON.parse(line)) : [];
    const snapshotEvents = new Map(snapshot.events.map(event => [event.id, event]));
    if (events.length !== entry.count || events.some(event => JSON.stringify(snapshotEvents.get(event.id)) !== JSON.stringify(event))) fail("HISTORY_CORRUPT", "歷史事件與恢復點不符");
    return events;
  } catch (error) { fail("HISTORY_CORRUPT", `歷史損壞：${error.message}`); }
}
export function allTaskEvents(root, state) {
  const events = [...state.events];
  for (const entry of state.history ?? []) {
    const archived = archiveEvents(root, state, entry);
    if (!entry.restored) events.push(...archived);
  }
  const ids = new Set();
  const commands = new Set();
  for (const event of events) {
    if (ids.has(event.id) || commands.has(event.commandId)) fail("HISTORY_CORRUPT", "歷史有重複事件或指令");
    ids.add(event.id); commands.add(event.commandId);
  }
  return events.sort((a, b) => a.revision - b.revision);
}
export function historyPage(root, state, { limit = 50, beforeRevision = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(beforeRevision) || beforeRevision < 0) fail("INVALID_COMMAND", "分頁參數必須是有效正整數 revision／limit");
  const events = allTaskEvents(root, state).filter(event => event.revision < beforeRevision).reverse();
  const page = events.slice(0, limit);
  return { revision: state.revision, events: page, nextBeforeRevision: events.length > limit ? page.at(-1).revision : null };
}
const movable = new Set(["建立任務", "item add", "item update", "item move", "item reopen", "item cancel", "report submit", "report accept", "report reject", "report ack", "compact", "history restore", "migrate", "close", "archive"]);
export function compactionPlan(state, policy, now = Date.now()) {
  const sorted = [...state.events].sort((a, b) => a.revision - b.revision);
  const recent = new Set(sorted.slice(-policy.keepRecentEvents).map(event => event.id));
  const cutoff = now - policy.keepRecentDays * 86400000;
  const strings = new Set();
  function scan(value) {
    if (typeof value === "string") strings.add(value);
    else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") Object.values(value).forEach(scan);
  }
  for (const [key, value] of Object.entries(state)) if (!["events", "history"].includes(key)) scan(value);
  const candidates = sorted.filter(event => !recent.has(event.id) && Date.parse(event.recordedAt) < cutoff && movable.has(event.command) && !strings.has(event.id) && !strings.has(event.commandId));
  const bytes = Buffer.byteLength(JSON.stringify(state.events));
  return { triggered: state.events.length > policy.triggerEvents || bytes > policy.triggerBytes, hotCount: state.events.length, hotBytes: bytes, count: candidates.length, retained: state.events.length - candidates.length, reason: "保留最近筆數、最近天數、狀態引用與未知指令的恢復依賴", candidates };
}
export function compactState(root, state, policy, fault) {
  const plan = compactionPlan(state, policy);
  if (!plan.count) return { count: 0, retained: plan.retained, reason: plan.reason };
  const id = randomUUID();
  const base = `history/task-list/${id}`;
  const snapshot = writeImmutable(root, `${base}/snapshot-r${state.revision}.json`, JSON.stringify(state) + "\n", fault);
  const segment = writeImmutable(root, `${base}/events-${plan.candidates[0].recordedAt.slice(0, 7)}-r${plan.candidates[0].revision}-r${plan.candidates.at(-1).revision}.jsonl`, plan.candidates.map(event => JSON.stringify(event)).join("\n") + "\n", fault);
  const manifest = { schemaVersion: 2, id, taskId: state.taskId, sourceRevision: state.revision, count: plan.count, firstRevision: plan.candidates[0].revision, lastRevision: plan.candidates.at(-1).revision, snapshot, segment };
  const descriptor = writeImmutable(root, `${base}/manifest.json`, JSON.stringify(manifest) + "\n", fault);
  state.history.push({ id, manifest: descriptor.path, sha256: descriptor.sha256, count: plan.count });
  const removed = new Set(plan.candidates.map(event => event.id));
  state.events = state.events.filter(event => !removed.has(event.id));
  return { archive: id, count: plan.count, retained: plan.retained };
}
export function restoreState(root, state, id) {
  const entry = state.history.find(entry => entry.id === id);
  if (!entry) fail("NOT_FOUND", "找不到歷史封存");
  if (entry.restored) fail("ALREADY_RESTORED", "歷史已還原到熱資料");
  state.events.push(...archiveEvents(root, state, entry));
  state.events.sort((a, b) => a.revision - b.revision);
  entry.restored = true;
  return { archive: id, count: entry.count };
}
export function migrateState(root, old, fault) {
  const id = randomUUID();
  const snapshot = writeImmutable(root, `history/task-list/${id}/snapshot-v1-r${old.revision}.json`, JSON.stringify(old) + "\n", fault);
  const manifest = writeImmutable(root, `history/task-list/${id}/migration.json`, JSON.stringify({ schemaVersion: 2, taskId: old.taskId, sourceRevision: old.revision, from: 1, to: 2, snapshot }) + "\n", fault);
  return { ...structuredClone(old), schemaVersion: 2, history: [], migration: manifest };
}
export function verifyMigration(root, state) {
  if (!state.migration) return;
  const manifest = JSON.parse(verified(root, state.migration));
  const snapshot = JSON.parse(verified(root, manifest.snapshot));
  if (manifest.taskId !== state.taskId || manifest.from !== 1 || manifest.to !== 2 || snapshot.schemaVersion !== 1 || snapshot.taskId !== state.taskId) fail("HISTORY_CORRUPT", "遷移恢復點不符");
}
