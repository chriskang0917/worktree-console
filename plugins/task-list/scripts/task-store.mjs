import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { validateTaskState } from "./task-core-schema.mjs";
import { allTaskEvents, compactState, compactionPlan, migrateState, readCleanupConfig, verifyMigration } from "./task-history.mjs";

export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function checked(state, validate = validateTaskState) {
  const result = validate(state);
  if (!result.ok) throw Object.assign(new Error(result.errors.map(({ path, message }) => `${path.replace(/^\$\./, "")}：${message}`).join("\n")), { code: "INVALID_STATE", errors: result.errors });
  return state;
}
function identity(pid) {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).trim() || null; }
  catch { return null; }
}
let ownStart;
function processStart() { return ownStart ??= identity(process.pid); }
function syncDir(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function atomicWrite(file, content, fault = () => {}) {
  const start = processStart();
  if (!start) fail("LOCK_IDENTITY", "無法核對程序啟動身分");
  const temp = path.join(path.dirname(file), `.wtc-${process.pid}-${Buffer.from(start).toString("base64url")}-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fault("write", file);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fault("beforeRename", file);
    fs.renameSync(temp, file);
    fault("afterRename", file);
    syncDir(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}
// Reject symlinks, including intermediate directories; writes stay inside this task.
export function taskPath(root, relative, createParents = false) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) fail("UNSAFE_PATH", "必須使用任務內相對路徑，不可包含反斜線");
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("UNSAFE_PATH", "路徑不可越界");
  let current = fs.realpathSync(root);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) fail("UNSAFE_PATH", "路徑不可經過連結或非目錄");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (i < parts.length - 1 && createParents) {
        try { fs.mkdirSync(current); }
        catch (created) {
          if (created.code !== "EEXIST") throw created;
          const stat = fs.lstatSync(current);
          if (stat.isSymbolicLink() || !stat.isDirectory()) fail("UNSAFE_PATH", "路徑不可經過連結或非目錄");
        }
      }
    }
  }
  return current;
}
const OLDER_BACKUPS = 20;
function dead(owner) {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.start !== "string" || !owner.start) return false;
  const observed = identity(owner.pid);
  if (observed) return observed !== owner.start;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}
function pruneBackups(root, previousRevision) {
  const dir = taskPath(root, ".console");
  const older = fs.readdirSync(dir).filter((name) => /^previous-\d+\.json$/.test(name))
    .map((name) => ({ name, revision: Number(name.slice(9, -5)) }))
    .filter(({ revision }) => revision < previousRevision).sort((a, b) => b.revision - a.revision);
  for (const { name } of older.slice(OLDER_BACKUPS)) {
    const file = taskPath(root, `.console/${name}`);
    if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
  }
}
function lock(root, fault = () => {}) {
  const file = taskPath(root, ".console/transaction.lock", true);
  const owner = { pid: process.pid, start: processStart(), token: randomUUID() };
  if (!owner.start) fail("LOCK_IDENTITY", "無法核對程序啟動身分");
  const candidate = `${file}.${owner.token}.owner`;
  atomicWrite(candidate, JSON.stringify(owner));
  try {
    try { fs.linkSync(candidate, file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      let stat;
      try {
        stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) fail("LOCKED", "交易鎖身分不明");
        previous = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch { fail("LOCKED", "交易鎖身分不明，拒絕搶鎖"); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || !previous.start || !previous.token) fail("LOCKED", "交易鎖身分不明");
      const observed = identity(previous.pid);
      if (observed === previous.start) fail("LOCKED", "另一個交易仍在執行");
      if (!observed) {
        try { process.kill(previous.pid, 0); fail("LOCKED", "程序仍存活但無法核對啟動身分"); }
        catch (probe) { if (probe.code !== "ESRCH") throw probe; }
      }
      fault("beforeReclaim", file);
      // Arbitration belongs to this exact inode, never a replacement lock.
      const prefix = `${path.basename(file)}.reclaim-${stat.dev}-${stat.ino}-`;
      // The mkdir name itself carries identity: no empty-owner crash window.
      const gate = path.join(path.dirname(file), `${prefix}${owner.pid}-${Buffer.from(owner.start).toString("base64url")}-${owner.token}`);
      fs.mkdirSync(gate);
      try {
        fault("afterReclaimGate", file);
        for (const name of fs.readdirSync(path.dirname(file))) {
          if (!name.startsWith(prefix) || name === path.basename(gate)) continue;
          const match = name.slice(prefix.length).match(/^(\d+)-([A-Za-z0-9_-]+)-([0-9a-f-]{36})$/);
          if (!match || !dead({ pid: Number(match[1]), start: Buffer.from(match[2], "base64url").toString() })) fail("LOCKED", "另一個程序正在回收交易鎖");
          // UUID names are never reused; only remove our empty arbitration directories.
          fs.rmdirSync(path.join(path.dirname(file), name));
        }
        const fresh = fs.lstatSync(file);
        const freshOwner = JSON.parse(fs.readFileSync(file, "utf8"));
        if (fresh.dev !== stat.dev || fresh.ino !== stat.ino || freshOwner.token !== previous.token) fail("LOCKED", "交易鎖已換代，拒絕回收");
        fs.unlinkSync(file);
        try { fs.linkSync(candidate, file); } catch { fail("LOCKED", "另一個交易已取得鎖"); }
      } finally { fs.rmdirSync(gate); }
    }
    syncDir(path.dirname(file));
    // Preserve orphan files: Node cannot portably unlink relative to a verified
    // directory descriptor, and even the task root can be replaced by a symlink.
  } finally { fs.rmSync(candidate, { force: true }); }
  return () => {
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    if (current.token === owner.token) { fs.unlinkSync(file); syncDir(path.dirname(file)); }
  };
}
export function readTask(root, validate = validateTaskState) {
  const state = JSON.parse(fs.readFileSync(taskPath(root, "task-state.json"), "utf8"));
  checked(state.schemaVersion === 1 ? { ...state, schemaVersion: 2, history: [] } : state, validate);
  if (state.schemaVersion === 1 && (state.history !== undefined || state.migration !== undefined)) fail("INVALID_STATE", "v1 不可含有外部歷史");
  verifyMigration(root, state);
  allTaskEvents(root, state);
  return state;
}
function commitLocked(root, { commandId, expectedRevision, actor, requestHash, apply, fault = () => {}, generate, validate = validateTaskState, command }) {
  if (typeof commandId !== "string" || !commandId.trim()) fail("COMMAND_ID", "必須提供 commandId");
  const old = readTask(root, validate);
  const replay = allTaskEvents(root, old).find((event) => event.commandId === commandId && event.result !== undefined);
  if (replay) {
    if (replay.requestHash !== requestHash) fail("COMMAND_ID_CONFLICT", "同一 commandId 不可用於不同指令內容或身分");
    return { result: replay.result, revision: replay.revision, replay: true, viewErrors: generate ? generate(old) : [] };
  }
  if (expectedRevision !== old.revision) fail("REVISION_CONFLICT", "revision 已改變，請重讀後重新判斷");
  readCleanupConfig(root);
  const next = old.schemaVersion === 1 ? migrateState(root, old, fault) : structuredClone(old);
  const now = new Date().toISOString();
  const result = apply(next, now);
  next.revision++;
  next.updatedAt = now;
  next.events.push({ id: randomUUID(), revision: next.revision, entity: { type: "task", id: next.taskId }, actor, occurredAt: now, recordedAt: now, commandId, ...(command ? { command } : {}), requestHash, result });
  checked(next, validate);
  atomicWrite(taskPath(root, `.console/previous-${old.revision}.json`), JSON.stringify(old, null, 2) + "\n", fault);
  // Events and command receipts share the atomic snapshot's commit point.
  atomicWrite(taskPath(root, "task-state.json"), JSON.stringify(next, null, 2) + "\n", fault);
  pruneBackups(root, old.revision);
  const viewErrors = generate ? generate(next) : [];
  return { result, revision: next.revision, replay: false, viewErrors };
}
export function commitTask(root, transaction) {
  const release = lock(root, transaction.fault);
  try {
    const result = commitLocked(root, transaction);
    if (!result.replay && !["compact", "history restore", "close", "archive"].includes(transaction.command)) {
      try {
        const state = readTask(root, transaction.validate);
        const { history } = readCleanupConfig(root);
        const plan = compactionPlan(state, history);
        if (history.autoCompact && plan.triggered && plan.count) {
          const compacted = commitLocked(root, { commandId: randomUUID(), expectedRevision: state.revision, actor: { host: "local", id: "auto-compact" }, requestHash: "auto-compact", command: "compact", fault: transaction.fault, generate: transaction.generate, validate: transaction.validate, apply: next => compactState(root, next, history, transaction.fault) });
          result.stateRevision = compacted.revision;
          result.compaction = compacted.result;
          result.viewErrors.push(...compacted.viewErrors);
        } else if (history.autoCompact && plan.triggered) result.compaction = { count: 0, retained: plan.retained, reason: plan.reason };
      } catch (error) { result.compactionError = `${error.code ?? "ERROR"}：${error.message}`; }
    }
    return result;
  } finally { release(); }
}
export function withTaskLock(root, action, validate = validateTaskState) {
  const release = lock(root);
  try { return action(readTask(root, validate), (transaction) => commitLocked(root, { validate, ...transaction })); } finally { release(); }
}
