import fs from "node:fs";
import path from "node:path";
import { atomicWrite, taskPath } from "./task-store.mjs";
import { computeProgress } from "./task-core-schema.mjs";
import { allTaskEvents, readCleanupConfig } from "./task-history.mjs";

export function taskTree(state) {
  const row = (item) => ({ ...item, star: state.reports.some((report) => report.itemId === item.id && !report.ack), progress: item.kind === "group" ? computeProgress(state, item.id) : null, children: state.items.filter((child) => child.parentId === item.id).sort((a, b) => a.order - b.order).map(row) });
  return state.items.filter((item) => item.parentId === undefined).sort((a, b) => a.order - b.order).map(row);
}
const glyphs = { queued: "○", doing: "▶", waiting: "◆", blocked: "!", parked: "=", review: "◇", done: "✓", cancelled: "×" };
export function renderTaskGraph(state, { includeCompleted = false, timelineLimit = 20, timeline = state.events } = {}) {
  const lines = [`${state.title}（${state.taskId}）`, `revision ${state.revision}`];
  const summary = [];
  for (const [status, label] of [["waiting", "待回答"], ["blocked", "受阻"], ["review", "待驗收"], ["doing", "進行"], ["queued", "待辦"], ["parked", "停泊"]]) {
    const count = state.items.filter(item => item.status === status && !state.items.some(child => child.parentId === item.id)).length;
    if (count) summary.push(`${glyphs[status]} ${count} ${label}`);
  }
  if (!summary.length) summary.push("沒有未完成項目");
  const unacknowledged = state.reports.filter(report => !report.ack).length;
  if (unacknowledged) summary.push(`★ ${unacknowledged} 未核對`);
  lines.push(summary.join(" · "), "");
  function row(item, prefix) {
    const children = item.children.filter(child => includeCompleted || child.status !== "done" || child.star || child.children.length);
    if (includeCompleted || item.status !== "done" || item.star || children.length) lines.push(`${prefix}${glyphs[item.status]} ${item.title}${item.progress ? ` ${item.progress.done}/${item.progress.total}` : ""}${item.star ? " ★" : ""}${item.status === "review" ? " 待驗收" : ""}${item.nextAction ? ` — ${item.nextAction}` : ""}${item.review ? `；驗收者 ${item.review.reviewer}；再看 ${item.review.revisitAt}` : ""}`);
    children.forEach((child, index) => row(child, index === children.length - 1 ? "╰─ " : "├─ "));
  }
  const tree = taskTree(state).filter(item => includeCompleted || item.status !== "done" || item.star || item.children.some(child => child.status !== "done" || child.star || child.children.length));
  tree.forEach((item, index) => {
    if (index) lines.push("");
    row(item, "");
  });
  const done = state.items.filter(item => item.kind === "leaf" && item.status === "done").length;
  if (!includeCompleted && done) lines.push(`已完成 ${done} 項（task-todos --include-completed 展開）`);
  for (const report of state.reports.filter(report => !report.ack)) lines.push(`${report.history ? "歷史證據待核對" : "待核對"}：${report.id}（${report.itemId}）${report.evidence.join("、")}`);
  for (const [collection, statuses] of [["questions", ["open", "blocked"]], ["runs", ["unknown", "interrupted", "busy"]]]) {
    for (const entry of state[collection] ?? []) if (statuses.includes(entry.status)) lines.push(`${collection} ${entry.status}：${entry.id} ${entry.title ?? ""}`);
  }
  if (!state.items.length) lines.push("尚無待辦：task-list.mjs task item add --title <名稱> --criterion <完成條件>");
  const events = [...timeline].sort((a, b) => a.revision - b.revision);
  const cold = (state.history ?? []).filter(entry => !entry.restored).reduce((count, entry) => count + entry.count, 0);
  lines.push("", `時間線（最近 ${timelineLimit} 筆已提交事件）`);
  for (const event of events.slice(-timelineLimit)) lines.push(`${event.occurredAt} r${event.revision} ${event.command ?? "更新"}${event.result?.id ? `（${event.result.id}）` : ""}`);
  const displayed = new Set(events.slice(-timelineLimit).map(event => event.id));
  lines.push(`另有 ${state.events.filter(event => !displayed.has(event.id)).length} 筆較早事件未展開；${cold} 筆已封存。完整歷史：task history --limit 50 --before-revision <revision>`);
  return lines.join("\n");
}
export function generateCoreViews(root, state, fault = () => {}, { boardPrefix = "", extraFiles = [] } = {}) {
  const errors = [];
  let boardPath = "board.md";
  let view;
  try {
    const file = taskPath(root, ".console/config.json");
    if (fs.existsSync(file)) boardPath = JSON.parse(fs.readFileSync(file, "utf8")).boardPath ?? boardPath;
    view = readCleanupConfig(root).view;
  } catch (error) { errors.push(`設定：${error.message}`); return errors; }
  const header = `<!-- GENERATED / taskId=${state.taskId} / revision=${state.revision} / generatedAt=${new Date().toISOString()} / 離線快照 -->\n\n`;
  const reserved = new Set(["task-state.json", "decisions.md", "readme.md", "policy.md"]);
  const key = typeof boardPath === "string" ? boardPath.toLowerCase() : null;
  const evidence = new Set(state.reports.flatMap(report => report.evidence).filter(ref => !/^[a-z][a-z0-9+.-]*:/i.test(ref)).map(ref => path.resolve(fs.realpathSync(root), ref).toLowerCase()));
  let collision = false;
  try { collision = boardPath !== null && evidence.has(taskPath(root, boardPath).toLowerCase()); }
  catch (error) { errors.push(`${error.code}：${error.message}`); boardPath = null; }
  if (boardPath !== null && (!key || collision || reserved.has(key) || key === "history" || key.startsWith("history/") || key === ".console" || key.startsWith(".console/") || key === "runs" || key.startsWith("runs/") || key === "lines" || key.startsWith("lines/"))) { errors.push("BOARD_PATH_COLLISION：看板路徑不可覆寫正本、證據或其他生成文件"); boardPath = null; }
  for (const [relative, body] of [[boardPath, `# ${state.title}\n\n${boardPrefix}## 待辦\n\n${renderTaskGraph(state, { includeCompleted: view.completed === "expanded", timelineLimit: view.timelineLimit, timeline: allTaskEvents(root, state) })}\n`], ...extraFiles]) { if (!relative) continue; try { atomicWrite(taskPath(root, relative, true), header + body, fault); } catch (error) { errors.push(`${relative}：${error.message}`); } }
  return errors;
}
