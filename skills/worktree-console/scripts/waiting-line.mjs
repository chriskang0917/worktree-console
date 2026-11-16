import { proseLines, sessionTag } from "./lib.mjs";
import { autoReplyOf, readDelegated } from "./auto-reply.mjs";

// ⏸ waits on the user only when its last paragraph asks the user to decide or to say a word.
const DECIDE = /等你|請你|由你|你決定|你確認|你選|請決定|請確認|請選|說「[^」]+」|回「[^」]+」/;

export function awaitsDecision(text) {
  const lines = proseLines(text);
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim()) start--;
  return DECIDE.test(lines.slice(start, end).join("\n"));
}

const list = (tags) => (tags.length ? tags.join("、") : "無");

// One line for the console's replies: who waits on the user, who works on an answer sent for them, who just runs.
export function waitingLine(rows, delegated = readDelegated()) {
  const waiting = [];
  const auto = [];
  const running = [];
  for (const row of rows) {
    for (const s of row.sessions) {
      if (s.archived) continue;
      const tag = sessionTag(row, s);
      const kind = s.status?.kind;
      if (autoReplyOf(s, delegated)) auto.push(tag);
      else if (["waiting", "permission", "anomaly"].includes(kind) || (kind === "done" && awaitsDecision(s.status.text))) waiting.push(tag);
      else if (kind === "busy") running.push(tag);
    }
  }
  return `等待：${list(waiting)}｜自動處理中：${list(auto)}｜在跑：${list(running)}`;
}
