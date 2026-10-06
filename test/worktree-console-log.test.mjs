import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commitLog,
  computeTokens,
  logEvent,
  transcriptActivity,
  pairStops,
  readEvents,
  readTokens,
  registerConsole,
  replies,
  reportLines,
  transcriptUsage,
  writeManaged,
} from "../skills/worktree-console/scripts/log.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "hooks", "console-log.mjs");
let tmp;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-log-")));
  process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, "projects");
  process.env.WORKTREE_CONSOLE_HOME = path.join(tmp, "console-home");
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function freshLog(t) {
  const dir = fs.mkdtempSync(path.join(tmp, "log-"));
  fs.rmSync(dir, { recursive: true });
  process.env.WORKTREE_CONSOLE_LOG_DIR = dir;
  return dir;
}

const dayFile = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
const allText = (dir) => dayFile(dir).map((f) => fs.readFileSync(f, "utf8")).join("");

function transcript(name, entries) {
  const file = path.join(tmp, "projects", "-wt", `${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

const reply = (id, usage, model = "claude-opus-5-5") => ({ type: "assistant", message: { id, model, usage, content: [{ type: "text", text: "x" }] } });
const U = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 };

test("紀錄目錄不存在時自動建立並 git init、沒有 remote；一天一個 JSONL、一行一事件，帶時間戳、事件類型、repo、票號", () => {
  const dir = freshLog();
  logEvent("stop", { repo: "app", ticket: "PROJ-1", status: "waiting", question: "要哪個？", suggestion: null });
  logEvent("close", { repo: "app", ticket: "PROJ-1", ok: true });
  assert.ok(fs.existsSync(path.join(dir, ".git")));
  assert.equal(spawnSync("git", ["-C", dir, "remote"], { encoding: "utf8" }).stdout.trim(), "");
  const files = dayFile(dir);
  assert.equal(files.length, 1);
  assert.match(path.basename(files[0]), /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const lines = fs.readFileSync(files[0], "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  for (const ev of lines) {
    assert.ok(!Number.isNaN(Date.parse(ev.ts)));
    assert.equal(ev.repo, "app");
    assert.equal(ev.ticket, "PROJ-1");
  }
  assert.deepEqual(lines.map((e) => e.event), ["stop", "close"]);
});

test("遮罩：AWS key、私鑰、GitLab token、sk- 開頭金鑰、password/secret/token= 後的值，寫進檔案後原值不出現", () => {
  const dir = freshLog();
  const secrets = {
    aws: "AKIAIOSFODNN7EXAMPLE",
    key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabcdefSECRETBODY\n-----END RSA PRIVATE KEY-----",
    gitlab: "glpat-AbCdEfGhIjKlMnOpQrSt12",
    sk: "sk-ant-api03-abcdefghijklmnopqrstuv",
    assign: "hunter2-very-secret-value",
  };
  logEvent("prompt", { text: `用這個 ${secrets.aws} 部署` });
  logEvent("prompt", { text: `貼上金鑰 ${secrets.key}` });
  logEvent("prompt", { text: `token 是 ${secrets.gitlab}` });
  logEvent("answer", { answer: `OPENAI 用 ${secrets.sk}` });
  logEvent("answer", { answer: `password=${secrets.assign} secret: s3cr3t-abc TOKEN="quoted-value-1"` });
  const text = allText(dir);
  for (const value of [...Object.values(secrets), "MIIEowIBAAKCAQEAabcdefSECRETBODY", "s3cr3t-abc", "quoted-value-1"]) {
    assert.ok(!text.includes(value), `原值不該出現：${value}`);
  }
  assert.equal(text.trim().split("\n").length, 5);
  assert.match(text, /已遮罩/);
});

test("token：同一個 message.id 重複出現的列只算一次，子代理一起加總", () => {
  const file = transcript("dup", [reply("m1", U), reply("m1", U), reply("m1", U), reply("m2", U)]);
  fs.mkdirSync(file.replace(/\.jsonl$/, "/subagents"), { recursive: true });
  fs.writeFileSync(file.replace(/\.jsonl$/, "/subagents/agent-a.jsonl"), [reply("s1", U, "claude-haiku-4-5-20251001"), reply("s1", U, "claude-haiku-4-5-20251001")].map((e) => JSON.stringify(e)).join("\n"));
  const usage = transcriptUsage(file);
  assert.equal(usage.source, "message-id");
  assert.deepEqual(
    { ...usage.models["claude-opus-5-5"], usd: undefined },
    { input: 20, output: 200, cacheWrite: 2000, cacheRead: 20000, usd: undefined },
  );
  assert.equal(usage.models["claude-haiku-4-5-20251001"].output, 100);
  const opusUsd = (20 * 4 + 200 * 20 + 2000 * 4 * 1.25 + 20000 * 0.2) / 1e6;
  assert.ok(Math.abs(usage.models["claude-opus-5-5"].usd - opusUsd) < 1e-9);
});

test("token：有 cost-state 就讀它（模型名去掉 [1m]），沒有才依 message.id 加總", () => {
  const costState = {
    type: "cost-state",
    totalCostUSD: 9.5,
    modelUsage: { "claude-opus-5-5[1m]": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 9.5 } },
  };
  const file = transcript("cost", [reply("m1", U), reply("m1", U), costState]);
  const usage = transcriptUsage(file);
  assert.equal(usage.source, "cost-state");
  assert.deepEqual(usage.models, { "claude-opus-5-5": { input: 1, output: 2, cacheWrite: 4, cacheRead: 3, usd: 9.5 } });
  const resumed = transcript("resumed", [reply("m1", U), costState, reply("m2", U)]);
  assert.equal(transcriptUsage(resumed).source, "message-id", "cost-state 之後又有回覆時改用加總");
});

test("token：重算結果比上次少（對話紀錄被清掉一部分）時沿用舊值；每筆帶計算時間戳；中控台另算", () => {
  freshLog();
  const wt = path.join(tmp, "wt-a");
  const dir = path.join(tmp, "projects", wt.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const write = (entries) => fs.writeFileSync(path.join(dir, "child.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  write([reply("m1", U), reply("m2", U)]);
  const consoleFile = transcript("console-sid", [reply("c1", U)]);
  writeManaged({ worktrees: [{ path: wt, repo: "app", ticket: "PROJ-9" }], repos: [], consoles: [], handles: {} });
  logEvent("session", { role: "console", ticket: "中控台", sessionId: "console-sid", transcript: consoleFile });
  const first = computeTokens(new Date("2026-10-02T01:00:00Z"));
  assert.equal(first.buckets["app/PROJ-9"].models["claude-opus-5-5"].output, 200);
  assert.equal(first.buckets["app/PROJ-9"].computedAt, "2026-10-02T01:00:00.000Z");
  assert.equal(first.buckets["中控台"].models["claude-opus-5-5"].output, 100);
  write([reply("m1", U)]);
  const second = computeTokens(new Date("2026-10-02T02:00:00Z"));
  assert.equal(second.buckets["app/PROJ-9"].models["claude-opus-5-5"].output, 200, "變少不覆蓋");
  assert.equal(second.buckets["app/PROJ-9"].sessions.child.computedAt, "2026-10-02T01:00:00.000Z");
  write([reply("m1", U), reply("m2", U), reply("m3", U)]);
  const third = computeTokens(new Date("2026-10-02T03:00:00Z"));
  assert.equal(third.buckets["app/PROJ-9"].models["claude-opus-5-5"].output, 300, "變多照樣更新");
  fs.rmSync(path.join(dir, "child.jsonl"));
  assert.equal(computeTokens().buckets["app/PROJ-9"].models["claude-opus-5-5"].output, 300, "對話紀錄整個被清掉也保留舊值");
  assert.deepEqual(readTokens().buckets["app/PROJ-9"].ticket, "PROJ-9");
});

test("commit：第一次與強制時 commit、30 分鐘內沒有關票不 commit、沒變動不 commit、有關票事件就補一次", () => {
  const dir = freshLog();
  const count = () => Number(spawnSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).stdout.trim() || 0);
  logEvent("stop", { repo: "app", ticket: "A" });
  assert.equal(commitLog({ force: true, reason: "中控台啟動" }), true);
  assert.equal(count(), 1);
  assert.match(spawnSync("git", ["-C", dir, "log", "-1", "--format=%s%n%an"], { encoding: "utf8" }).stdout, /中控台啟動\nworktree-console/);
  logEvent("stop", { repo: "app", ticket: "A" });
  assert.equal(commitLog(), false, "30 分鐘內不 commit");
  assert.equal(commitLog({ now: Date.now() + 31 * 60 * 1000 }), true);
  assert.equal(commitLog({ force: true }), false, "沒變動不 commit");
  spawnSync("sleep", ["1"]);
  logEvent("close", { repo: "app", ticket: "A", ok: true });
  assert.equal(commitLog(), true, "關票後補一次");
  assert.equal(count(), 3);
});

test("report：中控台送出的同一句與 hook 記到的（同分頁、同文字、數秒內）只算一次；直接在 Orca 分頁打的回覆也算回答", () => {
  const t0 = Date.parse("2026-10-02T01:00:00Z");
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const events = [
    { ts: at(0), event: "stop", repo: "app", ticket: "PROJ-1", handle: "h1", status: "waiting", question: "要用 A 還是 B？", suggestion: "A" },
    { ts: at(30), event: "answer", repo: "app", ticket: "PROJ-1", handle: "h1", via: "text", answer: "用 B", delivery: "delivered" },
    { ts: at(32), event: "prompt", repo: "app", ticket: "PROJ-1", handle: "h1", text: "用 B" },
    { ts: at(100), event: "stop", repo: "app", ticket: "PROJ-1", handle: "h1", status: "waiting", question: "要加測試嗎？", suggestion: "要" },
    { ts: at(160), event: "prompt", repo: "app", ticket: "PROJ-1", handle: "h1", text: "先不用" },
    { ts: at(200), event: "prompt", repo: "app", ticket: "PROJ-1", handle: "h2", text: "用 B" },
  ];
  const r = replies(events);
  assert.deepEqual(r.map((x) => [x.handle, x.via, x.answer]), [["h1", "text", "用 B"], ["h1", "typed", "先不用"], ["h2", "typed", "用 B"]]);
  const pairs = pairStops(events);
  assert.deepEqual(pairs.map((p) => p.reply?.answer), ["用 B", "先不用"]);
  const out = reportLines(events, { buckets: {} }).join("\n");
  assert.match(out, /\| app\/PROJ-1 \| 2 \| 45 秒 \| 1 分 0 秒 \| 0 \|/);
  assert.match(out, /\| app\/PROJ-1 \| 文字 \| A \| 用 B \| 文字題，待比對 \|/);
  assert.match(out, /\| app\/PROJ-1 \| Orca 分頁直接輸入 \| 要 \| 先不用 \| 文字題，待比對 \|/);
  assert.equal((out.match(/用 B/g) ?? []).length, 1, "重複的那句只出現一次");
});

test("report：四張表——常卡的問題依票與問題開頭計數、等待時間、token 與費用（含中控台）、偏離建議（選單標記）", () => {
  const events = [
    { ts: "2026-10-02T01:00:00Z", event: "stop", repo: "app", ticket: "PROJ-2", handle: "h", status: "permission", question: "Bash npm test -- --grep login", suggestion: null },
    { ts: "2026-10-02T01:00:20Z", event: "answer", repo: "app", ticket: "PROJ-2", handle: "h", via: "permission", answer: "允許", delivery: "delivered" },
    { ts: "2026-10-02T01:01:00Z", event: "stop", repo: "app", ticket: "PROJ-2", handle: "h", status: "permission", question: "Bash npm test -- --grep signup", suggestion: null },
    { ts: "2026-10-02T01:02:00Z", event: "stop", repo: "app", ticket: "PROJ-2", handle: "h", status: "waiting", question: "要哪個顏色？", suggestion: "綠" },
    { ts: "2026-10-02T01:02:10Z", event: "answer", repo: "app", ticket: "PROJ-2", handle: "h", via: "menu", suggestion: "綠", answer: "顏色→紅", offSuggestion: true, delivery: "delivered" },
  ];
  const tokens = {
    buckets: {
      中控台: { ticket: "中控台", computedAt: "T2", models: { "claude-opus-5-5": { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, usd: 0.5 } } },
      "app/PROJ-2": { ticket: "PROJ-2", computedAt: "T1", models: { "claude-opus-5-5": { input: 1000, output: 2, cacheWrite: 3, cacheRead: 4, usd: 1.25 } } },
    },
  };
  const out = reportLines(events, tokens);
  const text = out.join("\n");
  for (const h of ["### 常卡的問題", "### 等待時間（停下到回答送達）", "### token 與費用", "### 偏離建議的回答"]) assert.ok(out.includes(h), h);
  assert.match(text, /\| app\/PROJ-2 \| Bash npm test -- --g \| 🔐 等待授權 \| 2 \|/, "問題開頭（前 20 字）相同的歸成一組");
  assert.match(text, /\| app\/PROJ-2 \| claude-opus-5-5 \| 1,000 \| 2 \| 3 \| 4 \| \$1\.25 \| T1 \|/);
  assert.match(text, /\| 中控台 \| claude-opus-5-5 \| 1 \| 2 \| 3 \| 4 \| \$0\.50 \| T2 \|/);
  assert.match(text, /\| app\/PROJ-2 \| 選單 \| 綠 \| 顏色→紅 \| 選了非建議選項 \|/);
  assert.match(text, /\| app\/PROJ-2 \| 2 \| 15 秒 \| 20 秒 \| 1 \|/);
});

function runHook(command, { env = {}, input = {} } = {}) {
  const res = spawnSync(process.execPath, [hook, command], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ORCA_TERMINAL_HANDLE: "", ...env },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

test("hook：不在 Orca 分頁、或 worktree 不歸中控台管、或是中控台自己時，不寫檔也不輸出", () => {
  const dir = freshLog();
  const managed = path.join(tmp, "managed-wt");
  fs.mkdirSync(managed, { recursive: true });
  const input = { session_id: "s1", transcript_path: "/x/s1.jsonl", cwd: managed, prompt: "你好" };
  for (const command of ["session-start", "user-prompt"]) {
    const res = runHook(command, { input });
    assert.deepEqual([res.code, res.out], [0, ""]);
  }
  assert.ok(!fs.existsSync(dir), "沒有中控台紀錄時連目錄都不建");
  writeManaged({ worktrees: [{ path: managed, repo: "app", ticket: "PROJ-5" }], repos: [], consoles: ["term_console"], handles: {} });
  const other = path.join(tmp, "elsewhere");
  fs.mkdirSync(other, { recursive: true });
  for (const [env, cwd] of [
    [{}, managed],
    [{ ORCA_TERMINAL_HANDLE: "term_x" }, other],
    [{ ORCA_TERMINAL_HANDLE: "term_console" }, managed],
  ]) {
    for (const command of ["session-start", "user-prompt"]) {
      const res = runHook(command, { env, input: { ...input, cwd } });
      assert.deepEqual([res.code, res.out], [0, ""]);
    }
  }
  assert.deepEqual(dayFile(dir), []);
});

test("hook：受管 worktree 的 Orca 分頁——SessionStart 登記分頁↔session_id↔對話紀錄路徑，UserPromptSubmit 記收到的話前 120 字，都不輸出", () => {
  const dir = freshLog();
  const managed = path.join(tmp, "managed-wt2");
  fs.mkdirSync(path.join(managed, "sub"), { recursive: true });
  writeManaged({ worktrees: [{ path: managed, repo: "app", ticket: "PROJ-6" }], repos: [], consoles: [], handles: {} });
  const env = { ORCA_TERMINAL_HANDLE: "term_child", ORCA_PANE_KEY: "tab:leaf" };
  const start = runHook("session-start", { env, input: { session_id: "sid-1", source: "clear", transcript_path: "/p/sid-1.jsonl", cwd: path.join(managed, "sub") } });
  const prompt = runHook("user-prompt", { env, input: { session_id: "sid-1", cwd: managed, prompt: "好".repeat(200) } });
  assert.deepEqual([start.out, prompt.out], ["", ""]);
  const events = readEvents();
  assert.equal(events.length, 2);
  assert.deepEqual(
    { ...events[0], ts: undefined },
    { ts: undefined, event: "session", repo: "app", ticket: "PROJ-6", handle: "term_child", paneKey: "tab:leaf", sessionId: "sid-1", role: "child", source: "clear", transcript: "/p/sid-1.jsonl", path: managed, cwd: path.join(managed, "sub") },
  );
  assert.equal(events[1].event, "prompt");
  assert.equal(events[1].text, "好".repeat(120));
  assert.ok(dir);
});

test("token：主 checkout 只算有登記的 session，不把整個資料夾的歷史對話都算進來", () => {
  freshLog();
  const main = path.join(tmp, "main-co");
  const dir = path.join(tmp, "projects", main.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "old.jsonl"), JSON.stringify(reply("o1", U)) + "\n");
  fs.writeFileSync(path.join(dir, "mine.jsonl"), JSON.stringify(reply("n1", U)) + "\n");
  writeManaged({ worktrees: [{ path: main, repo: "app", ticket: "dev", main: true }], repos: [], consoles: [], handles: {} });
  logEvent("session", { role: "child", repo: "app", ticket: "dev", sessionId: "mine", transcript: path.join(dir, "mine.jsonl"), path: main });
  const b = computeTokens().buckets["app/dev"];
  assert.deepEqual(Object.keys(b.sessions), ["mine"]);
  assert.equal(b.models["claude-opus-5-5"].output, 100);
});

test("session 編號：有分頁代號的事件換成該分頁目前登記的 session（/clear 後換新的），只有 worktree 路徑的帶該路徑登記過的 session 清單", () => {
  freshLog();
  logEvent("session", { role: "child", handle: "h1", sessionId: "s-old", path: "/wt/a" });
  logEvent("stop", { handle: "h1", status: "waiting" });
  logEvent("session", { role: "child", handle: "h1", sessionId: "s-new", path: "/wt/a", source: "clear" });
  logEvent("answer", { handle: "h1", via: "text" });
  logEvent("prompt", { handle: "h1", sessionId: "given" });
  logEvent("stop", { handle: "h-unknown" });
  logEvent("close", { path: "/wt/a", ok: true });
  const ev = readEvents().filter((e) => e.event !== "session");
  assert.deepEqual(ev.map((e) => ("sessionId" in e ? e.sessionId : e.sessionIds)), ["s-old", "s-new", "given", null, ["s-old", "s-new"]]);
});

const at = (s) => new Date(Date.parse("2026-10-02T01:00:00Z") + s * 1000).toISOString();
const row = (type, s, extra = {}) => ({ type, timestamp: at(s), ...extra });
const userMsg = (s, content, extra) => row("user", s, { message: { role: "user", content }, ...extra });
const said = (s, content = [{ type: "text", text: "ok" }]) => row("assistant", s, { message: { id: `m${s}`, content } });
const result = (s) => userMsg(s, [{ type: "tool_result", tool_use_id: "t", content: "ok" }]);

test("對話紀錄掃描：skill（工具呼叫、斜線指令、子代理）、你送來的輪數、每段處理起訖，停下時間校正到停下前最後一則回覆", () => {
  const file = transcript("activity", [
    userMsg(0, "<command-name>/agent-skills:define-goal</command-name> <command-args>PROJ-1</command-args>"),
    said(5, [{ type: "tool_use", id: "t", name: "Skill", input: { skill: "other-plugin:branch-naming" } }]),
    result(6),
    said(20),
    userMsg(21, "<local-command-stdout>略</local-command-stdout>"),
    userMsg(22, "Caveat", { isMeta: true }),
    userMsg(100, "用紅色"),
    said(130),
    userMsg(200, "<task-notification><task-id>x</task-id></task-notification>"),
    said(210),
  ]);
  const sub = file.replace(/\.jsonl$/, "/subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-x.jsonl"), JSON.stringify(said(150, [{ type: "tool_use", id: "u", name: "Skill", input: { skill: "other-plugin:speak-human" } }])) + "\n");
  const a = transcriptActivity(file, [{ ts: at(28) }, { ts: at(139) }, { ts: at(1) }]);
  assert.deepEqual(a.skills.map((x) => x.name), ["other-plugin:branch-naming", "other-plugin:speak-human"]);
  assert.deepEqual(a.commands.map((x) => x.name), ["agent-skills:define-goal"]);
  assert.equal(a.turns, 2, "工作通知不算你送的一輪；local-command 與 isMeta 不算");
  assert.deepEqual(a.segments.map((g) => [g.start, g.end, g.prompt]), [[at(0), at(20), true], [at(100), at(130), true], [at(200), at(210), false]]);
  assert.deepEqual(a.stopTimes, { [at(28)]: at(20), [at(139)]: at(130) });
  assert.deepEqual([a.firstAt, a.lastAt], [at(0), at(210)]);
});

test("重算 token 時一併寫入每個 session 的活動；停下事件的等待時間改用校正後的時間", () => {
  freshLog();
  const wt = path.join(tmp, "wt-act");
  const dir = path.join(tmp, "projects", wt.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "s1.jsonl"), [userMsg(0, "開工"), said(10)].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeManaged({ worktrees: [{ path: wt, repo: "app", ticket: "PROJ-8" }], repos: [], consoles: [], handles: {} });
  logEvent("session", { role: "child", handle: "h8", sessionId: "s1", path: wt, transcript: path.join(dir, "s1.jsonl") });
  const stop = { ts: at(18), event: "stop", repo: "app", ticket: "PROJ-8", handle: "h8", sessionId: "s1", status: "waiting", question: "？" };
  fs.appendFileSync(dayFile(process.env.WORKTREE_CONSOLE_LOG_DIR)[0], JSON.stringify(stop) + "\n");
  const tokens = computeTokens();
  assert.equal(tokens.buckets["app/PROJ-8"].sessions.s1.activity.stopTimes[at(18)], at(10));
  const reply = { ts: at(40), event: "answer", repo: "app", ticket: "PROJ-8", handle: "h8", sessionId: "s1", via: "text", answer: "好", delivery: "delivered" };
  const text = reportLines([stop, reply], tokens).join("\n");
  assert.match(text, /\| app\/PROJ-8 \| 1 \| 30 秒 \| 30 秒 \| 0 \|/, "從 10 秒算到 40 秒，不是從 watcher 看到的 18 秒");
});

test("report 每個 session 一列：觸發、skill、停下、回應中位數、處理時間扣掉等你、完畢後再指令次數、總時間、產出", () => {
  const activity = {
    skills: [{ name: "other-plugin:branch-naming", at: at(5) }],
    commands: [{ name: "goal", at: at(0) }],
    turns: 3,
    segments: [
      { start: at(0), end: at(60), prompt: true },
      { start: at(100), end: at(160), prompt: true },
      { start: at(300), end: at(330), prompt: true },
    ],
    firstAt: at(0),
    lastAt: at(330),
    stopTimes: {},
  };
  const tokens = { buckets: { "app/PROJ-3": { path: "/wt/3", ticket: "PROJ-3", sessions: { "abcdef1234567890": { activity, models: {} } }, models: {} } } };
  const base = { repo: "app", ticket: "PROJ-3", handle: "h3", sessionId: "abcdef1234567890" };
  const events = [
    { ts: at(-5), event: "session", ...base, role: "child", source: "startup" },
    { ts: at(1), event: "prompt", ...base, text: "PROJ-3 開工" },
    { ts: at(2), event: "start", repo: "app", ticket: "PROJ-3", path: "/wt/3", ok: true, sessionIds: ["abcdef1234567890"] },
    { ts: at(30), event: "stop", ...base, status: "waiting", question: "選單？" },
    { ts: at(50), event: "answer", ...base, via: "menu", answer: "1", delivery: "delivered" },
    { ts: at(60), event: "stop", ...base, status: "done", question: "做完了。" },
    { ts: at(100), event: "prompt", ...base, text: "再改一下" },
    { ts: at(160), event: "stop", ...base, status: "done", question: "改好了。" },
    { ts: at(300), event: "prompt", ...base, text: "再改" },
    { ts: at(400), event: "close", repo: "app", ticket: "PROJ-3", path: "/wt/3", ok: true, output: { commits: 2, files: 3, insertions: 40, deletions: 5, pushed: true, stage: "已 push" } },
  ];
  const out = reportLines(events, tokens);
  assert.ok(out.includes("### 每個 session"));
  const line = out.find((l) => l.startsWith("| app/PROJ-3 | abcdef12 |"));
  assert.equal(
    line,
    "| app/PROJ-3 | abcdef12 | 新開，首句：開工指令 | other-plugin:branch-naming、/goal | 3 | 40 秒 | 2 分 10 秒 | 2 | 5 分 30 秒 | 2 commit，3 檔 +40/-5，已 push，已 push |",
  );
});

function withSession(id, fn) {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = id;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
}

// A conversation that loaded the worktree-console skill, which is what makes a session a console.
const consoleTranscript = (sessionId) =>
  transcript(sessionId, [{ type: "user", message: { content: [{ type: "text", text: "Base directory for this skill: /x/skills/worktree-console\n\n# Worktree Console" }] } }]);

test("hook：中控台交棒開出的新分頁在登記前不記 session 與 prompt，登記後只有 role: console 那筆；一般子 session 交棒照記", () => {
  freshLog();
  const managed = path.join(tmp, "managed-takeover");
  fs.mkdirSync(managed, { recursive: true });
  writeManaged({ worktrees: [{ path: managed, repo: "app", ticket: "PROJ-8" }], repos: [], consoles: [], handles: {} });
  const home = path.join(tmp, "handoff-takeover");
  fs.mkdirSync(path.join(home, "events"), { recursive: true });
  const event = (name, fields) => fs.writeFileSync(path.join(home, "events", `${name}.json`), JSON.stringify({ oldHandle: `old-${name}`, status: "switching", updatedAt: Date.now(), ...fields }));
  event("con", { isConsole: true, newHandle: "term_con_new" });
  event("kid", { isConsole: false, newHandle: "term_kid_new" });
  for (const handle of ["term_con_new", "term_kid_new"]) {
    const env = { ORCA_TERMINAL_HANDLE: handle, AUTO_HANDOFF_HOME: home };
    runHook("session-start", { env, input: { session_id: `sid-${handle}`, source: "startup", cwd: managed } });
    runHook("user-prompt", { env, input: { session_id: `sid-${handle}`, cwd: managed, prompt: "接手交棒：先完整讀 /n.md" } });
  }
  consoleTranscript("sid-term_con_new");
  withSession("sid-term_con_new", () => registerConsole({ handle: "term_con_new", paneKey: "tab:leaf", repo: "app" }));
  const con = readEvents().filter((e) => e.handle === "term_con_new");
  assert.deepEqual(con.map((e) => [e.event, e.role, e.ticket]), [["session", "console", "中控台"]]);
  const kid = readEvents().filter((e) => e.handle === "term_kid_new");
  assert.deepEqual(kid.map((e) => [e.event, e.role ?? null, e.ticket]), [["session", "child", "PROJ-8"], ["prompt", null, "PROJ-8"]]);
});

test("登記中控台：刪掉同分頁自最近一次 startup 起的 session、prompt（跨午夜兩個檔都處理），更早當子 session 的紀錄與其他分頁一筆不少", () => {
  const dir = freshLog();
  const local = (d, h, m) => new Date(2026, 9, d, h, m).toISOString();
  const lines = {
    "2026-10-02": [
      { ts: local(2, 9, 0), event: "session", role: "child", handle: "h1", sessionId: "old-kid", source: "startup", ticket: "PROJ-1" },
      { ts: local(2, 9, 1), event: "prompt", handle: "h1", sessionId: "old-kid", text: "舊的子 session" },
      { ts: local(2, 23, 58), event: "session", role: "child", handle: "h1", sessionId: "con", source: "startup", ticket: "" },
      { ts: local(2, 23, 58), event: "session", role: "child", handle: "h2", sessionId: "other", source: "startup", ticket: "PROJ-2" },
      { ts: local(2, 23, 59), event: "prompt", handle: "h1", sessionId: "con", text: "開中控台" },
      { ts: local(2, 23, 59), event: "stop", handle: "h1", status: "waiting" },
    ],
    "2026-10-03": [
      { ts: local(3, 0, 1), event: "prompt", handle: "h2", sessionId: "other", text: "別的分頁" },
      { ts: local(3, 0, 2), event: "session", role: "child", handle: "h1", sessionId: "con2", source: "clear", ticket: "" },
      { ts: local(3, 0, 3), event: "prompt", handle: "h1", sessionId: "con2", text: "看板" },
    ],
  };
  fs.mkdirSync(dir, { recursive: true });
  for (const [d, list] of Object.entries(lines)) fs.writeFileSync(path.join(dir, `${d}.jsonl`), list.map((e) => JSON.stringify(e)).join("\n") + "\n");
  consoleTranscript("con2");
  withSession("con2", () => registerConsole({ handle: "h1", paneKey: "tab:leaf", repo: "app" }));
  const left = readEvents().map((e) => [e.handle, e.event, e.sessionId ?? null, e.role ?? null]);
  assert.deepEqual(left.slice(0, -1), [
    ["h1", "session", "old-kid", "child"],
    ["h1", "prompt", "old-kid", null],
    ["h2", "session", "other", "child"],
    ["h1", "stop", null, null],
    ["h2", "prompt", "other", null],
  ]);
  assert.deepEqual(left.at(-1), ["h1", "session", "con2", "console"]);
  withSession("con2", () => registerConsole({ handle: "h1", paneKey: "tab:leaf", repo: "app" }));
  assert.equal(readEvents().length, left.length, "已登記過就不再動紀錄");
});
