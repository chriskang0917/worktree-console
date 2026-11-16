// Answers non-urgent questions for the user: each answer is first written as review items, then sent with `console.mjs reply --only`.
// Runs from the watcher's poll; the band reads the same verdicts so it shows only urgent questions.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consoleHome, pendingItems } from "./lib.mjs";
import { advisorHome, advisorState, latestFor, loadAdvice } from "./advice.mjs";
import { addItem, append, itemProblems, stateOf, worktreeOf } from "./review.mjs";
import { classify } from "./urgency.mjs";
import { sessionFor } from "./log.mjs";

const FILE = "delegated.json";
const KEEP_MS = 3 * 86400_000;
// The console's prompt counts as being typed in for this long after the band last saw text in it.
export const TYPING_MS = 15_000;
const CONSOLE = fileURLToPath(new URL("./console.mjs", import.meta.url));

export function readDelegated(home = consoleHome()) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, FILE), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeDelegated(state, home = consoleHome(), now = Date.now()) {
  const kept = Object.fromEntries(Object.entries(state).filter(([, v]) => now - (v.at ?? 0) < KEEP_MS));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, FILE), JSON.stringify(kept));
}

export const stopKey = (item) => `${item.session.paneKey ?? item.session.handle}@${item.session.since ?? item.session.agent?.stateStartedAt ?? item.entries?.[0]?.question ?? ""}`;

// The console's prompt holds a draft: the band writes `typingAt` into focus.json on each poll while it does.
export function typing(home = consoleHome(), now = Date.now()) {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(home, "focus.json"), "utf8"));
    return now - (f.typingAt ?? 0) < TYPING_MS;
  } catch {
    return false;
  }
}

// Whether a session stopped right after one of the gates turned it away: that message is never answered for the user.
function blockedStop(wt, sessionId, since) {
  if (!wt || !sessionId) return false;
  try {
    const st = stateOf(wt);
    const at = typeof since === "number" ? since : Date.parse(since ?? "") || Date.now();
    return st.blocked.some((b) => b.session === sessionId && Date.parse(b.at) <= at + 60_000) && !st.approved;
  } catch {
    return true;
  }
}

// Every pending question with what to do with it; `delegated` holds the ones already answered (or failed) by key.
// Without the advisor nothing is answered for the user: every question goes on the band as before (implement's 送審 aside).
export function verdicts(rows, { now = Date.now(), delegated = readDelegated() } = {}) {
  const advisor = advisorState(advisorHome());
  const byPath = advisor ? loadAdvice(advisorHome(), now) : null;
  return pendingItems(rows).map((item) => {
    const key = stopKey(item);
    const done = delegated[key];
    if (done?.failed) return { item, key, verdict: { band: true, urgent: null, reason: "代回沒送出" } };
    if (done) return { item, key, verdict: { band: false, done: true } };
    const since = item.session.since ?? item.session.agent?.stateStartedAt;
    const prediction = byPath ? latestFor(byPath, item.row.path, since) : null;
    let wt = null;
    try {
      wt = worktreeOf(item.row.path);
    } catch {}
    const gateBlocked = blockedStop(wt, item.session.handle ? sessionFor(item.session.handle) : null, since);
    const verdict = classify(item, { prediction, now, gateBlocked });
    return { item, key, wt, prediction, verdict: advisor || verdict.submit || verdict.band ? verdict : { band: true, urgent: null, reason: "沒有 advisor" } };
  });
}

const fit = (s) =>
  String(s ?? "")
    .split(/(?<=[。！？；])/)
    .map((x) => (Array.from(x).length > 40 ? `${Array.from(x).slice(0, 39).join("")}…` : x))
    .join("");

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: process.env, timeout: 120_000 });
}

// One poll: answers every question judged non-urgent and sends 送審 to implement's clean stops. Returns one line per action for the log.
export function delegateStep(rows, { now = Date.now(), home = consoleHome(), send = (tag, text) => runNode(CONSOLE, ["reply", "--only", tag, "--", text]).status === 0 } = {}) {
  const delegated = readDelegated(home);
  const out = [];
  if (typing(home, now)) return out;
  for (const { item, key, wt, verdict } of verdicts(rows, { now, delegated })) {
    if (verdict.submit) {
      delegated[key] = { at: now, submit: true };
      writeDelegated(delegated, home, now);
      const ok = send(item.tag, "送審");
      if (!ok) delegated[key] = { at: now, failed: true };
      out.push(`[${item.tag}] ${ok ? "已自動回覆：送審" : "自動送審沒送出"}`);
      continue;
    }
    if (!verdict.delegate || !wt) continue;
    const d = verdict.delegate;
    const sessionId = item.session.handle ? sessionFor(item.session.handle) : null;
    const items = d.items.map((x) => ({ ...x, question: fit(x.question), plan: fit(x.plan), impact: fit(x.impact) }));
    if (items.length === 0 || items.some((x) => itemProblems(x).length) || !d.answer) {
      delegated[key] = { at: now, failed: true, reason: "審核項目不合格式" };
      continue;
    }
    // Recorded before it is sent: a send that fails leaves an 未送出 line, never an answer nobody wrote down.
    const added = items.map((x) => addItem(wt, { ...x, by: "advisor", stop: `${item.tag} ${item.session.since ?? ""}`.trim(), session: sessionId, predictionId: d.predictionId ?? null }));
    const advisor = advisorState(advisorHome());
    const recorded = advisor && d.predictionId ? runNode(advisor.script, ["auto", "--tag", item.tag, "--path", item.row.path]).status === 0 : false;
    delegated[key] = { at: now, answer: d.answer, n: added.filter((a) => a.ok).map((a) => a.n) };
    writeDelegated(delegated, home, now);
    const ok = send(item.tag, d.answer);
    if (!ok) {
      for (const a of added) if (a.ok) append(wt, { event: "unsent", n: a.n, reason: "未送出" });
      if (recorded) runNode(advisor.script, ["undo", "--tag", item.tag]);
      delegated[key] = { at: now, failed: true };
    }
    out.push(`[${item.tag}] ${ok ? `已代回：${d.answer}` : "代回沒送出"}`);
  }
  writeDelegated(delegated, home, now);
  return out;
}
