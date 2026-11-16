import fs from "node:fs";
import path from "node:path";
import { KEEPALIVE_REPLY, asksNearEnd, consoleHome, endingOf, readKeepalive, sessionTag } from "./lib.mjs";
import { autoReplyOf, readDelegated } from "./auto-reply.mjs";

// What a stop without the ending line says when it waits on the user. 「跟我說」「告訴我」 are left out: they mostly close a report politely.
const DECIDE = new RegExp(
  [
    "(?<!不用|不必|不需要|無須)等你",
    "請你",
    "由你",
    "你決定",
    "你確認",
    "你選",
    "請決定",
    "請確認",
    "請選",
    "(?:說|回|回我|按)[「『][^」』]+[」』]",
    "送出決定",
    "(?:審核頁|確認頁)[^。\\n]{0,20}?(?:按|勾|選|決定|送出|確認|審)",
    "(?<!不需|不)要你",
    "你同意",
    "你拍板",
    "(?<!期)待你",
    "回\\s*[a-zA-Z](?:\\s*[／/、,，或]\\s*[a-zA-Z])+",
  ].join("|"),
);

const ONE_DAY_MS = 24 * 3_600_000;

export function awaitsDecision(text) {
  return asksNearEnd(text, (p) => DECIDE.test(p.join("\n")));
}

// The session's own ending line decides first; without one, 💬, a menu, 🔐 and ⚠️ wait, and ⏸ waits when it asks in words.
export function awaitsUser(status) {
  const kind = status?.kind;
  if (kind === "permission" || kind === "anomaly" || (kind === "waiting" && status.menu)) return true;
  if (kind !== "waiting" && kind !== "done") return false;
  const ending = endingOf(status.text);
  if (ending) return ending.wait;
  return kind === "waiting" || awaitsDecision(status.text);
}

const sinceOf = (s) => s.since ?? s.agent?.stateStartedAt ?? null;

// When the user skipped this stop on the focus band (8 延後處理, or picking another), from focus.json's `bumped`.
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

// Which cell of the line a session goes in: auto, skipped, waiting, running, or null.
export function listedAs(s, delegated = {}, bumped = {}, keepalive = {}) {
  if (s.archived) return null;
  if (autoReplyOf(s, delegated)) return "auto";
  if (awaitsUser(judgedStatus(s, keepalive))) return skippedAt(s, bumped) != null ? "skipped" : "waiting";
  return s.status?.kind === "busy" ? "running" : null;
}

const list = (tags) => (tags.length ? tags.join("、") : "無");

// One line for the console's replies: who waits on the user, who works on an answer sent for them, who just runs, and what the user skipped.
export function waitingLine(rows, delegated = readDelegated(), bumped = readBumped(), now = Date.now(), keepalive = readKeepalive()) {
  const cells = { waiting: [], auto: [], running: [], skipped: [] };
  for (const row of rows) {
    for (const s of row.sessions) {
      const cell = listedAs(s, delegated, bumped, keepalive);
      if (!cell) continue;
      const tag = sessionTag(row, s);
      const since = sinceOf(s);
      const late = cell === "skipped" && since != null && now - since >= ONE_DAY_MS;
      cells[cell].push(late ? `${tag}（等了 ${Math.floor((now - since) / 3_600_000)} 小時）` : tag);
    }
  }
  return `等待：${list(cells.waiting)}｜自動處理中：${list(cells.auto)}｜在跑：${list(cells.running)}｜已跳過：${list(cells.skipped)}`;
}
