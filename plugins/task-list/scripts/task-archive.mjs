import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { atomicWrite, taskPath, fail } from "./task-store.mjs";
import { archivableEvidence } from "./task-evidence.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function closePlan(root, state) {
  const blockers = state.items.filter(item => !["done", "cancelled"].includes(item.status)).map(item => `item ${item.id} ${item.status}`);
  blockers.push(...state.reports.filter(report => !report.ack).map(report => `未核對 ${report.id}`));
  const files = [];
  for (const relative of new Set(state.reports.flatMap(report => report.evidence))) {
    let file;
    try { file = archivableEvidence(root, relative); }
    catch (error) {
      if (error.code === "UNSAFE_PATH" || error.code === "UNSAFE_ARCHIVE") fail(error.code, `${error.message}（證據引用：${relative}）`);
      throw error;
    }
    if (file) files.push({ source: relative, sha256: hash(fs.readFileSync(file)) });
  }
  files.sort((a, b) => a.source.localeCompare(b.source));
  const evidenceSha256 = hash(JSON.stringify(files));
  return { revision: state.revision, blockers, files, evidenceSha256, preview: true, applyArgs: `--yes --expected-revision ${state.revision} --expected-evidence ${evidenceSha256}` };
}
export function archiveEvidence(root, state, fault, expectedEvidence) {
  const plan = closePlan(root, state);
  if (expectedEvidence !== plan.evidenceSha256) fail("EVIDENCE_CHANGED", "證據清單或內容已改變，請重新預覽並提供 --expected-evidence");
  if (plan.blockers.length) fail("CLOSE_BLOCKED", `尚不可結案：${plan.blockers.join("、")}`);
  const id = randomUUID();
  const files = plan.files.map(file => ({ ...file, destination: `history/task-list/${id}/evidence/${file.source}` }));
  for (const file of files) {
    const bytes = fs.readFileSync(taskPath(root, file.source));
    if (hash(bytes) !== file.sha256) fail("EVIDENCE_CHANGED", "證據已改變，請重新預覽");
    atomicWrite(taskPath(root, file.destination, true), bytes, fault);
    if (hash(fs.readFileSync(taskPath(root, file.destination))) !== file.sha256) fail("EVIDENCE_CHANGED", "證據複製校驗失敗");
    const parts = file.destination.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const fd = fs.openSync(taskPath(root, parts.slice(0, i).join("/")), "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  const rootFd = fs.openSync(root, "r");
  try { fs.fsyncSync(rootFd); } finally { fs.closeSync(rootFd); }
  const mapping = new Map(files.map(file => [file.source, file.destination]));
  for (const report of state.reports) report.evidence = report.evidence.map(ref => mapping.get(ref) ?? ref);
  for (const item of state.items) {
    item.sourceRef = mapping.get(item.sourceRef) ?? item.sourceRef;
    for (const policy of item.completionPolicy ?? []) policy.target = mapping.get(policy.target) ?? policy.target;
  }
  state.evidenceArchives ??= [];
  state.evidenceArchives.push({ id, files });
  return { archive: id, files, preview: false };
}
export function finishEvidenceArchive(root, state) {
  const errors = [];
  for (const archive of state.evidenceArchives ?? []) for (const file of archive.files) {
    try {
      if (hash(fs.readFileSync(taskPath(root, file.destination))) !== file.sha256) fail("EVIDENCE_CHANGED", `封存證據損壞：${file.destination}`);
      const source = taskPath(root, file.source);
      if (!fs.existsSync(source)) continue;
      if (hash(fs.readFileSync(source)) !== file.sha256) fail("EVIDENCE_CHANGED", `原檔已改變，不移除：${file.source}`);
      fs.unlinkSync(source);
      const parent = file.source.includes("/") ? taskPath(root, file.source.slice(0, file.source.lastIndexOf("/"))) : root;
      const fd = fs.openSync(parent, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) { errors.push(error.message); }
  }
  return errors;
}
