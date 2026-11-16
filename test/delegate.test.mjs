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

test("整張審核單審完，不論有沒有改，一律送一則「審核完成：N 件通過、M 件已改，請重跑剛才被擋的指令」，有改的件一起附上；通過算猜中、改了算猜錯寫回 advisor", async () => {
  const { finishRound } = await import("../skills/worktree-console/scripts/review-cli.mjs");
  const w = world();
  const adv = advisor({ path: w.dir });
  const wt = worktreeOf(w.dir);
  const { addItem } = await import("../skills/worktree-console/scripts/review.mjs");
  for (const [q, pid] of [["一？", "pa"], ["二？", "pb"]]) addItem(wt, { question: q, plan: "x", basis: { kind: "none", note: "" }, impact: "y", by: "advisor", stop: "s", predictionId: pid, session: "s1" });
  append(wt, { event: "pass", n: 1 });
  append(wt, { event: "edit", n: 2, to: "改用實線" });
  const r = finishRound(wt);
  assert.equal(r.message, "審核完成：1 件通過、1 件已改，請重跑剛才被擋的指令\n\n已改的件：\n2. 二？：改成 改用實線");
  assert.ok(stateOf(wt).approved);
  assert.deepEqual(adv.calls().filter((c) => c.startsWith("verdict")), ["verdict --prediction pa --hit yes", "verdict --prediction pb --hit no"]);
  addItem(wt, { question: "三？", plan: "x", basis: { kind: "none", note: "" }, impact: "y", by: "advisor", stop: "s" });
  append(wt, { event: "pass", n: 3 });
  assert.equal(finishRound(wt).message, "審核完成：1 件通過、0 件已改，請重跑剛才被擋的指令", "沒有改也送");
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
