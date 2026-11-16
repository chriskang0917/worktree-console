// The trial's console side: the expiry reminder in the watcher.
// Everything here is off unless ~/.config/worktree-console/automation.json says otherwise; the advisor is reached only through its files and its script.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { consoleHome } from "./lib.mjs";
import { advisorHome, advisorState } from "./advice.mjs";

const AUTOMATION = "automation.json";
const MIDTERM_AFTER_DAYS = 7;
const REPORT_TIMEOUT_MS = 120_000;

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
  return { trial: { from: day(v.trial?.from), until: day(v.trial?.until) } };
}

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
