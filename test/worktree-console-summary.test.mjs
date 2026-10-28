import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeManaged } from "../skills/worktree-console/scripts/log.mjs";
import { modelCommand, pendingFile, readSummary, summaryFile, summaryModel, usageFile } from "../skills/worktree-console/scripts/summary.mjs";
import { focusPayload } from "../skills/worktree-console/scripts/focus.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "skills", "worktree-console", "scripts", "summary.mjs");
let tmp;
let managed;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-summary-")));
  process.env.WORKTREE_CONSOLE_LOG_DIR = path.join(tmp, "log");
  process.env.AUTO_HANDOFF_HOME = path.join(tmp, "handoff");
  managed = path.join(tmp, "wt-child");
  fs.mkdirSync(path.join(managed, "sub"), { recursive: true });
  writeManaged({ worktrees: [{ path: managed, repo: "app", ticket: "PROJ-6" }], repos: [], consoles: [], handles: {} });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const freshHome = () => fs.mkdtempSync(path.join(tmp, "home-"));
const REPLY = "登入頁改好了，測試全部通過。要不要也改註冊頁？";
const OK_JSON = { type: "result", is_error: false, result: "登入頁改好了，測試都過。等你決定要不要改註冊頁。", total_cost_usd: 0.0123, usage: { input_tokens: 812, output_tokens: 64, cache_creation_input_tokens: 0, cache_read_input_tokens: 2048 }, modelUsage: { "claude-sonnet-5-5": {} } };

// A stand-in for `claude -p`: records each call (model, stdin, whether the tab's terminal variables reached it), then answers `out`.
function fakeModel(home, { out = JSON.stringify(OK_JSON), code = 0, sleep = 0 } = {}) {
  const calls = path.join(home, "calls.log");
  const reply = path.join(home, "reply.json");
  fs.writeFileSync(reply, out);
  return `n=$(cat); printf '%s|%s|%s\\n' "$WORKTREE_CONSOLE_SUMMARY_MODEL" "\${ORCA_TERMINAL_HANDLE:-none}" "$(printf '%s' "$n" | tr '\\n' ' ')" >> '${calls}'; ${sleep ? `sleep ${sleep};` : ""} cat '${reply}'; exit ${code}`;
}

const calls = (home) => {
  try {
    return fs.readFileSync(path.join(home, "calls.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

function stopHook(home, { env = {}, input = {} } = {}) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [script, "stop"], {
    input: JSON.stringify({ session_id: "sid-child", cwd: path.join(managed, "sub"), last_assistant_message: REPLY, ...input }),
    encoding: "utf8",
    env: { ...process.env, WORKTREE_CONSOLE_HOME: home, ORCA_TERMINAL_HANDLE: "term_child", ...env },
  });
  return { code: res.status, out: res.stdout, err: res.stderr, ms: Date.now() - started };
}

async function settle(home, handle = "term_child", ms = 8000) {
  const deadline = Date.now() + ms;
  while (fs.existsSync(pendingFile(home, handle)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
}

const usage = (home) => {
  try {
    return fs.readFileSync(usageFile(home), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

test("摘要產生：受管子 session 停下時 hook 立刻結束、不輸出任何東西；背景摘要這一輪回覆並存成這個分頁最新的一份", async () => {
  const home = freshHome();
  const res = stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home, { sleep: 1 }) } });
  assert.deepEqual([res.code, res.out, res.err], [0, "", ""]);
  assert.ok(res.ms < 1000, `hook 花了 ${res.ms}ms，應該不等摘要`);
  assert.equal(readSummary(home, "term_child").pending, true, "背景還在跑時算產生中");
  await settle(home);
  const saved = JSON.parse(fs.readFileSync(summaryFile(home, "term_child"), "utf8"));
  assert.equal(saved.text, OK_JSON.result);
  assert.equal(saved.sessionId, "sid-child");
  assert.deepEqual(readSummary(home, "term_child"), { text: OK_JSON.result, at: saved.at, sessionId: "sid-child", pending: false });
  const [call] = calls(home);
  const [model, handle, stdin] = call.split("|");
  assert.equal(model, "sonnet");
  assert.equal(handle, "none", "背景 claude -p 不帶分頁的終端機變數，不會被當成子 session");
  assert.ok(stdin.includes(REPLY));
});

test("摘要產生：每份摘要只留最新一份，下一次停下覆蓋上一份", async () => {
  const home = freshHome();
  stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home) } });
  await settle(home);
  stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home, { out: JSON.stringify({ ...OK_JSON, result: "第二輪的摘要。" }) }) } });
  await settle(home);
  assert.equal(readSummary(home, "term_child").text, "第二輪的摘要。");
  assert.deepEqual(fs.readdirSync(path.join(home, "summaries")), ["term_child.json"]);
});

test("摘要產生：中控台自己的 session、不受管的 worktree、不在 Orca 或 herdr、背景摘要自己的 claude -p 停下都不摘要", async () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, "consoles.json"), JSON.stringify(["term_console"]));
  const cmd = fakeModel(home);
  const outside = path.join(tmp, "not-managed");
  fs.mkdirSync(outside, { recursive: true });
  for (const run of [
    { env: { ORCA_TERMINAL_HANDLE: "term_console" } },
    { input: { cwd: outside } },
    { env: { ORCA_TERMINAL_HANDLE: "" } },
    { env: { WORKTREE_CONSOLE_SUMMARY_CHILD: "1" } },
  ]) {
    const res = stopHook(home, { ...run, env: { WORKTREE_CONSOLE_SUMMARY_CMD: cmd, ...run.env } });
    assert.deepEqual([res.code, res.out], [0, ""]);
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(calls(home), []);
  assert.equal(fs.existsSync(path.join(home, "summaries")), false);
});

test("用量紀錄：每次摘要呼叫在中控台家目錄的 summary-usage.jsonl 追加一筆時間、session、模型、四種 token 與 total_cost_usd", async () => {
  const home = freshHome();
  stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home) } });
  await settle(home);
  stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home) } });
  await settle(home);
  const lines = usage(home);
  assert.equal(lines.length, 2);
  const [first] = lines;
  assert.ok(!Number.isNaN(Date.parse(first.ts)));
  assert.deepEqual(
    { ...first, ts: null },
    { ts: null, sessionId: "sid-child", handle: "term_child", model: "sonnet", ok: true, inputTokens: 812, outputTokens: 64, cacheCreationTokens: 0, cacheReadTokens: 2048, totalCostUsd: 0.0123, models: ["claude-sonnet-5-5"] },
  );
});

test("用量紀錄：失敗的呼叫回了用量也記一筆（ok: false 與原因）；沒有用量的失敗不記", async () => {
  const home = freshHome();
  stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home, { out: JSON.stringify({ ...OK_JSON, is_error: true, result: "API Error" }), code: 1 }) } });
  await settle(home);
  stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home, { out: "", code: 1 }) } });
  await settle(home);
  const lines = usage(home);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].reason, "exit 1");
  assert.equal(lines[0].totalCostUsd, 0.0123);
  assert.equal(lines[0].inputTokens, 812);
});

test("模型設定：config.json 的 summaryModel 換掉摘要模型，不用改 code；沒設或空字串用 sonnet", async () => {
  const home = freshHome();
  assert.equal(summaryModel(home), "sonnet");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ theme: "dracula", summaryModel: "  " }));
  assert.equal(summaryModel(home), "sonnet");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ theme: "dracula", summaryModel: "haiku" }));
  assert.equal(summaryModel(home), "haiku");
  stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home) } });
  await settle(home);
  assert.equal(calls(home)[0].split("|")[0], "haiku");
  assert.equal(usage(home)[0].model, "haiku");
});

test("背景呼叫：claude -p 帶設定的模型、JSON 輸出、不載工具、skill、MCP 與 hooks，摘要規則寫在系統提示裡", () => {
  const prev = process.env.WORKTREE_CONSOLE_SUMMARY_CMD;
  delete process.env.WORKTREE_CONSOLE_SUMMARY_CMD;
  try {
    const { cmd, args } = modelCommand("haiku");
    assert.equal(cmd, "claude");
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.ok(args.includes("-p"));
    assert.equal(at("--model"), "haiku");
    assert.equal(at("--output-format"), "json");
    assert.equal(at("--tools"), "");
    assert.equal(at("--settings"), '{"disableAllHooks":true}');
    for (const flag of ["--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
    const system = at("--system-prompt");
    for (const rule of ["前提：", "問題：", "沒有就整行省略", "解法：", "建議：", "每行只講一件事", "不超過 30 個中文字", "主動語態", "不要自己替開發者選"]) assert.ok(system.includes(rule), rule);
  } finally {
    if (prev !== undefined) process.env.WORKTREE_CONSOLE_SUMMARY_CMD = prev;
  }
});

test("摘要失敗：逾時或沒有輸出時保留上一份摘要、不重試，產生中標記清掉", async () => {
  const home = freshHome();
  stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home, { out: JSON.stringify({ ...OK_JSON, result: "上一份摘要。" }) }) } });
  await settle(home);
  for (const [extra, out] of [
    [{ WORKTREE_CONSOLE_SUMMARY_TIMEOUT_MS: "300" }, { sleep: 3 }],
    [{}, { out: "" }],
    [{}, { out: JSON.stringify({ ...OK_JSON, result: "   " }) }],
  ]) {
    const before = calls(home).length;
    const res = stopHook(home, { env: { WORKTREE_CONSOLE_SUMMARY_CMD: fakeModel(home, out), ...extra } });
    assert.deepEqual([res.code, res.out], [0, ""]);
    await settle(home);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(calls(home).length, before + 1, "只呼叫一次，不重試");
    assert.deepEqual([readSummary(home, "term_child").text, readSummary(home, "term_child").pending], ["上一份摘要。", false]);
  }
});

test("產生中標記：背景程序死掉沒清標記時，過了逾時再加一分鐘就不算產生中", () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, "summaries"), { recursive: true });
  fs.writeFileSync(pendingFile(home, "term_x"), JSON.stringify({ since: 1_000, timeoutMs: 120_000 }));
  assert.equal(readSummary(home, "term_x", 1_000 + 179_000).pending, true);
  assert.equal(readSummary(home, "term_x", 1_000 + 181_000).pending, false);
});

test("中控台卡片資料帶這個分頁的摘要：有摘要給全文，產生中標 pending，還沒有就是 null", () => {
  const home = freshHome();
  const row = { path: "/wt/a", repo: "app", label: "PROJ-2", ticket: "PROJ-2", branch: "proj-2", title: "x", stage: "實作中", sessions: [{ n: null, handle: "term_a", paneKey: "pane-a", agent: { state: "done" }, status: { kind: "done", text: "做完了" } }] };
  const view = { current: null, queue: [], wait: null, state: { titles: {} } };
  assert.deepEqual(focusPayload([row], view, { home }).payload.sessions[0].brief, { text: null, pending: false });
  fs.mkdirSync(path.join(home, "summaries"), { recursive: true });
  fs.writeFileSync(summaryFile(home, "term_a"), JSON.stringify({ text: "做完了登入頁。", sessionId: "s" }));
  fs.writeFileSync(pendingFile(home, "term_a"), JSON.stringify({ since: Date.now(), timeoutMs: 120_000 }));
  assert.deepEqual(focusPayload([row], view, { home }).payload.sessions[0].brief, { text: "做完了登入頁。", pending: true });
});
