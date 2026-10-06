import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_HANDOFF_TEXT } from "../hooks/auto-handoff.mjs";
import { KEEPALIVE_REPLY, KEEPALIVE_TEXT, RECYCLED, agentStatus, boardLines, collect, handoffLines, pendingBlock } from "../skills/worktree-console/scripts/lib.mjs";
import { HANDOFF_TOKENS, KEEPALIVE_AFTER_MS, handedOver, keepaliveStep, keepaliveUsage } from "../skills/worktree-console/scripts/keepalive.mjs";
import { emptyFocus, focusPayload, focusStep, saveFocus, syncFocus } from "../skills/worktree-console/scripts/focus.mjs";
import { readEvents } from "../skills/worktree-console/scripts/log.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills", "worktree-console", "scripts");
const fakeOrca = path.join(root, "test", "fixtures", "worktree-console", "fake-orca.mjs");
const usageFixture = path.join(root, "test", "fixtures", "worktree-console", "keepalive-usage.jsonl");
const MIN = 60_000;
const QUESTION = "登入頁要怎麼改，選哪個？\n\n- A：只改前端\n- B：前後端一起改\n\n我建議 A。";

let tmp;
let app;
let watchScripts;
let seq = 0;

const gitIn = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-keep-")));
  app = path.join(tmp, "app");
  fs.mkdirSync(app);
  gitIn(app, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(app, "a.txt"), "a\n");
  gitIn(app, "add", ".");
  gitIn(app, "commit", "-qm", "init");
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) gitIn(app, "worktree", "add", "-q", "-b", `proj-${n}`, path.join(tmp, "wt", `proj-${n}`), "main");
  watchScripts = path.join(tmp, "keep-scripts");
  fs.symlinkSync(scripts, watchScripts);
  fs.chmodSync(fakeOrca, 0o755);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const wt = (n) => path.join(tmp, "wt", `proj-${n}`);
const pane = (id) => `tab-${id}:leaf-${id}`;

// One worktree per session: { id, n, state, text, prompt, since, toolName, toolInput }.
function agentOf(s) {
  return {
    paneKey: pane(s.id),
    state: s.state ?? "done",
    toolName: s.toolName ?? null,
    toolInput: s.toolInput ?? null,
    stateStartedAt: s.since,
    prompt: s.prompt ?? "做事",
    lastAssistantMessage: s.text ?? null,
  };
}

function psOf(sessions) {
  const byN = new Map();
  for (const s of sessions) byN.set(s.n, [...(byN.get(s.n) ?? []), s]);
  return {
    ok: true,
    result: { worktrees: [...byN].map(([n, list]) => ({ path: wt(n), repoId: "r1", branch: `refs/heads/proj-${n}`, linkedLinearIssue: `PROJ-${n}`, agents: list.map(agentOf) })) },
  };
}

// A fake Orca world: each argument after the first is the next `worktree ps` answer.
function world(sessions, ...later) {
  const dir = path.join(tmp, `w${++seq}`);
  fs.mkdirSync(dir);
  const all = [sessions, ...later];
  const panes = new Map(all.flat().map((s) => [s.id, s]));
  const put = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  put("repo-list.json", { ok: true, result: { repos: [{ id: "r1", path: app, displayName: "app" }] } });
  put("worktree-list.json", {
    ok: true,
    result: { worktrees: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ path: wt(n), repoId: "r1", branch: `refs/heads/proj-${n}`, linkedLinearIssue: `PROJ-${n}`, displayName: `proj-${n}` })) },
  });
  put("terminal-list.json", {
    ok: true,
    result: { terminals: [...panes.values()].map((s) => ({ handle: `term_${s.id}`, tabId: `tab-${s.id}`, leafId: `leaf-${s.id}`, worktreePath: wt(s.n), agentIdentity: "claude" })) },
  });
  put("worktree-ps.json", psOf(sessions));
  if (later.length > 0) all.forEach((list, i) => put(`ps-${i}.json`, psOf(list)));
  return dir;
}

function homes() {
  const dir = path.join(tmp, `h${++seq}`);
  const env = {
    WORKTREE_CONSOLE_HOME: path.join(dir, "console"),
    WORKTREE_CONSOLE_LOG_DIR: path.join(dir, "log"),
    AUTO_HANDOFF_HOME: path.join(dir, "handoff"),
    CLAUDE_PROJECTS_DIR: path.join(dir, "projects"),
  };
  fs.mkdirSync(env.WORKTREE_CONSOLE_HOME, { recursive: true });
  return env;
}

function envFor(dir, home) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORCA_|WATCH_|WORKTREE_CONSOLE_|AUTO_HANDOFF_|CLAUDE_)/.test(k))),
    ORCA_BIN: fakeOrca,
    FAKE_ORCA_DIR: dir,
    ORCA_TERMINAL_HANDLE: "term_self",
    CLAUDE_CODE_SESSION_ID: "",
    WATCH_INTERVAL_MS: "20",
    WATCH_TIMEOUT_MS: "2500",
    WATCH_PGREP_PATTERN: `${watchScripts}/watch\\.mjs`,
    ...home,
  };
}

// A world that changes between polls needs every poll to run before the watcher times out, however slow the first one is.
function watch(dir, home, args = []) {
  const polls = fs.readdirSync(dir).some((f) => /^ps-\d+\.json$/.test(f));
  const env = { ...envFor(dir, home), ...(polls ? { WATCH_TIMEOUT_MS: "5000" } : {}) };
  const res = spawnSync(process.execPath, [path.join(watchScripts, "watch.mjs"), ...args], { encoding: "utf8", env });
  const lines = res.stdout.trim().split("\n");
  return { lines, said: lines.filter((l) => !l.startsWith("baseline:")), baseline: lines.find((l) => l.startsWith("baseline:"))?.slice(10) ?? null, err: res.stderr };
}

const sends = (dir) =>
  (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n") : [])
    .filter((l) => l.startsWith("terminal send"))
    .map((l) => {
      const m = l.match(/^terminal send --terminal (\S+) --text ([\s\S]*) --enter$/);
      return { to: m[1], text: m[2] };
    });

const keepState = (home) => JSON.parse(fs.readFileSync(path.join(home.WORKTREE_CONSOLE_HOME, "keepalive.json"), "utf8"));

// Runs `fn` with this process pointed at the fake world, for the board, the reply list and the focus pane.
function inWorld(dir, home, fn) {
  const env = envFor(dir, home);
  const keys = Object.keys(env).filter((k) => /^(ORCA_|WATCH_|WORKTREE_CONSOLE_|AUTO_HANDOFF_|CLAUDE_|FAKE_)/.test(k));
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, Object.fromEntries(keys.map((k) => [k, env[k]])));
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// What the board, the reply list and the focus pane show, as the console would see them.
function screens(dir, home, now = Date.now()) {
  return inWorld(dir, home, () => {
    const data = collect(null, { withStage: true, withTitles: false });
    for (const r of data.rows) r.title = r.title ?? r.branch;
    const view = syncFocus(data.rows, { now });
    const { payload } = focusPayload(data.rows, view, { now, keys: data.keys });
    return {
      board: boardLines(data.rows).join("\n"),
      pending: pendingBlock(data.rows).join("\n"),
      focus: payload.sessions.filter((s) => s.pending).map((s) => ({ tag: s.tag, question: s.question, options: s.options, suggest: s.suggest })),
      onScreen: view.current?.key ?? null,
      queue: [view.current, ...view.queue].filter(Boolean).map((e) => e.key),
    };
  });
}

function registerTranscript(home, id, entries) {
  const file = path.join(home.CLAUDE_PROJECTS_DIR, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.mkdirSync(home.WORKTREE_CONSOLE_LOG_DIR, { recursive: true });
  fs.appendFileSync(
    path.join(home.WORKTREE_CONSOLE_LOG_DIR, `${new Date().toLocaleDateString("sv")}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), event: "session", role: "child", handle: `term_${id}`, sessionId: `sess-${id}`, transcript: file }) + "\n",
  );
  return file;
}

const used = (tokens, extra = {}, content = [{ type: "text", text: "x" }]) => ({
  type: "assistant",
  message: { model: "claude-opus-5-5", content, usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: tokens - 1002, ...extra } },
});

const keepalive = { type: "user", message: { role: "user", content: KEEPALIVE_TEXT } };
const ok = (tokens, extra = {}) => used(tokens, extra, [{ type: "text", text: KEEPALIVE_REPLY }]);

const MENU = { questions: [{ question: "用哪個方案？", header: "方案", options: [{ label: "A" }, { label: "B" }] }] };

// Rows for keepaliveStep without Orca: one session per row.
function rowsOf(list) {
  return list.map((s) => {
    const agent = s.state === "none" ? null : agentOf(s);
    const status = agent ? agentStatus(agent) : { kind: "idle", text: "" };
    return { repo: "app", label: `PROJ-${s.n}`, path: wt(s.n), sessions: [{ paneKey: pane(s.id), handle: `term_${s.id}`, n: null, agent, status, archived: !!s.archived }] };
  });
}

test("續命：⏸ 回覆完畢與純文字 💬 停下滿 50 分鐘（以 stateStartedAt 計）沒人回，watcher 各送一次續命訊息；未滿 50 分鐘不送；之後的輪詢與重掛都不再送", () => {
  const now = Date.now();
  const dir = world([
    { id: "A", n: 1, text: "登入頁改好了，測試也過了。", since: now - 51 * MIN },
    { id: "B", n: 2, text: QUESTION, since: now - 51 * MIN },
    { id: "G", n: 3, text: "還有一題：要不要順便改註冊頁？", since: now - 49 * MIN },
  ]);
  const home = homes();
  const first = watch(dir, home);
  assert.deepEqual(first.said, ["[watch] timeout"], "續命不出聲");
  assert.deepEqual(
    sends(dir).sort((a, b) => a.to.localeCompare(b.to)),
    [
      { to: "term_A", text: KEEPALIVE_TEXT },
      { to: "term_B", text: KEEPALIVE_TEXT },
    ],
  );
  watch(dir, home, ["--baseline", first.baseline]);
  assert.equal(sends(dir).length, 2, "同一次停下恰好一次");
  assert.deepEqual(
    Object.fromEntries(Object.entries(keepState(home)).map(([k, v]) => [k, v.phase])),
    { [pane("A")]: "sent", [pane("B")]: "sent" },
  );
  const logged = inWorld(dir, home, () => readEvents()).filter((e) => e.event === "keepalive");
  assert.deepEqual(logged.map((e) => [e.ticket, e.step, e.ok]).sort(), [["PROJ-1", "sent", true], ["PROJ-2", "sent", true]]);
});

test("續命訊息只交代三件事：中控台自動訊息不是新指令、只回固定短句、不要做任何事；不提先前的回覆或過程，也不要它重貼、複述、摘要、說明或回報", () => {
  assert.equal(KEEPALIVE_TEXT, `（中控台自動訊息，不是使用者的新指令）只回「${KEEPALIVE_REPLY}」兩個字，不要做任何事，也不要呼叫任何工具。`);
  assert.match(KEEPALIVE_TEXT, /中控台自動訊息，不是使用者的新指令/);
  assert.ok(KEEPALIVE_TEXT.includes(`只回「${KEEPALIVE_REPLY}」`));
  assert.match(KEEPALIVE_TEXT, /不要做任何事/);
  assert.doesNotMatch(KEEPALIVE_TEXT, /上一則|先前|之前|剛才|回覆過|想法|思考|推理|過程|做了|貼|複述|重複|摘要|總結|說明|回報|報告|解釋|逐字|原封不動/);
});

test("續命：子 session 只回固定短句時不出聲；從送出續命、它回完到使用者回覆前，看板、待回覆清單、專注面板一直顯示原題與原選項，從不出現固定短句；用量記進過程紀錄", () => {
  const now = Date.now();
  const stop = { id: "B", n: 2, state: "done", text: QUESTION, since: now - 55 * MIN };
  const busy = { ...stop, state: "working", prompt: KEEPALIVE_TEXT, since: now - 3 * MIN };
  const again = { ...stop, prompt: KEEPALIVE_TEXT, text: KEEPALIVE_REPLY, since: now - 2 * MIN };
  const home = homes();
  registerTranscript(home, "B", [used(60_000), keepalive, ok(61_000, { cache_creation: { ephemeral_1h_input_tokens: 900, ephemeral_5m_input_tokens: 0 } })]);
  const before = screens(world([stop]), home);
  assert.match(before.pending, /登入頁要怎麼改，選哪個？/);
  assert.match(before.pending, /a 只改前端／b 前後端一起改/);
  const dir = world([stop], [busy], [again]);
  const out = watch(dir, home);
  assert.deepEqual(out.said, ["[watch] timeout"], "照指示只回固定短句：不出聲");
  assert.deepEqual(sends(dir), [{ to: "term_B", text: KEEPALIVE_TEXT }]);
  assert.equal(keepState(home)[pane("B")].phase, "kept");
  for (const [name, state] of [["送出後還沒開始", stop], ["續命中", busy], ["回完後", again], ["再過一陣子", { ...again, since: now - 1 * MIN }]]) {
    const now2 = screens(world([state]), home);
    assert.equal(now2.board, before.board, `${name}：看板不變`);
    assert.equal(now2.pending, before.pending, `${name}：待回覆清單不變`);
    assert.deepEqual(now2.focus, before.focus, `${name}：專注面板的題目與選項不變`);
    assert.ok(!(now2.board + now2.pending + JSON.stringify(now2.focus)).includes(KEEPALIVE_REPLY), `${name}：畫面不出現固定短句`);
  }
  const replied = screens(world([{ ...stop, prompt: "用 A", text: "好，改前端。要不要也改樣式？", since: now - 30_000 }]), home);
  assert.match(replied.pending, /要不要也改樣式/, "使用者回覆後改顯示新的回覆");
  const kept = inWorld(dir, home, () => readEvents()).find((e) => e.event === "keepalive" && e.step === "kept");
  assert.deepEqual(kept.usage, { cacheRead: 59_998, cacheWrite1h: 900, cacheWrite5m: 0, input: 2 });
});

test("續命：子 session 多講話或呼叫工具時，watcher 印一行「[票號] 續命時沒照指示只回「收到」…」，畫面照樣顯示原題與原選項", () => {
  const extra = "收到。另外我發現登入頁還有一個問題，要不要順便改？\n\n- A：改\n- B：不改";
  const cases = [
    ["多講話", extra, [ok(61_000), used(61_200, {}, [{ type: "text", text: "另外我發現登入頁還有一個問題，要不要順便改？" }])]],
    ["呼叫工具", KEEPALIVE_REPLY, [used(61_000, {}, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } }]), { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "clean" }] } }, ok(61_200)]],
  ];
  for (const [name, text, tail] of cases) {
    const now = Date.now();
    const stop = { id: "B", n: 2, text: QUESTION, since: now - 55 * MIN };
    const replied = { ...stop, prompt: KEEPALIVE_TEXT, text, since: now - 2 * MIN };
    const home = homes();
    registerTranscript(home, "B", [used(60_000), keepalive, ...tail]);
    const before = screens(world([stop]), home);
    const dir = world([stop], [{ ...stop, state: "working", prompt: KEEPALIVE_TEXT, since: now - 3 * MIN }], [replied]);
    const out = watch(dir, home);
    assert.deepEqual(out.said, [`[PROJ-2] 續命時沒照指示只回「${KEEPALIVE_REPLY}」，畫面照舊顯示原題`], name);
    const shown = screens(world([replied]), home);
    assert.equal(shown.pending, before.pending, `${name}：待回覆清單仍是原題`);
    assert.deepEqual(shown.focus, before.focus, `${name}：專注面板仍是原題與原選項`);
    assert.equal(shown.board, before.board, `${name}：看板不變`);
    const again = watch(world([replied]), home, ["--baseline", out.baseline]);
    assert.deepEqual(again.said, ["[watch] timeout"], `${name}：同一次只提醒一次、不另外回報`);
  }
});

test("續命：續命造成的停下不叫醒中控台、不重新回報（不寫新的停下紀錄）、不改變專注排隊順序與畫面上的題目", () => {
  const now = Date.now();
  const A = { id: "A", n: 1, text: "第一題：API 要叫 fetchOrders 還是 getOrders？", since: now - 80 * MIN };
  const B = { id: "B", n: 2, text: QUESTION, since: now - 55 * MIN };
  const C = { id: "C", n: 3, text: "要不要順便補測試？", since: now - 10 * MIN };
  const home = homes();
  saveFocusIn(home);
  const before = screens(world([A, B, C]), home, now);
  assert.deepEqual(before.queue.map((k) => k.split("@")[0]), [pane("A"), pane("B"), pane("C")]);
  const start = watch(world([A, B, C]), home);
  const kept = (s, dt) => ({ ...s, prompt: KEEPALIVE_TEXT, text: KEEPALIVE_REPLY, since: now - 3 * MIN + dt });
  const dir = world([A, B, C], [{ ...kept(A, 1), state: "working" }, { ...kept(B, 2), state: "working" }, C], [kept(A, 3), kept(B, 4), C]);
  const out = watch(dir, home, ["--baseline", start.baseline]);
  assert.deepEqual(out.said, ["[watch] timeout"], "不叫醒中控台");
  assert.equal(out.baseline, start.baseline, "狀態快照不變");
  assert.deepEqual(inWorld(dir, home, () => readEvents()).filter((e) => e.event === "stop"), [], "不重新回報");
  const after = screens(world([kept(A, 3), kept(B, 4), C]), home, now + 10);
  assert.deepEqual(after.queue, before.queue, "專注排隊順序與題目代號不變");
  assert.equal(after.onScreen, before.onScreen);
});

function saveFocusIn(home) {
  inWorld(world([]), home, () => saveFocus(emptyFocus()));
}

test("交棒：續命那輪停下再滿 50 分鐘仍沒人回、context 滿 15 萬 token，watcher 送快取交棒訊息走既有 handoff 流程，完成後印「[票號] 已自動交棒（快取將到期）」", () => {
  const now = Date.now();
  const home = homes();
  registerTranscript(home, "A", [used(90_000), keepalive, ok(160_000)]);
  const stop = { id: "A", n: 1, text: QUESTION, since: now - 110 * MIN };
  watch(world([stop]), home);
  const dir = world([{ ...stop, prompt: KEEPALIVE_TEXT, text: KEEPALIVE_REPLY, since: now - 51 * MIN }]);
  const out = watch(dir, home);
  assert.deepEqual(out.said, ["[watch] timeout"]);
  assert.deepEqual(sends(dir), [{ to: "term_A", text: CACHE_HANDOFF_TEXT }]);
  assert.equal(keepState(home)[pane("A")].phase, "handing");
  const ev = { status: "done", cache: true, oldHandle: "term_A", oldPaneKey: pane("A"), newHandle: "term_N", newPaneKey: pane("N"), cwd: wt(1), updatedAt: Date.now() };
  fs.mkdirSync(path.join(home.AUTO_HANDOFF_HOME, "events"), { recursive: true });
  fs.writeFileSync(path.join(home.AUTO_HANDOFF_HOME, "events", "sess-A.json"), JSON.stringify(ev));
  const swapped = world([{ id: "N", n: 1, text: QUESTION, prompt: "接手交棒：先完整讀 /n.md 。", since: now - 1000 }]);
  const done = watch(swapped, home);
  assert.deepEqual(done.said, ["[PROJ-1] 已自動交棒（快取將到期）"]);
  assert.deepEqual(keepState(home), { [pane("N")]: { phase: "fresh", handle: "term_N", at: keepState(home)[pane("N")].at } });
  const logged = inWorld(dir, home, () => readEvents()).find((e) => e.event === "handoff");
  assert.deepEqual([logged.ticket, logged.kind, logged.ok, logged.newHandle], ["PROJ-1", "cache", true, "term_N"]);
  assert.deepEqual(
    handoffLines([{ path: wt(1), label: "PROJ-1" }], [{ ...ev, status: "failed", step: "開新分頁" }]).map((x) => x.line),
    ["[PROJ-1] 自動交棒失敗：卡在「開新分頁」，舊 session 保留"],
  );
  assert.equal(handedOver({ [pane("A")]: { phase: "handing", handle: "term_A" } }, { ...ev, status: "failed" })[pane("A")].phase, "expired", "交棒失敗的舊 session 讓它過期，不再續命");
});

test("交棒：同情境 context 未滿 15 萬 token 時不交棒，之後也不再送任何訊息", () => {
  const now = Date.now();
  const home = homes();
  registerTranscript(home, "A", [used(90_000), keepalive, ok(HANDOFF_TOKENS - 1)]);
  const stop = { id: "A", n: 1, text: QUESTION, since: now - 110 * MIN };
  const first = world([stop]);
  watch(first, home);
  assert.equal(sends(first).length, 1);
  const dir = world([{ ...stop, prompt: KEEPALIVE_TEXT, since: now - 51 * MIN }]);
  watch(dir, home);
  watch(dir, home);
  assert.deepEqual(sends(dir), []);
  assert.equal(keepState(home)[pane("A")].phase, "expired");
  let state = keepState(home);
  const rows = rowsOf([{ ...stop, prompt: KEEPALIVE_TEXT, since: now - 51 * MIN }]);
  for (let t = now; t < now + 6 * 60 * MIN; t += 5 * MIN) {
    const step = keepaliveStep(rows, state, t, { contextOf: () => HANDOFF_TOKENS - 1 });
    assert.deepEqual(step.actions, [], "之後幾小時都不再送");
    state = step.state;
  }
});

test("♻️：換手過的 session 在看板、待回覆清單、專注卡片的最後動態／問題前有「♻️」，使用者回覆後消失", () => {
  const now = Date.now();
  const home = homes();
  fs.writeFileSync(path.join(home.WORKTREE_CONSOLE_HOME, "keepalive.json"), JSON.stringify({ [pane("N")]: { phase: "fresh", handle: "term_N", at: now } }));
  const fresh = { id: "N", n: 1, text: QUESTION, prompt: "接手交棒：先完整讀 /n.md 。讀完後第一則回覆只原樣貼出…", since: now - 2 * MIN };
  const other = { id: "B", n: 2, text: "要不要順便補測試？", since: now - 3 * MIN };
  const marked = screens(world([fresh, other]), home);
  const boardRow = marked.board.split("\n").find((l) => l.includes("PROJ-1"));
  const otherRow = marked.board.split("\n").find((l) => l.includes("PROJ-2"));
  assert.match(boardRow, new RegExp(`\\| ${RECYCLED} 登入頁要怎麼改`));
  assert.doesNotMatch(otherRow, /♻️/);
  assert.match(marked.pending.split("\n").find((l) => l.includes("PROJ-1")), new RegExp(`\\| ${RECYCLED} 登入頁要怎麼改`));
  assert.deepEqual(marked.focus.map((f) => [f.tag, f.question.startsWith(`${RECYCLED} `)]), [["PROJ-1", true], ["PROJ-2", false]]);
  const replied = { ...fresh, prompt: "用 A", text: "好，改前端。要不要也改樣式？", since: now - 90_000 };
  const after = screens(world([replied, other]), home);
  assert.doesNotMatch(after.board + after.pending + JSON.stringify(after.focus), /♻️/);
  watch(world([replied, other]), home);
  assert.equal(keepState(home)[pane("N")], undefined, "使用者回覆後紀錄清掉");
});

test("交棒後的新 session 在使用者回覆前不續命、不交棒；使用者回覆某個子 session 後該 session 計數歸零，下次停下重新計時", () => {
  const t0 = Date.now();
  let state = { [pane("N")]: { phase: "fresh", handle: "term_N", at: t0 } };
  const waiting = { id: "N", n: 1, text: QUESTION, prompt: "接手交棒：先完整讀 /n.md 。", since: t0 };
  for (let t = t0; t < t0 + 5 * 60 * MIN; t += 5 * MIN) {
    const step = keepaliveStep(rowsOf([waiting]), state, t, { contextOf: () => 900_000 });
    assert.deepEqual(step.actions, [], "回覆前從不續命、不交棒");
    state = step.state;
  }
  const home = homes();
  fs.writeFileSync(path.join(home.WORKTREE_CONSOLE_HOME, "keepalive.json"), JSON.stringify(state));
  const old = world([{ ...waiting, since: t0 - 3 * 60 * MIN }]);
  watch(old, home);
  assert.deepEqual(sends(old), [], "watcher 實際也不送");

  const t1 = t0 + 6 * 60 * MIN;
  const answered = { ...waiting, prompt: "用 A", text: "改好了，要不要順便改註冊頁？", since: t1 };
  let step = keepaliveStep(rowsOf([answered]), state, t1 + KEEPALIVE_AFTER_MS - 1);
  assert.deepEqual([step.actions, step.state[pane("N")]], [[], undefined], "回覆後計數歸零，未滿 50 分鐘不送");
  step = keepaliveStep(rowsOf([answered]), step.state, t1 + KEEPALIVE_AFTER_MS);
  assert.deepEqual(step.actions.map((a) => [a.type, a.tag]), [["keepalive", "PROJ-1"]], "回覆後下一次停下照同一套規則重新續命");

  let s = {};
  const A = { id: "A", n: 2, text: QUESTION, since: t0 };
  s = keepaliveStep(rowsOf([A]), s, t0 + 50 * MIN).state;
  s = keepaliveStep(rowsOf([{ ...A, prompt: KEEPALIVE_TEXT, since: t0 + 51 * MIN }]), s, t0 + 52 * MIN).state;
  assert.equal(s[pane("A")].phase, "kept");
  const reply = { ...A, prompt: "選 B", text: "好，前後端一起改。還要補文件嗎？", since: t0 + 70 * MIN };
  step = keepaliveStep(rowsOf([reply]), s, t0 + 119 * MIN, { contextOf: () => 900_000 });
  assert.deepEqual([step.actions, step.state[pane("A")]], [[], undefined], "續命過的 session 被回覆後也歸零：不交棒、重新計時");
  step = keepaliveStep(rowsOf([reply]), step.state, t0 + 120 * MIN, { contextOf: () => 900_000 });
  assert.deepEqual(step.actions.map((a) => a.type), ["keepalive"]);
});

test("排除：🔐 等待授權、開著選單的 💬、封存、💤 閒置的 session 從頭到尾不收到續命訊息、不被交棒", () => {
  const now = Date.now();
  const old = now - 3 * 60 * MIN;
  const list = [
    { id: "C", n: 3, state: "waiting", toolName: "Bash", toolInput: { command: "npm run migrate" }, since: old },
    { id: "D", n: 4, state: "waiting", toolName: "AskUserQuestion", toolInput: MENU, since: old },
    { id: "E", n: 5, state: "idle", since: old },
    { id: "F", n: 6, text: QUESTION, since: old },
  ];
  const home = homes();
  fs.writeFileSync(path.join(home.WORKTREE_CONSOLE_HOME, "archive.json"), JSON.stringify([{ path: wt(6), paneKey: pane("F"), tag: "PROJ-6", at: old, kind: "waiting", since: old }]));
  const dir = world(list);
  watch(dir, home);
  watch(dir, home);
  assert.deepEqual(sends(dir), [], "watcher 實際一則都不送");
  const rows = rowsOf(list);
  rows[3].sessions[0].archived = true;
  let state = {};
  for (let t = now; t < now + 8 * 60 * MIN; t += 5 * MIN) {
    const step = keepaliveStep(rows, state, t, { contextOf: () => 900_000 });
    assert.deepEqual(step.actions, []);
    state = step.state;
  }
  assert.deepEqual(state, {});
});

test("續命用量：取續命後第一次模型呼叫的快取數字——快取命中時讀取接近整段 context、1 小時寫入只有新增的小段", () => {
  const entries = fs.readFileSync(usageFixture, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const before = entries.filter((e) => e.type === "assistant").at(0).message.usage;
  const context = before.input_tokens + before.cache_read_input_tokens + before.cache_creation_input_tokens;
  const u = keepaliveUsage(entries);
  assert.ok(u.cacheRead >= context * 0.95, `讀取 ${u.cacheRead} 接近整段 context ${context}`);
  assert.ok(u.cacheWrite1h < context * 0.05, `1h 寫入 ${u.cacheWrite1h} 只有新增的小段`);
  assert.equal(u.cacheWrite5m, 0);
});

test("續命與快取交棒訊息不記成使用者回覆：子 session 的 prompt 紀錄 hook 跳過這兩句", () => {
  const home = homes();
  const managed = wt(7);
  inWorld(world([]), home, () => {
    fs.mkdirSync(path.join(home.WORKTREE_CONSOLE_LOG_DIR, ".state"), { recursive: true });
    fs.writeFileSync(path.join(home.WORKTREE_CONSOLE_LOG_DIR, ".state", "managed.json"), JSON.stringify({ worktrees: [{ path: managed, repo: "app", ticket: "PROJ-7" }], repos: [], consoles: [], handles: {} }));
  });
  for (const prompt of [KEEPALIVE_TEXT, CACHE_HANDOFF_TEXT, "用 A"]) {
    spawnSync(process.execPath, [path.join(root, "hooks", "console-log.mjs"), "user-prompt"], {
      input: JSON.stringify({ session_id: "sid", cwd: managed, prompt }),
      encoding: "utf8",
      env: { ...envFor(world([]), home), ORCA_TERMINAL_HANDLE: "term_child" },
    });
  }
  const prompts = inWorld(world([]), home, () => readEvents()).filter((e) => e.event === "prompt");
  assert.deepEqual(prompts.map((e) => e.text), ["用 A"]);
});
