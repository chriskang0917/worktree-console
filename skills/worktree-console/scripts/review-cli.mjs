// `console.mjs review <子指令>`: the commands children, the advisor, the console and the focus pane use on the review records.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, homeRunFolder, readNames, repoBase, watcherPrompt } from "./lib.mjs";
import { DELEGATE_PREFIX } from "./urgency.mjs";
import { TAKEOVER_HEAD } from "../../../hooks/auto-handoff.mjs";
import { archiveDir, isConsoleSession, readEntries, transcriptOf } from "./log.mjs";
import { advisorHome, advisorState } from "./advice.mjs";
import {
  DONE_MESSAGE,
  DONE_TEXT,
  addItem,
  append,
  basisFrom,
  correctItem,
  prOf,
  problemLine,
  real,
  reviewFile,
  sections,
  sheetData,
  sheetLines,
  sheetMarkdown,
  STATE_SUBCOMMANDS,
  sheetProblems,
  stateOf,
  tagOf,
  worktreeOf,
} from "./review.mjs";

const USAGE = "用法：console.mjs review <add|correct|sheet|data|pass|pass-all|edit|undo|ask|example|done|reviewed|elsewhere|status> [--path <worktree>] …";

function die(line) {
  console.error(line);
  process.exit(1);
}

function worktree(values) {
  const wt = worktreeOf(values.path ? real(values.path) : process.cwd());
  if (!wt) die("不在 git worktree 裡：請帶 --path <worktree>");
  return wt;
}

const number = (values) => {
  const n = Number(values.n);
  if (!Number.isInteger(n) || n < 1) die("要帶 --n <第幾件>");
  return n;
};

function item(st, n) {
  const it = st.open.find((x) => x.n === n) ?? st.items.find((x) => x.n === n);
  if (!it) die(`沒有第 ${n} 件`);
  return it;
}

// `read` turns on the answerer that reads the worktree: only the file-reading tools, confined to the worktree and `read.dirs`, no MCP.
export function modelCommand(read = null) {
  const custom = process.env.WORKTREE_CONSOLE_REVIEW_MODEL_CMD;
  if (custom) return { cmd: "sh", args: ["-c", custom] };
  const args = ["-p", "--model", process.env.WORKTREE_CONSOLE_REVIEW_MODEL || "sonnet", "--settings", '{"disableAllHooks":true}'];
  if (read) args.push("--restricted", "--strict-mcp-config", "--tools", "Read,Grep,Glob", ...read.dirs.flatMap((d) => ["--add-dir", d]));
  return { cmd: "claude", args };
}

export const ASK_TIMEOUT = 100_000;

function askModel(prompt, { read = null, cwd = os.tmpdir(), timeout = 240_000 } = {}) {
  const { cmd, args } = modelCommand(read);
  const env = { ...process.env };
  for (const k of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY"]) delete env[k];
  const r = spawnSync(cmd, args, { input: prompt, encoding: "utf8", env, cwd, timeout, killSignal: "SIGKILL" });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

const CONTEXT_MAX = 12000;
const PLAN_NAMES = new Set(["spec.md", "plan.md", "goal.md", "userflow.md", "handoff.md", "decisions.md", "assumptions.md"]);
const isDir = (d) => {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
};

function goalFiles(wt) {
  const dir = path.join(wt.main, ".goals");
  const tail = wt.branch.split("/").pop();
  for (const name of [tail, tail.replace(/^[a-z]+-\d+-/i, ""), path.basename(wt.path)]) {
    const goal = path.join(dir, `${name}.md`);
    if (fs.existsSync(goal)) return [goal, path.join(dir, `${name}.checklist.md`)].filter((f) => fs.existsSync(f));
  }
  return [];
}

function filesUnder(root, depth = 0) {
  if (depth > 3 || !isDir(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return [];
    const p = path.join(root, e.name);
    return e.isDirectory() ? filesUnder(p, depth + 1) : e.isFile() ? [p] : [];
  });
}

const lines = (out) => (out ? out.split("\n").filter(Boolean) : []);

// Planning documents this branch added or changed since it left the base, or has untracked; other tickets' old ones stay out.
function branchPlanFiles(wt) {
  const base = repoBase(wt.path);
  const fork = base ? git(wt.path, ["merge-base", base, "HEAD"]) : null;
  const changed = fork?.ok ? lines(git(wt.path, ["-c", "core.quotePath=false", "diff", "--name-only", fork.out]).out) : [];
  const untracked = lines(git(wt.path, ["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"]).out);
  return [...new Set([...changed, ...untracked])]
    .filter((f) => PLAN_NAMES.has(path.basename(f)))
    .map((f) => path.join(wt.path, f))
    .filter((f) => fs.existsSync(f));
}

// This ticket's planning files and the folders outside the worktree the answerer needs to read them.
export function ticketPlans(wt) {
  const run = homeRunFolder(wt.repo, wt.branch);
  const goals = path.join(wt.main, ".goals");
  const files = [...goalFiles(wt), ...filesUnder(run), ...branchPlanFiles(wt)];
  return { files: [...new Set(files)], dirs: [run, goals].filter(isDir) };
}

// The end of the child session's conversation: what was asked and what it said, from its copy or else its original transcript.
function talkText(sessionId) {
  if (!sessionId) return null;
  const entries = readEntries(path.join(archiveDir(), `${sessionId}.jsonl`)) ?? readEntries(transcriptOf(sessionId) ?? "") ?? [];
  const said = entries.flatMap((e) => {
    if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain) return [];
    const c = e.message?.content;
    const text = typeof c === "string" ? c : (c ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
    return text.trim() && !/^\s*</.test(text) ? [`${e.type === "user" ? "使用者" : "子 session"}：${text.trim()}`] : [];
  });
  const text = said.join("\n\n");
  return text ? text.slice(-CONTEXT_MAX) : null;
}

// The prompt for a typed question: the worktree, this ticket's planning files to read, and the child session's conversation.
export function askPrompt(wt, x, st, q) {
  const plans = ticketPlans(wt);
  const talk = talkText(x.session ?? st.sessions.at(-1));
  const prompt = [
    "使用者在審核一件 coding agent 替他做的決定，問了一個問題。",
    `程式碼在這個 worktree：${wt.path}`,
    "先讀規劃檔與相關程式碼再答，三句內白話，不寫程式碼、不用 Markdown。",
    "最後一行寫『出處：<檔案:行號>』最多三個，同一行用「、」隔開。",
    "讀完仍查不到才回『查不到：<缺什麼>』，不推測。",
    "",
    ...(plans.files.length ? ["這張票的規劃檔：", ...plans.files.map((f) => `- ${f}`), ""] : []),
    ...(talk ? ["子 session 的對話（最後一段）：", talk, ""] : []),
    "這一件：",
    itemText(x),
    ...x.asks.flatMap((r) => [`先前問：${r.q}`, `先前答：${r.a}`]),
    "",
    `問題：${q}`,
  ].join("\n");
  return { prompt, dirs: plans.dirs };
}

export function askQuestion(wt, x, st, q, ask = askModel) {
  const { prompt, dirs } = askPrompt(wt, x, st, q);
  return ask(prompt, { read: { dirs }, cwd: wt.path, timeout: ASK_TIMEOUT });
}

const itemText = (x) => [`題目：${x.question}`, `當前方案：${x.plan}`, `依據：${x.basis?.kind === "precedent" ? x.basis.source : "沒有前例"}`, `影響範圍：${x.impact}`].join("\n");

const examplesDir = (wt) => path.join(path.dirname(reviewFile(wt.repo, wt.branch)), "examples");

// An example for one item: screenshots it came with (a prototype's marked as such), else a mermaid flow for logic or one「如果…，會…」for a simple behaviour.
export function makeExample(wt, x, ask = askModel) {
  fs.mkdirSync(examplesDir(wt), { recursive: true });
  const file = path.join(examplesDir(wt), `${x.n}-${x.asks.length + 1}.md`);
  const s = x.screens ?? null;
  if (s?.before || s?.after || s?.prototype) {
    const body = [`# 第 ${x.n} 件：${x.question}`, ""];
    if (s.before || s.after) body.push(`改前`, "", s.before ? `![改前](${s.before})` : "（缺圖）", "", `改後`, "", s.after ? `![改後](${s.after})` : "（缺圖）");
    else body.push("這是原型", "", `![原型](${s.prototype})`);
    fs.writeFileSync(file, `${body.join("\n")}\n`);
    return { file, answer: s.before || s.after ? "改前改後截圖：按 o 打開" : "原型截圖（這是原型）：按 o 打開" };
  }
  const out = ask(
    [
      "下面是一件審核項目。替它寫一個讓人一眼看懂的範例，只輸出一行 JSON。",
      "邏輯複雜（有分支、多個步驟）就給流程圖：{\"kind\":\"flow\",\"mermaid\":\"flowchart TD\\n...\"}",
      "簡單行為就給一個情境：{\"kind\":\"scenario\",\"text\":\"如果…，會…\"}，40 字內、白話、不寫程式碼。",
      "",
      itemText(x),
    ].join("\n"),
  );
  let v = null;
  try {
    v = JSON.parse(String(out ?? "").match(/\{[\s\S]*\}/)?.[0] ?? "null");
  } catch {}
  if (v?.kind === "flow" && v.mermaid) {
    fs.writeFileSync(file, `# 第 ${x.n} 件：${x.question}\n\n\`\`\`mermaid\n${String(v.mermaid).trim()}\n\`\`\`\n`);
    return { file, answer: "流程圖：按 o 打開" };
  }
  const text = v?.kind === "scenario" && /如果.*會/.test(v.text ?? "") ? v.text : null;
  if (!text) return null;
  fs.writeFileSync(file, `# 第 ${x.n} 件：${x.question}\n\n${text}\n`);
  return { file, answer: text };
}

function runAdvisor(args) {
  const a = advisorState(advisorHome());
  if (!a?.script) return false;
  return spawnSync(process.execPath, [a.script, ...args], { encoding: "utf8", env: process.env, timeout: 60_000 }).status === 0;
}

// The whole sheet reviewed: the round closes, the worktree is marked as past its review, the advisor learns which guesses held.
// `elsewhere`: the user answered outside the sheet, so the items left are marked 在別處回覆 and say nothing to the advisor.
export function finishRound(wt, { by = "panel", passAll = false, elsewhere = false } = {}) {
  const st = stateOf(wt);
  if (st.open.length === 0) return { ok: false, line: "沒有待審的代回" };
  if (passAll) for (const x of st.open.filter((x) => x.status === "pending")) append(wt, { event: "pass", n: x.n, by });
  if (elsewhere) for (const x of st.open.filter((x) => x.status === "pending")) append(wt, { event: "elsewhere", n: x.n, by });
  const now = stateOf(wt);
  const left = now.open.filter((x) => x.status === "pending");
  if (left.length) return { ok: false, line: `還有 ${left.length} 件沒審：${left.map((x) => x.n).join("、")}` };
  const passed = now.open.filter((x) => x.status === "passed");
  const edited = now.open.filter((x) => x.status === "edited");
  append(wt, { event: "done", by, passed: passed.length, edited: edited.length, ns: now.open.map((x) => x.n) });
  append(wt, { event: "approved", by });
  const byPrediction = new Map();
  for (const x of now.open.filter((x) => x.predictionId && x.status !== "elsewhere")) byPrediction.set(x.predictionId, (byPrediction.get(x.predictionId) ?? true) && x.status === "passed");
  for (const [id, hit] of byPrediction) runAdvisor(["verdict", "--prediction", id, "--hit", hit ? "yes" : "no"]);
  const message = [DONE_MESSAGE(passed.length, edited.length), ...(edited.length ? ["", "已改的件：", ...edited.map((x) => `${x.n}. ${x.question}：改成 ${x.edit}`)] : [])].join("\n");
  return { ok: true, passed: passed.length, edited: edited.length, elsewhere: now.open.filter((x) => x.status === "elsewhere").length, message, sessions: now.blocked.map((b) => b.session).concat(now.sessions).filter(Boolean) };
}

// The user's own words, not something the console or the watcher sent on its own.
export function ownReply(text) {
  const t = String(text ?? "").trim();
  return !!t && !t.startsWith("/") && !watcherPrompt(t) && !t.startsWith(DELEGATE_PREFIX) && !t.startsWith("（中控台自動") && !t.startsWith(TAKEOVER_HEAD);
}

// A stop that pasted the whole review sheet of the worktree at `where`, as the gate asks when it holds a session back: the 審核單 heading
// and every item still pending, its question and plan; the gate's own 「審核單：node … review sheet」 line alone is not the sheet.
export function pastedSheet(text, where) {
  const t = String(text ?? "");
  if (!/^\s*(?:\*\*)?審核單[：:]/m.test(t)) return false;
  try {
    const wt = worktreeOf(where);
    const pending = wt ? stateOf(wt).open.filter((x) => x.status === "pending") : [];
    return pending.length > 0 && pending.every((x) => t.includes(x.question) && t.includes(x.plan));
  } catch {
    return false;
  }
}

// Answered outside the sheet: the open round of the worktree at `where` closes once, its pending items marked 在別處回覆.
export function closeElsewhere(where, { by = "reply" } = {}) {
  try {
    const wt = worktreeOf(where);
    if (!wt || !stateOf(wt).open.some((x) => x.status === "pending")) return null;
    return finishRound(wt, { by, elsewhere: true });
  } catch {
    return null;
  }
}

export async function reviewCommand(values, positionals, { deliver }) {
  const [sub] = positionals;
  if (!sub) die(USAGE);
  const caller = values.session ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
  if (STATE_SUBCOMMANDS.has(sub) && caller && !isConsoleSession(caller)) die(`review ${sub} 只有中控台與焦點面板能跑；子 session 只能用 review add／correct 記下代回。`);
  if (sub === "add") {
    const wt = worktree(values);
    const r = addItem(wt, {
      question: values.question,
      plan: values.plan,
      basis: basisFrom({ basis: values.basis, source: values.source }),
      impact: values.impact,
      by: values.by ?? "child",
      stop: values.stop,
      ticket: values.ticket ?? null,
      session: values.session ?? process.env.CLAUDE_CODE_SESSION_ID ?? null,
      predictionId: values.prediction ?? null,
      screens: values.before || values.after || values.prototype ? { before: values.before ?? null, after: values.after ?? null, prototype: values.prototype ?? null } : null,
    });
    if (!r.ok) die(["沒有寫入：", ...r.problems.map((p) => problemLine(r.n, p))].join("\n"));
    return console.log(`[${tagOf(wt, readNames())}] 已記下審核第 ${r.n} 件`);
  }
  if (sub === "correct") {
    const wt = worktree(values);
    const n = number(values);
    const fields = Object.fromEntries(Object.entries({ question: values.question, plan: values.plan, impact: values.impact }).filter(([, v]) => v !== undefined));
    if (values.basis !== undefined || values.source !== undefined) fields.basis = basisFrom({ basis: values.basis, source: values.source });
    const r = correctItem(wt, n, fields);
    if (!r.ok) die(["沒有寫入：", ...r.problems.map((p) => problemLine(n, p))].join("\n"));
    return console.log(`[${tagOf(wt, readNames())}] 已更正第 ${n} 件`);
  }
  if (sub === "sheet") {
    const wt = worktree(values);
    const st = stateOf(wt);
    const tag = tagOf(wt, readNames());
    if (st.open.length === 0) return console.log(`[${tag}] 沒有待審的代回`);
    const problems = sheetProblems(st.open);
    if (problems.length) die(["審核單不產生：", ...problems].join("\n"));
    const pr = prOf(wt);
    if (values.markdown) return console.log(sheetMarkdown({ tag, items: st.items.filter((x) => x.round === st.round || x.phase === "implement") }).join("\n"));
    return console.log(sheetLines({ tag, wt, pr, open: st.open, width: Number(values.width) || 70 }).join("\n"));
  }
  if (sub === "data") {
    const wt = worktree(values);
    const st = stateOf(wt);
    return console.log(JSON.stringify({ ...sheetData({ tag: tagOf(wt, readNames()), wt, pr: values.json ? prOf(wt) : null, st }), problems: sheetProblems(st.open) }));
  }
  if (sub === "status") {
    const wt = worktree(values);
    const st = stateOf(wt);
    return console.log(JSON.stringify({ pending: st.open.length, approved: !!st.approved, locked: !!st.lock }));
  }
  if (sub === "pass" || sub === "edit") {
    const wt = worktree(values);
    const n = number(values);
    item(stateOf(wt), n);
    if (sub === "edit" && !String(values.to ?? "").trim()) die("要帶 --to <改成什麼>");
    append(wt, sub === "pass" ? { event: "pass", n, by: values.by ?? "panel" } : { event: "edit", n, to: String(values.to).trim(), by: values.by ?? "panel" });
    return console.log(sub === "pass" ? `第 ${n} 件已通過` : `第 ${n} 件已改：${String(values.to).trim()}`);
  }
  if (sub === "undo") {
    const wt = worktree(values);
    const n = number(values);
    const x = item(stateOf(wt), n);
    if (x.status === "pending") die(`第 ${n} 件本來就是待審`);
    append(wt, { event: "undo", n, by: values.by ?? "panel" });
    return console.log(`第 ${n} 件已退回待審`);
  }
  if (sub === "pass-all") {
    const wt = worktree(values);
    const st = stateOf(wt);
    const { past } = sections(st.open);
    const left = past.filter((x) => x.status === "pending");
    for (const x of left) append(wt, { event: "pass", n: x.n, by: values.by ?? "panel" });
    return console.log(`「照你過去的回答」通過 ${left.length} 件`);
  }
  if (sub === "ask" || sub === "example") {
    const wt = worktree(values);
    const n = number(values);
    const x = item(stateOf(wt), n);
    const q = sub === "example" ? "" : String(values.q ?? "").trim();
    if (!q) {
      const ex = makeExample(wt, x);
      if (!ex) die(`第 ${n} 件的範例沒產生出來`);
      append(wt, { event: "ask", n, q: "（要範例）", a: ex.answer, example: ex.file });
      return console.log(ex.answer);
    }
    const a = askQuestion(wt, x, stateOf(wt), q);
    if (!a) die(`第 ${n} 件的問題沒有得到回答`);
    append(wt, { event: "ask", n, q, a });
    return console.log(a);
  }
  if (sub === "elsewhere") {
    const wt = worktree(values);
    const r = finishRound(wt, { by: values.by ?? "reply", elsewhere: true });
    if (!r.ok) die(r.line);
    return console.log(`[${tagOf(wt, readNames())}] 審核單已記成審完（在別處回覆 ${r.elsewhere} 件）`);
  }
  if (sub === "done" || sub === "reviewed") {
    const wt = worktree(values);
    const r = finishRound(wt, { by: values.by ?? (sub === "reviewed" ? "reply" : "panel"), passAll: sub === "reviewed" });
    if (!r.ok) die(r.line);
    const tag = tagOf(wt, readNames());
    if (sub === "reviewed") return console.log(`[${tag}] 審核單已記成審完`);
    const sent = await deliver(wt, r);
    console.log(`[${tag}] ${DONE_TEXT(r.passed, r.edited).split("，")[0]}`);
    return console.log(sent);
  }
  die(USAGE);
}
