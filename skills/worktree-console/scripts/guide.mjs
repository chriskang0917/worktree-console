// `console.mjs guide`: the questions the console points the user at, printed from the child's own text, and the two lines every console reply
// ends with. What it prints for the session on the band is kept so the band shows the console's advice and its Stop hook can check the ending.
import { batchSheet, finishedState, matchSessions, pendingItems, proseLines, textOptionLabels, withoutEnding } from "./lib.mjs";
import { adviceFor, advisorHome, advisorState, loadAdvice } from "./advice.mjs";
import { finishedAdvice } from "./band.mjs";
import { readGuide, writeGuide } from "./guide-record.mjs";
import { waitingLine } from "./waiting-line.mjs";

const TOPIC = /^\s*\**\s*第\s*[一二三四五六七八九十\d]+\s*題/;
const TOPIC_NUM = /第\s*(\d+)\s*題/;
const SHEET_OPEN = /^\s*(?:\*\*)?\s*待決定\s*(\d{1,2})\s*[：:]/;
const OPTION = /^\s*(?:[-*+]\s+)?(?:\*\*)?\s*[a-z](?:\*\*)?\s*[.)、]/i;
const SUGGEST = /^\s*(?:\*\*)?建議(?:\*\*)?\s*[：:]\s*(.*)$/;
const RULE = /^\s*(?:─{3,}|-{3,})\s*$/;
const OWN = "子 session 自己的建議";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

const sinceOf = (s) => s.since ?? s.agent?.stateStartedAt ?? null;

// 「建議：b，理由」 split into the answer and its reason.
export function splitAdvice(text) {
  const t = String(text ?? "").trim();
  const m = t.match(/^(.*?)\s*[，,]\s*(.+)$/);
  return m ? { answer: m[1].trim(), reason: m[2].trim() } : { answer: t, reason: "" };
}

// A 「建議：」 line always says why: the child's own reason, or that it is the child's own suggestion.
function withReason(line) {
  const m = line.match(SUGGEST);
  if (!m) return line;
  const { answer, reason } = splitAdvice(m[1].replace(/\*\*/g, ""));
  return `建議：${answer}，${reason || OWN}`;
}

function paragraphs(lines) {
  const out = [];
  let cur = [];
  for (const l of lines) {
    if (l.trim()) cur.push(l);
    else if (cur.length) (out.push(cur), (cur = []));
  }
  if (cur.length) out.push(cur);
  return out;
}

// The question as the child wrote it: a batch sheet's 待決定 lines, options and 建議 lines; else the last 「第 N 題」 to the end;
// else the last paragraph. `own` is the child's 建議 line pulled out of a plain question, for the advice line.
export function questionOf(text) {
  const prose = proseLines(withoutEnding(text));
  if (batchSheet(text)) {
    const out = [];
    let open = false;
    for (const l of prose) {
      if (SHEET_OPEN.test(l)) (open = true), out.push(...(out.length ? [""] : []), l.trim());
      else if (!open) continue;
      else if (OPTION.test(l)) out.push(l.trim());
      else if (SUGGEST.test(l)) (out.push(withReason(l.trim())), (open = false));
      else if (RULE.test(l) || /整張單的建議/.test(l)) open = false;
    }
    return { lines: out, own: null, numbers: [...prose.join("\n").matchAll(new RegExp(SHEET_OPEN.source, "gm"))].map((m) => Number(m[1])) };
  }
  const numbers = [...new Set(prose.flatMap((l) => (TOPIC.test(l) ? [Number(l.match(TOPIC_NUM)?.[1])] : [])).filter(Number.isFinite))];
  const at = prose.findLastIndex((l) => TOPIC.test(l));
  const part = at >= 0 ? prose.slice(at) : (paragraphs(prose).filter((p) => !p.every((l) => SUGGEST.test(l))).at(-1) ?? []);
  const own = (at >= 0 ? part : prose).filter((l) => SUGGEST.test(l)).at(-1) ?? null;
  const lines = part.filter((l) => !SUGGEST.test(l)).map((l) => l.trimEnd());
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (at < 0) {
    const listed = textOptionLabels(text);
    if (listed.length && !lines.some((l) => OPTION.test(l))) lines.push("", ...listed.map((o, i) => `- ${LETTERS[i]}. ${o}`));
  }
  return { lines, own: own ? withReason(own.trim()) : null, numbers };
}

function menuQuestion(menu) {
  return menu.flatMap((q, i) => [
    ...(i ? [""] : []),
    `${menu.length > 1 ? `第 ${i + 1} 題 ` : ""}${q.header ? `${q.header}　` : ""}${q.question ?? ""}${q.multiSelect ? "（可複選）" : ""}`,
    ...(q.options ?? []).map((o, j) => `- ${LETTERS[j]}. ${o.label}${o.description ? `：${o.description}` : ""}`),
  ]);
}

function adviceOf(item, advice, advisor, now) {
  return adviceFor(advice, { path: item.row.path, status: item.session.status, since: sinceOf(item.session), now, advisor });
}

// One pending stop's block: its tag, the question, then one 建議 line with its reason.
export function questionBlock(item, advice = null) {
  const status = item.session.status;
  let lines;
  let own = null;
  if (item.kind === "menu" && status.menu) {
    lines = menuQuestion(status.menu);
    const rec = status.menu.map((q) => (q.options ?? []).findIndex((o) => /recommended|建議|推薦/i.test(`${o.label} ${o.description ?? ""}`)));
    if (rec.some((i) => i >= 0)) own = `建議：${rec.map((i) => (i >= 0 ? LETTERS[i] : "—")).join("；")}，${OWN}`;
  } else if (item.kind === "permission") lines = [`${status.tool}`, ...String(status.input ?? "").split("\n").slice(0, 6)];
  else if (item.kind === "anomaly") lines = ["session 異常：讀不到它在等什麼，到分頁看畫面"];
  else ({ lines, own } = questionOf(status.text));
  const said = advice?.state === "ready" && advice.answer ? `建議：${advice.answer}，${advice.reason || OWN}` : own;
  return [`**${item.tag}**`, "", ...lines, ...(said ? ["", said] : [])];
}

function parseSelf(text) {
  return [...String(text ?? "").matchAll(/\d+/g)].map((m) => Number(m[0]));
}

// The two lines every console reply ends with. `--mine` names what the console itself suggests for `target`.
export function endingLines(rows, view, { target = null, mine = null, advice = null, advisor = null, now = Date.now() } = {}) {
  const item = target ?? view.current?.item ?? null;
  let suggestion;
  if (mine && item) suggestion = `回 ${item.tag} ${mine}`;
  else if (item) {
    const a = adviceOf(item, advice, advisor, now);
    const finished = finishedState(item.row, item.session.status);
    if (a?.state === "ready" && a.answer) suggestion = `回 ${item.tag} ${a.answer}，${a.reason || OWN}`;
    else if (finished && !finished.closable) {
      const f = finishedAdvice(item.tag, finished);
      suggestion = `${f.answer}，${f.reason}`;
    } else suggestion = `回 ${item.tag}（按 9 看題目）`;
  } else suggestion = view.wait?.tag ? `不用做事，等 ${view.wait.tag} 回報` : "不用做事";
  return [`\`建議\`：${suggestion}`, `\`等待\`：${waitingLine(rows).replace(/^等待：/, "")}`];
}

// Prints the blocks for `tags`, the console's own advice when given, and the two ending lines; records them for the band and the Stop hook.
export function guideLines(rows, view, tags = [], { mine = null, self = null, now = Date.now(), session = process.env.CLAUDE_CODE_SESSION_ID ?? null } = {}) {
  const advice = loadAdvice(advisorHome(), now);
  const advisor = advice ? advisorState(advisorHome()) : null;
  const pending = pendingItems(rows);
  const items = tags.map((t) => {
    const sessions = matchSessions(rows, t).map((h) => h.session);
    const hit = pending.find((x) => sessions.includes(x.session));
    if (!hit) throw new Error(`[${t}] 不在待回覆清單`);
    return hit;
  });
  const out = items.flatMap((item, i) => [...(i ? [""] : []), ...questionBlock(item, adviceOf(item, advice, advisor, now))]);
  const target = items[0] ?? null;
  const own = mine ? splitAdvice(mine) : null;
  if (own) out.push(...(out.length ? [""] : []), `中控台的建議：${own.answer}${own.reason ? `，${own.reason}` : ""}`);
  const ending = endingLines(rows, view, { target: mine || self ? target ?? view.current?.item : null, mine, advice, advisor, now });
  out.push(...(out.length ? [""] : []), ...ending);
  const record = readGuide();
  const who = (mine || self) && (target ?? view.current?.item);
  if (who) {
    const numbers = who.kind === "text" ? questionOf(who.session.status.text).numbers : [];
    record.sessions[who.session.paneKey] = { since: sinceOf(who.session), tag: who.tag, mine: own, self: self ? parseSelf(self) : [], numbers, ending, at: now };
  }
  record.last = { at: now, session, lines: ending };
  writeGuide(record);
  return out;
}

