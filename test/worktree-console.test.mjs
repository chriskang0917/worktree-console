import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOARD_WIDTH,
  childAnswer,
  optionLine,
  LABEL,
  hiddenTally,
  afterSendLines,
  reportBlock,
  pendingBlock,
  pendingItems,
  todoLines,
  agentStatus,
  boardLines,
  displayWidth,
  deriveStage,
  goalPlan,
  runFolder,
  stageFacts,
  STAGE,
  pickUrgent,
  promptHead,
  claudeProjectDir,
  deliveryVerdict,
  screenRunning,
  lastActivity,
  parseMenu,
  sessionHint,
  sessionStatus,
  needsYou,
  ticketFromBranch,
  ticketKeys,
  collect,
  reportLines,
  sessionTag,
} from "../skills/worktree-console/scripts/lib.mjs";
import { FOCUS_WAIT_MS, emptyFocus, focusPick, focusReplied, focusSkip, focusStep, loadFocus, saveFocus, saveTitles } from "../skills/worktree-console/scripts/focus.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills", "worktree-console", "scripts");
const fixtures = path.join(root, "test", "fixtures", "worktree-console");
const fakeOrca = path.join(fixtures, "fake-orca.mjs");
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let tmp;
const psFixture = JSON.parse(fs.readFileSync(path.join(fixtures, "worktree-ps.json"), "utf8"));
const agentsOf = (suffix) => psFixture.result.worktrees.find((w) => w.path.endsWith(suffix)).agents;

function sh(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

const wt = (name) => path.join(tmp, "wt", name);
const app = () => path.join(tmp, "app");

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-")));
  process.env.WORKTREE_CONSOLE_LOG_DIR = path.join(tmp, "log");
  fs.chmodSync(fakeOrca, 0o755);
  sh(tmp, "init", "--bare", "-b", "main", "remote.git");
  sh(tmp, "clone", "-q", "remote.git", "seed");
  fs.writeFileSync(path.join(tmp, "seed", "README.md"), "hi\n");
  fs.writeFileSync(path.join(tmp, "seed", ".gitignore"), "*.log\n.goals\n");
  sh(path.join(tmp, "seed"), "add", ".");
  sh(path.join(tmp, "seed"), "commit", "-qm", "init");
  sh(path.join(tmp, "seed"), "push", "-q", "origin", "main");
  sh(tmp, "clone", "-q", "remote.git", "app");
  const branches = {
    "proj-101-login": "feat/proj-101-login",
    "chris-proj-102-question": "chris-proj-102-question",
    "proj-102-perm": "proj-102-perm",
    "release-2026-10": "release-2026-10",
    "proj-103-idle": "proj-103-idle",
    "proj-104-noagent": "proj-104-noagent",
    "external-spike": "external-spike",
  };
  for (const [dir, branch] of Object.entries(branches)) sh(app(), "worktree", "add", "-q", "-b", branch, wt(dir), "main");
  fs.writeFileSync(path.join(wt("proj-101-login"), "login.js"), "wip\n");
  fs.writeFileSync(path.join(wt("chris-proj-102-question"), "q.js"), "x\n");
  sh(wt("chris-proj-102-question"), "add", ".");
  sh(wt("chris-proj-102-question"), "commit", "-qm", "q");
  sh(wt("chris-proj-102-question"), "push", "-q", "-u", "origin", "chris-proj-102-question");
  fs.writeFileSync(path.join(wt("proj-104-noagent"), "n.js"), "x\n");
  sh(wt("proj-104-noagent"), "add", ".");
  sh(wt("proj-104-noagent"), "commit", "-qm", "n");
  fs.writeFileSync(path.join(wt("proj-103-idle"), "debug.log"), "log\n");
  fs.mkdirSync(path.join(app(), ".goals"));
  fs.writeFileSync(path.join(app(), ".goals", "proj-103.md"), "# goal\n");
  sh(tmp, "clone", "-q", "remote.git", "other-repo");
  sh(path.join(tmp, "other-repo"), "worktree", "add", "-q", "-b", "chris/proj-6923-dev-flow-trial", path.join(tmp, "api-wt"), "main");
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fake({ mutatePs, mutateList, mutateTerminals, sequence } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "fake-"));
  for (const f of fs.readdirSync(fixtures).filter((f) => f.endsWith(".json"))) {
    fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(fixtures, f), "utf8").replaceAll("__ROOT__", tmp));
  }
  fs.copyFileSync(path.join(dir, "terminal-read-trust.json"), path.join(dir, "terminal-read-term_e.json"));
  if (mutateTerminals) {
    const terms = JSON.parse(fs.readFileSync(path.join(dir, "terminal-list.json"), "utf8"));
    mutateTerminals(terms.result.terminals);
    fs.writeFileSync(path.join(dir, "terminal-list.json"), JSON.stringify(terms));
  }
  if (mutateList) {
    const list = JSON.parse(fs.readFileSync(path.join(dir, "worktree-list.json"), "utf8"));
    mutateList(list);
    fs.writeFileSync(path.join(dir, "worktree-list.json"), JSON.stringify(list));
  }
  const ps = JSON.parse(fs.readFileSync(path.join(dir, "worktree-ps.json"), "utf8"));
  if (mutatePs) mutatePs(ps);
  fs.writeFileSync(path.join(dir, "worktree-ps.json"), JSON.stringify(ps));
  (sequence ?? []).forEach((mutate, i) => {
    const copy = structuredClone(ps);
    mutate(copy);
    fs.writeFileSync(path.join(dir, `ps-${i}.json`), JSON.stringify(copy));
  });
  return dir;
}

function runEnv(dir) {
  return {
    ORCA_BIN: fakeOrca,
    FAKE_ORCA_DIR: dir,
    ORCA_TERMINAL_HANDLE: "term_self",
    WATCH_INTERVAL_MS: "30",
    AWAIT_INTERVAL_MS: "30",
    ANSWER_KEY_DELAY_MS: "0",
    CLAUDE_PROJECTS_DIR: path.join(tmp, "claude-projects"),
    WORKTREE_CONSOLE_HOME: path.join(tmp, "home"),
    CLAUDE_CODE_SESSION_ID: "",
    WORKTREE_CONSOLE_LOG_DIR: path.join(tmp, "log"),
    AUTO_HANDOFF_HOME: path.join(tmp, "handoff"),
    CLAUDE_CONFIG_DIR: path.join(tmp, "claude-config"),
    WATCH_PGREP_PATTERN: `${scripts}/watch\\.mjs|${tmp}/old/watch\\.mjs`,
  };
}

function run(script, args, { dir = fake(), env = {} } = {}) {
  const res = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: { ...process.env, ...runEnv(dir), ...env },
  });
  return { code: res.status, out: res.stdout.trim(), lines: res.stdout.trim().split("\n"), err: res.stderr };
}

// The report section `reportLines()` builds for each tag, from the same fake Orca state `detail` reads.
function expectedReports(dir, tags) {
  const env = runEnv(dir);
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const { rows } = collect(app(), { withStage: false });
    return tags.map((tag) => {
      for (const row of rows) for (const s of row.sessions) if (sessionTag(row, s) === tag) return reportLines(row, s.status, s);
      throw new Error(`no session ${tag}`);
    });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Report sections in detail output: each starts at a `### ` line, separated by one blank line.
function detailReports(lines) {
  const heads = lines.flatMap((l, i) => (l.startsWith("### ") ? [i] : []));
  return heads.map((h, k) => lines.slice(h, k + 1 < heads.length ? heads[k + 1] - 1 : lines.length));
}

const agentIn = (ps, suffix) => ps.result.worktrees.find((w) => w.path.endsWith(suffix)).agents;
const allPanes = (state) =>
  psFixture.result.worktrees
    .flatMap((w) => w.agents.map((a) => `${a.paneKey}=${state}`))
    .join(",");


// Full baseline as the watcher would write it, with some panes overridden.
function baselineWith(overrides = {}) {
  return psFixture.result.worktrees
    .flatMap((w) => w.agents.map((a) => [a.paneKey, agentStatus(a).kind]))
    .concat([["zzz-tab:zzz-leaf", "waiting"]])
    .map(([k, v]) => `${k}=${overrides[k] ?? v}`)
    .join(",");
}
const pane = (suffix) => agentsOf(suffix)[0].paneKey;

const BOARD_HEADER = "| 狀態 | 票號 | 摘要 | 階段 | 最後動態 |";

// Every per-repo table of a board; rows are keyed by tag (second column).
function table(out) {
  const lines = out.split("\n");
  const tables = [];
  lines.forEach((line, at) => {
    if (line !== BOARD_HEADER) return;
    const rows = [];
    for (const l of lines.slice(at + 2)) {
      if (!l.startsWith("| ")) break;
      rows.push(l.slice(2, -2).split(" | "));
    }
    tables.push({ at, repo: lines[at - 2], blank: lines[at - 1], sep: lines[at + 1], rows });
  });
  const rows = tables.flatMap((t) => t.rows);
  return { at: tables[0]?.at ?? -1, tables, rows, by: Object.fromEntries(rows.map((r) => [r[1], r])) };
}

function assertClipped(actual, full) {
  if (actual === full) return;
  assert.ok(actual.endsWith("…") && full.startsWith(actual.slice(0, -1)), `${actual} 應為 ${full} 截短後以…結尾`);
}

// Watcher output: reports, then the board, joined by `---`; the trailing baseline line is dropped.
function blocks(out) {
  const body = out.split("\n").filter((l) => !l.startsWith("baseline:")).join("\n");
  const parts = body.split("\n\n---\n\n");
  return { reports: parts.slice(0, -1).map((p) => p.split("\n")), board: parts.at(-1) };
}

const AGAIN = "（先前已回報，尚未回覆）";
const fresh = (reports) => reports.filter((r) => !r[0].endsWith(AGAIN));

const MENU = [
  {
    question: "要哪個顏色？",
    header: "顏色",
    multiSelect: false,
    options: [
      { label: "紅", description: "暖色" },
      { label: "綠 (Recommended)", description: "冷色" },
      { label: "藍", description: "冷色" },
    ],
  },
  { question: "要哪個尺寸？", header: "尺寸", multiSelect: false, options: [{ label: "S", description: "小" }, { label: "M", description: "中" }] },
];

function writeTranscript(worktree, file, entries) {
  const dir = claudeProjectDir(worktree);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const userText = (text) => ({ type: "user", message: { role: "user", content: text } });
const toolUse = (id, name, input) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

const menuAgent = (prompt = "PROJ-103 選顏色尺寸") => ({ state: "waiting", toolName: "AskUserQuestion", toolInput: null, prompt, lastAssistantMessage: null });

function withMenuSession(questions = MENU, extra = {}) {
  const prev = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
  try {
    writeTranscript(wt("proj-103-idle"), "s.jsonl", [
      userText("先問一題"),
      toolUse("t0", "AskUserQuestion", { questions: [{ question: "舊題？", header: "舊", options: [{ label: "x" }] }] }),
      toolResult("t0"),
      userText("PROJ-103 選顏色尺寸"),
      toolUse("t1", "AskUserQuestion", { questions }),
    ]);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = prev;
  }
  return fake({
    mutatePs: (ps) => Object.assign(agentIn(ps, "proj-103-idle")[0], menuAgent()),
    ...extra,
  });
}

test("狀態對應：working／waiting／blocked／done 問句／done／idle 各對到固定標籤", () => {
  assert.equal(agentStatus(agentsOf("proj-101-login")[0]).kind, "busy");
  const perm = agentStatus(agentsOf("proj-102-perm")[0]);
  assert.equal(perm.kind, "permission");
  assert.equal(perm.tool, "Bash");
  assert.equal(agentStatus({ ...agentsOf("proj-102-perm")[0], state: "blocked" }).kind, "permission");
  assert.equal(agentStatus(agentsOf("chris-proj-102-question")[0]).kind, "waiting");
  assert.equal(agentStatus(agentsOf("release-2026-10")[0]).kind, "done");
  assert.equal(agentStatus(agentsOf("proj-103-idle")[0]).kind, "idle");
  assert.equal(agentStatus(undefined).kind, "idle");
  assert.deepEqual(
    Object.values(LABEL).sort(),
    ["⏸ 回覆完畢", "🔄 執行中", "💬 等待回應", "🔐 等待授權", "💤 閒置"].sort(),
  );
});

test("票號解析：linked issue 與 branch 前綴，不把 release-2026-10 當票號", () => {
  const keys = ticketKeys(["PROJ-101"], ["chris/proj-1-a", "Proj-2-b", "release-2025-12", "release-2026-10", "v1-2"]);
  assert.deepEqual([...keys], ["PROJ"]);
  assert.equal(ticketFromBranch("chris/Proj-6923-中文票名", keys).ticket, "PROJ-6923");
  assert.equal(ticketFromBranch("release-2026-10", ticketKeys([], ["release-2025-12", "release-2026-10"])), null);
  assert.equal(ticketFromBranch("feature/proj-update-rules", keys), null);
});

test("UX1 看板：依 repo 分表，表頭 狀態｜票號｜摘要｜階段｜最後動態；只列有 claude session 的 worktree，排除中控台", () => {
  const { code, out } = run("console.mjs", ["board", "--repo", app()]);
  assert.equal(code, 0);
  const t = table(out);
  assert.deepEqual(t.tables.map((x) => [x.repo, x.blank, x.sep]), [
    ["**app**", "", "| --- | --- | --- | --- | --- |"],
    ["**api**", "", "| --- | --- | --- | --- | --- |"],
  ]);
  assert.equal(out.split("\n")[0], "**app**");
  for (const row of t.rows) assert.equal(row.length, 5, row.join(" | "));
  assert.deepEqual(t.by["PROJ-101"], ["🔄 執行中", "PROJ-101", "登入頁改版", "實作中", "PROJ-101 實作登入頁改版"]);
  assert.deepEqual(t.tables[1].rows.map((r) => r.slice(0, 2)), [["🔄 執行中", "PROJ-6923"]]);
  for (const gone of ["PROJ-104", "external-spike", "main"]) assert.ok(!t.by[gone], `${gone} 沒有 session，不該上看板`);
});

test("狀態看板最後才提示 memory.md 看不懂的條目；沒有就不提", () => {
  const file = path.join(tmp, "log", "memory.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ["# 回覆習慣", "", "## 其他", "- 看心情（記住 2026-09-01）", ""].join("\n"));
  try {
    const { lines } = run("console.mjs", ["board", "--repo", app()]);
    assert.deepEqual(lines.slice(-2), ["", "memory.md 有 1 條看不懂（沒有情境字母或認得的關鍵字），腳本不改不刪"]);
  } finally {
    fs.rmSync(file);
  }
  assert.ok(!run("console.mjs", ["board", "--repo", app()]).out.includes("看不懂"));
});

test("UX2 看板：一個 session 一列，同 worktree 多 session 各一列標 <票號>#n，不再有縮排子列", () => {
  const { out } = run("console.mjs", ["board", "--repo", app()]);
  const t = table(out);
  assert.deepEqual(t.rows.map((r) => r[1]).sort(), [
    "PROJ-101",
    "PROJ-102(perm)",
    "PROJ-102(question)",
    "PROJ-6923",
    "release…#1",
    "release…#2",
  ].sort());
  assert.ok(!out.split("\n").some((l) => l.startsWith(" ")), "不該有縮排子列");
  assert.deepEqual(t.by["release…#1"].slice(0, 4), ["⏸ 回覆完畢", "release…#1", "release-2026-10", "未開工"]);
  assert.equal(t.by["release…#2"][4], "好了。");
});

const onlyApp = { mutatePs: (ps) => (ps.result.worktrees = ps.result.worktrees.filter((w) => w.repoId !== "other-repo-id")) };

test("UX3 看板：沒有加總行；只有一個 repo 有 session 時表格上方照樣有 repo 名稱行", () => {
  const { out } = run("console.mjs", ["board", "--repo", app()], { dir: fake(onlyApp) });
  const t = table(out);
  assert.deepEqual(t.tables.map((x) => x.repo), ["**app**"]);
  assert.deepEqual(out.split("\n").slice(0, 3), ["**app**", "", BOARD_HEADER]);
  assert.ok(!/共 \d+ 個 session/.test(out), out);
  const rows = [{ repo: "solo", label: "PROJ-1", title: "x", stage: "實作中", sessions: [{ n: null, status: { kind: "busy", text: "跑" } }] }];
  assert.deepEqual(boardLines(rows).slice(0, 3), ["**solo**", "", BOARD_HEADER]);
});

test("UX4 最後動態：回應放問題、授權放執行內容、執行中放最後指令、回覆完畢放最後一句、閒置放—，每格 ≤30 字", () => {
  const dir = withMenuSession();
  const t = table(run("console.mjs", ["board", "--repo", app()], { dir }).out);
  assertClipped(t.by["PROJ-102(question)"][4], "要我掛一支監看，等它收工或卡住時主動跟你回報嗎？");
  assertClipped(t.by["PROJ-102(perm)"][4], "Bash npm run db:migrate -- --…");
  assertClipped(t.by["PROJ-101"][4], "PROJ-101 實作登入頁改版");
  assert.match(t.by["release…#1"][4], /^全部改動已 commit/);
  assert.equal(t.by["PROJ-103"][0], "💬 等待回應");
  assert.equal(t.by["PROJ-103"][4], "要哪個顏色？");
  for (const row of t.rows) assert.ok(Array.from(row[4]).length <= 30, row[4]);
  const long = "這是一句非常非常長的最後一句話，用來確認最後動態欄一定會被截在三十個字以內而且結尾有刪節號。";
  assert.equal(Array.from(lastActivity({ kind: "done", text: `前面。\n\n${long}` })).length, 30);
  assert.equal(lastActivity({ kind: "done", text: "第一段。\n\n做完了。測試全過。" }), "測試全過。");
  assert.equal(lastActivity({ kind: "idle", text: "" }), "—");
});

test("UX5 狀態改變：先貼該次變動的回報，接著貼包含全部 session 的完整表格", () => {
  const dir = fake({
    sequence: [
      () => {},
      (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "登入頁做好了。" }),
    ],
  });
  const { code, out, lines } = run("watch.mjs", ["--baseline", baselineWith()], { dir });
  assert.equal(code, 0);
  const b = blocks(out);
  assert.equal(fresh(b.reports).length, 1);
  assert.equal(b.reports[0][0], "### ⏸ PROJ-101 回覆完畢");
  assert.ok(out.indexOf("### ⏸ PROJ-101") < out.indexOf(BOARD_HEADER), "回報要在表格前面");
  const t = table(b.board);
  assert.equal(t.rows.length, 6, "完整表格要列出全部非閒置 session，不只變動的那個");
  assert.ok(b.board.includes("閒置 1 個"), b.board);
  assert.equal(t.by["PROJ-101"][0], "⏸ 回覆完畢");
  assert.equal(t.by["PROJ-102(perm)"][0], "🔐 等待授權");
  assert.match(lines.at(-1), /^baseline: /);
});

test("UX5 baseline：狀態沒變不觸發，之後的轉換才觸發；轉成執行中或閒置不吵你", () => {
  const dir = fake({
    sequence: [
      () => {},
      (ps) => Object.assign(agentIn(ps, "proj-103-idle")[0], { state: "working", prompt: "跑" }),
      (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "登入頁做好了。\n\n要順便改註冊頁嗎？" }),
    ],
  });
  const current = JSON.parse(fs.readFileSync(path.join(dir, "ps-0.json"), "utf8"))
    .result.worktrees.flatMap((w) => w.agents.map((a) => `${a.paneKey}=${agentStatus(a).kind}`))
    .join(",");
  const { out } = run("watch.mjs", ["--baseline", current], { dir });
  const b = blocks(out);
  assert.deepEqual(fresh(b.reports).map((r) => r[0]), ["### 💬 PROJ-101 等你回應"]);
});

test("UX6 一般文字提問：回報貼最後一則回覆完整原文，不截斷、不改寫、不加詳情提示", () => {
  const { out } = run("watch.mjs", ["--baseline", allPanes("busy")]);
  const r = blocks(out).reports.find((x) => x[0].includes("PROJ-102(question)"));
  assert.equal(r[0], "### 💬 PROJ-102(question) 等你回應");
  const original = agentsOf("chris-proj-102-question")[0].lastAssistantMessage;
  const quoted = r.filter((l) => l.startsWith(">")).map((l) => l.replace(/^> ?/, "")).join("\n");
  assert.equal(quoted, original);
  assert.ok(!out.includes("完整："), "不加「完整：詳情」提示");
});

test("UX7 AskUserQuestion：狀態是 💬 等待回應，列出每題標籤、題目、所有選項含說明與「其他」，編號與畫面一致", () => {
  const dir = withMenuSession();
  const { out } = run("watch.mjs", ["--baseline", baselineWith()], { dir });
  const r = blocks(out).reports[0];
  assert.equal(r[0], "### 💬 PROJ-103 等你選擇");
  assert.ok(!out.includes("🔐 PROJ-103"));
  assert.equal(table(blocks(out).board).by["PROJ-103"][0], "💬 等待回應");
  assert.ok(r.includes("> 第 1 題 **顏色**　要哪個顏色？"));
  assert.ok(r.includes("> 第 2 題 **尺寸**　要哪個尺寸？"));
  const q1 = r.indexOf("> 第 1 題 **顏色**　要哪個顏色？");
  assert.deepEqual(r.slice(q1 + 2, q1 + 8), [
    "| # | 選項 | 說明 |",
    "| --- | --- | --- |",
    "| a | 紅 | 暖色 |",
    "| b | **綠 (Recommended)** | 冷色 |",
    "| c | 藍 | 冷色 |",
    "| d | 其他 | 自行輸入 |",
  ]);
  const q2 = r.indexOf("> 第 2 題 **尺寸**　要哪個尺寸？");
  assert.deepEqual(r.slice(q2 + 4, q2 + 7), ["| a | S | 小 |", "| b | M | 中 |", "| c | 其他 | 自行輸入 |"]);
  assert.ok(!r.some((l) => l.includes("舊題")), "已回答過的舊選單不該被拿來用");
  assert.deepEqual(parseMenu(JSON.stringify({ questions: MENU })), MENU, "Orca 之後若帶 toolInput 就直接用");
  assert.equal(parseMenu(null), null);
});

test("UX8 回報沒有「↳ 回覆：」行與「摘要：…｜階段：…」行；多 session 標題帶 <票號>#n", () => {
  const outs = [
    run("watch.mjs", ["--baseline", allPanes("busy")]).out,
    run("watch.mjs", ["--baseline", baselineWith()], { dir: withMenuSession() }).out,
    run("watch.mjs", ["--baseline", baselineWith()], { dir: withMenuSession([MENU[0]]) }).out,
  ];
  for (const out of outs) {
    assert.ok(blocks(out).reports.length > 0, out);
    assert.ok(!out.split("\n").some((l) => l.startsWith("↳") || l.startsWith("摘要：")), out);
  }
  const dir = fake({
    ...addSecondLoginSession,
    sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "要改註冊頁嗎？" })],
  });
  const multi = fresh(blocks(run("watch.mjs", ["--baseline", baselineWith()], { dir }).out).reports);
  assert.equal(multi.length, 1);
  assert.deepEqual(multi[0], ["### 💬 PROJ-101#1 等你回應", "", "> 要改註冊頁嗎？"]);
});

test("UX9 回 <票號> <編號>／其他：<文字>：代按選單選項，送完子 session 離開等待回應", () => {
  const done = (ps) => Object.assign(agentIn(ps, "proj-103-idle")[0], { state: "working", toolName: null });
  const sends = (dir) =>
    fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter((l) => l.startsWith("terminal send")).map((l) => l.replace("terminal send --terminal term_e --text ", ""));
  const one = withMenuSession([MENU[0]], { sequence: [() => {}, done] });
  const a = run("console.mjs", ["answer", "--repo", app(), "103", "2"], { dir: one });
  assert.deepEqual([a.code, a.out], [0, "[PROJ-103] 已選擇：顏色→綠 (Recommended)"]);
  assert.deepEqual(sends(one), ["2"]);
  const other = withMenuSession([MENU[0]], { sequence: [() => {}, done] });
  const b = run("console.mjs", ["answer", "--repo", app(), "PROJ-103", "其他：紫", "色"], { dir: other });
  assert.deepEqual([b.code, b.out], [0, "[PROJ-103] 已選擇：顏色→其他「紫 色」"]);
  assert.deepEqual(sends(other), ["4", "紫 色", "\r"]);
  const two = withMenuSession(MENU, { sequence: [() => {}, done] });
  const c = run("console.mjs", ["answer", "--repo", app(), "103", "2；其他：XL"], { dir: two });
  assert.equal(c.code, 0, c.out);
  assert.deepEqual(sends(two), ["2", "3", "XL", "\r", "1"], "多題最後要在確認畫面按 1 送出");
  const stuck = run("console.mjs", ["answer", "--repo", app(), "103", "1", "--timeout", "0"], { dir: withMenuSession([MENU[0]]) });
  assert.equal(stuck.code, 1);
  assert.match(stuck.out, /^\[PROJ-103\] 已送出，但選單還開著/);
  for (const [args, msg] of [
    [["103", "9"], /沒有第 9 項/],
    [["103", "4"], /選「其他」時請寫成/],
    [["103", "1；2"], /選單有 1 題，收到 2 個答案/],
    [["103", "隨便"], /看不懂「隨便」/],
    [["101", "1"], /目前沒有開著的選單/],
  ]) {
    const dir = withMenuSession([MENU[0]]);
    const res = run("console.mjs", ["answer", "--repo", app(), ...args], { dir });
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, msg);
    assert.ok(!fs.readFileSync(path.join(dir, "calls.log"), "utf8").includes("terminal send"), "驗證失敗時不送任何按鍵");
  }
  const multi = withMenuSession([{ ...MENU[0], multiSelect: true }]);
  assert.match(run("console.mjs", ["answer", "--repo", app(), "103", "1"], { dir: multi }).out, /可複選題不代按/);
});

test("UX9b 有預覽框的題目：數字只移游標，要再按 Enter；「其他」不代按", () => {
  const done = (ps) => Object.assign(agentIn(ps, "proj-103-idle")[0], { state: "working", toolName: null });
  const sends = (dir) =>
    fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter((l) => l.startsWith("terminal send")).map((l) => l.replace("terminal send --terminal term_e --text ", ""));
  const previewed = { ...MENU[0], options: MENU[0].options.map((o) => ({ ...o, preview: `## ${o.label}` })) };
  const one = withMenuSession([previewed], { sequence: [() => {}, done] });
  assert.equal(run("console.mjs", ["answer", "--repo", app(), "103", "2"], { dir: one }).code, 0);
  assert.deepEqual(sends(one), ["2", "\r"]);
  const mixed = withMenuSession([previewed, MENU[1]], { sequence: [() => {}, done] });
  assert.equal(run("console.mjs", ["answer", "--repo", app(), "103", "1；1"], { dir: mixed }).code, 0);
  assert.deepEqual(sends(mixed), ["1", "\r", "1", "1"], "沒有預覽框的題目照舊只按數字");
  const other = withMenuSession([previewed]);
  const res = run("console.mjs", ["answer", "--repo", app(), "103", "其他：紫"], { dir: other });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /有預覽框.*請改用文字轉達/);
  assert.ok(!fs.readFileSync(path.join(other, "calls.log"), "utf8").includes("terminal send"));
});

test("UX10 回報排版：標題列、空行、引用框原文或選單表格（建議項加粗），回報與看板之間保留分隔線", () => {
  const dir = withMenuSession(MENU, {
    sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "第一段。\n\n第二段？" })],
  });
  const baseline = baselineWith({ [pane("proj-103-idle")]: "waiting" });
  const { out } = run("watch.mjs", ["--baseline", baseline], { dir });
  const [r] = blocks(out).reports;
  assert.deepEqual(r, ["### 💬 PROJ-101 等你回應", "", "> 第一段。", ">", "> 第二段？"]);
  assert.match(out, /\n\n---\n\n\*\*app\*\*\n\n\| 狀態 \|/, "回報與看板以分隔線隔開");
  const menu = blocks(run("watch.mjs", ["--baseline", baselineWith()], { dir: withMenuSession() }).out).reports[0];
  assert.match(menu[0], /^### 💬 PROJ-103 等你選擇$/);
  assert.equal(menu[1], "");
  assert.ok(menu.includes("| b | **綠 (Recommended)** | 冷色 |"));
  assert.equal(menu.at(-1), "| c | 其他 | 自行輸入 |");
  for (const report of blocks(run("watch.mjs", ["--baseline", allPanes("busy")]).out).reports) {
    assert.match(report[0], /^### (💬|🔐|⏸) \S+ (等你回應|等你選擇|等你授權|回覆完畢)$/);
    assert.equal(report[1], "");
    const body = report.slice(2);
    const end = body.includes("") ? body.indexOf("") : body.length;
    assert.ok(body.slice(0, end).every((l) => l.startsWith(">")), report.join("\n"));
    assert.ok(body.slice(end + 1).every((l) => /^- [a-z]\. /.test(l)), "引用框後只接 a、b、c 選項行");
  }
});

test("UX11 回覆完畢：貼最後一則回覆完整原文，不論長度都不摺疊、不截斷", () => {
  const long = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段：${"內容".repeat(60)}。`).join("\n\n");
  const dir = fake({
    sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: long })],
  });
  const { out } = run("watch.mjs", ["--baseline", baselineWith()], { dir });
  const [r] = blocks(out).reports;
  assert.equal(r[0], "### ⏸ PROJ-101 回覆完畢");
  assert.equal(r.filter((l) => l.startsWith(">")).map((l) => l.replace(/^> ?/, "")).join("\n"), long);
  assert.ok(!r.join("\n").includes("<details>") && !r.join("\n").includes("…"), "不摺疊、不截斷");
});

test("UX12 等待授權：顯示工具與完整參數（不截在 80 字）", () => {
  const { out } = run("watch.mjs", ["--baseline", allPanes("busy")]);
  const r = blocks(out).reports.find((x) => x[0].includes("PROJ-102(perm)"));
  const input = agentsOf("proj-102-perm")[0].toolInput;
  assert.ok(input.length > 80);
  assert.equal(r[0], "### 🔐 PROJ-102(perm) 等你授權");
  assert.deepEqual(r.slice(1), ["", "> **Bash**", `> ${input}`]);
});

test("UX13 同一輪多個 session 同時變動：各一則回報，全部貼完只貼一次完整表格，且與表格狀態一致", () => {
  const { code, out } = run("watch.mjs", ["--baseline", allPanes("busy")]);
  assert.equal(code, 0);
  const b = blocks(out);
  assert.deepEqual(b.reports.map((r) => r[0].split(" ")[2]).sort(), [
    "PROJ-102(perm)",
    "PROJ-102(question)",
    "release…#1",
    "release…#2",
  ]);
  assert.equal(out.split("\n").filter((l) => l === "**app**").length, 1, "看板只貼一次");
  assert.ok(out.lastIndexOf("### ", out.indexOf("### 📋") - 1) < out.indexOf(BOARD_HEADER), "全部回報貼完才貼表格");
  const t = table(b.board);
  const emoji = { 等你回應: "💬", 等你選擇: "💬", 等你授權: "🔐", 回覆完畢: "⏸" };
  for (const r of b.reports) {
    const [, e, tag, title] = r[0].split(" ");
    assert.equal(e, emoji[title]);
    assert.ok(t.by[tag][0].startsWith(e), r[0]);
  }
});

test("board：主 checkout 在扣掉中控台後仍有 agent 時才列出", () => {
  const dir = fake({
    mutatePs: (ps) => agentIn(ps, "/app").push({ ...agentIn(ps, "/app")[0], paneKey: "other:pane", state: "done", lastAssistantMessage: "好了" }),
  });
  const t = table(run("console.mjs", ["board", "--repo", app()], { dir }).out);
  assert.equal(t.by.main[0], "⏸ 回覆完畢");
  assert.ok(!table(run("console.mjs", ["board", "--repo", app()]).out).by.main, "只有中控台自己時不列");
});

test("階段：看板依 git、目標檔與 run folder 顯示未開工／規劃中／實作中／已 push", () => {
  const t = table(run("console.mjs", ["board", "--repo", app()]).out);
  assert.equal(t.by["PROJ-101"][3], "實作中");
  assert.equal(t.by["PROJ-102(question)"][3], "已 push");
  assert.equal(table(run("console.mjs", ["board", "--repo", app()], { dir: withMenuSession() }).out).by["PROJ-103"][3], "規劃中");
  assert.equal(t.by["PROJ-6923"][3], "未開工");
  assert.equal(t.by["release…#1"][3], "未開工");
  for (const row of t.rows) assert.ok(Object.values(STAGE).includes(row[3]), row[3]);
});

test("resolve：數字完全比對、零／一／多筆", () => {
  const r = (q) => JSON.parse(run("console.mjs", ["resolve", "--repo", app(), q]).out);
  const one = r("101");
  assert.equal(one.match, "one");
  assert.deepEqual(one.rows[0], {
    repo: "app",
    main: app(),
    ticket: "PROJ-101",
    branch: "feat/proj-101-login",
    path: wt("proj-101-login"),
    handle: "term_a",
    session: null,
    tag: "PROJ-101",
    status: "🔄 執行中",
    prompt: "PROJ-101 實作登入頁改版",
  });
  assert.equal(r("proj-101").match, "one");
  assert.equal(r("102").match, "many");
  assert.equal(r("release-2026-10").match, "many", "同一 worktree 兩個 claude 分頁也算 many");
  assert.equal(r("999").match, "none");
  assert.equal(r("01").match, "none", "不比尾數");
  const idle = r("104");
  assert.equal(idle.match, "one");
  assert.equal(idle.rows[0].handle, null);
  assert.equal(r("external-spike").match, "one");
});

test("detail：顯示 branch、worktree 路徑、sessions，回覆完畢的 session 各附一段回報", () => {
  const dir = fake();
  const { lines } = run("console.mjs", ["detail", "--repo", app(), "release-2026-10"], { dir });
  assert.equal(lines[0], "[release…] 詳情");
  assert.ok(lines.includes("branch: release-2026-10"));
  assert.ok(lines.includes(`worktree: ${wt("release-2026-10")}`));
  assert.ok(lines.includes("sessions:"));
  assert.ok(!lines.includes("最近輸出："));
  const reports = detailReports(lines);
  assert.deepEqual(reports, expectedReports(dir, ["release…#1", "release…#2"]));
  assert.match(reports[0][0], /^### ⏸ release…#1 回覆完畢$/);
  assert.ok(reports.flat().some((l) => l.includes("CI 綠燈")));
});

test("close-check：dirty、執行中、主 checkout 擋下；零 commit、已 push、未 push commit 放行", () => {
  const a = run("console.mjs", ["close-check", "--path", wt("proj-101-login")]);
  assert.equal(a.code, 1);
  assert.match(a.lines[0], /^blocked:.*工作區有未 commit 的改動.*session 執行中/);
  const f = run("console.mjs", ["close-check", "--path", wt("proj-104-noagent")]);
  assert.deepEqual([f.code, f.lines[0]], [0, "ok"]);
  assert.match(run("console.mjs", ["close-check", "--path", app()]).lines[0], /^blocked:這是主 checkout/);
  const e = run("console.mjs", ["close-check", "--path", wt("proj-103-idle")]);
  assert.equal(e.code, 0);
  assert.deepEqual(e.lines, ["ok", "!! debug.log"]);
  assert.equal(run("console.mjs", ["close-check", "--path", wt("chris-proj-102-question")]).lines[0], "ok");
});

test("await-start：已開工與未開工（trust 對話框、逾時）", () => {
  const ok = run("console.mjs", ["await-start", "--path", wt("proj-101-login"), "--expect", "PROJ-101 實作"]);
  assert.deepEqual([ok.code, ok.out], [0, "[PROJ-101] 已開工"]);
  const dg = run("console.mjs", ["await-start", "--path", wt("chris-proj-102-question"), "--expect", "PROJ-102", "--define-goal"]);
  assert.equal(dg.out, "[PROJ-102(question)] 已開工");
  const trust = run("console.mjs", ["await-start", "--path", wt("proj-103-idle"), "--expect", "PROJ-103", "--timeout", "0"]);
  assert.deepEqual([trust.code, trust.out], [1, "[PROJ-103] 未開工：卡在 trust 對話框"]);
  const late = run("console.mjs", ["await-start", "--path", wt("proj-104-noagent"), "--expect", "PROJ-104", "--timeout", "0"]);
  assert.equal(late.out, "[PROJ-104] 未開工：逾時");
});

test("watcher：orca 不可達與逾時出口", () => {
  const down = run("watch.mjs", [], { env: { FAKE_ORCA_FAIL: "1" } });
  assert.equal(down.out, "[watch] orca-unreachable");
  const idle = run("watch.mjs", [], { env: { WATCH_TIMEOUT_MS: "0" } });
  assert.equal(idle.lines[0], "[watch] timeout");
  assert.match(idle.lines[1], /^baseline: /);
});

test("多 session 優先順序：等待授權 > 執行中 > 等待回應 > 回覆完畢 > 閒置", () => {
  const k = (...kinds) => pickUrgent(kinds.map((kind) => ({ kind, text: "" }))).kind;
  assert.equal(k("waiting", "busy"), "busy");
  assert.equal(k("done", "busy", "idle"), "busy");
  assert.equal(k("busy", "permission"), "permission");
  assert.equal(k("done", "waiting"), "waiting");
  assert.equal(k("idle", "done"), "done");
  assert.equal(k("idle"), "idle");
});

const stageAt = (dir, branch, { main = app(), id = null, comment = "" } = {}) =>
  deriveStage({ facts: stageFacts(dir, null, branch), goal: goalPlan(main, id), comment });

// A fresh worktree of `app` on `branch`, removed after `fn`.
function withWorktree(branch, fn) {
  const dir = path.join(tmp, "stage-wt", branch.replace(/\//g, "-"));
  sh(app(), "worktree", "add", "-q", "-b", branch, dir, "main");
  try {
    fn(dir);
  } finally {
    sh(app(), "worktree", "remove", "--force", dir);
    sh(app(), "branch", "-D", branch);
  }
}

function writeFile(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

const plan = (status) => `---\nstatus: ${status}\n---\n\n# plan\n`;

test("階段：沒改動、沒 commit、沒目標檔、沒 run folder、沒 define-goal 標記 → 未開工", () => {
  withWorktree("chris/proj-7200-untouched", (dir) => {
    const facts = stageFacts(dir, null, "chris/proj-7200-untouched");
    assert.deepEqual([facts.dirty, facts.ahead, facts.runFolder, facts.planApproved], [false, 0, false, false]);
    assert.equal(goalPlan(app(), "PROJ-7200"), null);
    assert.equal(stageAt(dir, "chris/proj-7200-untouched", { id: "PROJ-7200" }), "未開工");
  });
});

test("階段（define-goal）：有開工標記或目標檔、實作方案還沒交棒 → 規劃中；交棒字樣出現 → 實作中", () => {
  const goals = path.join(app(), ".goals");
  withWorktree("chris/proj-7201-goal", (dir) => {
    const at = (opts) => stageAt(dir, "chris/proj-7201-goal", { id: "PROJ-7201", ...opts });
    assert.equal(at({ comment: "define-goal" }), "規劃中");
    fs.writeFileSync(path.join(goals, "proj-7201.md"), "## 目標：x\n\n**實作方案**：（未定）\n");
    try {
      assert.equal(at(), "規劃中");
      fs.writeFileSync(path.join(goals, "proj-7201.md"), "## 目標：x\n\n**實作方案**：直接實作（`/goal` 錨在本檔，2026-10-02）\n");
      assert.equal(at(), "實作中", "還沒改任何 code 也算實作中");
      fs.writeFileSync(path.join(goals, "proj-7201.md"), "## 目標：x\n\n**實作方案**：見 .goals/proj-7201-spec.md\n");
      assert.equal(at(), "實作中");
    } finally {
      fs.rmSync(path.join(goals, "proj-7201.md"));
    }
  });
  fs.writeFileSync(path.join(goals, "login.md"), "**實作方案**：\n");
  try {
    assert.deepEqual(goalPlan(app(), "login"), { handedOff: false }, "沒有票號時用暱稱找目標檔");
  } finally {
    fs.rmSync(path.join(goals, "login.md"));
  }
});

test("階段（dev-flow）：run folder 存在、plan.md 未批准且改動只在 docs/dev-flow → 規劃中；plan.md status: approved → 實作中", () => {
  const branch = "chris/proj-7202-flow";
  withWorktree(branch, (dir) => {
    const folder = "docs/dev-flow/chris-proj-7202-flow";
    assert.equal(runFolder(dir, branch), path.join(dir, folder));
    writeFile(dir, `${folder}/goal.md`, "# goal\n");
    assert.equal(stageAt(dir, branch), "規劃中", "只有 goal.md、沒有 plan.md");
    writeFile(dir, `${folder}/plan.md`, plan("draft"));
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "plan");
    assert.equal(stageAt(dir, branch), "規劃中", "規劃檔的 commit 不算");
    writeFile(dir, `${folder}/plan.md`, plan("approved"));
    assert.equal(stageAt(dir, branch), "實作中");
  });
  withWorktree("chris/proj-7203-old-flow", (dir) => {
    writeFile(dir, "docs/dev-flow/20261001-0900-old/00-run-summary.md", "# old\n");
    assert.equal(stageAt(dir, "chris/proj-7203-old-flow"), "未開工", "舊版 run folder 不認");
  });
});

test("階段：docs/dev-flow 以外有未 commit 改動或 commit → 實作中，不論走哪條流程", () => {
  const branch = "chris/proj-7204-code";
  withWorktree(branch, (dir) => {
    writeFile(dir, "docs/dev-flow/chris-proj-7204-code/plan.md", plan("draft"));
    writeFile(dir, "src/a.js", "x\n");
    assert.equal(stageAt(dir, branch), "實作中", "未 commit 的 code");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "code");
    assert.equal(stageAt(dir, branch), "實作中", "有動到 code 的 commit");
    assert.equal(stageAt(dir, branch, { id: "PROJ-7204", comment: "define-goal" }), "實作中");
  });
  const file = path.join(wt("chris-proj-102-question"), "wip.js");
  fs.writeFileSync(file, "wip\n");
  try {
    assert.equal(table(run("console.mjs", ["board", "--repo", app()]).out).by["PROJ-102(question)"][3], "實作中", "已 push 後又有未 commit 改動");
  } finally {
    fs.rmSync(file);
  }
});

test("階段：只 push 了規劃檔不算已 push；push 了動到 code 的 commit 才是已 push", () => {
  const branch = "chris/proj-7205-push";
  withWorktree(branch, (dir) => {
    writeFile(dir, "docs/dev-flow/chris-proj-7205-push/plan.md", plan("draft"));
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "plan");
    sh(dir, "push", "-q", "-u", "origin", branch);
    assert.equal(stageAt(dir, branch), "規劃中");
    writeFile(dir, "src/b.js", "x\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "code");
    assert.equal(stageAt(dir, branch), "實作中", "code commit 還沒 push");
    sh(dir, "push", "-q");
    assert.equal(stageAt(dir, branch), "已 push");
    writeFile(dir, "docs/dev-flow/chris-proj-7205-push/implement-report.md", "# report\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "report");
    assert.equal(stageAt(dir, branch), "已 push", "之後只多了沒 push 的規劃檔 commit");
    sh(dir, "push", "-q", "origin", "--delete", branch);
  });
});

test("階段：看板讀得到 branch 的 run folder（PROJ-6923 dev-flow trial）", () => {
  const folder = path.join(tmp, "api-wt", "docs", "dev-flow", "chris-proj-6923-dev-flow-trial");
  writeFile(folder, "plan.md", plan("draft"));
  try {
    const stage = () => table(run("console.mjs", ["board", "--repo", app()]).out).by["PROJ-6923"][3];
    assert.equal(stage(), "規劃中");
    writeFile(folder, "plan.md", plan("approved"));
    assert.equal(stage(), "實作中");
  } finally {
    fs.rmSync(path.join(tmp, "api-wt", "docs"), { recursive: true });
  }
});

test("階段：worktree comment 含 define-goal 且沒有改動 → 規劃中", () => {
  const dir = fake({
    mutateList: (list) => {
      list.result.worktrees.find((w) => w.path.endsWith("release-2026-10")).comment = "define-goal";
    },
  });
  assert.equal(table(run("console.mjs", ["board", "--repo", app()], { dir }).out).by["release…#1"][3], "規劃中");
});

test("階段：找不到 base 時，有 upstream、沒有未 push 的 code commit、不 dirty → 已 push", () => {
  const repo = path.join(tmp, "nobase");
  sh(tmp, "clone", "-q", "remote.git", "nobase");
  sh(repo, "remote", "set-head", "origin", "-d");
  sh(repo, "checkout", "-q", "-b", "feat-pushed");
  fs.writeFileSync(path.join(repo, "p.js"), "x\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "p");
  sh(repo, "push", "-q", "-u", "origin", "feat-pushed");
  const pushed = stageFacts(repo, null, "feat-pushed");
  assert.deepEqual([pushed.hasBase, pushed.upstream, pushed.unpushed, pushed.dirty], [false, true, 0, false]);
  assert.equal(deriveStage({ facts: pushed }), "已 push");
  fs.writeFileSync(path.join(repo, "q.js"), "x\n");
  assert.equal(deriveStage({ facts: stageFacts(repo, null, "feat-pushed") }), "實作中");
  sh(repo, "checkout", "-q", "-b", "feat-local");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "q");
  const local = stageFacts(repo, null, "feat-local");
  assert.equal(local.upstream, false);
  assert.equal(deriveStage({ facts: local }), "實作中");
});

const addSecondLoginSession = {
  mutatePs: (ps) =>
    agentIn(ps, "proj-101-login").push({
      ...agentIn(ps, "proj-101-login")[0],
      paneKey: "zzz-tab:zzz-leaf",
      state: "done",
      prompt: "幫我跑 lint 並修好所有警告訊息，然後回報結果",
      lastAssistantMessage: "lint 已修好。\n\n要我順便跑測試嗎？",
    }),
  mutateTerminals: (terms) => {
    const a = terms.find((t) => t.handle === "term_a");
    terms.push({ ...a, handle: "term_a2", tabId: "zzz-tab", leafId: "zzz-leaf" });
  },
};

test("編號：同一 worktree 兩個以上 session 依建立先後（取不到就依 paneKey）編 #1、#2，單一 session 不編號", () => {
  const r = (q, dir) => JSON.parse(run("console.mjs", ["resolve", "--repo", app(), q], { dir }).out);
  const byPane = r("release-2026-10");
  assert.deepEqual(byPane.rows.map((x) => [x.tag, x.handle]), [["release…#1", "term_d"], ["release…#2", "term_d2"]]);
  const dir = fake({
    mutateTerminals: (terms) => {
      terms.find((t) => t.handle === "term_d").createdAt = 2000;
      terms.find((t) => t.handle === "term_d2").createdAt = 1000;
    },
  });
  const byCreated = r("release-2026-10", dir);
  assert.deepEqual(byCreated.rows.map((x) => [x.tag, x.handle]), [["release…#1", "term_d2"], ["release…#2", "term_d"]]);
  assert.equal(r("101").rows[0].tag, "PROJ-101");
  assert.equal(r("101").rows[0].session, null);
});

test("看板：多 session 的 worktree 各 session 一列，狀態與最後動態各自計算", () => {
  assert.equal(promptHead("一二三四五六七八九十一二三四五六七八九十多出來"), "一二三四五六七八九十一二三四五六七八九十…");
  assert.equal(promptHead(""), "（無）");
  const t = table(run("console.mjs", ["board", "--repo", app()], { dir: fake(addSecondLoginSession) }).out);
  assert.deepEqual(t.by["PROJ-101#1"], ["🔄 執行中", "PROJ-101#1", "登入頁改版", "實作中", "PROJ-101 實作登入頁改版"]);
  assert.deepEqual(t.by["PROJ-101#2"], ["💬 等待回應", "PROJ-101#2", "登入頁改版", "實作中", "要我順便跑測試嗎？"]);
  assert.ok(!t.by["PROJ-101"]);
  assert.ok(t.by["PROJ-6923"], "單一 session 不加編號");
});

test("resolve：6923#2／PROJ-6923#2 命中唯一 session；只給票號回 many 並附編號、狀態、最後一則 prompt", () => {
  const dir = fake(addSecondLoginSession);
  const r = (q) => JSON.parse(run("console.mjs", ["resolve", "--repo", app(), q], { dir }).out);
  for (const q of ["101#2", "PROJ-101#2", "proj-101#2"]) {
    const hit = r(q);
    assert.equal(hit.match, "one", q);
    assert.equal(hit.rows[0].handle, "term_a2");
    assert.equal(hit.rows[0].tag, "PROJ-101#2");
  }
  assert.equal(r("101#1").rows[0].handle, "term_a");
  assert.equal(r("101#3").match, "none");
  const many = r("101");
  assert.equal(many.match, "many");
  assert.deepEqual(
    many.rows.map((x) => [x.session, x.status, x.prompt]),
    [
      [1, "🔄 執行中", "PROJ-101 實作登入頁改版"],
      [2, "💬 等待回應", "幫我跑 lint 並修好所有警告訊息，然…"],
    ],
  );
});

test("detail：多 session 逐一列出編號、狀態、handle、最後一則 prompt；#n 只看該 session", () => {
  const dir = fake(addSecondLoginSession);
  const all = run("console.mjs", ["detail", "--repo", app(), "101"], { dir });
  assert.equal(all.lines[0], "[PROJ-101] 詳情");
  assert.equal(all.lines.filter((l) => l === "[PROJ-101] 詳情").length, 1);
  const at = all.lines.indexOf("sessions:");
  assert.deepEqual(all.lines.slice(at + 1, at + 3), [
    "#1 🔄 執行中｜term_a｜最後指令：PROJ-101 實作登入頁改版",
    "#2 💬 等待回應｜term_a2｜最後指令：幫我跑 lint 並修好所有警告訊息，然後回報結果",
  ]);
  const one = run("console.mjs", ["detail", "--repo", app(), "101#2"], { dir });
  assert.equal(one.lines[0], "[PROJ-101#2] 詳情");
  assert.ok(one.lines.includes("terminal: term_a2"));
  assert.ok(one.lines.includes("狀態：💬 等待回應"));
  assert.ok(!one.lines.includes("sessions:"));
  assert.deepEqual(detailReports(one.lines), expectedReports(dir, ["PROJ-101#2"]));
  assert.deepEqual(detailReports(one.lines)[0], ["### 💬 PROJ-101#2 等你回應", "", "> lint 已修好。", ">", "> 要我順便跑測試嗎？"]);
});

test("detail：多 session 不帶 #n 保留 sessions 清單，其下只有待你處理的 session 各一段回報", () => {
  const dir = fake(addSecondLoginSession);
  const { lines } = run("console.mjs", ["detail", "--repo", app(), "101"], { dir });
  const at = lines.indexOf("sessions:");
  assert.ok(at > 0);
  const reports = detailReports(lines);
  assert.equal(reports.length, 1, "🔄 執行中的 #1 不出回報段");
  assert.ok(lines.indexOf(reports[0][0]) > at + 2, "回報段在 sessions 清單之下");
  assert.deepEqual(reports, expectedReports(dir, ["PROJ-101#2"]));
  const busy = run("console.mjs", ["detail", "--repo", app(), "101#1"], { dir });
  assert.ok(busy.lines.includes("狀態：🔄 執行中"));
  assert.deepEqual(detailReports(busy.lines), []);
});

test("detail：💬 文字提問的回報段＝reportLines()，引用框是完整原文、不只最後 20 行", () => {
  const body = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行說明`).join("\n");
  const dir = fake({ mutatePs: (ps) => Object.assign(agentIn(ps, "chris-proj-102-question")[0], { state: "done", lastAssistantMessage: `${body}\n\n要先做 A 還是 B？` }) });
  const { lines } = run("console.mjs", ["detail", "--repo", app(), "chris-proj-102-question"], { dir });
  const reports = detailReports(lines);
  assert.equal(reports.length, 1, lines.join("\n"));
  const [tag] = reports[0][0].match(/^### 💬 (\S+) 等你回應$/).slice(1);
  assert.deepEqual(reports, expectedReports(dir, [tag]));
  assert.equal(reports[0][1], "");
  assert.ok(reports[0].slice(2).every((l) => l === ">" || l.startsWith("> ")));
  assert.equal(reports[0][2], "> 第 1 行說明");
  assert.equal(reports[0].at(-1), "> 要先做 A 還是 B？");
});

test("detail：選單、等待授權的回報段＝reportLines()；💤 閒置不出回報段", () => {
  const menu = withMenuSession();
  const m = detailReports(run("console.mjs", ["detail", "--repo", app(), "103"], { dir: menu }).lines);
  assert.deepEqual(m, expectedReports(menu, ["PROJ-103"]));
  assert.equal(m[0][0], "### 💬 PROJ-103 等你選擇");
  assert.ok(m[0].includes("| # | 選項 | 說明 |"));
  const dir = fake();
  const p = detailReports(run("console.mjs", ["detail", "--repo", app(), "proj-102-perm"], { dir }).lines);
  assert.equal(p.length, 1);
  assert.match(p[0][0], /^### 🔐 \S+ 等你授權$/);
  assert.equal(p[0][2], "> **Bash**");
  assert.deepEqual(p, expectedReports(dir, [p[0][0].split(" ")[2]]));
  const idle = run("console.mjs", ["detail", "--repo", app(), "103"], { dir });
  assert.ok(idle.lines.includes(`狀態：${LABEL.idle}`));
  assert.deepEqual(detailReports(idle.lines), []);
});

test("最後一則 prompt 為空時改用最後回覆最後一段前 20 字加「說：」，兩者都空才是（無）", () => {
  const said = "第一段不該出現。\n\n已經在瀏覽器打開兩個分頁，左側選單可以直接點選查看";
  assert.equal(sessionHint({ prompt: "跑測試", lastAssistantMessage: said }), "跑測試");
  assert.equal(sessionHint({ prompt: "  ", lastAssistantMessage: said }), "說：已經在瀏覽器打開兩個分頁，左側選單可以直…");
  assert.equal(sessionHint({ prompt: "", lastAssistantMessage: null }), "（無）");
  assert.equal(sessionHint(null), "（無）");
  const dir = fake({
    mutatePs: (ps) => {
      const [d, d2] = agentIn(ps, "release-2026-10");
      Object.assign(d, { prompt: "", lastAssistantMessage: null });
      Object.assign(d2, { prompt: "", lastAssistantMessage: said });
    },
  });
  const many = JSON.parse(run("console.mjs", ["resolve", "--repo", app(), "release-2026-10"], { dir }).out);
  assert.deepEqual(many.rows.map((x) => [x.tag, x.prompt]), [
    ["release…#1", "（無）"],
    ["release…#2", "說：已經在瀏覽器打開兩個分頁，左側選單可以直…"],
  ]);
  const detail = run("console.mjs", ["detail", "--repo", app(), "release-2026-10"], { dir }).lines;
  const s = detail.indexOf("sessions:");
  assert.deepEqual(detail.slice(s + 1, s + 3), [
    "#1 ⏸ 回覆完畢｜term_d｜（無）",
    "#2 ⏸ 回覆完畢｜term_d2｜說：已經在瀏覽器打開兩個分頁，左側選單可以直…",
  ]);
});

// The three rows from the 2026-10-01 screenshot that wrapped in a ~110-column Orca tab.
const screenshotRows = () => [
  {
    repo: "proj-v2-frontend",
    label: "dev",
    title: "—",
    stage: "實作中",
    sessions: [{ n: null, status: { kind: "done", text: "全部改動已 commit，本機測試與 lint 都通過，等你決定要不要推上遠端與開 MR。" } }],
  },
  {
    repo: "proj-v2-frontend",
    label: "PROJ-6700",
    title: "資料管理頁依產業別情境時間選擇匯入-demo-資料",
    stage: "已 push",
    sessions: [{ n: null, status: { kind: "waiting", text: "已推上遠端。\n\n要我接著補 demo 資料匯入流程的端對端測試，還是先等 review？" } }],
  },
  {
    repo: "proj-v2-frontend",
    label: "PROJ-6923",
    title: "dev-flow-trial-2",
    stage: "實作中",
    sessions: [{ n: null, status: { kind: "done", text: "dev-flow-trial-2 流程試跑完成，三個步驟都有產出紀錄，細節寫在試跑報告的最後一節。" } }],
  },
];

const tableLines = (lines) => lines.filter((l) => l.startsWith("| "));

test("看板每列顯示寬度不超過 100 欄（中文與 emoji 算 2 格），狀態、票號、階段維持原字", () => {
  assert.equal(displayWidth("PROJ-6700"), 9);
  assert.equal(displayWidth("💬 等待回應"), 11);
  assert.equal(displayWidth("（Orca 未納管）"), 15);
  const shot = boardLines(screenshotRows());
  for (const line of tableLines(shot)) assert.ok(displayWidth(line) <= BOARD_WIDTH, `${displayWidth(line)}: ${line}`);
  const t = table(shot.join("\n"));
  assert.deepEqual(t.rows.map((r) => [r[0], r[1], r[3]]), [
    ["⏸ 回覆完畢", "dev", "實作中"],
    ["💬 等待回應", "PROJ-6700", "已 push"],
    ["⏸ 回覆完畢", "PROJ-6923", "實作中"],
  ]);
  for (const dir of [fake(), withMenuSession(), fake(addSecondLoginSession)]) {
    const out = run("console.mjs", ["board", "--repo", app(), "--aligning", "PROJ-7001=把報表匯出頁改成可以依照產業別、時間區間與情境自由組合篩選"], { dir }).out;
    for (const line of tableLines(out.split("\n"))) assert.ok(displayWidth(line) <= BOARD_WIDTH, `${displayWidth(line)}: ${line}`);
    const fixture = table(out);
    assert.deepEqual([fixture.by["PROJ-102(perm)"][0], fixture.by["PROJ-102(perm)"][3]], ["🔐 等待授權", "未開工"]);
    assert.equal(fixture.tables.length, 2);
  }
});

test("摘要、最後動態截短後以…結尾，且是原文開頭；放得下時不截", () => {
  const t = table(boardLines(screenshotRows()).join("\n"));
  assertClipped(t.by["PROJ-6700"][2], "資料管理頁依產業別情境時間選擇匯入-demo-資料");
  assert.ok(t.by["PROJ-6700"][2].endsWith("…"), t.by["PROJ-6700"][2]);
  assert.equal(t.by["PROJ-6923"][2], "dev-flow-trial-2");
  for (const row of t.rows) assert.ok(row[4].endsWith("…"), row[4]);
  assertClipped(t.by["PROJ-6700"][4], "要我接著補 demo 資料匯入流程的端對端測試，還是先等 review？");
  const short = table(boardLines([{ ...screenshotRows()[2], title: "短票名", sessions: [{ n: null, status: { kind: "done", text: "好了。" } }] }]).join("\n"));
  assert.deepEqual(short.rows[0], ["⏸ 回覆完畢", "PROJ-6923", "短票名", "實作中", "好了。"]);
});

test("還在確認要不要開 session 的票：--aligning 階段為未開工，補在啟動 repo 表格最後一列，摘要同樣截短；帶 <repo>/ 前綴時補在該 repo 的表格", () => {
  const long = "把報表匯出頁改成可以依照產業別、時間區間與情境自由組合篩選";
  const config = path.join(tmp, "claude-config-define-goal");
  fs.mkdirSync(path.join(config, "skills", "define-goal"), { recursive: true });
  fs.writeFileSync(path.join(config, "skills", "define-goal", "SKILL.md"), "---\nname: define-goal\n---\n");
  const out = run("console.mjs", ["board", "--repo", app(), "--aligning", `PROJ-7001=${long}`, "--aligning", "api/PROJ-7002=後端匯出"], { env: { CLAUDE_CONFIG_DIR: config } }).out;
  const t = table(out);
  const last = t.tables[0].rows.at(-1);
  assert.deepEqual([last[0], last[1], last[3]], ["💬 等待回應", "PROJ-7001", "未開工"]);
  assert.ok(last[2].endsWith("…"));
  assertClipped(last[2], long);
  assertClipped(last[4], "要不要先跑 define-goal？");
  assert.deepEqual(t.tables[1].rows.at(-1).slice(0, 4), ["💬 等待回應", "PROJ-7002", "後端匯出", "未開工"]);
  for (const line of tableLines(out.split("\n"))) assert.ok(displayWidth(line) <= BOARD_WIDTH, line);
});

test("詳情多一行「摘要：<完整票名>」，不截斷", () => {
  const long = "登入頁改版：支援 SSO、記住我、忘記密碼流程與多語系錯誤訊息的完整重構";
  const dir = fake();
  fs.writeFileSync(path.join(dir, "linear-issue-PROJ-101.json"), JSON.stringify({ ok: true, result: { issue: { identifier: "PROJ-101", title: long } } }));
  const { lines } = run("console.mjs", ["detail", "--repo", app(), "101"], { dir });
  assert.equal(lines[0], "[PROJ-101] 詳情");
  assert.equal(lines[1], `摘要：${long}`);
  assert.equal(table(run("console.mjs", ["board", "--repo", app()], { dir }).out).by["PROJ-101"][2].endsWith("…"), true);
});

test("送出後：扣掉剛回覆的 session 已無待你處理 → 貼完整看板", () => {
  const dir = fake({
    mutatePs: (ps) => {
      for (const w of ps.result.worktrees) {
        for (const a of w.agents) if (!w.path.endsWith("proj-102-perm") && agentStatus(a).kind !== "idle") Object.assign(a, { state: "working" });
      }
    },
  });
  const { code, out } = run("console.mjs", ["after-send", "--repo", app(), "PROJ-102(perm)"], { dir });
  assert.equal(code, 0);
  const t = table(out);
  assert.ok(t.at > 0, out);
  assert.equal(t.rows.length, 6);
  assert.ok(out.includes("閒置 1 個"), out);
  assert.ok(!out.includes("還有") && !out.includes("### 📋"), out);
});

test("送出後：扣掉剛回的仍有題目在等回覆 → 只貼待回覆清單，不貼看板、不再有「還有 N 個待你處理」", () => {
  const { code, out } = run("console.mjs", ["after-send", "--repo", app(), "PROJ-102(perm)"]);
  assert.equal(code, 0);
  assert.match(out, /^### 📋 待回覆\n/);
  assert.deepEqual(Object.keys(replyList(out).by), ["PROJ-102(question)", "release…#1", "release…#2"]);
  assert.ok(!out.includes(BOARD_HEADER) && !out.includes("還有"), out);
  const many = run("console.mjs", ["after-send", "--repo", app(), "release…#1", "--aligning", "PROJ-7001=新票"]).out;
  assert.match(many, /^### 📋 待回覆\n/);
  const rows = [listRow("PROJ-1", session(asking("好嗎？"))), listRow("PROJ-2", session({ kind: "done", text: "好了。" }))];
  assert.deepEqual(afterSendLines(rows, new Set(["PROJ-1"])), boardLines(rows), "只剩 ⏸ 時沒有題目可列，貼看板");
});

test("沒綁票的 worktree：Orca 顯示名稱是 3～8 個英文字母時當暱稱，看板、詳情、回報、指揮都用它", () => {
  const nickname = (list) => {
    list.result.worktrees.find((w) => w.path.endsWith("release-2026-10")).displayName = "rel";
  };
  const dir = fake({ mutateList: nickname });
  const t = table(run("console.mjs", ["board", "--repo", app()], { dir }).out);
  assert.deepEqual(Object.keys(t.by).filter((k) => k.startsWith("rel")).sort(), ["rel#1", "rel#2"]);
  assert.equal(t.by["rel#1"][2], "release-2026-10", "摘要放 branch 名稱");
  const r = JSON.parse(run("console.mjs", ["resolve", "--repo", app(), "rel#2"], { dir }).out);
  assert.equal(r.match, "one");
  assert.equal(r.rows[0].tag, "rel#2");
  assert.equal(JSON.parse(run("console.mjs", ["resolve", "--repo", app(), "REL"], { dir }).out).match, "many");
  assert.equal(run("console.mjs", ["detail", "--repo", app(), "rel#1"], { dir }).lines[0], "[rel#1] 詳情");
  const changed = fake({
    mutateList: nickname,
    sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "release-2026-10")[0], { state: "waiting", lastAssistantMessage: "要繼續嗎？" })],
  });
  const w = run("watch.mjs", ["--baseline", baselineWith()], { dir: changed });
  assert.match(blocks(w.out).reports[0][0], /^### \S+ rel#\d /);
});

test("暱稱判斷：3～8 個英文字母才算（review、cleanup 算，ab、abcdefghi、含數字不算）；重新讀 Orca 仍以暱稱顯示", () => {
  const withName = (name) =>
    table(run("console.mjs", ["board", "--repo", app()], {
      dir: fake({ mutateList: (list) => (list.result.worktrees.find((w) => w.path.endsWith("release-2026-10")).displayName = name) }),
    }).out).by;
  for (const name of ["abc", "review", "cleanup", "abcdefgh"]) assert.ok(withName(name)[`${name}#1`], name);
  for (const name of ["ab", "abcdefghi", "rel10"]) assert.ok(withName(name)["release…#1"], name);
  assert.ok(withName("abc")["abc#2"], "每次都從 Orca 重讀，不靠本機狀態");
});

const LOGIN_PROMPT = "PROJ-101 實作登入頁改版";
const SETTLED = { state: "working", workingMode: "monitoring", mainAgent: { state: "done", stateStartedAt: 1 }, lastAssistantMessage: "登入頁做好了。" };
const settledAgent = (extra = {}) => ({ ...agentsOf("proj-101-login")[0], ...SETTLED, ...extra });
const assistantText = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } });
const launched = (id, text) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
const notified = (taskId, toolUseId) => userText(`<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>`);
const agentLaunch = (id) => launched(`tu-${id}`, `Async agent launched successfully.\nagentId: ${id} (internal ID)\nThe agent is working in the background.`);
const workflowLaunch = (id) => launched(`tu-${id}`, `Workflow launched in background. Task ID: ${id}\nSummary: probe`);
const bashLaunch = (id) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${id}`, content: `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output` }] } });
const turn = (...middle) => [userText(LOGIN_PROMPT), ...middle, assistantText("登入頁做好了。")];

function withTranscripts(files, fn = () => {}) {
  const prev = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
  try {
    const dir = claudeProjectDir(wt("proj-101-login"));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, entries] of Object.entries(files)) {
      if (typeof entries === "string") fs.writeFileSync(path.join(dir, file), entries);
      else writeTranscript(wt("proj-101-login"), file, entries);
    }
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = prev;
  }
}

const settledKind = (files, agent = settledAgent()) => withTranscripts(files, () => sessionStatus(agent, wt("proj-101-login")).kind);

test("只剩背景工作：working＋monitoring＋mainAgent done 改判回覆完畢；最後一段是問句改判等待回應", () => {
  assert.equal(settledKind({ "s.jsonl": turn() }), "done");
  const asked = settledAgent({ lastAssistantMessage: "登入頁做好了。\n\n要順便改註冊頁嗎？" });
  assert.equal(settledKind({ "s.jsonl": turn() }, asked), "waiting");
});

test("只剩背景工作：沒有 monitoring、沒有 mainAgent、mainAgent 不是 done 都維持執行中", () => {
  const files = { "s.jsonl": turn() };
  assert.equal(settledKind(files, settledAgent({ workingMode: undefined })), "busy");
  assert.equal(settledKind(files, settledAgent({ mainAgent: undefined })), "busy");
  for (const state of ["working", "waiting", "blocked"]) {
    assert.equal(settledKind(files, settledAgent({ mainAgent: { state } })), "busy", state);
  }
});

test("只剩背景工作：子代理或 Workflow 還沒收到結束通知或 TaskStop 結果時維持執行中", () => {
  assert.equal(settledKind({ "s.jsonl": turn(agentLaunch("a1")) }), "busy");
  assert.equal(settledKind({ "s.jsonl": turn(workflowLaunch("w1")) }), "busy");
  assert.equal(settledKind({ "s.jsonl": [...turn(agentLaunch("a1"), workflowLaunch("w1")), notified("a1", "tu-a1")] }), "busy");
  assert.equal(settledKind({ "s.jsonl": [...turn(agentLaunch("a1"), workflowLaunch("w1")), notified("a1", "tu-a1"), notified("w1", "tu-w1")] }), "done");
  const stopped = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-stop", content: '{"message":"Successfully stopped task: a1 (x)","task_id":"a1","task_type":"local_agent"}' }] } };
  assert.equal(settledKind({ "s.jsonl": turn(agentLaunch("a1"), stopped) }), "done");
});

test("只剩背景工作：背景 shell 指令沒收到結束通知不擋改判", () => {
  assert.equal(settledKind({ "s.jsonl": turn(bashLaunch("b1")) }), "done");
});

test("只剩背景工作：對不到、沒有紀錄檔、內容壞掉時維持執行中且不丟例外", () => {
  assert.equal(settledKind({}), "busy");
  assert.equal(settledKind({ "s.jsonl": [userText("別的指令"), assistantText("好")] }), "busy");
  assert.equal(settledKind({ "s.jsonl": "not json\n{broken" }), "busy");
  assert.equal(settledKind({ "s.jsonl": turn() }, settledAgent({ prompt: "" })), "busy");
  assert.equal(settledKind({ "s.jsonl": turn(), "old.jsonl": [userText("PROJ-101"), assistantText("x")] }), "done", "只比對最後一則指令，不算前綴");
});

test("只剩背景工作：對到多份時每份都沒有背景工作才改判，任一份還有就維持執行中", () => {
  assert.equal(settledKind({ "a.jsonl": turn(), "b.jsonl": turn() }), "done");
  assert.equal(settledKind({ "a.jsonl": turn(), "b.jsonl": turn(agentLaunch("a1")) }), "busy");
});

test("只剩背景工作：斜線指令照使用者打的原文比對，空白換行不影響", () => {
  const typed = "/other-plugin:speak-human 也照剛剛的方式檢核這一份 artifact，先列出需要修的地方。";
  const stored = userText(`<command-message>other-plugin:speak-human</command-message>\n<command-name>/other-plugin:speak-human</command-name>\n<command-args>也照剛剛的方式檢核這一份 artifact，先列出需要修的地方。</command-args>`);
  const meta = { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /x" }] } };
  assert.equal(settledKind({ "s.jsonl": [stored, meta, assistantText("好")] }, settledAgent({ prompt: typed })), "done");
  const bare = userText("<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args></command-args>");
  assert.equal(settledKind({ "s.jsonl": [bare, assistantText("好")] }, settledAgent({ prompt: "/compact" })), "done");
  assert.equal(settledKind({ "s.jsonl": [userText("PROJ-101  實作\n登入頁改版"), assistantText("好")] }), "done");
});

test("只剩背景工作：分頁有登記對話紀錄時直接看那份，不比對指令", () => {
  const handle = "term_registered";
  const log = path.join(tmp, "log");
  const day = new Date();
  const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}.jsonl`;
  const register = (file) => fs.appendFileSync(path.join(log, name), JSON.stringify({ ts: new Date().toISOString(), event: "session", handle, transcript: file }) + "\n");
  fs.mkdirSync(log, { recursive: true });
  withTranscripts({ "mine.jsonl": [userText("別的寫法"), assistantText("好")], "other.jsonl": turn(agentLaunch("a1")) }, () => {
    const dir = claudeProjectDir(wt("proj-101-login"));
    register(path.join(dir, "mine.jsonl"));
    assert.equal(sessionStatus(settledAgent(), wt("proj-101-login"), handle).kind, "done");
    register(path.join(dir, "other.jsonl"));
    assert.equal(sessionStatus(settledAgent(), wt("proj-101-login"), handle).kind, "busy");
    register(path.join(dir, "gone.jsonl"));
    assert.equal(sessionStatus(settledAgent(), wt("proj-101-login"), handle).kind, "busy", "登記的檔案不在就回到比對指令");
  });
});

test("只剩背景工作：Orca 的 prompt 截在 200 字時比對指令開頭", () => {
  const long = "改".repeat(250);
  const clipped = settledAgent({ prompt: long.slice(0, 200) });
  assert.equal(settledKind({ "s.jsonl": [userText(long), assistantText("好")] }, clipped), "done");
  assert.equal(settledKind({ "s.jsonl": [userText("PROJ-101 實作登入頁改版與註冊頁"), assistantText("好")] }), "busy", "短指令不比開頭");
});

test("只剩背景工作：watch 只回報一次，之後 Orca 自己轉成 done 不重複回報", () => {
  withTranscripts({ "s.jsonl": turn() });
  const dir = fake({ sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], SETTLED)] });
  const first = run("watch.mjs", ["--baseline", baselineWith()], { dir, env: { WATCH_TIMEOUT_MS: "5000" } });
  const b = blocks(first.out);
  assert.deepEqual(fresh(b.reports).map((r) => r[0]), ["### ⏸ PROJ-101 回覆完畢"]);
  assert.equal(table(b.board).by["PROJ-101"][0], "⏸ 回覆完畢");
  const baseline = first.lines.at(-1).replace(/^baseline: /, "");
  const orcaDone = fake({ mutatePs: (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { ...SETTLED, state: "done", workingMode: undefined }) });
  const second = run("watch.mjs", ["--baseline", baseline], { dir: orcaDone, env: { WATCH_TIMEOUT_MS: "0" } });
  assert.equal(second.lines[0], "[watch] timeout");
});

test("只剩背景工作：看板顯示改判後狀態，每列不超過 100 欄", () => {
  withTranscripts({ "s.jsonl": turn() });
  const count = (out) => {
    const states = table(out).rows.map((r) => r[0]);
    return [states.filter((x) => /^(💬|🔐|⏸)/.test(x)).length, states.filter((x) => x.startsWith("🔄")).length];
  };
  const before = run("console.mjs", ["board", "--repo", app()]).out;
  const after = run("console.mjs", ["board", "--repo", app()], { dir: fake({ mutatePs: (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], SETTLED) }) }).out;
  const [needBefore, busyBefore] = count(before);
  assert.deepEqual(count(after), [needBefore + 1, busyBefore - 1]);
  assert.equal(table(after).by["PROJ-101"][0], "⏸ 回覆完畢");
  for (const line of tableLines(after.split("\n"))) assert.ok(displayWidth(line) <= BOARD_WIDTH, line);
});

test("只剩背景工作：關閉前檢查照舊看 Orca，mainAgent 是 done 仍擋下", () => {
  withTranscripts({ "s.jsonl": turn() });
  const dir = fake({ mutatePs: (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], SETTLED) });
  assert.match(run("console.mjs", ["close-check", "--path", wt("proj-101-login")], { dir }).lines[0], /^blocked:.*session 執行中/);
});

const LIST_HEAD = "| 狀態 | 代號 | 問題 | 選項 | 建議 | 你通常會回 |";

// The reply list printed after the board: header line, then table rows keyed by code.
function replyList(out) {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("### 📋 "));
  if (at < 0) return null;
  const rows = [];
  for (const line of lines.slice(at + 4)) {
    if (!line.startsWith("| ")) break;
    rows.push(line.slice(2, -2).split(" | "));
  }
  return { at, head: lines[at], columns: lines[at + 2], lines: lines.slice(at + 2, at + 4 + rows.length), rows, by: Object.fromEntries(rows.map((r) => [r[1], r])) };
}

const session = (status, extra = {}) => ({ n: null, handle: "h", agent: { state: status.kind === "permission" ? "waiting" : "done" }, status, ...extra });
const listRow = (label, ...sessions) => ({ repo: "app", label, ticket: label, branch: label.toLowerCase(), title: "x", stage: "實作中", sessions });
const asking = (text) => agentStatus({ state: "done", lastAssistantMessage: text });
const releaseBusy = (ps) => agentIn(ps, "release-2026-10").forEach((a) => Object.assign(a, { state: "working", toolName: null }));

test("待回覆清單：watcher 回報時有 1 題以上在等就在看板後附清單，沒有就不附", () => {
  const two = run("watch.mjs", ["--baseline", allPanes("busy")]).out;
  const list = replyList(two);
  assert.ok(list, two);
  assert.ok(list.at > two.split("\n").indexOf(BOARD_HEADER), "清單在看板之後");
  assert.deepEqual(Object.keys(list.by).sort(), ["PROJ-102(perm)", "PROJ-102(question)", "release…#1", "release…#2"]);
  const permDone = (ps) => Object.assign(agentIn(ps, "proj-102-perm")[0], { state: "working", toolName: null });
  const one = run("watch.mjs", ["--baseline", allPanes("busy")], { dir: fake({ mutatePs: permDone }) }).out;
  assert.deepEqual(Object.keys(replyList(one).by), ["PROJ-102(question)", "release…#1", "release…#2"], one);
  const none = fake({
    mutatePs: (ps) => {
      permDone(ps);
      releaseBusy(ps);
      Object.assign(agentIn(ps, "chris-proj-102-question")[0], { lastAssistantMessage: "做完了。" });
    },
  });
  const zero = run("watch.mjs", ["--baseline", allPanes("busy")], { dir: none }).out;
  assert.ok(blocks(zero).reports.length > 0, zero);
  assert.equal(replyList(zero), null, zero);
});

test("待回覆清單：收 💬、🔐 與還沒 push 的 ⏸；🔄、💤 不列入", () => {
  const rows = [
    listRow("PROJ-1", session(asking("要改嗎？"))),
    listRow("PROJ-2", session({ kind: "done", text: "登入頁改好了。測試也過了。" })),
    listRow("PROJ-3", session({ kind: "busy", text: "跑" })),
    listRow("PROJ-4", session({ kind: "idle", text: "" })),
  ];
  assert.deepEqual(Object.keys(replyList(pendingBlock(rows).join("\n")).by), ["PROJ-1", "PROJ-2"]);
  rows.push(listRow("PROJ-5", session({ kind: "permission", tool: "Bash", input: "ls" })));
  assert.deepEqual(Object.keys(replyList(pendingBlock(rows).join("\n")).by), ["PROJ-1", "PROJ-2", "PROJ-5"]);
  assert.deepEqual(pendingBlock(rows.slice(2, 4)), []);
});

test("待回覆清單：實作中的 ⏸ 列入，問題欄放最後一句；未開工與規劃中同樣列入", () => {
  const done = { kind: "done", text: "登入頁改好了。測試也過了。" };
  const list = replyList(pendingBlock([listRow("PROJ-2", session(done))]).join("\n"));
  assert.equal(list.head, "### 📋 待回覆");
  assert.deepEqual(list.rows, [["⏸ 回覆完畢", "PROJ-2", "測試也過了。", "—", "—", "—"]]);
  for (const stage of ["未開工", "規劃中"]) assert.equal(pendingItems([{ ...listRow("PROJ-2", session(done)), stage }]).length, 1, stage);
  assert.equal(pendingItems([{ ...listRow("PROJ-2", session(done)), stage: undefined }]).length, 0, "不知道階段時不列");
});

test("待回覆清單：已 push 的 ⏸ 不列入", () => {
  const pushed = { ...listRow("PROJ-6", session({ kind: "done", text: "已推上遠端。" }, { handle: "h6" })), stage: "已 push" };
  assert.deepEqual(pendingBlock([pushed]), []);
  const rows = [listRow("PROJ-1", session(asking("要改嗎？"), { handle: "h1" })), pushed];
  assert.deepEqual(Object.keys(replyList(pendingBlock(rows).join("\n")).by), ["PROJ-1"]);
});

test("待回覆清單：代號沿用看板 tag，多 session 帶 #n，不另編流水號", () => {
  const out = run("console.mjs", ["board", "--repo", app()], { dir: fake(addSecondLoginSession) }).out;
  const codes = replyList(out).rows.map((r) => r[1]);
  const tags = table(out).rows.map((r) => r[1]);
  assert.deepEqual(codes.sort(), ["PROJ-101#2", "PROJ-102(perm)", "PROJ-102(question)", "release…#1", "release…#2"]);
  for (const code of codes) assert.ok(tags.includes(code), code);
});

test("待回覆清單：建議只轉述子 session 給的（選單 Recommended、文字明寫的建議），沒給就是—", () => {
  const menu = { kind: "waiting", menu: MENU };
  const menuRows = [listRow("PROJ-1", session(menu, { agent: { state: "waiting", toolName: "AskUserQuestion" } })), listRow("PROJ-2", session(asking("要改嗎？")))];
  const by = replyList(pendingBlock(menuRows).join("\n")).by;
  assert.equal(by["PROJ-1①"][4], "b 綠");
  assert.equal(by["PROJ-1②"][4], "—", "沒有 Recommended 就不補");
  assert.equal(by["PROJ-2"][4], "—");
  const said = pendingItems([listRow("PROJ-3", session(asking("**先做 A 還是 B？**\n\n- **A**：先改 API\n- **B**：先改畫面\n\n建議選 B，比較快看到結果。")))])[0];
  assert.deepEqual([said.entries[0].options, said.entries[0].suggest], ["a 先改 API／b 先改畫面", "b"]);
  assert.equal(pendingItems([listRow("PROJ-4", session(asking("建議：先跑測試。\n\n要繼續嗎？")))])[0].entries[0].suggest, "先跑測試");
  assert.equal(pendingItems([listRow("PROJ-5", session(asking("要選哪個建議選項？")))])[0].entries[0].suggest, "—", "問句裡的「建議」不算");
});

test("送出後帶多個代號：仍有題目在等就印只含剩下題目的清單，沒有就貼看板", () => {
  const dir = fake(addSecondLoginSession);
  const list = run("console.mjs", ["after-send", "--repo", app(), "PROJ-101#2"], { dir }).out;
  assert.match(list, /^### 📋 待回覆\n/);
  assert.deepEqual(Object.keys(replyList(list).by).sort(), ["PROJ-102(perm)", "PROJ-102(question)", "release…#1", "release…#2"]);
  assert.ok(!list.includes("還有") && !list.includes(BOARD_HEADER), list);
  const one = run("console.mjs", ["after-send", "--repo", app(), "PROJ-101#2", "PROJ-102(perm)"], { dir }).out;
  assert.deepEqual(Object.keys(replyList(one).by), ["PROJ-102(question)", "release…#1", "release…#2"]);
  assert.ok(!one.includes("還有") && !one.includes(BOARD_HEADER), one);
  const rows = [listRow("PROJ-1", session(asking("好嗎？"))), listRow("PROJ-2", session(asking("好嗎？")))];
  assert.deepEqual(afterSendLines(rows, new Set(["PROJ-1", "PROJ-2"])), boardLines(rows));
});

test("清單格式：標題列只有「### 📋 待回覆」，表格欄位依序為狀態、代號、問題、選項、建議、你通常會回；選單每題一列帶圈號，授權是允許／拒絕，空格放—", () => {
  const rows = [
    listRow("PROJ-6923", session({ kind: "waiting", menu: MENU }, { agent: { state: "waiting", toolName: "AskUserQuestion" } })),
    listRow("PROJ-7000", session({ kind: "permission", tool: "Bash", input: "ls" })),
    listRow("PROJ-8000", session(asking("要繼續嗎？"))),
  ];
  const list = replyList(pendingBlock(rows).join("\n"));
  assert.equal(list.head, "### 📋 待回覆");
  assert.equal(list.columns, LIST_HEAD);
  assert.ok(list.rows.every((r) => r.length === 6));
  assert.deepEqual(list.rows.map((r) => r.slice(0, 5)), [
    ["💬 等待回應", "PROJ-6923①", "要哪個顏色？", "a 紅／b 綠／c 藍／其他", "b 綠"],
    ["💬 等待回應", "PROJ-6923②", "要哪個尺寸？", "a S／b M／其他", "—"],
    ["🔐 等待授權", "PROJ-7000", "Bash ls", "允許／拒絕", "—"],
    ["💬 等待回應", "PROJ-8000", "要繼續嗎？", "—", "—"],
  ]);
});

test("清單每列顯示寬度不超過 100 欄，代號與狀態保持原字，問題、選項、建議放不下就以…截短", () => {
  const long = "要不要把報表匯出頁改成可以依照產業別、時間區間與情境自由組合篩選，並且同時支援匯出成 Excel 與 PDF 兩種格式？";
  const options = Array.from({ length: 6 }, (_, i) => ({ label: `很長的選項名稱第${i + 1}個` }));
  const rows = [
    listRow("PROJ-6923(report-export)", session(asking(long))),
    listRow("PROJ-7000", session({ kind: "waiting", menu: [{ question: long, options }] }, { agent: { state: "waiting", toolName: "AskUserQuestion" } })),
    listRow("PROJ-7001", session({ kind: "permission", tool: "Bash", input: "npm run db:migrate -- --env production ".repeat(4) })),
  ];
  const list = replyList(pendingBlock(rows).join("\n"));
  for (const line of list.lines) assert.ok(displayWidth(line) <= BOARD_WIDTH, `${displayWidth(line)}: ${line}`);
  assert.deepEqual(list.rows.map((r) => [r[1], r[0]]), [
    ["PROJ-6923(report-export)", "💬 等待回應"],
    ["PROJ-7000", "💬 等待回應"],
    ["PROJ-7001", "🔐 等待授權"],
  ]);
  assertClipped(list.by["PROJ-6923(report-export)"][2], long);
  assert.ok(list.by["PROJ-6923(report-export)"][2].endsWith("…"));
  assert.ok(list.by["PROJ-7000"][3].endsWith("…"));
  assert.match(list.by["PROJ-7000"][3], /^a 很…／b 很…／c.*…$/, "每個選項先一起縮短，放不下才整格截短");
});

test("現在狀況：有 1 題以上在等回覆時看板後附同一份清單，沒有時不附", () => {
  const out = run("console.mjs", ["board", "--repo", app()]).out;
  const list = replyList(out);
  assert.ok(list && list.at > out.split("\n").lastIndexOf(BOARD_HEADER), out);
  assert.equal(out.split("\n")[list.at - 1], "");
  const permDone = (ps) => Object.assign(agentIn(ps, "proj-102-perm")[0], { state: "working", toolName: null });
  assert.deepEqual(Object.keys(replyList(run("console.mjs", ["board", "--repo", app()], { dir: fake({ mutatePs: permDone }) }).out).by), ["PROJ-102(question)", "release…#1", "release…#2"]);
  const none = fake({
    mutatePs: (ps) => {
      permDone(ps);
      releaseBusy(ps);
      Object.assign(agentIn(ps, "chris-proj-102-question")[0], { lastAssistantMessage: "做完了。" });
    },
  });
  assert.equal(replyList(run("console.mjs", ["board", "--repo", app()], { dir: none }).out), null);
});

test("新回報連同先前未回的題目一起出現：同票其他 session 與別張票都算，已回或已離開等待的不再出現", () => {
  const dir = fake({
    ...addSecondLoginSession,
    sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "要改註冊頁嗎？" })],
  });
  const baseline = baselineWith({ "zzz-tab:zzz-leaf": "waiting" });
  const heads = blocks(run("watch.mjs", ["--baseline", baseline], { dir }).out).reports.map((r) => r[0]);
  assert.equal(heads[0], "### 💬 PROJ-101#1 等你回應");
  assert.deepEqual(heads.slice(1).sort(), [
    `### 💬 PROJ-101#2 等你回應${AGAIN}`,
    `### 💬 PROJ-102(question) 等你回應${AGAIN}`,
    `### 🔐 PROJ-102(perm) 等你授權${AGAIN}`,
  ].sort());
  const answered = fake({
    sequence: [
      () => {},
      (ps) => {
        Object.assign(agentIn(ps, "proj-102-perm")[0], { state: "working", toolName: null });
        Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "要改註冊頁嗎？" });
      },
    ],
  });
  const later = blocks(run("watch.mjs", ["--baseline", baselineWith()], { dir: answered }).out).reports.map((r) => r[0]);
  assert.deepEqual(later, ["### 💬 PROJ-101 等你回應", `### 💬 PROJ-102(question) 等你回應${AGAIN}`]);
  assert.ok(!later.some((h) => h.includes("release…")), "⏸ 回覆完畢不重貼");
});

test("先前未回的題目完整重貼原文，排在新題目之後、看板與清單之前；原文回報不因清單刪減", () => {
  const original = agentsOf("chris-proj-102-question")[0].lastAssistantMessage;
  const dir = fake({ sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "登入頁做好了。" })] });
  const { out } = run("watch.mjs", ["--baseline", baselineWith()], { dir });
  const b = blocks(out);
  assert.equal(b.reports[0][0], "### ⏸ PROJ-101 回覆完畢");
  const again = b.reports.find((r) => r[0] === `### 💬 PROJ-102(question) 等你回應${AGAIN}`);
  assert.equal(again.filter((l) => l.startsWith(">")).map((l) => l.replace(/^> ?/, "")).join("\n"), original);
  const at = (s) => out.indexOf(s);
  assert.ok(at(`PROJ-102(question) 等你回應${AGAIN}`) > at("### ⏸ PROJ-101"));
  assert.ok(at(BOARD_HEADER) > at(`PROJ-102(perm) 等你授權${AGAIN}`));
  assert.ok(at("### 📋 待回覆") > at(BOARD_HEADER), "清單在看板之後");
});

test("等待回應判斷：程式碼區塊與引用框以外任何一行有問號就是 💬，不限最後一段", () => {
  const text = "**要先改 API 還是先改畫面？**\n\n- A：先改 API\n- B：先改畫面\n\n建議選 B，畫面改完可以先給 PM 看。";
  assert.equal(asking(text).kind, "waiting");
  const rows = [listRow("PROJ-1", session(asking(text))), listRow("PROJ-2", session(asking("好嗎？")))];
  assert.equal(table(boardLines(rows).join("\n")).by["PROJ-1"][0], "💬 等待回應");
  assert.ok(replyList(pendingBlock(rows).join("\n")).by["PROJ-1"]);
});

test("等待回應判斷：問號只在程式碼區塊或引用框裡時仍是 ⏸", () => {
  assert.equal(asking("改好了：\n\n```js\nconst x = a?.b ?? c;\n```\n\n測試全過。").kind, "done");
  assert.equal(asking("你剛剛問：\n\n> 要不要順便改註冊頁？\n\n已經一起改好了。").kind, "done");
  assert.equal(asking("~~~\nwhy?\n~~~\n做完了。").kind, "done");
});

test("最後動態與清單問題欄都取整則回覆最後一個含問號的那一行，同樣排除程式碼與引用", () => {
  const text = "第一個問題：要改 API 嗎？\n\n**第二個問題：要不要順便改畫面？**\n\n> 引用的問句？\n\n```\nx?.y\n```\n\n建議先改 API。";
  const status = asking(text);
  assert.equal(lastActivity(status), "**第二個問題：要不要順便改畫面？**");
  assert.equal(pendingItems([listRow("PROJ-1", session(status))])[0].entries[0].question, "**第二個問題：要不要順便改畫面？**");
});

test("待開工：以「### 待開工」開頭接代號｜票號｜標題表格，代號依序 a、b、c，沒有「待開工 N 張」；N 為 0 時沒有輸出", () => {
  assert.deepEqual(todoLines([]), []);
  const long = "[FE] 報表匯出頁改成可以依照產業別、時間區間與情境自由組合篩選，並同時支援 Excel 與 PDF 兩種匯出格式";
  const lines = todoLines([{ identifier: "PROJ-6923", title: long }, { identifier: "PROJ-7", title: "[FE] 短標題" }]);
  assert.deepEqual(lines.slice(0, 4), ["### 待開工", "", "| 代號 | 票號 | 標題 |", "| --- | --- | --- |"]);
  assert.ok(!lines.some((l) => /待開工 \d+ 張/.test(l)));
  const rows = lines.slice(4).map((l) => l.slice(2, -2).split(" | "));
  assert.deepEqual(rows.map((r) => r[0]), ["a", "b"]);
  assert.deepEqual(rows.map((r) => r[1]), ["PROJ-6923", "PROJ-7"]);
  assert.ok(rows[0][2].endsWith("…"));
  assertClipped(rows[0][2], long);
  assert.equal(rows[1][2], "[FE] 短標題");
  for (const line of lines) assert.ok(displayWidth(line) <= BOARD_WIDTH, line);
});

const API_PANE = "x:y";
const apiWt = () => path.join(tmp, "api-wt");
const apiAgent = (ps) => ps.result.worktrees.find((w) => w.repoId === "other-repo-id").agents[0];
const apiTerminal = (terms) => terms.push({ ...terms.find((t) => t.handle === "term_a"), handle: "term_x", tabId: "x", leafId: "y", worktreePath: apiWt(), branch: "refs/heads/chris/proj-6923-dev-flow-trial" });

test("跨 repo 監看：一支 watcher 涵蓋 Orca 所有 repo，兩個 repo 的 session 同時停下兩則都回報", () => {
  const dir = fake({
    mutateTerminals: apiTerminal,
    sequence: [
      () => {},
      (ps) => {
        Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "前端好了。" });
        Object.assign(apiAgent(ps), { state: "waiting", toolName: "Bash", toolInput: "npm test" });
      },
    ],
  });
  const { code, out } = run("watch.mjs", ["--baseline", baselineWith()], { dir });
  assert.equal(code, 0);
  const heads = fresh(blocks(out).reports).map((r) => r[0]);
  assert.deepEqual(heads.sort(), ["### ⏸ PROJ-101 回覆完畢", "### 🔐 PROJ-6923 等你授權"].sort());
  const t = table(blocks(out).board);
  assert.deepEqual(t.tables.map((x) => x.repo), ["**app**", "**api**"]);
  assert.ok(replyList(out).by["PROJ-6923"], "別的 repo 的題目一樣進待回覆清單");
});

test("同一時間只有一支 watcher：已有一支（含舊版帶 --repo 的）就印 already-running；--takeover 先停掉舊的再接手", async () => {
  const old = path.join(tmp, "old");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "watch.mjs"), "setTimeout(() => {}, 60000);\n");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.join(old, "watch.mjs"), "--repo", "/somewhere/else"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (_, signal) => resolve(signal)));
  try {
    await new Promise((r) => setTimeout(r, 200));
    const busy = run("watch.mjs", [], { env: { WATCH_TIMEOUT_MS: "0" } });
    assert.equal(busy.out, "[watch] already-running");
    const taken = run("watch.mjs", ["--takeover"], { env: { WATCH_TIMEOUT_MS: "0" } });
    assert.equal(taken.lines[0], "[watch] timeout");
    assert.equal(await exited, "SIGTERM");
  } finally {
    child.kill();
  }
});

const sameMain = {
  mutatePs: (ps) => {
    agentIn(ps, "/app").push({ ...agentIn(ps, "/app")[0], paneKey: "other:pane", state: "done", lastAssistantMessage: "前端要繼續嗎？" });
    const api = ps.result.worktrees.find((w) => w.repoId === "other-repo-id");
    api.branch = "refs/heads/main";
    Object.assign(api.agents[0], { state: "done", lastAssistantMessage: "後端要繼續嗎？" });
  },
  mutateTerminals: (terms) => {
    apiTerminal(terms);
    terms.push({ ...terms.find((t) => t.handle === "term_a"), handle: "term_m", tabId: "other", leafId: "pane", worktreePath: app(), branch: "refs/heads/main" });
  },
};

test("代號撞名：不同 repo 的代號相同時，看板、回報、待回覆清單、resolve 都用 <repo>/<代號>；沒撞名時不加", () => {
  const dir = fake(sameMain);
  const board = run("console.mjs", ["board", "--repo", app()], { dir }).out;
  const t = table(board);
  assert.ok(t.by["app/main"] && t.by["api/main"], board);
  assert.equal(t.tables.find((x) => x.repo === "**api**").rows[0][1], "api/main");
  assert.ok(t.by["PROJ-101"], "沒撞名的代號不變");
  assert.deepEqual(Object.keys(replyList(board).by).filter((k) => k.endsWith("/main")).sort(), ["api/main", "app/main"]);
  const r = (q) => JSON.parse(run("console.mjs", ["resolve", "--repo", app(), q], { dir }).out);
  assert.deepEqual([r("api/main").match, r("api/main").rows[0].handle, r("api/main").rows[0].tag], ["one", "term_x", "api/main"]);
  assert.deepEqual([r("app/main").match, r("app/main").rows[0].handle], ["one", "term_m"]);
  assert.equal(r("main").match, "many");
  const changed = fake({ ...sameMain, sequence: [() => {}, (ps) => sameMain.mutatePs(ps)] });
  const heads = fresh(blocks(run("watch.mjs", ["--baseline", baselineWith()], { dir: changed }).out).reports).map((x) => x[0]);
  assert.deepEqual(heads.sort(), ["### 💬 api/main 等你回應", "### 💬 app/main 等你回應"]);
});

test("非啟動 repo 的 session：resolve、詳情、選單代答、關閉檢查都作用得到", () => {
  const perm = fake({ mutateTerminals: apiTerminal, mutatePs: (ps) => Object.assign(apiAgent(ps), { state: "waiting", toolName: "Bash", toolInput: "npm test" }) });
  const hit = JSON.parse(run("console.mjs", ["resolve", "--repo", app(), "6923"], { dir: perm }).out);
  assert.equal(hit.match, "one");
  assert.deepEqual([hit.rows[0].repo, hit.rows[0].main, hit.rows[0].path, hit.rows[0].handle], ["api", path.join(tmp, "other-repo"), apiWt(), "term_x"]);
  const detail = run("console.mjs", ["detail", "--repo", app(), "6923"], { dir: perm }).lines;
  assert.equal(detail[0], "[PROJ-6923] 詳情");
  assert.ok(detail.includes("repo: api") && detail.includes(`worktree: ${apiWt()}`), detail.join("\n"));

  const prev = process.env.CLAUDE_PROJECTS_DIR;
  process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, "claude-projects");
  try {
    writeTranscript(apiWt(), "s.jsonl", [userText("PROJ-6923 選顏色"), toolUse("t1", "AskUserQuestion", { questions: [MENU[0]] })]);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = prev;
  }
  const menu = fake({
    mutateTerminals: apiTerminal,
    mutatePs: (ps) => Object.assign(apiAgent(ps), menuAgent("PROJ-6923 選顏色")),
    sequence: [() => {}, (ps) => Object.assign(apiAgent(ps), { state: "working", toolName: null })],
  });
  const answered = run("console.mjs", ["answer", "--repo", app(), "6923", "2"], { dir: menu });
  assert.deepEqual([answered.code, answered.out], [0, "[PROJ-6923] 已選擇：顏色→綠 (Recommended)"]);
  assert.ok(fs.readFileSync(path.join(menu, "calls.log"), "utf8").includes("terminal send --terminal term_x --text 2"));

  const idle = fake({ mutatePs: (ps) => Object.assign(apiAgent(ps), { state: "done", lastAssistantMessage: "好了。" }) });
  assert.equal(run("console.mjs", ["close-check", "--path", apiWt()], { dir: idle }).lines[0], "ok");
});

test("沒有 session 的 worktree 不上看板，但 resolve、詳情、關閉檢查都找得到", () => {
  assert.ok(!table(run("console.mjs", ["board", "--repo", app()]).out).by["PROJ-104"]);
  const hit = JSON.parse(run("console.mjs", ["resolve", "--repo", app(), "104"]).out);
  assert.deepEqual([hit.match, hit.rows[0].path, hit.rows[0].handle], ["one", wt("proj-104-noagent"), null]);
  assert.equal(JSON.parse(run("console.mjs", ["resolve", "--repo", app(), "external-spike"]).out).match, "one");
  assert.equal(run("console.mjs", ["detail", "--repo", app(), "104"]).lines[0], "[PROJ-104] 詳情");
  assert.equal(run("console.mjs", ["close-check", "--path", wt("proj-104-noagent")]).lines[0], "ok");
});

// A Claude session whose own conversation loaded the worktree-console skill (or, with `skill: false`, a dev session
// that only ran `board`, its subagent having loaded the skill).
function claudeSession(id, { skill = true } = {}) {
  const dir = path.join(tmp, "claude-projects", "-sessions");
  const line = (e) => JSON.stringify({ timestamp: "2026-10-02T14:50:00.000Z", ...e });
  const board = (isSidechain) => ({ type: "assistant", isSidechain, message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "node /x/skills/worktree-console/scripts/console.mjs board --repo R" } }] } });
  const loaded = (isSidechain) => ({ type: "user", isSidechain, message: { content: [{ type: "text", text: "Base directory for this skill: /x/skills/worktree-console\n\n# Worktree Console" }] } });
  fs.mkdirSync(path.join(dir, id, "subagents"), { recursive: true });
  const main = skill ? [{ type: "user", message: { content: "/worktree-console:worktree-console" } }, loaded(false)] : [{ type: "user", message: { content: "跑子代理模擬新舊版 skill" } }, board(false)];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), main.map(line).join("\n") + "\n");
  if (!skill) fs.writeFileSync(path.join(dir, id, "subagents", "agent-a.jsonl"), [loaded(true), board(true)].map(line).join("\n") + "\n");
  return id;
}

test("中控台互相排除：登記過的另一個中控台 session 不上看板、不被回報；看板會登記自己並清掉已關的分頁", () => {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  fs.writeFileSync(path.join(home, "consoles.json"), JSON.stringify(["term_x", "term_gone"]));
  const env = { WORKTREE_CONSOLE_HOME: home, CLAUDE_CODE_SESSION_ID: claudeSession("real-console") };
  const dir = fake({ mutateTerminals: apiTerminal });
  const t = table(run("console.mjs", ["board", "--repo", app()], { dir, env }).out);
  assert.ok(!t.by["PROJ-6923"], "另一個中控台不上看板");
  assert.deepEqual(t.tables.map((x) => x.repo), ["**app**"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "consoles.json"), "utf8")).sort(), ["term_self", "term_x"]);
  const asks = { mutateTerminals: apiTerminal, sequence: [() => {}, (ps) => Object.assign(apiAgent(ps), { state: "done", lastAssistantMessage: "要接手嗎？" })] };
  const quiet = run("watch.mjs", ["--baseline", baselineWith()], { dir: fake(asks), env: { ...env, WATCH_TIMEOUT_MS: "300" } });
  assert.equal(quiet.lines[0], "[watch] timeout", quiet.out);
  const seen = run("watch.mjs", ["--baseline", baselineWith()], { dir: fake(asks) });
  assert.match(seen.out, /### 💬 PROJ-6923 等你回應/, "沒登記時照常回報");
});

const idleStatus = { kind: "idle", text: "" };
const repoRow = (repo, label, ...sessions) => ({ ...listRow(label, ...sessions), repo });
const idleLine = (lines) => lines.filter((l) => /閒置/.test(l) && !l.startsWith("| "));

test("看板：💤 閒置不進表格，🔄／🔐／💬／⏸ 的列照舊", () => {
  const rows = [
    listRow("PROJ-1", session({ kind: "busy", text: "跑" })),
    listRow("PROJ-2", session({ kind: "permission", tool: "Bash", input: "ls" })),
    listRow("PROJ-3", session(asking("好嗎？"))),
    listRow("PROJ-4", session({ kind: "done", text: "好了。" })),
    listRow("PROJ-5", session(idleStatus)),
  ];
  const lines = boardLines(rows);
  const t = table(lines.join("\n"));
  assert.deepEqual(t.rows.map((r) => [r[0], r[1]]), [
    ["🔄 執行中", "PROJ-1"],
    ["🔐 等待授權", "PROJ-2"],
    ["💬 等待回應", "PROJ-3"],
    ["⏸ 回覆完畢", "PROJ-4"],
  ]);
  assert.ok(!lines.some((l) => l.includes(LABEL.idle)), lines.join("\n"));
  for (const line of tableLines(lines)) assert.ok(displayWidth(line) <= BOARD_WIDTH, line);
  const board = table(run("console.mjs", ["board", "--repo", app()]).out);
  assert.ok(!board.by["PROJ-103"], "fixture 裡閒置的 PROJ-103 不進表格");
  assert.ok(!board.rows.some((r) => r[0] === LABEL.idle));
});

test("看板：各 repo 表格下方不再有「另有 N 個閒置」，整張看板最下面一行是跨 repo 合計，同 worktree 多個 session 各算一個", () => {
  const rows = [
    repoRow("app", "PROJ-1", session({ kind: "busy", text: "跑" })),
    repoRow("app", "PROJ-5", session(idleStatus, { n: 1 }), session(idleStatus, { n: 2 }), session({ kind: "done", text: "好了。" }, { n: 3 })),
    repoRow("api", "PROJ-7", session({ kind: "busy", text: "跑" }), ),
    repoRow("api", "PROJ-6", session(idleStatus)),
  ];
  const lines = boardLines(rows);
  assert.ok(!lines.some((l) => /另有/.test(l)), lines.join("\n"));
  assert.deepEqual(lines.slice(-2), ["", "閒置 3 個"]);
  assert.deepEqual(idleLine(lines), ["閒置 3 個"]);
  assert.deepEqual(table(lines.join("\n")).rows.map((r) => r[1]), ["PROJ-1", "PROJ-5#3", "PROJ-7"]);
  for (const tag of ["PROJ-5", "PROJ-6", "#1", "#2"]) assert.ok(!idleLine(lines)[0].includes(tag), idleLine(lines)[0]);
  const out = run("console.mjs", ["board", "--repo", app()]).out.split("\n");
  const at = out.indexOf("閒置 1 個");
  assert.ok(at > table(out.join("\n")).tables.at(-1).at, out.join("\n"));
  assert.deepEqual([out[at - 1], out[at + 1], out[at + 2].startsWith("### 📋 ")], ["", "", true], "合計在看板最後、待回覆清單之前");
});

test("看板：底部合計 `封存 N 個、閒置 M 個`，為 0 的項目不寫、全 0 整行不印", () => {
  const archivedSession = (status, extra = {}) => session(status, { archived: true, ...extra });
  const both = boardLines([listRow("PROJ-1", session({ kind: "busy", text: "跑" })), listRow("PROJ-2", archivedSession({ kind: "done", text: "好了。" })), listRow("PROJ-3", session(idleStatus)), listRow("PROJ-4", archivedSession(idleStatus))]);
  assert.deepEqual(both.slice(-2), ["", "封存 2 個、閒置 1 個"]);
  assert.ok(!table(both.join("\n")).by["PROJ-2"], "封存的不進表格");
  const onlyArchived = boardLines([listRow("PROJ-1", session({ kind: "busy", text: "跑" })), listRow("PROJ-2", archivedSession({ kind: "done", text: "好了。" }))]);
  assert.deepEqual(onlyArchived.slice(-2), ["", "封存 1 個"]);
  const none = boardLines([listRow("PROJ-1", session({ kind: "done", text: "好了。" }))]);
  assert.ok(!none.some((l) => /閒置|封存/.test(l)), none.join("\n"));
  assert.equal(hiddenTally([]), "");
});

test("看板：某 repo 全部閒置／封存時只印 **<repo 名稱>** 加「全部閒置／封存」，沒有表頭也沒有表格", () => {
  const rows = [
    repoRow("app", "PROJ-1", session({ kind: "busy", text: "跑" })),
    repoRow("api", "PROJ-7", session(idleStatus, { n: 1 }), session({ kind: "done", text: "好了。" }, { n: 2, archived: true })),
  ];
  const lines = boardLines(rows);
  const at = lines.indexOf("**api**");
  assert.deepEqual(lines.slice(at), ["**api**", "", "全部閒置／封存", "", "封存 1 個、閒置 1 個"]);
  assert.deepEqual(table(lines.join("\n")).tables.map((x) => x.repo), ["**app**"]);
  assert.deepEqual(boardLines([listRow("PROJ-8", session(idleStatus))]), ["**app**", "", "全部閒置／封存", "", "閒置 1 個"]);
});

test("watcher 回報與 after-send 貼的看板套用同一規則：閒置不進表格、看板最下面列閒置合計", () => {
  const dir = fake({
    sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "好了。" })],
  });
  const board = blocks(run("watch.mjs", ["--baseline", baselineWith()], { dir }).out).board;
  assert.ok(!table(board).by["PROJ-103"], board);
  assert.ok(board.split("\n").includes("閒置 1 個"), board);
  const quiet = fake({
    mutatePs: (ps) => {
      for (const w of ps.result.worktrees) {
        for (const a of w.agents) if (!w.path.endsWith("proj-102-perm") && agentStatus(a).kind !== "idle") Object.assign(a, { state: "working" });
      }
    },
  });
  const sent = run("console.mjs", ["after-send", "--repo", app(), "PROJ-102(perm)"], { dir: quiet }).out;
  assert.ok(!table(sent).by["PROJ-103"], sent);
  assert.ok(sent.split("\n").includes("閒置 1 個"), sent);
  const rows = [listRow("PROJ-1", session(asking("好嗎？"))), listRow("PROJ-2", session(idleStatus))];
  assert.deepEqual(afterSendLines(rows, new Set(["PROJ-1"])), boardLines(rows));
  assert.deepEqual(reportBlock([], rows).slice(0, boardLines(rows).length), boardLines(rows));
});

test("閒置 session 不在看板上，resolve、detail、指揮照樣用代號找得到它", () => {
  const hit = JSON.parse(run("console.mjs", ["resolve", "--repo", app(), "103"]).out);
  assert.equal(hit.match, "one");
  assert.deepEqual([hit.rows[0].tag, hit.rows[0].handle, hit.rows[0].status], ["PROJ-103", "term_e", LABEL.idle]);
  assert.equal(JSON.parse(run("console.mjs", ["resolve", "--repo", app(), "PROJ-103"]).out).rows[0].handle, "term_e");
  const { lines } = run("console.mjs", ["detail", "--repo", app(), "103"]);
  assert.equal(lines[0], "[PROJ-103] 詳情");
  assert.ok(lines.includes("terminal: term_e") && lines.includes(`狀態：${LABEL.idle}`), lines.join("\n"));
});

const PANE_101 = pane("proj-101-login");
const newSession = (ps, state = "working") =>
  agentIn(ps, "proj-101-login").push({ ...agentIn(ps, "proj-101-login")[0], paneKey: "tab_new:leaf_new", state, prompt: "接手交棒：先完整讀 /n.md", lastAssistantMessage: null });
const newTerminal = (terms) => terms.push({ ...terms.find((t) => t.handle === "term_a"), handle: "term_new", tabId: "tab_new", leafId: "leaf_new" });

function handoffEvent(home, fields) {
  fs.mkdirSync(path.join(home, "events"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "events", "sess-101.json"),
    JSON.stringify({ oldHandle: "term_a", oldPaneKey: PANE_101, cwd: wt("proj-101-login"), percent: 41, updatedAt: Date.now(), ...fields }),
  );
}

test("子 session 自動交棒：舊 session 停下不報成待處理，換手完成只印一行「[票號] 已自動交棒（context N%）」，看板上這張票只剩新 session", () => {
  const home = fs.mkdtempSync(path.join(tmp, "handoff-"));
  const env = { AUTO_HANDOFF_HOME: home, WATCH_TIMEOUT_MS: "300" };
  handoffEvent(home, { status: "writing" });
  const stopped = fake({ sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "交棒說明寫好了。" })] });
  const quiet = run("watch.mjs", ["--baseline", baselineWith()], { dir: stopped, env });
  assert.equal(quiet.lines[0], "[watch] timeout", quiet.out);

  handoffEvent(home, { status: "switching", newHandle: "term_new", newPaneKey: "tab_new:leaf_new" });
  const reading = fake({ mutateTerminals: newTerminal, sequence: [() => {}, (ps) => newSession(ps, "done")] });
  assert.equal(run("watch.mjs", ["--baseline", baselineWith()], { dir: reading, env }).lines[0], "[watch] timeout", "新 session 讀交棒說明時的停下也不報");

  handoffEvent(home, { status: "done", newHandle: "term_new", newPaneKey: "tab_new:leaf_new" });
  const swapped = {
    mutateTerminals: (terms) => {
      newTerminal(terms);
      terms.splice(terms.findIndex((t) => t.handle === "term_a"), 1);
    },
    mutatePs: (ps) => {
      newSession(ps);
      agentIn(ps, "proj-101-login").shift();
    },
  };
  const done = run("watch.mjs", ["--baseline", baselineWith()], { dir: fake(swapped), env });
  assert.deepEqual(done.lines.filter((l) => !l.startsWith("baseline:")), ["[PROJ-101] 已自動交棒（context 41%）"]);
  assert.equal(run("watch.mjs", ["--baseline", baselineWith()], { dir: fake(swapped), env }).lines[0], "[watch] timeout", "同一次交棒只印一次");
  const board = table(run("console.mjs", ["board", "--repo", app()], { dir: fake(swapped), env }).out);
  assert.deepEqual(board.rows.filter((r) => r[1].startsWith("PROJ-101")).map((r) => [r[0], r[1]]), [[LABEL.busy, "PROJ-101"]]);
});

test("中控台自己交棒：新中控台 --takeover 接手後只有一支 watch.mjs、consoles.json 只有新分頁、新中控台不上看板", async () => {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  fs.writeFileSync(path.join(home, "consoles.json"), JSON.stringify(["term_new"]));
  const consoleSwap = {
    mutateTerminals: (terms) => {
      const self = terms.find((t) => t.handle === "term_self");
      Object.assign(self, { handle: "term_new", tabId: "tab_con", leafId: "leaf_con" });
    },
    mutatePs: (ps) => Object.assign(agentIn(ps, "/app")[0], { paneKey: "tab_con:leaf_con", state: "done", lastAssistantMessage: "中控台接手了，要看板嗎？" }),
  };
  const env = { WORKTREE_CONSOLE_HOME: home, ORCA_TERMINAL_HANDLE: "term_new" };
  const board = run("console.mjs", ["board", "--repo", app()], { dir: fake(consoleSwap), env }).out;
  assert.doesNotMatch(board, /\| main \|/, "新中控台不上看板");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "consoles.json"), "utf8")), ["term_new"]);

  const old = path.join(tmp, "old");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "watch.mjs"), "setTimeout(() => {}, 60000);\n");
  const { spawn } = await import("node:child_process");
  const stale = spawn(process.execPath, [path.join(old, "watch.mjs")], { stdio: "ignore" });
  const dir = fake(consoleSwap);
  const fresh = spawn(process.execPath, [path.join(scripts, "watch.mjs"), "--takeover"], {
    stdio: "ignore",
    env: { ...process.env, ORCA_BIN: fakeOrca, FAKE_ORCA_DIR: dir, ...env, AUTO_HANDOFF_HOME: path.join(tmp, "handoff"), WATCH_INTERVAL_MS: "30", WATCH_TIMEOUT_MS: "60000", CLAUDE_PROJECTS_DIR: path.join(tmp, "claude-projects"), WATCH_PGREP_PATTERN: `${scripts}/watch\\.mjs|${old}/watch\\.mjs` },
  });
  try {
    await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 400));
    const pids = spawnSync("pgrep", ["-f", `${scripts}/watch\\.mjs|${old}/watch\\.mjs`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    assert.deepEqual(pids, [String(fresh.pid)]);
    assert.notEqual(stale.exitCode ?? stale.signalCode, null, "舊 watcher 已被停掉");
  } finally {
    fresh.kill();
    stale.kill();
  }
});

// Real `orca terminal read --screen` captures from a child claude session, each with the text that was sent.
const SCREENS = {
  chat: ["chat.json", "請只回覆一個字：好"],
  chatWrapped: ["chat-wrapped.json", `長文測試：${"這是一段很長的測試文字，用來觸發貼上收起。".repeat(45)}結尾請回覆收到`],
  queued: ["queued.json", "排隊測試二：之後請回覆收到"],
  workflows: ["workflows.json", "檢視頁測試：請回覆收到"],
  pasted: ["pasted-collapsed.json", `收起測試六：${"一段很長的文字用來觸發收起。".repeat(70)}`],
  upgrade: ["upgrade-running.json", "/other-plugin:speak-human 也照剛剛的方式檢核這一份 artifact：https://claude.ai/artifact/FSxud2JSM4noiZaymJv4t2 ，先列出需要修和建議修的地方，等我確認再改。"],
  memory: ["memory-running.json", "memory 可以，改回按 8 才預填。另外一個需求：輸入框上方橫條的排隊候選（現在是 1–7: <暱稱>）最多只顯示 5 個。請評估要併進這次目標還是另開，給建議後再問我。"],
};
const screenFile = (name) => path.join(fixtures, "screens", SCREENS[name][0]);
const screenOf = (name) => JSON.parse(fs.readFileSync(screenFile(name), "utf8")).result.terminal;

test("送出確認：真實子 session 畫面判定送達／排隊中／送 Esc 重送／未送達", () => {
  const verdict = (name, text = SCREENS[name][1]) => deliveryVerdict(screenOf(name), text);
  assert.deepEqual(verdict("chat"), { verdict: "delivered" }, "一般對話：那句話已進對話");
  assert.deepEqual(verdict("chatWrapped"), { verdict: "delivered" }, "長句被畫面折行也認得出來");
  assert.deepEqual(verdict("queued"), { verdict: "queued" }, "執行中排隊也算送達");
  assert.deepEqual(verdict("workflows"), { verdict: "retry", reason: "畫面停在檢視頁" }, "/workflows 檢視頁吃掉文字：送 Esc 重送");
  assert.deepEqual(verdict("pasted"), { verdict: "failed", reason: "被當成貼上內容收起，還留在輸入框" }, "收成 Pasted text：一般對話畫面不送 Esc");
  assert.deepEqual(verdict("chat", "沒送過的另一句"), { verdict: "failed", reason: "畫面上沒看到這句話" }, "一般對話畫面沒看到：未送達");
  assert.equal(verdict("workflows", "/workflows").verdict, "retry", "檢視頁上方殘留的 /workflows 指令不算送達");
});

function sendRun(screens, text, extra = {}, dir = fake()) {
  screens.forEach((name, i) => fs.copyFileSync(screenFile(name), path.join(dir, `screen-term_e-${i}.json`)));
  const res = run("console.mjs", ["send", "--terminal", "term_e", "--tag", "PROJ-103", "--", text], {
    dir,
    env: { SEND_CHECK_MS: "0", SEND_CHECK_TRIES: "2", ...extra },
  });
  const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter((l) => l.startsWith("terminal send"));
  return { ...res, sends: calls.map((l) => l.replace("terminal send --terminal term_e --text ", "")) };
}

test("send：一般對話送達回「已送出」，排隊中回「已送出（排隊中）」，都只送一次", () => {
  const chat = sendRun(["chat"], SCREENS.chat[1]);
  assert.deepEqual([chat.code, chat.out, chat.sends], [0, "[PROJ-103] 已送出", [`${SCREENS.chat[1]} --enter`]]);
  const queued = sendRun(["queued"], SCREENS.queued[1]);
  assert.deepEqual([queued.code, queued.out, queued.sends], [0, "[PROJ-103] 已送出（排隊中）", [`${SCREENS.queued[1]} --enter`]]);
});

test("send：停在 /workflows 檢視頁 → 送 Esc 退回對話重送一次並再確認", () => {
  const text = SCREENS.chat[1];
  const ok = sendRun(["workflows", "workflows", "chat"], text);
  assert.deepEqual([ok.code, ok.out], [0, "[PROJ-103] 已送出（已按 Esc 退回對話後重送）"]);
  assert.deepEqual(ok.sends, [`${text} --enter`, "\u001b", `${text} --enter`]);
  const stuck = sendRun(["workflows"], text);
  assert.equal(stuck.code, 1);
  assert.equal(stuck.lines[0], "[PROJ-103] 未送達：畫面停在檢視頁，按 Esc 退回對話重送後仍沒看到這句話");
  assert.deepEqual(stuck.sends, [`${text} --enter`, "\u001b", `${text} --enter`], "只重送一次");
  assert.ok(stuck.out.includes("Esc to close"), "附畫面最後幾行");
});

test("send：一般對話畫面沒看到那句話（含被收成 Pasted text）→ 不送 Esc、不重送，回報未送達並附畫面", () => {
  const pasted = sendRun(["pasted"], SCREENS.pasted[1]);
  assert.equal(pasted.code, 1);
  assert.equal(pasted.lines[0], "[PROJ-103] 未送達：被當成貼上內容收起，還留在輸入框");
  assert.deepEqual(pasted.sends, [`${SCREENS.pasted[1]} --enter`]);
  assert.ok(pasted.out.includes("paste again to expand"));
  const missing = sendRun(["chat"], "沒送過的另一句");
  assert.deepEqual([missing.code, missing.lines[0], missing.sends], [1, "[PROJ-103] 未送達：畫面上沒看到這句話", ["沒送過的另一句 --enter"]]);
  const stale = sendRun(["chat"], "任何話", { FAKE_ORCA_SEND_FAIL: "1" });
  assert.deepEqual([stale.code, stale.out], [1, "[PROJ-103] 未送達：送出失敗：terminal_handle_stale"]);
});

const UNCONFIRMED = "[PROJ-103] 已送出（子 session 執行中，畫面上還沒看到這句，等它停下再確認）";

test("send：upgrade 當時的真實畫面（✢ Moonwalking…、空輸入框、斜線指令沒顯示）→ 執行中回「未確認」，不送 Esc、不重送", () => {
  const screen = screenOf("upgrade");
  assert.ok(screenRunning(screen.tail), "認出畫面上的執行中轉圈行");
  assert.deepEqual(deliveryVerdict(screen, SCREENS.upgrade[1]), { verdict: "failed", reason: "畫面上沒看到這句話" });
  const res = sendRun(["upgrade"], SCREENS.upgrade[1]);
  assert.deepEqual([res.code, res.out, res.sends], [0, UNCONFIRMED, [`${SCREENS.upgrade[1]} --enter`]]);
});

test("send：memory 當時的真實畫面（✽ Frolicking… thinking、Tip 提示行、空輸入框）→ 執行中回「未確認」，不送 Esc、不重送", () => {
  const screen = screenOf("memory");
  assert.ok(screenRunning(screen.tail), "認出畫面上的執行中轉圈行");
  assert.deepEqual(deliveryVerdict(screen, SCREENS.memory[1]), { verdict: "failed", reason: "畫面上沒看到這句話" });
  const res = sendRun(["memory"], SCREENS.memory[1]);
  assert.deepEqual([res.code, res.out, res.sends], [0, UNCONFIRMED, [`${SCREENS.memory[1]} --enter`]]);
  assert.ok(!screenRunning(screenOf("chat").tail) && !screenRunning(screenOf("workflows").tail), "停下的畫面不算執行中");
});

test("send：畫面看不出執行中但 Orca 回報執行中，或查不到子 session 狀態 → 一律當執行中，不送 Esc", () => {
  const text = SCREENS.chat[1];
  const working = fake({ mutatePs: (ps) => Object.assign(agentIn(ps, "proj-103-idle")[0], { state: "working" }) });
  const busy = sendRun(["workflows"], text, {}, working);
  assert.deepEqual([busy.code, busy.out, busy.sends], [0, UNCONFIRMED, [`${text} --enter`]]);
  const gone = fake({ mutateTerminals: (terms) => terms.splice(terms.findIndex((t) => t.handle === "term_e"), 1) });
  const unknown = sendRun(["workflows"], text, {}, gone);
  assert.deepEqual([unknown.code, unknown.out, unknown.sends], [0, UNCONFIRMED, [`${text} --enter`]]);
  const missing = sendRun(["chat"], "沒送過的另一句", {}, fake({ mutatePs: (ps) => Object.assign(agentIn(ps, "proj-103-idle")[0], { state: "blocked" }) }));
  assert.deepEqual([missing.code, missing.out], [0, UNCONFIRMED], "等授權中也不按 Esc");
});

test("紀錄 send：執行中沒看到那句話記成 unconfirmed，與 delivered／queued／failed 分開", () => {
  const dir = fake();
  fs.copyFileSync(screenFile("upgrade"), path.join(dir, "screen-term_e-0.json"));
  const log = fs.mkdtempSync(path.join(tmp, "log-"));
  const env = { SEND_CHECK_MS: "0", SEND_CHECK_TRIES: "1", WORKTREE_CONSOLE_LOG_DIR: log };
  const file = path.join(log, `${new Date().toLocaleDateString("sv")}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ ts: new Date(Date.now() - 1000).toISOString(), event: "stop", repo: "app", ticket: "PROJ-103", handle: "term_e", status: "waiting", question: "要哪個？", suggestion: "A" }) + "\n");
  for (const text of [SCREENS.upgrade[1], "再補一句"]) assert.equal(run("console.mjs", ["send", "--terminal", "term_e", "--tag", "PROJ-103", "--", text], { dir, env }).code, 0);
  const answers = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "answer");
  assert.deepEqual(answers.map((a) => [a.delivery, a.suggestion]), [["unconfirmed", "A"], ["unconfirmed", null]], "未確認也算回過，下一句不再沿用建議");
});

function logRun(script, args, opts = {}) {
  const log = fs.mkdtempSync(path.join(tmp, "log-"));
  const res = run(script, args, { ...opts, env: { ...(opts.env ?? {}), WORKTREE_CONSOLE_LOG_DIR: log } });
  const events = fs
    .readdirSync(log)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => fs.readFileSync(path.join(log, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { ...res, log, events };
}

test("紀錄 watch：進入待你處理時寫停下事件（狀態、問題前 120 字、子 session 自己的建議，沒有就是 null，當時的 git 情境），並在中控台啟動時 commit", () => {
  const dir = fake({
    sequence: [
      () => {},
      (ps) =>
        Object.assign(agentIn(ps, "proj-101-login")[0], {
          state: "done",
          lastAssistantMessage: "登入頁做好了。\n\n建議：先加單元測試\n\n要先補測試還是直接接 API？",
        }),
    ],
  });
  const { code, events, log } = logRun("watch.mjs", [], { dir });
  assert.equal(code, 0);
  const stops = events.filter((e) => e.event === "stop");
  assert.deepEqual(
    stops.map(({ ts, handle, paneKey, sessionId, ...rest }) => rest),
    [{ event: "stop", repo: "app", ticket: "PROJ-101", status: "waiting", question: "要先補測試還是直接接 API？", suggestion: "先加單元測試", scene: "A" }],
  );
  assert.equal(stops[0].handle, "term_a");
  const subjects = spawnSync("git", ["-C", log, "log", "--format=%s"], { encoding: "utf8" }).stdout;
  assert.match(subjects, /中控台啟動/);
  assert.equal(spawnSync("git", ["-C", log, "remote"], { encoding: "utf8" }).stdout.trim(), "");
});

test("紀錄 watch：授權停下記工具名＋參數前 80 字，建議為 null", () => {
  const dir = fake({
    sequence: [() => {}, (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "blocked", toolName: "Bash", toolInput: { command: "x".repeat(200) } })],
  });
  const { events } = logRun("watch.mjs", [], { dir });
  const stop = events.find((e) => e.event === "stop");
  assert.equal(stop.status, "permission");
  assert.equal(stop.suggestion, null);
  assert.ok(stop.question.startsWith("Bash {"), stop.question);
  assert.equal(Array.from(stop.question).length, "Bash ".length + 80);
});

test("紀錄 send：文字回答寫回答事件，帶建議、回答前 120 字、送達結果；未送達也記", () => {
  const text = SCREENS.chat[1];
  const dir = fake();
  fs.copyFileSync(screenFile("chat"), path.join(dir, "screen-term_e-0.json"));
  const log = fs.mkdtempSync(path.join(tmp, "log-"));
  const env = { SEND_CHECK_MS: "0", SEND_CHECK_TRIES: "1", WORKTREE_CONSOLE_LOG_DIR: log };
  fs.writeFileSync(
    path.join(log, `${new Date().toLocaleDateString("sv")}.jsonl`),
    JSON.stringify({ ts: new Date(Date.now() - 1000).toISOString(), event: "stop", repo: "app", ticket: "PROJ-103", handle: "term_e", status: "waiting", question: "要哪個？", suggestion: "A" }) + "\n",
  );
  assert.equal(run("console.mjs", ["send", "--terminal", "term_e", "--tag", "PROJ-103", "--", text], { dir, env }).code, 0);
  assert.equal(run("console.mjs", ["send", "--terminal", "term_e", "--tag", "PROJ-103", "--", "沒送到的話"], { dir, env }).code, 1);
  const lines = fs.readFileSync(path.join(log, `${new Date().toLocaleDateString("sv")}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const answers = lines.filter((e) => e.event === "answer");
  assert.equal(answers.length, 2);
  assert.deepEqual(
    (({ repo, ticket, handle, via, suggestion, delivery }) => ({ repo, ticket, handle, via, suggestion, delivery }))(answers[0]),
    { repo: "app", ticket: "PROJ-103", handle: "term_e", via: "text", suggestion: "A", delivery: "delivered" },
  );
  assert.equal(answers[0].answer, Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 120).join(""));
  assert.equal(answers[1].suggestion, null, "前一題已回答過，建議不再沿用");
  assert.match(answers[1].delivery, /^failed: /);
});

test("紀錄 answer：選單代答記建議、我的選擇與是否選了非建議選項", () => {
  const done = (ps) => Object.assign(agentIn(ps, "proj-103-idle")[0], { state: "working", toolName: null });
  const pick = logRun("console.mjs", ["answer", "--repo", app(), "103", "2；其他：XL"], { dir: withMenuSession(MENU, { sequence: [() => {}, done] }) });
  assert.equal(pick.code, 0, pick.out);
  const a = pick.events.find((e) => e.event === "answer");
  assert.deepEqual(
    (({ ticket, via, suggestion, answer, offSuggestion, delivery }) => ({ ticket, via, suggestion, answer, offSuggestion, delivery }))(a),
    { ticket: "PROJ-103", via: "menu", suggestion: "綠 (Recommended)；—", answer: "顏色→綠 (Recommended)；尺寸→其他「XL」", offSuggestion: false, delivery: "delivered" },
  );
  const off = logRun("console.mjs", ["answer", "--repo", app(), "103", "1"], { dir: withMenuSession([MENU[0]], { sequence: [() => {}, done] }) });
  assert.equal(off.events.find((e) => e.event === "answer").offSuggestion, true);
});

test("紀錄 answer：🔐 等待授權回「允許」按 1、「拒絕」按 Esc，各寫一筆回答事件", () => {
  const leave = (ps) => Object.assign(agentIn(ps, "proj-102-perm")[0], { state: "working", toolName: null });
  for (const [word, key, line] of [
    ["允許", "1", "[PROJ-102(perm)] 已允許"],
    ["拒絕", "\u001b", "[PROJ-102(perm)] 已拒絕"],
  ]) {
    const dir = fake({ sequence: [() => {}, leave] });
    const res = logRun("console.mjs", ["answer", "--repo", app(), "PROJ-102(perm)", word], { dir });
    assert.deepEqual([res.code, res.out], [0, line]);
    const sent = fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter((l) => l.startsWith("terminal send"));
    assert.deepEqual(sent, [`terminal send --terminal term_c --text ${key}`]);
    const ev = res.events.find((e) => e.event === "answer");
    assert.deepEqual([ev.via, ev.answer, ev.delivery], ["permission", word, "delivered"]);
  }
  const bad = logRun("console.mjs", ["answer", "--repo", app(), "PROJ-102(perm)", "改用別的"], { dir: fake() });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /只能回「允許」或「拒絕」/);
});

test("紀錄 close：關票成功與被擋下都寫關閉事件，被擋下帶原因", () => {
  const blocked = logRun("console.mjs", ["close", "--path", wt("proj-101-login")]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /^\[PROJ-101\] 未關閉：工作區有未 commit 的改動/);
  const ev = blocked.events.find((e) => e.event === "close");
  assert.deepEqual([ev.ticket, ev.ok, ev.reason], ["PROJ-101", false, "工作區有未 commit 的改動；session 執行中"]);
  sh(app(), "worktree", "add", "-q", "-b", "proj-105-close", wt("proj-105-close"), "main");
  fs.writeFileSync(path.join(wt("proj-105-close"), "a.js"), "1\n2\n");
  fs.writeFileSync(path.join(wt("proj-105-close"), "b.js"), "1\n");
  sh(wt("proj-105-close"), "add", ".");
  sh(wt("proj-105-close"), "commit", "-qm", "c");
  sh(wt("proj-105-close"), "push", "-q", "-u", "origin", "proj-105-close");
  const ok = logRun("console.mjs", ["close", "--path", wt("proj-105-close")]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /已關閉：worktree 已移除，branch proj-105-close 保留/);
  assert.ok(!fs.existsSync(wt("proj-105-close")));
  const closed = ok.events.find((e) => e.event === "close");
  assert.equal(closed.ok, true);
  assert.deepEqual(
    (({ commits, files, insertions, deletions, pushed }) => ({ commits, files, insertions, deletions, pushed }))(closed.output),
    { commits: 1, files: 2, insertions: 3, deletions: 0, pushed: true },
    "移除 worktree 前記下 git 產出",
  );
  assert.deepEqual(blocked.events.find((e) => e.event === "close").output.pushed, false);
});

test("紀錄 await-start：開工成功與失敗各寫一筆開工事件，失敗帶原因", () => {
  const started = logRun("console.mjs", ["await-start", "--path", wt("proj-101-login"), "--expect", "PROJ-101", "--timeout", "1"]);
  const fail = logRun("console.mjs", ["await-start", "--path", wt("proj-104-noagent"), "--expect", "nothing", "--timeout", "0"]);
  const a = started.events.find((e) => e.event === "start");
  const b = fail.events.find((e) => e.event === "start");
  assert.deepEqual([started.code, a.ok, a.ticket], [0, true, "PROJ-101"]);
  assert.deepEqual([fail.code, b.ok, b.reason], [1, false, "逾時"]);
});

test("紀錄 watch：已回答過的分頁又停在新問題（狀態一直是 💬、中間沒被輪詢到執行中）也寫一筆新的停下事件，同一題不重複寫", () => {
  const ask = (ps) => Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", lastAssistantMessage: "第二題：要用哪個尺寸？" });
  const dir = fake({ mutatePs: ask });
  const log = fs.mkdtempSync(path.join(tmp, "log-"));
  const file = path.join(log, `${new Date().toLocaleDateString("sv")}.jsonl`);
  const t = Date.now();
  fs.writeFileSync(
    file,
    [
      { ts: new Date(t - 60000).toISOString(), event: "stop", repo: "app", ticket: "PROJ-101", handle: "term_a", status: "waiting", question: "第一題：要用哪種顏色？", suggestion: null },
      { ts: new Date(t - 30000).toISOString(), event: "answer", repo: "app", ticket: "PROJ-101", handle: "term_a", via: "text", answer: "紅", delivery: "delivered" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const env = { WORKTREE_CONSOLE_LOG_DIR: log, WATCH_TIMEOUT_MS: "50" };
  const baseline = baselineWith({ [pane("proj-101-login")]: "waiting" });
  run("watch.mjs", ["--baseline", baseline], { dir, env });
  run("watch.mjs", ["--baseline", baseline], { dir, env });
  const stops = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "stop");
  assert.deepEqual(stops.map((s) => s.question), ["第一題：要用哪種顏色？", "第二題：要用哪個尺寸？"]);
});

test("紀錄 watch：自動交棒完成寫交棒事件，帶新舊分頁代號與新舊 session 編號", () => {
  const home = fs.mkdtempSync(path.join(tmp, "handoff-"));
  const log = fs.mkdtempSync(path.join(tmp, "log-"));
  fs.writeFileSync(
    path.join(log, `${new Date().toLocaleDateString("sv")}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), event: "session", role: "child", handle: "term_new", sessionId: "sess-new", path: wt("proj-101-login") }) + "\n",
  );
  handoffEvent(home, { status: "done", newHandle: "term_new", newPaneKey: "tab_new:leaf_new" });
  const swapped = {
    mutateTerminals: (terms) => {
      newTerminal(terms);
      terms.splice(terms.findIndex((t) => t.handle === "term_a"), 1);
    },
    mutatePs: (ps) => {
      newSession(ps);
      agentIn(ps, "proj-101-login").shift();
    },
  };
  run("watch.mjs", ["--baseline", baselineWith()], { dir: fake(swapped), env: { AUTO_HANDOFF_HOME: home, WATCH_TIMEOUT_MS: "300", WORKTREE_CONSOLE_LOG_DIR: log } });
  const ev = fs
    .readFileSync(path.join(log, `${new Date().toLocaleDateString("sv")}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .find((e) => e.event === "handoff");
  assert.deepEqual(
    (({ ticket, kind, ok, oldHandle, newHandle, oldSessionId, newSessionId }) => ({ ticket, kind, ok, oldHandle, newHandle, oldSessionId, newSessionId }))(ev),
    { ticket: "PROJ-101", kind: "auto", ok: true, oldHandle: "term_a", newHandle: "term_new", oldSessionId: "sess-101", newSessionId: "sess-new" },
  );
});

test("中控台交棒：依舊分頁是中控台記成「中控台」，開在有票號的 worktree 也一樣；自動與手動各印對應那行", () => {
  const swapped = {
    mutateTerminals: (terms) => {
      newTerminal(terms);
      terms.splice(terms.findIndex((t) => t.handle === "term_a"), 1);
    },
    mutatePs: (ps) => {
      newSession(ps);
      agentIn(ps, "proj-101-login").shift();
    },
  };
  for (const [percent, line, kind] of [
    [41, "[中控台] 已自動交棒（context 41%）", "auto"],
    [null, "[中控台] 已交棒（手動）", "manual"],
  ]) {
    const home = fs.mkdtempSync(path.join(tmp, "handoff-"));
    const log = fs.mkdtempSync(path.join(tmp, "log-"));
    handoffEvent(home, { status: "done", isConsole: true, percent, newHandle: "term_new", newPaneKey: "tab_new:leaf_new" });
    const out = run("watch.mjs", ["--baseline", baselineWith()], { dir: fake(swapped), env: { AUTO_HANDOFF_HOME: home, WATCH_TIMEOUT_MS: "300", WORKTREE_CONSOLE_LOG_DIR: log } });
    assert.deepEqual(out.lines.filter((l) => !l.startsWith("baseline:")), [line]);
    const ev = fs
      .readFileSync(path.join(log, `${new Date().toLocaleDateString("sv")}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "handoff");
    assert.deepEqual([ev.ticket, ev.kind, ev.oldHandle, ev.newHandle], ["中控台", kind, "term_a", "term_new"]);
  }
});

test("SKILL.md：詳情建議只在〈看板與詳情〉；〈指揮〉的「照建議」展開成完整指令送出、不送原文", () => {
  const skill = fs.readFileSync(path.join(root, "skills", "worktree-console", "SKILL.md"), "utf8");
  const section = (heading) => skill.split(/\n## /).find((s) => s.startsWith(heading)) ?? "";
  const board = section("看板與詳情");
  assert.match(board, /詳情建議：/);
  assert.match(board, /只有「詳情」這個入口准中控台補建議/);
  assert.match(board, /不讀實作 code/);
  const command = section("指揮");
  assert.match(command, /照建議/);
  assert.match(command, /不把「照建議」原文送進子 session/);
  assert.match(command, /console\.mjs send/);
  assert.match(command, /after-send/);
  assert.match(section("主動回報"), /中控台不自己補建議/);
});

// A console home of its own: this tab registered as the console, with or without the focus band polling.
function consoleHome({ mods = false } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  fs.writeFileSync(path.join(home, "consoles.json"), JSON.stringify(["term_self"]));
  if (mods) fs.writeFileSync(path.join(home, "focus.json"), JSON.stringify({ ...emptyFocus(), modsAt: Date.now() }));
  return home;
}
const readJson = (home, file) => JSON.parse(fs.readFileSync(path.join(home, file), "utf8"));
const at = (ms) => (a) => Object.assign(a, { stateStartedAt: ms });

test("封存：封存後不上看板表格、待回覆清單、專注橫條；取消封存後恢復；封存期間詳情與指揮照常", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  const dir = fake();
  const tag = "PROJ-102(question)";
  assert.deepEqual(run("console.mjs", ["archive", "--repo", app(), tag], { dir, env }).lines, [`[${tag}] 已封存`]);
  const board = run("console.mjs", ["board", "--repo", app()], { dir, env }).out;
  assert.ok(!table(board).by[tag], board);
  assert.ok(!replyList(board).by[tag], board);
  assert.ok(board.split("\n").includes("封存 1 個、閒置 1 個"), board);
  const focus = JSON.parse(run("console.mjs", ["focus"], { dir, env }).out);
  assert.deepEqual(focus.sessions.filter((s) => s.pending).map((s) => s.tag), ["PROJ-102(perm)", "release…#1", "release…#2"], "四題扣掉封存的一題");
  assert.equal(focus.queue.length + 1, 3);
  assert.equal(focus.sessions.find((s) => s.tag === tag).archived, true);
  assert.equal(focus.stats, "等待回應 0 | 等待授權 1 | 回覆完畢 2 | 執行中 2 | 封存 1 | 閒置 1");
  assert.equal(run("console.mjs", ["detail", "--repo", app(), tag], { dir, env }).lines[0], `[${tag}] 詳情`);
  const hit = JSON.parse(run("console.mjs", ["resolve", "--repo", app(), tag], { dir, env }).out);
  assert.deepEqual([hit.match, hit.rows[0].handle], ["one", "term_b"]);
  assert.deepEqual(run("console.mjs", ["unarchive", "--repo", app(), tag], { dir, env }).lines, [`[${tag}] 已取消封存`]);
  const back = run("console.mjs", ["board", "--repo", app()], { dir, env }).out;
  assert.ok(table(back).by[tag] && replyList(back).by[tag], back);
  assert.ok(back.split("\n").includes("閒置 1 個"), back);
  assert.deepEqual(run("console.mjs", ["unarchive", "--repo", app(), tag], { dir, env }).lines, [`[${tag}] 沒有封存`]);
});

test("已移除的 idle／next／split／pending 回未知指令並 exit 1；report、unarchive 與 focus-later 保留", () => {
  const dir = fake();
  for (const cmd of ["idle", "next", "split", "pending"]) {
    const res = run("console.mjs", [cmd, "--repo", app()], { dir });
    assert.equal(res.code, 1, cmd);
    assert.equal(res.lines[0], `未知指令：${cmd}`);
    assert.ok(res.lines[1].includes("report") && res.lines[1].includes("unarchive") && res.lines[1].includes("focus-later") && !res.lines[1].includes("|idle|"), res.out);
  }
});

test("封存：面板的取消封存按鈕不帶 --repo 跑 unarchive，照樣從封存紀錄移除並回到專注資料", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  const dir = fake();
  const tag = "PROJ-102(question)";
  run("console.mjs", ["archive", "--repo", app(), tag], { dir, env });
  const res = run("console.mjs", ["unarchive", tag], { dir, env });
  assert.deepEqual([res.code, res.lines], [0, [`[${tag}] 已取消封存`]]);
  const focus = JSON.parse(run("console.mjs", ["focus"], { dir, env }).out);
  const card = focus.sessions.find((s) => s.tag === tag);
  assert.deepEqual([card.archived, card.pending], [false, true]);
});

test("封存：紀錄存在中控台設定檔，重開仍生效；worktree 被 close 後紀錄自動清掉", () => {
  const home = consoleHome();
  const env = { WORKTREE_CONSOLE_HOME: home };
  const dir = fake();
  run("console.mjs", ["archive", "--repo", app(), "release…#1"], { dir, env });
  const saved = readJson(home, "archive.json");
  assert.deepEqual(saved.map((a) => [a.path, a.tag]), [[wt("release-2026-10"), "release…#1"]]);
  assert.ok(typeof saved[0].at === "number" && saved[0].paneKey);
  for (let i = 0; i < 2; i++) assert.ok(!table(run("console.mjs", ["board", "--repo", app()], { dir, env }).out).by["release…#1"], "每次重開都讀同一份紀錄");
  const gone = wt("proj-105-archive");
  sh(app(), "worktree", "add", "-q", "-b", "proj-105-archive", gone, "main");
  fs.writeFileSync(path.join(home, "archive.json"), JSON.stringify([...saved, { ...saved[0], path: gone, tag: "PROJ-105", paneKey: "p:q" }]));
  const closed = run("console.mjs", ["close", "--path", gone], { dir, env });
  assert.equal(closed.code, 0, closed.out);
  assert.deepEqual(readJson(home, "archive.json").map((a) => a.path), [wt("release-2026-10")]);
});

test("封存：轉成 💬 或 🔐 時自動解除並進入待回覆清單與專注橫條；轉成 ⏸ 時仍保持封存", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  for (const tag of ["release…#1", "release…#2", "PROJ-103"]) run("console.mjs", ["archive", "--repo", app(), tag], { dir: fake(), env });
  assert.equal(readJson(home, "archive.json").length, 3);
  const dir = fake({
    mutatePs: (ps) => {
      const [r1, r2] = agentIn(ps, "release-2026-10");
      Object.assign(r1, { lastAssistantMessage: "要先跑測試嗎？", stateStartedAt: 1790787900000 });
      Object.assign(r2, { lastAssistantMessage: "又做完一輪了。", stateStartedAt: 1790787900000 });
      Object.assign(agentIn(ps, "proj-103-idle")[0], { state: "waiting", toolName: "Bash", toolInput: "rm -rf build", stateStartedAt: 1790787900000 });
    },
  });
  const board = run("console.mjs", ["board", "--repo", app()], { dir, env }).out;
  assert.deepEqual(readJson(home, "archive.json").map((a) => a.tag), ["release…#2"]);
  const list = replyList(board).by;
  assert.ok(list["release…#1"] && list["PROJ-103"], board);
  assert.ok(!list["release…#2"], "⏸ 不解除封存");
  const focus = JSON.parse(run("console.mjs", ["focus"], { dir, env }).out);
  assert.match(focus.stats, /^等待回應 2 \| 等待授權 2 \| 回覆完畢 0 \| 執行中 \d+ \| 封存 1 \| 閒置 0$/);
});

test("新開中控台時看板之後列一次封存清單表格：代號｜摘要｜封存時間；沒有封存就不列", () => {
  const home = consoleHome();
  const env = { WORKTREE_CONSOLE_HOME: home };
  assert.equal(run("console.mjs", ["archived", "--repo", app()], { env }).out, "");
  run("console.mjs", ["archive", "--repo", app(), "PROJ-101"], { env });
  const lines = run("console.mjs", ["archived", "--repo", app()], { env }).lines;
  assert.deepEqual(lines.slice(0, 4), ["### 封存", "", "| 代號 | 摘要 | 封存時間 |", "| --- | --- | --- |"]);
  const row = lines[4].slice(2, -2).split(" | ");
  assert.deepEqual(row.slice(0, 2), ["PROJ-101", "登入頁改版"]);
  assert.match(row[2], /^\d\d-\d\d \d\d:\d\d$/);
  assert.equal(lines.length, 5);
});

test("選項摘要：文字題取到第一個「，：。—（」或只取行首粗體段，每個選項 ≤8 個中文字、超過以「…」結尾；選項一律以 a、b、c 標示", () => {
  const text = "預設要選哪一種？\n\n1. **專注模式當預設**，watcher 只端一題\n2. 預設維持現在的全批次回報，另加開關\n3. 完全取代：拿掉舊的回報\n";
  assert.equal(pendingItems([listRow("PROJ-1", session(asking(text)))])[0].entries[0].options, "a 專注模式當預設／b 預設維持現在的全…／c 完全取代");
  const letters = "- **A. 只做封存**：不做自動\n- **B**（建議）—連自動封存一起做\n- **C**（我的建議）\n\n選哪個？";
  assert.equal(pendingItems([listRow("PROJ-2", session(asking(letters)))])[0].entries[0].options, "a 只做封存／b／c");
  const mixed = "做了：\n1. 改好 X\n2. 測試過了\n\n- A：照做\n- B：不做\n\n建議選 A。\n\n要做嗎？";
  assert.equal(pendingItems([listRow("PROJ-3", session(asking(mixed)))])[0].entries[0].options, "a 照做／b 不做", "只取最後一組選項");
  const menu = { kind: "waiting", menu: MENU };
  const by = replyList(pendingBlock([listRow("PROJ-4", session(menu, { agent: { state: "waiting", toolName: "AskUserQuestion" } }))]).join("\n")).by;
  assert.equal(by["PROJ-4①"][3], "a 紅／b 綠／c 藍／其他");
});

const entry = (key, kind, since, extra = {}) => ({ key, paneKey: key, handle: `h-${key}`, tag: key, kind, since, ...extra });

test("專注佇列：先停先出、🔐 插最前；目前這題不被後來的 🔐 搶走", () => {
  const a = entry("a", "waiting", 1);
  const b = entry("b", "done", 2);
  const c = entry("c", "permission", 3);
  const first = focusStep(emptyFocus(), [a, b, c], 100);
  assert.deepEqual([first.current.key, first.queue.map((e) => e.key)], ["c", ["a", "b"]]);
  const noPerm = focusStep(emptyFocus(), [b, a], 100);
  assert.deepEqual([noPerm.current.key, noPerm.queue.map((e) => e.key)], ["a", ["b"]]);
  const d = entry("d", "permission", 4);
  const sticky = focusStep(noPerm.state, [a, b, d], 200);
  assert.deepEqual([sticky.current.key, sticky.queue.map((e) => e.key)], ["a", ["d", "b"]]);
});

test("專注佇列：回完一題先等同一個 session 最多 60 秒；期間它再停下就端它的新題目，其他 session 的 🔐 不插隊；超過 60 秒才換下一題", () => {
  const a = entry("a@1", "waiting", 1, { paneKey: "a", tag: "a" });
  const b = entry("b@2", "done", 2, { paneKey: "b" });
  const t0 = 1_000;
  let view = focusStep(emptyFocus(), [a, b], t0);
  assert.equal(view.current.key, "a@1");
  let state = focusReplied(view.state, [a, b], [{ paneKey: "a", tag: "a" }], t0);
  view = focusStep(state, [a, b], t0 + 1_000);
  assert.deepEqual([view.current, view.wait.tag], [null, "a"], "剛回的那則還掛著也不再端出");
  const perm = entry("p@3", "permission", 3, { paneKey: "p" });
  view = focusStep(view.state, [b, perm], t0 + 20_000);
  assert.equal(view.current, null, "等待中其他 session 的 🔐 不插隊");
  const again = entry("a@9", "waiting", 9, { paneKey: "a" });
  const back = focusStep(view.state, [b, perm, again], t0 + FOCUS_WAIT_MS - 1);
  assert.deepEqual([back.current.key, back.wait], ["a@9", null]);
  const late = focusStep(view.state, [b, perm], t0 + FOCUS_WAIT_MS);
  assert.deepEqual([late.current.key, late.wait], ["p@3", null], "超過 60 秒換排隊中的下一題，🔐 在最前");
  const afterLate = focusStep(late.state, [b, perm, again], t0 + FOCUS_WAIT_MS + 1);
  assert.equal(afterLate.current.key, "p@3", "超時後它再停下就照排隊");
});

test("專注佇列：「延後處理」立刻放棄等待，把目前這題移到隊尾", () => {
  const a = entry("a", "waiting", 1);
  const b = entry("b", "waiting", 2);
  const c = entry("c", "permission", 3);
  let view = focusStep(emptyFocus(), [a, b, c], 10);
  assert.equal(view.current.key, "c");
  view = focusStep(focusSkip(view.state, 20), [a, b, c], 20);
  assert.deepEqual([view.current.key, view.queue.map((e) => e.key)], ["a", ["b", "c"]]);
  const waiting = focusReplied(view.state, [a, b, c], [{ paneKey: "a", tag: "a" }], 30);
  const skipped = focusStep(focusSkip(waiting, 40), [b, c], 40);
  assert.deepEqual([skipped.current.key, skipped.wait], ["b", null]);
});

test("專注佇列：四層順序——回覆後又回來的 → 🔐 → 其他 → 被跳過的；前三層照停下時間，被跳過那層最近跳過的在最後", () => {
  const a = entry("a@1", "waiting", 1, { paneKey: "a" });
  const b = entry("b@2", "waiting", 2, { paneKey: "b" });
  const c = entry("c@3", "waiting", 3, { paneKey: "c" });
  const d = entry("d@4", "done", 4, { paneKey: "d" });
  const p = entry("p@5", "permission", 5, { paneKey: "p" });
  const s = entry("s@6", "waiting", 6, { paneKey: "s" });
  let view = focusStep(emptyFocus(), [a, b, c, d, p, s], 10);
  assert.equal(view.current.key, "p@5");
  view = focusStep(focusSkip(view.state, 20), [a, b, c, d, p, s], 20);
  assert.equal(view.current.key, "a@1");
  view = focusStep(focusPick(view.state, "s@6", 30), [a, b, c, d, p, s], 30);
  assert.deepEqual([view.current.key, view.queue.map((e) => e.key)], ["s@6", ["b@2", "c@3", "d@4", "p@5", "a@1"]]);
  let state = focusReplied(view.state, [a, b, c, d, p, s], [{ paneKey: "s" }], 40);
  state = focusReplied(state, [a, b, c, d, p], [{ paneKey: "c" }], 41);
  view = focusStep(state, [a, b, d, p], 45 + FOCUS_WAIT_MS);
  assert.equal(view.current.key, "b@2");
  const c2 = entry("c@90", "waiting", 90, { paneKey: "c" });
  const s2 = entry("s@80", "done", 80, { paneKey: "s" });
  const q = entry("q@70", "permission", 70, { paneKey: "q" });
  const e = entry("e@60", "waiting", 60, { paneKey: "e" });
  view = focusStep(view.state, [a, b, d, p, c2, s2, q, e], 50 + FOCUS_WAIT_MS);
  assert.deepEqual([view.current.key, view.queue.map((x) => x.key)], ["b@2", ["s@80", "c@90", "q@70", "d@4", "e@60", "p@5", "a@1"]]);
});

test("專注佇列：回覆 A 後 A 超過 60 秒才再停下，畫面上的 B 不被換掉，A 排在排隊第 1 位", () => {
  const a = entry("a@1", "waiting", 1, { paneKey: "a", tag: "a" });
  const b = entry("b@2", "permission", 2, { paneKey: "b" });
  const c = entry("c@3", "permission", 3, { paneKey: "c" });
  const t0 = 1_000;
  let view = focusStep(focusPick(emptyFocus(), "a@1", t0), [a, b, c], t0);
  view = focusStep(focusReplied(view.state, [a, b, c], [{ paneKey: "a", tag: "a" }], t0), [a, b, c], t0);
  view = focusStep(view.state, [b, c], t0 + FOCUS_WAIT_MS + 1);
  assert.deepEqual([view.current.key, view.wait], ["b@2", null]);
  const again = entry("a@9", "waiting", 9, { paneKey: "a" });
  view = focusStep(view.state, [b, c, again], t0 + FOCUS_WAIT_MS + 30_000);
  assert.deepEqual([view.current.key, view.queue.map((e) => e.key)], ["b@2", ["a@9", "c@3"]], "B 仍在畫面上，A 排第 1 位（🔐 之前）");
});

test("專注佇列：回覆 A 後 A 在 60 秒內再停下，直接上畫面", () => {
  const a = entry("a@1", "waiting", 1, { paneKey: "a", tag: "a" });
  const b = entry("b@2", "permission", 2, { paneKey: "b" });
  let view = focusStep(focusPick(emptyFocus(), "a@1", 10), [a, b], 10);
  view = focusStep(focusReplied(view.state, [a, b], [{ paneKey: "a", tag: "a" }], 10), [a, b], 10);
  const again = entry("a@9", "waiting", 9, { paneKey: "a" });
  view = focusStep(view.state, [b, again], 10 + FOCUS_WAIT_MS - 1);
  assert.deepEqual([view.current.key, view.wait, view.queue.map((e) => e.key)], ["a@9", null, ["b@2"]]);
});

test("專注佇列：上一題被延後、或自己停下沒被回覆的 session 再停下，不進第一層，照一般規則排", () => {
  const a = entry("a@1", "waiting", 1, { paneKey: "a" });
  const b = entry("b@2", "waiting", 2, { paneKey: "b" });
  const c = entry("c@3", "waiting", 3, { paneKey: "c" });
  let view = focusStep(emptyFocus(), [a, b, c], 10);
  assert.equal(view.current.key, "a@1");
  view = focusStep(focusSkip(view.state, 20), [a, b, c], 20);
  assert.equal(view.current.key, "b@2");
  const a2 = entry("a@50", "waiting", 50, { paneKey: "a" });
  const c2 = entry("c@40", "done", 40, { paneKey: "c" });
  view = focusStep(view.state, [b, a2, c2], 60);
  assert.deepEqual([view.current.key, view.queue.map((e) => e.key)], ["b@2", ["c@40", "a@50"]], "依停下時間排，不插到最前");
  assert.deepEqual(view.state.back, {});
  const replied = focusStep(focusReplied(view.state, [b, a2, c2], [{ paneKey: "b" }], 70), [a2, c2], 70 + FOCUS_WAIT_MS);
  const b2 = entry("b@99", "waiting", 99, { paneKey: "b" });
  const later = focusStep(replied.state, [a2, c2, b2], 80 + FOCUS_WAIT_MS);
  assert.deepEqual([later.current.key, later.queue.map((e) => e.key)], ["c@40", ["b@99", "a@50"]], "被回覆過的 b 回來才插到最前");
});

test("專注佇列：一般題在畫面上沒回就切走（數字或面板），排到最後，跟按 8 一樣", () => {
  const a = entry("a", "waiting", 1);
  const b = entry("b", "waiting", 2);
  const c = entry("c", "permission", 3);
  let view = focusStep(emptyFocus(), [a, b, c], 10);
  assert.equal(view.current.key, "c");
  const picked = focusStep(focusPick(view.state, "b", 20), [a, b, c], 20);
  const later = focusStep(focusSkip(view.state, 20), [a, b, c], 20);
  assert.deepEqual([picked.current.key, picked.queue.map((e) => e.key)], ["b", ["a", "c"]]);
  assert.deepEqual(later.queue.map((e) => e.key).at(-1), "c");
  view = focusStep(focusPick(picked.state, "a", 30), [a, b, c], 30);
  assert.deepEqual([view.current.key, view.queue.map((e) => e.key)], ["a", ["c", "b"]], "被跳過那層最近跳過的在最後");
  const same = focusStep(focusPick(view.state, "a", 40), [a, b, c], 40);
  assert.deepEqual(same.queue.map((e) => e.key), ["c", "b"], "點目前這題不算跳過");
});

test("專注佇列：第一層的題目被切走仍留第一層（照停下時間排在其他第一層之間）；被按 8 才掉到最後", () => {
  const a = entry("a@1", "waiting", 1, { paneKey: "a" });
  const b = entry("b@2", "waiting", 2, { paneKey: "b" });
  const x = entry("x@3", "permission", 3, { paneKey: "x" });
  let view = focusStep(emptyFocus(), [a, b, x], 10);
  let state = focusReplied(view.state, [a, b, x], [{ paneKey: "a" }], 10);
  state = focusReplied(state, [b, x], [{ paneKey: "b" }], 11);
  view = focusStep(state, [x], 20 + FOCUS_WAIT_MS);
  assert.equal(view.current.key, "x@3");
  const a2 = entry("a@40", "waiting", 40, { paneKey: "a" });
  const b2 = entry("b@50", "waiting", 50, { paneKey: "b" });
  const y = entry("y@30", "waiting", 30, { paneKey: "y" });
  view = focusStep(view.state, [x, y, a2, b2], 30 + FOCUS_WAIT_MS);
  assert.deepEqual([view.current.key, view.queue.map((e) => e.key)], ["x@3", ["a@40", "b@50", "y@30"]]);
  view = focusStep(focusPick(view.state, "a@40", 40 + FOCUS_WAIT_MS), [x, y, a2, b2], 40 + FOCUS_WAIT_MS);
  view = focusStep(focusPick(view.state, "y@30", 50 + FOCUS_WAIT_MS), [x, y, a2, b2], 50 + FOCUS_WAIT_MS);
  assert.deepEqual([view.current.key, view.queue.map((e) => e.key)], ["y@30", ["a@40", "b@50", "x@3"]], "a 被切走仍在第一層、b 之前");
  view = focusStep(focusPick(view.state, "b@50", 60 + FOCUS_WAIT_MS), [x, y, a2, b2], 60 + FOCUS_WAIT_MS);
  view = focusStep(focusPick(view.state, "a@40", 70 + FOCUS_WAIT_MS), [x, y, a2, b2], 70 + FOCUS_WAIT_MS);
  assert.deepEqual(view.queue.map((e) => e.key), ["b@50", "x@3", "y@30"], "b 被切走仍排第 1 位");
  view = focusStep(focusSkip(view.state, 80 + FOCUS_WAIT_MS), [x, y, a2, b2], 80 + FOCUS_WAIT_MS);
  assert.deepEqual([view.current.key, view.queue.map((e) => e.key)], ["b@50", ["x@3", "y@30", "a@40"]], "按 8 延後的第一層題目掉到最後");
});

test("專注佇列時間線：回覆送出後子 session 搶先停下，新題直接上橫條且只算回覆當下那題；打字回覆（含 after-send）與按鈕回覆都一樣", () => {
  const t0 = 1_791_168_832_980;
  const old = entry("a@1791168000000", "waiting", 1_791_168_000_000, { paneKey: "a", handle: "h-a", tag: "a" });
  const b = entry("b@1791167000000", "permission", 1_791_167_000_000, { paneKey: "b" });
  const start = focusStep(focusPick(emptyFocus(), old.key, t0 - 5_000), [old, b], t0 - 5_000).state;
  const next = entry(`a@${t0 + 1_584}`, "done", t0 + 1_584, { paneKey: "a", handle: "h-a", tag: "a" });
  const reply = { paneKey: "a", handle: "h-a", tag: "a", at: t0 };
  for (const afterSend of [true, false]) {
    let state = focusReplied(start, [next, b], [reply], t0 + 2_000);
    let view = focusStep(state, [next, b], t0 + 2_000);
    if (afterSend) view = focusStep(focusReplied(view.state, [next, b], [{ paneKey: "a", handle: "h-a", tag: "a" }], t0 + 3_000), [next, b], t0 + 3_000);
    view = focusStep(view.state, [next, b], t0 + 5_000);
    assert.deepEqual([view.current?.key, view.state.answered, view.queue.map((e) => e.key)], [next.key, [], ["b@1791167000000"]], afterSend ? "打字回覆" : "按鈕回覆");
    assert.deepEqual(view.state.replied, [], "已回來的 session 不再記成等它回來");
    state = focusReplied(focusStep(start, [old, b], t0).state, [old, b], [reply], t0 + 1_000);
    assert.deepEqual(state.answered, [old.key], "子 session 還沒停下時只記回覆當下那題");
    view = focusStep(state, [next, b], t0 + 4_000);
    if (afterSend) view = focusStep(focusReplied(view.state, [next, b], [{ paneKey: "a", handle: "h-a", tag: "a" }], t0 + 4_500), [next, b], t0 + 4_500);
    assert.deepEqual([view.current?.key, view.state.answered], [next.key, []]);
  }
});

test("專注佇列時間線：回覆後超過 60 秒才回來，橫條換成排隊第一題且不再變，回來的 session 排在排隊第 1 位", () => {
  const t0 = 1_791_168_832_980;
  const old = entry("a@1791168000000", "waiting", 1_791_168_000_000, { paneKey: "a", handle: "h-a", tag: "a" });
  const b = entry("b@1791167000000", "waiting", 1_791_167_000_000, { paneKey: "b" });
  const c = entry("c@1791166000000", "permission", 1_791_166_000_000, { paneKey: "c" });
  let view = focusStep(focusPick(emptyFocus(), old.key, t0 - 5_000), [old, b, c], t0 - 5_000);
  view = focusStep(focusReplied(view.state, [old, b, c], [{ paneKey: "a", handle: "h-a", tag: "a", at: t0 }], t0 + 1_000), [old, b, c], t0 + 1_000);
  view = focusStep(focusReplied(view.state, [b, c], [{ paneKey: "a", handle: "h-a", tag: "a" }], t0 + 2_000), [b, c], t0 + 2_000);
  assert.deepEqual([view.current, view.wait?.tag], [null, "a"]);
  view = focusStep(view.state, [b, c], t0 + 2_000 + FOCUS_WAIT_MS);
  assert.deepEqual([view.current.key, view.wait], ["c@1791166000000", null]);
  const next = entry(`a@${t0 + 90_000}`, "done", t0 + 90_000, { paneKey: "a", handle: "h-a", tag: "a" });
  view = focusStep(view.state, [b, c, next], t0 + 95_000);
  assert.deepEqual([view.current.key, view.queue.map((e) => e.key)], ["c@1791166000000", [next.key, "b@1791167000000"]]);
});

const stagger = (ps) => {
  at(1790787800001)(agentIn(ps, "chris-proj-102-question")[0]);
  at(1790787800002)(agentIn(ps, "proj-102-perm")[0]);
  const [r1, r2] = agentIn(ps, "release-2026-10");
  at(1790787800003)(r1);
  at(1790787800004)(r2);
};

// The focus band's JSON for one poll, and the tag of a key in it; like the mod, an announced question is reported as printed unless `printed` is false.
function focusRun(dir, env, args = ["focus"], { printed = true } = {}) {
  const res = run("console.mjs", args, { dir, env });
  const payload = JSON.parse(res.out);
  if (printed && payload.announceKey) run("console.mjs", ["focus-shown", payload.announceKey], { dir, env });
  const tagOf = (key) => payload.sessions.find((s) => s.key === key)?.tag ?? null;
  return { ...payload, currentTag: tagOf(payload.current), queueTags: payload.queue.map((q) => tagOf(q.key)), tagOf };
}

test("有 mods 時 watcher 不為題目叫醒中控台：題目停下只寫紀錄；重掛帶相同 baseline 也不輸出重複回報；沒有 mods 照舊整批回報", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home, WATCH_TIMEOUT_MS: "300" };
  const dir = fake({ mutatePs: stagger });
  const out = run("watch.mjs", ["--baseline", allPanes("busy")], { dir, env });
  assert.equal(out.lines[0], "[watch] timeout", out.out);
  assert.ok(!out.out.includes("###"), out.out);
  for (let i = 0; i < 2; i++) {
    const again = run("watch.mjs", ["--baseline", allPanes("busy")], { dir, env });
    assert.deepEqual([again.lines[0], again.out.includes("###")], ["[watch] timeout", false], "模擬重掛 watcher 帶相同 baseline");
  }
  const plain = run("watch.mjs", ["--baseline", allPanes("busy")], { dir, env: { WATCH_TIMEOUT_MS: "300" } });
  assert.ok(plain.out.includes(BOARD_HEADER) && plain.out.includes("### 📋"), "沒有 mods 時照舊整批回報");
  assert.ok(plain.out.includes("### 🔐 PROJ-102(perm) 等你授權"));
});

test("專注：同一題（session＋停下時間）只 announce 一次，輪詢、重啟都不重送；該 session 有新題才再 announce", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  const dir = fake({ mutatePs: stagger });
  const first = focusRun(dir, env);
  assert.deepEqual([first.currentTag, first.announce], ["PROJ-102(perm)", "PROJ-102(perm)"]);
  for (let i = 0; i < 2; i++) assert.equal(focusRun(dir, env).announce, null, "同一題不重送");
  const restarted = { ...readJson(home, "focus.json"), modsAt: 0 };
  fs.writeFileSync(path.join(home, "focus.json"), JSON.stringify(restarted));
  assert.equal(focusRun(dir, env).announce, null, "中控台重啟後同一題也不重送");
  const asksAgain = fake({ mutatePs: (ps) => { stagger(ps); Object.assign(agentIn(ps, "proj-102-perm")[0], { state: "waiting", toolName: "Bash", toolInput: "ls", stateStartedAt: 1790787900000 }); } });
  const fresh = focusRun(asksAgain, env);
  assert.deepEqual([fresh.currentTag, fresh.announce], ["PROJ-102(perm)", "PROJ-102(perm)"], "同 session 停在新的一題：再 announce");
});

test("專注：mod 回報印出（focus-shown）前，同一題每次輪詢都 announce；回報後才算印過", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  const dir = fake({ mutatePs: stagger });
  const first = focusRun(dir, env, ["focus"], { printed: false });
  assert.deepEqual([first.announce, first.tagOf(first.announceKey)], ["PROJ-102(perm)", "PROJ-102(perm)"]);
  assert.deepEqual(readJson(home, "focus.json").reported, [], "只決定要印，還不算印過");
  assert.equal(focusRun(dir, env, ["focus"], { printed: false }).announceKey, first.announceKey, "沒回報印出就再送一次");
  assert.equal(run("console.mjs", ["focus-shown", first.announceKey], { dir, env }).code, 0);
  assert.deepEqual([focusRun(dir, env).announce, focusRun(dir, env).announceKey], [null, null]);
});

test("專注：同一個分頁裡沒載入過中控台 skill 的 session（daemon 的備用 session）拿不到橫條；中控台 session 查過一次就記住", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  const dir = fake({ mutatePs: stagger });
  const spare = claudeSession("spare-session", { skill: false });
  const before = fs.readFileSync(path.join(home, "focus.json"), "utf8");
  assert.deepEqual(JSON.parse(run("console.mjs", ["focus", "--session", spare], { dir, env }).out), { active: false });
  assert.deepEqual(JSON.parse(run("console.mjs", ["focus"], { dir, env: { ...env, CLAUDE_CODE_SESSION_ID: spare } }).out), { active: false }, "沒帶 --session 時看環境變數");
  assert.equal(fs.readFileSync(path.join(home, "focus.json"), "utf8"), before, "備用 session 不動專注狀態，題目留給中控台");
  const real = claudeSession("console-session");
  const view = focusRun(dir, env, ["focus", "--session", real], { printed: false });
  assert.deepEqual([view.currentTag, view.announce], ["PROJ-102(perm)", "PROJ-102(perm)"]);
  assert.deepEqual(readJson(home, "focus.json").consoleSessions, [real]);
  fs.rmSync(path.join(tmp, "claude-projects", "-sessions", `${real}.jsonl`));
  assert.equal(focusRun(dir, env, ["focus", "--session", real]).active, true, "記住後不再讀對話紀錄");
});

test("專注：切題把排隊題放上橫條、沒回的原題排到最後；延後把目前這題移到排隊最後、換排隊第一題；兩者都 announce", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  const dir = fake({ mutatePs: stagger });
  const start = focusRun(dir, env);
  assert.deepEqual([start.currentTag, start.queueTags], ["PROJ-102(perm)", ["PROJ-102(question)", "release…#1", "release…#2"]]);
  const picked = focusRun(dir, env, ["focus-pick", start.queue[2].key]);
  assert.deepEqual([picked.currentTag, picked.queueTags, picked.announce], ["release…#2", ["PROJ-102(question)", "release…#1", "PROJ-102(perm)"], "release…#2"]);
  const back = focusRun(dir, env, ["focus-pick", picked.queue[2].key]);
  assert.deepEqual([back.currentTag, back.queueTags, back.announce], ["PROJ-102(perm)", ["PROJ-102(question)", "release…#1", "release…#2"], "PROJ-102(perm)"], "切回已印過的題目照樣 announce");
  const later = focusRun(dir, env, ["focus-later"]);
  assert.deepEqual([later.currentTag, later.queueTags, later.announce], ["PROJ-102(question)", ["release…#1", "release…#2", "PROJ-102(perm)"], "PROJ-102(question)"]);
  const again = focusRun(dir, env, ["focus-later"]);
  assert.deepEqual([again.currentTag, again.queueTags], ["release…#1", ["release…#2", "PROJ-102(perm)", "PROJ-102(question)"]], "延後過的依延後先後排最後");
  const unit = focusStep(focusPick(emptyFocus(), "b"), [entry("a", "waiting", 1), entry("b", "waiting", 2), entry("c", "permission", 3)], 10);
  assert.deepEqual([unit.current.key, unit.queue.map((e) => e.key)], ["b", ["c", "a"]], "🔐 固定最前");
});

test("專注：其他 session 有新題時橫條題目不動、排隊多一題標 isNew、統計加 1；回完等同一 session 60 秒，它再問就直接上橫條並 announce", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  const quiet = (ps) => { stagger(ps); releaseBusy(ps); };
  const before = focusRun(fake({ mutatePs: quiet }), env);
  assert.deepEqual([before.currentTag, before.queueTags], ["PROJ-102(perm)", ["PROJ-102(question)"]]);
  assert.match(before.stats, /^等待回應 1 \| 等待授權 1 \| 回覆完畢 0 /);
  const dir = fake({ mutatePs: (ps) => { quiet(ps); Object.assign(agentIn(ps, "release-2026-10")[0], { state: "done", toolName: null, lastAssistantMessage: "要先跑測試嗎？", stateStartedAt: 1790787900000 }); } });
  const after = focusRun(dir, env);
  assert.deepEqual([after.currentTag, after.announce], ["PROJ-102(perm)", null], "橫條題目不動，也不印");
  assert.deepEqual(after.queue.map((q) => [after.tagOf(q.key), q.isNew]), [["PROJ-102(question)", false], ["release…#1", true]]);
  assert.match(after.stats, /^等待回應 2 \| 等待授權 1 /);
  assert.deepEqual(run("console.mjs", ["after-send", "--repo", app(), "PROJ-102(perm)"], { dir, env }).lines, ["等 PROJ-102(perm) 回應中…　還有 2 題排隊", "待取暱稱：chris-proj-102-question（app）、proj-102-perm（app）、release-2026-10（app）"]);
  const waiting = focusRun(dir, env);
  assert.deepEqual([waiting.current, waiting.waiting.tag, waiting.announce], [null, "PROJ-102(perm)", null]);
  const asksAgain = fake({ mutatePs: (ps) => { quiet(ps); Object.assign(agentIn(ps, "release-2026-10")[0], { state: "done", toolName: null, lastAssistantMessage: "要先跑測試嗎？", stateStartedAt: 1790787900000 }); Object.assign(agentIn(ps, "proj-102-perm")[0], { state: "done", toolName: null, lastAssistantMessage: "要改用 db:reset 嗎？", stateStartedAt: 1790787950000 }); } });
  const sticky = focusRun(asksAgain, env);
  assert.deepEqual([sticky.currentTag, sticky.announce, sticky.waiting], ["PROJ-102(perm)", "PROJ-102(perm)", null], "60 秒內同一 session 又問：不換人直接上橫條");
  run("console.mjs", ["after-send", "--repo", app(), "PROJ-102(perm)"], { dir: asksAgain, env });
  const state = readJson(home, "focus.json");
  fs.writeFileSync(path.join(home, "focus.json"), JSON.stringify({ ...state, wait: { ...state.wait, until: Date.now() - 1 } }));
  const moved = focusRun(asksAgain, env);
  assert.deepEqual([moved.currentTag, moved.announce], ["PROJ-102(question)", "PROJ-102(question)"], "超過 60 秒自動輪到排隊第一題並 announce");
});

test("console.mjs focus：只回應中控台自己的分頁；每個 session 一張卡片資料，含狀態、階段、摘要、問題、a/b/c 選項與完整回報（不含建議）", () => {
  const notConsole = fs.mkdtempSync(path.join(tmp, "home-"));
  assert.deepEqual(JSON.parse(run("console.mjs", ["focus"], { env: { WORKTREE_CONSOLE_HOME: notConsole } }).out), { active: false });
  assert.ok(!fs.existsSync(path.join(notConsole, "focus.json")), "不是中控台不留心跳");
  const home = consoleHome();
  const view = focusRun(fake({ mutatePs: stagger }), { WORKTREE_CONSOLE_HOME: home });
  assert.equal(view.stats, "等待回應 1 | 等待授權 1 | 回覆完畢 2 | 執行中 2 | 封存 0 | 閒置 1");
  assert.equal(view.home, home);
  const perm = view.sessions.find((s) => s.tag === "PROJ-102(perm)");
  assert.deepEqual([perm.status, perm.stage, perm.pending, perm.options, "suggest" in perm], ["等待授權", "未開工", true, [], false]);
  assert.equal(perm.report, expectedReports(fake({ mutatePs: stagger }), ["PROJ-102(perm)"])[0].join("\n"));
  const idle = view.sessions.find((s) => s.tag === "PROJ-103");
  assert.deepEqual([idle.status, idle.question, idle.pending], ["閒置", "（閒置）", false]);
  assert.deepEqual(view.sessions.map((s) => s.repo), ["app", "app", "app", "app", "app", "app", "api"]);
  assert.ok(Date.now() - readJson(home, "focus.json").modsAt < 5_000, "每次輪詢都是 mods 的心跳");
  const menu = focusRun(withMenuSession([MENU[0]], { mutatePs: (ps) => { stagger(ps); Object.assign(agentIn(ps, "proj-103-idle")[0], menuAgent()); } }), { WORKTREE_CONSOLE_HOME: consoleHome() });
  const card = menu.sessions.find((s) => s.tag === "PROJ-103");
  assert.deepEqual([card.options, "suggest" in card], [["紅", "綠", "藍"], false]);
});

const PROJ_6668 = fs.readFileSync(path.join(fixtures, "proj-6668.md"), "utf8");

test("選項漏抓：optionLine 認出「- **A（建議）：…**」是選項 A 且標為建議；PROJ-6668 原文的待回覆清單選項欄有 a、b、c，建議欄為 a", () => {
  const hit = optionLine("- **A（建議）：這張票只在卡片上顯示「缺多少」…**");
  assert.deepEqual([hit.code, hit.marked], ["A", true]);
  assert.equal(hit.label, "這張票只在卡片上顯示「缺多少」…");
  assert.deepEqual(optionLine("A（建議）：照做"), { code: "A", label: "照做", marked: true });
  const by = replyList(pendingBlock([listRow("PROJ-6668", session(asking(PROJ_6668)))]).join("\n")).by;
  const options = by["PROJ-6668"][3].split("／");
  assert.deepEqual(options.map((o) => o.split(" ")[0]), ["a", "b", "c"]);
  assert.equal(by["PROJ-6668"][4], "a");
  const report = reportLines(listRow("PROJ-6668"), asking(PROJ_6668));
  assert.deepEqual(report.slice(-4), ["", "- a. 這張票只在卡片上顯示「缺多少」，細節用連結交給現有頁面。（建議）", "- b. 卡片直接顯示狀態標籤（補貨中、被其他訂單保留、待上架……）。", "- c. 前端自己去撈庫存保留紀錄來推算原因。"]);
});

test("a/b/c 轉回子 session 原寫法：列 A／B／C 送 B、列 1／2／3 送 2，選單送選單編號", () => {
  const [letters] = pendingItems([listRow("PROJ-1", session(asking("- **A**：先改 API\n- **B**：先改畫面\n\n先做哪個？")))]);
  const [digits] = pendingItems([listRow("PROJ-2", session(asking("1. 先改 API\n2. 先改畫面\n\n先做哪個？")))]);
  const [menu] = pendingItems([listRow("PROJ-3", session({ kind: "waiting", menu: MENU }, { agent: { state: "waiting", toolName: "AskUserQuestion" } }))]);
  assert.deepEqual([childAnswer(letters, "b"), childAnswer(digits, "b"), childAnswer(menu, "b；a")], ["B", "2", "2；1"]);
  assert.deepEqual([childAnswer(letters, "照 b 做"), childAnswer(letters, "z"), childAnswer(menu, "其他：XL；a")], ["照 b 做", "z", "其他：XL；1"]);
});

// A child question on term_b (PROJ-102(question)) with options, the only one waiting, and a screen showing `sent` delivered.
function replyWorld(text, sent) {
  const dir = fake({
    mutatePs: (ps) => {
      Object.assign(agentIn(ps, "chris-proj-102-question")[0], { state: "done", toolName: null, lastAssistantMessage: text, stateStartedAt: 1790787800001 });
      Object.assign(agentIn(ps, "proj-102-perm")[0], { state: "working", toolName: null });
      releaseBusy(ps);
    },
  });
  const screen = JSON.parse(fs.readFileSync(screenFile("chat"), "utf8"));
  screen.result.terminal.tail = screen.result.terminal.tail.map((l) => l.replace(SCREENS.chat[1], sent));
  fs.writeFileSync(path.join(dir, "screen-term_b-0.json"), JSON.stringify(screen));
  return dir;
}
const sentTo = (dir) => fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter((l) => l.startsWith("terminal send"));

test("回答路由：沒寫代號的回答送給橫條目前這題，第一行為「[<代號>] 已送出」；寫代號送那一題；b 依子 session 原寫法送 B 或 2", () => {
  const env = () => ({ WORKTREE_CONSOLE_HOME: consoleHome({ mods: true }), SEND_CHECK_MS: "0", SEND_CHECK_TRIES: "1" });
  const letters = replyWorld("- **A**：先改 API\n- **B**：先改畫面\n\n先做哪個？", "B");
  const bare = run("console.mjs", ["reply", "--repo", app(), "--", "b"], { dir: letters, env: env() });
  assert.equal(bare.lines[0], "[PROJ-102(question)] 已送出", bare.out);
  assert.deepEqual(sentTo(letters), ["terminal send --terminal term_b --text B --enter"]);
  const digits = replyWorld("1. 先改 API\n2. 先改畫面\n\n先做哪個？", "2");
  const named = run("console.mjs", ["reply", "--repo", app(), "--", "PROJ-102(question)", "b"], { dir: digits, env: env() });
  assert.equal(named.lines[0], "[PROJ-102(question)] 已送出", named.out);
  assert.deepEqual(sentTo(digits), ["terminal send --terminal term_b --text 2 --enter"]);
  const sentence = replyWorld("- **A**：先改 API\n- **B**：先改畫面\n\n先做哪個？", "先改畫面，順便補測試");
  const free = run("console.mjs", ["reply", "--repo", app(), "--", "先改畫面，順便補測試"], { dir: sentence, env: env() });
  assert.equal(free.lines[0], "[PROJ-102(question)] 已送出", free.out);
  assert.deepEqual(sentTo(sentence), ["terminal send --terminal term_b --text 先改畫面，順便補測試 --enter"]);
});

test("回答路由：選單題的 a、b 轉成選單實際編號再代按", () => {
  const dir = withMenuSession([MENU[0]], { mutatePs: (ps) => { Object.assign(agentIn(ps, "proj-103-idle")[0], menuAgent()); for (const s of ["chris-proj-102-question", "proj-102-perm"]) Object.assign(agentIn(ps, s)[0], { state: "working", toolName: null }); releaseBusy(ps); } });
  const res = run("console.mjs", ["reply", "--repo", app(), "--", "b"], { dir, env: { WORKTREE_CONSOLE_HOME: consoleHome({ mods: true }) } });
  assert.deepEqual(sentTo(dir)[0], "terminal send --terminal term_e --text 2");
  assert.match(res.lines[0], /^\[PROJ-103\] /);
});

test("有 mods 時在輸入框回覆（send 送達）也算回完這題：專注改成等這個 session；沒有 mods 時不碰專注狀態", () => {
  const home = consoleHome({ mods: true });
  const sent = sendRun(["chat"], SCREENS.chat[1], { WORKTREE_CONSOLE_HOME: home });
  assert.equal(sent.out, "[PROJ-103] 已送出");
  const state = readJson(home, "focus.json");
  assert.deepEqual([state.wait.tag, state.wait.handle, state.current], ["PROJ-103", "term_e", null]);
  assert.ok(state.wait.until > Date.now() + FOCUS_WAIT_MS - 10_000);
  const plain = consoleHome();
  assert.equal(sendRun(["chat"], SCREENS.chat[1], { WORKTREE_CONSOLE_HOME: plain }).out, "[PROJ-103] 已送出");
  assert.ok(!fs.existsSync(path.join(plain, "focus.json")));
});

test("蒸餾提醒：保存的對話紀錄滿 20 份時 watcher 印一行提醒（附路徑清單檔）並帶 baseline 結束；同一批下次不再叫醒，中控台重啟再提醒", () => {
  const log = fs.mkdtempSync(path.join(tmp, "distill-log-"));
  fs.mkdirSync(path.join(log, ".state"), { recursive: true });
  fs.writeFileSync(path.join(log, ".state", "archive.json"), JSON.stringify({ order: Array.from({ length: 20 }, (_, i) => `sid-${i}`), sources: {} }));
  const dir = fake();
  const env = { WORKTREE_CONSOLE_LOG_DIR: log, WATCH_TIMEOUT_MS: "300" };
  const first = run("watch.mjs", [], { dir, env });
  assert.match(first.lines[0], /^\[蒸餾\] 已保存 20 份對話紀錄待蒸餾，這批 20 份的路徑清單：.*distill-batch\.txt；處理完打「已蒸餾」$/);
  assert.match(first.lines.at(-1), /^baseline: /);
  assert.equal(first.lines.length, 2);
  assert.equal(fs.readFileSync(path.join(log, "distill-batch.txt"), "utf8").trim().split("\n").length, 20);
  const again = run("watch.mjs", ["--baseline", first.lines.at(-1).slice("baseline: ".length)], { dir, env });
  assert.ok(!again.out.includes("[蒸餾]"), again.out);
  assert.match(run("watch.mjs", [], { dir, env }).lines[0], /^\[蒸餾\]/, "中控台重啟（不帶 baseline）再提醒");
  assert.match(run("console.mjs", ["distilled"], { dir, env }).out, /^\[蒸餾\] 已標記處理到第 20 份/);
  assert.ok(!run("watch.mjs", [], { dir, env }).out.includes("[蒸餾]"));
});

test("中控台登記：只是跑 board 或 watcher 的開發 session（含共用 session 編號的子代理）不登記成中控台——過程紀錄與 consoles.json 都不登記；載入過 worktree-console skill 的才登記，看板照樣排除自己的分頁", () => {
  const log = fs.mkdtempSync(path.join(tmp, "register-log-"));
  const home = fs.mkdtempSync(path.join(tmp, "register-home-"));
  const consoles = () =>
    fs.readdirSync(log).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(path.join(log, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
      .filter((e) => e.event === "session" && e.role === "console").map((e) => e.sessionId);
  const registry = () => (fs.existsSync(path.join(home, "consoles.json")) ? JSON.parse(fs.readFileSync(path.join(home, "consoles.json"), "utf8")) : []);
  const dir = fake({ mutatePs: (ps) => Object.assign(agentIn(ps, "/app")[0], { state: "done", lastAssistantMessage: "中控台自己的分頁" }) });
  const env = (sid) => ({ WORKTREE_CONSOLE_LOG_DIR: log, WORKTREE_CONSOLE_HOME: home, CLAUDE_CODE_SESSION_ID: sid, WATCH_TIMEOUT_MS: "100" });
  const dev = claudeSession("dev-sid", { skill: false });
  run("console.mjs", ["board", "--repo", app()], { dir, env: env(dev) });
  run("watch.mjs", [], { dir, env: env(dev) });
  assert.deepEqual(consoles(), [], "開發 session 跑 board／watcher 不寫中控台登記事件");
  assert.deepEqual(registry(), [], "開發 session 跑 board／watcher 不進 consoles.json");
  const real = claudeSession("console-sid");
  const board = run("console.mjs", ["board", "--repo", app()], { dir, env: env(real) }).out;
  run("console.mjs", ["board", "--repo", app()], { dir, env: env(real) });
  assert.deepEqual(consoles(), ["console-sid"], "真的中控台登記一次");
  assert.deepEqual(registry(), ["term_self"], "真的中控台進 consoles.json");
  assert.doesNotMatch(board, /中控台自己的分頁/, "看板排除中控台自己的分頁");
});

const GOAL_PROMPT = "/goal 做完登入頁";
const goalStatus = (met) => ({ type: "attachment", attachment: { type: "goal_status", met, ...(met ? {} : { sentinel: true }), condition: "做完登入頁" } });
const goalCommand = userText("<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>做完登入頁</command-args>");
const goalStdout = userText("<local-command-stdout>Goal set: 做完登入頁</local-command-stdout>");
const goalTurn = (...rest) => [goalStatus(false), goalCommand, goalStdout, assistantText("第一段做完。"), ...rest];
const GOAL_FOOTER = ["⏺ 第一段做完。", "                                        ◎ /goal active (1m 3s)", "────", "❯ ", "────", "  ~/wt/proj-101-login  feat/proj-101-login", "  ⏵⏵ bypass permissions on"];
const PLAIN_FOOTER = ["⏺ 第一段做完。", "  ⎿  /goal active 這幾個字出現在輸出裡不算", "────", "❯ ", "────", "  ⏵⏵ bypass permissions on"];
const goalScreen = (handle, tail) => [`terminal-read-${handle}.json`, JSON.stringify({ ok: true, result: { terminal: { handle, tail } } })];
const GOAL_NOW = 1_800_000_000_000;

// Status of a stopped PROJ-101 tab: transcript files (null = none), footer lines (null = unreadable), seconds stopped.
function goalKind({ files = { "s.jsonl": goalTurn() }, screen = GOAL_FOOTER, age = 10, prompt = GOAL_PROMPT, handle = "term_goal", extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "goal-orca-"));
  if (screen) fs.writeFileSync(path.join(dir, goalScreen(handle, screen)[0]), goalScreen(handle, screen)[1]);
  const agent = { ...agentsOf("proj-101-login")[0], state: "done", workingMode: undefined, toolName: null, prompt, lastAssistantMessage: "第一段做完。", stateStartedAt: GOAL_NOW - age * 1000, ...extra };
  const env = { ORCA_BIN: fakeOrca, FAKE_ORCA_DIR: dir, ORCA_TERMINAL_HANDLE: "term_self" };
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return withTranscripts(files ?? {}, () => sessionStatus(agent, wt("proj-101-login"), handle, GOAL_NOW).kind);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("/goal 進行中：紀錄最後一筆 goal_status 是 met:false 且畫面底部有 /goal active，Orca 回報 done 也算執行中；問句停下同樣算執行中", () => {
  assert.equal(goalKind(), "busy");
  assert.equal(goalKind({ extra: { lastAssistantMessage: "第一段做完，要繼續嗎？" } }), "busy");
  const settled = { state: "working", workingMode: "monitoring", mainAgent: { state: "done", stateStartedAt: GOAL_NOW - 10_000 } };
  assert.equal(goalKind({ extra: settled }), "busy", "只剩背景工作改判的停下也照 /goal 規則");
});

test("/goal 進行中：照分頁登記的對話紀錄判斷，Orca 的 prompt 對不到也找得到", () => {
  const dir = claudeProjectDir(path.join(tmp, "elsewhere"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "logged.jsonl");
  fs.writeFileSync(file, goalTurn().map((e) => JSON.stringify(e)).join("\n") + "\n");
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(process.env.WORKTREE_CONSOLE_LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(process.env.WORKTREE_CONSOLE_LOG_DIR, `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: "session", role: "child", handle: "term_goal_logged", sessionId: "logged", transcript: file }) + "\n");
  assert.equal(goalKind({ files: {}, screen: null, handle: "term_goal_logged", prompt: "評審駁回後的接續" }), "busy");
});

test("/goal 達成：紀錄寫入 met:true 或畫面底部不再有 /goal active 就照一般規則判回覆完畢", () => {
  assert.equal(goalKind({ files: { "s.jsonl": goalTurn(goalStatus(true), assistantText("全部完成。")) } }), "done", "met:true，畫面還掛著字樣也算結束");
  assert.equal(goalKind({ screen: PLAIN_FOOTER }), "done", "紀錄沒寫結束（例如手動取消），畫面已無字樣");
  assert.equal(goalKind({ files: { "s.jsonl": goalTurn(goalStatus(true)) }, extra: { lastAssistantMessage: "都做完了，要 push 嗎？" } }), "waiting");
});

test("/goal 單邊讀取與 60 秒保險：只讀得到一邊照那一邊；兩邊都讀不到時回覆完畢滿 60 秒才算", () => {
  assert.equal(goalKind({ screen: null }), "busy", "只有紀錄：進行中");
  assert.equal(goalKind({ screen: null, files: { "s.jsonl": goalTurn(goalStatus(true)) } }), "done", "只有紀錄：已達成");
  assert.equal(goalKind({ files: null }), "busy", "只有畫面：有字樣");
  assert.equal(goalKind({ files: null, screen: PLAIN_FOOTER }), "done", "只有畫面：沒有字樣");
  assert.equal(goalKind({ files: { "a.jsonl": goalTurn(), "b.jsonl": goalTurn() }, screen: PLAIN_FOOTER }), "done", "紀錄對到多份算讀不到，照畫面");
  assert.equal(goalKind({ files: { "s.jsonl": "not json\n{broken" }, screen: GOAL_FOOTER }), "busy", "紀錄壞掉算讀不到，照畫面");
  assert.equal(goalKind({ files: null, screen: null, age: 59 }), "busy", "兩邊都讀不到：未滿 60 秒");
  assert.equal(goalKind({ files: null, screen: null, age: 60 }), "done", "兩邊都讀不到：滿 60 秒");
  assert.equal(goalKind({ files: null, screen: null, extra: { stateStartedAt: undefined } }), "done", "不知道停多久就照一般規則");
});

function goalStatusOf(extra) {
  const dir = fs.mkdtempSync(path.join(tmp, "goal-orca-"));
  fs.writeFileSync(path.join(dir, goalScreen("term_goal", GOAL_FOOTER)[0]), goalScreen("term_goal", GOAL_FOOTER)[1]);
  const agent = { ...agentsOf("proj-101-login")[0], workingMode: undefined, prompt: GOAL_PROMPT, lastAssistantMessage: null, stateStartedAt: GOAL_NOW - 1000, ...extra };
  const prev = { ORCA_BIN: process.env.ORCA_BIN, FAKE_ORCA_DIR: process.env.FAKE_ORCA_DIR };
  Object.assign(process.env, { ORCA_BIN: fakeOrca, FAKE_ORCA_DIR: dir });
  try {
    return withTranscripts({ "s.jsonl": goalTurn(toolUse("t1", "AskUserQuestion", { questions: MENU })) }, () => sessionStatus(agent, wt("proj-101-login"), "term_goal", GOAL_NOW));
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("/goal 進行中＋選單：開著選單照原規則馬上算等待回應進待回覆，不算執行中、不等 5 分鐘", () => {
  for (const state of ["waiting", "blocked"]) {
    const status = goalStatusOf({ state, toolName: "AskUserQuestion", toolInput: { questions: MENU } });
    assert.equal(status.kind, "waiting", state);
    assert.deepEqual(status.menu.map((q) => q.question), ["要哪個顏色？", "要哪個尺寸？"], state);
    assert.ok(needsYou(status.kind), state);
  }
});

test("/goal 進行中＋權限請求：照原規則馬上算等待授權進待回覆，不算執行中、不等 5 分鐘", () => {
  for (const state of ["waiting", "blocked"]) {
    const status = goalStatusOf({ state, toolName: "Bash", toolInput: "rm -rf build" });
    assert.deepEqual([status.kind, status.tool, status.input], ["permission", "Bash", "rm -rf build"], state);
    assert.ok(needsYou(status.kind), state);
  }
});

test("/goal 5 分鐘上限：進行中但停下滿 5 分鐘沒被接續，照回覆完畢", () => {
  assert.equal(goalKind({ age: 299 }), "busy");
  assert.equal(goalKind({ age: 300 }), "done");
  assert.equal(goalKind({ files: null, screen: null, age: 300 }), "done");
});

test("沒跑 /goal：紀錄或畫面讀得到時，停下立刻是回覆完畢，不多等 60 秒", () => {
  const plain = { "s.jsonl": turn() };
  assert.equal(goalKind({ files: plain, screen: PLAIN_FOOTER, prompt: LOGIN_PROMPT, age: 1 }), "done");
  assert.equal(goalKind({ files: plain, screen: null, prompt: LOGIN_PROMPT, age: 1 }), "done", "只讀得到紀錄");
  assert.equal(goalKind({ files: null, screen: PLAIN_FOOTER, prompt: LOGIN_PROMPT, age: 1 }), "done", "只讀得到畫面");
  assert.equal(goalKind({ files: { "s.jsonl": goalTurn(goalStatus(true), userText(LOGIN_PROMPT), assistantText("好")) }, screen: null, prompt: LOGIN_PROMPT, age: 1 }), "done", "先前跑過的 /goal 已達成");
});

test("/goal 中控台各處：進行中時專注排隊列、灰色統計行、看板都算執行中，沒有 mods 的 watcher 不叫醒；達成後進隊伍一次並回報", () => {
  const stopped = Date.now() - 10_000;
  const goalPs = (ps) => {
    stagger(ps);
    Object.assign(agentIn(ps, "proj-101-login")[0], { state: "done", workingMode: undefined, toolName: null, prompt: GOAL_PROMPT, lastAssistantMessage: "第一段做完。", stateStartedAt: stopped });
  };
  const withScreen = (tail) => {
    const dir = fake({ mutatePs: goalPs });
    fs.writeFileSync(path.join(dir, goalScreen("term_a", tail)[0]), goalScreen("term_a", tail)[1]);
    return dir;
  };
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  const baseline = focusRun(fake({ mutatePs: stagger }), { WORKTREE_CONSOLE_HOME: consoleHome({ mods: true }) });

  withTranscripts({ "s.jsonl": goalTurn() });
  const active = withScreen(GOAL_FOOTER);
  const during = focusRun(active, env);
  const card = during.sessions.find((s) => s.tag === "PROJ-101");
  assert.deepEqual([card.status, card.pending], ["執行中", false]);
  assert.ok(!during.queueTags.includes("PROJ-101") && during.currentTag !== "PROJ-101", "不進排隊");
  assert.ok(!during.queue.some((q) => q.isNew), "沒有 ✨，不跳浮動通知");
  assert.equal(during.stats, baseline.stats, "統計行跟沒停下時一樣");
  assert.equal(table(run("console.mjs", ["board", "--repo", app()], { dir: active }).out).by["PROJ-101"][0], "🔄 執行中");
  const quiet = run("watch.mjs", ["--baseline", baselineWith()], { dir: active, env: { WATCH_TIMEOUT_MS: "300" } });
  assert.equal(quiet.lines[0], "[watch] timeout", quiet.out);

  withTranscripts({ "s.jsonl": goalTurn(goalStatus(true), assistantText("全部完成。")) });
  const achieved = withScreen(PLAIN_FOOTER);
  const done = focusRun(achieved, env);
  assert.equal(done.queueTags.filter((t) => t === "PROJ-101").length, 1, "達成後進隊伍");
  assert.equal(done.queue.find((q) => done.tagOf(q.key) === "PROJ-101").isNew, true, "多一顆 ✨");
  const again = focusRun(achieved, env);
  assert.equal(again.queueTags.filter((t) => t === "PROJ-101").length, 1, "同一次停下只進一次");
  assert.equal(again.queue.find((q) => again.tagOf(q.key) === "PROJ-101").isNew, true, "key 沒變，不重算成新題");
  assert.equal(table(run("console.mjs", ["board", "--repo", app()], { dir: achieved }).out).by["PROJ-101"][0], "⏸ 回覆完畢");
  const woke = run("watch.mjs", ["--baseline", baselineWith()], { dir: achieved, env: { WATCH_TIMEOUT_MS: "300" } });
  assert.deepEqual(fresh(blocks(woke.out).reports).map((r) => r[0]), ["### ⏸ PROJ-101 回覆完畢"]);
});

test("API 錯誤停下：不用 Orca 給的最後回覆（空的或前一個工具的錯誤輸出），改印對話紀錄裡的錯誤訊息，狀態是回覆完畢", () => {
  const dir = claudeProjectDir(path.join(tmp, "api-error"));
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(process.env.WORKTREE_CONSOLE_LOG_DIR, { recursive: true });
  const register = (handle, entries) => {
    const file = path.join(dir, `${handle}.jsonl`);
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    fs.appendFileSync(path.join(process.env.WORKTREE_CONSOLE_LOG_DIR, `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: "session", role: "child", handle, sessionId: handle, transcript: file }) + "\n");
  };
  const statusOf = (handle, lastAssistantMessage) => {
    const agent = { ...agentsOf("proj-101-login")[0], state: "done", workingMode: undefined, toolName: null, prompt: "同意", lastAssistantMessage, stateStartedAt: GOAL_NOW - 600_000 };
    return sessionStatus(agent, wt("proj-101-login"), handle, GOAL_NOW);
  };
  const error = "API Error: Opus 5.5's safeguards flagged this message.";
  const failedTool = { type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "Exit code 1\n要繼續嗎？" }] } };
  const refused = { type: "assistant", isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: error }] } };
  const tail = { type: "system", subtype: "turn_duration" };
  register("term_api_a", [failedTool, refused, tail]);
  register("term_api_b", [refused, tail]);
  register("term_api_c", [refused, assistantText("第 8 題記下了，網址是？")]);
  assert.deepEqual(statusOf("term_api_a", "Exit code 1\n要繼續嗎？"), { kind: "done", text: `⚠️ ${error}` }, "前一個工具的錯誤輸出不當成回覆，也不因問號變成等你回應");
  assert.deepEqual(statusOf("term_api_b", ""), { kind: "done", text: `⚠️ ${error}` });
  assert.equal(statusOf("term_api_c", "第 8 題記下了，網址是？").kind, "waiting", "錯誤之後又正常回覆就照 Orca 的內容");
});

test("專注佇列：橫條上的 session 被直接在它自己的分頁回覆（開始執行）也等它 60 秒；封存或關掉的不等", () => {
  const a = entry("a@1", "waiting", 1, { paneKey: "a", tag: "a" });
  const b = entry("b@2", "waiting", 2, { paneKey: "b", tag: "b" });
  const start = focusStep(emptyFocus(), [a, b], 10).state;
  let view = focusStep(start, [b], 20, [{ paneKey: "a", handle: "h-a", tag: "a" }]);
  assert.deepEqual([view.current, view.wait?.tag], [null, "a"], "原本那題消失、它在執行中：不換下一題");
  view = focusStep(view.state, [b], 30, [{ paneKey: "a", tag: "a" }]);
  assert.equal(view.current, null, "等待中照樣不換");
  const again = entry("a@25", "waiting", 25, { paneKey: "a", tag: "a" });
  view = focusStep(view.state, [b, again], 40);
  assert.deepEqual([view.current?.key, view.wait], ["a@25", null], "它再停下就端它的新題目");
  assert.equal(focusStep(start, [b], 20).current.key, "b@2", "不在執行中（封存、關掉）就照排隊");
  const late = focusStep(focusStep(start, [b], 20, [{ paneKey: "a", tag: "a" }]).state, [b], 20 + FOCUS_WAIT_MS, [{ paneKey: "a", tag: "a" }]);
  assert.equal(late.current.key, "b@2", "60 秒到了就換下一題，不再重新起算");
});

test("專注橫條存檔：輪詢最後只寫標題快取，不蓋掉輪詢期間回覆存下的等待", () => {
  const home = consoleHome({ mods: true });
  const prev = process.env.WORKTREE_CONSOLE_HOME;
  process.env.WORKTREE_CONSOLE_HOME = home;
  try {
    const wait = { paneKey: "a", handle: "h-a", tag: "a", until: Date.now() + FOCUS_WAIT_MS };
    saveFocus({ ...loadFocus(), current: null, wait, answered: ["a@1"] });
    saveTitles({ "/wt/a": "標題" });
    const state = loadFocus();
    assert.deepEqual([state.wait, state.answered, state.titles], [wait, ["a@1"], { "/wt/a": "標題" }]);
  } finally {
    if (prev === undefined) delete process.env.WORKTREE_CONSOLE_HOME;
    else process.env.WORKTREE_CONSOLE_HOME = prev;
  }
});

test("focus-shown：題目還在橫條上才記成印過；已離開橫條的等回來再印", () => {
  const home = consoleHome({ mods: true });
  const env = { WORKTREE_CONSOLE_HOME: home };
  fs.writeFileSync(path.join(home, "focus.json"), JSON.stringify({ ...emptyFocus(), modsAt: Date.now(), current: "b@2" }));
  run("console.mjs", ["focus-shown", "a@1"], { env });
  assert.deepEqual(readJson(home, "focus.json").reported, [], "已離開橫條：不算印過");
  run("console.mjs", ["focus-shown", "b@2"], { env });
  assert.deepEqual(readJson(home, "focus.json").reported, ["b@2"]);
});

test("Orca 交棒：新分頁的 --command 是 claude，送 /goal、看到 Goal set 才關訪談分頁", () => {
  const dir = fake();
  fs.writeFileSync(path.join(dir, "terminal-read-term_new.json"), JSON.stringify({ ok: true, result: { terminal: { handle: "term_new", tail: ["Goal set"] } } }));
  const file = path.join(dir, "goal.txt");
  fs.writeFileSync(file, "/goal 做完 PROJ-103");
  const res = run("console.mjs", ["handoff", "--path", wt("proj-103-idle"), "--from", "term_old", "--file", file], { dir, env: { SEND_CHECK_MS: "0" } });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /已交棒執行$/);
  const created = fs.readFileSync(path.join(dir, "create.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(created.map((a) => a[a.indexOf("--command") + 1]), ["claude"]);
  const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8");
  assert.match(calls, /terminal send --terminal term_new --text \/goal 做完 PROJ-103 --enter/);
  assert.match(calls, /terminal close --terminal term_old --tab/);
});

test("Orca open：--continue 時 --command 是 claude --continue，不帶時是 claude", () => {
  for (const [extra, command] of [[["--continue"], "claude --continue"], [[], "claude"]]) {
    const dir = fake();
    const res = run("console.mjs", ["open", "--path", wt("proj-103-idle"), ...extra], { dir });
    assert.equal(res.code, 0, res.out);
    assert.equal(res.out, "terminal: term_new");
    const args = JSON.parse(fs.readFileSync(path.join(dir, "create.log"), "utf8").trim());
    assert.equal(args[args.indexOf("--command") + 1], command);
  }
});
