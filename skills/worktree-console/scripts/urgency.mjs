// Which waiting questions reach the band: urgent ones at once, others only after the advisor has judged them; a non-urgent one is answered for the user.
import fs from "node:fs";
import path from "node:path";
import { asksAtEnd, asksSeveral, batchSheet, homeRunFolder, textOptionLabels } from "./lib.mjs";

// The ten kinds the advisor never answers; any one question of them makes the whole message urgent.
export const URGENT = [
  "等待授權",
  "session 異常",
  "不可逆或對外動作",
  "代價高的決定",
  "需使用者本人判定的驗收與原型確認",
  "加進〈不做〉或拿掉先前決定",
  "要用秘密值",
  "要連 SSH 或 RDS",
  "連續 3 個假設失敗",
  "判斷不出是否緊急",
];
export const UNSURE = URGENT[9];
export const JUDGE_WAIT_MS = 120_000;
export const DELEGATE_PREFIX = "（中控台代回，待實作前審核）";
export const SHEET_ANSWER = `${DELEGATE_PREFIX}全照建議`;

const QUESTION_HEAD = /\*\*第\s*\d+\s*題[:：]/;
const UNDECIDED = /第\s*\d+\s*題（gate#[0-9a-z]{8}-\d+）[：:]/;
const GATE_STOP = /^\s*審核單[：:]|console\.mjs review sheet/m;
const SUBMIT = /回「送審」/;
const LIVE = /說「定稿」/;
const ms = (t) => (typeof t === "number" ? t : Date.parse(t ?? "")) || 0;

export const isUndecided = (text) => UNDECIDED.test(String(text ?? ""));
export const isGateStop = (text) => GATE_STOP.test(String(text ?? ""));
export const isSubmitStop = (text) => SUBMIT.test(String(text ?? ""));
// dev-flow's full path stops with the prototype open and the user to confirm it (「說「定稿」才進審核」).
export const isLiveStop = (text) => LIVE.test(String(text ?? ""));

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// A batch sheet's path: dev-flow's full path (it makes a prototype) answers it for you, its lean path, define-goal and the interview do not.
export function sheetPath(row, text) {
  const goal = row?.repo && row?.branch ? read(path.join(homeRunFolder(row.repo, row.branch), "goal.md")) : null;
  if (/走精簡/.test(text) || (goal && /^path:\s*lean\b/m.test(goal))) return "lean";
  if (/走完整/.test(text) || goal) return "full";
  return "other";
}

// Each 待決定 of a sheet with the option its 建議 picks: one review item each.
export function sheetDecisions(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const l = raw.replace(/\*\*/g, "").trim();
    const head = l.match(/^待決定\s*(\d{1,2})\s*[：:]\s*(.+)$/);
    if (head) {
      cur = { n: Number(head[1]), question: head[2].replace(/^🔴\s*/, "").trim(), options: new Map(), pick: null, reason: "" };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const opt = l.match(/^[-*]?\s*([a-z])[.)、]\s*(.+)$/i);
    if (opt) cur.options.set(opt[1].toLowerCase(), opt[2].split(/[：:]/)[0].trim());
    const rec = l.match(/^建議[：:]\s*([a-z])\s*[，,。]?\s*(.*)$/i);
    if (rec) {
      cur.pick = rec[1].toLowerCase();
      cur.reason = rec[2].trim();
      cur = null;
    }
    if (/^整張單的建議/.test(l)) cur = null;
  }
  return out.map((d) => ({ n: d.n, question: d.question, plan: d.options.get(d.pick) ?? d.pick ?? "", reason: d.reason }));
}

// The implement report a 送審 stop points at: send 送審 only when 卡點與待裁決 says 無 and no criterion waits on a person.
export function reportClear(report) {
  if (!report) return false;
  const section = report.match(/(^|\n)#+\s*卡點與待裁決[^\n]*\n([\s\S]*?)(?=\n#+\s|\s*$)/);
  if (!section || section[2].replace(/[-*\s。]/g, "") !== "無") return false;
  return !/需人工判定\s*[1-9]|需人工判定[^\n]{0,6}[：:]\s*[1-9]/.test(report);
}

export function implementReport(row) {
  return row?.repo && row?.branch ? read(path.join(homeRunFolder(row.repo, row.branch), "implement-report.md")) : null;
}

const urgent = (reason) => ({ band: true, urgent: reason });
const onBand = (reason) => ({ band: true, urgent: null, reason });

// One pending question: `band` when it goes on the band (`urgent` names its kind), `wait` while the advisor still judges it,
// `delegate` with what to send and the review items to write, `submit` for implement's 送審 stop.
export function classify(item, { prediction = null, now = Date.now(), gateBlocked = false } = {}) {
  const { kind } = item;
  const status = item.session?.status ?? {};
  const text = String(status.text ?? "");
  if (kind === "permission") return urgent(URGENT[0]);
  if (kind === "anomaly") return urgent(URGENT[1]);
  if (gateBlocked || isGateStop(text)) return onBand("攔截點停下");
  if (status.kind === "done") {
    if (!isSubmitStop(text)) return onBand("回覆完畢");
    if (asksSeveral(text) || /第\s*\d+\s*題/.test(text)) return onBand("送審停下另有題目");
    return reportClear(implementReport(item.row)) ? { band: false, submit: true } : onBand("報告有卡點或需人工判定");
  }
  const sheet = kind === "text" ? batchSheet(text) : null;
  if (sheet) {
    if (sheet.red > 0 || text.includes("🔴")) return urgent(URGENT[3]);
    if (sheetPath(item.row, text) !== "full") return onBand("批改單就是實作前審核");
    const items = sheetDecisions(text).map((d) => ({ question: d.question, plan: d.plan, impact: d.reason || "這張票的規劃", basis: { kind: "none", note: "" } }));
    return { band: false, delegate: { answer: SHEET_ANSWER, items, sheet: true } };
  }
  if (isUndecided(text)) return urgent(URGENT[4]);
  if (kind === "text" && !QUESTION_HEAD.test(text) && textOptionLabels(text).length === 0 && !asksAtEnd(text)) return onBand("問句不在最後一段");
  const since = ms(item.session?.since ?? item.session?.agent?.stateStartedAt) || now;
  const p = prediction;
  if (!p || p.status === "pending") return now - since >= JUDGE_WAIT_MS ? urgent(UNSURE) : { band: false, wait: true };
  if (p.status !== "ready") return urgent(UNSURE);
  if (p.urgent === undefined) return urgent(UNSURE);
  if (p.urgent) return urgent(URGENT.includes(p.urgent) ? p.urgent : UNSURE);
  const briefs = Array.isArray(p.brief) && p.brief.length ? p.brief : null;
  if (!briefs) return urgent(UNSURE);
  const basis = p.precedentText ? { kind: "precedent", source: p.precedentText } : { kind: "none", note: "" };
  const items = briefs.map((b) => ({ question: b.question, plan: b.plan, impact: b.impact, basis }));
  return { band: false, delegate: { answer: String(p.answer ?? "").trim(), items, predictionId: p.id } };
}
