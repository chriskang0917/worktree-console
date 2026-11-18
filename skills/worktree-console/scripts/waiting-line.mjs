import fs from "node:fs";
import path from "node:path";
import { KEEPALIVE_REPLY, awaitsDecision, awaitsUser, closable, consoleHome, readKeepalive, sessionTag } from "./lib.mjs";
import { autoReplyOf, readDelegated } from "./auto-reply.mjs";

export { awaitsDecision, awaitsUser };

const ONE_DAY_MS = 24 * 3_600_000;

const sinceOf = (s) => s.since ?? s.agent?.stateStartedAt ?? null;

// When the user put this stop off on the focus band (8 延後處理), from focus.json's `bumped`.
export function skippedAt(s, bumped) {
  const since = sinceOf(s);
  if (since != null) return bumped[`${s.paneKey}@${since}`] ?? null;
  const hit = Object.entries(bumped).find(([k]) => k.startsWith(`${s.paneKey}@`) && !/@\d+$/.test(k));
  return hit ? hit[1] : null;
}

export function readBumped(home = consoleHome()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "focus.json"), "utf8")).bumped ?? {};
  } catch {
    return {};
  }
}

const keepaliveReply = (text) => String(text ?? "").replace(/[\s。.!！]/g, "") === KEEPALIVE_REPLY;

// A session kept alive is judged by the stop it had before the keepalive, never by its 「收到」 turn.
export function judgedStatus(s, keepalive = {}) {
  const rec = keepalive[s.paneKey];
  if (!s.realStatus && rec?.status && rec.phase !== "fresh" && keepaliveReply(s.status?.text)) return rec.status;
  return s.status;
}

// Which group a session goes in: auto, skipped, waiting, running, closable, or null. Without `row` no git is read, so nothing is closable.
export function listedAs(s, delegated = {}, bumped = {}, keepalive = {}, row = null) {
  if (s.archived) return null;
  if (autoReplyOf(s, delegated)) return "auto";
  const status = judgedStatus(s, keepalive);
  if (awaitsUser(status, { row, session: s })) return skippedAt(s, bumped) != null ? "skipped" : "waiting";
  if (row && closable(row, { ...s, status })) return "closable";
  return s.status?.kind === "busy" ? "running" : null;
}

export const GROUPS = [
  { id: "waiting", label: "等待" },
  { id: "auto", label: "自動處理中" },
  { id: "running", label: "在跑" },
  { id: "skipped", label: "延後處理" },
  { id: "closable", label: "可關閉" },
];

// The tags in each group, in board order (等待 in `first`'s order when given: the band's stop, then its queue); a stop put off for a day or
// more says how long it has waited.
export function waitingGroups(rows, { delegated = readDelegated(), bumped = readBumped(), now = Date.now(), keepalive = readKeepalive(), first = [] } = {}) {
  const groups = Object.fromEntries(GROUPS.map((g) => [g.id, []]));
  for (const row of rows) {
    for (const s of row.sessions) {
      const group = listedAs(s, delegated, bumped, keepalive, row);
      if (!group) continue;
      const tag = sessionTag(row, s);
      const since = sinceOf(s);
      const late = group === "skipped" && since != null && now - since >= ONE_DAY_MS;
      groups[group].push(late ? `${tag}（等了 ${Math.floor((now - since) / 3_600_000)} 小時）` : tag);
    }
  }
  const at = (tag) => (first.includes(tag) ? first.indexOf(tag) : first.length);
  groups.waiting = groups.waiting.map((tag, i) => [tag, i]).sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1]).map(([tag]) => tag);
  return groups;
}

const list = (tags) => (tags.length ? tags.join("、") : "無");

// One line for the console's replies: who waits on the user, who works on an answer sent for them, who just runs, and what the user put off.
export function waitingLine(rows, delegated = readDelegated(), bumped = readBumped(), now = Date.now(), keepalive = readKeepalive()) {
  const groups = waitingGroups(rows, { delegated, bumped, now, keepalive });
  return GROUPS.filter((g) => g.id !== "closable").map((g) => `${g.label}：${list(groups[g.id])}`).join("｜");
}
