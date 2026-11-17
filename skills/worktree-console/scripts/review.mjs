// Pre-implementation review: what the advisor or a child decided without the user, kept per worktree until the user reviews it in the focus pane.
// Records live in ~/.worktree-console/reviews/<repo>/<branch>/review.jsonl and are only ever appended to; an item is found by worktree path and number,
// so a branch renamed mid-way still lists what was recorded under its old name.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { displayWidth } from "./lib.mjs";

export const FIELDS = { question: "題目", plan: "當前方案", basis: "依據", impact: "影響範圍" };
export const NO_PRECEDENT = "沒有前例";
export const SENTENCE_MAX = 40;
export const FILES_QUESTION = "規劃階段改了這些檔";
export const BLOCK_MESSAGE = "先跑 console.mjs review sheet、停下等使用者審核";
export const DONE_MESSAGE = (passed, edited) => `審核完成：${passed} 件通過、${edited} 件已改，請重跑剛才被擋的指令`;
const BY = new Set(["advisor", "child"]);

export const logDir = () => process.env.WORKTREE_CONSOLE_LOG_DIR || path.join(os.homedir(), ".worktree-console");
export const reviewsHome = () => path.join(logDir(), "reviews");

function gitOut(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// The worktree a path sits in: its top level, its main checkout's folder name (the repo) and its branch; null outside git.
export function worktreeOf(dir) {
  const top = gitOut(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const common = gitOut(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const main = common ? real(path.dirname(common)) : real(top);
  return { path: real(top), main, repo: path.basename(main), branch: gitOut(dir, ["branch", "--show-current"]) || "HEAD" };
}

const safeBranch = (b) => String(b || "HEAD").split("/").filter((s) => s && s !== "." && s !== "..").join("/") || "HEAD";
export const reviewFile = (repo, branch) => path.join(reviewsHome(), repo, safeBranch(branch), "review.jsonl");

function jsonl(file) {
  // A record file that exists but cannot be read is an error, not "no reviews": the gate must not let anything through on it.
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").flatMap((l, i) => {
    if (!l.trim()) return [];
    try {
      return [JSON.parse(l)];
    } catch {
      throw new Error(`審核紀錄第 ${i + 1} 行讀不懂：${file}`);
    }
  });
}

function files(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(files(p));
    else if (e.name === "review.jsonl") out.push(p);
  }
  return out;
}

// Every line recorded for a worktree, across all its branch names, in the order written.
export function linesFor(wt) {
  const all = files(path.join(reviewsHome(), wt.repo)).flatMap((f) => jsonl(f).map((l) => ({ ...l, file: f })));
  return all.filter((l) => l.path === wt.path).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || (a.seq ?? 0) - (b.seq ?? 0));
}

let seq = 0;
export function append(wt, line) {
  const file = reviewFile(wt.repo, wt.branch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const full = { at: new Date().toISOString(), seq: Date.now() * 1000 + (seq++ % 1000), path: wt.path, repo: wt.repo, branch: wt.branch, ...line };
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
  return full;
}

const strip = (s) => String(s ?? "").replace(/`[^`\n]*`/g, " ");
const CODE = [
  /[A-Za-z_$][\w$]*\([^)]*\)/,
  /=>|[=!]==|&&|\|\||::|->/,
  /[{}<>;]/,
  /^\s*(const|let|var|function|import|export|return|def|class)\s/m,
  /\$[A-Za-z_{]/,
];
const sentencesOf = (s) => String(s ?? "").split(/[。！？!?；;\n]/).map((x) => x.trim()).filter(Boolean);

// Problems with one item's visible fields: missing ones, a sentence over 40 characters, code outside inline code. Empty when it may be shown.
export function itemProblems(item) {
  const out = [];
  const fields = { question: item.question, plan: item.plan, impact: item.impact };
  for (const [k, v] of Object.entries(fields)) if (!String(v ?? "").trim()) out.push({ field: FIELDS[k], reason: "缺欄位" });
  if (!item.basis || (item.basis.kind === "precedent" && !String(item.basis.source ?? "").trim()) || (item.basis.kind !== "precedent" && item.basis.kind !== "none")) out.push({ field: FIELDS.basis, reason: "缺欄位" });
  const shown = { ...fields, basis: item.basis?.kind === "precedent" ? item.basis.source : item.basis?.note };
  for (const [k, v] of Object.entries(shown)) {
    const text = String(v ?? "");
    if (!text.trim()) continue;
    if (/```|~~~/.test(text)) out.push({ field: FIELDS[k], reason: "出現程式碼區塊" });
    else if (CODE.some((re) => re.test(strip(text)))) out.push({ field: FIELDS[k], reason: "出現行內程式碼以外的程式碼" });
    if (item.kind === "files" && k === "impact") continue;
    const long = sentencesOf(strip(text)).find((x) => Array.from(x).length > SENTENCE_MAX);
    if (long) out.push({ field: FIELDS[k], reason: `說明句超過 ${SENTENCE_MAX} 字：「${long}」` });
  }
  return out;
}

export const problemLine = (n, p) => `第 ${n} 件「${p.field}」不合格：${p.reason}`;

// `--basis 沒有前例[；補充]` or `--source <出處>` (has a precedent).
export function basisFrom({ basis, source }) {
  if (String(source ?? "").trim()) return { kind: "precedent", source: String(source).trim() };
  const b = String(basis ?? "").trim();
  if (!b) return null;
  if (b.startsWith(NO_PRECEDENT)) return { kind: "none", note: b.slice(NO_PRECEDENT.length).replace(/^[；;，,：:\s]+/, "") };
  return { kind: "precedent", source: b.replace(/^(有前例|前例)[：:\s]*/, "") };
}

// Folds a worktree's lines into its items and rounds: a round ends at each `done`; `approved` marks the worktree as past its pre-implementation review.
export function fold(lines) {
  const items = new Map();
  let round = 0;
  let approved = null;
  let lock = null;
  const sessions = new Set();
  const blocked = [];
  for (const l of lines) {
    if (l.event === "blocked") blocked.push({ session: l.session ?? null, gate: l.gate ?? null, at: l.at });
    if (l.event === "add") {
      items.set(l.n, { ...l, round, phase: approved ? "implement" : "planning", status: "pending", edit: null, asks: [], unsent: null, corrected: false });
      if (l.session) sessions.add(l.session);
    }
    const it = items.get(l.n);
    if (l.event === "correct" && it) Object.assign(it, l.fields, { corrected: true });
    if (l.event === "pass" && it) Object.assign(it, { status: "passed", edit: null });
    if (l.event === "edit" && it) Object.assign(it, { status: "edited", edit: l.to });
    if (l.event === "undo" && it) Object.assign(it, { status: "pending", edit: null });
    if (l.event === "ask" && it) it.asks.push({ q: l.q, a: l.a, example: l.example ?? null, at: l.at });
    if (l.event === "unsent" && it) it.unsent = l.reason ?? "未送出";
    if (l.event === "done") round++;
    if (l.event === "approved") approved = l.at;
    if (l.event === "cleared") approved = null;
    if (l.event === "lock") lock = { session: l.session, files: l.files ?? [], at: l.at };
    if (l.event === "approved" || l.event === "cleared") lock = null;
  }
  const list = [...items.values()];
  const open = list.filter((x) => x.round === round);
  return { items: list, open, round, approved, lock, blocked, sessions: [...sessions], lines };
}

export function stateOf(wt) {
  return fold(linesFor(wt));
}

// The open round still to be reviewed; it holds back implementation only while the worktree has no approval marker.
export const pendingCount = (st) => st.open.length;
export const gated = (st) => st.open.length > 0 && !st.approved;

export function nextNumber(st) {
  return st.items.reduce((m, x) => Math.max(m, x.n), 0) + 1;
}

export function addItem(wt, fields) {
  const st = stateOf(wt);
  const item = {
    kind: fields.kind ?? "decision",
    question: String(fields.question ?? "").trim(),
    plan: String(fields.plan ?? "").trim(),
    basis: fields.basis ?? null,
    impact: String(fields.impact ?? "").trim(),
  };
  const problems = itemProblems(item);
  const n = nextNumber(st);
  if (!BY.has(fields.by)) problems.push({ field: "誰代回", reason: "只收 advisor 或 child" });
  if (!String(fields.stop ?? "").trim()) problems.push({ field: "對應停點", reason: "缺欄位" });
  if (problems.length) return { ok: false, n, problems };
  const line = append(wt, {
    event: "add",
    id: `rv${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
    n,
    ticket: fields.ticket ?? null,
    session: fields.session ?? null,
    by: fields.by,
    stop: String(fields.stop).trim(),
    predictionId: fields.predictionId ?? null,
    ...(fields.files ? { files: fields.files } : {}),
    ...(fields.screens ? { screens: fields.screens } : {}),
    ...item,
  });
  return { ok: true, n, line };
}

export function correctItem(wt, n, fields) {
  const st = stateOf(wt);
  const it = st.items.find((x) => x.n === n);
  if (!it) return { ok: false, problems: [{ field: "編號", reason: `沒有第 ${n} 件` }] };
  const merged = { ...it, ...fields };
  const problems = itemProblems(merged);
  if (problems.length) return { ok: false, problems };
  append(wt, { event: "correct", n, fields });
  return { ok: true };
}

// The "files changed while planning" item heads the sheet and is added once per set of files.
export function addFilesItem(wt, changed, { session = null, stop = "規劃階段改檔" } = {}) {
  const st = stateOf(wt);
  const have = st.open.find((x) => x.kind === "files");
  const want = [...new Set(changed)].sort();
  if (have && want.every((f) => (have.files ?? []).includes(f))) return have;
  return addItem(wt, {
    kind: "files",
    question: FILES_QUESTION,
    plan: "先留著，由你決定留著或還原",
    basis: { kind: "none", note: "" },
    impact: want.join("、"),
    files: want,
    by: "child",
    stop,
    session,
  }).line;
}

const pad = (left, right, width) => {
  const room = width - displayWidth(right) - 2;
  let l = left;
  if (displayWidth(l) > room) {
    const chars = Array.from(l);
    while (chars.length && displayWidth(chars.join("")) > room - 1) chars.pop();
    l = `${chars.join("")}…`;
  }
  return `${l}${" ".repeat(Math.max(2, width - displayWidth(l) - displayWidth(right)))}${right}`;
};

// The order the sheet shows: 先看：沒有前例 (the files item among them), then 照你過去的回答; each section by number,
// so the numbers read top to bottom match the ones `review edit --n` takes.
export function sections(open) {
  const byN = [...open].sort((a, b) => a.n - b.n);
  const fresh = byN.filter((x) => x.kind === "files" || x.basis?.kind !== "precedent");
  const past = byN.filter((x) => x.kind !== "files" && x.basis?.kind === "precedent");
  return { fresh, past };
}

const basisText = (b) => (b?.kind === "precedent" ? b.source : [NO_PRECEDENT, b?.note].filter(Boolean).join("；"));
const LABEL_W = 10;
const label = (name) => `${name}${"　".repeat(Math.max(0, (LABEL_W - displayWidth(name)) / 2))}`;

// The sheet as text: `審核單：<代號>`, branch (and PR) on the left with the repo on the right, then the two sections; nothing else.
export function sheetLines({ tag, wt, pr = null, open, width = 70 }) {
  const { fresh, past } = sections(open);
  const out = [`審核單：${tag}`, pad(`${wt.branch}${pr ? ` · ${pr}` : ""}`, wt.repo, width)];
  if (fresh.length) {
    out.push("", "先看：沒有前例");
    for (const x of fresh) {
      out.push("", `${x.n}. ${x.question}`, `   ${label(FIELDS.plan)}${x.plan}`, `   ${label(FIELDS.basis)}${basisText(x.basis)}`, `   ${label(FIELDS.impact)}${x.impact}`);
    }
  }
  if (past.length) {
    out.push("", "照你過去的回答", "");
    for (const x of past) out.push(`${x.n}. ${x.question}`, `   ${label(FIELDS.plan)}${x.plan}（出處：${x.basis.source}）`);
  }
  return out;
}

export function sheetProblems(open) {
  return open.flatMap((x) => itemProblems(x).map((p) => problemLine(x.n, p)));
}

const statusText = (x) => (x.status === "passed" ? "通過" : x.status === "edited" ? `已改：${x.edit}` : "待審");

// The Markdown for a draft PR／MR: the sheet's items with how each was reviewed, then what was answered during implementation.
export function sheetMarkdown({ tag, items }) {
  const planning = items.filter((x) => x.phase === "planning");
  const impl = items.filter((x) => x.phase === "implement");
  const out = [`**審核單：${tag}**`, ""];
  const item = (x) => [
    `- ${x.n}. ${x.question}（${statusText(x)}${x.asks.length ? `，問過 ${x.asks.length} 輪` : ""}）`,
    `  - ${FIELDS.plan}：${x.plan}`,
    `  - ${FIELDS.basis}：${basisText(x.basis)}`,
    `  - ${FIELDS.impact}：${x.impact}`,
  ];
  if (planning.length) out.push("實作前審核", "", ...planning.flatMap(item), "");
  if (impl.length) out.push("實作階段的代回（不擋流程，請一併看）", "", ...impl.flatMap(item), "");
  return out;
}

// What the panel draws: the open round's items in sheet order with their state, and the two sections apart.
export function sheetData({ tag, wt, pr = null, st }) {
  const { fresh, past } = sections(st.open);
  const view = (x) => ({
    n: x.n,
    kind: x.kind,
    question: x.question,
    plan: x.plan,
    basis: basisText(x.basis),
    precedent: x.basis?.kind === "precedent",
    impact: x.impact,
    status: x.status,
    edit: x.edit,
    asks: x.asks,
    example: x.asks.findLast((a) => a.example)?.example ?? null,
    by: x.by,
  });
  return { tag, path: wt.path, repo: wt.repo, branch: wt.branch, pr, fresh: fresh.map(view), past: past.map(view) };
}

// The 代號 a sheet is titled with: the name or nickname the console gave the worktree, else its ticket, else the branch's last part.
export function tagOf(wt, names = {}) {
  const n = names[wt.path];
  if (n?.name) return n.name;
  if (n?.nickname) return n.nickname;
  const t = String(wt.branch).match(/([A-Za-z]+)-(\d+)/);
  return t ? `${t[1].toUpperCase()}-${t[2]}` : String(wt.branch).split("/").pop();
}

// The open PR or MR of a branch, `PR #N`／`MR !N`; null when there is none or the CLI cannot tell. `WORKTREE_CONSOLE_PR` overrides it (tests).
export function prOf(wt) {
  if (process.env.WORKTREE_CONSOLE_PR !== undefined) return process.env.WORKTREE_CONSOLE_PR || null;
  const remote = gitOut(wt.path, ["remote", "get-url", "origin"]) ?? "";
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: wt.path, encoding: "utf8", timeout: 8000 });
  try {
    if (/github\.com/.test(remote)) {
      const r = run("gh", ["pr", "list", "--head", wt.branch, "--state", "open", "--json", "number,body"]);
      const n = r.status === 0 ? JSON.parse(r.stdout || "[]")[0]?.number : null;
      return n ? `PR #${n}` : null;
    }
    if (/gitlab/.test(remote)) {
      const r = run("glab", ["mr", "list", "--source-branch", wt.branch, "--output", "json"]);
      const n = r.status === 0 ? JSON.parse(r.stdout || "[]")[0]?.iid : null;
      return n ? `MR !${n}` : null;
    }
  } catch {}
  return null;
}

// --- planning artifacts and the worktree's own changes ---

const devFlowHome = () => process.env.SARA_DEV_FLOW_HOME || path.join(os.homedir(), ".sara-dev-flow");
const handoffHome = () => process.env.AUTO_HANDOFF_HOME || path.join(os.homedir(), ".config", "claude-handoff");

// What planning may write before the review: .goals/, a dev-flow run folder, the backend's spec.md and plan.md, the auto-handoff note.
export function isPlanningArtifact(rel) {
  const p = rel.split(path.sep).join("/");
  return /^\.goals\//.test(p) || /(^|\/)docs\/dev-flow\//.test(p) || /(^|\/)(spec|plan)\.md$/.test(p) || /(^|\/)\.handoff[^/]*\.md$/.test(p);
}

// Whether an edit tool may write `file` before the review: outside the worktree, or a planning artifact inside it.
export function editAllowed(wt, file) {
  const abs = real(path.isAbsolute(file) ? file : path.join(wt.path, file));
  const rel = path.relative(wt.path, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true;
  for (const home of [devFlowHome(), handoffHome(), reviewsHome()]) {
    const r = path.relative(real(home), abs);
    if (!r.startsWith("..") && !path.isAbsolute(r)) return true;
  }
  return isPlanningArtifact(rel);
}

// Each changed file of the worktree (tracked or not) with its size and mtime, so a later look tells what a command changed.
export function snapshot(wtPath) {
  const r = spawnSync("git", ["-C", wtPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git status 失敗：${(r.stderr || "").trim()}`);
  const out = {};
  const parts = r.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const code = e.slice(0, 2);
    const file = e.slice(3);
    if (code[0] === "R" || code[0] === "C") i++;
    let sig = code;
    try {
      const s = fs.statSync(path.join(wtPath, file));
      sig = `${code}:${s.size}:${s.mtimeMs}`;
    } catch {}
    out[file] = sig;
  }
  return out;
}

export const nonPlanning = (snap) => Object.keys(snap).filter((f) => !isPlanningArtifact(f));

export function changedSince(before, after) {
  return Object.keys(after).filter((f) => before[f] !== after[f] && !isPlanningArtifact(f));
}

// --- the gate's view of a Bash command ---

function words(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (const ch of String(cmd)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch) || ";|&()".includes(ch)) {
      if (cur || has) out.push(cur);
      if (";|&()".includes(ch)) out.push(ch);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const isFlow = (w) => /(^|\/)flow\.(mjs|py)$/.test(w) || /^\$\{?FLOW\}?$/.test(w);
const isConsoleScript = (w) => /(^|\/)console\.mjs$/.test(w);
export const STATE_SUBCOMMANDS = new Set(["pass", "edit", "undo", "pass-all", "done", "approve", "clear", "unlock"]);

// Which gate a command hits: `approve` / `confirm-spec` as the word after a flow script, `handoff-files.mjs` anywhere; `reopen` is noted for the marker.
// `review` is set when the command starts with console.mjs review, which the gate always lets through (its state subcommands are the console's alone).
export function classifyCommand(cmd) {
  const w = words(cmd);
  const lead = w.findIndex((x) => isConsoleScript(x));
  const start = w.slice(0, lead).every((x) => x === "node" || /(^|\/)node$/.test(x));
  if (lead >= 0 && start && w[lead + 1] === "review") return { gate: null, review: w[lead + 2] ?? "", reopen: false };
  let gate = null;
  let reopen = false;
  for (let i = 0; i < w.length; i++) {
    if (isFlow(w[i])) {
      if (w[i + 1] === "approve") gate = gate ?? "approve";
      if (w[i + 1] === "confirm-spec") gate = gate ?? "confirm-spec";
      if (w[i + 1] === "reopen") reopen = true;
    }
    if (/(^|\/)handoff-files\.mjs$/.test(w[i])) gate = gate ?? "handoff-files";
  }
  return { gate, review: null, reopen };
}

// Whether a command writes into the reviews folder by hand (any way but console.mjs).
export function touchesReviews(cmd) {
  return /\.worktree-console\/reviews|\$\{?WORKTREE_CONSOLE_LOG_DIR\}?\/reviews/.test(String(cmd)) || String(cmd).includes(reviewsHome());
}

export const GATE_LABEL = { approve: "前端 dev-flow 的 approve", "confirm-spec": "後端的 confirm-spec", "handoff-files": "define-goal 的 handoff-files.mjs", edit: "第一次改檔" };
