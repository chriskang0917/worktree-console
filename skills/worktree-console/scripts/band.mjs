// The status band above the console's prompt, composed here so the mod only draws runs: who is up, the advice, what was just sent,
// the groups line and the weekly reminder. Colors are names the mod maps onto its theme.
import fs from "node:fs";
import path from "node:path";
import { GROUPS } from "./waiting-line.mjs";

const LEAD = "  ";
const GROUP_GAP = "     ";
const TAG_GAP = "  ";
const SENT_MAX = 40;
// The groups that wait on you: their tags are bold in the group's color, the others' plain.
const YOURS = new Set(["waiting", "closable"]);
const COLLAPSE = ["skipped", "running", "auto", "closable"];

const run = (text, color = null, bold = false) => ({ text, ...(color ? { color } : {}), ...(bold ? { bold: true } : {}) });
const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const clipText = (text, max) => ([...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text);

// The groups line, widest first: then 延後處理, 在跑, 自動處理中 and 可關閉 shrink to 「組名 數字」 one by one,
// then the last tags of 等待 give way to +N. The mod draws the first one that fits.
export function groupVariants(groups, lead = LEAD) {
  const parts = GROUPS.filter((g) => groups[g.id]?.length).map((g) => ({ ...g, tags: groups[g.id] }));
  if (!parts.length) return [];
  const tagRuns = (p, tags) => tags.flatMap((t, i) => [...(i ? [run(TAG_GAP)] : []), YOURS.has(p.id) ? run(t, p.id, true) : run(t)]);
  const full = (p) => [run(`${p.label}${TAG_GAP}`, p.id), ...tagRuns(p, p.tags)];
  const short = (p) => [run(`${p.label} ${p.tags.length}`, p.id)];
  const cut = (p, keep) => [run(`${p.label}${TAG_GAP}`, p.id), ...tagRuns(p, p.tags.slice(0, keep)), ...(keep ? [run(TAG_GAP)] : []), run(`+${p.tags.length - keep}`, p.id, true)];
  const join = (list) => [run(lead), ...list.flatMap((runs, i) => [...(i ? [run(GROUP_GAP)] : []), ...runs])];
  const shrunk = new Set();
  const draw = (waitingKeep = null) => join(parts.map((p) => (p.id === "waiting" && waitingKeep !== null ? cut(p, waitingKeep) : shrunk.has(p.id) ? short(p) : full(p))));
  const variants = [draw()];
  for (const id of COLLAPSE) {
    if (!parts.some((p) => p.id === id)) continue;
    shrunk.add(id);
    variants.push(draw());
  }
  const waiting = parts.find((p) => p.id === "waiting");
  if (waiting) for (let keep = waiting.tags.length - 1; keep >= 0; keep--) variants.push(draw(keep));
  return variants;
}

// Question numbers as 「1～3 5 7」: three or more in a row become a range.
export function numberRanges(list) {
  const ns = [...new Set(list.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < ns.length; ) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    if (j - i >= 2) out.push(`${ns[i]}～${ns[j]}`);
    else for (let k = i; k <= j; k++) out.push(String(ns[k]));
    i = j + 1;
  }
  return out.join(" ");
}

// The Monday of `now`'s week as YYYY-MM-DD, local time.
export function mondayOf(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// This week's advisor report while it has no proposals yet; only reads the two files.
export function weeklyReport(home, now = Date.now()) {
  if (!home) return null;
  const base = path.join(home, "reports", `weekly-${mondayOf(now)}`);
  return fs.existsSync(`${base}.md`) && !fs.existsSync(`${base}-proposals.json`) ? `${base}.md` : null;
}

// A bare a／b／c answer carries its option's own words.
function optionWords(answer, options = []) {
  if (!/^[a-z](?:\s*[、,，]\s*[a-z])*$/i.test(answer)) return "";
  const words = [...answer.toLowerCase().matchAll(/[a-z]/g)].map((m) => options[m[0].charCodeAt(0) - 97]?.split(/[：:]/)[0]?.trim()).filter(Boolean);
  return words.length ? ` ${words.join("、")}` : "";
}

function adviceRuns(label, advice, options, dim = false) {
  if (!advice) return null;
  if (advice.state !== "ready" || !advice.answer) return [run(`${LEAD}${label}${TAG_GAP}`, dim ? "dim" : "accent"), run(flat(advice.text), "dim")];
  const answer = flat(advice.answer);
  const words = optionWords(answer, options);
  const reason = flat(advice.reason);
  return [
    run(`${LEAD}${label}${TAG_GAP}`, dim ? "dim" : "accent"),
    run(answer, dim ? "dim" : null, !dim),
    ...(words ? [run(words, dim ? "dim" : null)] : []),
    ...(advice.principle ? [run(`（原則性：${advice.principle}）`, dim ? "dim" : "waiting")] : []),
    ...(reason ? [run(`${TAG_GAP}${reason}`, "dim")] : []),
  ];
}

// What a 已完成 stop still lacks, as the advice row's reason.
export function finishedAdvice(tag, finished) {
  const missing = [finished.dirty ? `${finished.dirty} 個檔案沒 commit` : "", finished.unpushed ? `${finished.unpushed} 個 commit 沒推` : ""].filter(Boolean).join("、");
  return { answer: `回 ${tag}「送出」`, reason: `它說已完成，但還有 ${missing}，送出會開 draft MR` };
}

const KIND_LINE = { permission: ["等待授權", "blocked"], anomaly: ["session 異常", "error"], done: ["回覆完畢", "auto"] };

// The band's rows; `keys` sit on the first row's right. Empty when nothing waits, runs or can be closed.
export function bandRows({ current = null, wait = null, queue = 0, groups = {}, advice = null, options = [], guide = null, finished = null, sent = null, weekly = null }) {
  const rows = [];
  const variants = groupVariants(groups);
  let rail = "dim";
  if (current) {
    const [label, color] = KIND_LINE[current.kind] ?? ["輪到你", "waiting"];
    rail = color;
    rows.push({
      variants: [[run("◆", color), run(` ${label}${TAG_GAP}`, color, true), run(current.tag, null, true)]],
      keys: [...(queue ? [{ key: "8", label: "延後處理", action: "later" }] : []), { key: "9", label: "顯示問題", action: "show" }, { key: "0", label: "面板", action: "pane" }],
    });
    const mine = guide?.mine ?? null;
    if (mine) {
      rows.push({ variants: [[run(`${LEAD}中控台建議${TAG_GAP}`, "accent"), run(mine.answer, null, true), ...(mine.reason ? [run(`${TAG_GAP}${mine.reason}`, "dim")] : [])]] });
      const theirs = adviceRuns("advisor 建議", advice, options, true);
      if (theirs) rows.push({ variants: [theirs] });
    } else if (finished && !finished.closable) {
      const f = finishedAdvice(current.tag, finished);
      rows.push({ variants: [[run(`${LEAD}建議${TAG_GAP}`, "accent"), run(f.answer, null, true), run(`${TAG_GAP}${f.reason}`, "dim")]] });
    } else {
      const own = adviceRuns("建議", advice, options);
      if (own) rows.push({ variants: [own] });
    }
    if (guide?.self?.length) {
      const rest = (guide.numbers ?? []).filter((n) => !guide.self.includes(n));
      rows.push({
        variants: [[run(`${LEAD}要你回${TAG_GAP}`, "accent"), run(numberRanges(guide.self), "waiting", true), ...(rest.length ? [run(`${GROUP_GAP}照建議${TAG_GAP}`, "accent"), run(numberRanges(rest))] : [])]],
      });
    }
    if (sent?.text) rows.push({ variants: [[run(`${LEAD}剛送出${TAG_GAP}`, "accent"), run(`${sent.tag}：${clipText(flat(sent.text), SENT_MAX)}`), run(`${GROUP_GAP}它回來後排在下一件`, "dim")]] });
  } else if (wait) {
    rows.push({
      variants: [[run("◌ 等 ", "dim"), run(wait.tag ?? "—", null, true), run(" 回應中…", "dim"), ...(wait.text ? [run("　你回了  ", "dim"), run(clipText(flat(wait.text), SENT_MAX))] : [])]],
      keys: [...(queue ? [{ key: "8", label: "先處理下一件", action: "next" }] : []), { key: "0", label: "面板", action: "pane" }],
    });
  }
  if (variants.length) {
    if (rows.length) rows.push({ variants });
    else rows.push({ variants: groupVariants(groups, ""), keys: [{ key: "0", label: "面板", action: "pane" }] });
  }
  if (weekly) rows.push({ variants: [[run(`${rows.length ? LEAD : ""}[每週改善] 報告：`, "accent"), run(weekly)]] });
  if (rows.length && !rows[0].keys) rows[0].keys = [{ key: "0", label: "面板", action: "pane" }];
  return { title: "狀態", rail, rows };
}

// The plain text of a row as the mod draws its widest form, for tests and logs.
export const rowText = (row, i = 0) => (row.variants[i] ?? []).map((r) => r.text).join("");
