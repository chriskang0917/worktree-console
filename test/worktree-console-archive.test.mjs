import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveDir,
  archiveTranscripts,
  backfillConsoles,
  commitLog,
  consoleCalls,
  distillList,
  distillReminder,
  logEvent,
  markDistilled,
  readEntries,
  readEvents,
  subagentFiles,
} from "../skills/worktree-console/scripts/log.mjs";
import { consoleRounds, sessionTokens, suggestionOutcomes, usageLines } from "../skills/worktree-console/scripts/console-usage.mjs";

let tmp;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-archive-")));
  process.env.CLAUDE_PROJECTS_DIR = path.join(tmp, "projects");
  process.env.WORKTREE_CONSOLE_HOME = path.join(tmp, "console-home");
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function freshLog() {
  const dir = fs.mkdtempSync(path.join(tmp, "log-"));
  fs.rmSync(dir, { recursive: true });
  process.env.WORKTREE_CONSOLE_LOG_DIR = dir;
  return dir;
}

let seq = 0;
function transcript(name, entries, folder = "-wt") {
  const file = path.join(tmp, "projects", folder, `${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n");
  return file;
}

function subagent(file, name, entries) {
  const dir = file.replace(/\.jsonl$/, "/subagents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const U = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 };
const T = (m) => new Date(Date.parse("2026-10-02T01:00:00Z") + m * 60_000).toISOString();
const reply = (id, at, text = "x", extra = {}) => ({ type: "assistant", timestamp: at, message: { id, model: "claude-opus-5-5", usage: U, content: [{ type: "text", text }] }, ...extra });
const bash = (id, at, command, toolId = `toolu_${++seq}`) => ({
  type: "assistant",
  timestamp: at,
  message: { id, model: "claude-opus-5-5", usage: U, content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command } }] },
});
const said = (at, text) => ({ type: "user", timestamp: at, message: { content: text } });
const result = (at, text) => ({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "x", content: text }] } });
const notice = (at, toolId) => said(at, `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n</task-notification>`);
const register = (sessionId, file, role = "child") => logEvent("session", { role, ticket: role === "console" ? "中控台" : "PROJ-1", sessionId, transcript: file });
const copies = () => (fs.existsSync(archiveDir()) ? fs.readdirSync(archiveDir()).filter((f) => f.endsWith(".jsonl")) : []);
const lines = (file) => fs.readFileSync(file, "utf8").trim().split("\n");

test("複製：登記過的 session（子代理併進同一份）複製進 transcripts/，該目錄被 .gitignore 排除，git ls-files 不含任何複製檔；檔數等於登記過且原檔仍在的 session 數", () => {
  const dir = freshLog();
  const a = transcript("sid-a", [reply("a1", T(0))]);
  subagent(a, "agent-1", [reply("s1", T(1), "sub", { isSidechain: true })]);
  const b = transcript("sid-b", [reply("b1", T(0))]);
  register("sid-a", a, "console");
  register("sid-b", b);
  register("sid-gone", path.join(tmp, "projects", "-wt", "missing.jsonl"));
  assert.equal(commitLog({ force: true }), true);
  assert.deepEqual(copies().sort(), ["sid-a.jsonl", "sid-b.jsonl"]);
  assert.equal(lines(path.join(archiveDir(), "sid-a.jsonl")).length, 2, "子代理的列併在同一份");
  const tracked = spawnSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" }).stdout.trim().split("\n");
  assert.ok(tracked.includes(".gitignore"));
  assert.ok(!tracked.some((f) => f.startsWith("transcripts/")), tracked.join(","));
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^transcripts\/$/m);
});

test("複製：舊的紀錄目錄（.gitignore 只有 .state/）也補上 transcripts/", () => {
  const dir = freshLog();
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["-C", dir, "init", "-q"]);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".state/\n");
  logEvent("stop", { ticket: "A" });
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), ".state/\ntranscripts/\n");
});

test("複製：同一個 session 新的覆蓋舊的；原檔已不存在、或新的比舊的少行時保留舊副本", () => {
  freshLog();
  const file = transcript("sid-keep", [reply("k1", T(0)), reply("k2", T(1))]);
  register("sid-keep", file);
  const out = () => path.join(archiveDir(), "sid-keep.jsonl");
  archiveTranscripts();
  assert.equal(lines(out()).length, 2);
  transcript("sid-keep", [reply("k1", T(0)), reply("k2", T(1)), reply("k3", T(2))]);
  archiveTranscripts();
  assert.equal(lines(out()).length, 3, "變多就覆蓋");
  transcript("sid-keep", [reply("k9", T(5))]);
  archiveTranscripts();
  assert.equal(lines(out()).length, 3, "變少保留舊副本");
  assert.match(fs.readFileSync(out(), "utf8"), /"k3"/);
  fs.rmSync(file);
  archiveTranscripts();
  assert.equal(lines(out()).length, 3, "原檔消失保留舊副本");
});

test("複製：逐行解析 JSON 只遮罩文字值，複製檔與原檔依 message.id 去重加總的 token 相同；解析不了的行整行遮罩", () => {
  freshLog();
  const leak = { type: "user", timestamp: T(0), message: { content: "token=abc123secretvalue 跟 \"input_tokens\": 5" } };
  const file = transcript("sid-mask", [leak, reply("m1", T(1)), reply("m1", T(1)), reply("m2", T(2)), "{broken password=hunter2xyz"]);
  subagent(file, "agent-x", [reply("s1", T(3), "sub", { isSidechain: true }), reply("s1", T(3), "sub", { isSidechain: true })]);
  register("sid-mask", file);
  archiveTranscripts();
  const copy = path.join(archiveDir(), "sid-mask.jsonl");
  const text = fs.readFileSync(copy, "utf8");
  assert.ok(!text.includes("abc123secretvalue"));
  assert.ok(!text.includes("hunter2xyz"));
  assert.match(text, /"input_tokens":10/, "數字欄位不被遮罩");
  const original = [...readEntries(file), ...subagentFiles(file).flatMap((f) => readEntries(f))];
  assert.equal(sessionTokens(readEntries(copy)), sessionTokens(original));
  assert.equal(sessionTokens(original), 3 * (10 + 100 + 1000 + 10000));
  assert.equal(lines(copy).at(-3), "{broken password=[已遮罩]");
});

test("遮罩：8 類樣本各一筆，寫進事件與複製檔後原值都不出現", () => {
  const dir = freshLog();
  const samples = {
    aws: "AKIAIOSFODNN7EXAMPLE",
    key: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAPRIVATEBODY\n-----END OPENSSH PRIVATE KEY-----",
    gitlab: "glpat-AbCdEfGhIjKlMnOpQrSt12",
    sk: "sk-proj-abcdefghijklmnopqrstuv",
    assign: "password=hunter2-assign-value",
    url: "postgres://admin:Pa55w0rdInUrl@db.internal:5432/app",
    bearer: "Authorization: Bearer opaqueBearerTok3n.value",
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  };
  const secrets = [
    "AKIAIOSFODNN7EXAMPLE",
    "b3BlbnNzaC1rZXktdjEAAAAPRIVATEBODY",
    "glpat-AbCdEfGhIjKlMnOpQrSt12",
    "sk-proj-abcdefghijklmnopqrstuv",
    "hunter2-assign-value",
    "Pa55w0rdInUrl",
    "opaqueBearerTok3n",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ];
  const entries = Object.values(samples).map((v, i) => said(T(i), `看這個 ${v}`));
  const file = transcript("sid-secrets", entries);
  for (const v of Object.values(samples)) logEvent("prompt", { text: v });
  register("sid-secrets", file);
  archiveTranscripts();
  const events = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  const copy = fs.readFileSync(path.join(archiveDir(), "sid-secrets.jsonl"), "utf8");
  for (const s of secrets) {
    assert.ok(!events.includes(s), `事件紀錄不該出現：${s}`);
    assert.ok(!copy.includes(s), `複製檔不該出現：${s}`);
  }
  assert.match(copy, /postgres:\/\/\[帳密已遮罩\]@db\.internal/);
  assert.match(copy, /Bearer \[已遮罩\]/);
  assert.match(copy, /\[JWT 已遮罩\]/);
});

test("補登記：載入過 worktree-console skill 且跑過 board 的舊對話紀錄登記成中控台，只跑一次；只看過檔案的不算", () => {
  freshLog();
  const skill = { type: "user", timestamp: T(0), isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill: /x/skills/worktree-console\n\n# Worktree Console" }] } };
  const old = transcript("old-console", [said(T(0), "/worktree-console:worktree-console"), skill, bash("o1", T(1), "S=/x/scripts/console.mjs; node $S board --repo R")], "-old");
  transcript("reader", [said(T(0), "看 skills/worktree-console"), bash("r1", T(1), "cat /x/skills/worktree-console/scripts/console.mjs board.txt")], "-old");
  const found = backfillConsoles();
  assert.deepEqual(found.map((c) => c.sessionId), ["old-console"]);
  const ev = readEvents().filter((e) => e.event === "session");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].role, "console");
  assert.equal(ev[0].transcript, old);
  assert.deepEqual(backfillConsoles(), [], "第二次不再掃");
});

test("蒸餾提醒：第 19 份不提醒、第 20 份提醒並寫路徑清單、同一批不重複、中控台重啟再提醒、標記後歸零、標記後重啟不提醒", () => {
  freshLog();
  const add = (i) => register(`sid-${String(i).padStart(2, "0")}`, transcript(`sid-${String(i).padStart(2, "0")}`, [reply(`d${i}`, T(i))]));
  for (let i = 1; i <= 19; i++) add(i);
  archiveTranscripts();
  assert.equal(distillReminder(), null, "第 19 份不提醒");
  add(20);
  archiveTranscripts();
  const line = distillReminder();
  assert.match(line, /^\[蒸餾\] 已保存 20 份.*已蒸餾/);
  assert.ok(line.includes(distillList()));
  const listed = fs.readFileSync(distillList(), "utf8").trim().split("\n");
  assert.equal(listed.length, 20);
  assert.ok(listed.every((p) => p.startsWith(archiveDir()) && fs.existsSync(p)));
  assert.equal(distillReminder(), null, "同一批不重複提醒");
  assert.match(distillReminder({ start: true }), /^\[蒸餾\]/, "未標記時中控台啟動再提醒");
  assert.match(markDistilled(), /已標記處理到第 20 份/);
  assert.equal(distillReminder({ start: true }), null, "標記後歸零，重啟也不提醒");
  for (let i = 21; i <= 39; i++) add(i);
  archiveTranscripts();
  assert.equal(distillReminder({ start: true }), null, "下一批第 19 份不提醒");
  add(40);
  archiveTranscripts();
  assert.match(distillReminder(), /已保存 20 份/);
  assert.match(fs.readFileSync(distillList(), "utf8"), /sid-21\.jsonl/);
});

test("子指令：直接路徑、變數別名都算，讀檔不算", () => {
  assert.deepEqual(consoleCalls('S=/p/scripts/console.mjs; node $S send --terminal t -- "x"; node "$S" after-send --repo R a'), ["send", "after-send"]);
  assert.deepEqual(consoleCalls("node /p/scripts/console.mjs detail --repo R 6923 && node $B/scripts/console.mjs board"), ["detail", "board"]);
  assert.deepEqual(consoleCalls("cat /p/scripts/console.mjs lib.mjs; sed -n 1,9p console.mjs"), []);
});

function consoleFixture() {
  const watch = "toolu_watch";
  const other = "toolu_other";
  return [
    said(T(0), "/worktree-console:worktree-console"),
    bash("c1", T(0.1), "node /p/console.mjs board --repo R"),
    bash("c2", T(0.2), "node /p/watch.mjs", watch),
    bash("c3", T(0.3), "sleep 100", other),
    said(T(1), "6923 詳情"),
    bash("c4", T(1.1), "node /p/console.mjs detail --repo R 6923"),
    reply("c5", T(1.2), "[PROJ-6923] 詳情\n摘要：x\n\n[PROJ-6923] 卡在命名。\n1. 用 fetchOrders\n照這樣回嗎？\n\n[menu] 回完了，下一步該叫它 commit。\n要送嗎？"),
    said(T(2), "6923 照建議；menu 照建議，第 1 題改成 push"),
    bash("c6", T(2.1), 'S=/p/console.mjs; node $S send --terminal a -- "命名用 fetchOrders"; node $S after-send --repo R PROJ-6923 menu'),
    notice(T(3), watch),
    bash("c7", T(3.1), "cat out"),
    result(T(3.2), "### 💬 PROJ-6923 等你回應\n\n> 下一題"),
    said(T(4), "logging 詳情"),
    bash("c8", T(4.1), "node /p/console.mjs detail --repo R logging"),
    reply("c9", T(4.2), "[logging] 卡在範圍。\n1. 只做提醒\n照這樣回嗎？\n\n[stage] 該叫它跑測試。\n要送嗎？"),
    said(T(5), "logging 我自己寫的回答"),
    notice(T(6), other),
    reply("c10", T(6.1), "背景跑完了", { message: { id: "c10", model: "claude-opus-5-5", usage: U, content: [{ type: "text", text: "背景跑完了" }] } }),
    reply("sub1", T(4.5), "sub", { isSidechain: true }),
  ];
}

test("report 中控台 token：一輪依「誰觸發 × 子指令組合」分類，各類總 token 加總等於中控台 session 總 token（同一份去重口徑）", () => {
  const entries = [...consoleFixture(), reply("c5", T(1.2)), reply("before", T(-1))];
  const rounds = consoleRounds(entries);
  assert.deepEqual(
    rounds.map((r) => [r.trigger, [...new Set(r.calls)].sort().join("+")]),
    [
      ["你的訊息", "board"],
      ["你的訊息", "detail"],
      ["你的訊息", "after-send+send"],
      ["watcher 回報", ""],
      ["你的訊息", "detail"],
      ["你的訊息", ""],
      ["其他背景通知", ""],
    ],
  );
  assert.equal(
    rounds.reduce((n, r) => n + r.tokens, 0),
    sessionTokens(entries),
  );
  assert.equal(rounds[4].tokens, 3 * 11110, "子代理的回覆依時間算進當時那一輪");
});

test("report 詳情建議去向：照建議、改了再送、自己另寫（含直接在 Orca 分頁打字）、沒回；到該 session 下次停下為止", () => {
  const rounds = consoleRounds(consoleFixture());
  const typed = [{ ts: T(4.6), ticket: "stage", via: "typed" }];
  const got = suggestionOutcomes(rounds, typed).map((x) => [x.tag, x.outcome]);
  assert.deepEqual(got, [
    ["PROJ-6923", "照建議"],
    ["menu", "改了再送"],
    ["logging", "自己另寫"],
    ["stage", "自己另寫"],
  ]);
  const late = consoleRounds([...consoleFixture(), said(T(7), "6923 照建議")]);
  assert.equal(suggestionOutcomes(late)[0].outcome, "照建議", "停下前的那次回覆才算");
  const silent = consoleRounds(consoleFixture().slice(0, 9));
  assert.deepEqual(suggestionOutcomes(silent.slice(0, 2)).map((x) => x.outcome), ["沒回", "沒回"]);
});

test("report：多三張表，從複製後的中控台對話紀錄算出；指令用量另列 SKILL.md 有寫但期間零次的子指令", () => {
  freshLog();
  const file = transcript("console-r", consoleFixture());
  register("console-r", file, "console");
  archiveTranscripts();
  fs.rmSync(file);
  const text = usageLines(0, { documented: ["board", "detail", "send", "after-send", "close", "todo"] }).join("\n");
  assert.match(text, /### 指令用量/);
  assert.match(text, /\| detail \| 2 \|/);
  assert.match(text, /\| close \| 0 \|/);
  assert.match(text, /SKILL\.md 有寫但期間零次：close、todo/);
  assert.match(text, /### 詳情建議去向/);
  assert.match(text, /\| 照建議 \| 1 \| PROJ-6923（/);
  assert.match(text, /\| 沒回 \| 1 \| stage（/);
  assert.match(text, /### 中控台 token/);
  assert.match(text, /\| 你的訊息 \| detail \| 2 \|/);
  const totals = [...text.matchAll(/^\| [^|]+ \| [^|]+ \| \d+ \| ([\d,]+) \|/gm)].map((m) => Number(m[1].replace(/,/g, "")));
  assert.equal(
    totals.reduce((a, b) => a + b, 0),
    sessionTokens(readEntries(path.join(archiveDir(), "console-r.jsonl"))),
  );
});
