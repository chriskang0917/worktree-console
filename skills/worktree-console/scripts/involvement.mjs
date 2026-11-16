#!/usr/bin/env node
// How much the user is pulled in: share of answers they gave themselves, answers per day, and stretches of more than 25 minutes nobody interrupted.
// Reads the console's event logs and the advisor's answers.jsonl, never writes either.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const QUIET_MS = 25 * 60_000;
const AUTO_MATCH_MS = 120_000;
const logDir = () => process.env.WORKTREE_CONSOLE_LOG_DIR || path.join(os.homedir(), ".worktree-console");
const advisorHome = () => process.env.ADVISOR_HOME || path.join(os.homedir(), ".advisor");

function lines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").flatMap((l) => {
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

const pad = (n) => String(n).padStart(2, "0");
export const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function days(from, until) {
  const out = [];
  const [y, m, d] = from.split("-").map(Number);
  for (let t = new Date(y, m - 1, d); dayOf(t) <= until; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) out.push(dayOf(t));
  return out;
}

// Every answer with its time and who gave it: `you` for the user (console or the child's tab), `auto` for one given for them.
export function answersIn({ from, until, events, advisor }) {
  const inRange = (t) => {
    const d = dayOf(t);
    return d >= from && d <= until;
  };
  const autos = advisor.filter((r) => r.event === "answer" && r.source === "auto" && inRange(r.ts)).map((r) => ({ at: Date.parse(r.ts), by: "auto", tag: r.tag ?? null }));
  const delegated = events.filter((e) => e.event === "delegate" && /已代回|已自動回覆/.test(e.line ?? "") && inRange(e.ts)).map((e) => ({ at: Date.parse(e.ts), by: "auto", tag: null }));
  const sentByAuto = (e) => autos.some((a) => (!a.tag || a.tag === e.ticket) && Math.abs(Date.parse(e.ts) - a.at) < AUTO_MATCH_MS);
  const console = events
    .filter((e) => e.event === "answer" && inRange(e.ts) && !String(e.delivery ?? "").startsWith("failed"))
    .filter((e) => !sentByAuto(e))
    .map((e) => ({ at: Date.parse(e.ts), by: "you" }));
  const tab = advisor.filter((r) => r.event === "answer" && r.source === "tab" && inRange(r.ts)).map((r) => ({ at: Date.parse(r.ts), by: "you" }));
  return [...console, ...tab, ...autos, ...delegated].sort((a, b) => a.at - b.at);
}

// Stretches longer than 25 minutes with no answer from the user, between the first and the last thing the console logged that day.
export function quietStretches(interruptions, start, end) {
  const marks = [start, ...interruptions.filter((t) => t > start && t < end), end];
  let n = 0;
  for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > QUIET_MS) n++;
  return n;
}

export function involvement({ from, until, home = logDir(), advisor = advisorHome() }) {
  const files = days(from, until).map((d) => path.join(home, `${d}.jsonl`));
  const events = files.flatMap(lines);
  const all = answersIn({ from, until, events, advisor: lines(path.join(advisor, "answers.jsonl")) });
  const you = all.filter((a) => a.by === "you");
  const rows = days(from, until).map((day) => {
    const mine = you.filter((a) => dayOf(a.at) === day).map((a) => a.at);
    const stamps = events.filter((e) => dayOf(e.ts) === day).map((e) => Date.parse(e.ts)).filter(Number.isFinite);
    const quiet = stamps.length ? quietStretches(mine, Math.min(...stamps), Math.max(...stamps)) : 0;
    return { day, answers: mine.length, quiet, active: stamps.length > 0 };
  });
  return { from, until, you: you.length, auto: all.length - you.length, rows };
}

export function involvementLines(r) {
  const total = r.you + r.auto;
  const share = total ? `${((r.you / total) * 100).toFixed(1)}%` : "—";
  const active = r.rows.filter((x) => x.active);
  const avg = (k) => (active.length ? (active.reduce((n, x) => n + x[k], 0) / active.length).toFixed(1) : "—");
  return [
    `期間 ${r.from}～${r.until}`,
    `涉入佔比：${share}（你回答 ${r.you} 次、代回 ${r.auto} 次）`,
    "",
    "| 日期 | 你回答幾次 | 超過 25 分鐘沒被打斷的段數 |",
    "| --- | --- | --- |",
    ...r.rows.map((x) => `| ${x.day.slice(5)} | ${x.active ? x.answers : "—"} | ${x.active ? x.quiet : "—"} |`),
    "",
    `有紀錄的 ${active.length} 天平均：每天回答 ${avg("answers")} 次、沒被打斷的段數 ${avg("quiet")} 段`,
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { from: { type: "string" }, until: { type: "string" }, days: { type: "string" } } });
  const until = values.until ?? dayOf(Date.now());
  const back = Number(values.days ?? 7);
  const [y, m, d] = until.split("-").map(Number);
  const from = values.from ?? dayOf(new Date(y, m - 1, d - back + 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    console.error("用法：involvement.mjs [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--days N]");
    process.exit(1);
  }
  for (const l of involvementLines(involvement({ from, until }))) console.log(l);
}
