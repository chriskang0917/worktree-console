import fs from "node:fs";
import { taskPath, fail } from "./task-store.mjs";

export function readCleanupConfig(root) {
  const file = taskPath(root, ".console/config.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const view = { completed: "collapsed", timelineLimit: 20, ...config.view };
  if (config.view !== undefined && (!config.view || typeof config.view !== "object" || Array.isArray(config.view))) fail("INVALID_CONFIG", "顯示設定必須是物件");
  if (!["collapsed", "expanded"].includes(view.completed) || !Number.isSafeInteger(view.timelineLimit) || view.timelineLimit < 1) fail("INVALID_CONFIG", "顯示設定無效");
  return { view };
}
export function historyPage(state, { limit = 50, beforeRevision = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(beforeRevision) || beforeRevision < 0) fail("INVALID_COMMAND", "分頁參數必須是有效正整數 revision／limit");
  const events = state.events.filter(event => event.revision < beforeRevision).sort((a, b) => b.revision - a.revision);
  const page = events.slice(0, limit);
  return { revision: state.revision, events: page, nextBeforeRevision: events.length > limit ? page.at(-1).revision : null };
}
