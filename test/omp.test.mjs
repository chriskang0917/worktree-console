import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills", "worktree-console", "scripts");
const fixtures = path.join(root, "test", "fixtures");
const fakeHerdr = path.join(fixtures, "worktree-console", "fake-herdr.mjs");
const fakeOrca = path.join(fixtures, "worktree-console", "fake-orca.mjs");
const fakeApp = path.join(fixtures, "worktree-console", "fake-herdr-app.mjs");
const fakeHc = path.join(fixtures, "worktree-console", "fake-hc.mjs");
const autoHandoff = path.join(root, "hooks", "auto-handoff.mjs");
const BRIDGE = path.join(root, "omp", "bridge.mjs");
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORCA_|HERDR_|HC_|AUTO_HANDOFF_|CLAUDE_CODE_SESSION_ID|WORKTREE_CONSOLE_|OMP_)/.test(k)));

let tmp;
const app = () => path.join(tmp, "app");
const wt = (name) => path.join(tmp, "wt", name);
function sh(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-omp-")));
  fs.mkdirSync(app());
  sh(app(), "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(app(), "README.md"), "hi\n");
  sh(app(), "add", ".");
  sh(app(), "commit", "-qm", "init");
  for (const name of ["proj-301-ask", "proj-302-run", "proj-303-done", "proj-304-handoff"]) sh(app(), "worktree", "add", "-q", "-b", `feat/${name}`, wt(name), "main");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const router = await import("../skills/worktree-console/scripts/router.mjs");
const omp = await import("../skills/worktree-console/scripts/omp.mjs");
const bridge = await import("../omp/bridge.mjs");
const { openingRules } = await import("../hooks/review-gate.mjs");

const NOW = Date.UTC(2026, 10, 17, 6, 0, 0);
const HOUR = 60 * 60 * 1000;
const usage = (five, week, { at = NOW, resetIn = HOUR } = {}) => ({ at, fiveHour: five === null ? null : { used: five, resetsAt: at + resetIn }, weekly: week === null ? null : { used: week, resetsAt: at + 24 * HOUR } });
const cc = (five, week) => ({ fiveHour: { used: five, resetsAt: NOW + HOUR }, weekly: { used: week, resetsAt: NOW + 48 * HOUR } });
const pickOf = (r) => [r.backend, r.model];

// An omp transcript sample with its placeholders filled in, written where omp keeps sessions.
function sample(name, cwd, dir, { keepalive = "" } = {}) {
  const text = fs.readFileSync(path.join(fixtures, "omp", `${name}.jsonl`), "utf8").replaceAll("__CWD__", cwd).replaceAll('"__KEEPALIVE__"', JSON.stringify(keepalive));
  const hex = Buffer.from(name).toString("hex").padEnd(4, "0").slice(0, 4);
  const file = path.join(dir, "sessions", "-wt", `2026-11-17T06-00-00-000Z_01a1e800-0000-7000-8000-00000000${hex}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test("router 規則逐條：Claude 任一用量 ≥ 90% 才往下；Command Code 任一 ≥ 90% 再跳 Anthropic；門檻上下各一筆", () => {
  const r = (claude, commandCode = cc(10, 10)) => pickOf(router.route({ role: "implement", claude, commandCode, now: NOW }));
  assert.deepEqual(r(usage(89.9, 89.9)), ["claude", null]);
  assert.deepEqual(r(usage(90, 10)), ["omp", "commandcode/claude-sonnet-5-5"]);
  assert.deepEqual(r(usage(10, 90)), ["omp", "commandcode/claude-sonnet-5-5"]);
  assert.deepEqual(r(usage(95, 95), cc(89.9, 89.9)), ["omp", "commandcode/claude-sonnet-5-5"]);
  assert.deepEqual(r(usage(95, 10), cc(90, 10)), ["omp", "anthropic/claude-sonnet-5-5"]);
  assert.deepEqual(r(usage(95, 10), cc(10, 92)), ["omp", "anthropic/claude-sonnet-5-5"]);
  assert.match(router.route({ role: "implement", claude: usage(93, 20), commandCode: cc(95, 1), now: NOW }).reason, /Claude 5 小時用量 93% ≥ 90%，Command Code 5 小時用量 95% ≥ 90%，改用 Anthropic API/);
});

test("router 資料缺漏：從沒寫過用量檔選 Claude；缺一個視窗只看另一個；Command Code 讀不到先用 Command Code", () => {
  const none = router.route({ role: "implement", claude: null, now: NOW });
  assert.deepEqual(pickOf(none), ["claude", null]);
  assert.match(none.reason, /讀不到 Claude 用量/);
  assert.deepEqual(pickOf(router.route({ role: "implement", claude: usage(null, 50), now: NOW })), ["claude", null]);
  assert.deepEqual(pickOf(router.route({ role: "implement", claude: usage(null, 97), commandCode: cc(1, 1), now: NOW })), ["omp", "commandcode/claude-sonnet-5-5"]);
  const unknown = router.route({ role: "implement", claude: usage(97, 1), commandCode: null, now: NOW });
  assert.deepEqual(pickOf(unknown), ["omp", "commandcode/claude-sonnet-5-5"]);
  assert.match(unknown.reason, /Command Code 用量讀不到/);
});

test("router 用量過期：超過 15 分鐘沒更新沿用上次的選擇，到該上限的重置時間才回 Claude；15 分鐘內照新資料判", () => {
  const at = NOW - 20 * 60 * 1000;
  const previous = { backend: "omp", provider: "commandcode", model: "commandcode/claude-sonnet-5-5", resetsAt: NOW + 30 * 60 * 1000 };
  const kept = router.route({ role: "implement", claude: usage(10, 10, { at }), previous, now: NOW });
  assert.deepEqual(pickOf(kept), ["omp", "commandcode/claude-sonnet-5-5"]);
  assert.match(kept.reason, /20 分鐘沒更新，沿用上次的選擇/);
  const back = router.route({ role: "implement", claude: usage(10, 10, { at }), previous: { ...previous, resetsAt: NOW - 1 }, now: NOW });
  assert.deepEqual(pickOf(back), ["claude", null]);
  assert.match(back.reason, /已過重置時間/);
  const anthropic = { backend: "omp", provider: "anthropic", model: "anthropic/claude-sonnet-5-5", resetsAt: NOW + 1000 };
  assert.deepEqual(pickOf(router.route({ role: "implement", claude: usage(99, 99, { at }), previous: anthropic, now: NOW })), ["omp", "anthropic/claude-sonnet-5-5"]);
  assert.deepEqual(pickOf(router.route({ role: "implement", claude: usage(99, 99, { at }), previous: { backend: "claude" }, now: NOW })), ["claude", null]);
  assert.deepEqual(pickOf(router.route({ role: "implement", claude: usage(10, 10, { at: NOW - 14 * 60 * 1000 }), previous, now: NOW })), ["claude", null]);
});

test("router 只換實作階段：訪談、規劃、中控台在用量 100% 時也開 Claude", () => {
  for (const role of ["interview", "planning", "console"]) {
    const r = router.route({ role, claude: usage(100, 100), commandCode: cc(100, 100), now: NOW });
    assert.deepEqual(pickOf(r), ["claude", null], role);
    assert.match(r.reason, /需求訪談與規劃一律用 Claude Code/);
  }
});

test("router 用量回降：上次選 omp、這次用量回到 90% 以下就選回 Claude", () => {
  const first = router.route({ role: "implement", claude: usage(96, 30), commandCode: cc(5, 5), now: NOW });
  assert.equal(first.backend, "omp");
  const later = router.route({ role: "implement", claude: usage(40, 30, { at: NOW + HOUR }), commandCode: cc(5, 5), previous: { ...first }, now: NOW + HOUR });
  assert.deepEqual(pickOf(later), ["claude", null]);
});

test("用量檔：讀 statusline 寫的 rate_limits（resets_at 是秒）；omp usage --json 的 Command Code 換成百分比", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "usage-"));
  const file = path.join(dir, "usage.json");
  assert.equal(router.readClaudeUsage(file), null);
  fs.writeFileSync(file, JSON.stringify({ at: NOW, rate_limits: { five_hour: { used_percentage: 91, resets_at: 1794901959 }, seven_day: { used_percentage: 12, resets_at: 1795000000 } } }));
  assert.deepEqual(router.readClaudeUsage(file), { at: NOW, fiveHour: { used: 91, resetsAt: 1794901959000 }, weekly: { used: 12, resetsAt: 1795000000000 } });
  const report = { reports: [{ provider: "commandcode", limits: [{ window: { id: "5h", resetsAt: 5 }, amount: { usedFraction: 0.5 } }, { window: { id: "7d", resetsAt: 7 }, amount: { usedFraction: 0.95 } }] }] };
  assert.deepEqual(router.parseCommandCode(report), { fiveHour: { used: 50, resetsAt: 5 }, weekly: { used: 95, resetsAt: 7 } });
  assert.equal(router.parseCommandCode({ reports: [] }), null);
});

test("omp 紀錄轉成 Claude 格式：工具呼叫、提問、cacheRead／cacheWrite 與 promptTokens 對上 Claude 的欄位", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "conv-"));
  const entries = fs.readFileSync(sample("question", "/w", dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(omp.isOmpEntries(entries));
  const out = omp.claudeEntries(entries);
  assert.deepEqual(out.map((e) => e.type), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(out[1].message.content[0], { type: "tool_use", id: "c1", name: "Read", input: { path: "README.md", i: "讀 README", file_path: "README.md" } });
  assert.equal(out[2].message.content[0].tool_use_id, "c1");
  const last = out[3].message;
  assert.equal(last.stop_reason, "end_turn");
  assert.deepEqual(last.usage, { input_tokens: 1200, cache_read_input_tokens: 40000, cache_creation_input_tokens: 800, output_tokens: 300 });
  assert.equal(last.context_window, 1_000_000);
  assert.equal(omp.sessionIdOf("/x/2026-11-17T06-00-00-000Z_01a1e800-0000-7000-8000-00000000abcd.jsonl"), "01a1e800-0000-7000-8000-00000000abcd");
});

test("omp 輸入框：空的讀成空字串、有草稿讀出草稿（omp 畫面樣本）；Claude 畫面不算 omp", () => {
  const read = (name) => fs.readFileSync(path.join(fixtures, `omp-screen-${name}.txt`), "utf8").replace(/\n+$/, "").split("\n");
  assert.equal(omp.ompDraftOf(read("empty")), "");
  assert.equal(omp.ompDraftOf(read("draft")), "這是一段草稿 draft");
  assert.equal(omp.ompDraftOf(["────", "❯ hi", "────"]), null);
  assert.equal(omp.ompGoal("/goal 本次任務依 a.md 執行"), "/goal set 本次任務依 a.md 執行");
  assert.equal(omp.ompGoal("/goal set x"), "/goal set x");
});

// A herdr world with the console in w1:p1 and one pane per agent; omp panes report their transcript path.
function world(agents, { screens = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "w-"));
  const home = path.join(dir, "home");
  const ompDir = path.join(dir, "omp");
  const panes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: app(), foreground_cwd: app() }];
  const list = [];
  agents.forEach((a, i) => {
    const pane = `w1:p${i + 2}`;
    panes.push({ pane_id: pane, tab_id: `w1:t${i + 2}`, workspace_id: "w1", cwd: a.cwd, foreground_cwd: a.cwd, agent: a.agent ?? "omp", label: a.label ?? null });
    const file = a.sample ? sample(a.sample, a.cwd, ompDir) : null;
    list.push({ agent: a.agent ?? "omp", name: `a${i}`, pane_id: pane, cwd: a.cwd, agent_status: a.status, ...(file ? { agent_session: { agent: "omp", kind: "path", value: file } } : {}) });
  });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ panes, agents: list, workspaces: [{ workspace_id: "w1", label: "app" }] }));
  for (const [pane, lines] of Object.entries(screens)) fs.writeFileSync(path.join(dir, `screen-${pane.replace(/:/g, "_")}.txt`), lines.join("\n") + "\n");
  fs.mkdirSync(path.join(dir, "config", "herdr"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "herdr", "config.toml"), `[worktrees]\ndirectory = "${path.join(dir, "worktrees")}"\n`);
  const base = {
    ...clean(),
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_BIN: fakeHerdr,
    FAKE_HERDR_DIR: dir,
    ORCA_BIN: fakeOrca,
    WORKTREE_CONSOLE_HOME: home,
    WORKTREE_CONSOLE_LOG_DIR: path.join(dir, "log"),
    WORKTREE_CONSOLE_USAGE: path.join(dir, "usage.json"),
    OMP_AGENT_DIR: ompDir,
    OMP_BIN: "/nonexistent/omp",
    CLAUDE_PROJECTS_DIR: path.join(dir, "projects"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
    SECURITY_BIN: "/usr/bin/false",
    SEND_CHECK_MS: "0",
    SEND_CHECK_TRIES: "1",
    HERDR_GRACE_MS: "0",
  };
  const run = (args, extra = {}) => {
    const res = spawnSync(process.execPath, [path.join(scripts, "console.mjs"), ...args], { encoding: "utf8", env: { ...base, ...extra } });
    return { code: res.status, out: res.stdout.trim(), err: res.stderr };
  };
  const read = (name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const writeUsage = (five, week, at = Date.now()) => fs.writeFileSync(base.WORKTREE_CONSOLE_USAGE, JSON.stringify({ at, rate_limits: { five_hour: { used_percentage: five, resets_at: Math.round(at / 1000) + 3600 }, seven_day: { used_percentage: week, resets_at: Math.round(at / 1000) + 86400 } } }));
  return { dir, home, base, run, calls: () => read("calls.log"), sends: () => read("sends.jsonl"), writeUsage, state: () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) };
}

test("看板列出 omp 分頁，從 omp 紀錄判出 執行中／等待回應／回覆完畢；提問原文進待回覆清單；印一行實作後端原因", () => {
  const w = world([
    { cwd: wt("proj-301-ask"), status: "idle", sample: "question" },
    { cwd: wt("proj-302-run"), status: "working", sample: "running" },
    { cwd: wt("proj-303-done"), status: "idle", sample: "done" },
  ]);
  const res = w.run(["board", "--repo", app()]);
  assert.equal(res.code, 0, res.err);
  const row = (ticket) => res.out.split("\n").find((l) => l.includes(ticket)) ?? "";
  assert.match(row("PROJ-301"), /💬 輪到你/);
  assert.match(row("PROJ-302"), /🔄 執行中/);
  assert.match(row("PROJ-303"), /⏸ 回覆完畢/);
  assert.ok(res.out.includes("安裝說明要放在哪裡？"), res.out);
  assert.match(res.out.split("\n").at(-1), /^實作後端：Claude Code（讀不到 Claude 用量/);
  w.writeUsage(95, 10);
  const over = w.run(["board", "--repo", app()]);
  assert.match(over.out.split("\n").at(-1), /^實作後端：omp＋Command Code Sonnet 5\.5（Claude 5 小時用量 95% ≥ 90%；Command Code 用量讀不到/);
});

// The session record the bridge's session-start leaves for a tab, as console-log writes it.
function registered(logDir, rows) {
  fs.mkdirSync(logDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(logDir, `${day}.jsonl`), rows.map((r) => JSON.stringify({ ts: new Date().toISOString(), event: "session", role: "child", source: "startup", repo: "app", ...r })).join("\n") + "\n");
}

const OMP_TABS = [
  { name: "proj-301-ask", sample: "question", ticket: "PROJ-301", want: /💬 輪到你/ },
  { name: "proj-302-run", sample: "running", ticket: "PROJ-302", want: /🔄 執行中/ },
  { name: "proj-303-done", sample: "done", ticket: "PROJ-303", want: /⏸ 回覆完畢/ },
];

function assertOmpBoard(out) {
  const row = (ticket) => out.split("\n").find((l) => l.includes(ticket)) ?? "";
  for (const t of OMP_TABS) assert.match(row(t.ticket), t.want, out);
  assert.ok(out.includes("安裝說明要放在哪裡？"), out);
}

test("Orca 模式看板：Orca 不認得 omp，從 console-log 登記的 omp 紀錄判出 等待回應／執行中／回覆完畢", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "orca-board-"));
  const put = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  const ompDir = path.join(dir, "omp");
  const files = OMP_TABS.map((t) => sample(t.sample, wt(t.name), ompDir));
  const tree = (t) => ({ path: wt(t.name), repoId: "r1", branch: `refs/heads/feat/${t.name}`, linkedLinearIssue: null, displayName: `feat/${t.name}` });
  put("repo-list.json", { ok: true, result: { repos: [{ id: "r1", path: app(), displayName: "app" }] } });
  put("worktree-list.json", { ok: true, result: { worktrees: OMP_TABS.map(tree) } });
  put("terminal-list.json", { ok: true, result: { terminals: OMP_TABS.map((t, i) => ({ handle: `term_${i}`, tabId: `tab-${i}`, leafId: `leaf-${i}`, worktreePath: wt(t.name), agentIdentity: null, createdAt: 1000 + i })) } });
  put("worktree-ps.json", { ok: true, result: { worktrees: OMP_TABS.map((t) => ({ ...tree(t), agents: [] })) } });
  const logDir = path.join(dir, "log");
  registered(logDir, OMP_TABS.map((t, i) => ({ handle: `term_${i}`, paneKey: `tab-${i}:leaf-${i}`, ticket: t.ticket, sessionId: omp.sessionIdOf(files[i]), transcript: files[i], path: wt(t.name), cwd: wt(t.name) })));
  const env = { ...clean(), ORCA_BIN: fakeOrca, FAKE_ORCA_DIR: dir, ORCA_TERMINAL_HANDLE: "term_self", WORKTREE_CONSOLE_HOME: path.join(dir, "home"), WORKTREE_CONSOLE_LOG_DIR: logDir, WORKTREE_CONSOLE_USAGE: path.join(dir, "usage.json"), OMP_AGENT_DIR: ompDir, CLAUDE_PROJECTS_DIR: path.join(dir, "projects"), HERDR_GRACE_MS: "0", SECURITY_BIN: "/usr/bin/false" };
  const res = spawnSync(process.execPath, [path.join(scripts, "console.mjs"), "board", "--repo", app()], { encoding: "utf8", env });
  assert.equal(res.status, 0, res.stderr);
  assertOmpBoard(res.stdout);
  const without = { ...env, WORKTREE_CONSOLE_LOG_DIR: path.join(dir, "empty-log") };
  const bare = spawnSync(process.execPath, [path.join(scripts, "console.mjs"), "board", "--repo", app()], { encoding: "utf8", env: without });
  assert.doesNotMatch(bare.stdout, /💬 輪到你|💬 等待回應|🔄 執行中/, "沒登記 omp 紀錄的分頁不算 omp");
});

test("Herdr app 模式看板：hc 回報 omp 的分頁，從 console-log 登記的 omp 紀錄判出 等待回應／執行中／回覆完畢", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "app-board-"));
  const ompDir = path.join(dir, "omp");
  const files = OMP_TABS.map((t) => sample(t.sample, wt(t.name), ompDir));
  const state = {
    seq: 100,
    focus: { space: "sp0", tab: "tb0", pane: "pa1" },
    terminals: { t1: { cwd: app(), status: "working", agent: "claude-code" } },
    spaces: [
      { id: "sp0", name: "console", folder: app(), tabs: [{ id: "tb0", name: "console", terminals: [{ terminal: "t1", pane: "pa1", name: null }] }] },
      { id: "sp1", name: "app", folder: app(), tabs: [] },
    ],
  };
  OMP_TABS.forEach((t, i) => {
    const address = `t${i + 2}`;
    state.terminals[address] = { cwd: wt(t.name), status: null, agent: "omp" };
    state.spaces[1].tabs.push({ id: `tb${address}`, name: t.name, terminals: [{ terminal: address, pane: `pa${address}`, name: null }] });
  });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  const logDir = path.join(dir, "log");
  registered(logDir, OMP_TABS.map((t, i) => ({ handle: `t${i + 2}`, paneKey: `hc:t${i + 2}`, ticket: t.ticket, sessionId: omp.sessionIdOf(files[i]), transcript: files[i], path: wt(t.name), cwd: wt(t.name) })));
  const env = { ...clean(), HC_TERMINAL_ID: "t1", HC_SCOPE: "scope", HC_BIN: fakeHc, HERDR_APP_BIN: fakeApp, FAKE_HERDR_APP_DIR: dir, FAKE_HC_DIR: dir, HERDR_APP_HOME: path.join(dir, "app-home"), HERDR_APP_WORKTREES: path.join(dir, "worktrees"), WORKTREE_CONSOLE_HOME: path.join(dir, "home"), WORKTREE_CONSOLE_LOG_DIR: logDir, WORKTREE_CONSOLE_USAGE: path.join(dir, "usage.json"), OMP_AGENT_DIR: ompDir, CLAUDE_PROJECTS_DIR: path.join(dir, "projects"), HERDR_GRACE_MS: "0", SECURITY_BIN: "/usr/bin/false" };
  const res = spawnSync(process.execPath, [path.join(scripts, "console.mjs"), "board", "--repo", app()], { encoding: "utf8", env });
  assert.equal(res.status, 0, res.stderr);
  assertOmpBoard(res.stdout);
});

test("console.mjs reply 把答案送進 omp 分頁輸入框（以 omp 紀錄確認送達）；輸入框有使用者草稿時不送", () => {
  const screen = (name) => fs.readFileSync(path.join(fixtures, `omp-screen-${name}.txt`), "utf8").replace(/\n+$/, "").split("\n");
  const busy = world([{ cwd: wt("proj-301-ask"), status: "idle", sample: "question" }], { screens: { "w1:p2": screen("draft") } });
  const held = busy.run(["reply", "--repo", app(), "--", "PROJ-301 b"]);
  assert.equal(held.code, 1, held.out);
  assert.match(held.out, /草稿/);
  assert.equal(busy.sends().length, 0);
  const free = world([{ cwd: wt("proj-301-ask"), status: "idle", sample: "question" }], { screens: { "w1:p2": screen("empty") } });
  const file = free.state().agents[0].agent_session.value;
  const sent = free.run(["reply", "--repo", app(), "--", "PROJ-301 b"], {});
  assert.deepEqual(free.sends().map((s) => [s.via, s.pane]), [["prompt", "w1:p2"]]);
  assert.match(free.sends()[0].text, /b/);
  fs.appendFileSync(file, JSON.stringify({ type: "message", id: "u9", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: free.sends()[0].text }] } }) + "\n");
  const again = free.run(["send", "--terminal", "w1:p2", "--tag", "PROJ-301", "--", free.sends()[0].text]);
  assert.equal(again.code, 0, again.out + again.err);
  assert.match(again.out, /已送出/);
  assert.ok(sent.code === 0 || /已送出/.test(sent.out), sent.out);
});

test("直接開工：用量過門檻時 herdr 開 omp --model 與橋接 -e，--append-system-prompt 帶中控台規則；需求訪談一律開 Claude", () => {
  const w = world([]);
  w.writeUsage(97, 20);
  const ok = w.run(["start", "--repo", app(), "--branch", "feat/proj-310-direct", "--dir", "proj-310", "--ticket", "PROJ-310", "--", "開工"]);
  assert.match(ok.out, /backend: omp＋Command Code Sonnet 5\.5/, ok.out + ok.err);
  const start = w.calls().filter((c) => c[0] === "agent" && c[1] === "start").at(-1);
  assert.equal(start[start.indexOf("--kind") + 1], "omp");
  const argv = start.slice(start.indexOf("--") + 1);
  assert.deepEqual(argv.slice(0, 4), ["--model", "commandcode/claude-sonnet-5-5", "-e", BRIDGE]);
  assert.equal(argv[4], "--append-system-prompt");
  assert.equal(fs.readFileSync(argv[5], "utf8"), openingRules());
  w.run(["start", "--repo", app(), "--branch", "feat/proj-311-talk", "--dir", "proj-311", "--ticket", "PROJ-311", "--interview", "--", "訪談"]);
  const talk = w.calls().filter((c) => c[0] === "agent" && c[1] === "start").at(-1);
  assert.equal(talk[talk.indexOf("--kind") + 1], "claude");
  w.writeUsage(40, 20);
  w.run(["start", "--repo", app(), "--branch", "feat/proj-312-back", "--dir", "proj-312", "--ticket", "PROJ-312", "--", "開工"]);
  const back = w.calls().filter((c) => c[0] === "agent" && c[1] === "start").at(-1);
  assert.equal(back[back.indexOf("--kind") + 1], "claude", "用量回降後下一次開工選回 Claude");
});

test("Orca 與 Herdr app 模式：router 選 omp 時開分頁的指令帶 omp --model、-e 橋接與 --append-system-prompt", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "modes-"));
  const saved = { ...process.env };
  Object.assign(process.env, { ORCA_BIN: fakeOrca, FAKE_ORCA_DIR: dir, WORKTREE_CONSOLE_HOME: path.join(dir, "home") });
  fs.writeFileSync(path.join(dir, "state.json"), "{}");
  try {
    const { terminals } = await import("../skills/worktree-console/scripts/terminals.mjs");
    const choice = router.route({ role: "implement", claude: usage(99, 1), commandCode: cc(99, 1), now: NOW });
    terminals({ ORCA_TERMINAL_HANDLE: "term_x" }).create(wt("proj-303-done"), { name: "PROJ-303", backend: choice });
    const create = fs.readFileSync(path.join(dir, "create.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    const command = create[create.indexOf("--command") + 1];
    assert.ok(command.startsWith(`omp --model 'anthropic/claude-sonnet-5-5' -e '${BRIDGE}' --append-system-prompt '`), command);
    assert.deepEqual(router.launchArgv(router.route({ role: "interview", now: NOW }), { name: "PROJ-303" }), ["claude", "--name", "PROJ-303"]);
  } finally {
    process.env = saved;
  }
  const appDir = fs.mkdtempSync(path.join(tmp, "app-mode-"));
  fs.writeFileSync(path.join(appDir, "state.json"), JSON.stringify({ spaces: [{ id: "s1", name: "app", folder: app(), tabs: [] }], terminals: {} }));
  const choice = router.route({ role: "implement", claude: usage(99, 1), commandCode: cc(1, 1), now: NOW });
  const code = `const { herdrAppTerminals } = await import(${JSON.stringify(path.join(scripts, "herdr-app.mjs"))}); console.log(JSON.stringify(herdrAppTerminals.create(${JSON.stringify(wt("proj-303-done"))}, { name: "PROJ-303", backend: ${JSON.stringify(choice)}, timeoutMs: 100 })));`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...clean(), HERDR_APP_BIN: fakeApp, HC_BIN: fakeHc, FAKE_HERDR_APP_DIR: appDir, FAKE_HC_DIR: appDir, WORKTREE_CONSOLE_HOME: path.join(appDir, "home") } });
  const made = Object.values(JSON.parse(fs.readFileSync(path.join(appDir, "state.json"), "utf8")).terminals).at(-1)?.argv;
  assert.ok(made, `Herdr app 沒開分頁：${res.stdout}${res.stderr}`);
  assert.deepEqual(made.slice(0, 5), ["omp", "--model", "commandcode/claude-sonnet-5-5", "-e", BRIDGE]);
  assert.equal(made[5], "--append-system-prompt");
  assert.equal(fs.readFileSync(made[6], "utf8"), openingRules());
  assert.equal(made.includes("--session-id"), false);
});

// The fake pi the bridge registers on: handlers by event, user messages it sends.
function fakePi() {
  const handlers = {};
  const sent = [];
  return { handlers, sent, on: (name, fn) => (handlers[name] = fn), sendUserMessage: (text, opts) => sent.push({ text, opts }) };
}

function bridgeWorld() {
  const dir = fs.mkdtempSync(path.join(tmp, "bridge-"));
  const file = sample("question", wt("proj-301-ask"), path.join(dir, "omp"));
  const ctx = { hasUI: true, cwd: wt("proj-301-ask"), sessionManager: { getSessionFile: () => file, getSessionId: () => "01a1e800-0000-7000-8000-00000000ques" } };
  return { dir, file, ctx };
}

test("橋接每輪結束：用 Claude Stop 格式依序呼叫 summary、advisor stop、auto-handoff Stop；擋下時把理由當下一則訊息送回 omp", async () => {
  const { dir, ctx } = bridgeWorld();
  process.env.WORKTREE_CONSOLE_HOME = path.join(dir, "home");
  const list = bridge.hooks(root, path.join(dir, "skills"));
  fs.mkdirSync(path.join(dir, "skills", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "hooks", "advisor-record.mjs"), "");
  const all = bridge.hooks(root, path.join(dir, "skills"));
  assert.deepEqual(all.stop.map((a) => [path.relative(dir, a[1]).startsWith("..") ? path.relative(root, a[1]) : path.relative(dir, a[1]), a[2]]), [
    ["skills/worktree-console/scripts/summary.mjs", "stop"],
    ["skills/hooks/advisor-record.mjs", "stop"],
    ["hooks/auto-handoff.mjs", "stop"],
  ]);
  assert.equal(list.stop.length, 2, "沒裝 agent-skills 時略過 advisor");
  const seen = [];
  const pi = fakePi();
  const s = bridge.createBridge(pi, { hookList: all, run: async (argv, input) => (seen.push({ hook: path.basename(argv[1]), input }), argv[1].endsWith("auto-handoff.mjs") ? { decision: "block", reason: "寫交棒說明" } : null) });
  pi.handlers.agent_end({ messages: [{ role: "user", content: [] }, { role: "assistant", content: [{ type: "text", text: "要用 A 還是 B？" }] }] }, ctx);
  await s.pending;
  assert.deepEqual(seen.map((x) => x.hook), ["summary.mjs", "advisor-record.mjs", "auto-handoff.mjs"]);
  for (const { input } of seen) {
    assert.deepEqual([input.hook_event_name, input.session_id, input.cwd, input.last_assistant_message, input.stop_hook_active], ["Stop", "01a1e800-0000-7000-8000-00000000ques", wt("proj-301-ask"), "要用 A 還是 B？", false]);
    assert.equal(input.transcript_path, bridge.shadowPath("01a1e800-0000-7000-8000-00000000ques"));
  }
  const shadow = fs.readFileSync(seen[0].input.transcript_path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(shadow.at(-1).type, "assistant");
  assert.match(shadow.at(-1).message.content[0].text, /安裝說明要放在哪裡/);
  assert.deepEqual(pi.sent, [{ text: "寫交棒說明", opts: { deliverAs: "followUp" } }]);
  pi.handlers.agent_end({ messages: [] }, ctx);
  await s.pending;
  assert.equal(seen.at(-1).input.stop_hook_active, true);
  pi.handlers.agent_end({ willContinue: true, messages: [] }, ctx);
  assert.equal(seen.length, 6, "還會接著跑的一輪不算結束");
});

test("橋接改檔前：用 PreToolUse 格式送 review-gate 與範圍 hook，被擋就回拒絕；edit 改多檔每個路徑各送一次；解析不出路徑直接拒絕", async () => {
  const { dir, ctx } = bridgeWorld();
  process.env.WORKTREE_CONSOLE_HOME = path.join(dir, "home");
  const seen = [];
  const hookList = { sessionStart: [], stop: [], preEdit: [["node", "/x/review-gate.mjs"], ["node", "/x/goal-scope.mjs"]], preBash: [["node", "/x/review-gate.mjs"]], post: [] };
  const deny = (p) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `超出範圍：${p}` } });
  const pi = fakePi();
  bridge.createBridge(pi, { hookList, run: async (argv, input) => (seen.push({ hook: path.basename(argv[1]), input }), argv[1].endsWith("goal-scope.mjs") && input.tool_input.file_path === "b.js" ? deny("b.js") : null) });
  const one = await pi.handlers.tool_call({ toolName: "edit", toolCallId: "t1", input: { path: "a.js", old_string: "x", new_string: "y" } }, ctx);
  assert.equal(one, undefined);
  assert.deepEqual(seen.map((x) => [x.hook, x.input.hook_event_name, x.input.tool_name, x.input.tool_input.file_path, x.input.tool_use_id]), [
    ["review-gate.mjs", "PreToolUse", "Edit", "a.js", "t1"],
    ["goal-scope.mjs", "PreToolUse", "Edit", "a.js", "t1"],
  ]);
  seen.length = 0;
  const patch = "*** Begin Patch\n*** Update File: a.js\n@@\n-x\n+y\n*** Add File: b.js\n+z\n*** End Patch";
  const many = await pi.handlers.tool_call({ toolName: "edit", toolCallId: "t2", input: { input: patch } }, ctx);
  assert.deepEqual(many, { block: true, reason: "超出範圍：b.js" });
  assert.deepEqual(seen.map((x) => x.input.tool_input.file_path), ["a.js", "a.js", "b.js", "b.js"]);
  seen.length = 0;
  const none = await pi.handlers.tool_call({ toolName: "edit", toolCallId: "t3", input: { input: "看不懂的內容" } }, ctx);
  assert.equal(none.block, true);
  assert.match(none.reason, /解析不出這次要改的檔案路徑/);
  assert.equal(seen.length, 0);
  const written = await pi.handlers.tool_call({ toolName: "write", toolCallId: "t4", input: { path: "b.js", content: "z" } }, ctx);
  assert.equal(written.block, true);
  assert.equal(seen[0].input.tool_name, "Write");
  assert.equal(await pi.handlers.tool_call({ toolName: "read", toolCallId: "t5", input: { path: "b.js" } }, ctx), undefined);
});

test("範圍 hook 收到的 transcript_path 是 Claude 格式替身紀錄，最後一行是未達成的 goal_status；真的範圍 hook 擋下範圍外的檔", async (t) => {
  const { dir, ctx } = bridgeWorld();
  process.env.WORKTREE_CONSOLE_HOME = path.join(dir, "home");
  const goalsDir = path.join(dir, "goals");
  fs.mkdirSync(goalsDir, { recursive: true });
  const goal = path.join(goalsDir, "demo.md");
  fs.writeFileSync(goal, "# demo\n");
  fs.writeFileSync(path.join(goalsDir, "demo.scope.json"), JSON.stringify({ goal, checklist: path.join(goalsDir, "demo.checklist.md"), files: ["src/**"] }));
  const condition = `本次任務依 ${goal} 執行：照做`;
  const seen = [];
  const pi = fakePi();
  bridge.createBridge(pi, { hookList: { sessionStart: [], stop: [], preEdit: [["node", "/x/goal-scope.mjs"]], preBash: [], post: [] }, run: async (_a, input) => (seen.push(input), null) });
  pi.handlers.goal_updated({ goal: { id: "g1", objective: condition, status: "active" } });
  await pi.handlers.tool_call({ toolName: "edit", toolCallId: "t1", input: { path: path.join(wt("proj-301-ask"), "README.md"), old_string: "a", new_string: "b" } }, ctx);
  const lines = fs.readFileSync(seen[0].transcript_path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.at(-1).attachment, { type: "goal_status", met: false, condition });
  assert.ok(lines.slice(0, -1).every((e) => e.type === "user" || e.type === "assistant"));
  pi.handlers.goal_updated({ goal: { id: "g1", objective: condition, status: "complete" } });
  await pi.handlers.tool_call({ toolName: "edit", toolCallId: "t2", input: { path: "x", old_string: "a", new_string: "b" } }, ctx);
  assert.equal(JSON.parse(fs.readFileSync(seen[1].transcript_path, "utf8").trim().split("\n").at(-1)).attachment.met, true);

  const skills = bridge.agentSkillsRoot();
  if (!skills || !fs.existsSync(path.join(skills, "hooks", "goal-scope.mjs"))) return t.skip("這台沒裝 agent-skills，略過真的範圍 hook");
  process.env.DEFINE_GOAL_HOME = path.join(dir, "define-goal");
  const real = fakePi();
  bridge.createBridge(real, { hookList: { sessionStart: [], stop: [], preEdit: [["node", path.join(skills, "hooks", "goal-scope.mjs")]], preBash: [], post: [] } });
  real.handlers.goal_updated({ goal: { id: "g1", objective: condition, status: "active" } });
  const outside = await real.handlers.tool_call({ toolName: "edit", toolCallId: "t3", input: { path: path.join(wt("proj-301-ask"), "README.md"), old_string: "a", new_string: "b" } }, ctx);
  assert.equal(outside?.block, true);
  assert.match(outside.reason, /超出這個目標的可動範圍/);
  const inside = await real.handlers.tool_call({ toolName: "edit", toolCallId: "t4", input: { path: path.join(wt("proj-301-ask"), "src", "a.js"), old_string: "a", new_string: "b" } }, ctx);
  assert.equal(inside, undefined);
  delete process.env.DEFINE_GOAL_HOME;
});

test("橋接的 bash／eval 轉成 Claude Bash 送真的 review-gate：子 session 跑核准指令、寫審核狀態都被擋；工具結束轉 PostToolUse", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "gate-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "feat/demo");
  fs.writeFileSync(path.join(repo, "app.js"), "a\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  const saved = { ...process.env };
  Object.assign(process.env, { WORKTREE_CONSOLE_HOME: path.join(dir, "home"), WORKTREE_CONSOLE_LOG_DIR: path.join(dir, "log"), AUTO_HANDOFF_HOME: path.join(dir, "handoff"), CLAUDE_PROJECTS_DIR: path.join(dir, "projects"), WORKTREE_CONSOLE_PR: "" });
  try {
    const add = spawnSync(process.execPath, [path.join(scripts, "console.mjs"), "review", "add", "--question", "按鈕放哪？", "--plan", "放右上", "--basis", "沒有前例", "--impact", "工具列", "--by", "child", "--stop", "規劃 第 1 題"], { cwd: repo, encoding: "utf8", env: process.env });
    assert.equal(add.status, 0, add.stderr);
    const file = sample("question", repo, path.join(dir, "omp"));
    const ctx = { hasUI: true, cwd: repo, sessionManager: { getSessionFile: () => file, getSessionId: () => "omp-child-1" } };
    const seen = [];
    const hookList = bridge.hooks(root, null);
    const pi = fakePi();
    bridge.createBridge(pi, { hookList, run: (argv, input) => (seen.push({ hook: path.basename(argv[1]), input }), bridge.runHook(argv, input)) });
    const approve = await pi.handlers.tool_call({ toolName: "bash", toolCallId: "b1", input: { command: "node /x/flow.mjs approve --auto" } }, ctx);
    assert.equal(approve?.block, true);
    assert.match(approve.reason, /被擋下：這個 worktree 有還沒審的代回/);
    assert.deepEqual([seen[0].hook, seen[0].input.tool_name, seen[0].input.tool_input.command], ["review-gate.mjs", "Bash", "node /x/flow.mjs approve --auto"]);
    const state = await pi.handlers.tool_call({ toolName: "eval", toolCallId: "b2", input: { language: "sh", code: `node "${path.join(scripts, "console.mjs")}" review approve` } }, ctx);
    assert.equal(state?.block, true);
    assert.match(state.reason, /審核狀態只能由中控台與焦點面板寫/);
    const edit = await pi.handlers.tool_call({ toolName: "edit", toolCallId: "b3", input: { path: path.join(repo, "app.js"), old_string: "a", new_string: "b" } }, ctx);
    assert.equal(edit?.block, true);
    seen.length = 0;
    await pi.handlers.tool_result({ toolName: "bash", toolCallId: "b4", input: { command: "ls" }, content: [{ type: "text", text: "app.js" }] }, ctx);
    assert.deepEqual([seen[0].input.hook_event_name, seen[0].input.tool_name, seen[0].input.tool_use_id], ["PostToolUse", "Bash", "b4"]);
  } finally {
    process.env = saved;
  }
});

test("橋接在 session_start 用 SessionStart 格式呼叫 console-log 登記 omp 紀錄路徑；herdr 回報紀錄路徑時也找得到該 session", async () => {
  const { ctx, file } = bridgeWorld();
  const seen = [];
  const pi = fakePi();
  bridge.createBridge(pi, { hookList: { sessionStart: [["node", path.join(root, "hooks", "console-log.mjs"), "session-start"]], stop: [], preEdit: [], preBash: [], post: [] }, run: async (argv, input) => (seen.push({ argv, input }), null) });
  await pi.handlers.session_start({}, ctx);
  assert.deepEqual(seen[0].argv.slice(-2), [path.join(root, "hooks", "console-log.mjs"), "session-start"]);
  assert.deepEqual(seen[0].input, { session_id: "01a1e800-0000-7000-8000-00000000ques", transcript_path: file, cwd: wt("proj-301-ask"), source: "startup", hook_event_name: "SessionStart" });
  const w = world([{ cwd: wt("proj-301-ask"), status: "idle", sample: "question" }]);
  const ref = w.state().agents[0].agent_session;
  assert.equal(ref.kind, "path");
  assert.equal(omp.sessionFile(ref), ref.value);
  const code = `const { herdrTerminals } = await import(${JSON.stringify(path.join(scripts, "herdr.mjs"))}); console.log(JSON.stringify([herdrTerminals.sessionOf("w1:p2"), herdrTerminals.agentOf("w1:p2")?.transcript]));`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...w.base } });
  assert.deepEqual(JSON.parse(res.stdout), [omp.sessionIdOf(ref.value), ref.value], res.stderr);
});

test("續命：omp 分頁停 50 分鐘照常送續命；快取命中數字讀 omp 紀錄的 cacheRead／cacheWrite", async () => {
  const { KEEPALIVE_TEXT } = await import("../hooks/keepalive-text.mjs");
  const keepalive = await import("../skills/worktree-console/scripts/keepalive.mjs");
  const dir = fs.mkdtempSync(path.join(tmp, "ka-"));
  const file = sample("keepalive", "/w", path.join(dir, "omp"), { keepalive: KEEPALIVE_TEXT });
  const entries = keepalive.entriesOf(file);
  assert.deepEqual(keepalive.keepaliveUsage(entries), { cacheRead: 41500, cacheWrite1h: 120, cacheWrite5m: 0, input: 30 });
  assert.deepEqual(keepalive.keepaliveReply(entries), { text: "好", tools: 0 });
  const stopAt = NOW - 51 * 60 * 1000;
  const session = { paneKey: "w1:p2", handle: "w1:p2", agent: { state: "done", stateStartedAt: stopAt, prompt: "做事" }, status: { kind: "waiting", text: "要選哪個？" } };
  const rows = [{ label: "PROJ-301", sessions: [session] }];
  const step = keepalive.keepaliveStep(rows, {}, NOW, { ratio: 0.4 });
  assert.deepEqual(step.actions.map((a) => [a.type, a.text]), [["keepalive", KEEPALIVE_TEXT]]);
});

test("交棒：omp 的 context 用量是 promptTokens 除以模型視窗；過門檻照既有流程寫交棒說明、開新分頁由 router 選後端並送 /goal set", async () => {
  const { measure, handoffRole } = await import("../hooks/auto-handoff.mjs");
  const ompEntry = (prompt) => ({ type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "進行中" }], model: "claude-sonnet-5-5", provider: "commandcode", stopReason: "stop", usage: { input: 10, cacheRead: prompt - 10, cacheWrite: 0, output: 1 }, contextSnapshot: { promptTokens: prompt } } });
  assert.deepEqual(measure(omp.claudeEntries([ompEntry(420_000)])), { used: 420_000, window: 1_000_000, percent: 42, model: "claude-sonnet-5-5" });
  assert.equal(handoffRole({ isConsole: true, goal: "x", cwd: "/a" }), "console");
  assert.equal(handoffRole({ isConsole: false, goal: "x", cwd: "/a", records: { "/a": { interview: true } } }), "implement");
  assert.equal(handoffRole({ isConsole: false, goal: null, cwd: "/a/sub", records: { "/a": { interview: true } } }), "interview");
  assert.equal(handoffRole({ isConsole: false, goal: null, cwd: "/b", records: {} }), "implement");

  const dir = fs.mkdtempSync(path.join(tmp, "ah-omp-"));
  const cwd = wt("proj-304-handoff");
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ panes: [{ pane_id: "w3:p1", tab_id: "w3:t1", workspace_id: "w3", cwd }], agents: [{ agent: "omp", name: "old", pane_id: "w3:p1", cwd, agent_status: "idle" }] }));
  const home = path.join(dir, "handoff");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ enabled: true, ratio: 0.4 }));
  const GOAL = "本次任務依 /x/goal.md 執行";
  const old = path.join(dir, "old.jsonl");
  fs.writeFileSync(old, [{ type: "session", version: 3, id: "old-1", timestamp: new Date().toISOString(), cwd }, { type: "message", id: "u1", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "做事" }] } }, ompEntry(450_000)].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const s = { sessionId: "old-1", file: old, goal: { condition: GOAL, met: false } };
  const consoleHome = path.join(dir, "console");
  process.env.WORKTREE_CONSOLE_HOME = consoleHome;
  const transcript = bridge.writeShadow(s);
  const usageFile = path.join(dir, "usage.json");
  fs.writeFileSync(usageFile, JSON.stringify({ at: Date.now(), rate_limits: { five_hour: { used_percentage: 96, resets_at: Math.round(Date.now() / 1000) + 3600 }, seven_day: { used_percentage: 5, resets_at: Math.round(Date.now() / 1000) + 86400 } } }));
  const env = { ...clean(), HERDR_ENV: "1", HERDR_PANE_ID: "w3:p1", HERDR_WORKSPACE_ID: "w3", HERDR_BIN: fakeHerdr, FAKE_HERDR_DIR: dir, FAKE_HERDR_TRANSCRIPTS: path.join(dir, "projects"), CLAUDE_PROJECTS_DIR: path.join(dir, "projects"), OMP_AGENT_DIR: path.join(dir, "omp"), OMP_BIN: "/nonexistent/omp", AUTO_HANDOFF_HOME: home, CLAUDE_CONFIG_DIR: path.join(dir, "claude"), WORKTREE_CONSOLE_HOME: consoleHome, WORKTREE_CONSOLE_USAGE: usageFile, AUTO_HANDOFF_POLL_MS: "10", AUTO_HANDOFF_DELIVER_MS: "2000", AUTO_HANDOFF_FIRST_TURN_MS: "2000", AUTO_HANDOFF_GOAL_MS: "2000" };
  const stop = () => spawnSync(process.execPath, [autoHandoff, "stop"], { input: JSON.stringify({ session_id: "old-1", transcript_path: transcript, cwd, permission_mode: "default", hook_event_name: "Stop", last_assistant_message: "進行中" }), encoding: "utf8", env });
  const first = JSON.parse(stop().stdout);
  assert.equal(first.decision, "block");
  assert.match(first.reason, /context 用量 45%（門檻 40%，上限 1,000,000 tokens）/);
  fs.mkdirSync(path.join(home, "notes"), { recursive: true });
  fs.writeFileSync(path.join(home, "notes", "old-1.md"), "# 交棒說明\n");
  const res = stop();
  assert.equal(res.stdout + res.stderr, "");
  const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const start = calls.find((c) => c[0] === "agent" && c[1] === "start");
  assert.equal(start[start.indexOf("--kind") + 1], "omp");
  assert.deepEqual(start.slice(start.indexOf("--") + 1, start.indexOf("--") + 5), ["--model", "commandcode/claude-sonnet-5-5", "-e", BRIDGE]);
  const sends = fs.readFileSync(path.join(dir, "sends.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.match(sends[0].text, /接手交棒/);
  assert.equal(sends[1].text, `/goal set ${GOAL}`);
  const event = JSON.parse(fs.readFileSync(path.join(home, "events", "old-1.json"), "utf8"));
  assert.equal(event.status, "done");
});

test("定稿交棒給 omp 實作 session：送 omp 的 /goal set <條件>，看到 Goal mode enabled 才關訪談分頁", () => {
  const w = world([{ agent: "claude", cwd: wt("proj-304-handoff"), status: "idle" }]);
  w.writeUsage(99, 99);
  const goalFile = path.join(w.dir, "goal.txt");
  fs.writeFileSync(goalFile, "/goal 本次任務依 /x/proj-304.md 執行\n");
  const res = w.run(["handoff", "--path", wt("proj-304-handoff"), "--from", "w1:p2", "--file", goalFile]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /已交棒執行/);
  assert.match(res.out, /omp＋Command Code Sonnet 5\.5/);
  const goal = w.sends().find((s) => s.text.startsWith("/goal"));
  assert.equal(goal.text, "/goal set 本次任務依 /x/proj-304.md 執行");
  assert.equal(w.state().panes.some((p) => p.pane_id === "w1:p2"), false, "訪談分頁關掉");
  const start = w.calls().find((c) => c[0] === "agent" && c[1] === "start");
  assert.equal(start[start.indexOf("--kind") + 1], "omp");
});
