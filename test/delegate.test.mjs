import "./fixtures/isolate-env.mjs";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp;
let seq = 0;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-")));
  process.env.WORKTREE_CONSOLE_LOG_DIR = path.join(tmp, "log");
  process.env.SARA_DEV_FLOW_HOME = path.join(tmp, "dev-flow");
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { agentStatus } = await import("../skills/worktree-console/scripts/lib.mjs");
const { classify, sheetDecisions, reportClear, URGENT, SHEET_ANSWER, JUDGE_WAIT_MS } = await import("../skills/worktree-console/scripts/urgency.mjs");
const { delegateStep, verdicts } = await import("../skills/worktree-console/scripts/delegate.mjs");
const { stateOf, worktreeOf, append } = await import("../skills/worktree-console/scripts/review.mjs");
const { deliverReview, flushOutbox, readOutbox, targetSession } = await import("../skills/worktree-console/scripts/review-deliver.mjs");

function gitDir(branch = "feat/demo") {
  const dir = path.join(tmp, `wt${++seq}`);
  fs.mkdirSync(dir);
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  git("init", "-q", "-b", branch);
  git("commit", "-q", "--allow-empty", "-m", "i");
  // A pushed branch, so a stop ending in 已完成 is closable rather than waiting on a push.
  spawnSync("git", ["init", "-q", "--bare", `${dir}.git`]);
  git("remote", "add", "origin", `${dir}.git`);
  git("push", "-q", "origin", branch);
  return dir;
}

const NOW = Date.parse("2026-11-16T10:00:00Z");
const ASK = "**第 3 題：先做哪個？**\n\n- **a.** 先改 API\n- **b.** 先改畫面\n\n建議：b，畫面先定";

function world({ text = ASK, state = "done", since = NOW - 10_000, branch = "feat/demo", extra = {} } = {}) {
  const dir = gitDir(branch);
  const status = agentStatus({ state, lastAssistantMessage: text, ...extra });
  const session = { n: null, handle: `h${seq}`, paneKey: `p${seq}`, since, agent: { state, stateStartedAt: since }, status };
  const row = { repo: path.basename(dir), label: `T${seq}`, ticket: `T${seq}`, branch, path: dir, title: "x", stage: "規劃中", sessions: [session] };
  return { dir, row, session, rows: [row], item: { tag: row.label, row, session, kind: status.kind === "waiting" ? "text" : status.kind, entries: [{ question: "q" }] } };
}

function advisor({ path: target, urgent = null, brief = [{ question: "先做哪個畫面？", plan: "先改畫面", impact: "訂單頁" }], status = "done", at = NOW - 5_000, precedentText = null } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, "advisor-"));
  const log = path.join(home, "calls.log");
  const script = path.join(home, "advisor.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\n`);
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ script, types: {} }));
  const lines = [{ event: "start", id: "p1", at: new Date(at).toISOString(), path: target, kind: "text", question: ASK }];
  if (status === "done") lines.push({ event: "done", ref: "p1", at: new Date(at).toISOString(), answer: "b", reason: "畫面先定", type: "t", principle: null, precedent: null, urgent, brief, precedentText });
  fs.writeFileSync(path.join(home, "predictions.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(home, "answers.jsonl"), "");
  process.env.ADVISOR_HOME = home;
  return { home, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}

const consoleHome = () => {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  process.env.WORKTREE_CONSOLE_HOME = home;
  return home;
};
const ready = (extra = {}) => ({ id: "p1", status: "ready", answer: "b", urgent: null, brief: [{ question: "q？", plan: "p", impact: "i" }], ...extra });

test("緊急名單 10 類一律上橫條不代回：等待授權、session 異常馬上上；advisor 判出的類別上；一則多題其中一題緊急整則上", () => {
  const w = world();
  assert.deepEqual(classify({ ...w.item, kind: "permission" }), { band: true, urgent: "等待授權" });
  assert.deepEqual(classify({ ...w.item, kind: "anomaly" }), { band: true, urgent: "session 異常" });
  for (const u of URGENT.slice(2)) assert.deepEqual(classify(w.item, { prediction: ready({ urgent: u }), now: NOW }), { band: true, urgent: u }, u);
  const several = world({ text: `**第 1 題：命名？**\n\n- **a.** x\n- **b.** y\n\n建議：a，短\n\n**第 2 題：要 push 嗎？**\n\n- **a.** 要\n- **b.** 不要\n\n建議：b，先別推` });
  assert.equal(classify(several.item, { prediction: ready({ urgent: "不可逆或對外動作" }), now: NOW }).band, true, "一題緊急整則上橫條");
  const split = classify(several.item, { prediction: ready({ brief: [{ question: "命名？", plan: "用 x", impact: "a" }, { question: "要不要拆檔？", plan: "不拆", impact: "b" }] }), now: NOW });
  assert.equal(split.delegate.items.length, 2, "一則多題拆成多件審核項目");
});

test("其他題等 advisor 判完：判斷中不上橫條；超過 2 分鐘判不出來（還在判、失敗、沒有預測）算緊急；非緊急直接代回", () => {
  const w = world({ since: NOW - 10_000 });
  assert.deepEqual(classify(w.item, { prediction: { status: "pending" }, now: NOW }), { band: false, wait: true });
  assert.deepEqual(classify(w.item, { prediction: null, now: NOW }), { band: false, wait: true });
  const late = NOW + JUDGE_WAIT_MS;
  for (const p of [{ status: "pending" }, null]) assert.deepEqual(classify(w.item, { prediction: p, now: late }), { band: true, urgent: "判斷不出是否緊急" });
  assert.deepEqual(classify(w.item, { prediction: { status: "failed" }, now: NOW }), { band: true, urgent: "判斷不出是否緊急" });
  assert.deepEqual(classify(w.item, { prediction: ready({ urgent: undefined }), now: NOW }), { band: true, urgent: "判斷不出是否緊急" }, "舊預測沒判緊急算判斷不出");
  const d = classify(w.item, { prediction: ready({ precedentText: "11/10 你回「b」" }), now: NOW });
  assert.equal(d.band, false);
  assert.equal(d.delegate.answer, "b");
  assert.deepEqual(d.delegate.items[0].basis, { kind: "precedent", source: "11/10 你回「b」" });
});

test("沒有選項的開放題照同一套規則代回（一般句子與「第 N 題」都算）；緊急的照舊上橫條", () => {
  const answer = ready({ answer: "寫安裝與用法兩段" });
  for (const text of ["README 要寫什麼內容？", "做完了。\n\nREADME 要寫什麼內容？", "**第 2 題：README 要寫什麼內容？**\n\n建議：安裝與用法"]) {
    const v = classify(world({ text }).item, { prediction: answer, now: NOW });
    assert.equal(v.band, false, text);
    assert.equal(v.delegate.answer, "寫安裝與用法兩段", text);
  }
  assert.deepEqual(classify(world({ text: "要先做哪張票？" }).item, { prediction: ready({ urgent: URGENT[3] }), now: NOW }), { band: true, urgent: URGENT[3] });
});

test("一般句子的問號要在最後一段、而且不在程式碼、引用框、表格或標題裡，才算在問；不算的照舊上橫條", () => {
  const notAsking = [
    "為什麼會壞？因為少了一個參數。\n\n已經修好，測試都過了。",
    "已經修好。\n\n## 為什麼會壞？",
    "已經修好。\n\n> 要不要順便改？",
    "已經修好。\n\n| 題目 | 要改嗎？ |\n|---|---|\n| a | 是 |",
    "已經修好。\n\n```\nif (ok?) run()\n```",
  ];
  for (const text of notAsking) {
    const v = classify(world({ text }).item, { prediction: ready(), now: NOW });
    assert.equal(v.delegate, undefined, text);
  }
  assert.equal(classify(world({ text: "已經修好。\n\n要順便把舊測試也改掉嗎？" }).item, { prediction: ready(), now: NOW }).band, false);
});

test("面板與看板的 💬 跟代回同一條：「第 N 題」、a b c 選項或最後一段有問句才算在問；自問自答的報告顯示 ⏸", () => {
  const kind = (text) => agentStatus({ state: "done", lastAssistantMessage: text }).kind;
  for (const text of [ASK, "**第 2 題：README 要寫什麼內容？**\n\n建議：安裝與用法", "要用哪個？\n\n- **a.** 甲\n- **b.** 乙\n\n建議 a", "做完了。\n\n要順便改舊測試嗎？"]) assert.equal(kind(text), "waiting", text);
  for (const text of ["為什麼會壞？因為少了一個參數。\n\n已經修好，測試都過了。", "已經修好。\n\n## 為什麼會壞？", "已經修好。\n\n| 題目 | 要改嗎？ |\n|---|---|\n| a | 是 |", "已經修好，測試都過了。"]) assert.equal(kind(text), "done", text);
});

test("dev-flow 未定題算緊急第 5 類；攔截點停下的那則一律不代回", () => {
  const und = world({ text: `未定 1 題\n第 1 題（gate#016a044c-1）：重置要不要進草稿；暫定：照 plan\n\n${ASK}` });
  assert.deepEqual(classify(und.item, { prediction: ready(), now: NOW }), { band: true, urgent: URGENT[4] });
  const gated = world({ text: `審核單：T1\nfeat/demo  repo\n\n${ASK}` });
  assert.equal(classify(gated.item, { prediction: ready(), now: NOW }).band, true);
  const w = world();
  assert.equal(classify(w.item, { prediction: ready(), now: NOW, gateBlocked: true }).band, true);
});

const FULL_SHEET = [
  "走完整：會動到訂單頁",
  "",
  "**第 1 題：批改單這樣定稿嗎？**",
  "",
  "**已決定**",
  "1. 沿用現有表格元件",
  "",
  "────────────────────",
  "",
  "**待決定 1：空狀態要顯示什麼？**",
  "",
  "- **a.** 沿用目前沒有資料：不改文案",
  "- **b.** 新文案：要翻譯",
  "",
  "建議：a，不用新增翻譯",
  "",
  "────────────────────",
  "",
  "**待決定 2：預設排序？**",
  "",
  "- **a.** 建立時間：新到舊",
  "- **b.** 名稱",
  "",
  "建議：a，跟列表頁一致",
  "",
  "────────────────────",
  "",
  "**整張單的建議**：1 選 a、2 選 a",
  "",
  "- **a.** 全照建議並動工：照單定稿",
  "- **b.** 全照建議先不動工：同 a",
  "- **c.** 要改：回「1 b」",
  "",
  "建議：a，都有出處",
].join("\n");

test("前端完整路徑的批改單代回「全照建議」，開頭固定（中控台代回，待實作前審核）；每個待決定一件、當前方案是它的建議；有 🔴 算緊急", () => {
  const w = world({ text: FULL_SHEET });
  const v = classify(w.item, { now: NOW });
  assert.equal(v.band, false);
  assert.equal(v.delegate.answer, SHEET_ANSWER);
  assert.ok(SHEET_ANSWER.startsWith("（中控台代回，待實作前審核）"));
  assert.deepEqual(v.delegate.items.map((x) => [x.question, x.plan]), [["空狀態要顯示什麼？", "沿用目前沒有資料"], ["預設排序？", "建立時間"]]);
  assert.deepEqual(sheetDecisions(FULL_SHEET).map((d) => d.reason), ["不用新增翻譯", "跟列表頁一致"]);
  const red = world({ text: FULL_SHEET.replace("**待決定 2：", "**待決定 2：🔴 ") });
  assert.deepEqual(classify(red.item, { now: NOW }), { band: true, urgent: "代價高的決定" });
});

test("define-goal 與前端精簡路徑的批改單不代回：那張批改單就是這張票的實作前審核", () => {
  const lean = world({ text: FULL_SHEET.replace("走完整", "走精簡") });
  assert.equal(classify(lean.item, { now: NOW }).band, true);
  const goal = world({ text: FULL_SHEET.replace("走完整：會動到訂單頁\n\n", "") });
  assert.equal(classify(goal.item, { now: NOW }).band, true);
  const leanByGoal = world({ text: FULL_SHEET.replace("走完整：會動到訂單頁\n\n", ""), branch: "feat/lean" });
  const run = path.join(tmp, "dev-flow", leanByGoal.row.repo, "feat-lean");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, "goal.md"), "---\npath: lean\n---\n");
  assert.equal(classify(leanByGoal.item, { now: NOW }).band, true);
});

const SUBMIT = "做完了，已在本機 commit abc123。\n\n檢查完回「送審」，我會開新分頁交棒 /sara-frontend-v3:finalize 收尾";
const REPORT_OK = "# implement report\n\n## 總結\n通過 5 條、不通過 0 條、需人工判定 0 條\n\n## 卡點與待裁決\n無\n\n## 證據\nx\n";

test("前端 implement 停在回「送審」：報告乾淨就自動送「送審」；卡點不是無、有需人工判定的準則、或那則另帶題目時不送、照常上待回覆", () => {
  const w = world({ text: SUBMIT, branch: "feat/impl" });
  const run = path.join(tmp, "dev-flow", w.row.repo, "feat-impl");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, "implement-report.md"), REPORT_OK);
  const item = { ...w.item, kind: "done" };
  assert.equal(w.session.status.kind, "done");
  assert.deepEqual(classify(item, { now: NOW }), { band: false, submit: true });
  fs.writeFileSync(path.join(run, "implement-report.md"), REPORT_OK.replace("## 卡點與待裁決\n無", "## 卡點與待裁決\n- AC3 缺帳號"));
  assert.equal(classify(item, { now: NOW }).band, true);
  fs.writeFileSync(path.join(run, "implement-report.md"), REPORT_OK.replace("需人工判定 0 條", "需人工判定 2 條"));
  assert.equal(classify(item, { now: NOW }).band, true);
  assert.equal(reportClear(null), false, "讀不到報告不送");
  fs.writeFileSync(path.join(run, "implement-report.md"), REPORT_OK);
  const withQ = { ...item, session: { ...item.session, status: { ...item.session.status, text: `${SUBMIT}\n\n**第 1 題：要不要順便改標題？**` } } };
  assert.equal(classify(withQ, { now: NOW }).band, true, "那則停下帶題目時不送");
});

test("代回：先寫 review add 再用 reply --only 送；advisor 用自己的指令記成代回；輸入框有字時不代回；同一題不送第二次", () => {
  const w = world();
  const adv = advisor({ path: w.dir, precedentText: null });
  const home = consoleHome();
  fs.writeFileSync(path.join(home, "focus.json"), JSON.stringify({ typingAt: NOW - 1000 }));
  const sent = [];
  const send = (tag, text) => {
    sent.push([tag, text, stateOf(worktreeOf(w.dir)).open.length]);
    return true;
  };
  assert.deepEqual(delegateStep(w.rows, { now: NOW, home, send }), []);
  assert.deepEqual(sent, [], "輸入框有字時不代回");
  fs.writeFileSync(path.join(home, "focus.json"), JSON.stringify({ typingAt: 0 }));
  assert.deepEqual(delegateStep(w.rows, { now: NOW, home, send }), [`[${w.row.label}] 已代回：b`]);
  assert.deepEqual(sent, [[w.row.label, "b", 1]], "送出時審核項目已寫好");
  const [it] = stateOf(worktreeOf(w.dir)).open;
  assert.deepEqual([it.question, it.plan, it.impact, it.by, it.basis.kind, it.predictionId], ["先做哪個畫面？", "先改畫面", "訂單頁", "advisor", "none", "p1"]);
  assert.ok(adv.calls().some((c) => c.startsWith("auto --tag")), "advisor auto 記成代回");
  delegateStep(w.rows, { now: NOW + 1000, home, send });
  assert.equal(sent.length, 1, "不重送");
  assert.equal(verdicts(w.rows, { now: NOW }).find((v) => v.item.session === w.session).verdict.band, false, "代回過的題不上橫條");
});

test("代回送失敗：補一行「未送出」、撤回 advisor 紀錄，題目改上橫條", () => {
  const w = world();
  const adv = advisor({ path: w.dir });
  const home = consoleHome();
  assert.deepEqual(delegateStep(w.rows, { now: NOW, home, send: () => false }), [`[${w.row.label}] 代回沒送出`]);
  const lines = fs.readFileSync(path.join(tmp, "log", "reviews", w.row.repo, "feat", "demo", "review.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ["add", "unsent"]);
  assert.ok(adv.calls().some((c) => c.startsWith("undo")));
  assert.equal(verdicts(w.rows, { now: NOW }).find((v) => v.item.session === w.session).verdict.band, true);
});

test("沒裝 advisor 時一律照舊上橫條，不代回", () => {
  const w = world();
  process.env.ADVISOR_HOME = path.join(tmp, "no-advisor");
  consoleHome();
  assert.equal(verdicts(w.rows, { now: NOW })[0].verdict.band, true);
  assert.deepEqual(delegateStep(w.rows, { now: NOW, send: () => assert.fail("不該送") }), []);
});

const handoff = (oldSessionId, newSessionId, ts = new Date(NOW).toISOString()) => ({ event: "handoff", ok: true, oldSessionId, newSessionId, ts });

test("審核結果回送：沿交棒事件的舊／新 session 找到現在的 session；正在工作先排隊，停下再送", () => {
  const w = world();
  const events = [handoff("s-old", "s-mid"), handoff("s-mid", "s-new")];
  const idOf = () => "s-new";
  const hit = targetSession(w.rows, w.dir, ["s-old"], { events, now: NOW, idOf });
  assert.equal(hit.s, w.session);
  w.session.status = { kind: "busy", text: "" };
  const sent = [];
  const line = deliverReview(w.rows, w.dir, "審核完成：1 件通過、0 件已改，請重跑剛才被擋的指令", ["s-old"], { events, now: NOW, idOf, send: (tag, text) => (sent.push([tag, text]), { ok: true, out: `[${tag}] 已送出` }) });
  assert.match(line, /正在工作，審核結果排隊，停下再送/);
  assert.deepEqual(sent, []);
  assert.equal(readOutbox().length, 1);
  assert.deepEqual(flushOutbox(w.rows, { events, now: NOW, idOf, send: () => assert.fail("還在工作不送") }), []);
  w.session.status = agentStatus({ state: "done", lastAssistantMessage: "被擋下了，等審核。" });
  w.row.stage = "規劃中";
  const out = flushOutbox(w.rows, { events, now: NOW, idOf, send: (tag, text) => (sent.push([tag, text]), { ok: true, out: `[${tag}] 已送出` }) });
  assert.deepEqual(out, [`[${w.row.label}] 已送出`]);
  assert.deepEqual(sent, [[w.row.label, "審核完成：1 件通過、0 件已改，請重跑剛才被擋的指令"]]);
  assert.equal(readOutbox().length, 0);
});

test("審核結果回送找不到交棒鏈（超過 24 小時、或 dev-flow 自己換分頁）時，送給那個 worktree 目前沒封存的 session", () => {
  const w = world();
  const archived = { ...w.session, handle: "hz", archived: true };
  w.row.sessions = [archived, w.session];
  const old = [handoff("s-old", "s-new", new Date(NOW - 25 * 3600_000).toISOString())];
  const idOf = (s) => (s === archived ? "s-new" : "s-other");
  assert.equal(targetSession(w.rows, w.dir, ["s-old"], { events: old, now: NOW, idOf }).s, w.session, "超過 24 小時");
  assert.equal(targetSession(w.rows, w.dir, ["s-gone"], { events: [], now: NOW, idOf }).s, w.session, "沒有交棒鏈");
});

test("整張審核單審完，不論有沒有改，一律送一則開頭「（中控台自動訊息，不是使用者的新指令）」的「審核完成：N 件通過、M 件已改，請重跑剛才被擋的指令」，有改的件一起附上；通過算猜中、改了算猜錯寫回 advisor", async () => {
  const { finishRound } = await import("../skills/worktree-console/scripts/review-cli.mjs");
  const w = world();
  const adv = advisor({ path: w.dir });
  const wt = worktreeOf(w.dir);
  const { addItem } = await import("../skills/worktree-console/scripts/review.mjs");
  for (const [q, pid] of [["一？", "pa"], ["二？", "pb"]]) addItem(wt, { question: q, plan: "x", basis: { kind: "none", note: "" }, impact: "y", by: "advisor", stop: "s", predictionId: pid, session: "s1" });
  append(wt, { event: "pass", n: 1 });
  append(wt, { event: "edit", n: 2, to: "改用實線" });
  const r = finishRound(wt);
  assert.equal(r.message, "（中控台自動訊息，不是使用者的新指令）審核完成：1 件通過、1 件已改，請重跑剛才被擋的指令\n\n已改的件：\n2. 二？：改成 改用實線");
  // advisor.mjs watcherText: the tab-answer hook skips prompts starting 「（中控台自動」.
  assert.match(r.message, /^（中控台自動/);
  assert.ok(stateOf(wt).approved);
  assert.deepEqual(adv.calls().filter((c) => c.startsWith("verdict")), ["verdict --prediction pa --hit yes", "verdict --prediction pb --hit no"]);
  addItem(wt, { question: "三？", plan: "x", basis: { kind: "none", note: "" }, impact: "y", by: "advisor", stop: "s" });
  append(wt, { event: "pass", n: 3 });
  assert.equal(finishRound(wt).message, "（中控台自動訊息，不是使用者的新指令）審核完成：1 件通過、0 件已改，請重跑剛才被擋的指令", "沒有改也送");
});

test("draft PR／MR 開好後，把審核單的 Markdown 版與實作階段的代回補進說明一次，和「請先看」合成一份", async () => {
  const { mergeBody, prNoteStep, resetChecks } = await import("../skills/worktree-console/scripts/pr-note.mjs");
  const { addItem } = await import("../skills/worktree-console/scripts/review.mjs");
  const w = world();
  const wt = worktreeOf(w.dir);
  addItem(wt, { question: "規劃時的題？", plan: "照做", basis: { kind: "none", note: "" }, impact: "a", by: "advisor", stop: "s" });
  append(wt, { event: "pass", n: 1 });
  append(wt, { event: "done" });
  append(wt, { event: "approved" });
  addItem(wt, { question: "實作時的題？", plan: "照做", basis: { kind: "precedent", source: "AGENTS.md" }, impact: "b", by: "child", stop: "s" });
  const body = "## 目標\n\nx\n\n## 請先看\n\n- ⚠️ 推測的決定 A\n\n## Summary\n\ny\n";
  const updates = [];
  const find = () => ({ label: "PR #9", body, update: (b) => (updates.push(b), true) });
  resetChecks();
  assert.deepEqual(prNoteStep(w.rows, { now: NOW, find }), ["[demo] 已把審核單補進 PR #9 的說明"]);
  const out = updates[0];
  assert.equal(out.match(/請先看/g).length, 1, "合成一份");
  const section = out.slice(out.indexOf("## 請先看"), out.indexOf("## Summary"));
  assert.match(section, /推測的決定 A/);
  assert.match(section, /實作前審核[\s\S]*規劃時的題？（通過）/);
  assert.match(section, /實作階段的代回[\s\S]*實作時的題？（待審）/);
  resetChecks();
  assert.deepEqual(prNoteStep(w.rows, { now: NOW + 3600_000, find }), [], "只補一次");
  assert.equal(updates.length, 1);
  assert.match(mergeBody("只有內文", ["- x"]), /^只有內文\n\n## 請先看\n\n- x\n$/);
});

test("involvement.mjs：涉入佔比＝你回答÷全部回答；每天回答次數；每天超過 25 分鐘沒被打斷的段數（代回送出的那筆不算你回答）", async () => {
  const { involvement, involvementLines, quietStretches } = await import("../skills/worktree-console/scripts/involvement.mjs");
  const log = fs.mkdtempSync(path.join(tmp, "inv-log-"));
  const adv = fs.mkdtempSync(path.join(tmp, "inv-adv-"));
  const t = (h, m) => new Date(2026, 10, 2, h, m).toISOString();
  const ev = [
    { ts: t(9, 0), event: "stop" },
    { ts: t(9, 10), event: "answer", ticket: "A", delivery: "delivered" },
    { ts: t(9, 20), event: "answer", ticket: "A", delivery: "failed: x" },
    { ts: t(10, 0), event: "answer", ticket: "B", delivery: "delivered" },
    { ts: t(11, 0), event: "answer", ticket: "C", delivery: "delivered" },
    { ts: t(12, 0), event: "stop" },
  ];
  fs.writeFileSync(path.join(log, "2026-11-02.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(adv, "answers.jsonl"), [{ event: "answer", source: "auto", tag: "C", ts: t(11, 0) }, { event: "answer", source: "tab", ts: t(9, 40) }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = involvement({ from: "2026-11-02", until: "2026-11-03", home: log, advisor: adv });
  assert.deepEqual([r.you, r.auto], [3, 1]);
  assert.deepEqual(r.rows[0], { day: "2026-11-02", answers: 3, quiet: 2, active: true }, "09:10→09:40 與 10:00→12:00 兩段");
  assert.equal(r.rows[1].active, false);
  const out = involvementLines(r);
  assert.equal(out[1], "涉入佔比：75.0%（你回答 3 次、代回 1 次）");
  assert.ok(out.includes("| 11-02 | 3 | 2 |"));
  assert.equal(quietStretches([], 0, 26 * 60_000), 1);
  assert.equal(quietStretches([], 0, 25 * 60_000), 0);
});

test("自動送審：watcher 這一輪對報告乾淨的送審停點送「送審」，同一停點不送第二次", () => {
  const w = world({ text: SUBMIT, branch: "feat/impl2" });
  const run = path.join(tmp, "dev-flow", w.row.repo, "feat-impl2");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, "implement-report.md"), REPORT_OK);
  process.env.ADVISOR_HOME = path.join(tmp, "no-advisor");
  const home = consoleHome();
  const sent = [];
  const send = (tag, text) => (sent.push([tag, text]), true);
  assert.deepEqual(delegateStep(w.rows, { now: NOW, home, send }), [`[${w.row.label}] 已自動回覆：送審`]);
  delegateStep(w.rows, { now: NOW + 5000, home, send });
  assert.deepEqual(sent, [[w.row.label, "送審"]]);
});

const { autoReplyOf } = await import("../skills/worktree-console/scripts/auto-reply.mjs");
const { waitingLine, awaitsDecision, awaitsUser, readBumped } = await import("../skills/worktree-console/scripts/waiting-line.mjs");
const { asksUser } = await import("../skills/worktree-console/scripts/lib.mjs");

test("代回中：session 正在跑、而且這一輪是中控台最近一筆代回送出後才開始的，才回傳代回的答案；停下、自己另外下指令、送失敗都不算", () => {
  const sentAt = NOW - 30_000;
  const busy = (startedAt) => world({ state: "working", since: startedAt }).session;
  const s = busy(sentAt + 3_000);
  const key = (x) => `${x.paneKey}@${sentAt - 60_000}`;
  assert.equal(autoReplyOf(s, { [key(s)]: { at: sentAt, answer: "先改 API" } }), "先改 API");
  assert.equal(autoReplyOf(s, { [key(s)]: { at: sentAt, submit: true } }), "送審");
  assert.equal(autoReplyOf(s, { [key(s)]: { at: sentAt, failed: true } }), null, "送失敗不算");
  assert.equal(autoReplyOf(s, {}), null);
  const later = busy(sentAt + 10 * 60_000);
  assert.equal(autoReplyOf(later, { [key(later)]: { at: sentAt, answer: "先改 API" } }), null, "停下後使用者自己下指令的那一輪不算");
  const stopped = world({ state: "done", since: sentAt + 3_000, text: "做完了。" }).session;
  assert.equal(autoReplyOf(stopped, { [key(stopped)]: { at: sentAt, answer: "先改 API" } }), null, "停下就不算");
});

test("waiting-line：一行「等待：…｜自動處理中：…｜在跑：…｜延後處理：…」，空的寫「無」；⏸ 只有最後一段在等使用者決定才算等待", () => {
  const sentAt = NOW - 30_000;
  const asking = world({ text: "做完了。\n\n要順便改舊測試嗎？" });
  const report = world({ text: "為什麼會壞？因為少了參數。\n\n已經修好。" });
  const decide = world({ text: "原型開好了。\n\n看完請說「定稿」。" });
  const auto = world({ state: "working", since: sentAt + 2_000 });
  const run = world({ state: "working", since: NOW - 5_000 });
  const rows = [asking, report, decide, auto, run].map((w) => w.row);
  const delegated = { [`${auto.session.paneKey}@x`]: { at: sentAt, answer: "b" } };
  const tag = (w) => w.row.label;
  assert.equal(waitingLine(rows, delegated, {}), `等待：${tag(asking)}、${tag(decide)}｜自動處理中：${tag(auto)}｜在跑：${tag(run)}｜延後處理：無`);
  assert.equal(waitingLine([report.row], {}, {}), "等待：無｜自動處理中：無｜在跑：無｜延後處理：無");
  assert.equal(awaitsDecision("請你確認\n\n已經修好。"), false, "只看最後一段");
});

// Two finalize stops that waited on the review page and were left off the line: the ask is 按「送出決定」 in the last paragraph, 等你 only in the first.
const REVIEW_PAGE_A = [
  "審核頁已經開好，我在等你決定。",
  "**目前進度**\n- branch 檢查通過。\n- 審查找到 6 條，都不阻斷。其中 3 條我已經直接修好。",
  "**要你決定的 3 條**（每張卡片選「修正」「接受風險（A）」或「誤判（F）」）\n1. 通知選單會多渲染一次。\n2. 通知彈窗裡有兩處型別強轉。\n3. 表單送出後用了一次型別強轉。",
  "另外提醒一件事：origin/dev 已經比這個 branch 多 43 個 commit。",
  "## 下一步\n- 3 條都決定好 → 在審核頁按「送出決定」，不用回話，我會接著做。",
].join("\n\n");
const REVIEW_PAGE_B = [
  "收尾跑到 code review，現在停在審核頁，等你在上面做決定。",
  "**目前進度**\n- 開工檢查通過。\n- 3 條已自動修，修完 lint、型別檢查、相關測試都通過。",
  "**需要你在審核頁決定的 2 條**\n- **R2**：用 effect 把「等待中」的標記清掉。\n- **R5**：用 effect 把清單焦點拉回第一列。",
  "我建議兩條都按「接受風險（A）」，理由寫「目前行為正確，改寫風險大於好處」。按「送出決定」後，我會接著做到開 draft MR。",
].join("\n\n");

test("waiting-line：等使用者的說法——回我「…」、按「…」、送出決定、審核頁／確認頁＋動作、要你、你同意、你拍板、待你、回 a／b／c；「跟我說」「告訴我」與否定說法不算", () => {
  for (const t of ["改好了，回我「定稿」就收尾。", "在審核頁按「送出決定」。", "三條都看完就送出決定。", "審核頁開好了，請在上面勾選要修的。", "確認頁上選一個方案。", "這裡需要你看一下截圖。", "你同意的話我就合併。", "這個方向等你拍板。", "還有兩條待你處理。", "回 a／b／c 其中一個。", "回 a 或 b。"]) {
    assert.equal(awaitsDecision(`已經跑完。\n\n${t}`), true, t);
  }
  for (const t of ["有問題再跟我說。", "想看細節可以告訴我。", "這步不需要你介入。", "不用等你回，我會接著做。", "期待你的回饋。"]) {
    assert.equal(awaitsDecision(`已經跑完。\n\n${t}`), false, t);
  }
});

test("waiting-line：等你寫在倒數 2–4 段、後面只是備註、提醒、標題或分隔線也算等待；後面是一般內容或超過四段就不算", () => {
  assert.equal(awaitsDecision("改法有兩種，請你確認要哪個。\n\n備註：舊測試沒動。"), true);
  assert.equal(awaitsDecision("請你確認改法。\n\n另外：CI 已過。\n\n提醒：明天要升版。\n\n---"), true, "等你在倒數第 4 段");
  assert.equal(awaitsDecision("請你確認改法。\n\n備註：a\n\n備註：b\n\n備註：c\n\n備註：d"), false, "倒數第 5 段太遠");
  assert.equal(awaitsDecision("請你確認\n\n已經修好。"), false, "後面一段是一般內容");
});

test("waiting-line：兩個 finalize 停在審核頁的回覆（最後一段只寫按「送出決定」）列進等待", () => {
  const a = world({ text: REVIEW_PAGE_A });
  const b = world({ text: REVIEW_PAGE_B });
  assert.deepEqual([a.session.status.kind, b.session.status.kind], ["done", "done"], "沒有問號，是 ⏸");
  assert.equal(waitingLine([a.row, b.row], {}, {}), `等待：${a.row.label}、${b.row.label}｜自動處理中：無｜在跑：無｜延後處理：無`);
});

test("💬：問句後面接「等你：…」結尾行或備註段照樣算在問；問句後面是一般內容不算", () => {
  assert.equal(asksUser("做完了。\n\n要先改 A 還是 B？\n\n等你：回 a 或 b"), true);
  assert.equal(asksUser("要順便改舊測試嗎？\n\n備註：CI 已過。"), true);
  assert.equal(asksUser("要順便改舊測試嗎？\n\n已經修好了。"), false);
  assert.equal(agentStatus({ state: "done", lastAssistantMessage: "要先改 A 還是 B？\n\n等你：回 a 或 b" }).kind, "waiting");
});

test("waiting-line：最後一行「等你：…」或「不用等你」先決定，沒寫才看說法；🔐、⚠️、選單照舊算等待", () => {
  const done = (text) => agentStatus({ state: "done", lastAssistantMessage: text });
  assert.equal(awaitsUser(done("已經修好。\n\n等你：看完截圖說好不好看")), true, "沒有等你的說法也算");
  assert.equal(awaitsUser(done("請你確認改法。\n\n不用等你")), false, "不用等你蓋過「請你確認」");
  assert.equal(awaitsUser(done("要順便改舊測試嗎？\n\n不用等你")), false, "💬 寫了不用等你也不算");
  assert.equal(awaitsUser(done("已經修好。\n**等你：** 在審核頁按送出")), true, "粗體、同一段的最後一行也認");
  assert.equal(awaitsUser({ kind: "permission", tool: "Bash", input: "x" }), true);
  assert.equal(awaitsUser({ kind: "anomaly", text: "" }), true);
  assert.equal(awaitsUser({ kind: "waiting", text: "", menu: [{ question: "q" }] }), true);
  assert.equal(awaitsUser({ kind: "busy", text: "等你：x" }), false);
});

test("waiting-line：做完的回報最後一行寫「已完成」（或舊寫法「不用等你」）不列進等待；「已完成」後面還接字就不算結尾行", () => {
  const report = "PR 已合併，遠端分支也刪了。\n\n本機分支還在，要清的話離開 worktree 後跑 git worktree remove。\n\n";
  for (const ending of ["已完成", "已完成。", "**已完成**", "不用等你"]) {
    const w = world({ text: `${report}請你確認改法。\n${ending}` });
    assert.equal(awaitsUser(w.session.status), false, ending);
    assert.equal(waitingLine(w.rows, {}, {}, NOW), "等待：無｜自動處理中：無｜在跑：無｜延後處理：無", ending);
  }
  assert.equal(awaitsUser(world({ text: "已完成登入頁，請你確認改法。" }).session.status), true, "已完成後面還接字就不是結尾行");
});

test("waiting-line：在焦點橫條按過延後處理（focus.json 的 bumped）的改列「延後處理」，等超過一天加時數", () => {
  const fresh = world({ text: "請你確認改法。", since: NOW - 2 * 3_600_000 });
  const old = world({ text: "請你確認改法。", since: NOW - 27 * 3_600_000 });
  const still = world({ text: "請你確認改法。" });
  const key = (w) => `${w.session.paneKey}@${w.session.since}`;
  const bumped = { [key(fresh)]: NOW - 3_600_000, [key(old)]: NOW - 3_600_000, [`${still.session.paneKey}@1`]: NOW };
  assert.equal(
    waitingLine([fresh.row, old.row, still.row], {}, bumped, NOW),
    `等待：${still.row.label}｜自動處理中：無｜在跑：無｜延後處理：${fresh.row.label}、${old.row.label}（等了 27 小時）`,
    "同一個分頁前一次停下的跳過紀錄不算這次",
  );
  const home = consoleHome();
  fs.writeFileSync(path.join(home, "focus.json"), JSON.stringify({ bumped }));
  assert.deepEqual(readBumped(home), bumped);
  assert.deepEqual(readBumped(path.join(home, "none")), {});
});

test("waiting-line：續命中的 session 照續命前記下的原題判斷（等你行、關鍵字），不看續命那輪的「收到」", async () => {
  const { applyKeepalive, KEEPALIVE_TEXT } = await import("../skills/worktree-console/scripts/lib.mjs");
  const original = { kind: "done", text: "審核頁開好了。\n\n等你：在審核頁按「送出決定」" };
  const kept = world({ text: "收到", since: NOW - 60_000 });
  kept.session.agent.prompt = KEEPALIVE_TEXT;
  const keepalive = { [kept.session.paneKey]: { phase: "kept", stopAt: NOW - 3_600_000, status: original } };
  applyKeepalive(kept.rows, keepalive);
  assert.equal(kept.session.status.text, original.text, "畫面換回原題");
  assert.equal(waitingLine(kept.rows, {}, {}, NOW, keepalive), `等待：${kept.row.label}｜自動處理中：無｜在跑：無｜延後處理：無`);
  const missed = world({ text: "收到" });
  const byKeyword = { [missed.session.paneKey]: { phase: "sent", stopAt: NOW - 3_600_000, status: { kind: "done", text: "改好了。\n\n請你確認改法。" } } };
  assert.equal(waitingLine(missed.rows, {}, {}, NOW, byKeyword), `等待：${missed.row.label}｜自動處理中：無｜在跑：無｜延後處理：無`, "畫面沒換回原題時也用續命紀錄的原題");
  assert.equal(waitingLine(missed.rows, {}, {}, NOW, {}), "等待：無｜自動處理中：無｜在跑：無｜延後處理：無", "沒有續命紀錄就照畫面");
  const free = { [missed.session.paneKey]: { phase: "kept", stopAt: NOW - 3_600_000, status: { kind: "done", text: "做完了。\n\n不用等你" } } };
  assert.equal(waitingLine(missed.rows, {}, {}, NOW, free), "等待：無｜自動處理中：無｜在跑：無｜延後處理：無");
});
