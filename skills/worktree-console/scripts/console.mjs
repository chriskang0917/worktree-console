#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  LABELS,
  afterSendLines,
  aligningRow,
  defineGoalDefault,
  defineGoalInstall,
  setDefineGoalDefault,
  archivedLines,
  boardLines,
  childAnswer,
  isConsole,
  isRecommended,
  readArchive,
  writeArchive,
  collect,
  consoleHome,
  deliveryVerdict,
  fillTitle,
  git,
  gitFacts,
  mainCheckout,
  matchSessions,
  needsYou,
  pendingBlock,
  pendingItems,
  parseQuery,
  readDisposable,
  readTasks,
  repoLead,
  sessionHint,
  TASK_MAX,
  writeDisposable,
  writeTasks,
  realpath,
  reportLines,
  gitWorktrees,
  screenRunning,
  stageOf,
  selfInfo,
  sessionTag,
  unreadableMemory,
  stripRef,
  todoLines,
  UNSEEN,
  ALIAS,
  nameLines,
  readNames,
  writeNames,
} from "./lib.mjs";
import { consoleSessionOk, focusPayload, focusPick, focusReplied, focusSkip, loadFocus, markReported, modsActive, saveFocus, saveTitles, syncFocus, waitLine } from "./focus.mjs";
import { usageLines } from "./console-usage.mjs";
import { forgetWorktree, recordMisjudge, recordWorktree, rememberRepo, repoByName, worktreeHome } from "./herdr.mjs";
import { herdrReport } from "./herdr-report.mjs";
import { maybeTerminals, runOrca, terminals } from "./terminals.mjs";
import { commitsSince, dropBranch } from "./disposable.mjs";
import {
  archiveAll,
  clip,
  lastStop,
  logEvent,
  markDistilled,
  parseSince,
  readEvents,
  readManaged,
  readTokens,
  registerConsole,
  reportLines as logReportLines,
  sessionFor,
} from "./log.mjs";

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    path: { type: "string" },
    expect: { type: "string" },
    "define-goal": { type: "boolean", default: false },
    timeout: { type: "string", default: "60" },
    aligning: { type: "string", multiple: true, default: [] },
    terminal: { type: "string" },
    tag: { type: "string" },
    from: { type: "string" },
    file: { type: "string" },
    since: { type: "string" },
    session: { type: "string" },
    branch: { type: "string" },
    dir: { type: "string" },
    ticket: { type: "string" },
    name: { type: "string" },
    continue: { type: "boolean", default: false },
    out: { type: "string" },
    notes: { type: "string" },
    target: { type: "string" },
    nickname: { type: "string" },
    title: { type: "string" },
    set: { type: "string" },
  },
});

function fail(message) {
  console.log(message);
  process.exit(1);
}

function manager() {
  try {
    return terminals();
  } catch (error) {
    fail(error.message);
  }
}

// herdr mode remembers every repo it meets, so after one full path the repo's name is enough.
function repoArg() {
  if (!values.repo || manager().name !== "herdr") return values.repo ?? null;
  if (fs.existsSync(values.repo)) {
    const main = mainCheckout(realpath(values.repo));
    rememberRepo(main);
    return main;
  }
  return repoByName(values.repo) ?? fail(`找不到 repo「${values.repo}」：第一次請用主 checkout 的完整路徑`);
}

function load(opts, { repoOptional = false } = {}) {
  if (!values.repo && !repoOptional) fail("缺少 --repo <主 checkout 絕對路徑>");
  try {
    return collect(repoArg(), opts);
  } catch (error) {
    if (error.unsupported) fail(error.message);
    if (error.terminal) fail(`[console] ${error.terminal}-unreachable`);
    throw error;
  }
}

function screenHint(handle) {
  return manager().name === "herdr" ? `herdr pane read ${handle} --source visible` : `orca terminal read --terminal ${handle} --screen`;
}

// `[<repo>/]<票號>=<票名>`; without a repo the row goes to the launch repo's table.
function aligning(data) {
  const askDefineGoal = values.aligning.length > 0 && defineGoalInstall() !== null && defineGoalDefault() === null;
  return values.aligning.map((v) => {
    const i = v.indexOf("=");
    const head = (i < 0 ? v : v.slice(0, i)).trim();
    const title = i < 0 ? "" : v.slice(i + 1).trim();
    const slash = head.lastIndexOf("/");
    const repo = slash > 0 ? head.slice(0, slash) : data.launchRepo;
    return aligningRow(head.slice(slash + 1), title, repo, askDefineGoal);
  });
}

function board() {
  const data = load({ withTitles: true, register: true });
  registerConsole({ handle: data.self.handle, paneKey: data.self.paneKey, repo: data.launchRepo });
  const list = pendingBlock(data.rows);
  const bad = unreadableMemory();
  const names = nameLines(data.rows);
  for (const line of [...boardLines(data.rows, aligning(data)), ...(list.length > 0 ? ["", ...list] : []), ...(names.length > 0 ? ["", ...names] : []), ...(bad.length > 0 ? ["", ...bad] : [])]) console.log(line);
}

function afterSend() {
  if (positionals.length === 0) fail("缺少剛送出的票號");
  const data = load({ withTitles: true });
  const hits = positionals.flatMap((q) => matchSessions(data.rows, q)).filter((h) => h.session);
  if (modsActive(loadFocus())) {
    const view = syncFocus(data.rows, { change: (state, entries, now) => focusReplied(state, entries, hits.map(focusSession), now) });
    for (const line of [waitLine(view), ...nameLines(data.rows)]) console.log(line);
    return;
  }
  const exclude = new Set(hits.map(({ row, session }) => sessionTag(row, session)));
  const names = nameLines(data.rows);
  for (const line of [...afterSendLines(data.rows, exclude, aligning(data)), ...(names.length > 0 ? ["", ...names] : [])]) console.log(line);
}

// Stores the nickname the console's model gave a worktree; it must be 3–5 lowercase letters and unused in every repo.
function nickname() {
  const [query, nick = ""] = positionals;
  if (!query || !nick) fail("用法：console.mjs nickname --repo R <branch 或代號> <暱稱>");
  if (!ALIAS.test(nick)) fail(`[${nick}] 暱稱要 3～5 個英文小寫字母`);
  const { rows } = load({ withStage: false }, { repoOptional: true });
  const hits = [...new Set(matchSessions(rows, query).map((h) => h.row))];
  if (hits.length === 0) fail(`[${query}] 找不到這個 worktree`);
  if (hits.length > 1) fail(`[${query}] 對到多個 worktree：${hits.map((r) => r.branch).join("、")}`);
  const row = hits[0];
  const names = Object.fromEntries(Object.entries(readNames()).filter(([p]) => p !== row.path && fs.existsSync(p)));
  const taken = [
    ...Object.values(names).map((n) => n.nickname),
    ...rows.filter((r) => r !== row).flatMap((r) => [r.label, r.base, r.nickname, r.displayName, r.branch.replace(/^(.*\/)?ask-/, "")]),
  ];
  if (taken.some((t) => (t ?? "").toLowerCase() === nick)) fail(`[${nick}] 暱稱已被使用，請換一個`);
  writeNames({ ...names, [row.path]: { nickname: nick, branch: row.branch, repo: row.repo, at: Date.now() } });
  console.log(`[${nick}] 已存暱稱：${row.branch}（${row.repo}）`);
}

const focusSession = ({ row, session }) => ({ paneKey: session.paneKey, handle: session.handle, tag: sessionTag(row, session) });

// Remembers a reply for the focus band, whether the console or a band button sent it; `at` is when it was sent, so a stop after that is not taken as answered. A failure here never fails the send.
function noteReply(session) {
  if (!modsActive(loadFocus())) return;
  try {
    const { rows } = collect(repoArg(), { withStage: true });
    syncFocus(rows, { change: (state, entries, now) => focusReplied(state, entries, [session], now) });
  } catch {}
}

function archive() {
  const query = positionals[0];
  if (!query) fail("缺少代號");
  const { rows } = load({ withStage: false, withTitles: true });
  const hits = matchSessions(rows, query).filter((h) => h.session);
  if (hits.length === 0) fail(`[${query}] 找不到對應的 session`);
  const list = readArchive();
  for (const { row, session } of hits) {
    const tag = sessionTag(row, session);
    if (!list.some((a) => a.path === row.path && a.paneKey === session.paneKey)) {
      list.push({ path: row.path, paneKey: session.paneKey, source: manager().name, tag, title: row.title ?? null, at: Date.now(), kind: session.status.kind, since: session.agent?.stateStartedAt ?? null });
    }
    console.log(`[${tag}] 已封存`);
  }
  writeArchive(list);
}

// Also the 封存 tab's 取消封存 button on the focus pane, which runs it without --repo.
function unarchive() {
  const query = positionals[0];
  if (!query) fail("缺少代號");
  const { rows } = load({ withStage: false }, { repoOptional: true });
  const hits = matchSessions(rows, query).filter((h) => h.session);
  if (hits.length === 0) fail(`[${query}] 找不到對應的 session`);
  const list = readArchive();
  const drop = (row, session) => (a) => a.path === row.path && a.paneKey === session.paneKey;
  let left = list;
  for (const { row, session } of hits) {
    const tag = sessionTag(row, session);
    console.log(left.some(drop(row, session)) ? `[${tag}] 已取消封存` : `[${tag}] 沒有封存`);
    left = left.filter((a) => !drop(row, session)(a));
  }
  writeArchive(left);
}

function archived() {
  const { rows } = load({ withStage: false, withTitles: true });
  for (const line of archivedLines(rows)) console.log(line);
}

// The focus band's data for the mod, as JSON; only the console's own screen gets it, and each poll marks the band as drawn.
// `announce` names the question to print in the conversation: a new one on screen, or the one a press just put there; it counts as shown only after `focus-shown`.
function focusOut({ rows, keys }, { change = null, show = false } = {}) {
  const now = Date.now();
  const view = syncFocus(rows, { now, change, heartbeat: true });
  const fresh = view.current && !view.state.reported.includes(view.current.key);
  const announced = view.current && (show || fresh) ? view.current : null;
  const { payload, titles, firsts } = focusPayload(rows, view, { now, keys, announce: announced?.item.tag ?? null, announceKey: announced?.key ?? null });
  saveTitles(titles, firsts);
  console.log(JSON.stringify(payload));
}

function focus() {
  if (!isConsole(maybeTerminals()?.selfHandle()) || !consoleSessionOk(values.session ?? process.env.CLAUDE_CODE_SESSION_ID)) return console.log(JSON.stringify({ active: false }));
  focusOut(load({}, { repoOptional: true }));
}

// The mod ran /focus-show; it printed only if the question was still on the band, so one that left waits to be printed when it is back.
function focusShown() {
  if (!positionals[0]) fail("缺少題目代號");
  const state = loadFocus();
  if (state.current === positionals[0]) saveFocus(markReported(state, positionals[0]));
}

// A queue button, or a card picked on the pane's 待回覆 tab: that question goes on screen.
function focusPickCommand() {
  if (!positionals[0]) fail("缺少題目代號");
  focusOut(load({}, { repoOptional: true }), { change: (state) => focusPick(state, positionals[0]), show: true });
}

// 8 on the band: the question on screen goes behind the queue and the first one in the queue comes up.
function focusLater() {
  focusOut(load({}, { repoOptional: true }), { change: (state) => focusSkip(state), show: true });
}

function detail() {
  const query = positionals[0];
  if (!query) fail("缺少票號或數字");
  const { rows, keys } = load({ withStage: false, withTitles: true });
  const specific = parseQuery(query).n !== null;
  const hits = matchSessions(rows, query);
  if (hits.length === 0) fail(`[${query}] 找不到對應的 worktree 或 session`);
  const seen = new Set();
  for (const { row, session } of hits) {
    if (!specific && seen.has(row)) continue;
    seen.add(row);
    fillTitle(row, keys);
    console.log(`[${specific ? sessionTag(row, session) : row.label}] 詳情`);
    console.log(`摘要：${row.title ?? "—"}`);
    console.log(`repo: ${row.repo}`);
    console.log(`branch: ${row.branch}`);
    console.log(`worktree: ${row.path}`);
    const many = !specific && row.sessions.length >= 2;
    if (many) {
      console.log("sessions:");
      for (const s of row.sessions) {
        const prompt = (s.agent?.prompt || "").replace(/\s+/g, " ").trim();
        const said = prompt ? `最後指令：${prompt}` : sessionHint(s.agent);
        console.log(`#${s.n} ${LABELS[s.status.kind]}｜${s.handle ?? "（無 handle）"}｜${said}`);
      }
    } else {
      console.log(`terminal: ${session?.handle ?? "（無 claude 分頁）"}`);
      if (session) console.log(`狀態：${LABELS[session.status.kind]}`);
    }
    for (const s of many ? row.sessions : session ? [session] : []) {
      if (!needsYou(s.status.kind)) continue;
      console.log("");
      for (const line of reportLines(row, s.status, s)) console.log(line);
    }
  }
}

function resolve() {
  const query = positionals[0];
  if (!query) fail("缺少票號或數字");
  const { rows } = load({ withStage: false });
  const out = matchSessions(rows, query).map(({ row, session }) => ({
    repo: row.repo,
    main: row.main,
    ticket: row.ticket,
    branch: row.branch,
    path: row.path,
    handle: session?.handle ?? null,
    session: session?.n ?? null,
    tag: sessionTag(row, session),
    status: LABELS[(session?.status ?? row.status).kind],
    prompt: session ? sessionHint(session.agent) : null,
  }));
  const match = out.length === 0 ? "none" : out.length === 1 ? "one" : "many";
  console.log(JSON.stringify({ match, rows: out }));
}

function closeCheck() {
  if (!values.path) fail("缺少 --path");
  const { reasons, ignored } = closeReasons(realpath(values.path));
  console.log(reasons.length ? `blocked:${reasons.join("；")}` : "ok");
  for (const line of ignored) console.log(line);
  process.exit(reasons.length ? 1 : 0);
}

function closeReasons(target) {
  const reasons = [];
  const main = mainCheckout(target);
  if (target === main) reasons.push("這是主 checkout");
  const m = manager();
  const term = m.terminalList();
  const self = selfInfo(term.ok ? term.terminals : [], m.selfHandle());
  if (self.worktreePath === target) reasons.push("這是中控台所在的 worktree");
  if (git(target, ["status", "--porcelain"]).out !== "") reasons.push("工作區有未 commit 的改動");
  const ps = m.ps();
  if (!ps.ok) reasons.push(`${m.name} 無法查詢 session 狀態`);
  const row = ps.ok ? ps.worktrees.find((w) => realpath(w.path) === target) : null;
  if (row?.agents?.some((a) => a.paneKey !== self.paneKey && a.state === "working")) reasons.push("session 執行中");
  const ignored = git(target, ["status", "--porcelain", "--ignored"]).out.split("\n").filter((l) => l.startsWith("!!"));
  return { reasons, ignored };
}

// What the ticket left in git before its worktree goes: commits and diff against base, pushed or not, stage.
function gitOutput(target, row, facts) {
  const { base } = facts;
  const stat = base ? git(target, ["diff", "--shortstat", `${base}...HEAD`]).out : "";
  const num = (re) => Number(stat.match(re)?.[1] ?? 0);
  let stage = null;
  try {
    stage = row ? stageOf(row) : null;
  } catch {}
  return {
    base,
    commits: facts.ahead,
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?/),
    deletions: num(/(\d+) deletions?/),
    pushed: facts.ahead > 0 && facts.unpushed === 0,
    stage,
  };
}

// close-check, close every tab, check again, then remove the worktree; the branch always stays.
function close() {
  if (!values.path) fail("缺少 --path");
  const target = realpath(values.path);
  const main = mainCheckout(target);
  let row = null;
  try {
    row = collect(main, { withStage: false }).rows.find((r) => r.path === target) ?? null;
  } catch {}
  const label = row?.label ?? path.basename(target);
  const branch = row?.branch ?? git(target, ["branch", "--show-current"]).out;
  const facts = gitFacts(target, row?.baseRef ?? null);
  const output = gitOutput(target, row, facts);
  const { unpushed } = facts;
  const done = (ok, line, reason = null, extra = []) => {
    logEvent("close", { repo: row?.repo ?? path.basename(main), ticket: label, path: target, ok, reason, output });
    for (const l of [line, ...extra]) console.log(l);
    process.exit(ok ? 0 : 1);
  };
  const first = closeReasons(target);
  if (first.reasons.length) done(false, `[${label}] 未關閉：${first.reasons.join("；")}`, first.reasons.join("；"), first.ignored);
  const closed = manager().closeWorktree(target);
  if (!closed.ok) done(false, `[${label}] 未關閉：關分頁失敗（${closed.code}）`, `關分頁失敗：${closed.code}`);
  const again = closeReasons(target);
  if (again.reasons.length) done(false, `[${label}] 未關閉：分頁已關，但${again.reasons.join("；")}`, again.reasons.join("；"), again.ignored);
  const temp = readDisposable().find((d) => d.kind === "worktree" && d.path === target) ?? null;
  const commits = temp ? commitsSince(temp) : 0;
  const removed = git(main, ["worktree", "remove", target]);
  if (!removed.ok) done(false, `[${label}] 未關閉：分頁已關，移除 worktree 失敗：${removed.err}`, `移除 worktree 失敗：${removed.err}`);
  try {
    writeArchive(readArchive().filter((a) => a.path !== target));
  } catch {}
  forgetWorktree(target);
  if (temp) {
    const dropped = dropBranch(temp, commits);
    try {
      writeDisposable(readDisposable().filter((d) => d.path !== target));
    } catch {}
    if (dropped || !temp.branch) done(true, `[${label}] 已關閉：暫存 worktree 已移除`);
    done(true, `[${label}] 已關閉：暫存 worktree 已移除，branch ${temp.branch} 保留${commits > 0 ? `（含 ${commits} 個 commit）` : ""}`);
  }
  done(true, `[${label}] 已關閉：worktree 已移除，branch ${branch} 保留${unpushed > 0 ? `（含 ${unpushed} 個未 push commit）` : ""}`);
}

const TRUST = /trust (the files|this folder)|Do you trust/i;
const ONBOARDING = /Choose the text style|Select login method|Let's get started|Welcome to Claude Code/i;
const DEFINE_GOAL_LOADED = /Skill\([^)]*define-goal|(Successfully )?loaded skill[^\n]*define-goal/i;

async function awaitStart() {
  if (!values.path || !values.expect) fail("缺少 --path 或 --expect");
  const target = realpath(values.path);
  const { ok, label, repo, reason } = await waitStart(target, values.expect, values["define-goal"]);
  logEvent("start", { repo, ticket: label, path: target, ok, reason: ok ? null : reason, defineGoal: values["define-goal"] });
  print(ok ? `[${label}] 已開工` : `[${label}] 未開工：${reason}`, ok ? 0 : 1);
}

async function waitStart(target, expect, defineGoal = false) {
  const deadline = Date.now() + Number(values.timeout) * 1000;
  const interval = Number(process.env.AWAIT_INTERVAL_MS || 2000);
  let label = target;
  let repo = path.basename(mainCheckout(target));
  let started = false;
  let reason = "逾時";
  for (;;) {
    let data;
    try {
      data = collect(mainCheckout(target), { withStage: false });
    } catch (error) {
      if (!error.terminal) throw error;
      reason = `${error.terminal} 無法連線`;
      break;
    }
    const row = data.rows.find((r) => r.path === target);
    if (row) label = row.label;
    const agent = row?.agents.find((a) => (a.prompt || "").startsWith(expect));
    if (agent && agent.state !== "idle") started = true;
    const screen = row?.handles[0] ? screenText(row.handles[0].handle) : "";
    if (!started && TRUST.test(screen)) reason = "卡在 trust 對話框";
    else if (!started && ONBOARDING.test(screen)) reason = "卡在 onboarding 對話框";
    if (row) repo = row.repo;
    if (started && !defineGoal) return { ok: true, label, repo, reason: null };
    if (started && defineGoal) {
      const asked = agent.state === "done" && /[?？]/.test(agent.lastAssistantMessage || "");
      if (DEFINE_GOAL_LOADED.test(screen) || asked) return { ok: true, label, repo, reason: null };
      if (agent.state === "done") {
        reason = "define-goal 未啟動";
        break;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, interval));
  }
  return { ok: false, label, repo, reason };
}

const EXPECT_MAX = 40;

function paneOf(handle) {
  const term = manager().terminalList();
  const t = term.ok ? term.terminals.find((x) => x.handle === handle) : null;
  return t ? `${t.tabId}:${t.leafId}` : null;
}

function saveTask(paneKey, title, handle) {
  if (!paneKey) return;
  writeTasks({ ...readTasks(), [paneKey]: { title: Array.from(title.trim()).slice(0, TASK_MAX).join(""), handle, source: manager().name, at: Date.now() } });
}

// The task title of a session the console just opened, for its focus card.
function title() {
  const text = positionals.join(" ").trim();
  if (!values.terminal || !text) fail("用法：console.mjs title --terminal <handle> -- <任務標題>");
  const paneKey = paneOf(values.terminal);
  if (!paneKey) fail(`找不到分頁 ${values.terminal}`);
  saveTask(paneKey, text, values.terminal);
}

function repoMatch() {
  if (!positionals[0]) fail("用法：console.mjs repo-match --repo R <開頭那個字>");
  const data = load({ withStage: false });
  const hit = repoLead(positionals[0], data.repos, data.rows);
  console.log(JSON.stringify({ match: hit.match, ...(hit.repo ? { repo: hit.repo.name } : {}), ...(hit.repos ? { repos: hit.repos.map((r) => r.name) } : {}) }));
}

// 「問 <repo>：…」: a temporary worktree with the question as its first instruction. Orca cannot open a tab in a detached
// worktree, so it gets a throwaway branch that goes with it when it is removed.
async function ask() {
  if (manager().name !== "orca") fail("「問 <repo>：…」目前只支援 Orca");
  const question = positionals.join(" ").trim();
  const nick = values.nickname ?? "";
  if (!values.target || !nick || !values.title || !question) fail("用法：console.mjs ask --repo R --target <repo> --nickname <暱稱> --title <任務標題> -- <問題>");
  if (!ALIAS.test(nick)) fail(`[${nick}] 暱稱要 3～5 個英文小寫字母`);
  const data = load({ withStage: false });
  const lead = repoLead(values.target, data.repos);
  if (lead.match === "many") fail(`「${values.target}」對到多個 repo：${lead.repos.map((r) => r.name).join("、")}`);
  if (lead.match !== "one") fail(`找不到 repo「${values.target}」`);
  const saved = Object.entries(readNames()).filter(([p]) => fs.existsSync(p)).map(([, n]) => n.nickname);
  if (saved.includes(nick) || data.rows.some((r) => r.label.toLowerCase() === nick || (r.branch === `ask-${nick}` || r.branch.endsWith(`/ask-${nick}`)))) fail(`[${nick}] 暱稱已被使用，請換一個`);
  const created = runOrca(["worktree", "create", "--repo", `path:${lead.repo.main}`, "--name", `ask-${nick}`, "--no-parent", "--setup", "skip", "--agent", "claude", "--prompt", question]);
  const made = created.ok ? created.result?.worktree?.path : null;
  if (!made) fail(`[${nick}] 未開工：開 worktree 失敗（${created.error?.code ?? "沒有路徑"}）`);
  const target = realpath(made);
  const rec = {
    kind: "worktree",
    source: manager().name,
    path: target,
    main: lead.repo.main,
    repo: lead.repo.name,
    branch: git(target, ["branch", "--show-current"]).out || null,
    start: git(target, ["rev-parse", "HEAD"]).out || null,
    nickname: nick,
    title: Array.from(values.title.trim()).slice(0, TASK_MAX).join(""),
    at: Date.now(),
  };
  writeDisposable([...readDisposable().filter((d) => d.path !== target), rec]);
  runOrca(["worktree", "set", "--worktree", `path:${target}`, "--display-name", nick]);
  const handle = created.result?.agentTerminalHandle ?? created.result?.startupTerminal?.handle ?? null;
  if (handle) saveTask(paneOf(handle), rec.title, handle);
  const { ok, reason } = await waitStart(target, Array.from(question).slice(0, EXPECT_MAX).join(""));
  if (ok) writeDisposable(readDisposable().map((d) => (d.path === target ? { ...d, seen: true } : d)));
  print(ok ? `[${nick}] 已開暫存 worktree（${lead.repo.name}），問題已送出` : `[${nick}] 未開工：${reason}`, ok ? 0 : 1);
}

// 「<代號> 問：…」: one more tab in that worktree, marked throwaway, with the question as its first instruction.
async function askTab() {
  const [query, ...words] = positionals;
  const question = words.join(" ").trim();
  if (!query || !question || !values.title) fail("用法：console.mjs ask-tab --repo R --title <任務標題> <代號> -- <問題>");
  const data = load({ withStage: false });
  const rows = [...new Set(matchSessions(data.rows, query).map((h) => h.row))];
  if (rows.length === 0) fail(`[${query}] 找不到這個代號`);
  if (rows.length > 1) fail(`[${query}] 對到多個 worktree：${rows.map((r) => r.label).join("、")}`);
  const row = rows[0];
  if (row.isMain) fail(`[${row.label}] 主 checkout 不開臨時分頁，改用「問 ${row.repo}：…」`);
  const m = manager();
  const created = m.create(row.path);
  if (!created.ok) fail(`[${row.label}] 未開臨時分頁：${created.code}`);
  const handle = created.handle;
  const idle = m.waitReady(handle, 60000);
  if (!idle.ok) fail(`[${row.label}] 未開臨時分頁：等分頁就緒（${idle.code}）`);
  const paneKey = paneOf(handle);
  writeDisposable([...readDisposable(), { kind: "tab", source: m.name, paneKey, handle, path: row.path, title: values.title.trim(), at: Date.now() }]);
  saveTask(paneKey, values.title, handle);
  let tag = row.label;
  try {
    const now = load({ withStage: false }).rows.find((r) => r.path === row.path);
    const s = now?.sessions.find((x) => x.paneKey === paneKey);
    if (s) tag = sessionTag(now, s);
  } catch {}
  const result = await deliver(handle, question);
  if (landed(result)) return print(`[${tag}] 已開臨時分頁，問題已送出`, 0);
  print(`[${tag}] 未送達：${result.reason}`, 1);
}

function screenText(handle) {
  const res = manager().readScreen(handle);
  return res.ok ? (res.terminal?.tail ?? []).join("\n") : "";
}

function print(line, code) {
  console.log(line);
  process.exit(code);
}

function parseAnswers(text) {
  return text.split(/[；;]/).map((part) => {
    const t = part.trim();
    if (/^\d+$/.test(t)) return { pick: Number(t) };
    if (/^[a-z]$/i.test(t)) return { pick: t.toLowerCase().charCodeAt(0) - 96 };
    const other = t.match(/^其他\s*[:：]\s*([\s\S]+)$/);
    return other ? { other: other[1].trim() } : { bad: t };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALLOW = /^(允許|1|allow|yes|y)$/i;
const DENY = /^(拒絕|deny|no|n|esc)$/i;

async function answer() {
  const [query, ...words] = positionals;
  if (!query || words.length === 0) fail("用法：console.mjs answer --repo R <票號>[#n] <編號｜其他：文字｜允許｜拒絕>[；…]");
  const { rows } = load({ withStage: false }, { repoOptional: true });
  const hits = matchSessions(rows, query).filter((h) => h.session);
  if (hits.length !== 1) fail(`[${query}] ${hits.length === 0 ? "找不到對應的 session" : `對應到 ${hits.length} 個 session，請加 #n`}`);
  return answerSession(hits[0].row, hits[0].session, words.join(" "));
}

async function answerSession(row, session, said) {
  const tag = sessionTag(row, session);
  if (!session.handle) fail(`[${tag}] 找不到這個 session 的終端機`);
  const at = Date.now();
  const record = (fields) => {
    logEvent("answer", { repo: row.repo, ticket: tag, handle: session.handle, paneKey: session.paneKey, ...fields });
    if (fields.delivery === "delivered") noteReply({ paneKey: session.paneKey, handle: session.handle, tag, at });
  };
  if (session.status.kind === "permission") return permit(tag, session, said.trim(), record);
  const questions = session.status.menu;
  if (session.status.kind !== "waiting" || !questions) fail(`[${tag}] 目前沒有開著的選單或授權請求`);
  if (questions.some((q) => q.multiSelect)) fail(`[${tag}] 可複選題不代按，請改用文字轉達`);
  const answers = parseAnswers(said);
  if (answers.length !== questions.length) fail(`[${tag}] 選單有 ${questions.length} 題，收到 ${answers.length} 個答案`);
  const keys = [];
  const picked = [];
  let off = false;
  const recs = questions.map((q) => (q.options ?? []).findIndex(isRecommended));
  answers.forEach((a, i) => {
    const options = questions[i].options ?? [];
    const name = questions[i].header || `第 ${i + 1} 題`;
    if (a.bad !== undefined) fail(`[${tag}] 看不懂「${a.bad}」：請給編號或「其他：<文字>」`);
    if (a.pick === options.length + 1) fail(`[${tag}] ${name} 選「其他」時請寫成「其他：<文字>」`);
    if (a.pick !== undefined && (a.pick < 1 || a.pick > options.length)) fail(`[${tag}] ${name} 沒有第 ${a.pick} 項`);
    // A question with previews only moves the cursor on a digit, and its 其他 has no text box to type into.
    const preview = options.some((o) => o.preview);
    if (preview && a.other !== undefined) fail(`[${tag}] ${name} 有預覽框，選「其他」不代按：請改用文字轉達`);
    if (recs[i] >= 0 && a.pick !== recs[i] + 1) off = true;
    if (a.pick !== undefined) {
      keys.push(...(preview ? [{ key: String(a.pick) }, { key: "enter" }] : [{ key: String(a.pick) }]));
      picked.push(`${name}→${options[a.pick - 1].label}`);
    } else {
      keys.push({ key: String(options.length + 1) }, { text: a.other }, { key: "enter" });
      picked.push(`${name}→其他「${a.other}」`);
    }
  });
  if (questions.length > 1) keys.push({ key: "1" });
  const suggestion = recs.some((r) => r >= 0) ? clip(recs.map((r, i) => (r >= 0 ? questions[i].options[r].label : "—")).join("；")) : null;
  const fields = { via: "menu", suggestion, answer: clip(picked.join("；")), offSuggestion: off };
  const gap = Number(process.env.ANSWER_KEY_DELAY_MS || 600);
  const m = manager();
  for (const k of keys) {
    const res = k.text !== undefined ? m.type(session.handle, k.text) : m.key(session.handle, k.key);
    if (!res.ok) {
      record({ ...fields, delivery: `failed: 送出失敗：${res.code}` });
      fail(`[${tag}] 送出失敗：${res.code}`);
    }
    await sleep(gap);
  }
  if (await leftWaiting(session, (a) => !(["waiting", "blocked"].includes(a.state) && a.toolName === "AskUserQuestion"))) {
    record({ ...fields, delivery: "delivered" });
    return print(`[${tag}] 已選擇：${picked.join("；")}`, 0);
  }
  record({ ...fields, delivery: "failed: 選單還開著" });
  print(`[${tag}] 已送出，但選單還開著：請用 \`${screenHint(session.handle)}\` 看畫面`, 1);
}

// 🔐: allow presses 1, deny presses Esc; anything else is not an answer to a permission prompt.
async function permit(tag, session, word, record) {
  const allow = ALLOW.test(word);
  if (!allow && !DENY.test(word)) fail(`[${tag}] 授權請求只能回「允許」或「拒絕」；要改說別的請先拒絕再用文字轉達`);
  const fields = { via: "permission", suggestion: null, answer: allow ? "允許" : "拒絕" };
  const res = manager().key(session.handle, allow ? "1" : "esc");
  if (!res.ok) {
    record({ ...fields, delivery: `failed: 送出失敗：${res.code}` });
    fail(`[${tag}] 送出失敗：${res.code}`);
  }
  if (await leftWaiting(session, (a) => !["waiting", "blocked"].includes(a.state))) {
    record({ ...fields, delivery: "delivered" });
    return print(`[${tag}] ${allow ? "已允許" : "已拒絕"}`, 0);
  }
  record({ ...fields, delivery: "failed: 授權請求還開著" });
  print(`[${tag}] 已送出，但授權請求還開著：請用 \`${screenHint(session.handle)}\` 看畫面`, 1);
}

async function leftWaiting(session, gone) {
  const deadline = Date.now() + Number(values.timeout) * 1000;
  for (;;) {
    const agent = manager().agentAt(session.paneKey);
    if (agent && gone(agent)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Number(process.env.AWAIT_INTERVAL_MS || 2000));
  }
}

const landed = (result) => ["delivered", "queued"].includes(result.verdict);
const SCREEN_TAIL = 8;

async function deliver(handle, text) {
  const m = manager();
  const res = m.send(handle, text, { enter: true });
  if (!res.ok) return { verdict: "failed", reason: `送出失敗：${res.code}`, lines: [] };
  const tries = Number(process.env.SEND_CHECK_TRIES || 3);
  const gap = Number(process.env.SEND_CHECK_MS ?? 1000);
  let result = { verdict: "failed", reason: "讀不到畫面", lines: [] };
  for (let i = 0; i < tries; i++) {
    await sleep(gap);
    const read = m.readScreen(handle);
    if (!read.ok) {
      result = { verdict: "failed", reason: `讀不到畫面：${read.code}`, lines: [] };
      continue;
    }
    result = { ...deliveryVerdict(read.terminal, text), lines: read.terminal?.tail ?? [] };
    if (landed(result)) break;
  }
  return result;
}

async function send() {
  const handle = values.terminal;
  const text = positionals.join(" ");
  if (!handle || !text.trim()) fail("用法：console.mjs send --terminal <handle> --tag <代號> -- <文字>");
  return sendText(handle, values.tag ?? handle, text);
}

const IDLE_STATES = new Set(["done", "idle"]);

// Unknown counts as running: Esc on a running session interrupts its work.
function childRunning(handle, lines) {
  if (screenRunning(lines)) return true;
  return !IDLE_STATES.has(manager().agentOf(handle)?.state);
}

async function sendText(handle, tag, text) {
  const at = Date.now();
  let result = await deliver(handle, text);
  let note = "";
  const unseen = result.verdict === "retry" || result.reason === UNSEEN;
  if (unseen && childRunning(handle, result.lines)) result = { verdict: "unconfirmed", lines: result.lines };
  else if (result.verdict === "retry") {
    const reason = result.reason;
    const esc = manager().key(handle, "esc");
    if (!esc.ok) result = { verdict: "failed", reason: `${reason}，送 Esc 失敗：${esc.code}`, lines: result.lines };
    else {
      await sleep(Number(process.env.SEND_CHECK_MS ?? 1000));
      result = await deliver(handle, text);
      note = "（已按 Esc 退回對話後重送）";
      if (!landed(result)) result = { ...result, reason: `${reason}，按 Esc 退回對話重送後仍沒看到這句話` };
    }
  }
  const stop = lastStop(handle);
  const known = readManaged()?.handles?.[handle] ?? null;
  logEvent("answer", {
    repo: stop?.repo ?? known?.repo ?? null,
    ticket: stop?.ticket ?? known?.ticket ?? tag,
    handle,
    paneKey: stop?.paneKey ?? known?.paneKey ?? null,
    via: "text",
    suggestion: stop?.suggestion ?? null,
    answer: clip(text),
    delivery: landed(result) || result.verdict === "unconfirmed" ? result.verdict : `failed: ${result.reason}`,
  });
  if (landed(result) || result.verdict === "unconfirmed") noteReply({ paneKey: stop?.paneKey ?? known?.paneKey ?? null, handle, tag, at });
  if (result.verdict === "delivered") return print(`[${tag}] 已送出${note}`, 0);
  if (result.verdict === "queued") return print(`[${tag}] 已送出（排隊中）${note}`, 0);
  if (result.verdict === "unconfirmed") return print(`[${tag}] 已送出（子 session 執行中，畫面上還沒看到這句，等它停下再確認）`, 0);
  console.log(`[${tag}] 未送達：${result.reason}`);
  const tail = result.lines.filter((l) => l.trim()).slice(-SCREEN_TAIL);
  if (tail.length > 0) console.log(["畫面最後幾行：", "```", ...tail, "```"].join("\n"));
  process.exit(1);
}

// Focus mode: a message that starts with a waiting session's tag goes there, anything else to the question on the band; a, b, c become the child's own codes.
async function reply() {
  const text = positionals.join(" ").trim();
  if (!text) fail("用法：console.mjs reply --repo R -- <整則訊息>");
  const { rows } = load({}, { repoOptional: true });
  const head = text.split(/\s+/)[0];
  const rest = text.slice(head.length).trim();
  const sessions = matchSessions(rows, head).map((h) => h.session);
  const named = rest ? pendingItems(rows).filter((x) => sessions.includes(x.session)) : [];
  if (named.length > 1) fail(`「${head}」對應到 ${named.length} 個在等你的 session，請加 #n`);
  let item = named[0] ?? null;
  if (!item) {
    item = syncFocus(rows).current?.item ?? null;
    if (!item) fail("橫條上目前沒有題目：請在開頭寫代號");
  }
  const said = childAnswer(item, item === named[0] ? rest : text);
  if (item.kind === "anomaly") return sendRaw(item, said);
  if (item.kind === "text") {
    if (!item.session.handle) fail(`[${item.tag}] 找不到這個 session 的終端機`);
    return sendText(item.session.handle, item.tag, said);
  }
  return answerSession(item.row, item.session, said);
}

// ⚠️: nobody knows what the child waits on, so the reply is typed verbatim and Enter pressed, past herdr's blocked guard.
function sendRaw(item, text) {
  const { tag, row, session } = item;
  if (!session.handle) fail(`[${tag}] 找不到這個 session 的終端機`);
  const m = manager();
  const typed = m.type(session.handle, text);
  const res = typed.ok ? m.key(session.handle, "enter") : typed;
  logEvent("answer", { repo: row.repo, ticket: tag, handle: session.handle, paneKey: session.paneKey, via: "raw", suggestion: null, answer: clip(text), delivery: res.ok ? "unconfirmed" : `failed: 送出失敗：${res.code}` });
  if (!res.ok) fail(`[${tag}] 送出失敗：${res.code}`);
  print(`[${tag}] 已原文送出（session 異常，請到分頁確認）`, 0);
}

const GOAL_SET = /Goal set/;
const PASTED_GOAL = /Pasted text|paste again to expand/;

// define-goal → execution: open a new tab in the worktree, send the /goal text, and close the interview tab once it took.
async function handoff() {
  if (!values.path || !values.from || !values.file) fail("用法：console.mjs handoff --path <worktree> --from <訪談 handle> --file <\/goal 暫存檔>");
  const target = realpath(values.path);
  let row = null;
  try {
    row = collect(mainCheckout(target), { withStage: false }).rows.find((r) => r.path === target) ?? null;
  } catch {}
  const label = row?.label ?? path.basename(target);
  const goal = fs.readFileSync(values.file, "utf8").trim();
  const m = manager();
  let handle = null;
  const done = (ok, line, reason = null) => {
    logEvent("handoff", {
      repo: row?.repo ?? path.basename(mainCheckout(target)),
      ticket: label,
      path: target,
      kind: "define-goal",
      ok,
      reason,
      oldHandle: values.from,
      newHandle: handle,
      oldSessionId: sessionFor(values.from),
      newSessionId: sessionFor(handle),
      terminal: m.name,
      goalLength: Array.from(goal).length,
    });
    console.log(line);
    if (!ok) console.log(["\/goal 原文：", "```", goal, "```"].join("\n"));
    process.exit(ok ? 0 : 1);
  };
  const created = m.create(target, { label });
  handle = created.ok ? created.handle : null;
  if (!handle) done(false, `[${label}] 交棒失敗：開新分頁（${created.code}），訪談分頁保留`, `開新分頁：${created.code}`);
  const idle = m.waitReady(handle, 60000);
  if (!idle.ok) done(false, `[${label}] 交棒失敗：等新分頁就緒（${idle.code}），訪談分頁保留`, "等新分頁就緒");
  const sent = m.send(handle, goal, { enter: true });
  if (!sent.ok) done(false, `[${label}] 交棒失敗：送出 \/goal（${sent.code}），訪談分頁保留`, `送出 /goal：${sent.code}`);
  let screen = "";
  for (let i = 0; i < Number(process.env.SEND_CHECK_TRIES || 5); i++) {
    await sleep(Number(process.env.SEND_CHECK_MS ?? 2000));
    screen = screenText(handle);
    if (GOAL_SET.test(screen)) break;
  }
  if (!GOAL_SET.test(screen)) {
    const pasted = PASTED_GOAL.test(screen) || /<pasted_content/.test(m.lastPrompt?.(handle) ?? "");
    const why = pasted ? "被當成貼上內容收起，請先清空新分頁的輸入框再貼" : "畫面沒看到 Goal set";
    done(false, `[${label}] 交棒失敗：${why}，訪談分頁保留`, why);
  }
  const task = readTasks()[paneOf(values.from)];
  if (task) saveTask(paneOf(handle), task.title, handle);
  const closed = m.closeTab(values.from);
  if (!closed.ok) done(false, `[${label}] 交棒失敗：新分頁已接手，關訪談分頁失敗（${closed.code}）`, `關訪談分頁：${closed.code}`);
  done(true, `[${label}] 已交棒執行`);
}

function report() {
  let since;
  try {
    since = parseSince(values.since);
  } catch (error) {
    fail(error.message);
  }
  archiveAll();
  for (const line of [...logReportLines(readEvents(since), readTokens(), since), "", ...usageLines(since)]) console.log(line);
}

function distilled() {
  console.log(markDistilled());
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(consoleHome(), "config.json"), "utf8"));
  } catch {
    return null;
  }
}

function todo() {
  if (!values.repo) fail("缺少 --repo <主 checkout 絕對路徑>");
  const config = readConfig();
  if (!config) return print("skip:no-config", 0);
  const prefixes = config.titlePrefixes ?? [];
  if (prefixes.length === 0) return print("skip:disabled", 0);
  const excluded = new Set(config.excludeLabels ?? []);
  const m = manager();
  const res = m.linearTodo();
  if (!res.ok) return print(`skip:${res.code}`, 0);
  let snap;
  try {
    snap = m.snapshot({ agents: false });
  } catch {
    return print(`skip:${m.name}-unreachable`, 0);
  }
  const worktrees = snap.worktrees;
  const mains = [mainCheckout(realpath(repoArg())), ...snap.repos.map((r) => r.path)];
  const started = (id) => {
    const lower = id.toLowerCase();
    if (mains.some((m) => fs.existsSync(path.join(m, ".goals", `${lower}.md`)))) return true;
    const inBranch = new RegExp(`(^|[^a-z0-9])${lower}(?!\\d)`);
    return worktrees.some(
      (w) => (w.linkedLinearIssue ?? "").toUpperCase() === id || inBranch.test(stripRef(w.branch).toLowerCase()),
    );
  };
  const hits = res.issues.filter(
    (i) =>
      i.cycle &&
      prefixes.some((p) => i.title.startsWith(p)) &&
      !(i.labels ?? []).some((l) => excluded.has(l.name)) &&
      !started(i.identifier),
  );
  for (const line of todoLines(hits)) console.log(line);
}

// A claude tab in a worktree that has none (idle row), `--continue` picks its last conversation back up.
function open() {
  if (!values.path) fail("用法：console.mjs open --path <worktree> [--continue]");
  const target = realpath(values.path);
  const m = manager();
  const created = m.create(target, { args: values.continue ? ["--continue"] : [] });
  if (!created.ok) fail(`未開分頁：${created.code}`);
  const ready = m.waitReady(created.handle, 60000);
  if (!ready.ok) fail(`未就緒：${ready.code}（terminal ${created.handle}）`);
  console.log(`terminal: ${created.handle}`);
}

// herdr mode's 開工: git worktree, the console's own ticket record, a tab running claude, then the first instruction.
function start() {
  const text = positionals.join(" ").trim();
  if (!values.repo || !values.branch || !values.dir || !text) {
    fail("用法：console.mjs start --repo R --branch B --dir <資料夾名稱> [--ticket KEY-n | --name <暱稱>] [--define-goal] [--path P] -- <首則指令>");
  }
  const m = manager();
  if (m.name !== "herdr") fail("Orca 模式照 kickoff.md 用 orca worktree create 開工");
  const main = mainCheckout(realpath(repoArg()));
  rememberRepo(main);
  const label = values.ticket?.toUpperCase() ?? values.name ?? values.branch;
  let target = gitWorktrees(main).find((w) => w.branch === values.branch)?.path ?? null;
  if (!target) {
    const want = values.path ? path.resolve(values.path) : path.join(worktreeHome(), path.basename(main), values.dir);
    const has = git(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${values.branch}`]).ok;
    fs.mkdirSync(path.dirname(want), { recursive: true });
    const add = git(main, ["worktree", "add", ...(has ? [want, values.branch] : ["-b", values.branch, want])]);
    if (!add.ok) fail(`[${label}] 未開工：建 worktree 失敗：${add.err}`);
    target = realpath(want);
    recordWorktree(target, { ticket: values.ticket?.toUpperCase() ?? null, displayName: values.name ?? null, defineGoal: values["define-goal"], repo: path.basename(main) });
  }
  const opened = m.create(target, { label });
  if (!opened.ok) fail(`[${label}] 未開工：開分頁失敗（${opened.code}）`);
  console.log(`worktree: ${target}`);
  console.log(`terminal: ${opened.handle}`);
  if (!opened.ready) fail(`[${label}] 未開工：新分頁沒就緒（${opened.code}），用 \`${screenHint(opened.handle)}\` 看畫面`);
  const sent = m.send(opened.handle, text, { enter: true });
  if (!sent.ok) fail(`[${label}] 未開工：送首則指令失敗（${sent.code}）`);
}

const ACTUAL = [
  [/授權|允許|permission/i, "permission"],
  [/選單|回應|回答|問|waiting/i, "waiting"],
  [/執行|在跑|working|busy/i, "busy"],
  [/完畢|回完|done/i, "done"],
  [/閒置|idle/i, "idle"],
];

// 「<代號> 狀態錯了，其實是 X」: what the board showed next to what the user saw, for the herdr evaluation.
function misjudge() {
  const [query, ...words] = positionals;
  const actual = words.join(" ").trim();
  if (!query || !actual) fail("用法：console.mjs misjudge --repo R <代號>[#n] <實際狀態>");
  const m = manager();
  const { rows } = load({ withStage: false }, { repoOptional: true });
  const hits = matchSessions(rows, query).filter((h) => h.session);
  if (hits.length !== 1) fail(`[${query}] ${hits.length === 0 ? "找不到對應的 session" : `對應到 ${hits.length} 個 session，請加 #n`}`);
  const { row, session } = hits[0];
  const tag = sessionTag(row, session);
  const shown = session.status.kind;
  recordMisjudge({
    terminal: m.name,
    repo: row.repo,
    ticket: tag,
    handle: session.handle,
    shown,
    herdr: session.agent?.herdr?.raw ?? null,
    inferred: session.agent?.herdr?.inferred ?? null,
    actual,
    actualKind: ACTUAL.find(([re]) => re.test(actual))?.[1] ?? null,
  });
  console.log(`[${tag}] 已記下誤判：看板顯示 ${LABELS[shown]}，實際是「${actual}」`);
}

const ON_OFF = { on: true, off: false };

function defineGoalCommand() {
  if (values.set !== undefined) {
    if (!(values.set in ON_OFF)) fail("用法：console.mjs define-goal [--set on|off]");
    setDefineGoalDefault(ON_OFF[values.set]);
    return console.log(`define-goal 預設：${ON_OFF[values.set] ? "開" : "關"}`);
  }
  const found = defineGoalInstall();
  if (!found) return console.log("define-goal 未安裝");
  const on = defineGoalDefault();
  console.log(`指令：${found.command}`);
  console.log(`目錄：${found.dir}`);
  console.log(`預設：${on === null ? "未設定" : on ? "開" : "關"}`);
}

function herdrReportCommand() {
  let since;
  try {
    since = parseSince(values.since);
  } catch (error) {
    fail(error.message);
  }
  const { file, conclusion } = herdrReport({ since, out: values.out, notes: values.notes });
  console.log(`報告：${file}`);
  for (const line of conclusion) console.log(line);
}

const commands = {
  board,
  todo,
  "after-send": afterSend,
  detail,
  resolve,
  answer,
  send,
  "close-check": closeCheck,
  close,
  "await-start": awaitStart,
  "define-goal": defineGoalCommand,
  handoff,
  report,
  archive,
  unarchive,
  archived,
  focus,
  "focus-pick": focusPickCommand,
  "focus-later": focusLater,
  "focus-shown": focusShown,
  reply,
  distilled,
  open,
  start,
  misjudge,
  "herdr-report": herdrReportCommand,
  title,
  "repo-match": repoMatch,
  ask,
  "ask-tab": askTab,
  nickname,
};
const OFFLINE = new Set(["report", "distilled", "herdr-report", "focus", "define-goal"]);
if (!commands[command]) fail(`未知指令：${command ?? "（未指定）"}\n用法：console.mjs <${Object.keys(commands).join("|")}> ...`);
if (!OFFLINE.has(command)) manager();
await commands[command]();
