import fs from "node:fs";
import path from "node:path";
import { advisorHome } from "./advice.mjs";
import { archiveDir, readEntries, readEvents, transcriptOf } from "./log.mjs";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const CELL = 60;
const STOP_LOOKBACK_MS = DAY;
export const NO_QA = "這段時間沒有問答紀錄";
const WHO = { console: "使用者", override: "使用者", tab: "分頁直接回", auto: "代回" };

const startOfDay = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

// One end of the range: YYYY-MM-DD, YYYY-MM-DD HH:mm, today, yesterday, or 3h / 2d / 30m back from now.
// A bare day as `--until` means the end of that day.
export function parseWhen(text, { end = false, now = Date.now() } = {}) {
  const s = String(text).trim();
  const day = (t) => (end ? startOfDay(t) + DAY : startOfDay(t));
  if (s === "today") return day(now);
  if (s === "yesterday") return day(startOfDay(now) - 1);
  const rel = s.match(/^(\d+)\s*([mhd])$/);
  if (rel) return now - Number(rel[1]) * { m: 60e3, h: HOUR, d: DAY }[rel[2]];
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) throw new Error(`看不懂的時間：${s}（用 YYYY-MM-DD、YYYY-MM-DD HH:mm、today、yesterday、3h、2d）`);
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime();
  return m[4] === undefined ? day(t) : t;
}

// Defaults to today; --days N is the last N days counting today; without --until the range ends tonight.
export function qaRange({ since = null, until = null, days = null, now = Date.now() } = {}) {
  if (days !== null && !(Number.isInteger(days) && days > 0)) throw new Error(`--days 要是正整數：${days}`);
  const to = until !== null ? parseWhen(until, { end: true, now }) : startOfDay(now) + DAY;
  let from;
  if (since !== null) from = parseWhen(since, { now });
  else if (days !== null) from = startOfDay(now) - (days - 1) * DAY;
  else from = startOfDay(now);
  return { from, to };
}

const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const clip = (text) => {
  const chars = Array.from(oneLine(text));
  return chars.length > CELL ? `${chars.slice(0, CELL - 1).join("")}…` : chars.join("");
};

function readAnswers(home) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, "answers.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
}

// The child's last paragraph before `at`, from the session's copy under transcripts/, else its original under ~/.claude/projects.
function lastParagraph(sessionId, at) {
  if (!sessionId) return null;
  const entries = readEntries(path.join(archiveDir(), `${sessionId}.jsonl`)) ?? readEntries(transcriptOf(sessionId) ?? "") ?? [];
  let found = null;
  for (const e of entries) {
    if (e.type !== "assistant" || Date.parse(e.timestamp ?? "") > at) continue;
    const text = (e.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    if (text) found = text;
  }
  return found ? found.split(/\n\s*\n/).filter((p) => p.trim()).at(-1) : null;
}

// The question for a record that logged none: the stop event of the same session just before it, else the transcript.
function questionFor(r, at, stops) {
  if (oneLine(r.question)) return r.question;
  const same = (e) => (r.sessionId && e.sessionId === r.sessionId) || (r.tag && e.ticket === r.tag);
  const stop = stops.filter((e) => same(e) && Date.parse(e.ts) <= at && at - Date.parse(e.ts) <= STOP_LOOKBACK_MS && oneLine(e.question)).at(-1);
  return stop?.question ?? lastParagraph(r.sessionId, at) ?? "（沒記到題目）";
}

const stamp = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// One line per answer: 時間｜代號｜問什麼｜怎麼回｜誰回的. Only reads ~/.advisor.
export function qaLines({ home = advisorHome(), tags = [], grep = null, since = null, until = null, days = null, limit = null, now = Date.now(), events = null } = {}) {
  if (limit !== null && !(Number.isInteger(limit) && limit > 0)) throw new Error(`--limit 要是正整數：${limit}`);
  const { from, to } = qaRange({ since, until, days, now });
  const stops = (events ?? readEvents(from - STOP_LOOKBACK_MS)).filter((e) => e.event === "stop");
  const tagOf = (r) => r.tag ?? stops.find((e) => r.sessionId && e.sessionId === r.sessionId)?.ticket ?? (r.path ? path.basename(r.path) : "—");
  const needle = grep ? grep.toLowerCase() : null;
  const rows = [];
  for (const r of readAnswers(home)) {
    if (r.event !== "answer") continue;
    const at = Date.parse(r.ts ?? "");
    if (!(at >= from && at < to)) continue;
    const tag = tagOf(r);
    if (tags.length && !tags.includes(tag)) continue;
    const question = questionFor(r, at, stops);
    if (needle && ![tag, question, r.answer].some((x) => String(x ?? "").toLowerCase().includes(needle))) continue;
    rows.push({ at, line: `${stamp(at)}｜${tag}｜${clip(question)}｜${clip(r.answer) || "—"}｜${WHO[r.source] ?? r.source ?? "—"}` });
  }
  rows.sort((a, b) => a.at - b.at);
  const shown = limit ? rows.slice(-limit) : rows;
  return shown.length ? shown.map((r) => r.line) : [NO_QA];
}
