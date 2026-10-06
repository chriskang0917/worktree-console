// The herdr trial's evaluation page: how often herdr could not tell, how often the console still could not, and the
// misjudgements the user caught, ending in a verdict against two fixed bars.
import fs from "node:fs";
import path from "node:path";
import { readAudit } from "./herdr.mjs";
import { LABELS, consoleHome } from "./lib.mjs";
import { readEvents } from "./log.mjs";

export const ANOMALY_BAR = 0.05;
const ASKING = new Set(["waiting", "permission"]);
const SILENT = new Set(["busy", "done"]);
const RAW = { working: "working（執行中）", blocked: "blocked（卡住）", done: "done（完成）", idle: "idle（閒置）", unknown: "unknown（認不出）" };

const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const kindName = (k) => (k === "unknown" ? "推不出來" : LABELS[k] ?? k ?? "—");

// A misjudgement that hides a question: the session waited on the user while the board said running or finished.
export const missedCall = (m) => ASKING.has(m.actualKind) && SILENT.has(m.shown);

export function evaluate({ since = 0, audit = readAudit(since), events = readEvents(since) } = {}) {
  const reads = audit.filter((e) => e.event === "read");
  const misjudges = audit.filter((e) => e.event === "misjudge");
  const unknown = reads.filter((e) => e.herdr === "unknown").length;
  const anomaly = reads.filter((e) => e.shown === "anomaly").length;
  const off = reads.filter((e) => e.mismatch);
  const groups = new Map();
  for (const e of off) {
    const key = `${e.herdr}\u0000${e.shown}\u0000${e.inferred}`;
    groups.set(key, { herdr: e.herdr, shown: e.shown, inferred: e.inferred, count: (groups.get(key)?.count ?? 0) + 1 });
  }
  const missed = misjudges.filter(missedCall);
  const handoffs = events.filter((e) => e.event === "handoff");
  const tickets = new Set(reads.map((e) => `${e.repo}/${e.ticket}`));
  const reasons = [];
  if (reads.length === 0) reasons.push("沒有任何狀態讀取紀錄");
  else if (anomaly / reads.length >= ANOMALY_BAR) reasons.push(`補判斷後「session 異常」佔 ${pct(anomaly, reads.length)}，沒有低於 5%`);
  if (missed.length > 0) reasons.push(`有 ${missed.length} 次實際在等使用者回應或授權，看板卻顯示執行中或回覆完畢`);
  return {
    reads: reads.length,
    unknown,
    anomaly,
    mismatches: off.length,
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    misjudges,
    missed,
    handoffs,
    tickets: tickets.size,
    permissions: new Set(reads.filter((e) => e.shown === "permission").map((e) => e.ticket)).size,
    menus: new Set(reads.filter((e) => e.shown === "waiting" && e.herdr === "blocked").map((e) => e.ticket)).size,
    starts: events.filter((e) => e.event === "start" && e.ok).length,
    closes: events.filter((e) => e.event === "close" && e.ok).length,
    safe: reasons.length === 0,
    reasons,
  };
}

export function conclusionLines(r) {
  return [
    `herdr 原始 unknown：${r.unknown}／${r.reads} 次讀取（${pct(r.unknown, r.reads)}）`,
    `補判斷後「session 異常」：${r.anomaly}／${r.reads}（${pct(r.anomaly, r.reads)}，門檻 <5%）`,
    `三方不一致：${r.mismatches} 次；人工誤判：${r.misjudges.length} 筆，其中該叫沒叫 ${r.missed.length} 筆`,
    r.safe ? "結論：herdr 版可以放心用" : `結論：還不行——${r.reasons.join("；")}`,
  ];
}

function table(head, rows) {
  if (rows.length === 0) return `<p class="muted">（沒有）</p>`;
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function handoffResult(e) {
  if (e.ok) return "成功（看到 Goal set）";
  return e.reason ?? "失敗";
}

export function renderHtml(r, { since = 0, now = new Date(), notes = [] } = {}) {
  const verdict = r.safe ? "herdr 版可以放心用" : "還不行";
  const range = since ? `${new Date(since).toLocaleString("zh-TW")} 起` : "全部紀錄";
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>herdr 試跑評估</title>
<style>
:root { --bg: #fbfaf7; --fg: #1f1d1a; --muted: #6b665e; --line: #e2ded6; --card: #ffffff; --good: #1f7a4a; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #171614; --fg: #ece8e1; --muted: #a39d93; --line: #34312c; --card: #201f1c; --good: #5cc28a; --bad: #f2867e; } }
:root[data-theme="dark"] { --bg: #171614; --fg: #ece8e1; --muted: #a39d93; --line: #34312c; --card: #201f1c; --good: #5cc28a; --bad: #f2867e; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, "PingFang TC", "Noto Sans TC", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.15rem; margin: 36px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.muted { color: var(--muted); }
.verdict { margin: 20px 0; padding: 16px; border-radius: 10px; background: var(--card); border: 2px solid ${r.safe ? "var(--good)" : "var(--bad)"}; }
.verdict strong { color: ${r.safe ? "var(--good)" : "var(--bad)"}; font-size: 1.2rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
.stat b { display: block; font-size: 1.5rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
</style>
</head>
<body>
<main>
<h1>herdr 試跑評估</h1>
<p class="muted">範圍：${esc(range)}；產生時間：${esc(now.toLocaleString("zh-TW"))}</p>

<div class="stats">
<div class="stat">狀態讀取<b>${r.reads}</b>次，涵蓋 ${r.tickets} 個 session</div>
<div class="stat">herdr 原始 unknown<b>${pct(r.unknown, r.reads)}</b>${r.unknown} 次</div>
<div class="stat">補判斷後 session 異常<b>${pct(r.anomaly, r.reads)}</b>${r.anomaly} 次（門檻 &lt;5%）</div>
<div class="stat">三方不一致<b>${r.mismatches}</b>次</div>
</div>

<h2>試跑覆蓋</h2>
<p>開工 ${r.starts} 次、關閉 ${r.closes} 次；碰到授權請求的 session ${r.permissions} 個、提問選單 ${r.menus} 個、交棒 ${r.handoffs.length} 次。</p>

<h2>三方不一致的分類</h2>
<p class="muted">每次讀狀態都比三樣：herdr 自己回報的狀態、中控台最後顯示的狀態、只看對話紀錄與畫面推出的狀態。任兩樣對不上就算一次。</p>
${table(["次數", "herdr 回報", "中控台顯示", "對話紀錄與畫面推出"], r.groups.map((g) => [g.count, RAW[g.herdr] ?? g.herdr, kindName(g.shown), kindName(g.inferred)]))}

<h2>人工誤判（逐筆）</h2>
${table(
  ["時間", "代號", "看板顯示", "herdr 回報", "使用者說實際是", "該叫沒叫"],
  r.misjudges.map((m) => [new Date(m.ts).toLocaleString("zh-TW"), m.ticket, kindName(m.shown), m.herdr ?? "—", m.actual, missedCall(m) ? "是" : "否"]),
)}

<h2>交棒：長 /goal 有沒有被收成貼上內容</h2>
${table(
  ["時間", "代號", "種類", "/goal 長度", "結果"],
  r.handoffs.map((e) => [new Date(e.ts).toLocaleString("zh-TW"), e.ticket ?? "—", e.kind ?? "—", e.goalLength ?? "—", handoffResult(e)]),
)}

${notes.length > 0 ? `<h2>試跑中發現的問題與處理</h2>\n<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>\n` : ""}
<h2>結論</h2>
<div class="verdict"><strong>${esc(verdict)}</strong>
<ul>${conclusionLines(r).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<p class="muted">放心用的門檻兩條都要成立：補判斷後「session 異常」佔全部狀態讀取不到 5%；人工誤判裡沒有任何一次「實際在等使用者回應或授權，看板卻顯示執行中或回覆完畢」。</p>
</div>
</main>
</body>
</html>
`;
}

// `notes` is a Markdown list of what the trial ran into; each `- ` line becomes one item of its own section.
export function herdrReport({ since = 0, out = null, now = new Date(), notes = null } = {}) {
  const r = evaluate({ since });
  const file = path.resolve(out ?? path.join(consoleHome(), "herdr-report.html"));
  const items = notes ? fs.readFileSync(notes, "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()) : [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderHtml(r, { since, now, notes: items }));
  return { file, report: r, conclusion: conclusionLines(r) };
}
