import fs from "node:fs";
import path from "node:path";
import { advisorHome } from "./advice.mjs";
import { readEvents } from "./log.mjs";
import { KEEPALIVE_TEXT } from "../../../hooks/keepalive-text.mjs";

const DAY = 86400e3;
const ASKED_SOURCES = new Set(["console", "tab"]);
const ASKED_KINDS = new Set(["text", "menu"]);
export const NO_RECORDS = "期間內沒有回答紀錄";

function readJsonl(home, file) {
  try {
    return fs.readFileSync(path.join(home, file), "utf8").split("\n").flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const readAnswers = (home) => readJsonl(home, "answers.jsonl");

// The Stop hook writes a prediction's start the moment the child stops, so it marks when the question was put to you.
function askedAt(home) {
  const starts = new Map();
  for (const p of readJsonl(home, "predictions.jsonl")) if (p.event === "start" && p.id) starts.set(p.id, Date.parse(p.at ?? "") || null);
  return (record) => starts.get(record.predictionId) ?? null;
}

const leadingLetter = (text) => String(text ?? "").trim().match(/^([a-z])\1*(?![a-z])/i)?.[1].toLowerCase() ?? null;

export function selfAnswerable(record) {
  if (!record.childSuggestion) return false;
  const answer = String(record.answer ?? "").trim();
  if (/^全?照建議/.test(answer)) return true;
  const letter = leadingLetter(answer);
  if (!letter) return false;
  if (record.format === "批改單" && (letter === "a" || letter === "b")) return true;
  return letter === leadingLetter(record.childSuggestion);
}

export const asked = (record) => record.event === "answer" && ASKED_SOURCES.has(record.source) && ASKED_KINDS.has(record.kind);

// A path is grouped under the nearest ancestor holding .git; a removed worktree falls back to the shortest recorded path above it.
function rootResolver(paths) {
  const cache = new Map();
  const gitRoot = (p) => {
    for (let dir = p; dir && dir !== path.dirname(dir); dir = path.dirname(dir)) if (fs.existsSync(path.join(dir, ".git"))) return dir;
    return null;
  };
  const known = [...new Set(paths)].sort((a, b) => a.length - b.length);
  return (p) => {
    if (!cache.has(p)) cache.set(p, gitRoot(p) ?? known.find((k) => p === k || p.startsWith(`${k}/`)) ?? p);
    return cache.get(p);
  };
}

const startOfDay = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const addDays = (t, n) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};
const mmdd = (t) => {
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

export function asksPeriod({ since = null, days = null, now = Date.now() } = {}) {
  if (days !== null && !(Number.isInteger(days) && days > 0)) throw new Error(`--days 要是正整數：${days}`);
  const tomorrow = addDays(startOfDay(now), 1);
  let start;
  let end;
  if (since !== null) {
    const m = String(since).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error(`--since 要用 YYYY-MM-DD：${since}`);
    start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    end = days === null ? Math.max(tomorrow, addDays(start, 1)) : addDays(start, days);
  } else {
    end = tomorrow;
    start = addDays(end, -(days ?? 7));
  }
  const length = Math.round((end - start) / DAY);
  return { start, end, length, prevStart: addDays(start, -length) };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const oneDecimal = (n) => String(Math.round(n * 10) / 10);
function span(ms) {
  if (ms === null) return "—";
  const minutes = ms / 60e3;
  if (minutes < 1) return "<1 分";
  if (minutes < 60) return `${Math.round(minutes)} 分`;
  if (minutes < 24 * 60) return `${oneDecimal(minutes / 60)} 小時`;
  return `${oneDecimal(minutes / 60 / 24)} 天`;
}
const longest = (values) => (values.length ? Math.max(...values) : null);

const ratio = (self, total) => (total ? `${Math.round((self / total) * 100)}%` : "—");
const delta = (n) => (n > 0 ? `+${n} 次` : n < 0 ? `−${-n} 次` : "±0 次");

const textOf = (e) => (e.event === "answer" ? e.answer : e.event === "prompt" ? e.text : null);
const keepaliveTurn = (e) => /^收到[。.!！]?$/.test(String(e.question ?? "").trim());
const SHORT_ANSWER = /^\s*(?:[a-z](?=$|[\s，,。；;：:、])|全?照建議|好|ok\b|可以|確認|同意|定稿|送審|繼續|照做|是|對|沒問題|動工|開工|合併|送出|第\s*\d+\s*題)/i;

// A reply that answers the stop: an option letter, 照建議, a short yes, or one of the 「…」 words the stop asked for.
// Anything else is a new instruction, which says nothing about whether the stop was waiting.
export function answersStop(text, question) {
  const t = String(text ?? "").trim();
  if (!t || /^</.test(t) || KEEPALIVE_TEXT.startsWith(t.replace(/…$/, ""))) return false;
  if (SHORT_ANSWER.test(t)) return true;
  const quoted = [...String(question ?? "").matchAll(/[「『]([^」』]+)[」』]/g)].map((m) => m[1]);
  return quoted.some((q) => t.startsWith(q));
}

// ⏸ stops in the period the waiting line left out, and how many of them the user then answered before the session stopped again.
// Stops without a recorded `waiting` (older than this field) and the 「收到」 turn of a keepalive are not counted.
export function missedStops(events, { start, end }) {
  const open = new Map();
  let shown = 0;
  let replied = 0;
  for (const e of [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const key = e.paneKey ?? e.handle;
    if (!key) continue;
    if (e.event === "stop") {
      if (keepaliveTurn(e)) continue;
      const t = Date.parse(e.ts);
      const left = e.status === "done" && e.waiting === false && t >= start && t < end;
      if (left) shown++;
      if (left) open.set(key, e);
      else open.delete(key);
    } else if (textOf(e) != null && open.has(key)) {
      if (answersStop(textOf(e), open.get(key).question)) replied++;
      open.delete(key);
    }
  }
  return { shown, replied };
}

export function missedLine({ shown, replied }) {
  return `等待判斷：看板顯示回覆完畢、沒列入等待 ${shown} 次，其中你接著回答了 ${replied} 次（${ratio(replied, shown)}）`;
}

export function asksReport({ home = advisorHome(), since = null, days = null, now = Date.now(), events = null } = {}) {
  const period = asksPeriod({ since, days, now });
  const missed = missedLine(missedStops(events ?? readEvents(period.start), period));
  const records = readAnswers(home).filter((r) => r.path);
  const rootOf = rootResolver(records.map((r) => r.path));
  const at = (r) => Date.parse(r.ts ?? "") || 0;
  const lastTag = new Map();
  for (const r of [...records].sort((a, b) => at(a) - at(b))) if (r.tag) lastTag.set(rootOf(r.path), r.tag);

  const waitedFrom = askedAt(home);
  const rows = new Map();
  const prev = { asks: 0, self: 0, waits: [] };
  for (const r of records) {
    if (!asked(r)) continue;
    const t = at(r);
    const self = selfAnswerable(r);
    const from = waitedFrom(r);
    const waited = from !== null && t >= from ? t - from : null;
    if (t >= period.prevStart && t < period.start) {
      prev.asks++;
      if (self) prev.self++;
      if (waited !== null) prev.waits.push(waited);
    }
    if (t < period.start || t >= period.end) continue;
    const root = rootOf(r.path);
    const row = rows.get(root) ?? { tag: lastTag.get(root) ?? path.basename(root), asks: 0, self: 0, waits: [] };
    row.asks++;
    if (self) row.self++;
    if (waited !== null) row.waits.push(waited);
    rows.set(root, row);
  }
  if (rows.size === 0) return [NO_RECORDS, missed];

  const sorted = [...rows.values()].sort((a, b) => b.asks - a.asks || b.self - a.self || a.tag.localeCompare(b.tag));
  const total = sorted.reduce((s, r) => ({ asks: s.asks + r.asks, self: s.self + r.self }), { asks: 0, self: 0 });
  const waits = sorted.flatMap((r) => r.waits);
  const waitPair = (list) => `中位數 ${span(median(list))}、最長 ${span(longest(list))}`;
  const range = (from, to) => `${mmdd(from)}–${mmdd(addDays(to, -1))}`;
  return [
    `問你幾次：${range(period.start, period.end)}（${period.length} 天）`,
    "代號｜問你幾次｜agent 自己能回答｜比例｜等你中位數｜等你最長",
    ...sorted.map((r) => `${r.tag}｜${r.asks}｜${r.self}｜${ratio(r.self, r.asks)}｜${span(median(r.waits))}｜${span(longest(r.waits))}`),
    `本期 ${total.asks} 次（自答 ${total.self}，${ratio(total.self, total.asks)}）`,
    `前期 ${range(period.prevStart, period.start)}：${prev.asks} 次（自答 ${prev.self}，${ratio(prev.self, prev.asks)}）· ${delta(total.asks - prev.asks)}`,
    `等你的時間：本期${waitPair(waits)} · 前期${waitPair(prev.waits)}`,
    missed,
  ];
}
