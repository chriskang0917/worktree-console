// `console.mjs review <子指令>`: the commands children, the advisor, the console and the focus pane use on the review records.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readNames } from "./lib.mjs";
import { advisorHome, advisorState } from "./advice.mjs";
import {
  DONE_MESSAGE,
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
  sheetProblems,
  stateOf,
  tagOf,
  worktreeOf,
} from "./review.mjs";

const USAGE = "用法：console.mjs review <add|correct|sheet|data|pass|pass-all|edit|ask|example|done|reviewed|status> [--path <worktree>] …";

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

export function modelCommand() {
  const custom = process.env.WORKTREE_CONSOLE_REVIEW_MODEL_CMD;
  if (custom) return { cmd: "sh", args: ["-c", custom] };
  return { cmd: "claude", args: ["-p", "--model", process.env.WORKTREE_CONSOLE_REVIEW_MODEL || "sonnet", "--settings", '{"disableAllHooks":true}'] };
}

function askModel(prompt) {
  const { cmd, args } = modelCommand();
  const env = { ...process.env };
  for (const k of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY"]) delete env[k];
  const r = spawnSync(cmd, args, { input: prompt, encoding: "utf8", env, cwd: os.tmpdir(), timeout: 240_000, killSignal: "SIGKILL" });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

function goalText(wt) {
  const dir = path.join(wt.main, ".goals");
  const tail = wt.branch.split("/").pop();
  for (const name of [tail, tail.replace(/^[a-z]+-\d+-/i, ""), path.basename(wt.path)]) {
    try {
      return fs.readFileSync(path.join(dir, `${name}.md`), "utf8").slice(0, 12000);
    } catch {}
  }
  return "（找不到目標檔）";
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
export function finishRound(wt, { by = "panel", passAll = false } = {}) {
  const st = stateOf(wt);
  if (passAll) for (const x of st.open.filter((x) => x.status === "pending")) append(wt, { event: "pass", n: x.n, by });
  const now = stateOf(wt);
  const left = now.open.filter((x) => x.status === "pending");
  if (left.length) return { ok: false, line: `還有 ${left.length} 件沒審：${left.map((x) => x.n).join("、")}` };
  const passed = now.open.filter((x) => x.status === "passed");
  const edited = now.open.filter((x) => x.status === "edited");
  append(wt, { event: "done", by, passed: passed.length, edited: edited.length, ns: now.open.map((x) => x.n) });
  append(wt, { event: "approved", by });
  const byPrediction = new Map();
  for (const x of now.open.filter((x) => x.predictionId)) byPrediction.set(x.predictionId, (byPrediction.get(x.predictionId) ?? true) && x.status === "passed");
  for (const [id, hit] of byPrediction) runAdvisor(["verdict", "--prediction", id, "--hit", hit ? "yes" : "no"]);
  const message = [DONE_MESSAGE(passed.length, edited.length), ...(edited.length ? ["", "已改的件：", ...edited.map((x) => `${x.n}. ${x.question}：改成 ${x.edit}`)] : [])].join("\n");
  return { ok: true, passed: passed.length, edited: edited.length, message, sessions: now.blocked.map((b) => b.session).concat(now.sessions).filter(Boolean) };
}

export async function reviewCommand(values, positionals, { deliver }) {
  const [sub] = positionals;
  if (!sub) die(USAGE);
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
    const a = askModel(["使用者在審核一件 coding agent 替他做的決定，問了一個問題。用白話回答，三句內、不寫程式碼。", "", "目標檔：", goalText(wt), "", "這一件：", itemText(x), ...x.asks.flatMap((r) => [`先前問：${r.q}`, `先前答：${r.a}`]), "", `問題：${q}`].join("\n"));
    if (!a) die(`第 ${n} 件的問題沒有得到回答`);
    append(wt, { event: "ask", n, q, a });
    return console.log(a);
  }
  if (sub === "done" || sub === "reviewed") {
    const wt = worktree(values);
    const r = finishRound(wt, { by: values.by ?? (sub === "reviewed" ? "reply" : "panel"), passAll: sub === "reviewed" });
    if (!r.ok) die(r.line);
    const tag = tagOf(wt, readNames());
    if (sub === "reviewed") return console.log(`[${tag}] 審核單已記成審完`);
    const sent = await deliver(wt, r);
    console.log(`[${tag}] ${DONE_MESSAGE(r.passed, r.edited).split("，")[0]}`);
    return console.log(sent);
  }
  die(USAGE);
}
