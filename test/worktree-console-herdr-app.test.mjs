import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectDir } from "../skills/worktree-console/scripts/lib.mjs";
import { UNSUPPORTED, terminalKind, terminals } from "../skills/worktree-console/scripts/terminals.mjs";
import { evaluate, conclusionLines, renderHtml } from "../skills/worktree-console/scripts/herdr-report.mjs";
import { terminalOf } from "../hooks/auto-handoff.mjs";
import { boardView, clock, waited } from "../herdr-app/mods/worktree-board/board.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills", "worktree-console", "scripts");
const fixtures = path.join(root, "test", "fixtures", "worktree-console");
const fakeHc = path.join(fixtures, "fake-hc.mjs");
const fakeApp = path.join(fixtures, "fake-herdr-app.mjs");
const consoleLog = path.join(root, "hooks", "console-log.mjs");
const autoHandoff = path.join(root, "hooks", "auto-handoff.mjs");
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORCA_|HERDR_|HC_|AUTO_HANDOFF_|CLAUDE_CODE_SESSION_ID)/.test(k)));

let tmp;
const app = () => path.join(tmp, "app");
const wt = (name) => path.join(tmp, "wt", name);
const MENU = [{ question: "要用哪個色？", header: "顏色", options: [{ label: "紅 (Recommended)", description: "暖" }, { label: "藍", description: "冷" }], multiSelect: false }];

function sh(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-herdr-app-")));
  sh(tmp, "init", "--bare", "-b", "main", "remote.git");
  sh(tmp, "clone", "-q", "remote.git", "app");
  fs.writeFileSync(path.join(app(), "README.md"), "hi\n");
  sh(app(), "add", ".");
  sh(app(), "commit", "-qm", "init");
  sh(app(), "push", "-q", "origin", "main");
  for (const name of ["proj-201-menu", "proj-202-perm", "proj-203-busy", "proj-204-done", "proj-205-idle"]) sh(app(), "worktree", "add", "-q", "-b", `feat/${name}`, wt(name), "main");
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ts = (n) => new Date(Date.UTC(2026, 9, 31, 6, 0, n)).toISOString();
const user = (text, n = 0) => ({ type: "user", timestamp: ts(n), message: { role: "user", content: text } });
const said = (text, n = 1, stop = "end_turn") => ({ type: "assistant", timestamp: ts(n), message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] } });
const call = (id, name, input, n = 1) => ({ type: "assistant", timestamp: ts(n), message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] } });
const result = (id, n = 2) => ({ type: "user", timestamp: ts(n), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

// A Herdr app with the console as t1 in the "console" space and one claude tab per agent in the "app" space;
// `session` is the id the console started that tab with.
function world(agents, { transcripts = {}, screens = {}, spaces = null, focus = { space: "sp0", tab: "tb0", pane: "pa1" } } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "fake-"));
  const home = path.join(dir, "home");
  const projects = path.join(dir, "projects");
  const state = {
    seq: 100,
    focus,
    terminals: { t1: { cwd: app(), status: "working", agent: "claude-code" } },
    spaces: spaces ?? [
      { id: "sp0", name: "console", folder: app(), tabs: [{ id: "tb0", name: "console", terminals: [{ terminal: "t1", pane: "pa1", name: null }] }] },
      { id: "sp1", name: "app", folder: app(), tabs: [] },
    ],
  };
  const sessions = {};
  agents.forEach((a, i) => {
    const address = a.terminal ?? `t${i + 2}`;
    state.terminals[address] = { cwd: a.cwd, status: a.status, agent: "claude-code", session: a.session ?? null };
    const space = state.spaces.find((s) => s.id === (a.space ?? "sp1"));
    const tab = a.tab ? space.tabs.find((t) => t.id === a.tab) : null;
    if (tab) tab.terminals.push({ terminal: address, pane: `pa${address}`, name: null });
    else space.tabs.push({ id: a.tab ?? `tb${address}`, name: a.name ?? path.basename(a.cwd), terminals: [{ terminal: address, pane: `pa${address}`, name: null }] });
    if (a.session) sessions[address] = { sessionId: a.session, cwd: a.cwd };
  });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "herdr-app-sessions.json"), JSON.stringify(sessions));
  for (const [session, { cwd, entries }] of Object.entries(transcripts)) {
    const prev = process.env.CLAUDE_PROJECTS_DIR;
    process.env.CLAUDE_PROJECTS_DIR = projects;
    const file = path.join(claudeProjectDir(cwd), `${session}.jsonl`);
    process.env.CLAUDE_PROJECTS_DIR = prev;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  for (const [t, lines] of Object.entries(screens)) fs.writeFileSync(path.join(dir, `screen-${t}.txt`), lines.join("\n") + "\n");
  const base = {
    ...clean(),
    HC_TERMINAL_ID: "t1",
    HC_SCOPE: "scope",
    HC_BIN: fakeHc,
    HERDR_APP_BIN: fakeApp,
    FAKE_HERDR_APP_DIR: dir,
    HERDR_APP_HOME: path.join(dir, "app-home"),
    HERDR_APP_WORKTREES: path.join(dir, "worktrees"),
    HERDR_APP_POLL_MS: "5",
    HERDR_APP_CLOSE_MS: "300",
    WORKTREE_CONSOLE_HOME: home,
    WORKTREE_CONSOLE_LOG_DIR: path.join(dir, "log"),
    CLAUDE_PROJECTS_DIR: projects,
    ANSWER_KEY_DELAY_MS: "0",
    SECURITY_BIN: "/usr/bin/false",
    AWAIT_INTERVAL_MS: "10",
    SEND_CHECK_MS: "0",
    SEND_CHECK_TRIES: "1",
    HERDR_GRACE_MS: "0",
  };
  const run = (args, extra = {}) => {
    const res = spawnSync(process.execPath, [path.join(scripts, "console.mjs"), ...args], { encoding: "utf8", env: { ...base, ...extra } });
    return { code: res.status, out: res.stdout.trim(), err: res.stderr };
  };
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const stateNow = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const save = (s) => fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(s));
  const events = () => {
    const log = path.join(dir, "log");
    return fs.existsSync(log) ? fs.readdirSync(log).filter((f) => f.endsWith(".jsonl")).flatMap((f) => lines(path.join(log, f))) : [];
  };
  return {
    dir,
    home,
    base,
    run,
    state: stateNow,
    save,
    events,
    calls: () => lines(path.join(dir, "calls.log")),
    sends: () => lines(path.join(dir, "sends.jsonl")),
    audit: () => lines(path.join(home, "herdr-audit.jsonl")),
  };
}

const appDo = (w, command) => w.calls().filter((c) => c[0] === "herdr-app" && c[1] === "do" && c[2] === command).map((c) => JSON.parse(c[3]));
const tabsOf = (w) => w.state().spaces.flatMap((s) => s.tabs.map((t) => ({ space: s.name, ...t })));
const PROMPT_SCREEN = ["⏺ Bash(mkdir -p /tmp/x)", "────────────────────────────", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Tab to amend"];

// One session in each of the five states, as hc reports them and their transcripts tell.
function five() {
  return world(
    [
      { cwd: wt("proj-201-menu"), status: "blocked", session: "s-menu", name: "PROJ-201" },
      { cwd: wt("proj-202-perm"), status: "blocked", session: "s-perm", name: "PROJ-202" },
      { cwd: wt("proj-203-busy"), status: "working", session: "s-busy", name: "PROJ-203" },
      { cwd: wt("proj-204-done"), status: "done", session: "s-done", name: "PROJ-204" },
      { cwd: wt("proj-205-idle"), status: "idle", session: "s-idle", name: "PROJ-205" },
    ],
    {
      transcripts: {
        "s-menu": { cwd: wt("proj-201-menu"), entries: [user("挑顏色"), call("t1", "AskUserQuestion", { questions: MENU })] },
        "s-perm": { cwd: wt("proj-202-perm"), entries: [user("建資料夾"), call("t2", "Bash", { command: "mkdir -p /tmp/x", description: "建資料夾" })] },
        "s-busy": { cwd: wt("proj-203-busy"), entries: [user("跑測試"), call("t3", "Bash", { command: "npm test" })] },
        "s-done": { cwd: wt("proj-204-done"), entries: [user("改登入頁"), said("登入頁改好了。", 1), call("t4", "Bash", { command: "npm test" }, 2), result("t4", 3), said("測試也全過。", 4)] },
      },
      screens: { t3: PROMPT_SCREEN },
    },
  );
}

test("偵測規則：只有 HC_TERMINAL_ID 是 Herdr app；同時有 HERDR_ENV=1 是舊 herdr；只有 ORCA_TERMINAL_HANDLE 是 Orca；都沒有報不支援並列出三種工具", () => {
  assert.equal(terminalKind({ HC_TERMINAL_ID: "t3" }), "herdr-app");
  assert.equal(terminalKind({ HC_TERMINAL_ID: "t3", HERDR_ENV: "1" }), "herdr");
  assert.equal(terminalKind({ ORCA_TERMINAL_HANDLE: "term_x" }), "orca");
  assert.equal(terminalKind({ HC_TERMINAL_ID: "t3", ORCA_TERMINAL_HANDLE: "term_x" }), "herdr-app");
  assert.equal(terminalKind({}), null);
  assert.equal(terminals({ HC_TERMINAL_ID: "t3" }).name, "herdr-app");
  assert.throws(() => terminals({}), (e) => e.unsupported && e.message === UNSUPPORTED);
  for (const tool of ["Orca", "herdr", "Herdr app"]) assert.ok(UNSUPPORTED.includes(tool), tool);
  const w = world([]);
  const none = w.run(["board", "--repo", app()], { HC_TERMINAL_ID: "" });
  assert.equal(none.code, 1);
  assert.equal(none.out, UNSUPPORTED);
  assert.deepEqual(w.calls(), [], "不支援時不碰 hc 與 herdr-app");
});

test("在 Herdr app 裡但 Herdr app 沒開（hc 或 herdr-app 叫不到）：報 herdr-app-unreachable，不改用別的工具", () => {
  const w = world([]);
  for (const env of [{ FAKE_HERDR_APP_FAIL: "1" }, { FAKE_HC_FAIL: "1" }]) {
    const res = w.run(["board", "--repo", app()], { ...env, ORCA_TERMINAL_HANDLE: "term_self" });
    assert.equal(res.code, 1);
    assert.equal(res.out, "[console] herdr-app-unreachable");
  }
});

test("hook 也認得 Herdr app：auto-handoff 的 terminalOf 依 HC_TERMINAL_ID，舊 herdr 與 Orca 照舊", () => {
  assert.deepEqual(terminalOf({ HC_TERMINAL_ID: "t7" }), { kind: "herdr-app", handle: "t7", paneKey: "hc:t7" });
  assert.equal(terminalOf({ HC_TERMINAL_ID: "t7", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" }).kind, "herdr");
  assert.equal(terminalOf({ ORCA_TERMINAL_HANDLE: "term_x" }).kind, "orca");
  assert.equal(terminalOf({}), null);
});

test("console-log hook 在 Herdr app 用 HC_TERMINAL_ID 登記分頁與 session", () => {
  const w = five();
  w.run(["board", "--repo", app()]);
  const run = (command, input, env = {}) => spawnSync(process.execPath, [consoleLog, command], { input: JSON.stringify(input), encoding: "utf8", env: { ...w.base, HC_TERMINAL_ID: "t2", ...env } });
  run("session-start", { session_id: "sid-1", transcript_path: "/x/sid-1.jsonl", cwd: wt("proj-201-menu"), source: "startup" });
  run("user-prompt", { session_id: "sid-1", cwd: wt("proj-201-menu"), prompt: "繼續" });
  const session = w.events().find((e) => e.event === "session");
  assert.deepEqual([session.handle, session.paneKey, session.ticket, session.transcript], ["t2", "hc:t2", "PROJ-201", "/x/sid-1.jsonl"]);
  assert.equal(w.events().find((e) => e.event === "prompt").text, "繼續");
  assert.equal(run("user-prompt", { cwd: wt("proj-201-menu"), prompt: "x" }, { HC_TERMINAL_ID: "" }).stdout, "");
});

test("看板五種狀態：blocked 依對話紀錄分成 💬 選單與 🔐 授權，working 是 🔄，done 是 ⏸，沒下過指令的 idle 是 💤；每次讀都記一筆 Herdr app 的對照紀錄", () => {
  const w = five();
  const res = w.run(["board", "--repo", app()]);
  assert.equal(res.code, 0, res.out + res.err);
  const row = (tag) => res.out.split("\n").find((l) => l.includes(`| ${tag} |`)) ?? "";
  assert.match(row("PROJ-201"), /💬 等待回應.*要用哪個色？/);
  assert.match(row("PROJ-202"), /🔐 等待授權.*Bash mkdir -p \/tmp\/x/);
  assert.match(row("PROJ-203"), /🔄 執行中/);
  assert.match(row("PROJ-204"), /⏸ 回覆完畢.*測試也全過。/);
  assert.match(res.out, /閒置 1 個/);
  const reads = w.audit().filter((e) => e.event === "read");
  assert.equal(reads.length, 5);
  assert.ok(reads.every((e) => e.terminal === "herdr-app"));
  const byTicket = Object.fromEntries(reads.map((e) => [e.ticket, e]));
  assert.deepEqual([byTicket["PROJ-201"].herdr, byTicket["PROJ-201"].shown], ["blocked", "waiting"]);
  assert.deepEqual([byTicket["PROJ-202"].herdr, byTicket["PROJ-202"].shown], ["blocked", "permission"]);
  assert.equal(w.calls().some((c) => c[0] === "hc" && c[1] === "send"), false, "讀看板不送任何字");
});

test("讀看板時寫出看板 mod 的狀態檔並把 mod 放進 Herdr app 的 mods 資料夾，.board-path 指向狀態檔", () => {
  const w = five();
  w.run(["board", "--repo", app()]);
  const state = JSON.parse(fs.readFileSync(path.join(w.home, "herdr-app-board.json"), "utf8"));
  assert.ok(Date.now() - state.at < 60_000);
  assert.deepEqual(Object.fromEntries(state.rows.map((r) => [r.tag, [r.repo, r.kind, r.terminal, r.stage, r.activity]])), {
    "PROJ-201": ["app", "waiting", "t2", "未開工", "要用哪個色？"],
    "PROJ-202": ["app", "permission", "t3", "未開工", "Bash mkdir -p /tmp/x"],
    "PROJ-203": ["app", "busy", "t4", "未開工", "跑測試"],
    "PROJ-204": ["app", "done", "t5", "未開工", "測試也全過。"],
    "PROJ-205": ["app", "idle", "t6", "未開工", "—"],
  }, "階段與最後動態和中控台看板同一套算法");
  const mod = path.join(w.base.HERDR_APP_HOME, "mods", "worktree-board");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mod, "mod.json"), "utf8")), { place: "none", title: "worktree 看板" });
  assert.equal(fs.readFileSync(path.join(mod, ".board-path"), "utf8"), path.join(w.home, "herdr-app-board.json"));
  for (const f of ["main.js", "board.js"]) assert.equal(fs.readFileSync(path.join(mod, f), "utf8"), fs.readFileSync(path.join(root, "herdr-app", "mods", "worktree-board", f), "utf8"));
});

test("中控台的分頁右側切出看板 pane：中控台自己讀狀態（board）時切一次、同一個分頁不再切、焦點留在中控台；其他指令讀狀態不切", () => {
  const w = five();
  const splits = () => appDo(w, "pane.split");
  w.run(["detail", "--repo", app(), "PROJ-204"]);
  assert.deepEqual(splits(), [], "不是中控台自己的讀取就不切");
  w.run(["board", "--repo", app()]);
  assert.deepEqual(splits(), [{ direction: "right", pane: "pa1", mod: "worktree-board" }]);
  const tab = w.state().spaces[0].tabs[0];
  assert.deepEqual(tab.mods.map((m) => m.mod), ["worktree-board"]);
  assert.equal(w.state().focus.pane, "pa1", "切完焦點回到中控台的 pane");
  assert.ok(fs.existsSync(path.join(w.base.HERDR_APP_HOME, "mods", "worktree-board", "main.js")), "先放好 mod 再切");
  w.run(["board", "--repo", app()]);
  assert.equal(splits().length, 1, "同一個分頁只切一次");
  const s = w.state();
  s.spaces[0].tabs.push({ id: "tb9", name: "console", terminals: [{ terminal: "t1", pane: "pa9" }] });
  s.spaces[0].tabs.shift();
  w.save(s);
  w.run(["board", "--repo", app()]);
  assert.deepEqual(splits().at(-1), { direction: "right", pane: "pa9", mod: "worktree-board" }, "中控台換到新分頁（交棒）就在新分頁再切一次");
});

test("看板 mod：每列是圖示、代號、階段、等待時間加一行最後動態；💬／🔐／⚠️ 排在 🔄／⏸／💤 前面，同狀態等最久的在上", () => {
  const now = Date.UTC(2026, 9, 31, 12, 0, 0);
  const min = 60_000;
  const view = boardView(
    {
      at: now - 10_000,
      rows: [
        { tag: "idle", kind: "idle", since: null, terminal: "t9" },
        { tag: "busy", kind: "busy", since: now - 5 * min, terminal: "t2" },
        { tag: "ask-new", kind: "waiting", since: now - 2 * min, terminal: "t3" },
        { tag: "done", kind: "done", since: now - 90 * min, terminal: "t4" },
        { tag: "perm", kind: "permission", since: now - 30_000, terminal: "t5" },
        { tag: "ask-old", kind: "waiting", since: now - 45 * min, terminal: "t6" },
        { tag: "lost", kind: "anomaly", since: now - 3 * 86_400_000, terminal: "t7" },
      ],
    },
    now,
  );
  assert.deepEqual(
    view.rows.map((r) => [r.icon, r.tag, r.wait]),
    [
      ["⚠️", "lost", "3d"],
      ["🔐", "perm", "<1m"],
      ["💬", "ask-old", "45m"],
      ["💬", "ask-new", "2m"],
      ["🔄", "busy", "5m"],
      ["⏸", "done", "1h"],
      ["💤", "idle", ""],
    ],
  );
  const asking = new Set(["⚠️", "🔐", "💬"]);
  const firstCalm = view.rows.findIndex((r) => !asking.has(r.icon));
  assert.ok(view.rows.slice(firstCalm).every((r) => !asking.has(r.icon)), "要處理的全部在前面");
  assert.deepEqual([view.stale, view.note], [false, null]);
  assert.equal(waited(now - 59_000, now), "<1m");
  const one = boardView({ at: now, rows: [{ repo: "app", tag: "PROJ-1", kind: "waiting", stage: "實作中", activity: "要不要 push？", since: now, terminal: "t2" }, { repo: "app", tag: "PROJ-2", kind: "done", stage: "未開工", activity: "—", since: now, terminal: "t3" }] }, now);
  assert.deepEqual(one.rows.map((r) => [r.tag, r.stage, r.activity]), [["PROJ-1", "實作中", "要不要 push？"], ["PROJ-2", "未開工", ""]], "最後動態是 — 時不畫第二行");
  const main = fs.readFileSync(path.join(root, "herdr-app", "mods", "worktree-board", "main.js"), "utf8");
  assert.match(main, /child\(r\.stage\)/);
  assert.match(main, /child\(r\.activity\)/);
});

test("看板 mod：依 repo 分組，組的順序跟著組裡最需要處理的那一列，所以等你處理的仍排最上面", () => {
  const now = Date.UTC(2026, 9, 31, 12, 0, 0);
  const view = boardView(
    {
      at: now,
      rows: [
        { repo: "web", tag: "w-busy", kind: "busy", since: now - 60_000, terminal: "t2" },
        { repo: "api", tag: "a-done", kind: "done", since: now - 60_000, terminal: "t3" },
        { repo: "api", tag: "a-perm", kind: "permission", since: now - 60_000, terminal: "t4" },
        { repo: "web", tag: "w-ask", kind: "waiting", since: now - 60_000, terminal: "t5" },
        { repo: "web", tag: "w-idle", kind: "idle", since: null, terminal: "t6" },
      ],
    },
    now,
  );
  assert.deepEqual(view.groups.map((g) => [g.repo, g.rows.map((r) => r.tag)]), [
    ["api", ["a-perm", "a-done"]],
    ["web", ["w-ask", "w-busy", "w-idle"]],
  ]);
  assert.deepEqual(view.rows.map((r) => r.tag), ["a-perm", "a-done", "w-ask", "w-busy", "w-idle"]);
});

test("看板 mod：狀態檔超過 2 分鐘沒更新就標「中控台未在執行，資料停在 HH:MM」並把列表變灰；沒有狀態檔也說明", () => {
  const at = new Date(2026, 9, 31, 9, 5, 0).getTime();
  const rows = [{ tag: "PROJ-1", kind: "waiting", since: at - 60_000, terminal: "t2" }];
  assert.deepEqual([boardView({ at, rows }, at + 119_000).stale, boardView({ at, rows }, at + 119_000).note], [false, null]);
  const old = boardView({ at, rows }, at + 121_000);
  assert.equal(old.stale, true);
  assert.equal(old.note, "中控台未在執行，資料停在 09:05");
  assert.equal(clock(at), "09:05");
  assert.deepEqual(old.rows.map((r) => r.tag), ["PROJ-1"], "過期仍列出最後的資料");
  const none = boardView(null, at);
  assert.deepEqual([none.stale, none.note, none.rows], [true, "中控台還沒寫入資料", []]);
  const main = fs.readFileSync(path.join(root, "herdr-app", "mods", "worktree-board", "main.js"), "utf8");
  assert.match(main, /when\(view\.stale, \(el\) => el\.opacity\(/, "過期時每列變淡");
  assert.match(main, /run\("tab\.select", \{ id: a\.tab \}\)/, "點列切到該子 session 的分頁");
});

test("開工（暱稱、不帶票）：worktree 開在 Herdr app 的 ~/.herdr/worktrees/<repo>/<branch>、在 repo 同名 space 開有名稱的分頁、首則指令不帶中控台位址送達；焦點留在中控台", () => {
  const w = world([]);
  const res = w.run(["start", "--repo", app(), "--branch", "feat/login-page", "--name", "login", "--", "login：做登入頁"]);
  assert.equal(res.code, 0, res.out + res.err);
  const target = path.join(w.base.HERDR_APP_WORKTREES, "app", "feat-login-page");
  const [made] = appDo(w, "tab.new");
  assert.match(res.out, new RegExp(`^worktree: ${fs.realpathSync(target)}\\nterminal: t\\d+$`));
  const terminal = res.out.split("terminal: ")[1];
  assert.equal(sh(target, "branch", "--show-current"), "feat/login-page");
  assert.equal(made.space, "sp1", "放進名稱等於 repo 的 space");
  assert.equal(made.name, "login");
  assert.equal(made.folder, fs.realpathSync(target));
  assert.deepEqual(made.argv.slice(0, 4), ["claude", "--name", "login", "--session-id"]);
  assert.match(made.argv[4], /^[0-9a-f-]{36}$/);
  assert.deepEqual(w.sends().map((s) => [s.via, s.terminal, s.text, s.from]), [["send", terminal, "login：做登入頁", null]]);
  assert.deepEqual(w.state().focus, { space: "sp0", tab: "tb0" }, "開完切回中控台的分頁");
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.home, "herdr-app-sessions.json"), "utf8"))[terminal].sessionId, made.argv[4]);
  const record = JSON.parse(fs.readFileSync(path.join(w.home, "herdr-worktrees.json"), "utf8"))[fs.realpathSync(target)];
  assert.deepEqual([record.ticket, record.displayName], [null, "login"]);
  const board = w.run(["board", "--repo", app()]).out;
  assert.match(board, /\| login \|/);

  const bare = world([], { spaces: [{ id: "sp0", name: "console", folder: app(), tabs: [{ id: "tb0", name: "console", terminals: [{ terminal: "t1", pane: "pa1" }] }] }] });
  const fresh = bare.run(["start", "--repo", app(), "--branch", "feat/other", "--name", "other", "--", "other 開工"]);
  assert.equal(fresh.code, 0, fresh.out);
  const [space] = appDo(bare, "space.new");
  assert.deepEqual([space.name, space.tab], ["app", "other"], "沒有 repo 同名的 space 就新開一個並命名");
});

test("開工：新分頁一直沒就緒（例如卡在信任資料夾）就回報並附 hc read 指令，不送首則指令", () => {
  const w = world([]);
  const res = w.run(["start", "--repo", app(), "--branch", "feat/stuck", "--name", "stuck", "--", "做事"], { FAKE_HC_NOT_READY: "1" });
  assert.equal(res.code, 1);
  assert.match(res.out, /\[stuck\] 未開工：新分頁沒就緒（timeout），用 `hc read t\d+` 看畫面/);
  assert.deepEqual(w.sends(), []);
});

test("詳情與指揮：詳情是上一則指令之後說的全部文字；send 走 hc send 且不帶中控台位址；blocked 時文字被擋就回未送達", () => {
  const w = five();
  const detail = w.run(["detail", "--repo", app(), "PROJ-204"]);
  assert.equal(detail.code, 0, detail.out);
  assert.match(detail.out, /登入頁改好了。[\s\S]*測試也全過。/);
  const sent = w.run(["send", "--terminal", "t6", "--tag", "PROJ-205", "--", "/rename PROJ-205"]);
  assert.match(sent.out, /^\[PROJ-205\] /);
  assert.deepEqual(w.sends().at(-1), { via: "send", terminal: "t6", text: "/rename PROJ-205", from: null });
  const blocked = w.run(["send", "--terminal", "t3", "--tag", "PROJ-202", "--", "hi"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /\[PROJ-202\] 未送達：送出失敗：blocked/);
});

test("代答：選單回 b 按 2、其他：<文字> 按「其他」再用 hc send --force 送字、授權允許按 1、拒絕按 Esc", () => {
  const w = five();
  assert.equal(w.run(["answer", "--repo", app(), "PROJ-201", "b"], { FAKE_HC_UNBLOCK: "1" }).out, "[PROJ-201] 已選擇：顏色→藍");
  assert.equal(w.run(["answer", "--repo", app(), "PROJ-202", "允許"], { FAKE_HC_UNBLOCK: "1" }).out, "[PROJ-202] 已允許");
  assert.deepEqual(w.sends().map((s) => [s.via, s.terminal, s.keys?.join(" ")]), [["keys", "t2", "2"], ["keys", "t3", "1"]]);
  const other = five();
  assert.equal(other.run(["answer", "--repo", app(), "PROJ-201", "其他：綠色"], { FAKE_HC_UNBLOCK: "1" }).out, "[PROJ-201] 已選擇：顏色→其他「綠色」");
  assert.deepEqual(other.sends().map((s) => [s.via, s.keys?.join(" ") ?? s.text, s.from ?? null]), [["keys", "3", null], ["force", "綠色", null]]);
  const deny = five();
  deny.run(["answer", "--repo", app(), "PROJ-202", "拒絕"], { FAKE_HC_UNBLOCK: "1" });
  assert.deepEqual(deny.sends().at(-1).keys, ["esc"]);
});

test("關閉：關掉該 worktree 的分頁（不關中控台自己的）、移除 worktree 與自記紀錄，branch 保留；和別的終端機同分頁時只關它的 pane", () => {
  const w = world([]);
  w.run(["start", "--repo", app(), "--branch", "feat/close-me", "--name", "closeme", "--", "做"]);
  const target = fs.realpathSync(path.join(w.base.HERDR_APP_WORKTREES, "app", "feat-close-me"));
  const s = w.state();
  for (const [k, t] of Object.entries(s.terminals)) if (k !== "t1") t.status = "idle";
  w.save(s);
  const res = w.run(["close", "--path", target]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(res.out, "[closeme] 已關閉：worktree 已移除，branch feat/close-me 保留");
  assert.equal(fs.existsSync(target), false);
  assert.equal(appDo(w, "tab.close").length, 1);
  assert.ok(w.state().terminals.t1, "中控台自己的分頁不關");
  assert.equal(tabsOf(w).some((t) => t.name === "closeme"), false);
  assert.equal(target in JSON.parse(fs.readFileSync(path.join(w.home, "herdr-worktrees.json"), "utf8")), false);
  assert.equal(sh(app(), "branch", "--list", "feat/close-me"), "feat/close-me");
  assert.doesNotMatch(sh(app(), "worktree", "list"), /feat-close-me/);

  const shared = world([
    { cwd: wt("proj-205-idle"), status: "idle", session: "a", name: "mix", tab: "tbmix" },
    { cwd: app(), status: "idle", terminal: "t9", tab: "tbmix" },
  ]);
  const s2 = shared.state();
  s2.spaces[1].tabs = [{ id: "tbmix", name: "mix", terminals: [{ terminal: "t2", pane: "pat2" }, { terminal: "t9", pane: "pat9" }] }];
  s2.terminals.t1.cwd = wt("proj-205-idle");
  shared.save(s2);
  const herdrApp = spawnSync(process.execPath, ["-e", `import("${path.join(scripts, "terminals.mjs")}").then(m => console.log(JSON.stringify(m.terminals().closeWorktree("${wt("proj-205-idle")}"))))`], { encoding: "utf8", env: shared.base });
  assert.equal(JSON.parse(herdrApp.stdout).ok, true, herdrApp.stderr);
  assert.deepEqual(appDo(shared, "pane.close"), [{ pane: "pat2" }]);
  assert.deepEqual(appDo(shared, "tab.close"), []);
  assert.deepEqual(tabsOf(shared).find((t) => t.id === "tbmix").terminals.map((t) => t.terminal), ["t9"]);
  assert.ok(shared.state().terminals.t1, "中控台在同一個 worktree 裡也不關自己");
});

test("需求訪談交棒：同一個 repo space 開新分頁送 /goal、看到 Goal set 才關訪談分頁；被收成貼上內容就保留訪談分頁", () => {
  const goal = (w) => {
    const file = path.join(w.dir, "goal.txt");
    fs.writeFileSync(file, "/goal 做完 PROJ-204");
    return file;
  };
  const w = five();
  const res = w.run(["handoff", "--path", wt("proj-204-done"), "--from", "t5", "--file", goal(w)]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(res.out, "[PROJ-204] 已交棒執行");
  assert.equal(w.state().terminals.t5, undefined, "訪談分頁已關");
  const sent = w.sends().find((s) => s.text?.startsWith("/goal"));
  assert.deepEqual([sent.via, sent.from], ["send", null]);
  assert.equal(appDo(w, "tab.new")[0].space, "sp1");
  const event = w.events().find((e) => e.event === "handoff");
  assert.deepEqual([event.terminal, event.ok], ["herdr-app", true]);

  const p = five();
  const pasted = p.run(["handoff", "--path", wt("proj-204-done"), "--from", "t5", "--file", goal(p)], { FAKE_HC_PASTE: "1" });
  assert.equal(pasted.code, 1);
  assert.match(pasted.out, /交棒失敗：被當成貼上內容收起/);
  assert.ok(p.state().terminals.t5, "訪談分頁保留");
});

test("搬 session：到另一個 space 開新分頁 --resume 同一段對話、接上後才關舊分頁；新分頁沒就緒就保留舊分頁；--to 不存在就拒絕", () => {
  const spaces = () => [
    { id: "sp0", name: "console", folder: app(), tabs: [{ id: "tb0", name: "console", terminals: [{ terminal: "t1", pane: "pa1" }] }] },
    { id: "sp1", name: "app", folder: app(), tabs: [] },
    { id: "sp2", name: "side", folder: app(), tabs: [] },
  ];
  const DONE = { cwd: wt("proj-204-done"), entries: [user("改"), said("改好了，搬家前最後一則。")] };
  const w = world([{ cwd: wt("proj-204-done"), status: "done", session: "s-done", name: "PROJ-204" }], { transcripts: { "s-done": DONE }, spaces: spaces() });
  const res = w.run(["move", "--repo", app(), "PROJ-204", "--to", "side"], { MOVE_CHECK_MS: "0" });
  assert.equal(res.code, 0, res.out + res.err);
  const [made] = appDo(w, "tab.new");
  assert.equal(made.space, "sp2");
  assert.deepEqual(made.argv, ["claude", "--name", "PROJ-204", "--resume", "s-done"]);
  const fresh = res.out.match(/新分頁 (t\d+)/)[1];
  assert.equal(res.out, `[PROJ-204] 已搬到工作區「side」：新分頁 ${fresh}，舊分頁 t2 已關`);
  assert.equal(w.state().terminals.t2, undefined);
  const reg = w.events().find((e) => e.event === "session" && e.handle === fresh);
  assert.deepEqual([reg.sessionId, reg.paneKey, reg.source], ["s-done", `hc:${fresh}`, "move"]);
  assert.match(w.run(["board", "--repo", app()]).out, /\| ⏸ 回覆完畢 \| PROJ-204 \|[^\n]*搬家前最後一則/);

  const stuck = world([{ cwd: wt("proj-204-done"), status: "done", session: "s-done", name: "PROJ-204" }], { transcripts: { "s-done": DONE }, spaces: spaces() });
  const failed = stuck.run(["move", "--repo", app(), "PROJ-204", "--to", "side"], { FAKE_HC_NOT_READY: "1" });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /^\[PROJ-204\] 未搬：新分頁沒就緒（timeout），舊分頁保留$/);
  assert.ok(stuck.state().terminals.t2, "舊分頁保留");

  const typo = world([{ cwd: wt("proj-204-done"), status: "done", session: "s-done", name: "PROJ-204" }], { transcripts: { "s-done": DONE }, spaces: spaces() });
  assert.equal(typo.run(["move", "--repo", app(), "PROJ-204", "--to", "nope"]).out, "[PROJ-204] 未搬：沒有叫「nope」的工作區");
  assert.deepEqual(appDo(typo, "tab.new"), []);
});

test("misjudge 記成 Herdr app 的人工誤判；herdr-report 把舊 herdr 與 Herdr app 的讀取次數與誤判分開列出", () => {
  const w = five();
  w.run(["board", "--repo", app()]);
  const res = w.run(["misjudge", "--repo", app(), "PROJ-204", "其實在等我授權"]);
  assert.equal(res.out, "[PROJ-204] 已記下誤判：看板顯示 ⏸ 回覆完畢，實際是「其實在等我授權」");
  const m = w.audit().find((e) => e.event === "misjudge");
  assert.deepEqual([m.terminal, m.shown, m.herdr, m.actualKind], ["herdr-app", "done", "done", "permission"]);

  const read = (extra) => ({ ts: ts(0), event: "read", herdr: "working", shown: "busy", inferred: "busy", mismatch: false, ticket: "T", ...extra });
  const audit = [
    ...Array.from({ length: 3 }, () => read({})),
    read({ herdr: "unknown", shown: "anomaly", inferred: "unknown", mismatch: true }),
    ...Array.from({ length: 6 }, () => read({ terminal: "herdr-app" })),
    { ts: ts(1), event: "misjudge", terminal: "herdr", ticket: "M1", shown: "permission", actualKind: "busy", actual: "在跑" },
    { ts: ts(1), event: "misjudge", terminal: "herdr-app", ticket: "M2", shown: "done", actualKind: "waiting", actual: "在等我回答" },
  ];
  const r = evaluate({ audit, events: [] });
  assert.deepEqual(
    r.sources.map((x) => [x.name, x.reads, x.anomaly, x.misjudges, x.missed]),
    [
      ["舊 herdr", 4, 1, 1, 0],
      ["Herdr app", 6, 0, 1, 1],
    ],
  );
  const lines = conclusionLines(r);
  assert.ok(lines.includes("舊 herdr：讀取 4 次、session 異常 1 次（25.0%）、人工誤判 1 筆（該叫沒叫 0 筆）"), lines.join("\n"));
  assert.ok(lines.includes("Herdr app：讀取 6 次、session 異常 0 次（0.0%）、人工誤判 1 筆（該叫沒叫 1 筆）"), lines.join("\n"));
  const html = renderHtml(r);
  assert.match(html, /舊 herdr 與 Herdr app 分開看/);
  assert.match(html, /<td>Herdr app<\/td><td>6<\/td>/);
  assert.match(html, /<td>Herdr app<\/td><td>M2<\/td><td>⏸ 回覆完畢<\/td>/);

  const out = path.join(w.dir, "report.html");
  const cmd = w.run(["herdr-report", "--out", out], { HC_TERMINAL_ID: "" });
  assert.equal(cmd.code, 0, cmd.out);
  assert.match(cmd.out, new RegExp(`Herdr app：讀取 ${w.audit().filter((e) => e.event === "read").length} 次`));
  assert.match(cmd.out, /舊 herdr：讀取 0 次/);
});

// The auto-handoff Stop hook in a Herdr app tab: t5 hands over to a new tab in its own space.
function handoffWorld({ goal = "完成 X" } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "ah-"));
  const projects = path.join(dir, "projects");
  const state = {
    seq: 100,
    focus: { space: "sp1", tab: "tb5" },
    terminals: { t5: { cwd: app(), status: "working", agent: "claude-code" } },
    spaces: [{ id: "sp1", name: "app", folder: app(), tabs: [{ id: "tb5", name: "PROJ-9", terminals: [{ terminal: "t5", pane: "pa5" }] }] }],
  };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  const home = path.join(dir, "handoff");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ enabled: true, ratio: 0.4 }));
  const transcript = path.join(dir, "t.jsonl");
  const entries = [
    { type: "user", message: { role: "user", content: "做事" } },
    ...(goal ? [{ type: "attachment", attachment: { type: "goal_status", met: false, sentinel: true, condition: goal } }] : []),
    { type: "assistant", message: { role: "assistant", model: "claude-haiku-4-5", stop_reason: "end_turn", usage: { input_tokens: 90000 }, content: [{ type: "text", text: "進行中" }] } },
  ];
  fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const env = {
    ...clean(),
    HC_TERMINAL_ID: "t5",
    HC_SCOPE: "scope",
    HC_BIN: fakeHc,
    HERDR_APP_BIN: fakeApp,
    FAKE_HERDR_APP_DIR: dir,
    FAKE_HC_CONVERSE: "1",
    CLAUDE_PROJECTS_DIR: projects,
    AUTO_HANDOFF_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
    WORKTREE_CONSOLE_HOME: path.join(dir, "console"),
    AUTO_HANDOFF_POLL_MS: "10",
    AUTO_HANDOFF_READY_MS: "300",
    AUTO_HANDOFF_DELIVER_MS: "500",
    AUTO_HANDOFF_FIRST_TURN_MS: "500",
    AUTO_HANDOFF_GOAL_MS: "500",
  };
  const stop = (extra = {}) => spawnSync(process.execPath, [autoHandoff, "stop"], { input: JSON.stringify({ session_id: "sess-h", transcript_path: transcript, cwd: app(), permission_mode: "acceptEdits" }), encoding: "utf8", env: { ...env, ...extra } });
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const writeNote = () => {
    fs.mkdirSync(path.join(home, "notes"), { recursive: true });
    fs.writeFileSync(path.join(home, "notes", "sess-h.md"), "# 交棒說明\n");
  };
  return { dir, home, stop, writeNote, calls: () => read("calls.log"), sends: () => read("sends.jsonl"), state: () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) };
}

const settle = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

test("自動交棒在 Herdr app：同一個 space 開新分頁（沿用名稱、--session-id、--permission-mode）、送接手指令與 /goal 都不帶舊分頁位址、看到 Goal set 後才關舊分頁", async () => {
  const h = handoffWorld();
  assert.match(JSON.parse(h.stop().stdout).decision, /block/);
  h.writeNote();
  const res = h.stop();
  assert.equal(res.stdout, "", res.stdout + res.stderr);
  const made = h.calls().filter((c) => c[0] === "herdr-app" && c[2] === "tab.new").map((c) => JSON.parse(c[3]));
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].space, made[0].name, made[0].folder], ["sp1", "PROJ-9", app()]);
  assert.deepEqual([made[0].argv.slice(0, 4), made[0].argv.slice(-2)], [["claude", "--name", "PROJ-9", "--session-id"], ["--permission-mode", "acceptEdits"]]);
  const sends = h.sends();
  assert.match(sends[0].text, /接手交棒/);
  assert.equal(sends[1].text, "/goal 完成 X");
  assert.ok(sends.every((s) => s.from === null && s.via === "send"), "送出不帶 <hc from=…>");
  const event = JSON.parse(fs.readFileSync(path.join(h.home, "events", "sess-h.json"), "utf8"));
  assert.deepEqual([event.status, event.oldHandle, event.oldPaneKey, event.newPaneKey], ["done", "t5", "hc:t5", `hc:${event.newHandle}`]);
  await settle(() => !h.state().terminals.t5);
  assert.equal(h.state().terminals.t5, undefined, "舊分頁關掉");
  assert.ok(h.state().terminals[event.newHandle], "新分頁留著");
  assert.deepEqual(h.state().focus, { space: "sp1", tab: "tb5" }, "開新分頁不搶焦點");
});

test("自動交棒在 Herdr app：送接手指令失敗或新分頁沒就緒就停在那一步、舊分頁保留並說卡在哪", async () => {
  const sendFail = handoffWorld({ goal: null });
  sendFail.stop();
  sendFail.writeNote();
  const res = sendFail.stop({ FAKE_HC_SEND_FAIL: "1" });
  assert.match(JSON.parse(res.stdout).systemMessage, /自動交棒失敗：卡在「送出接手指令」/);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(sendFail.state().terminals.t5, "舊分頁保留");
  assert.equal(sendFail.calls().some((c) => c[2] === "tab.close"), false);

  const notReady = handoffWorld({ goal: null });
  notReady.stop();
  notReady.writeNote();
  const late = notReady.stop({ FAKE_HC_NOT_READY: "1" });
  assert.match(JSON.parse(late.stdout).systemMessage, /自動交棒失敗：卡在「等新分頁就緒」/);
  assert.ok(notReady.state().terminals.t5);
});
