// The trial's console side: the expiry reminder in the watcher and the 待決 tab's batch approvals.
// Everything here is off unless ~/.config/worktree-console/automation.json says otherwise; the advisor is reached only through its files and its script.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { consoleHome, reportLines } from "./lib.mjs";
import { advisorHome, advisorState, isSheet, latestFor, loadAdvice } from "./advice.mjs";

const AUTOMATION = "automation.json";
const DECISIONS = "decisions.jsonl";
const FREE = "free-predictions.jsonl";
const MIDTERM_AFTER_DAYS = 7;
const REPORT_TIMEOUT_MS = 120_000;
const ACTION_LABEL = {
  "delete-remote-branch": "刪遠端 branch",
  "linear-mention": "Linear @ 同事",
  "weekly-assign-write": "寫入每週分票",
  "close-old-mr": "關掉舊 MR",
  merge: "合併",
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// null when the file is missing or unreadable: then the console behaves as if the trial never existed.
export function readAutomation(home = consoleHome()) {
  let v;
  try {
    v = JSON.parse(fs.readFileSync(path.join(home, AUTOMATION), "utf8"));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const day = (x) => (typeof x === "string" && DAY.test(x) ? x : null);
  return { trial: { from: day(v.trial?.from), until: day(v.trial?.until) }, batch: { enabled: v.batch?.enabled === true } };
}

export const batchEnabled = (home = consoleHome()) => readAutomation(home)?.batch.enabled === true;

const pad = (n) => String(n).padStart(2, "0");
export const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

export const finalReport = (until, home = advisorHome()) => path.join(home, "reports", `trial-${until}.md`);
export const midtermReport = (until, home = advisorHome()) => path.join(home, "reports", `trial-${until}-midterm.md`);

function runAdvisor(script, args) {
  try {
    return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: process.env, timeout: REPORT_TIMEOUT_MS, killSignal: "SIGKILL" });
  } catch {
    return { status: 1, stdout: "" };
  }
}

// One watcher poll: the expiry line to wake the console with, or null. The mid-term report (a week in) is written once and wakes nobody.
// `tried` keeps a failing advisor from being run again every poll of the same watcher.
export function trialStep(now = Date.now(), tried = new Set()) {
  try {
    const trial = readAutomation()?.trial;
    if (!trial?.until) return null;
    const script = advisorState(advisorHome())?.script;
    if (!script || !fs.existsSync(script)) return null;
    const today = localDay(now);
    const span = trial.from && trial.from <= trial.until ? ["--from", trial.from] : [];
    if (today >= trial.until) {
      const file = finalReport(trial.until);
      const key = `final:${trial.until}`;
      if (fs.existsSync(file) || tried.has(key)) return null;
      tried.add(key);
      const res = runAdvisor(script, ["trial-report", "--final", ...span, "--until", trial.until]);
      return res.status === 0 && fs.existsSync(file) ? `[試營運] 到期，報告：${file}` : null;
    }
    if (!trial.from || today < addDays(trial.from, MIDTERM_AFTER_DAYS)) return null;
    const file = midtermReport(trial.until);
    const key = `midterm:${trial.until}`;
    if (fs.existsSync(file) || tried.has(key)) return null;
    tried.add(key);
    runAdvisor(script, ["trial-report", "--from", trial.from, "--until", today, "--out", file]);
  } catch {}
  return null;
}

// --- 待決: second-tier questions wait in the pane's tab instead of on the band ---

const decisionLines = (home = consoleHome()) => jsonl(path.join(home, DECISIONS));

// Free-form predictions are kept apart by the advisor; only their batch ones are wanted here.
function freeBatch(home, now) {
  const byPath = loadAdvice(home, now, FREE);
  if (!byPath) return null;
  for (const [k, list] of byPath) byPath.set(k, list.filter((p) => p.tier === "batch"));
  return byPath;
}

const merged = (a, b, target) => new Map([[target, [...(a?.get(target) ?? []), ...(b?.get(target) ?? [])].sort((x, y) => x.at - y.at)]]);

// Splits the band's entries: with batch on, a waiting question whose ready prediction is second tier leaves the queue for 待決.
// `batch` is null when batch is off, so callers keep today's output exactly.
// Any failure here falls back to batch off, so a 待決 bug can never take the band down.
export function splitBatch(entries, now = Date.now()) {
  try {
    return batchEnabled() ? batchOf(entries, now) : { open: entries, batch: null };
  } catch {
    return { open: entries, batch: null };
  }
}

function batchOf(entries, now) {
  const manual = manualIds();
  const home = advisorHome();
  const byPath = loadAdvice(home, now);
  const free = freeBatch(home, now);
  const open = [];
  const batch = [];
  for (const e of entries) {
    const status = e.item.session.status;
    const p = status?.kind === "waiting" ? latestFor(merged(byPath, free, e.item.row.path), e.item.row.path, e.since) : null;
    if (p?.status === "ready" && p.tier === "batch" && !isSheet(p) && !manual.has(p.id)) batch.push({ entry: e, prediction: p });
    else open.push(e);
  }
  return { open, batch };
}

// Questions the user took over with 自己回: they go back to the band for good.
function manualIds(home = consoleHome()) {
  return new Set(decisionLines(home).filter((l) => l.event === "resolve" && l.choice === "manual" && l.predictionId).map((l) => l.predictionId));
}

function jsonl(file) {
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

// The past question and answer a prediction leaned on, from the advisor's own records; null when it named none or it is gone.
function precedentsOf(ids, home = advisorHome()) {
  if (ids.length === 0) return new Map();
  const want = new Set(ids);
  const found = new Map();
  for (const name of ["history.jsonl", "answers.jsonl"]) {
    for (const r of jsonl(path.join(home, name))) if (want.has(r.id) && r.question && r.answer) found.set(r.id, { question: String(r.question), answer: String(r.answer) });
  }
  return found;
}

// The child's whole last reply, as 顯示問題 prints it, without the heading or the quote marks.
function contextOf(entry) {
  const { row, session } = entry.item;
  return reportLines(row, session.status, session).slice(2).map((l) => l.replace(/^> ?/, "")).join("\n").trim();
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// The 待決 tab's cards, grouped by ticket in the order they stopped; a send that failed stays listed with `failed`.
export function decisionCards(batch, optionsOf, home = consoleHome()) {
  const last = new Map();
  for (const l of decisionLines(home)) if (l.event === "resolve" && l.predictionId) last.set(l.predictionId, l);
  const precedents = precedentsOf(batch.map((b) => b.prediction.precedent).filter(Boolean));
  // A card that cannot be built in full still lists, with the prediction's own text, so its question never goes missing.
  return batch.map((b) => {
    try {
      return fullCard(b, optionsOf, last, precedents);
    } catch {
      return plainCard(b, last);
    }
  });
}

function plainCard({ entry, prediction: p }, last) {
  return {
    id: p.id,
    key: entry.key,
    paneKey: entry.paneKey,
    tag: entry.tag,
    repo: null,
    stage: null,
    group: entry.tag,
    verb: p.verb ?? null,
    action: ACTION_LABEL[p.verb] ?? p.verb ?? "對外動作",
    predictionId: p.id,
    tier: p.tier,
    kind: p.kind ?? null,
    question: oneLine(p.question),
    fullQuestion: String(p.question ?? ""),
    context: String(p.question ?? ""),
    precedent: null,
    suggestion: `建議：${oneLine(p.answer)}`,
    options: [],
    answer: oneLine(p.answer),
    reason: oneLine(p.reason),
    failed: last.get(p.id)?.sent === false,
  };
}

function fullCard({ entry, prediction: p }, optionsOf, last, precedents) {
  return {
    id: p.id,
    key: entry.key,
    paneKey: entry.paneKey,
    tag: entry.tag,
    repo: entry.item.row.repo,
    stage: entry.item.row.stage && entry.item.row.stage !== "—" ? entry.item.row.stage : null,
    group: entry.item.row.label ?? entry.tag,
    verb: p.verb ?? null,
    action: ACTION_LABEL[p.verb] ?? p.verb ?? "對外動作",
    predictionId: p.id,
    tier: p.tier,
    kind: p.kind ?? null,
    question: oneLine(entry.item.entries.map((x) => x.question).join(" / ")),
    fullQuestion: String(p.question ?? ""),
    context: contextOf(entry) || String(p.question ?? ""),
    precedent: precedents.get(p.precedent) ?? null,
    suggestion: `建議：${oneLine(p.answer)}${p.reason ? `，${oneLine(p.reason)}` : ""}`,
    options: p.kind === "free" ? [] : optionsOf(entry.item),
    answer: oneLine(p.answer),
    reason: oneLine(p.reason),
    failed: last.get(p.id)?.sent === false,
  };
}

function appendDecision(rec, home = consoleHome()) {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(path.join(home, DECISIONS), `${JSON.stringify(rec)}\n`);
  } catch {}
}

const newId = () => `d${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

// `console.mjs decide`: records each approved answer with the advisor (as the console does when you answer), sends it with `reply`,
// then logs it to decisions.jsonl; a failed send is taken back so the question stays in 待決, marked as failed.
export function approve(batch, { ids = null, reply, now = () => new Date().toISOString() }) {
  const advisor = advisorState(advisorHome());
  if (!advisor?.script) return { lines: ["找不到 advisor（~/.advisor/state.json 沒有 script），無法核可"], ok: false };
  const picked = ids ? batch.filter((b) => ids.includes(b.prediction.id)) : batch;
  if (picked.length === 0) return { lines: [ids ? `[${ids.join("、")}] 不在待決清單` : "待決清單是空的"], ok: false };
  const lines = [];
  let ok = true;
  for (const { entry, prediction: p } of picked) {
    const { tag, item } = entry;
    const answer = String(p.answer ?? "").trim();
    const recorded = runAdvisor(advisor.script, ["answer", "--tag", tag, "--path", item.row.path, "--answer", answer, "--hit", "yes"]);
    let sent = false;
    if (recorded.status === 0) {
      sent = reply(tag, answer);
      if (!sent) runAdvisor(advisor.script, ["undo", "--tag", tag]);
    }
    appendDecision({ event: "resolve", id: newId(), at: now(), predictionId: p.id, tag, verb: p.verb ?? null, choice: "approve", by: "panel", sent });
    lines.push(sent ? `[${tag}] 已核可並送出：${answer}` : `[${tag}] 送出失敗，留在待決`);
    ok &&= sent;
  }
  return { lines, ok };
}

// `console.mjs decide <id> manual`: the user answers this one in the console; it leaves 待決 and nothing is recorded with the advisor here.
export function takeOver(batch, id, { now = () => new Date().toISOString() } = {}) {
  const hit = batch.find((b) => b.prediction.id === id);
  if (!hit) return { ok: false, line: `[${id}] 不在待決清單` };
  const { entry, prediction: p } = hit;
  appendDecision({ event: "resolve", id: newId(), at: now(), predictionId: p.id, tag: entry.tag, verb: p.verb ?? null, choice: "manual", by: "panel", sent: null });
  return { ok: true, key: entry.key, line: `[${entry.tag}] 改成自己回，已放上橫條` };
}
