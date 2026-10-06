import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CACHE_HANDOFF_TEXT, KEEPALIVE_REPLY, KEEPALIVE_TEXT, TAKEOVER_HEAD, cacheTrigger } from "../hooks/auto-handoff.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "hooks", "auto-handoff.mjs");
const fakeOrca = path.join(root, "test", "fixtures", "auto-handoff", "fake-orca.mjs");
const GOAL = "本次任務依 /repo/.goals/x.md 執行：完成前必須在對話中展示全部證據。未展示者一律視為未完成。";

let tmp;
let repo;
let seq = 0;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-")));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "wip.txt"), "wip\n");
  fs.chmodSync(fakeOrca, 0o755);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let uuid = 0;
const user = (text) => ({ type: "user", uuid: `u${++uuid}`, entrypoint: "cli", message: { role: "user", content: text } });
const reply = (model, used, text = "好了。") => ({
  type: "assistant",
  uuid: `a${++uuid}`,
  entrypoint: "cli",
  message: { role: "assistant", model, content: [{ type: "text", text }], usage: { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: used - 1003, output_tokens: 50 } },
});
const goalStatus = (fields) => ({ type: "attachment", uuid: `g${++uuid}`, attachment: { type: "goal_status", ...fields } });

// A fresh home, transcript and fake-orca dir per scenario.
function scenario(entries, { config, orca = true, failStep, env = {}, registry } = {}) {
  const dir = path.join(tmp, `s${++seq}`);
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(dir, "orca"), { recursive: true });
  fs.mkdirSync(path.join(dir, "claude"), { recursive: true });
  if (config) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  }
  if (registry) {
    fs.mkdirSync(path.join(dir, "console"), { recursive: true });
    fs.writeFileSync(path.join(dir, "console", "consoles.json"), JSON.stringify(registry));
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
    ORCA_BIN: fakeOrca,
    FAKE_ORCA_DIR: path.join(dir, "orca"),
    FAKE_WORKTREE: repo,
    AUTO_HANDOFF_POLL_MS: "10",
    AUTO_HANDOFF_DELIVER_MS: "300",
    AUTO_HANDOFF_FIRST_TURN_MS: "300",
    AUTO_HANDOFF_GOAL_MS: "300",
    ...(orca ? { ORCA_TERMINAL_HANDLE: "term_old", ORCA_PANE_KEY: "tab_old:leaf_old" } : {}),
    ...(failStep ? { FAKE_FAIL_STEP: failStep } : {}),
    ...env,
  };
  const note = path.join(home, "notes", `${session}.md`);
  const run = (command, input = {}) => {
    const res = spawnSync(process.execPath, [hook, command], {
      input: JSON.stringify({ session_id: session, transcript_path: transcript, cwd: repo, permission_mode: "acceptEdits", ...input }),
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
  const calls = () => {
    const file = path.join(dir, "orca", "calls.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const sends = () => {
    const file = path.join(dir, "orca", "sends.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const event = () => JSON.parse(fs.readFileSync(path.join(home, "events", `${session}.json`), "utf8"));
  return { dir, home, note, run, calls, sends, event, write, session };
}

const writeNote = (s, text = "# 交棒說明\n\n下一步：補測試。\n") => {
  fs.mkdirSync(path.dirname(s.note), { recursive: true });
  fs.writeFileSync(s.note, text);
};

async function closed(s) {
  for (let i = 0; i < 100; i++) {
    if (s.calls().some((c) => c[0] === "terminal" && c[1] === "close")) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const HAIKU = "claude-haiku-4-5-20251001";
const OPUS = "claude-opus-5-5";
const ON = { enabled: true };

test("未開啟時：用量再高 Stop hook 也不做任何動作，且不呼叫 orca", () => {
  for (const config of [undefined, { enabled: false }]) {
    const s = scenario([user("做事"), reply(HAIKU, 199_000)], { config });
    const res = s.run("stop");
    assert.deepEqual([res.code, res.out], [0, ""]);
    assert.deepEqual(s.calls(), []);
    assert.equal(fs.existsSync(path.join(s.home, "sessions")), false);
  }
});

test("首次詢問：沒設定過時 SessionStart 請模型問一次要不要開啟；回答記住後之後的 session 不再問", () => {
  const s = scenario([]);
  const ask = s.run("session-start").json.hookSpecificOutput.additionalContext;
  assert.match(ask, /要不要開啟自動交棒/);
  assert.match(ask, /auto-handoff\.mjs' enable/);
  for (const answer of ["enable", "disable"]) {
    const t = scenario([]);
    assert.ok(t.run("session-start").out);
    t.run(answer);
    assert.equal(t.run("session-start").out, "", `${answer} 之後不再問`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.home, "config.json"), "utf8")).enabled, answer === "enable");
  }
});

function crosses(model, below, above, config = ON) {
  const low = scenario([user("做事"), reply(model, below)], { config, orca: false });
  assert.equal(low.run("stop").out, "", `${model} ${below} 不該動作`);
  const high = scenario([user("做事"), reply(model, above)], { config, orca: false });
  const res = high.run("stop").json;
  assert.equal(res?.decision, "block", `${model} ${above} 應擋下`);
  assert.ok(res.reason.includes(high.note), "要求把交棒說明寫到指定檔");
  return res.reason;
}

test("門檻 200k 上限：80k 以下不動作，以上擋下並要求寫交棒說明到指定檔", () => {
  const reason = crosses(HAIKU, 79_000, 81_000);
  assert.match(reason, /門檻 40%，上限 200,000 tokens/);
});

test("門檻 1M 上限：400k 以下不動作，以上擋下並要求寫交棒說明到指定檔", () => {
  const reason = crosses(OPUS, 399_000, 401_000);
  assert.match(reason, /門檻 40%，上限 1,000,000 tokens/);
});

test("比例改成 30%：200k 門檻變 60k、1M 門檻變 300k；ratio 指令接受 0.3 與 30", () => {
  crosses(HAIKU, 59_000, 61_000, { enabled: true, ratio: 0.3 });
  crosses(OPUS, 299_000, 301_000, { enabled: true, ratio: 0.3 });
  const s = scenario([], { config: ON });
  const set = spawnSync(process.execPath, [hook, "ratio", "30"], { encoding: "utf8", env: { ...process.env, AUTO_HANDOFF_HOME: s.home } });
  assert.match(set.stdout, /門檻 30%/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "config.json"), "utf8")).ratio, 0.3);
});

test("不參與交棒的環境變數：AUTO_HANDOFF_OFF=1 時用量過門檻也不動作", () => {
  const s = scenario([user("做事"), reply(HAIKU, 150_000)], { config: ON, env: { AUTO_HANDOFF_OFF: "1" } });
  assert.equal(s.run("stop").out, "");
  assert.deepEqual(s.calls(), []);
});

test("手動觸發：輸入 /worktree-console:handoff 時用量沒過門檻、沒開啟也直接進入交棒流程；同一次指令不重複觸發", async () => {
  const cmd = user("<command-message>worktree-console:handoff</command-message>\n<command-name>/worktree-console:handoff</command-name>");
  const s = scenario([user("做事"), reply(HAIKU, 10_000), cmd, reply(HAIKU, 11_000, "收到。")]);
  const res = s.run("stop").json;
  assert.equal(res.decision, "block");
  assert.match(res.reason, /使用者要求現在交棒/);
  writeNote(s);
  s.run("stop");
  assert.ok(await closed(s));
  assert.equal(s.run("stop").out, "", "交棒後同一次指令不再觸發");
  const again = scenario([user("<command-name>/handoff</command-name>"), reply(HAIKU, 5_000)], { orca: false });
  assert.equal(again.run("stop").json.decision, "block", "/handoff 簡寫也算");
});

test("保底產檔：擋下要求寫說明後連續 2 次停下仍沒有交棒檔，hook 自己產一份並照樣交棒", async () => {
  const entries = [
    user("請幫我把登入頁改好"),
    goalStatus({ met: false, sentinel: true, condition: GOAL }),
    reply(HAIKU, 50_000, "改了 login.js。"),
    user("繼續"),
    reply(HAIKU, 90_000, "測試跑過了，剩文件。"),
  ];
  const s = scenario(entries, { config: ON });
  assert.equal(s.run("stop").json.decision, "block");
  const second = s.run("stop").json;
  assert.equal(second.decision, "block", "第 1 次停下沒檔：再擋一次提醒");
  assert.match(second.reason, /還沒看到交棒說明/);
  assert.equal(fs.existsSync(s.note), false);
  s.run("stop");
  const note = fs.readFileSync(s.note, "utf8");
  assert.match(note, /## 最初指令\n\n請幫我把登入頁改好/);
  assert.ok(note.includes(`## /goal 原文\n\n/goal ${GOAL}`));
  assert.match(note, /## 最後幾則對話[\s\S]*測試跑過了，剩文件。/);
  assert.match(note, /## git status\n\n```\n## main\n\?\? wip\.txt/);
  assert.ok(await closed(s), "保底後照樣交棒");
});

test("假 orca 交棒順序：開新分頁（同目錄、同 permission-mode）→ 等就緒 → 送接手指令 → 確認送達 → 關舊分頁", async () => {
  const s = scenario([user("做事"), reply(HAIKU, 90_000)], { config: ON });
  s.run("stop");
  writeNote(s);
  const res = s.run("stop");
  assert.deepEqual([res.code, res.out], [0, ""]);
  assert.ok(await closed(s));
  const order = s.calls().map((c) => c.slice(0, 2).join(" "));
  assert.deepEqual(order, ["terminal list", "terminal create", "terminal wait", "terminal send", "worktree ps", "terminal close"]);
  const create = s.calls()[1];
  assert.equal(create[create.indexOf("--worktree") + 1], `path:${repo}`);
  assert.equal(create[create.indexOf("--command") + 1], `cd '${repo}' && claude --permission-mode 'acceptEdits'`);
  assert.deepEqual(s.calls()[2].slice(2, 6), ["--terminal", "term_new", "--for", "tui-idle"]);
  const [sent] = s.sends();
  assert.equal(sent.terminal, "term_new");
  assert.ok(sent.text.includes(s.note) && /依交棒說明/.test(sent.text));
  assert.deepEqual(s.calls().at(-1), ["terminal", "close", "--terminal", "term_old", "--tab"]);
  assert.equal(s.event().status, "done");
  assert.equal(s.event().isConsole, false, "一般 session 交棒不標中控台");
});

test("任一步失敗就不關舊分頁，並把失敗步驟告訴使用者", async () => {
  const steps = { create: "開新分頁", wait: "等新分頁就緒", send: "送出接手指令", deliver: "確認接手指令送達" };
  for (const [failStep, name] of Object.entries(steps)) {
    const s = scenario([user("做事"), reply(HAIKU, 90_000)], { config: ON, failStep });
    s.run("stop");
    writeNote(s);
    const msg = s.run("stop").json.systemMessage;
    assert.ok(msg.includes(`卡在「${name}」`), `${failStep}: ${msg}`);
    assert.match(msg, /舊分頁保留/);
    assert.equal(await closed(s), false, `${failStep} 失敗不能關舊分頁`);
    assert.deepEqual([s.event().status, s.event().step], ["failed", name]);
  }
});

test("/goal 重送：最後一筆目標狀態未達成時，新 session 收到逐字相同的 /goal，畫面確認 Goal set 才關舊分頁", async () => {
  const s = scenario([user("x"), goalStatus({ met: false, sentinel: true, condition: GOAL }), goalStatus({ met: false, condition: GOAL, reason: "還沒" }), reply(OPUS, 450_000)], { config: ON });
  assert.match(s.run("stop").json.reason, /進行中的 \/goal/);
  writeNote(s);
  s.run("stop");
  assert.ok(await closed(s));
  const texts = s.sends().map((x) => x.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /接著會收到 \/goal/);
  assert.equal(texts[1], `/goal ${GOAL}`);
  const order = s.calls().map((c) => c.slice(0, 2).join(" "));
  assert.deepEqual(order.slice(-3), ["terminal send", "terminal read", "terminal close"]);
  assert.match(fs.readFileSync(s.note, "utf8"), /收工前須在本 session 重新執行並貼出 `\/goal` 全部證據/);
});

test("/goal 重送失敗（沒出現 Goal set、被當成貼上內容）不關舊分頁", async () => {
  const s = scenario([user("x"), goalStatus({ met: false, sentinel: true, condition: GOAL }), reply(OPUS, 450_000)], { config: ON, failStep: "goal-set" });
  s.run("stop");
  writeNote(s);
  const msg = s.run("stop").json.systemMessage;
  assert.match(msg, /卡在「確認 Goal set」（\/goal 被當成貼上內容收起/);
  assert.ok(msg.includes(`/goal ${GOAL}`));
  assert.equal(await closed(s), false);
});

test("/goal 不送：最後一筆目標狀態已達成或已失敗時不送 /goal，交棒說明也不附", async () => {
  for (const last of [{ met: true, condition: GOAL }, { met: false, failed: true, condition: GOAL }, { met: true, sentinel: true, condition: GOAL }]) {
    const s = scenario([user("x"), goalStatus({ met: false, sentinel: true, condition: GOAL }), goalStatus(last), reply(OPUS, 450_000)], { config: ON });
    s.run("stop");
    writeNote(s);
    s.run("stop");
    assert.ok(await closed(s));
    assert.deepEqual(s.sends().filter((x) => x.text.startsWith("/goal")), [], JSON.stringify(last));
    assert.doesNotMatch(fs.readFileSync(s.note, "utf8"), /### \/goal/);
  }
});

test("待答問題重問：最後一則在等使用者回答時，交棒說明附問題原文，接手指令要求先原樣重問", async () => {
  const question = "要用方案 A 還是 B？\n\n- A：改前端\n- B：改後端";
  const s = scenario([user("x"), reply(HAIKU, 90_000, question)], { config: ON });
  s.run("stop", { last_assistant_message: question });
  writeNote(s);
  s.run("stop", { last_assistant_message: "交棒說明寫好了。" });
  assert.ok(await closed(s));
  assert.ok(fs.readFileSync(s.note, "utf8").includes(`### 待答問題（原文）\n\n前一個 session 最後一則回覆在等使用者回答。新 session 開場先把下面這段原樣重問使用者，等使用者回答後再繼續：\n\n${question}\n`));
  assert.match(s.sends()[0].text, /把那段原文原樣重問使用者，等使用者回答再繼續/);
});

test("快取交棒：最後一則 prompt 是中控台送的快取交棒訊息時，沒開啟、用量沒過門檻也走既有交棒流程；說明附原題原文，接手指令要求新 session 只原樣貼出原題，事件標 cache", async () => {
  for (const original of ["登入頁要怎麼改，選哪個？\n\n- A：只改前端\n- B：前後端一起改", "登入頁改好了，測試也過了。"]) {
    const s = scenario([user("做事"), reply(OPUS, 160_000, original), user(CACHE_HANDOFF_TEXT), reply(OPUS, 160_500, "好。")]);
    const asked = s.run("stop", { last_assistant_message: "好。" }).json;
    assert.equal(asked.decision, "block");
    assert.match(asked.reason, /prompt 快取快到期/);
    assert.equal(s.event().cache, true);
    writeNote(s);
    s.run("stop", { last_assistant_message: "交棒說明寫好了。" });
    assert.ok(await closed(s));
    const note = fs.readFileSync(s.note, "utf8");
    assert.match(note, /- 交棒原因：prompt 快取將到期/);
    assert.ok(note.includes(`### 待答問題（原文）\n\n前一個 session 最後一則回覆在等使用者回答。新 session 開場先把下面這段原樣重問使用者，等使用者回答後再繼續：\n\n${original}\n`));
    const [sent] = s.sends();
    assert.ok(sent.text.startsWith(TAKEOVER_HEAD) && sent.text.includes(s.note));
    assert.match(sent.text, /第一則回覆只原樣貼出交棒說明最後〈待答問題（原文）〉那段，不加任何前言、說明或結語，貼完就停下等使用者回答/);
    assert.deepEqual([s.event().status, s.event().cache], ["done", true]);
    assert.equal(s.run("stop").out, "", "同一則交棒訊息不重複觸發");
  }
  const later = scenario([user("做事"), reply(OPUS, 160_000, "要哪個？"), user(CACHE_HANDOFF_TEXT), reply(OPUS, 160_500, "好。"), user("選 A"), reply(OPUS, 161_000, "改好了。")]);
  assert.equal(later.run("stop").out, "", "交棒訊息之後使用者又回話：不觸發");
});

test("快取交棒：交棒訊息前是續命那一來一回時，取到的原題是續命之前那則回覆，不是續命的固定短句", async () => {
  const original = "登入頁要怎麼改，選哪個？\n\n- A：只改前端\n- B：前後端一起改";
  const entries = [user("做事"), reply(OPUS, 150_000, original), user(KEEPALIVE_TEXT), reply(OPUS, 150_100, KEEPALIVE_REPLY), user(CACHE_HANDOFF_TEXT), reply(OPUS, 160_500, "好。")];
  assert.equal(cacheTrigger(entries).question, original);
  assert.equal(cacheTrigger([user("做事"), reply(OPUS, 150_000, "要哪個？"), user("選 A"), reply(OPUS, 150_100, original), user(CACHE_HANDOFF_TEXT)]).question, original, "沒有續命時照舊取交棒前最後一則");
  const s = scenario(entries);
  s.run("stop", { last_assistant_message: "好。" });
  writeNote(s);
  s.run("stop", { last_assistant_message: "交棒說明寫好了。" });
  assert.ok(await closed(s));
  const note = fs.readFileSync(s.note, "utf8");
  assert.ok(note.includes(`### 待答問題（原文）\n\n前一個 session 最後一則回覆在等使用者回答。新 session 開場先把下面這段原樣重問使用者，等使用者回答後再繼續：\n\n${original}\n`));
  assert.ok(!note.includes(`\n\n${KEEPALIVE_REPLY}\n`), "交棒說明不把固定短句當原題");
});

test("Orca 外：只寫交棒說明並提示一次（附路徑與 /goal 原文），不呼叫 orca；同一 session 之後不再提示", () => {
  const s = scenario([user("x"), goalStatus({ met: false, sentinel: true, condition: GOAL }), reply(HAIKU, 90_000)], { config: ON, orca: false });
  s.run("stop");
  writeNote(s);
  const msg = s.run("stop").json.systemMessage;
  assert.ok(msg.includes(s.note));
  assert.ok(msg.includes(`/goal ${GOAL}`));
  assert.equal(s.run("stop").out, "", "同一 session 不再提示");
  assert.equal(s.run("stop").out, "");
  assert.deepEqual(s.calls(), []);
});

test("中控台自己交棒：接手指令要求重啟中控台並 --takeover，consoles.json 只剩新分頁的登記", async () => {
  const s = scenario([user("開中控台"), reply(HAIKU, 90_000)], { config: ON, registry: ["term_old", "term_other"] });
  s.run("stop");
  writeNote(s);
  s.run("stop");
  assert.ok(await closed(s));
  assert.match(s.sends()[0].text, /worktree-console[\s\S]*--takeover/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, "console", "consoles.json"), "utf8")).sort(), ["term_new", "term_other"]);
  assert.deepEqual([s.event().isConsole, s.event().newHandle], [true, "term_new"], "交棒事件記下舊分頁是中控台，換手後登記表已換掉也查得到");
});

test("寫交棒說明檔自動放行，其他 Write 不干涉", () => {
  const s = scenario([]);
  const allow = s.run("pre-tool-use", { tool_name: "Write", tool_input: { file_path: s.note } }).json;
  assert.equal(allow.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(s.run("pre-tool-use", { tool_name: "Write", tool_input: { file_path: path.join(repo, "x.md") } }).out, "");
});

test("headless（claude -p）session 不交棒", () => {
  const e = reply(HAIKU, 150_000);
  e.entrypoint = "sdk-cli";
  const s = scenario([e], { config: ON });
  assert.equal(s.run("stop").out, "");
});
