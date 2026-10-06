import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOTIFICATION, SKIP_PROMPT, archiveDir, consoleCalls, consoleSubcommands, messageUsage, promptText, readEntries, readEvents, replies } from "./log.mjs";

const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRIGGER = { you: "你的訊息", watcher: "watcher 回報", other: "其他背景通知" };
const OUTCOMES = ["照建議", "改了再送", "自己另寫", "沒回"];
const RESULT = /^(詳情|已送出|已選擇|已允許|已拒絕|未送達|已開工|未開工|已關閉|未關閉|已交棒|交棒失敗|已自動交棒|自動交棒失敗|續命時沒照指示|對齊|沒有可用)/;
const AGREE = /^(照建議|依建議|用建議|照這樣回?|照它的?建議|好|好的|可以|OK|同意|沒問題|要)[。！!.]?$/i;
const AGREE_EDIT = /^(照建議|依建議|用建議|照這樣回?)[，,、;：:\s]+\S/;

// Copies of the registered console sessions, in registration order.
export function consoleCopies(events = readEvents()) {
  const ids = [...new Set(events.filter((e) => e.event === "session" && e.role === "console").map((e) => e.sessionId))];
  return ids.map((id) => ({ id, file: path.join(archiveDir(), `${id}.jsonl`) })).filter((c) => fs.existsSync(c.file));
}

function texts(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((p) => {
    if (p.type === "text") return [p.text ?? ""];
    if (p.type === "tool_result") return typeof p.content === "string" ? [p.content] : (p.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "");
    return [];
  });
}

// A round runs from what woke the console (your message, a watcher report, another background notice) to the
// next such wake-up. Every reply, subagents included, is counted once per message.id in the round it falls in.
export function consoleRounds(entries) {
  const main = entries.filter((e) => !e.isSidechain);
  const background = new Map();
  const rounds = [];
  let current = null;
  for (const e of main) {
    if (!e.timestamp) continue;
    for (const p of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (e.type === "assistant" && p.type === "tool_use" && p.name === "Bash") {
        background.set(p.id, String(p.input?.command ?? ""));
        current?.calls.push(...consoleCalls(p.input?.command));
      }
    }
    if (e.type === "assistant") current?.said.push({ at: e.timestamp, text: texts(e).join("\n") });
    if (e.type === "user" && current) current.seen.push({ at: e.timestamp, text: texts(e).join("\n") });
    const text = promptText(e);
    if (text === null || SKIP_PROMPT.test(text)) continue;
    let trigger = TRIGGER.you;
    if (NOTIFICATION.test(text)) {
      const id = text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1];
      trigger = /watch\.mjs/.test(background.get(id) ?? text) ? TRIGGER.watcher : TRIGGER.other;
    }
    current = { start: e.timestamp, trigger, prompt: trigger === TRIGGER.you ? text : null, calls: [], said: [], seen: [], tokens: 0, usd: 0 };
    rounds.push(current);
  }
  const seen = new Set();
  for (const e of entries) {
    const msg = e.message;
    if (e.type !== "assistant" || !msg?.usage) continue;
    const id = msg.id ?? e.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    const round = rounds.findLast((r) => r.start <= (e.timestamp ?? "")) ?? rounds[0];
    if (!round) continue;
    const { tokens, usd } = messageUsage(msg);
    round.tokens += tokens;
    round.usd += usd;
  }
  return rounds;
}

// Total tokens of a session counted once per message.id, the same way the rounds count them.
export function sessionTokens(entries) {
  const seen = new Set();
  let n = 0;
  for (const e of entries) {
    if (e.type !== "assistant" || !e.message?.usage) continue;
    const id = e.message.id ?? e.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    n += messageUsage(e.message).tokens;
  }
  return n;
}

// `[代號]` paragraphs the console wrote itself (not a script result line, not inside code, quotes or tables)
// that ask something.
export function suggestionBlocks(text) {
  const out = [];
  let fence = false;
  let block = null;
  for (const line of String(text).split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const quoted = fence || /^\s*(```|>|\||#{1,6}\s)/.test(line);
    const head = quoted ? null : line.match(/^\[([^\]\s]+)\]\s*(.*)$/);
    if (head && !RESULT.test(head[2])) {
      block = { tag: head[1], lines: [line] };
      out.push(block);
    } else if (quoted) block = null;
    else if (block) block.lines.push(line);
  }
  return out.filter((b) => /[?？]/.test(b.lines.join("\n"))).map((b) => ({ tag: b.tag, text: b.lines.join("\n").trim() }));
}

export function addresses(token, tag) {
  const base = tag.replace(/#\d+$/, "");
  return token === tag || token === base || (/^\d+$/.test(token) && base.endsWith(`-${token}`));
}

export function replyOutcome(rest) {
  const r = rest.trim();
  if (AGREE_EDIT.test(r)) return "改了再送";
  if (AGREE.test(r) || /^(照建議|依建議|用建議)/.test(r)) return "照建議";
  return "自己另寫";
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each detail suggestion from when it was posted until that session stops again, is closed, or the console ends,
// and what you did with it: the first message addressed to it, or a line typed straight into its Orca tab.
export function suggestionOutcomes(rounds, typed = []) {
  const blocks = [];
  for (const r of rounds) {
    if (!r.calls.includes("detail")) continue;
    for (const s of r.said) for (const b of suggestionBlocks(s.text)) blocks.push({ ...b, at: s.at });
  }
  const lastAt = rounds.flatMap((r) => [r.start, ...r.said.map((s) => s.at), ...r.seen.map((s) => s.at)]).sort().at(-1) ?? "";
  return blocks.map((b, i) => {
    const report = new RegExp(`^### \\S+ ${esc(b.tag)} (等你回應|等你選擇|等你授權|回覆完畢)\\s*$`, "m");
    const closed = `[${b.tag}] 已關閉`;
    const ends = [lastAt];
    const next = blocks.slice(i + 1).find((x) => x.tag === b.tag);
    if (next) ends.push(next.at);
    for (const r of rounds) {
      for (const s of r.seen) if (s.at > b.at && (report.test(s.text) || s.text.includes(closed))) ends.push(s.at);
    }
    const end = ends.sort()[0];
    let outcome = null;
    let at = null;
    for (const r of rounds.filter((r) => r.prompt && r.start > b.at && r.start <= end)) {
      for (const part of r.prompt.split(/[；;\n]/)) {
        const m = part.trim().match(/^(\S+)\s*(.*)$/s);
        if (m && addresses(m[1], b.tag)) {
          outcome = replyOutcome(m[2]);
          at = r.start;
          break;
        }
      }
      if (outcome) break;
    }
    const direct = typed.find((t) => t.ts > b.at && t.ts <= end && (!at || t.ts < at) && t.ticket && addresses(t.ticket, b.tag));
    if (direct) outcome = "自己另寫";
    return { tag: b.tag, at: b.at, outcome: outcome ?? "沒回" };
  });
}

// Subcommands documented in SKILL.md and its references.
export function documentedSubcommands(dir = SKILL_DIR) {
  const files = [path.join(dir, "SKILL.md")];
  try {
    files.push(...fs.readdirSync(path.join(dir, "references")).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, "references", f)));
  } catch {}
  const subs = new Set(consoleSubcommands());
  const found = new Set();
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {}
    for (const m of text.matchAll(/console\.mjs\s+([a-z][a-z-]*)/g)) if (subs.has(m[1])) found.add(m[1]);
  }
  return [...found];
}

function cell(text) {
  return String(text ?? "—").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|") || "—";
}

function table(head, rows) {
  if (rows.length === 0) return ["（沒有資料）"];
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");

function hhmm(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The three console tables: subcommand use, where detail suggestions went, and console tokens per kind of round.
export function usageLines(since = 0, { events = readEvents(), documented = documentedSubcommands() } = {}) {
  const from = since ? new Date(since).toISOString() : "";
  const sessions = consoleCopies(events).map((c) => consoleRounds(readEntries(c.file) ?? []));
  const rounds = sessions.flatMap((rs) => rs.filter((r) => r.start >= from));
  const out = [];

  out.push("### 指令用量（中控台跑的 console.mjs 子指令）", "");
  const counts = new Map();
  for (const r of rounds) for (const c of r.calls) counts.set(c, (counts.get(c) ?? 0) + 1);
  const used = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const unused = documented.filter((s) => !counts.has(s)).sort();
  out.push(...table(["子指令", "次數"], [...used, ...unused.map((s) => [s, 0])]), "");
  if (rounds.length > 0) out.push(`SKILL.md 有寫但期間零次：${unused.join("、") || "（無）"}`, "");

  out.push("### 詳情建議去向", "");
  const typed = replies(events).filter((r) => r.via === "typed" && (!from || r.ts >= from));
  const outcomes = sessions.flatMap((rs) => suggestionOutcomes(rs, typed)).filter((x) => x.at >= from);
  out.push(
    ...(outcomes.length === 0
      ? ["（沒有資料）"]
      : table(
          ["去向", "次數", "代號"],
          OUTCOMES.map((o) => {
            const hit = outcomes.filter((x) => x.outcome === o);
            return [o, hit.length, hit.map((x) => `${x.tag}（${hhmm(x.at)}）`).join("、") || "—"];
          }),
        )),
    "",
  );

  out.push("### 中控台 token（一輪：誰觸發 × 該輪跑的子指令）", "");
  const groups = new Map();
  for (const r of rounds) {
    const combo = [...new Set(r.calls)].sort().join("+") || "（無）";
    const key = `${r.trigger}\u0000${combo}`;
    const g = groups.get(key) ?? { trigger: r.trigger, combo, n: 0, tokens: 0, usd: 0 };
    g.n++;
    g.tokens += r.tokens;
    g.usd += r.usd;
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.tokens - a.tokens);
  out.push(...table(["觸發", "子指令組合", "輪數", "總 token", "估算美元", "平均每輪"], rows.map((g) => [g.trigger, g.combo, g.n, fmt(g.tokens), `$${g.usd.toFixed(2)}`, fmt(g.tokens / g.n)])));
  return out;
}
