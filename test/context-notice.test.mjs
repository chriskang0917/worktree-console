import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { crossing } from "../hooks/context-notice.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "hooks", "context-notice.mjs");
const SONNET = "claude-sonnet-4-5";
const OPUS_1M = "claude-opus-4-8";

let tmp;
let seq = 0;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notice-")));
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let uuid = 0;
const reply = (model, used, entrypoint = "cli") => ({
  type: "assistant",
  uuid: `a${++uuid}`,
  entrypoint,
  message: { role: "assistant", model, content: [{ type: "text", text: "好了。" }], usage: { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: used - 1003, output_tokens: 50 } },
});

// A fresh home and transcript per scenario; the notice is on unless a test says otherwise.
function scenario(entries, { notice = { enabled: true }, config = {}, env = {}, registry } = {}) {
  const dir = path.join(tmp, `s${++seq}`);
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, "claude"), { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ ...config, ...(notice ? { notice } : {}) }));
  if (registry) {
    fs.mkdirSync(path.join(dir, "console"), { recursive: true });
    fs.writeFileSync(path.join(dir, "console", "disposable.json"), JSON.stringify(registry));
  }
  const transcript = path.join(dir, "t.jsonl");
  const write = (list) => fs.writeFileSync(transcript, list.map((e) => JSON.stringify(e)).join("\n") + "\n");
  write(entries);
  const session = `sess-${seq}`;
  const baseEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORCA_|ANTHROPIC_MODEL|CLAUDE_CODE_DISABLE_1M_CONTEXT|AUTO_HANDOFF_)/.test(k))),
    AUTO_HANDOFF_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
    WORKTREE_CONSOLE_HOME: path.join(dir, "console"),
    ...env,
  };
  const run = (command, input = {}, ...args) => {
    const res = spawnSync(process.execPath, [hook, command, ...args], {
      input: JSON.stringify({ session_id: session, transcript_path: transcript, cwd: dir, ...input }),
      encoding: "utf8",
      env: baseEnv,
    });
    const out = res.stdout.trim();
    let json = null;
    try {
      json = out ? JSON.parse(out) : null;
    } catch {}
    return { code: res.status, out, json, err: res.stderr };
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(home, "context", `${session}.json`), "utf8"));
  return { dir, home, run, write, state, session, transcript };
}

const noticeOf = (r) => r.json?.hookSpecificOutput;

test("context 用量沒到任何門檻：不輸出，狀態檔照樣記下用量", () => {
  const s = scenario([reply(SONNET, 40_000)]);
  const r = s.run("post-tool-use");
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.deepEqual(s.state().notified, []);
  assert.equal(s.state().percent, 20);
});

test("context 用量跨過門檻：PostToolUse 輸出一則帶百分比的中控台自動訊息", () => {
  const s = scenario([reply(SONNET, 70_000)]);
  const r = s.run("post-tool-use");
  assert.equal(r.code, 0);
  assert.equal(noticeOf(r).hookEventName, "PostToolUse");
  assert.match(noticeOf(r).additionalContext, /^（中控台自動訊息，不是使用者的新指令）context 已用 35%（70,000 \/ 200,000 tokens）/);
  assert.deepEqual(s.state().notified, [30]);
});

test("UserPromptSubmit 也會通知，hookEventName 對應事件", () => {
  const s = scenario([reply(SONNET, 70_000)]);
  const r = s.run("user-prompt", { prompt: "繼續" });
  assert.equal(noticeOf(r).hookEventName, "UserPromptSubmit");
  assert.match(noticeOf(r).additionalContext, /已用 35%/);
});

test("同一個門檻只通知一次：transcript 變大但仍在同一級，之後靜默", () => {
  const s = scenario([reply(SONNET, 70_000)]);
  assert.ok(s.run("post-tool-use").json);
  s.write([reply(SONNET, 70_000), reply(SONNET, 80_000)]);
  const again = s.run("post-tool-use");
  assert.equal(again.out, "");
  assert.deepEqual(s.state().notified, [30]);
  assert.equal(s.state().percent, 40);
});

test("再跨一級才再通知：30% 之後到 50% 又來一則", () => {
  const s = scenario([reply(SONNET, 70_000)]);
  assert.ok(s.run("post-tool-use").json);
  s.write([reply(SONNET, 105_000)]);
  const r = s.run("post-tool-use");
  assert.match(noticeOf(r).additionalContext, /已用 53%/);
  assert.deepEqual(s.state().notified, [30, 50]);
});

test("一次跳過多級只通知一則", () => {
  const s = scenario([reply(SONNET, 150_000)]);
  const r = s.run("post-tool-use");
  assert.match(noticeOf(r).additionalContext, /已用 75%/);
  assert.deepEqual(s.state().notified, [30, 50, 70]);
});

test("用量掉下來（/compact、/clear）後再跨過門檻會再通知", () => {
  const s = scenario([reply(SONNET, 130_000)]);
  assert.ok(s.run("post-tool-use").json);
  assert.deepEqual(s.state().notified, [30, 50]);
  s.write([reply(SONNET, 130_000), reply(SONNET, 20_000)]);
  assert.equal(s.run("post-tool-use").out, "");
  assert.deepEqual(s.state().notified, []);
  s.write([reply(SONNET, 130_000), reply(SONNET, 20_000), reply(SONNET, 125_000)]);
  const r = s.run("post-tool-use");
  assert.match(noticeOf(r).additionalContext, /已用 63%/);
  assert.deepEqual(s.state().notified, [30, 50]);
});

test("transcript 大小沒變就直接略過，不重新量", () => {
  const s = scenario([reply(SONNET, 70_000)]);
  assert.ok(s.run("post-tool-use").json);
  const file = path.join(s.home, "context", `${s.session}.json`);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...saved, notified: [], at: "sentinel" }));
  assert.equal(s.run("post-tool-use").out, "");
  assert.equal(s.state().at, "sentinel");
});

test("視窗大小：1M 模型同樣的用量百分比小很多，200k 以上的用量也證明是 1M", () => {
  const small = scenario([reply(SONNET, 130_000)]);
  assert.match(noticeOf(small.run("post-tool-use")).additionalContext, /已用 65%（130,000 \/ 200,000 tokens）/);
  const large = scenario([reply(OPUS_1M, 130_000)]);
  assert.equal(large.run("post-tool-use").out, "");
  assert.equal(large.state().window, 1_000_000);
  assert.equal(large.state().percent, 13);
  const proven = scenario([reply(SONNET, 400_000)]);
  assert.match(noticeOf(proven.run("post-tool-use")).additionalContext, /已用 40%（400,000 \/ 1,000,000 tokens）/);
});

test("自動交棒開啟時訊息附上交棒門檻，沒開就不提；headless session 不會交棒也不提", () => {
  const on = scenario([reply(SONNET, 70_000)], { config: { enabled: true, ratio: 0.4 } });
  assert.match(noticeOf(on.run("post-tool-use")).additionalContext, /自動交棒門檻 40%/);
  const off = scenario([reply(SONNET, 70_000)]);
  assert.doesNotMatch(noticeOf(off.run("post-tool-use")).additionalContext, /交棒/);
  const headless = scenario([reply(SONNET, 70_000, "sdk-cli")], { config: { enabled: true } });
  const r = headless.run("post-tool-use");
  assert.match(noticeOf(r).additionalContext, /已用 35%/);
  assert.doesNotMatch(noticeOf(r).additionalContext, /交棒/);
});

test("自訂門檻：bands 子指令寫進設定，之後照新門檻通知", () => {
  const s = scenario([reply(SONNET, 20_000)], { notice: { enabled: true } });
  const set = s.run("bands", {}, "5,10");
  assert.equal(set.code, 0);
  assert.match(set.out, /開啟，門檻 5、10%/);
  const r = s.run("post-tool-use");
  assert.match(noticeOf(r).additionalContext, /已用 10%/);
  assert.deepEqual(s.state().notified, [5, 10]);
  assert.equal(s.run("bands", {}, "abc").code, 1);
});

test("show：印出最近一份用量紀錄與已通知門檻；沒有紀錄時說明原因", () => {
  const s = scenario([reply(SONNET, 130_000)]);
  assert.match(s.run("show").out, /還沒有 context 用量紀錄/);
  s.run("post-tool-use");
  const shown = s.run("show");
  assert.equal(shown.code, 0);
  assert.match(shown.out, /context 用量：65%（130,000 \/ 200,000 tokens，claude-sonnet-4-5），已通知門檻：30、50%/);
  assert.match(s.run("show", {}, s.session).out, /65%/);
});

test("預設關閉：沒設過 notice 的使用者，90% 也不輸出、不寫狀態檔", () => {
  const s = scenario([reply(SONNET, 180_000)], { notice: null });
  const r = s.run("post-tool-use");
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.equal(fs.existsSync(path.join(s.home, "context")), false);
});

test("enable 與 disable 子指令切換開關，並保留 config.json 裡其他設定", () => {
  const s = scenario([reply(SONNET, 180_000)], { notice: null, config: { enabled: true, ratio: 0.3 } });
  assert.match(s.run("enable").out, /開啟/);
  assert.ok(s.run("post-tool-use").json);
  const cfg = JSON.parse(fs.readFileSync(path.join(s.home, "config.json"), "utf8"));
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.ratio, 0.3);
  assert.equal(cfg.notice.enabled, true);
  assert.match(s.run("disable").out, /關閉/);
  s.write([reply(SONNET, 190_000)]);
  assert.equal(s.run("post-tool-use").out, "");
});

test("AUTO_HANDOFF_OFF=1 的 session 靜默", () => {
  const s = scenario([reply(SONNET, 180_000)], { env: { AUTO_HANDOFF_OFF: "1" } });
  const r = s.run("post-tool-use");
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.equal(fs.existsSync(path.join(s.home, "context")), false);
});

test("拋棄式 worktree 裡的 session 靜默", () => {
  const dir = path.join(tmp, "throwaway-wt");
  fs.mkdirSync(dir, { recursive: true });
  const s = scenario([reply(SONNET, 180_000)], { registry: [{ kind: "worktree", path: fs.realpathSync(dir) }] });
  const r = s.run("post-tool-use", { cwd: dir });
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
});

test("transcript 不存在、沒有 session id 或 stdin 不是 JSON：靜默、exit 0、不寫 stderr", () => {
  const s = scenario([reply(SONNET, 180_000)]);
  for (const input of [{ transcript_path: path.join(s.dir, "missing.jsonl") }, { session_id: "" }, { transcript_path: "" }]) {
    const r = s.run("post-tool-use", input);
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.equal(r.err, "");
  }
  const raw = spawnSync(process.execPath, [hook, "user-prompt"], { input: "not json", encoding: "utf8", env: { ...process.env, AUTO_HANDOFF_HOME: s.home } });
  assert.equal(raw.status, 0);
  assert.equal(raw.stdout, "");
});

test("transcript 只有使用者訊息、還沒有 assistant 用量：靜默", () => {
  const s = scenario([{ type: "user", uuid: "u1", entrypoint: "cli", message: { role: "user", content: "嗨" } }]);
  const r = s.run("post-tool-use");
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
});

test("crossing：只留下不高於目前用量的門檻，新跨過的取最高一級", () => {
  assert.deepEqual(crossing([30, 50, 70], 10, [30, 50]), { notified: [], top: null });
  assert.deepEqual(crossing([30, 50, 70], 55, [30]), { notified: [30, 50], top: 50 });
  assert.deepEqual(crossing([30, 50, 70], 55, [30, 50]), { notified: [30, 50], top: null });
  assert.deepEqual(crossing([30, 50, 70], 35, [30, 50, 70]), { notified: [30], top: null });
});
