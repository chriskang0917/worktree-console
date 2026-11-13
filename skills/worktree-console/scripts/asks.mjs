import fs from "node:fs";
import path from "node:path";
import { advisorHome } from "./advice.mjs";

const DAY = 86400e3;
const ASKED_SOURCES = new Set(["console", "tab"]);
const ASKED_KINDS = new Set(["text", "menu"]);
export const NO_RECORDS = "期間內沒有回答紀錄";

function readAnswers(home) {
  try {
    return fs.readFileSync(path.join(home, "answers.jsonl"), "utf8").split("\n").flatMap((l) => {
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

const ratio = (self, total) => (total ? `${Math.round((self / total) * 100)}%` : "—");
const delta = (n) => (n > 0 ? `+${n} 次` : n < 0 ? `−${-n} 次` : "±0 次");

export function asksReport({ home = advisorHome(), since = null, days = null, now = Date.now() } = {}) {
  const period = asksPeriod({ since, days, now });
  const records = readAnswers(home).filter((r) => r.path);
  const rootOf = rootResolver(records.map((r) => r.path));
  const at = (r) => Date.parse(r.ts ?? "") || 0;
  const lastTag = new Map();
  for (const r of [...records].sort((a, b) => at(a) - at(b))) if (r.tag) lastTag.set(rootOf(r.path), r.tag);

  const rows = new Map();
  const prev = { asks: 0, self: 0 };
  for (const r of records) {
    if (!asked(r)) continue;
    const t = at(r);
    const self = selfAnswerable(r);
    if (t >= period.prevStart && t < period.start) {
      prev.asks++;
      if (self) prev.self++;
    }
    if (t < period.start || t >= period.end) continue;
    const root = rootOf(r.path);
    const row = rows.get(root) ?? { tag: lastTag.get(root) ?? path.basename(root), asks: 0, self: 0 };
    row.asks++;
    if (self) row.self++;
    rows.set(root, row);
  }
  if (rows.size === 0) return [NO_RECORDS];

  const sorted = [...rows.values()].sort((a, b) => b.asks - a.asks || b.self - a.self || a.tag.localeCompare(b.tag));
  const total = sorted.reduce((s, r) => ({ asks: s.asks + r.asks, self: s.self + r.self }), { asks: 0, self: 0 });
  const range = (from, to) => `${mmdd(from)}–${mmdd(addDays(to, -1))}`;
  return [
    `問你幾次：${range(period.start, period.end)}（${period.length} 天）`,
    "代號｜問你幾次｜agent 自己能回答｜比例",
    ...sorted.map((r) => `${r.tag}｜${r.asks}｜${r.self}｜${ratio(r.self, r.asks)}`),
    `本期 ${total.asks} 次（自答 ${total.self}，${ratio(total.self, total.asks)}）`,
    `前期 ${range(period.prevStart, period.start)}：${prev.asks} 次（自答 ${prev.self}，${ratio(prev.self, prev.asks)}）· ${delta(total.asks - prev.asks)}`,
  ];
}
