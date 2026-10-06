import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectDir, pendingItems } from "../skills/worktree-console/scripts/lib.mjs";
import { terminalKind } from "../skills/worktree-console/scripts/terminals.mjs";
import { transcriptState } from "../skills/worktree-console/scripts/herdr.mjs";
import { evaluate, conclusionLines } from "../skills/worktree-console/scripts/herdr-report.mjs";
import { emptyFocus, focusStep } from "../skills/worktree-console/scripts/focus.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills", "worktree-console", "scripts");
const fakeHerdr = path.join(root, "test", "fixtures", "worktree-console", "fake-herdr.mjs");
const fakeOrca = path.join(root, "test", "fixtures", "worktree-console", "fake-orca.mjs");
const consoleLog = path.join(root, "hooks", "console-log.mjs");
const autoHandoff = path.join(root, "hooks", "auto-handoff.mjs");
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORCA_|HERDR_|AUTO_HANDOFF_|CLAUDE_CODE_SESSION_ID)/.test(k)));

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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-herdr-")));
  sh(tmp, "init", "--bare", "-b", "main", "remote.git");
  sh(tmp, "clone", "-q", "remote.git", "app");
  fs.writeFileSync(path.join(app(), "README.md"), "hi\n");
  sh(app(), "add", ".");
  sh(app(), "commit", "-qm", "init");
  sh(app(), "push", "-q", "origin", "main");
  for (const name of ["proj-201-menu", "proj-202-perm", "proj-203-lost", "proj-204-unknown", "proj-205-idle", "nick-task"]) {
    sh(app(), "worktree", "add", "-q", "-b", `feat/${name}`, wt(name), "main");
  }
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ts = (n) => new Date(Date.UTC(2026, 9, 5, 6, 0, n)).toISOString();
const user = (text, n = 0) => ({ type: "user", timestamp: ts(n), message: { role: "user", content: text } });
const said = (text, n = 1, stop = "end_turn") => ({ type: "assistant", timestamp: ts(n), message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] } });
const call = (id, name, input, n = 1) => ({ type: "assistant", timestamp: ts(n), message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] } });
const result = (id, n = 2) => ({ type: "user", timestamp: ts(n), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

// A fresh herdr world: a console pane in w1 plus one claude pane per entry of `agents`.
function world(agents, { transcripts = {}, screens = {}, extraPanes = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "fake-"));
  const home = path.join(dir, "home");
  const projects = path.join(dir, "projects");
  const panes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: app(), foreground_cwd: app() }, ...extraPanes];
  const list = [];
  agents.forEach((a, i) => {
    const pane = a.pane ?? `w1:p${i + 2}`;
    const ws = pane.split(":")[0];
    panes.push({ pane_id: pane, tab_id: `${ws}:t${i + 2}`, workspace_id: ws, cwd: a.cwd, foreground_cwd: a.cwd, agent: "claude", agent_status: a.status });
    list.push({ agent: "claude", name: `a${i}`, pane_id: pane, cwd: a.cwd, agent_status: a.status, ...(a.session ? { agent_session: { kind: "id", value: a.session } } : {}) });
  });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ panes, agents: list, workspaces: [{ workspace_id: "w1" }] }));
  const env = { CLAUDE_PROJECTS_DIR: projects };
  for (const [session, { cwd, entries, raw }] of Object.entries(transcripts)) {
    const prev = process.env.CLAUDE_PROJECTS_DIR;
    process.env.CLAUDE_PROJECTS_DIR = projects;
    const file = path.join(claudeProjectDir(cwd), `${session}.jsonl`);
    process.env.CLAUDE_PROJECTS_DIR = prev;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw ?? entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  for (const [pane, lines] of Object.entries(screens)) fs.writeFileSync(path.join(dir, `screen-${pane.replace(/:/g, "_")}.txt`), lines.join("\n") + "\n");
  const orcaDir = path.join(dir, "orca");
  fs.mkdirSync(orcaDir);
  const base = {
    ...clean(),
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_BIN: fakeHerdr,
    FAKE_HERDR_DIR: dir,
    ORCA_BIN: fakeOrca,
    FAKE_ORCA_DIR: orcaDir,
    WORKTREE_CONSOLE_HOME: home,
    WORKTREE_CONSOLE_LOG_DIR: path.join(dir, "log"),
    ANSWER_KEY_DELAY_MS: "0",
    SECURITY_BIN: "/usr/bin/false",
    AWAIT_INTERVAL_MS: "20",
    SEND_CHECK_MS: "0",
    SEND_CHECK_TRIES: "1",
    ...env,
  };
  const run = (args, extra = {}) => {
    const res = spawnSync(process.execPath, [path.join(scripts, "console.mjs"), ...args], { encoding: "utf8", env: { ...base, ...extra } });
    return { code: res.status, out: res.stdout.trim(), err: res.stderr };
  };
  const read = (name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const audit = () => (fs.existsSync(path.join(home, "herdr-audit.jsonl")) ? fs.readFileSync(path.join(home, "herdr-audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, home, base, run, calls: () => read("calls.log"), sends: () => read("sends.jsonl"), state, audit, orcaCalls: () => fs.existsSync(path.join(orcaDir, "calls.log")) };
}

const PROMPT_SCREEN = ["⏺ Bash(mkdir x)", "────────────────────────────", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to cancel · Tab to amend"];

// One session in each state herdr can report, each with what its transcript says.
function standard() {
  return world(
    [
      { cwd: wt("proj-201-menu"), status: "blocked", session: "s-menu" },
      { cwd: wt("proj-202-perm"), status: "blocked", session: "s-perm" },
      { cwd: wt("proj-203-lost"), status: "blocked" },
      { cwd: wt("proj-204-unknown"), status: "unknown", session: "s-unknown" },
      { cwd: wt("proj-205-idle"), status: "idle", session: "s-idle" },
    ],
    {
      transcripts: {
        "s-menu": { cwd: wt("proj-201-menu"), entries: [user("挑顏色"), call("t1", "AskUserQuestion", { questions: MENU })] },
        "s-perm": { cwd: wt("proj-202-perm"), entries: [user("建資料夾"), call("t2", "Bash", { command: "mkdir -p /tmp/x", description: "建資料夾" })] },
        "s-unknown": { cwd: wt("proj-204-unknown"), entries: [user("說明一下"), said("做好了，接下來要我 push 嗎？")] },
        "s-idle": { cwd: wt("proj-205-idle"), entries: [user("跑測試"), call("t3", "Bash", { command: "npm test" }), result("t3"), said("測試全過。", 3)] },
      },
      screens: { "w1:p4": ["✻ Thinking…", "some output", "❯"] },
    },
  );
}

test("環境決定終端管理工具：HERDR_ENV=1 先於 ORCA_TERMINAL_HANDLE，兩者皆無是 null", () => {
  assert.equal(terminalKind({ HERDR_ENV: "1", ORCA_TERMINAL_HANDLE: "term_x" }), "herdr");
  assert.equal(terminalKind({ ORCA_TERMINAL_HANDLE: "term_x" }), "orca");
  assert.equal(terminalKind({ HERDR_ENV: "0" }), null);
  assert.equal(terminalKind({}), null);
});

test("Orca 與 herdr 皆無：console、watch 直接報錯說只支援 Orca 與 herdr", () => {
  const w = world([]);
  const env = { HERDR_ENV: "", HERDR_PANE_ID: "", ORCA_TERMINAL_HANDLE: "" };
  const board = w.run(["board", "--repo", app()], env);
  assert.equal(board.code, 1);
  assert.match(board.out, /只支援 Orca 與 herdr/);
  const watch = spawnSync(process.execPath, [path.join(scripts, "watch.mjs")], { encoding: "utf8", env: { ...w.base, ...env, WATCH_PGREP_PATTERN: "no-such-watcher-xyz" } });
  assert.equal(watch.status, 1);
  assert.match(watch.stdout, /只支援 Orca 與 herdr/);
  assert.equal(w.orcaCalls(), false);
});

test("在 herdr 裡但 herdr 連不上：報 herdr-unreachable，不退回 Orca", () => {
  const w = world([]);
  const res = w.run(["board", "--repo", app()], { FAKE_HERDR_FAIL: "1", ORCA_TERMINAL_HANDLE: "term_self" });
  assert.equal(res.code, 1);
  assert.equal(res.out, "[console] herdr-unreachable");
  assert.equal(w.orcaCalls(), false, "不能呼叫 orca");
  const watch = spawnSync(process.execPath, [path.join(scripts, "watch.mjs")], { encoding: "utf8", env: { ...w.base, FAKE_HERDR_FAIL: "1", WATCH_PGREP_PATTERN: "no-such-watcher-xyz" } });
  assert.match(watch.stdout, /\[watch\] herdr-unreachable/);
});

test("blocked 依對話紀錄分類：選單→💬（選項讀自紀錄）、其他工具→🔐（工具與內容）、讀不到→⚠️ 排最前", () => {
  const w = standard();
  const res = w.run(["board", "--repo", app()]);
  assert.equal(res.code, 0, res.out + res.err);
  const row = (tag) => res.out.split("\n").find((l) => l.includes(`| ${tag} |`));
  assert.match(row("PROJ-201"), /💬 等待回應.*要用哪個色？/);
  assert.match(row("PROJ-202"), /🔐 等待授權.*Bash mkdir -p \/tmp\/x/);
  assert.match(row("PROJ-203"), /⚠️ session 異常，需手動排程/);
  const pending = res.out.split("### 📋 待回覆")[1].split("\n").filter((l) => /^\| (?!狀態|---)/.test(l));
  assert.match(pending[0], /PROJ-203/, "異常排在待回覆最前面");
  assert.ok(pending.some((l) => /PROJ-201.*a 紅／b 藍／其他.*a 紅/.test(l)), pending.join("\n"));
  assert.equal(w.orcaCalls(), false, "herdr 模式不碰 orca");
});

test("unknown 先讀對話紀錄補判斷：回完話→⏸／💬；工具在跑→🔄、畫面有授權框→🔐；讀不到→⚠️", () => {
  const replied = standard().run(["board", "--repo", app()]);
  assert.match(replied.out.split("\n").find((l) => l.includes("| PROJ-204 |")), /💬 等待回應.*要我 push 嗎？/);
  const tool = (screen) =>
    world([{ cwd: wt("proj-204-unknown"), status: "unknown", session: "s" }], {
      transcripts: { s: { cwd: wt("proj-204-unknown"), entries: [user("建"), call("t9", "Bash", { command: "rm -rf build" })] } },
      screens: { "w1:p2": screen },
    }).run(["board", "--repo", app()]).out;
  assert.match(tool(["✻ Running…", "❯"]), /🔄 執行中/);
  assert.match(tool(PROMPT_SCREEN), /🔐 等待授權.*Bash rm -rf build/);
  const lost = world([{ cwd: wt("proj-204-unknown"), status: "unknown" }]).run(["board", "--repo", app()]).out;
  assert.match(lost, /⚠️ session 異常，需手動排程/);
});

test("herdr idle 但對話紀錄已回完話＝⏸ 回覆完畢；沒下過指令才是 💤 閒置", () => {
  const out = standard().run(["board", "--repo", app()]).out;
  assert.match(out.split("\n").find((l) => l.includes("| PROJ-205 |")), /⏸ 回覆完畢.*測試全過。/);
  const fresh = world([{ cwd: wt("proj-205-idle"), status: "idle", session: "f" }], {
    transcripts: { f: { cwd: wt("proj-205-idle"), entries: [{ type: "attachment", timestamp: ts(0), attachment: { type: "x" } }] } },
  }).run(["board", "--repo", app()]).out;
  assert.match(fresh, /閒置 1 個/);
});

test("對話紀錄損毀（一行都解析不了）時 blocked 照樣標 ⚠️", () => {
  const w = world([{ cwd: wt("proj-201-menu"), status: "blocked", session: "bad" }], { transcripts: { bad: { cwd: wt("proj-201-menu"), raw: "{not json\n<<<garbage\n" } } });
  assert.match(w.run(["board", "--repo", app()]).out, /⚠️ session 異常，需手動排程/);
});

test("⚠️ 的詳情附子 session 畫面；回覆原文照送，不轉成 a、b、c", () => {
  const w = world([{ cwd: wt("proj-203-lost"), status: "blocked" }], { screens: { "w1:p2": ["奇怪的畫面第一行", "Trust this folder?", "❯ 1. Yes"] } });
  const detail = w.run(["detail", "--repo", app(), "PROJ-203"]);
  assert.match(detail.out, /### ⚠️ PROJ-203 session 異常，需手動排程/);
  assert.match(detail.out, /子 session 畫面：\n```\n奇怪的畫面第一行\nTrust this folder\?\n❯ 1\. Yes\n```/);
  assert.equal(w.run(["reply", "--repo", app(), "--", "PROJ-203 b"]).out, "[PROJ-203] 已原文送出（session 異常，請到分頁確認）");
  assert.deepEqual(w.sends().filter((s) => s.pane === "w1:p2").map((s) => s.text ?? s.keys.join(" ")), ["b", "enter"]);
});

test("每次讀狀態都寫一筆對照紀錄：herdr 原始、中控台顯示、紀錄與畫面推出，不一致標出", () => {
  const w = standard();
  w.run(["board", "--repo", app()]);
  const rows = Object.fromEntries(w.audit().filter((e) => e.event === "read").map((e) => [e.ticket, e]));
  assert.deepEqual(Object.keys(rows).sort(), ["PROJ-201", "PROJ-202", "PROJ-203", "PROJ-204", "PROJ-205"]);
  assert.deepEqual([rows["PROJ-202"].herdr, rows["PROJ-202"].shown, rows["PROJ-202"].inferred, rows["PROJ-202"].mismatch], ["blocked", "permission", "busy", true], "畫面沒有授權框：推論說還在跑，標不一致");
  assert.deepEqual([rows["PROJ-203"].shown, rows["PROJ-203"].inferred, rows["PROJ-203"].transcript, rows["PROJ-203"].mismatch], ["anomaly", "unknown", false, true]);
  assert.deepEqual([rows["PROJ-205"].herdr, rows["PROJ-205"].shown, rows["PROJ-205"].inferred, rows["PROJ-205"].mismatch], ["idle", "done", "done", false]);
  assert.equal(rows["PROJ-204"].herdr, "unknown");
  w.run(["board", "--repo", app()]);
  assert.equal(w.audit().filter((e) => e.event === "read").length, 10, "第二次讀再寫五筆");
});

test("「<票號> 狀態錯了，其實是 X」記成人工誤判", () => {
  const w = standard();
  const res = w.run(["misjudge", "--repo", app(), "PROJ-205", "其實在等我授權"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(res.out, "[PROJ-205] 已記下誤判：看板顯示 ⏸ 回覆完畢，實際是「其實在等我授權」");
  const m = w.audit().find((e) => e.event === "misjudge");
  assert.deepEqual([m.ticket, m.shown, m.herdr, m.actualKind], ["PROJ-205", "done", "idle", "permission"]);
});

test("repo 名單＝herdr 開著的工作區＋中控台記住的；工作區關掉後票仍在，之後可用名稱指定", () => {
  const w = world([{ cwd: wt("proj-201-menu"), status: "blocked", session: "s-menu", pane: "w7:p2" }], {
    transcripts: { "s-menu": { cwd: wt("proj-201-menu"), entries: [user("挑"), call("t1", "AskUserQuestion", { questions: MENU })] } },
    extraPanes: [{ pane_id: "w7:p1", tab_id: "w7:t1", workspace_id: "w7", cwd: wt("proj-201-menu"), foreground_cwd: wt("proj-201-menu") }],
  });
  assert.match(w.run(["board", "--repo", app()]).out, /\*\*app\*\*[\s\S]*PROJ-201/);
  const s = w.state();
  s.panes = s.panes.filter((p) => p.pane_id !== "w1:p1");
  fs.writeFileSync(path.join(w.dir, "state.json"), JSON.stringify(s));
  const byName = w.run(["board", "--repo", "app"], { HERDR_PANE_ID: "w9:p9" });
  assert.equal(byName.code, 0, byName.out);
  assert.match(byName.out, /PROJ-201/, "主 checkout 的工作區關了，票照樣在");
  assert.equal(JSON.parse(w.run(["resolve", "--repo", "app", "PROJ-205"]).out).match, "one", "沒有 session 的 worktree 也查得到");
  assert.match(w.run(["board", "--repo", "nope"]).out, /找不到 repo「nope」/);
});

test("開工：建 worktree、自記票號與需求訪談標記、開分頁啟動 claude 並送首則指令；看板據此顯示", () => {
  const w = world([]);
  const target = path.join(tmp, "herdr-wt", "app", "proj-301");
  const res = w.run(["start", "--repo", app(), "--branch", "feat/odd-name", "--dir", "proj-301", "--ticket", "proj-301", "--interview", "--path", target, "--", "PROJ-301：試；slug 用 proj-301"]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, new RegExp(`worktree: ${target}\\nterminal: w1:p\\d+`));
  assert.equal(sh(target, "branch", "--show-current"), "feat/odd-name");
  const calls = w.calls().map((c) => c.slice(0, 2).join(" "));
  assert.deepEqual(calls.filter((c) => c !== "api snapshot"), ["tab create", "agent start", "agent prompt"]);
  assert.equal(w.sends().at(-1).text, "PROJ-301：試；slug 用 proj-301");
  const record = JSON.parse(fs.readFileSync(path.join(w.home, "herdr-worktrees.json"), "utf8"))[fs.realpathSync(target)];
  assert.deepEqual([record.ticket, record.interview], ["PROJ-301", true]);
  const board = w.run(["board", "--repo", app()]).out;
  assert.match(board, /\| PROJ-301 \| feat\/odd-name \| 規劃中 \|/, "branch 名稱推不出票號，靠自記的對應顯示");
  const nick = w.run(["start", "--repo", "app", "--branch", "feat/nick-task", "--dir", "x", "--name", "login", "--", "login 做登入"]);
  assert.equal(nick.code, 0, nick.out);
  assert.equal(w.calls().filter((c) => c[0] === "tab" && c[1] === "create").length, 2, "既有 worktree 不再建，只開分頁");
});

test("指揮：選單代按送數字鍵、授權允許送 1 拒絕送 Esc、文字走 agent prompt；blocked 時文字被擋就回未送達", () => {
  const w = standard();
  assert.equal(w.run(["answer", "--repo", app(), "PROJ-201", "b"], { FAKE_HERDR_UNBLOCK: "1", AWAIT_INTERVAL_MS: "10" }).out, "[PROJ-201] 已選擇：顏色→藍");
  assert.equal(w.run(["answer", "--repo", app(), "PROJ-202", "允許"], { FAKE_HERDR_UNBLOCK: "1" }).out, "[PROJ-202] 已允許");
  const keys = w.sends().filter((s) => s.via === "send-keys").map((s) => [s.pane, s.keys.join(" ")]);
  assert.deepEqual(keys, [["w1:p2", "2"], ["w1:p3", "1"]]);
  const w2 = standard();
  w2.run(["answer", "--repo", app(), "PROJ-202", "拒絕"], { FAKE_HERDR_UNBLOCK: "1" });
  assert.deepEqual(w2.sends().at(-1).keys, ["esc"]);
  const sent = w2.run(["send", "--terminal", "w1:p6", "--tag", "PROJ-205", "--", "繼續"], { SEND_CHECK_TRIES: "1" });
  assert.equal(w2.sends().at(-1).via, "prompt");
  assert.equal(w2.sends().at(-1).text, "繼續");
  assert.match(sent.out, /^\[PROJ-205\] /);
  const blocked = w2.run(["send", "--terminal", "w1:p4", "--tag", "PROJ-203", "--", "hi"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /\[PROJ-203\] 未送達：送出失敗：agent_blocked/);
});

test("關閉：關掉 worktree 內的 herdr 分頁、git worktree remove、清掉自記紀錄，branch 保留", () => {
  const w = world([]);
  const target = path.join(tmp, "herdr-wt", "app", "close-me");
  w.run(["start", "--repo", app(), "--branch", "feat/close-me", "--dir", "close-me", "--ticket", "PROJ-401", "--path", target, "--", "PROJ-401 做"]);
  const s = w.state();
  s.agents.forEach((a) => (a.agent_status = "done"));
  fs.writeFileSync(path.join(w.dir, "state.json"), JSON.stringify(s));
  const res = w.run(["close", "--path", target]);
  assert.equal(res.code, 0, res.out);
  assert.equal(res.out, "[PROJ-401] 已關閉：worktree 已移除，branch feat/close-me 保留");
  assert.equal(fs.existsSync(target), false);
  assert.ok(w.calls().some((c) => c[0] === "pane" && c[1] === "close"));
  assert.equal(w.state().panes.some((p) => p.cwd === fs.realpathSync(path.dirname(target)) + "/close-me"), false);
  assert.equal(fs.realpathSync(path.dirname(target)) + "/close-me" in JSON.parse(fs.readFileSync(path.join(w.home, "herdr-worktrees.json"), "utf8")), false);
  assert.equal(sh(app(), "branch", "--list", "feat/close-me"), "feat/close-me");
});

test("交棒（define-goal 定稿後）：新分頁、送 /goal、看到 Goal set 才關訪談分頁；被收成貼上內容時保留", () => {
  const w = world([{ cwd: wt("proj-201-menu"), status: "done", session: "s" }], { transcripts: { s: { cwd: wt("proj-201-menu"), entries: [user("訪談"), said("定稿完成")] } } });
  const file = path.join(w.dir, "goal.txt");
  fs.writeFileSync(file, "/goal 做完 PROJ-201");
  const res = w.run(["handoff", "--path", wt("proj-201-menu"), "--from", "w1:p2", "--file", file], { SEND_CHECK_MS: "0" });
  assert.equal(res.code, 0, res.out);
  assert.equal(res.out, "[PROJ-201] 已交棒執行");
  assert.equal(w.state().panes.some((p) => p.pane_id === "w1:p2"), false, "訪談分頁已關");
  const goal = w.sends().find((s) => s.text?.startsWith("/goal"));
  assert.equal(goal.via, "prompt");
  const event = fs.readFileSync(path.join(w.dir, "log", fs.readdirSync(path.join(w.dir, "log")).find((f) => f.endsWith(".jsonl"))), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === "handoff");
  assert.deepEqual([event.terminal, event.goalLength, event.ok], ["herdr", 17, true]);

  const p = world([{ cwd: wt("proj-201-menu"), status: "done", session: "s" }], { transcripts: { s: { cwd: wt("proj-201-menu"), entries: [user("訪談"), said("定稿完成")] } } });
  const pasted = p.run(["handoff", "--path", wt("proj-201-menu"), "--from", "w1:p2", "--file", file], { FAKE_HERDR_PASTE: "1", SEND_CHECK_TRIES: "1" });
  assert.equal(pasted.code, 1);
  assert.match(pasted.out, /交棒失敗：被當成貼上內容收起/);
  assert.ok(p.state().panes.some((x) => x.pane_id === "w1:p2"), "訪談分頁保留");
});

test("open --continue 在沒有分頁的 worktree 開 claude 並帶參數", () => {
  const w = world([]);
  const res = w.run(["open", "--path", wt("proj-205-idle"), "--continue"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /^terminal: w1:p\d+$/);
  assert.deepEqual(w.state().agents.at(-1).argv, ["--continue"]);
});

test("console-log hook 在 herdr 用 HERDR_PANE_ID 登記分頁與 session", () => {
  const w = standard();
  w.run(["board", "--repo", app()]);
  const run = (command, input) =>
    spawnSync(process.execPath, [consoleLog, command], { input: JSON.stringify(input), encoding: "utf8", env: { ...w.base, HERDR_PANE_ID: "w1:p2" } });
  run("session-start", { session_id: "sid-1", transcript_path: "/x/sid-1.jsonl", cwd: wt("proj-201-menu"), source: "startup" });
  run("user-prompt", { session_id: "sid-1", cwd: wt("proj-201-menu"), prompt: "繼續" });
  const log = path.join(w.dir, "log");
  const events = fs.readdirSync(log).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(path.join(log, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const session = events.find((e) => e.event === "session");
  assert.deepEqual([session.handle, session.paneKey, session.ticket, session.transcript], ["w1:p2", "w1:p2", "PROJ-201", "/x/sid-1.jsonl"]);
  assert.equal(events.find((e) => e.event === "prompt").text, "繼續");
  const none = spawnSync(process.execPath, [consoleLog, "user-prompt"], { input: JSON.stringify({ cwd: wt("proj-201-menu"), prompt: "x" }), encoding: "utf8", env: { ...w.base, HERDR_ENV: "", ORCA_TERMINAL_HANDLE: "" } });
  assert.equal(none.stdout, "");
});

test("auto-handoff hook 在 herdr：同工作區開新分頁接手、送 /goal、確認 Goal set 後關舊分頁", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "ah-"));
  const projects = path.join(dir, "projects");
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ panes: [{ pane_id: "w3:p1", tab_id: "w3:t1", workspace_id: "w3", cwd: app() }], agents: [] }));
  const home = path.join(dir, "handoff");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ enabled: true, ratio: 0.4 }));
  const transcript = path.join(dir, "t.jsonl");
  const GOAL = "完成 X";
  const entries = [
    { type: "user", message: { role: "user", content: "做事" } },
    { type: "attachment", attachment: { type: "goal_status", met: false, sentinel: true, condition: GOAL } },
    { type: "assistant", message: { role: "assistant", model: "claude-haiku-4-5", stop_reason: "end_turn", usage: { input_tokens: 90000 }, content: [{ type: "text", text: "進行中" }] } },
  ];
  fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const env = { ...clean(), HERDR_ENV: "1", HERDR_PANE_ID: "w3:p1", HERDR_WORKSPACE_ID: "w3", HERDR_BIN: fakeHerdr, FAKE_HERDR_DIR: dir, FAKE_HERDR_TRANSCRIPTS: projects, CLAUDE_PROJECTS_DIR: projects, AUTO_HANDOFF_HOME: home, CLAUDE_CONFIG_DIR: path.join(dir, "claude"), WORKTREE_CONSOLE_HOME: path.join(dir, "console"), AUTO_HANDOFF_POLL_MS: "10", AUTO_HANDOFF_DELIVER_MS: "500", AUTO_HANDOFF_FIRST_TURN_MS: "500", AUTO_HANDOFF_GOAL_MS: "500" };
  const stop = () => spawnSync(process.execPath, [autoHandoff, "stop"], { input: JSON.stringify({ session_id: "sess-h", transcript_path: transcript, cwd: app(), permission_mode: "acceptEdits" }), encoding: "utf8", env });
  assert.match(JSON.parse(stop().stdout).decision, /block/);
  fs.mkdirSync(path.join(home, "notes"), { recursive: true });
  fs.writeFileSync(path.join(home, "notes", "sess-h.md"), "# 交棒說明\n");
  const res = stop();
  assert.equal(res.stdout, "", res.stdout + res.stderr);
  const event = JSON.parse(fs.readFileSync(path.join(home, "events", "sess-h.json"), "utf8"));
  assert.deepEqual([event.status, event.oldHandle, event.oldPaneKey], ["done", "w3:p1", "w3:p1"]);
  const sends = fs.readFileSync(path.join(dir, "sends.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.match(sends[0].text, /接手交棒/);
  assert.equal(sends[1].text, `/goal ${GOAL}`);
  const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const start = calls.find((c) => c[0] === "agent" && c[1] === "start");
  assert.deepEqual(start.slice(-3), ["--", "--permission-mode", "acceptEdits"]);
  assert.equal(calls.find((c) => c[0] === "tab")[3], "w3");
  for (let i = 0; i < 100 && JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).panes.some((p) => p.pane_id === "w3:p1"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).panes.some((p) => p.pane_id === "w3:p1"), false, "舊分頁關掉");
});

test("auto-handoff hook 在 Orca 與 herdr 以外：說明只支援 Orca 與 herdr，並附交棒說明路徑", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "ah-none-"));
  const home = path.join(dir, "handoff");
  fs.mkdirSync(path.join(home, "notes"), { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ enabled: true }));
  const transcript = path.join(dir, "t.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-haiku-4-5", usage: { input_tokens: 150000 }, content: [{ type: "text", text: "x" }] } }) + "\n");
  const env = { ...clean(), AUTO_HANDOFF_HOME: home, CLAUDE_CONFIG_DIR: path.join(dir, "claude") };
  const stop = () => spawnSync(process.execPath, [autoHandoff, "stop"], { input: JSON.stringify({ session_id: "sess-n", transcript_path: transcript, cwd: dir }), encoding: "utf8", env });
  stop();
  fs.writeFileSync(path.join(home, "notes", "sess-n.md"), "# 說明\n");
  const msg = JSON.parse(stop().stdout).systemMessage;
  assert.match(msg, /只支援 Orca 與 herdr/);
  assert.ok(msg.includes(path.join(home, "notes", "sess-n.md")));
});

test("transcriptState：選單、工具結果、回完話、被中斷、還沒下指令", () => {
  assert.equal(transcriptState([user("a"), call("t", "AskUserQuestion", { questions: MENU })]).pending.name, "AskUserQuestion");
  assert.equal(transcriptState([user("a"), call("t", "Bash", {}), result("t")]).phase, "running");
  assert.equal(transcriptState([user("a"), said("好")]).phase, "replied");
  assert.equal(transcriptState([user("a"), said("想一下", 1, null)]).phase, "running");
  assert.equal(transcriptState([user("a"), call("t", "Bash", {}), result("t"), user("[Request interrupted by user]", 3)]).phase, "replied");
  assert.equal(transcriptState([{ type: "attachment" }]).phase, "fresh");
  assert.equal(transcriptState([said("x")], { truncated: true }).phase, "replied");
});

test("待回覆與專注排隊：⚠️ 排在 🔐 前面", () => {
  const entries = [
    { key: "a", paneKey: "a", kind: "permission", since: 1, item: {} },
    { key: "b", paneKey: "b", kind: "anomaly", since: 5, item: {} },
    { key: "c", paneKey: "c", kind: "waiting", since: 0, item: {} },
  ];
  const view = focusStep(emptyFocus(), entries, 10);
  assert.deepEqual([view.current.key, ...view.queue.map((e) => e.key)], ["b", "a", "c"]);
  const row = (tag, kind) => ({ label: tag, repo: "r", stage: "實作中", sessions: [{ n: null, paneKey: tag, status: { kind, text: "", tool: "Bash", input: "x" }, agent: { state: kind === "anomaly" ? "anomaly" : "blocked" } }] });
  assert.deepEqual(pendingItems([row("P", "permission"), row("A", "anomaly")]).map((x) => x.tag), ["A", "P"]);
});

test("評估報告：門檻是異常 <5% 且沒有該叫沒叫的誤判", () => {
  const reads = (n, extra = {}) => Array.from({ length: n }, () => ({ ts: ts(0), event: "read", herdr: "working", shown: "busy", inferred: "busy", mismatch: false, ticket: "T", ...extra }));
  const good = evaluate({ audit: [...reads(96), ...reads(4, { herdr: "unknown", shown: "anomaly", inferred: "unknown", mismatch: true })], events: [] });
  assert.equal(good.safe, true);
  assert.deepEqual(conclusionLines(good).slice(0, 2), ["herdr 原始 unknown：4／100 次讀取（4.0%）", "補判斷後「session 異常」：4／100（4.0%，門檻 <5%）"]);
  assert.equal(conclusionLines(good).at(-1), "結論：herdr 版可以放心用");
  const bad = evaluate({ audit: [...reads(95), ...reads(5, { shown: "anomaly", inferred: "unknown", mismatch: true })], events: [] });
  assert.match(conclusionLines(bad).at(-1), /^結論：還不行——補判斷後「session 異常」佔 5\.0%/);
  const missed = evaluate({ audit: [...reads(10), { ts: ts(1), event: "misjudge", shown: "done", actualKind: "permission", actual: "在等授權" }], events: [] });
  assert.match(conclusionLines(missed).at(-1), /還不行——有 1 次實際在等使用者回應或授權/);
  const noisy = evaluate({ audit: [...reads(10), { ts: ts(1), event: "misjudge", shown: "permission", actualKind: "busy", actual: "其實在跑" }], events: [] });
  assert.equal(noisy.safe, true, "多叫一次不算否決");
});

test("herdr-report 指令寫出 HTML 並印路徑與結論", () => {
  const w = standard();
  w.run(["board", "--repo", app()]);
  const out = path.join(w.dir, "report.html");
  const res = w.run(["herdr-report", "--out", out], { HERDR_ENV: "", ORCA_TERMINAL_HANDLE: "" });
  assert.equal(res.code, 0, res.out);
  assert.equal(res.out.split("\n")[0], `報告：${out}`);
  assert.match(res.out, /herdr 原始 unknown：1／5 次讀取（20\.0%）/);
  assert.match(res.out, /結論：還不行——補判斷後「session 異常」佔 20\.0%/);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /<title>herdr 試跑評估<\/title>/);
  assert.match(html, /還不行/);
});

// linear.mjs: the key comes from a fake `security`, the API is a local server; nothing may print the key.
const SECRET = "lin_api_TOPSECRET_123";

function linearEnv(dir, { key = true } = {}) {
  const security = path.join(dir, "security");
  fs.writeFileSync(security, key ? `#!/bin/sh\necho "$@" >> "${dir}/security-args"\necho ${SECRET}\n` : "#!/bin/sh\nexit 44\n");
  const pbcopy = path.join(dir, "pbcopy");
  fs.writeFileSync(pbcopy, `#!/bin/sh\ncat > "${dir}/clipboard"\n`);
  fs.chmodSync(security, 0o755);
  fs.chmodSync(pbcopy, 0o755);
  return { ...clean(), SECURITY_BIN: security, PBCOPY_BIN: pbcopy };
}

function runLinear(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scripts, "linear.mjs"), ...args], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out: out.trim(), err }));
  });
}

test("linear.mjs：鑰匙圈沒有 key 時報錯、用 pbcopy 複製設定指令，輸出不含 key", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "lin-"));
  const res = await runLinear(["issue", "PROJ-1"], linearEnv(dir, { key: false }));
  assert.equal(res.code, 1);
  assert.match(res.out, /鑰匙圈裡沒有 Linear API key/);
  assert.match(res.out, /設定指令已用 pbcopy 複製到剪貼簿/);
  assert.equal(fs.readFileSync(path.join(dir, "clipboard"), "utf8"), 'security add-generic-password -U -s worktree-console-linear -a "$USER" -w');
  const json = await runLinear(["todo", "--json"], linearEnv(dir, { key: false }));
  assert.deepEqual(JSON.parse(json.out).error.code, "linear_key_missing");
});

test("linear.mjs：key 只放在 API 請求的標頭，issue 帶母票與子票、todo 只留排進 cycle 的", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "lin-"));
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      const q = JSON.parse(body).query;
      const data = q.includes("viewer")
        ? { viewer: { assignedIssues: { nodes: [{ identifier: "PROJ-9", title: "[FE] a", cycle: { number: 3 }, labels: { nodes: [{ name: "x" }] }, state: { name: "Todo" } }, { identifier: "PROJ-8", title: "b", cycle: null, labels: { nodes: [] }, state: { name: "Todo" } }] } } }
        : { issue: { identifier: "PROJ-7", title: "子票", branchName: "chris/proj-7-x", state: { name: "Todo" }, parent: { identifier: "PROJ-6", title: "母票", branchName: "chris/proj-6-y" }, children: { nodes: [] }, labels: { nodes: [] }, description: "內容" } };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { ...linearEnv(dir), LINEAR_API_URL: `http://127.0.0.1:${server.address().port}/graphql` };
  try {
    const issue = await runLinear(["issue", "proj-7"], env);
    assert.equal(issue.code, 0, issue.out + issue.err);
    assert.match(issue.out, /^PROJ-7 子票/);
    assert.match(issue.out, /母票：PROJ-6 母票（branch chris\/proj-6-y）/);
    const todo = JSON.parse((await runLinear(["todo", "--json"], env)).out);
    assert.deepEqual(todo.issues.map((i) => i.identifier), ["PROJ-9"]);
    assert.deepEqual(todo.issues[0].labels, [{ name: "x" }]);
    assert.ok(seen.every((s) => s.auth === SECRET));
    assert.equal(seen[0].body.variables.id, "PROJ-7");
    assert.ok(![issue.out, issue.err].some((t) => t.includes(SECRET)));
    assert.ok(!fs.readFileSync(path.join(dir, "security-args"), "utf8").includes(SECRET), "key 不在指令參數裡");
  } finally {
    server.close();
  }
});
