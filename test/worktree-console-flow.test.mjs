import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let tmp;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-flow-")));
  process.env.WORKTREE_CONSOLE_HOME = path.join(tmp, "home");
  process.env.WORKTREE_CONSOLE_LOG_DIR = path.join(tmp, "log");
  process.env.AUTO_HANDOFF_HOME = path.join(tmp, "handoff");
  process.env.WORKTREE_CONSOLE_PR = "";
  fs.mkdirSync(process.env.WORKTREE_CONSOLE_HOME, { recursive: true });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const focus = await import("../skills/worktree-console/scripts/focus.mjs");
const band = await import("../skills/worktree-console/scripts/band.mjs");
const guide = await import("../skills/worktree-console/scripts/guide.mjs");
const record = await import("../skills/worktree-console/scripts/guide-record.mjs");
const lib = await import("../skills/worktree-console/scripts/lib.mjs");
const line = await import("../skills/worktree-console/scripts/waiting-line.mjs");
const handoff = await import("../hooks/auto-handoff.mjs");
const review = await import("../skills/worktree-console/scripts/review.mjs");
const reviewCli = await import("../skills/worktree-console/scripts/review-cli.mjs");
const gate = await import("../hooks/review-gate.mjs");
const urgency = await import("../skills/worktree-console/scripts/urgency.mjs");
const { emptyFocus, focusReplied, focusSkip, focusStep, order } = focus;

const entry = (tag, since, extra = {}) => ({ key: `${tag}@${since}`, paneKey: tag, handle: `h-${tag}`, tag, kind: "waiting", since, sheet: false, ...extra });
const keys = (list) => list.map((e) => e.key);
const facts = (list) => list.map(([tag, kind, since, extra = {}]) => ({ paneKey: tag, handle: `h-${tag}`, tag, kind, since, goal: false, archived: false, ...extra }));
const text = (rows) => rows.map((r) => band.rowText(r));

// --- 狀態區什麼時候換目前這件 ---

test("換題規則：別的 session 停下只排進隊伍、不換掉目前這件；有別題在等時 8 才出現", () => {
  const a = entry("a", 100);
  let view = focusStep(emptyFocus(), [a], 1_000);
  assert.equal(view.current.key, "a@100");
  view = focusStep(view.state, [a, entry("b", 200), entry("p", 300, { kind: "permission" })], 2_000);
  assert.equal(view.current.key, "a@100", "目前這件不被後來的題目（含授權）換掉");
  assert.deepEqual(keys(view.queue), ["p@300", "b@200"]);
});

test("換題規則：回了目前這件、有別題在等時立刻換成排隊第一件；回過的那件回來時排在等待第一個，不換掉當時的目前這件", () => {
  const [a, b, c] = [entry("a", 100), entry("b", 200), entry("c", 300)];
  const live = facts([["a", "waiting", 100], ["b", "waiting", 200], ["c", "waiting", 300]]);
  let view = focusStep(emptyFocus(), [a, b, c], 1_000, { sessions: live });
  assert.equal(view.current.key, "c@300", "新停下的先");
  const sent = focusReplied(view.state, [a, b, c], [{ paneKey: "c", handle: "h-c", tag: "c", at: 2_000, text: "b" }], 2_000);
  view = focusStep(sent, [a, b, c], 2_000, { sessions: live });
  assert.equal(view.current.key, "b@200", "立刻換成排隊第一件");
  assert.equal(view.wait, null);
  assert.deepEqual(view.state.sent, { paneKey: "c", handle: "h-c", tag: "c", at: 2_000, text: "b" });
  const c2 = entry("c", 2_500);
  view = focusStep(view.state, [a, b, c2], 3_000, { sessions: live });
  assert.equal(view.current.key, "b@200", "回來的那件不換掉目前這件");
  assert.deepEqual(keys(view.queue), ["c@2500", "a@100"], "回來的那件排在等待第一個");
  assert.equal(view.state.sent, null, "回來後不再顯示剛送出");
});

test("換題規則：沒有別題在等時狀態區等它回應，不設時限；它再停下就直接換成它的新狀態", () => {
  const a = entry("a", 100);
  const live = facts([["a", "waiting", 100]]);
  let view = focusStep(emptyFocus(), [a], 1_000, { sessions: live });
  view = focusStep(focusReplied(view.state, [a], [{ paneKey: "a", handle: "h-a", tag: "a", at: 2_000, text: "好" }], 2_000), [a], 2_000, { sessions: live });
  assert.equal(view.current, null);
  assert.deepEqual([view.wait.tag, view.wait.text], ["a", "好"]);
  view = focusStep(view.state, [], 2_000 + 3_600_000, { sessions: facts([["a", "busy", 2_100]]) });
  assert.equal(view.wait?.tag, "a", "一小時後仍在等，沒有 60 秒換題");
  view = focusStep(view.state, [entry("a", 4_000_000)], 4_000_001, { sessions: facts([["a", "waiting", 4_000_000]]) });
  assert.equal(view.current.key, "a@4000000");
  assert.equal(view.wait, null);
});

test("換題規則：等的那件停下時已經不輪到你（可關閉），或回完就進入 /goal，就變成沒有目前這件", () => {
  const a = entry("a", 100);
  const live = facts([["a", "waiting", 100]]);
  const waiting = focusStep(focusReplied(focusStep(emptyFocus(), [a], 1_000, { sessions: live }).state, [a], [{ paneKey: "a", tag: "a", at: 2_000 }], 2_000), [a], 2_000, { sessions: live });
  assert.equal(waiting.wait.tag, "a");
  const closed = focusStep(waiting.state, [], 3_000, { sessions: facts([["a", "done", 2_500]]) });
  assert.deepEqual([closed.current, closed.wait], [null, null]);
  const goal = focusStep(waiting.state, [], 3_000, { sessions: facts([["a", "busy", 2_100, { goal: true }]]) });
  assert.deepEqual([goal.current, goal.wait], [null, null]);
});

test("換題規則：等待中按 8 是「先處理下一件」，換排隊第一件；原本等的那個回來時排在排隊最前面", () => {
  const a = entry("a", 100);
  const live = facts([["a", "waiting", 100]]);
  let view = focusStep(emptyFocus(), [a], 1_000, { sessions: live });
  view = focusStep(focusReplied(view.state, [a], [{ paneKey: "a", tag: "a", at: 2_000 }], 2_000), [a], 2_000, { sessions: live });
  const [b, c] = [entry("b", 3_000), entry("c", 4_000)];
  view = focusStep(view.state, [b, c], 5_000, { sessions: facts([["a", "busy", 2_100], ["b", "waiting", 3_000], ["c", "waiting", 4_000]]) });
  assert.equal(view.current, null, "等待中別題停下不搶目前這件");
  assert.deepEqual(keys(view.queue), ["c@4000", "b@3000"]);
  const busy = facts([["a", "busy", 2_100], ["b", "waiting", 3_000], ["c", "waiting", 4_000]]);
  view = focusStep(focusSkip(view.state, [b, c], 6_000), [b, c], 6_000, { sessions: busy });
  assert.equal(view.current.key, "c@4000");
  const late = entry("a", 2_000 + 60 * 60_000);
  view = focusStep(view.state, [b, c, late], 2_000 + 61 * 60_000, { sessions: busy });
  assert.equal(view.current.key, "c@4000");
  assert.deepEqual(keys(view.queue), [late.key, "b@3000"], "晚了一小時回來仍排最前面");
});

test("換題規則：有目前這件時按 8 延後處理，排到最後、換排隊第一件", () => {
  const [a, b, c] = [entry("a", 100), entry("b", 200), entry("c", 300)];
  let view = focusStep(emptyFocus(), [a, b, c], 1_000);
  assert.equal(view.current.key, "c@300");
  view = focusStep(focusSkip(view.state, [a, b, c], 2_000), [a, b, c], 2_000);
  assert.equal(view.current.key, "b@200");
  assert.deepEqual(keys(view.queue), ["a@100", "c@300"]);
  assert.equal(view.state.bumped["c@300"], 2_000);
});

test("換題規則：輸入框有字或中控台這一輪在跑時，等的那件回來與沒有目前這件時的新題都先不換；清空、這一輪結束後的下一次輪詢才換", () => {
  const a = entry("a", 100);
  const live = facts([["a", "waiting", 100]]);
  let view = focusStep(emptyFocus(), [a], 1_000, { sessions: live });
  view = focusStep(focusReplied(view.state, [a], [{ paneKey: "a", tag: "a", at: 2_000 }], 2_000), [a], 2_000, { sessions: live });
  const a2 = entry("a", 3_000);
  const back = facts([["a", "waiting", 3_000]]);
  const held = focusStep(view.state, [a2], 3_100, { hold: true, sessions: back });
  assert.deepEqual([held.current, held.wait?.tag], [null, "a"]);
  assert.equal(focusStep(held.state, [a2], 3_200, { sessions: back }).current.key, "a@3000");
  const fresh = focusStep(emptyFocus(), [entry("b", 100)], 1_000, { hold: true });
  assert.equal(fresh.current, null, "沒有目前這件時打字中也不放新題上去");
  assert.equal(focusStep(fresh.state, [entry("b", 100)], 1_100).current.key, "b@100");
});

test("換題規則：直接在子 session 分頁回了目前這件（它開始工作）也算回了它", () => {
  const [a, b] = [entry("a", 100), entry("b", 200)];
  let view = focusStep(emptyFocus(), [a, b], 1_000);
  view = focusStep(focusSkip(view.state, [a, b], 1_100), [a, b], 1_100);
  assert.equal(view.current.key, "a@100");
  view = focusStep(view.state, [b], 2_000, { sessions: facts([["a", "busy", 1_500], ["b", "waiting", 200]]) });
  assert.equal(view.current.key, "b@200");
  view = focusStep(view.state, [b, entry("a", 3_000)], 3_100);
  assert.deepEqual(keys(view.queue), ["a@3000"]);
});

// --- 優先順序 ---

test("優先順序：⚠️ 異常 → 接續對話（10 分鐘內剛回過）→ 授權 → 一般題新停下的先 → 批改單與審核擋下新停下的先 → 8 延後的", () => {
  const list = [
    entry("old", 100),
    entry("new", 900),
    entry("perm", 50, { kind: "permission" }),
    entry("sheet1", 200, { sheet: true }),
    entry("sheet2", 800, { sheet: true }),
    entry("bumped", 950),
    entry("back", 700),
    entry("late", 600),
    entry("bad", 990, { kind: "anomaly" }),
    entry("menu", 500, { kind: "waiting" }),
  ];
  const state = { ...emptyFocus(), bumped: { "bumped@950": 1 }, back: { "back@700": { at: 650, pin: false }, "late@600": { at: 600 - 11 * 60_000, pin: false } } };
  assert.deepEqual(order(list, state).map((e) => e.tag), ["bad", "back", "perm", "new", "late", "menu", "old", "sheet2", "sheet1", "bumped"]);
  const pinned = { ...state, back: { "late@600": { at: 0, pin: true } } };
  assert.equal(order(list, pinned)[1].tag, "late", "在狀態區上回過的那件不管多久回來都算接續");
});

test("批改單與審核擋下的停下算在批改單那一層", () => {
  const row = { repo: "r", path: "/nowhere", branch: "b", label: "s", sessions: [] };
  const session = (t) => ({ paneKey: "p", handle: "h", since: 1, status: { kind: "waiting", text: t }, agent: { state: "done", stateStartedAt: 1 } });
  const sheet = "**第 1 題：批改單這樣定稿嗎？**\n\n**待決定 1：要嗎？**\n\n- **a.** 要\n- **b.** 不要\n\n建議：a，好";
  const gateStop = "審核單：s\nfeat/x\n\n1. 先做哪個？\n\n要通過嗎？";
  for (const t of [sheet, gateStop]) {
    const view = focus.syncFocus([{ ...row, sessions: [session(t)] }]);
    assert.equal(view.current.sheet, true, t.slice(0, 10));
  }
});

// --- 狀態區的畫法 ---

const GROUPS = { waiting: ["flow", "tidy"], auto: ["unit"], running: ["advisor-loop"], skipped: [], closable: ["polish"] };
const ADVICE = { state: "ready", text: "", answer: "a", reason: "12 題都照建議就能定稿" };
const OPTIONS = ["全照建議並動工：…", "全照建議先不動工：…"];

test("狀態區：方案 D 的每一行，空組不畫；顏色照組、要你動手的組代號粗體", () => {
  const out = band.bandRows({ current: { tag: "flow", kind: "waiting" }, queue: 1, groups: GROUPS, advice: ADVICE, options: OPTIONS });
  assert.deepEqual(text(out.rows), ["◆ 輪到你  flow", "  建議  a 全照建議並動工  12 題都照建議就能定稿", "  等待  flow  tidy     自動處理中  unit     在跑  advisor-loop     可關閉  polish"]);
  assert.equal(out.rail, "waiting");
  assert.deepEqual(out.rows[0].keys.map((k) => `${k.key} ${k.label}`), ["8 延後處理", "9 顯示問題", "0 面板"]);
  const groupRuns = out.rows[2].variants[0];
  const paint = (t) => groupRuns.filter((r) => r.text === t).map((r) => [r.color ?? null, !!r.bold]);
  assert.deepEqual(paint("等待  "), [["waiting", false]]);
  assert.deepEqual(paint("tidy"), [["waiting", true]]);
  assert.deepEqual(paint("unit"), [[null, false]]);
  assert.deepEqual(paint("advisor-loop"), [[null, false]]);
  assert.deepEqual(paint("可關閉  "), [["closable", false]]);
  assert.deepEqual(paint("polish"), [["closable", true]]);
  assert.deepEqual(paint("自動處理中  "), [["auto", false]]);
  assert.deepEqual(paint("在跑  "), [["running", false]]);
  assert.ok(!band.rowText(out.rows[2]).includes("延後處理"), "空的延後處理不畫");
  assert.equal(out.rows[1].variants[0].at(-1).color, "dim", "建議的理由暗色");
  const alone = band.bandRows({ current: { tag: "flow", kind: "waiting" }, queue: 0, groups: GROUPS });
  assert.deepEqual(alone.rows[0].keys.map((k) => k.key), ["9", "0"], "沒有別題在等時沒有 8");
  const perm = band.bandRows({ current: { tag: "p", kind: "permission" }, groups: {} });
  assert.deepEqual([band.rowText(perm.rows[0]), perm.rail], ["◆ 等待授權  p", "blocked"]);
  assert.deepEqual(band.bandRows({ groups: {} }).rows, [], "什麼都沒有時不畫");
});

test("狀態區：一行放不下時依序把延後處理、在跑、自動處理中、可關閉縮成「組名 數字」，都縮了才把等待最後的代號換成 +N", () => {
  const groups = { waiting: ["flow", "tidy", "cards"], auto: ["unit"], running: ["a1", "a2"], skipped: ["s1"], closable: ["polish"] };
  assert.deepEqual(band.groupVariants(groups).map((v) => v.map((r) => r.text).join("")), [
    "  等待  flow  tidy  cards     自動處理中  unit     在跑  a1  a2     延後處理  s1     可關閉  polish",
    "  等待  flow  tidy  cards     自動處理中  unit     在跑  a1  a2     延後處理 1     可關閉  polish",
    "  等待  flow  tidy  cards     自動處理中  unit     在跑 2     延後處理 1     可關閉  polish",
    "  等待  flow  tidy  cards     自動處理中 1     在跑 2     延後處理 1     可關閉  polish",
    "  等待  flow  tidy  cards     自動處理中 1     在跑 2     延後處理 1     可關閉 1",
    "  等待  flow  tidy  +1     自動處理中 1     在跑 2     延後處理 1     可關閉 1",
    "  等待  flow  +2     自動處理中 1     在跑 2     延後處理 1     可關閉 1",
    "  等待  +3     自動處理中 1     在跑 2     延後處理 1     可關閉 1",
  ]);
});

test("狀態區同步中控台建議：情境 1～5", () => {
  const one = band.bandRows({ current: { tag: "flow", kind: "waiting" }, queue: 1, groups: GROUPS, advice: ADVICE, options: OPTIONS });
  assert.equal(band.rowText(one.rows[1]), "  建議  a 全照建議並動工  12 題都照建議就能定稿");
  const mine = { mine: { answer: "第 4、10 題你本人回，其他照建議", reason: "這兩題問的是你的習慣，代回猜不準" }, self: [4, 10], numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] };
  const two = band.bandRows({ current: { tag: "flow", kind: "waiting" }, queue: 1, groups: GROUPS, advice: ADVICE, options: OPTIONS, guide: mine });
  assert.deepEqual(text(two.rows).slice(1, 4), ["  中控台建議  第 4、10 題你本人回，其他照建議  這兩題問的是你的習慣，代回猜不準", "  advisor 建議  a 全照建議並動工  12 題都照建議就能定稿", "  要你回  4 10     照建議  1～3 5～9 11 12"]);
  assert.ok(two.rows[2].variants[0].every((r) => r.color === "dim"), "advisor 的建議退成暗字");
  assert.deepEqual(two.rows[3].variants[0].find((r) => r.text === "4 10"), { text: "4 10", color: "waiting", bold: true });
  const three = band.bandRows({ wait: { tag: "flow", text: "4 b、10 a，其他照建議" }, queue: 0, groups: { waiting: ["tidy"], running: ["flow"] } });
  assert.deepEqual(text(three.rows), ["◌ 等 flow 回應中…　你回了  4 b、10 a，其他照建議", "  等待  tidy     在跑  flow"]);
  assert.deepEqual(three.rows[0].keys.map((k) => k.key), ["0"]);
  const four = band.bandRows({ current: { tag: "tidy", kind: "waiting" }, queue: 1, groups: { waiting: ["tidy", "cards"], running: ["flow"] }, guide: { mine: { answer: "b 先修測試再推", reason: "同意 advisor，照建議就好" } }, advice: { state: "ready", answer: "b 先修測試再推", reason: "它說 CI 會擋" }, sent: { tag: "flow", text: "4 b、10 a，其他照建議" } });
  assert.deepEqual(text(four.rows), ["◆ 輪到你  tidy", "  中控台建議  b 先修測試再推  同意 advisor，照建議就好", "  advisor 建議  b 先修測試再推  它說 CI 會擋", "  剛送出  flow：4 b、10 a，其他照建議     它回來後排在下一件", "  等待  tidy  cards     在跑  flow"]);
  const five = band.bandRows({ current: { tag: "tidy", kind: "waiting" }, queue: 2, groups: { waiting: ["tidy", "flow", "cards"] }, guide: { mine: { answer: "b 先修測試再推", reason: "同意 advisor，照建議就好" } } });
  assert.equal(band.rowText(five.rows.at(-1)), "  等待  tidy  flow  cards");
  assert.equal(band.numberRanges([11, 1, 2, 3, 5, 6, 7, 8, 9, 12]), "1～3 5～9 11 12");
});

test("每週改善提醒：報告在、提案不在才多一行；兩者都在或報告不在都不顯示；只讀不寫", () => {
  const home = path.join(tmp, "advisor-weekly");
  const base = path.join(home, "reports", `weekly-${band.mondayOf()}`);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  assert.equal(band.weeklyReport(home), null);
  fs.writeFileSync(`${base}.md`, "# 報告");
  assert.equal(band.weeklyReport(home), `${base}.md`);
  const rows = band.bandRows({ groups: { running: ["x"] }, weekly: band.weeklyReport(home) });
  assert.equal(band.rowText(rows.rows.at(-1)), `  [每週改善] 報告：${base}.md`);
  fs.writeFileSync(`${base}-proposals.json`, "[]");
  assert.equal(band.weeklyReport(home), null);
  assert.deepEqual(fs.readdirSync(path.dirname(base)).sort(), [`weekly-${band.mondayOf()}-proposals.json`, `weekly-${band.mondayOf()}.md`]);
  assert.equal(band.mondayOf(new Date(2026, 10, 18, 23).getTime()), "2026-11-16");
  assert.equal(band.mondayOf(new Date(2026, 10, 16, 0, 1).getTime()), "2026-11-16");
});

// --- 子 session 的列與狀態區的資料 ---

let paneN = 0;
function row(label, status, extra = {}) {
  const since = extra.since ?? 1_000 + paneN;
  return {
    repo: "r",
    path: extra.path ?? path.join(tmp, `nowhere-${label}`),
    branch: extra.branch ?? `feat/${label}`,
    label,
    title: label,
    stage: "實作中",
    sessions: [{ paneKey: `p-${label}-${++paneN}`, handle: `h-${label}`, since, status, agent: { state: status.kind === "busy" ? "working" : "done", stateStartedAt: since }, ...(extra.session ?? {}) }],
  };
}
const asking = (t) => ({ kind: "waiting", text: t });

test("狀態區：腳本組的分組那行跟 waiting-line 同一份分組；子 session 停下或開始工作，下一次輪詢就換", () => {
  const rows = [row("flow", asking("要哪個？\n\n- a. 甲\n- b. 乙")), row("tidy", asking("先做哪個？")), row("work", { kind: "busy", text: "" })];
  const draw = (list) => {
    const view = focus.syncFocus(list);
    return focus.focusPayload(list, view).payload.band;
  };
  const first = draw(rows);
  assert.equal(band.rowText(first.rows[0]), `◆ 輪到你  ${focus.loadFocus().current.startsWith(rows[0].sessions[0].paneKey) ? "flow" : "tidy"}`);
  assert.match(band.rowText(first.rows.at(-1)), /^ {2}等待 {2}(flow|tidy) {2}(tidy|flow) {5}在跑 {2}work$/);
  assert.equal(line.waitingLine(rows).split("｜")[0], `等待：${line.waitingGroups(rows).waiting.join("、")}`);
  const ordered = line.waitingGroups(rows, { first: ["tidy", "flow"] }).waiting;
  assert.deepEqual(ordered, ["tidy", "flow"], "狀態區的等待照目前這件與排隊順序排（情境 5）");
  const next = [rows[0], rows[1], row("work", asking("好了，要推嗎？"))];
  const waitingRow = band.rowText(draw(next).rows.at(-1));
  assert.match(waitingRow, /^ {2}等待 {2}\S+ {2}\S+ {2}\S+$/);
  assert.ok(waitingRow.split(/\s+/).includes("work"), "work 停下後下一次輪詢就進等待");
  const quiet = [rows[0], rows[1], row("work", { kind: "busy", text: "" })];
  assert.match(band.rowText(draw(quiet).rows.at(-1)), /在跑 {2}work$/);
});

test("不顯示題目：狀態區與卡片資料都不帶題目文字；/focus-show 的回報照舊是完整題目", () => {
  const q = "這是一題很獨特的題目文字要不要做？";
  const rows = [row("flow", asking(q))];
  const { payload } = focus.focusPayload(rows, focus.syncFocus(rows));
  const bandText = payload.band.rows.map((r) => r.variants.flat().map((x) => x.text).join("")).join("\n");
  assert.ok(!bandText.includes(q));
  assert.equal(payload.sessions[0].question, undefined);
  assert.ok(payload.sessions[0].report.includes(q));
});

// --- 可關閉 ---

function gitRepo(name, { push = true, track = false } = {}) {
  const dir = path.join(tmp, name);
  const remote = path.join(tmp, `${name}.git`);
  const git = (cwd, ...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
  fs.mkdirSync(dir);
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(dir, "init", "-q", "-b", "feat/x");
  git(dir, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "a");
  if (push) git(dir, "push", "-q", ...(track ? ["-u"] : []), "origin", "feat/x");
  return { dir, git: (...a) => git(dir, ...a) };
}
const done = (t) => ({ kind: "done", text: t });
let clock = 1e12;
const state = (r) => lib.finishedState(r, r.sessions[0].status, (clock += 10_000));

test("可關閉：最後一行已完成、沒有未 commit 的改動、遠端同名分支已有最新 commit 才算；沒設追蹤分支但已推上去也算", () => {
  const { dir } = gitRepo("closable-ok");
  const r = row("ok", done("做完了。\n\n已完成"), { path: dir, branch: "feat/x" });
  assert.deepEqual(state(r), { closable: true, dirty: 0, unpushed: 0 });
  assert.equal(line.listedAs(r.sessions[0], {}, {}, {}, r), "closable");
  assert.equal(lib.awaitsUser(r.sessions[0].status, { row: r, session: r.sessions[0] }), false);
  assert.equal(state(row("ok2", done("做完了。\n\n等你：看一下"), { path: dir })), null, "最後一行不是已完成就不算");
  assert.equal(state(row("ok3", done("做完了。"), { path: dir })), null);
});

test("可關閉：三個條件各缺一時都不是；停下後又改檔就不再是可關閉；已完成但還沒推的顯示成輪到你、建議行寫缺什麼", () => {
  const dirty = gitRepo("closable-dirty");
  const r = row("dirty", done("已完成"), { path: dirty.dir, branch: "feat/x" });
  assert.equal(state(r).closable, true);
  fs.writeFileSync(path.join(dirty.dir, "b.txt"), "b\n");
  assert.deepEqual(state(r), { closable: false, dirty: 1, unpushed: 0 }, "停下後又改檔");
  const ahead = gitRepo("closable-ahead");
  fs.writeFileSync(path.join(ahead.dir, "c.txt"), "c\n");
  ahead.git("add", ".");
  ahead.git("commit", "-qm", "c");
  ahead.git("commit", "-q", "--allow-empty", "-m", "d");
  const a = row("ahead", done("已完成"), { path: ahead.dir, branch: "feat/x" });
  assert.deepEqual(state(a), { closable: false, dirty: 0, unpushed: 2 });
  const never = gitRepo("closable-never", { push: false });
  assert.deepEqual(state(row("never", done("已完成"), { path: never.dir, branch: "feat/x" })), { closable: false, dirty: 0, unpushed: 1 });
  const status = a.sessions[0].status;
  lib.finishedState(a, status, Date.now() + 10_000);
  assert.equal(lib.awaitsUser(status, { row: a, session: a.sessions[0] }), true, "已完成但沒推算輪到你");
  assert.equal(lib.turnLabel(a, a.sessions[0]), "◆ 輪到你");
  assert.equal(line.listedAs(a.sessions[0], {}, {}, {}, a), "waiting");
  const out = band.bandRows({ current: { tag: "unit", kind: "done" }, finished: { closable: false, dirty: 0, unpushed: 2 }, groups: { waiting: ["unit"] } });
  assert.equal(band.rowText(out.rows[1]), "  建議  回 unit「送出」  它說已完成，但還有 2 個 commit 沒推，送出會開 draft MR");
});

test("可關閉：第一次判成可關閉時事件紀錄多記一筆停下事件 closable，之後不重記", () => {
  const { dir } = gitRepo("closable-log");
  const rows = [row("logme", done("已完成"), { path: dir, branch: "feat/x" })];
  const events = () =>
    fs.readdirSync(process.env.WORKTREE_CONSOLE_LOG_DIR).filter((f) => f.endsWith(".jsonl")).flatMap((f) => fs.readFileSync(path.join(process.env.WORKTREE_CONSOLE_LOG_DIR, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((e) => e.event === "stop" && e.status === "closable" && e.ticket === "logme");
  let view = focus.syncFocus(rows);
  const first = focus.focusPayload(rows, view);
  assert.equal(events().length, 1);
  assert.equal(first.payload.band.rows.some((r) => band.rowText(r).includes("可關閉 ")), true);
  focus.saveTitles(first.titles, first.firsts, { closables: first.closables });
  view = focus.syncFocus(rows);
  focus.focusPayload(rows, view);
  assert.equal(events().length, 1);
});

// --- Stop hook：子 session 的結尾 ---

test("結尾與狀態：最後一行等你／已完成照它判；沒寫時用背景摘要的第四層（要你決定／下一步）；都沒有才照舊用字面判", () => {
  const home = process.env.WORKTREE_CONSOLE_HOME;
  const s = (handle, t, kind = "done") => ({ handle, since: 5, status: { kind, text: t }, agent: { stateStartedAt: 5 } });
  const recap = (handle, t, reply) => {
    fs.mkdirSync(path.join(home, "summaries"), { recursive: true });
    fs.writeFileSync(path.join(home, "summaries", `${encodeURIComponent(handle)}.json`), JSON.stringify({ text: t, replyKey: lib.replyKey(reply) }));
  };
  assert.equal(lib.awaitsUser(s("e1", "改好了。\n\n等你：看畫面").status), true);
  assert.equal(lib.awaitsUser(s("e2", "改好了。\n\n已完成").status), false);
  recap("d1", "在做什麼：改按鈕\n要你決定：要不要上線", "改好了。");
  recap("d2", "在做什麼：改按鈕\n下一步：跑測試", "改好了，請你確認。");
  assert.equal(lib.awaitsUser(s("d1", "改好了。").status, { session: s("d1", "改好了。") }), true);
  assert.equal(lib.awaitsUser(s("d2", "改好了，請你確認。").status, { session: s("d2", "改好了，請你確認。") }), false, "摘要說下一步就不等你");
  assert.equal(lib.awaitsUser(s("none", "改好了，請你確認。").status, { session: s("none", "x") }), true, "沒有摘要照舊用字面");
});

test("結尾與狀態：有「第 N 題」或 a、b、c 選項的 💬 題目、開著的選單，摘要寫下一步也照樣輪到你、留在等待清單", () => {
  const home = process.env.WORKTREE_CONSOLE_HOME;
  fs.mkdirSync(path.join(home, "summaries"), { recursive: true });
  const asks = {
    q1: "改好了。\n\n**第 1 題：** 按鈕放哪？\na. 左邊\nb. 右邊",
    q2: "要怎麼處理舊資料？\n\na. 保留\nb. 刪掉\nc. 搬走",
    q3: "**第 2 題：** 要不要拆成兩張票？",
  };
  for (const [handle, t] of Object.entries(asks)) {
    fs.writeFileSync(path.join(home, "summaries", `${encodeURIComponent(handle)}.json`), JSON.stringify({ text: "在做什麼：改按鈕\n下一步：等回覆後繼續" }));
    const s = { handle, paneKey: handle, since: 5, status: { kind: "waiting", text: t }, agent: { stateStartedAt: 5 } };
    assert.equal(lib.awaitsUser(s.status, { session: s }), true, handle);
    assert.equal(line.listedAs(s), "waiting", handle);
  }
  fs.writeFileSync(path.join(home, "summaries", "menu.json"), JSON.stringify({ text: "在做什麼：改按鈕\n下一步：跑測試" }));
  const menu = { handle: "menu", paneKey: "menu", since: 5, status: { kind: "waiting", menu: [{ question: "選哪個？", options: [{ label: "A" }] }], text: "" }, agent: { stateStartedAt: 5 } };
  assert.equal(line.listedAs(menu), "waiting");
});

test("結尾與狀態：中控台管的子 session 沒寫結尾行時 Stop hook 擋一次；補上或寫了就放行，第二次仍沒寫照樣放行但一律列進等待；續命、交棒那一輪與沒管的 worktree 不擋", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(hooks.hooks.Stop.flatMap((h) => h.hooks.map((x) => x.command.split("/").at(-1))), ['auto-handoff.mjs" stop', 'summary.mjs" stop']);
  const managed = path.join(tmp, "managed-wt");
  const loose = path.join(tmp, "loose-wt");
  for (const d of [managed, loose]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(process.env.WORKTREE_CONSOLE_LOG_DIR, ".state"), { recursive: true });
  fs.writeFileSync(path.join(process.env.WORKTREE_CONSOLE_LOG_DIR, ".state", "managed.json"), JSON.stringify({ worktrees: [{ path: managed, repo: "app", ticket: "PROJ-7" }], repos: [], consoles: [], handles: { "child-term": { path: managed } } }));
  let n = 0;
  const stop = (last, { cwd = managed, prompt = "做", active = false, same = false } = {}) => {
    if (!same) n += 1;
    const transcript = path.join(tmp, `child-${n}.jsonl`);
    fs.writeFileSync(transcript, [{ type: "user", uuid: `u-${n}`, message: { content: prompt } }, { type: "assistant", message: { content: [{ type: "text", text: last }] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const input = JSON.stringify({ session_id: `child-${n}`, transcript_path: transcript, cwd, last_assistant_message: last, stop_hook_active: active });
    const r = spawnSync(process.execPath, [path.join(root, "hooks/auto-handoff.mjs"), "stop"], { input, encoding: "utf8", env: { ...process.env, ORCA_TERMINAL_HANDLE: "child-term" } });
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const asked = stop("改好了。");
  assert.equal(asked?.decision, "block");
  assert.match(asked.reason, /等你：/);
  assert.match(asked.reason, /已完成/);
  for (const last of ["改好了。\n\n等你：看畫面", "改好了。\n\n已完成"]) assert.equal(stop(last), null, last);
  assert.equal(stop("改好了。", { cwd: loose }), null, "沒管的 worktree");
  assert.equal(stop("收到", { prompt: handoff.KEEPALIVE_TEXT }), null, "續命那一輪");
  assert.equal(stop("依交棒說明：…", { prompt: `${handoff.TAKEOVER_HEAD}先完整讀 x.md` }), null, "交棒那一輪");
  assert.equal(stop("改好了，接著跑測試。")?.decision, "block", "第一次問");
  assert.equal(stop("改好了，接著跑測試。", { active: true, same: true }), null, "問過了，第二次照樣放行");
  fs.mkdirSync(path.join(process.env.WORKTREE_CONSOLE_HOME, "summaries"), { recursive: true });
  fs.writeFileSync(path.join(process.env.WORKTREE_CONSOLE_HOME, "summaries", "child-term.json"), JSON.stringify({ text: "在做什麼：改按鈕\n下一步：跑測試", replyAt: 5 }));
  const s = { handle: "child-term", paneKey: "child-term", since: 5, status: { kind: "done", text: "改好了，接著跑測試。" }, agent: { stateStartedAt: 5 } };
  assert.equal(line.listedAs(s), "waiting", "補不上結尾行的那則不交給摘要");
  const later = { ...s, status: { kind: "done", text: "另一則回覆。" } };
  assert.equal(line.listedAs(later), null, "之後的另一則照舊看摘要");
});

// --- 中控台回覆結尾檢查 ---

test("中控台回覆結尾檢查：一致放行、不一致擋一次、沒跑 guide 不擋；stop_hook_active、續命與交棒的那一輪、別的 session 都不擋", () => {
  const ending = ["`建議`：回 flow a，照建議", "`等待`：flow｜自動處理中：無｜在跑：無｜延後處理：無"];
  const guideAt = { last: { at: 2_000, session: "con", lines: ending } };
  const entries = (prompt) => [{ type: "user", message: { content: prompt } }];
  const input = (msg, extra = {}) => ({ session_id: "con", last_assistant_message: msg, stop_hook_active: false, ...extra });
  const opts = { guide: guideAt, turnEnd: { at: 1_000 }, isConsole: true };
  assert.equal(handoff.endingProblem(input(`說明。\n\n${ending.join("\n")}`), entries("回 a"), opts), null);
  const problem = handoff.endingProblem(input("說明。\n\n`建議`：回 flow b\n`等待`：flow"), entries("回 a"), opts);
  assert.match(problem, /原樣貼/);
  assert.ok(problem.endsWith(ending.join("\n")));
  assert.equal(handoff.endingProblem(input("亂寫", { stop_hook_active: true }), entries("回 a"), opts), null, "擋過一次就放行");
  assert.equal(handoff.endingProblem(input("亂寫"), entries("回 a"), { ...opts, turnEnd: { at: 3_000 } }), null, "這一輪沒跑 guide");
  assert.equal(handoff.endingProblem(input("亂寫"), entries("回 a"), { ...opts, guide: {} }), null);
  assert.equal(handoff.endingProblem(input("亂寫"), entries(handoff.KEEPALIVE_TEXT), opts), null);
  assert.equal(handoff.endingProblem(input("亂寫"), entries(handoff.CACHE_HANDOFF_TEXT), opts), null);
  assert.equal(handoff.endingProblem(input("亂寫"), entries(`${handoff.TAKEOVER_HEAD}讀交棒說明`), opts), null);
  assert.equal(handoff.endingProblem(input("亂寫", { session_id: "child" }), entries("回 a"), opts), null);
  assert.equal(handoff.endingProblem(input("亂寫"), entries("回 a"), { ...opts, isConsole: false }), null);
});

test("中控台回覆結尾檢查：auto-handoff 的 Stop hook 對中控台不一致時回 decision: block", () => {
  const home = process.env.WORKTREE_CONSOLE_HOME;
  fs.writeFileSync(path.join(home, "consoles.json"), JSON.stringify(["con-term"]));
  record.writeGuide({ sessions: {}, last: { at: Date.now(), session: "con-hook", lines: ["`建議`：不用做事", "`等待`：無"] } }, home);
  const transcript = path.join(tmp, "console.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "現在狀況" } })}\n`);
  const run = (msg) =>
    spawnSync(process.execPath, [path.join(root, "hooks/auto-handoff.mjs"), "stop"], {
      input: JSON.stringify({ session_id: "con-hook", transcript_path: transcript, cwd: tmp, last_assistant_message: msg, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, ORCA_TERMINAL_HANDLE: "con-term" },
    }).stdout;
  assert.match(run("我自己寫的結尾"), /"decision":"block"/);
  assert.equal(run("好。\n\n`建議`：不用做事\n`等待`：無"), "");
});

// --- guide ---

const SHEET = [
  "**第 1 題：批改單這樣定稿嗎？**",
  "",
  "目標檔：/x/.goals/a.md",
  "",
  "**已決定**",
  "1. 先做 A（出處：x）",
  "",
  "────────────────────",
  "",
  "**待決定 1：要不要分頁？**",
  "",
  "背景說明一大段，不該印。",
  "",
  "- **a.** 要：分兩頁",
  "- **b.** 不要：一頁",
  "",
  "建議：a，比較清楚",
  "",
  "────────────────────",
  "",
  "**待決定 2：顏色？**",
  "",
  "- **a.** 藍",
  "- **b.** 綠",
  "",
  "建議：b",
  "",
  "────────────────────",
  "",
  "**整張單的建議**：1 選 a、2 選 b",
  "",
  "- **a.** 全照建議並動工",
  "- **b.** 要改",
  "",
  "建議：a，照建議就能動工",
].join("\n");

test("引導印題目：文字題印最後一個「第 N 題」那段、選單題印題目與選項、沒有出題格式印最後一段；建議一律接理由", () => {
  const topic = "前面的說明。\n\n**第 1 題：先做哪個？**\n\n- **a.** 甲\n- **b.** 乙\n\n建議：a，比較快\n\n**第 2 題：顏色？**\n\n- **a.** 藍\n- **b.** 綠\n\n建議：b";
  const item = (kind, status) => ({ tag: "flow", kind, row: { path: "/x" }, session: { status } });
  assert.deepEqual(guide.questionBlock(item("text", asking(topic))), ["**flow**", "", "**第 2 題：顏色？**", "", "- **a.** 藍", "- **b.** 綠", "", "建議：b，子 session 自己的建議"]);
  assert.deepEqual(guide.questionBlock(item("text", asking(topic)), { state: "ready", answer: "a", reason: "跟上次一樣" }).at(-1), "建議：a，跟上次一樣");
  const menu = { kind: "waiting", text: "", menu: [{ header: "範圍", question: "要做到哪？", options: [{ label: "只做 A（Recommended）", description: "小" }, { label: "全做", description: "大" }] }] };
  assert.deepEqual(guide.questionBlock(item("menu", menu)), ["**flow**", "", "範圍　要做到哪？", "- a. 只做 A（Recommended）：小", "- b. 全做：大", "", "建議：a，子 session 自己的建議"]);
  assert.deepEqual(guide.questionBlock(item("text", asking("做好了。\n\n要推上去嗎？\n\n建議：推，CI 都過了"))), ["**flow**", "", "要推上去嗎？", "", "建議：推，CI 都過了"]);
  assert.deepEqual(guide.questionBlock(item("text", asking(SHEET))), ["**flow**", "", "**待決定 1：要不要分頁？**", "- **a.** 要：分兩頁", "- **b.** 不要：一頁", "建議：a，比較清楚", "", "**待決定 2：顏色？**", "- **a.** 藍", "- **b.** 綠", "建議：b，子 session 自己的建議"]);
  assert.deepEqual(guide.questionOf(SHEET).numbers, [1, 2]);
});

function advisorWith(pathOf, since, answer = { answer: "a", reason: "跟上次一樣" }) {
  const home = fs.mkdtempSync(path.join(tmp, "advisor-"));
  const at = new Date(since + 1_000).toISOString();
  fs.writeFileSync(path.join(home, "predictions.jsonl"), [{ event: "start", id: "p1", at, path: pathOf, kind: "text", question: "x" }, ...(answer ? [{ event: "done", ref: "p1", at, ...answer, urgent: "代價高的決定" }] : [])].map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(home, "answers.jsonl"), "");
  return home;
}

test("回覆結尾由腳本產生：四種建議行，等待行是 waiting-line 加行內程式碼", () => {
  const rows = [row("flow", asking("要哪個？\n\n- a. 甲\n- b. 乙\n\n選哪個？")), row("work", { kind: "busy", text: "" })];
  const flowPath = rows[0].path;
  const since = rows[0].sessions[0].since;
  const view = focus.syncFocus(rows);
  const waiting = `\`等待\`：${line.waitingLine(rows).replace(/^等待：/, "")}`;
  assert.deepEqual(guide.endingLines(rows, view, { mine: "b，它說 CI 會擋", target: view.current.item }), ["`建議`：回 flow b，它說 CI 會擋", waiting]);
  assert.deepEqual(guide.endingLines(rows, view), ["`建議`：回 flow（按 9 看題目）", waiting]);
  const old = process.env.ADVISOR_HOME;
  process.env.ADVISOR_HOME = advisorWith(flowPath, since);
  try {
    const adviceView = focus.syncFocus(rows);
    const lines = guide.guideLines(rows, adviceView, []);
    assert.deepEqual(lines, ["`建議`：回 flow a，跟上次一樣", waiting]);
  } finally {
    process.env.ADVISOR_HOME = old;
  }
  const quiet = [row("work", { kind: "busy", text: "" })];
  assert.deepEqual(guide.endingLines(quiet, focus.syncFocus(quiet)), ["`建議`：不用做事", `\`等待\`：${line.waitingLine(quiet).replace(/^等待：/, "")}`]);
  assert.deepEqual(guide.endingLines(quiet, { current: null, wait: { tag: "flow" } }).at(0), "`建議`：不用做事，等 flow 回報");
  assert.match(waiting, /^`等待`：.*｜自動處理中：.*｜在跑：.*｜延後處理：/);
});

test("中控台的建議：--mine 另印「中控台的建議」，--self 的題號記成要你回；記進該 session 的紀錄、帶這次停下的時間，再停下就作廢", () => {
  const rows = [row("flow", asking(SHEET))];
  const view = focus.syncFocus(rows);
  const out = guide.guideLines(rows, view, ["flow"], { mine: "第 1 題你本人回，其他照建議，這題問你的習慣", self: "1", session: "con" });
  assert.ok(out.includes("中控台的建議：第 1 題你本人回，其他照建議，這題問你的習慣"));
  assert.deepEqual(out.slice(-2)[0], "`建議`：回 flow 第 1 題你本人回，其他照建議，這題問你的習慣");
  const rec = record.readGuide();
  const s = rows[0].sessions[0];
  assert.deepEqual([rec.sessions[s.paneKey].self, rec.sessions[s.paneKey].numbers, rec.sessions[s.paneKey].since], [[1], [1, 2], s.since]);
  assert.deepEqual(rec.last.lines, out.slice(-2));
  assert.equal(rec.last.session, "con");
  assert.ok(record.guideFor(rec, { paneKey: s.paneKey, since: s.since }));
  assert.equal(record.guideFor(rec, { paneKey: s.paneKey, since: s.since + 1 }), null, "再停下就作廢");
  const drawn = focus.focusPayload(rows, focus.syncFocus(rows)).payload.band;
  assert.deepEqual(text(drawn.rows).slice(1, 3), ["  中控台建議  第 1 題你本人回  其他照建議，這題問你的習慣", "  要你回  1     照建議  2"]);
  const plain = guide.guideLines(rows, view, ["flow"], { session: "con" });
  assert.ok(!plain.some((l) => l.startsWith("中控台的建議")), "沒帶 --mine 不印");
});

test("console.mjs reply 記下送出的內容：換到下一件時狀態區多一行剛送出", () => {
  const rows = [row("flow", asking("要哪個？")), row("tidy", asking("要推嗎？"))];
  let view = focus.syncFocus(rows);
  const first = view.current;
  const who = { paneKey: first.paneKey, handle: first.handle, tag: first.tag, at: Date.now(), text: "4 b、10 a，其他照建議" };
  view = focus.syncFocus(rows, { change: (st, entries, now) => focusReplied(st, entries, [who], now) });
  assert.notEqual(view.current.key, first.key);
  const drawn = focus.focusPayload(rows, view).payload.band;
  assert.ok(text(drawn.rows).includes(`  剛送出  ${first.tag}：4 b、10 a，其他照建議     它回來後排在下一件`));
});

// --- 輪到你、♻️、延後處理 ---

test("輪到你：💬 等待回應與 ⏸ 回覆完畢且等你在看板、待回覆清單、回報標題、卡片顯示相同；內部種類與代回判斷照舊", () => {
  const ask = row("ask", asking("要哪個？"));
  const wait = row("wait", done("做好了。\n\n等你：看畫面"));
  const free = row("free", done("做好了。\n\n已完成"));
  const rows = [ask, wait, free];
  const board = lib.boardLines(rows).join("\n");
  assert.equal(board.match(/💬 輪到你/g).length, 2);
  assert.ok(board.includes("⏸ 回覆完畢"));
  const list = lib.pendingBlock(rows).join("\n");
  assert.ok(list.includes("◆ 輪到你 | ask") && list.includes("◆ 輪到你 | wait"), list);
  assert.equal(lib.reportLines(ask, ask.sessions[0].status, ask.sessions[0])[0], "### ◆ ask 輪到你");
  assert.equal(lib.reportLines(wait, wait.sessions[0].status, wait.sessions[0])[0], "### ◆ wait 輪到你");
  assert.equal(lib.reportLines(free, free.sessions[0].status, free.sessions[0])[0], "### ⏸ free 回覆完畢");
  const cards = focus.focusPayload(rows, focus.syncFocus(rows)).payload.sessions;
  assert.deepEqual(cards.map((c) => c.status), ["輪到你", "輪到你", "回覆完畢"]);
  assert.deepEqual(rows.map((r) => r.sessions[0].status.kind), ["waiting", "done", "done"], "內部種類不改");
  assert.equal(urgency.classify({ kind: "text", row: wait, session: wait.sessions[0] }).reason, "回覆完畢", "代回仍照內部種類：回覆完畢不代回");
});

test("拿掉 ♻️：換手後的 session 在看板、待回覆清單、卡片都不加 ♻️", () => {
  const r = row("swap", asking("要哪個？"), { session: { recycled: true } });
  const all = [lib.boardLines([r]).join("\n"), lib.pendingBlock([r]).join("\n"), JSON.stringify(focus.focusPayload([r], focus.syncFocus([r])).payload)].join("\n");
  assert.ok(!all.includes("♻️"));
  assert.equal(lib.RECYCLED, undefined);
});

test("「已跳過」改名「延後處理」：waiting-line 輸出是 …｜在跑：…｜延後處理：…，全 repo 除 CHANGELOG 外沒有「已跳過」", () => {
  const r = row("later", asking("要哪個？"));
  const bumped = { [`${r.sessions[0].paneKey}@${r.sessions[0].since}`]: 1 };
  assert.equal(line.waitingLine([r], {}, bumped, r.sessions[0].since + 1, {}), "等待：無｜自動處理中：無｜在跑：無｜延後處理：later");
  const files = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter((f) => f && f !== "CHANGELOG.md" && fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile());
  const hits = files.filter((f) => !f.endsWith("worktree-console-flow.test.mjs") && fs.readFileSync(path.join(root, f), "utf8").includes("已跳過"));
  assert.deepEqual(hits, []);
});

// --- 審核防線 ---

test("補審核防線：console.mjs review 後面串接其他指令不算 review 指令；子 session 跑 review reviewed 與 review elsewhere 被拒", () => {
  assert.equal(review.classifyCommand("node console.mjs review sheet; sed -i '' x a.ts").review, null);
  for (const c of ["node console.mjs review sheet && rm a", "node console.mjs review sheet | sh", "node console.mjs review sheet\nrm a", "node console.mjs review add --plan \"$(rm a)\"", "(node console.mjs review sheet)"]) assert.equal(review.classifyCommand(c).review, null, c);
  assert.equal(review.classifyCommand(`node "${CONSOLE_CLI}" review add --question "a; b" --plan x`).review, "add", "引號裡的分號不算串接");
  for (const sub of ["reviewed", "elsewhere"]) {
    const out = gate.preToolUse({ tool_name: "Bash", tool_input: { command: `node /x/console.mjs review ${sub} --path /w` }, cwd: tmp, session_id: "child" }, { consoleCheck: () => false });
    assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", sub);
  }
});

function reviewRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "feat/demo");
  fs.writeFileSync(path.join(dir, "app.js"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}
const item = { question: "先做哪個畫面？", plan: "先改畫面", basis: { kind: "none", note: "" }, impact: "訂單頁", by: "advisor", stop: "x" };

test("補審核防線：被鎖住的 session 用 review sheet 串接 sed 也被擋", () => {
  const dir = reviewRepo("locked");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  review.append(wt, { event: "lock", session: "s1", files: ["a.ts"] });
  const out = gate.preToolUse({ tool_name: "Bash", tool_input: { command: `node "${CONSOLE_CLI}" review sheet; sed -i '' x a.ts` }, cwd: dir, session_id: "s1" }, { consoleCheck: () => false });
  assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(gate.preToolUse({ tool_name: "Bash", tool_input: { command: `node "${CONSOLE_CLI}" review sheet` }, cwd: dir, session_id: "s1" }, { consoleCheck: () => false }), null);
});

test("審核單不卡住：在別處回覆把待審的件標「在別處回覆」、記成審完並解鎖，不寫回 advisor 的猜中與否；只算使用者本人打的訊息", () => {
  const dir = reviewRepo("elsewhere");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  review.addItem(wt, { ...item, question: "第二件？", predictionId: "pred1" });
  review.append(wt, { event: "pass", n: 1, by: "panel" });
  const fake = path.join(tmp, "fake-advisor.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(path.join(tmp, "advisor-calls.txt"))}, process.argv.slice(2).join(" ") + "\\n");`);
  const home = fs.mkdtempSync(path.join(tmp, "adv-"));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ script: fake }));
  const old = process.env.ADVISOR_HOME;
  process.env.ADVISOR_HOME = home;
  try {
    const r = reviewCli.closeElsewhere(dir);
    assert.equal(r.ok, true);
    assert.equal(r.elsewhere, 1);
  } finally {
    process.env.ADVISOR_HOME = old;
  }
  const st = review.stateOf(wt);
  assert.ok(st.approved);
  assert.equal(st.open.length, 0);
  assert.deepEqual(st.items.map((x) => x.status), ["passed", "elsewhere"]);
  assert.ok(!fs.existsSync(path.join(tmp, "advisor-calls.txt")), "在別處回覆的件不寫回 advisor 的猜中與否");
  assert.equal(reviewCli.closeElsewhere(dir), null, "沒有待審的件就不再動");
  assert.deepEqual(review.sheetMarkdown({ tag: "t", items: st.items }).filter((l) => l.includes("在別處回覆")).length, 1);
  for (const t of [urgency.SHEET_ANSWER, "（中控台自動交棒）x", `${handoff.TAKEOVER_HEAD}x`, handoff.KEEPALIVE_TEXT, ""]) assert.equal(reviewCli.ownReply(t), false, t);
  assert.equal(reviewCli.ownReply("1 b；2 a"), true);
  assert.equal(reviewCli.pastedSheet("請跑 review sheet", dir), false);
});

test("審核單不卡住：在子 session 分頁直接回攔截點貼出整張審核單的那則會解鎖；直接回批改單、代回都不解鎖", async () => {
  const dir = reviewRepo("tab");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  const log = await import("../skills/worktree-console/scripts/log.mjs");
  log.writeManaged({ worktrees: [{ path: dir, repo: "r", ticket: "tab" }], consoles: [] });
  const hook = (last, prompt) => {
    const transcript = path.join(tmp, `tab-${Math.random()}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: last }] } })}\n`);
    const r = spawnSync(process.execPath, [path.join(root, "hooks", "console-log.mjs"), "user-prompt"], { input: JSON.stringify({ cwd: dir, prompt, transcript_path: transcript, session_id: "tab-s" }), encoding: "utf8", env: { ...process.env, ORCA_TERMINAL_HANDLE: "tab-term" } });
    assert.equal(r.status, 0, r.stderr);
    return review.stateOf(wt);
  };
  const pasted = "被擋下。\n\n審核單：tab\nfeat/demo\n\n1. 先做哪個畫面？\n   當前方案：先改畫面";
  assert.equal(hook(SHEET, "a").open.length, 1, "分頁裡直接回批改單不解鎖");
  assert.equal(hook(pasted, urgency.SHEET_ANSWER).open.length, 1, "代回不算");
  assert.equal(hook(pasted, handoff.KEEPALIVE_TEXT).open.length, 1, "續命訊息不算");
  const st = hook(pasted, "照建議");
  assert.ok(st.approved);
  assert.equal(st.items[0].status, "elsewhere");
});

// --- 檢核找到的漏洞：一律由程式擋 ---

test("審核狀態子指令：串接、前綴環境變數、cd、包在 sh -c 裡都擋；中控台照常能跑", () => {
  const cmds = [
    "node /x/console.mjs review pass-all && node /x/console.mjs review done --path /w",
    "node /x/console.mjs review elsewhere --path /w; true",
    "node /x/console.mjs review reviewed --path /w 2>&1",
    "cd . && node /x/console.mjs review done --path /w",
    "FOO=1 node /x/console.mjs review done --path /w",
    "sh -c 'node /x/console.mjs review approve --path /w'",
    "node /x/console.mjs review sheet | node /x/console.mjs review unlock",
  ];
  for (const command of cmds) {
    const out = gate.preToolUse({ tool_name: "Bash", tool_input: { command }, cwd: tmp, session_id: "child" }, { consoleCheck: () => false });
    assert.equal(out?.hookSpecificOutput?.permissionDecision, "deny", command);
    const ok = gate.preToolUse({ tool_name: "Bash", tool_input: { command }, cwd: tmp, session_id: "con" }, { consoleCheck: () => true });
    assert.notEqual(ok?.hookSpecificOutput?.permissionDecisionReason?.startsWith("審核狀態只能由中控台"), true, command);
  }
});

test("審核狀態子指令：console.mjs 本身也只讓中控台的 session 跑，子 session 直接跑不寫入", () => {
  const dir = reviewRepo("cli-guard");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  const cli = path.join(root, "skills", "worktree-console", "scripts", "console.mjs");
  for (const sub of ["elsewhere", "reviewed", "pass-all", "done"]) {
    const r = spawnSync(process.execPath, [cli, "review", sub, "--path", dir], { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "child-not-console" } });
    assert.notEqual(r.status, 0, sub);
    assert.match(r.stderr + r.stdout, /只有中控台/, sub);
  }
  assert.equal(review.stateOf(wt).open.length, 1);
  assert.equal(review.stateOf(wt).approved, null);
});

test("被鎖住的 session：review sheet 接 2>&1、| cat、| head 放行；導向寫檔照擋", () => {
  const dir = reviewRepo("locked-tail");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  review.append(wt, { event: "lock", session: "s1", files: ["a.ts"] });
  const run = (command) => gate.preToolUse({ tool_name: "Bash", tool_input: { command }, cwd: dir, session_id: "s1" }, { consoleCheck: () => false });
  for (const c of ["review sheet 2>&1", "review sheet | cat", "review sheet 2>&1 | head -50", "review status | tail -n 5"].map((t) => `node "${CONSOLE_CLI}" ${t}`)) assert.equal(run(c), null, c);
  for (const c of ["review sheet > a.ts", "review sheet | tee a.ts", "review sheet 2>&1 >> a.ts", "review sheet"].map((t, i) => (i === 3 ? `node /tmp/evil/console.mjs ${t}` : `node "${CONSOLE_CLI}" ${t}`))) assert.equal(run(c)?.hookSpecificOutput?.permissionDecision, "deny", c);
});

test("貼出審核單：要包含每一件待審的題目與方案才算；只有攔截訊息那行「審核單：…」不算；斜線指令不算使用者回答", () => {
  const dir = reviewRepo("pasted");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  review.addItem(wt, { ...item, question: "要不要拆票？", plan: "先不拆" });
  const blocked = `第一次改檔被擋下：這個 worktree 有還沒審的代回。\n審核單：node "/x/console.mjs" review sheet`;
  assert.equal(reviewCli.pastedSheet(blocked, dir), false);
  assert.equal(reviewCli.pastedSheet("審核單：pasted\n\n1. 先做哪個畫面？\n   當前方案：先改畫面", dir), false, "少一件");
  const full = review.sheetLines({ tag: "pasted", wt, open: review.stateOf(wt).open }).join("\n");
  assert.equal(reviewCli.pastedSheet(`被擋下。\n\n${full}`, dir), true);
  for (const t of ["/compact", "/clear", " /goal x"]) assert.equal(reviewCli.ownReply(t), false, t);
});

test("💬 題一律輪到你：一般句子問的題，摘要寫下一步也留在等待清單，和卡片的「輪到你」一致", () => {
  const home = process.env.WORKTREE_CONSOLE_HOME;
  fs.mkdirSync(path.join(home, "summaries"), { recursive: true });
  fs.writeFileSync(path.join(home, "summaries", "plain.json"), JSON.stringify({ text: "在做什麼：改按鈕\n下一步：等回覆", replyKey: lib.replyKey("按鈕要放左邊還是右邊？") }));
  const s = { handle: "plain", paneKey: "plain", since: 5, status: { kind: "waiting", text: "按鈕要放左邊還是右邊？" }, agent: { stateStartedAt: 5 } };
  assert.equal(lib.awaitsUser(s.status, { session: s }), true);
  assert.equal(line.listedAs(s), "waiting");
  assert.equal(lib.yourTurn(null, s), true);
});

test("Orca 這類比不了停下時間的 session：摘要對不上這次的回覆內容就不用，不拿上一次停下的摘要判", () => {
  const home = process.env.WORKTREE_CONSOLE_HOME;
  fs.mkdirSync(path.join(home, "summaries"), { recursive: true });
  const s = (handle, t) => ({ handle, since: 5, status: { kind: "done", text: t }, agent: { stateStartedAt: 5 } });
  fs.writeFileSync(path.join(home, "summaries", "stale.json"), JSON.stringify({ text: "在做什麼：改按鈕\n要你決定：要不要上線", replyKey: lib.replyKey("上一次的回覆") }));
  fs.writeFileSync(path.join(home, "summaries", "nokey.json"), JSON.stringify({ text: "在做什麼：改按鈕\n要你決定：要不要上線" }));
  fs.writeFileSync(path.join(home, "summaries", "fresh.json"), JSON.stringify({ text: "在做什麼：改按鈕\n要你決定：要不要上線", replyKey: lib.replyKey("改好了。\n\n測試都過了。") }));
  assert.equal(lib.awaitsUser(s("stale", "改好了。").status, { session: s("stale", "改好了。") }), false);
  assert.equal(lib.awaitsUser(s("nokey", "改好了。").status, { session: s("nokey", "改好了。") }), false);
  const fresh = s("fresh", "改好了。\n測試都過了。");
  assert.equal(lib.awaitsUser(fresh.status, { session: fresh }), true, "內容一樣、只差空白換行也算同一則");
});

test("guide X 沒帶 --mine：中控台這一輪在跑時，建議行寫這一輪結束後狀態區會顯示的那件，不寫「不用做事」", () => {
  focus.saveFocus(emptyFocus());
  const rows = [row("gx", asking("要哪個？\n\n- a. 甲\n- b. 乙"))];
  const view = focus.syncFocus(rows, { hold: true });
  assert.equal(view.current, null, "這一輪在跑，狀態區先不接");
  const out = guide.guideLines(rows, view, ["gx"]);
  assert.match(out.at(-2), /^`建議`：回 gx/);
  focus.saveFocus(emptyFocus());
});

test("結尾行不含換行：建議裡有換行時 guide 印成一行，Stop hook 照貼的回覆不擋", () => {
  const rows = [row("nl", asking("要哪個？\n\n- a. 甲\n- b. 乙"))];
  const view = focus.syncFocus(rows, { hold: false });
  const ending = guide.endingLines(rows, view, { mine: "a，因為\n第二行理由" });
  assert.ok(ending.every((l) => !l.includes("\n")), JSON.stringify(ending));
  const lines = ["`建議`：回 nl a，因為\n第二行理由", "`等待`：nl"];
  const opts = { guide: { last: { at: 2_000, session: "con", lines } }, turnEnd: { at: 1_000 }, isConsole: true };
  const input = { session_id: "con", stop_hook_active: false, last_assistant_message: `說明。\n\n${lines.join("\n")}` };
  assert.equal(handoff.endingProblem(input, [{ type: "user", message: { content: "回 a" } }], opts), null);
  focus.saveFocus(emptyFocus());
});

// --- 交棒前後的原題 ---

test("交棒前後的原題：交棒失敗的舊分頁、還沒貼回原題的新分頁都照原題列入等待；使用者回過就不再蓋", () => {
  const reply = "push 被擋。\n\n等你：解鎖 SSH 金鑰後跑 push 指令";
  const sess = (paneKey, text, stopAt, prompt) => ({ handle: paneKey, paneKey, status: { kind: "done", text }, agent: { stateStartedAt: stopAt, prompt } });
  const rows = (...sessions) => [{ path: "/nope", sessions }];
  const failed = { status: "failed", oldHandle: "w1:p1", oldPaneKey: "w1:p1", reply, question: reply, updatedAt: 200 };
  const old = sess("w1:p1", "交棒說明寫好了。", 150, "修 7 條");
  lib.applyHandoff(rows(old), [failed]);
  assert.equal(old.status.text, reply);
  assert.equal(line.listedAs(old), "waiting");
  const answered = sess("w1:p1", "推上去了。", 300, "推好了");
  lib.applyHandoff(rows(answered), [failed]);
  assert.equal(answered.status.text, "推上去了。", "失敗後使用者回過、又停下了");

  const done = { status: "done", oldPaneKey: "w1:p1", newHandle: "w1:p2", newPaneKey: "w1:p2", reply, question: reply, updatedAt: 200 };
  const fresh = sess("w1:p2", "依交棒說明：push 被擋，下一步是等你解鎖。", 250, `${handoff.TAKEOVER_HEAD}先完整讀 x.md`);
  lib.applyHandoff(rows(fresh), [done]);
  assert.equal(fresh.status.text, reply);
  assert.equal(line.listedAs(fresh), "waiting");
  const goalOwn = sess("w1:p2", "做了一半。\n\n等你：看畫面", 260, "/goal 完成 X");
  lib.applyHandoff(rows(goalOwn), [{ ...done, goal: "完成 X" }]);
  assert.equal(goalOwn.status.text, "做了一半。\n\n等你：看畫面", "自己在等使用者就照它的");
  const goalOn = sess("w1:p2", "繼續做下一步。", 260, "/goal 完成 X");
  lib.applyHandoff(rows(goalOn), [{ ...done, goal: "完成 X" }]);
  assert.equal(goalOn.status.text, reply);
  const goalDone = sess("w1:p2", "做完了，推上去了。\n\n已完成", 260, "/goal 完成 X");
  lib.applyHandoff(rows(goalDone), [{ ...done, goal: "完成 X" }]);
  assert.equal(goalDone.status.text, "做完了，推上去了。\n\n已完成", "自己寫了已完成就照它的，可以變成可關閉");
  const replied = sess("w1:p2", "好。", 270, "解鎖了");
  lib.applyHandoff(rows(replied), [done]);
  assert.equal(replied.status.text, "好。");
  const busy = { ...sess("w1:p2", "", 250, `${handoff.TAKEOVER_HEAD}x`), status: { kind: "busy", text: "" } };
  lib.applyHandoff(rows(busy), [done]);
  assert.equal(busy.status.kind, "busy");
});

// --- 第二輪檢核 ---

const CONSOLE_CLI = path.join(root, "skills", "worktree-console", "scripts", "console.mjs");
const childGate = (command, cwd = tmp) => gate.preToolUse({ tool_name: "Bash", tool_input: { command }, cwd, session_id: "child" }, { consoleCheck: () => false });
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === "deny";

test("第二輪 1b（A）：只擋真的會執行 console.mjs review <狀態子指令> 的指令；旗標、變數、反斜線、命令替換、sh -c、xargs 都認得出；只是提到字樣的讀檔、搜尋放行", () => {
  for (const c of [
    'node /x/console.mjs review --session "" reviewed --path /w',
    "env -u CLAUDE_CODE_SESSION_ID node /x/console.mjs review --by reply reviewed",
    "S=reviewed; node /x/console.mjs review $S",
    "node /x/console.mjs review rev\\iewed",
    "node /x/console.mjs review $(echo reviewed)",
    `CLAUDE_CODE_SESSION_ID=con node "${CONSOLE_CLI}" review pass --n 1`,
    "sh -c 'cd /w && node /x/console.mjs review done --path /w'",
    "echo reviewed | xargs node /x/console.mjs review",
    "X=/x/console.mjs; node $X review reviewed",
    "true && nohup node /x/console.mjs review pass-all --path /w",
  ]) assert.ok(denied(childGate(c)), c);
  for (const c of [
    `grep -n "done" ${CONSOLE_CLI}`,
    `rg "review (pass|done|reviewed)" ${CONSOLE_CLI}`,
    `cat ${CONSOLE_CLI} | head -5`,
    `sed -n 1,20p ${CONSOLE_CLI} && grep -c edit ${CONSOLE_CLI}`,
    `node "${CONSOLE_CLI}" review add --question "要不要 edit 按鈕？" --plan "先 done 再 pass" --basis "沒有前例" --impact "卡片" --by child --stop "規劃"`,
    `node "${CONSOLE_CLI}" review correct --n 1 --plan "改成 undo"`,
    `node "${CONSOLE_CLI}" review sheet 2>&1 | head -5`,
    "node --test test/review.test.mjs",
  ]) assert.equal(childGate(c), null, c);
});

test("第二輪 1b（A）：handoff-files.mjs 只有真的執行它才算交棒；改這支檔、搜尋、跑測試都不算", () => {
  for (const c of ["node skills/define-goal/scripts/handoff-files.mjs --goal x", "cd /w && node ./scripts/handoff-files.mjs", "sh -c 'node handoff-files.mjs'"]) assert.equal(review.classifyCommand(c).gate, "handoff-files", c);
  for (const c of ["grep -n spec skills/define-goal/scripts/handoff-files.mjs", "sed -i '' s/a/b/ handoff-files.mjs", "node --test skills/define-goal/scripts/handoff-files.test.mjs", "rg handoff-files.mjs", "cat handoff-files.mjs"]) assert.equal(review.classifyCommand(c).gate, null, c);
});

test("第二輪 1b（B）：子 session 的 Bash 前後比對審核狀態，不管指令怎麼寫，狀態被改就還原並鎖住；只新增代回照常保留", async () => {
  const dir = reviewRepo("snap-compare");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  const file = review.reviewFile(wt.repo, wt.branch);
  const before = fs.readFileSync(file, "utf8");
  const call = (id) => ({ tool_name: "Bash", tool_input: { command: "python3 x.py" }, cwd: dir, session_id: "child-snap", tool_use_id: id });
  gate.beforeBash(call("t1"), { consoleCheck: () => false });
  review.append(wt, { event: "pass", n: 1, by: "panel" });
  review.append(wt, { event: "approved", by: "panel" });
  const out = gate.postToolUse(call("t1"));
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /審核紀錄/);
  const st = review.stateOf(wt);
  assert.equal(st.approved, null, "還原");
  assert.equal(st.items[0].status, "pending");
  assert.equal(st.lock?.session, "child-snap", "鎖住");
  assert.ok(fs.readFileSync(file, "utf8").startsWith(before));

  const dir2 = reviewRepo("snap-add");
  const wt2 = review.worktreeOf(dir2);
  review.addItem(wt2, item);
  const call2 = { ...call("t2"), cwd: dir2 };
  gate.beforeBash(call2, { consoleCheck: () => false });
  review.addItem(wt2, { ...item, question: "第二件？" });
  assert.equal(gate.postToolUse(call2), null, "只新增代回");
  assert.equal(review.stateOf(wt2).items.length, 2);
  gate.beforeBash({ ...call2, tool_use_id: "t4" }, { consoleCheck: () => false });
  const { consoleIdentity } = await import("./fixtures/isolate-env.mjs");
  const passed = spawnSync(process.execPath, [CONSOLE_CLI, "review", "pass", "--n", "1", "--path", dir2], { encoding: "utf8", env: { ...process.env, ...consoleIdentity("con-snap") } });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(gate.postToolUse({ ...call2, tool_use_id: "t4" }), null, "子 session 的 Bash 跑的同時，中控台用 review pass 通過，不算子 session 改的");
  assert.equal(review.stateOf(wt2).items[0].status, "passed");
  gate.beforeBash({ ...call2, session_id: "con", tool_use_id: "t3" }, { consoleCheck: () => true });
  review.append(wt2, { event: "pass", n: 1, by: "panel" });
  assert.equal(gate.postToolUse({ ...call2, session_id: "con", tool_use_id: "t3" }), null, "中控台照常能改");
});

test("第二輪 1a：審核狀態子指令拿不到或對不上呼叫者身分一律拒絕；中控台的 session 與帶自己 session 的焦點面板照常能跑", () => {
  const dir = reviewRepo("identity");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  const projects = fs.mkdtempSync(path.join(tmp, "projects-"));
  fs.mkdirSync(path.join(projects, "-c"));
  fs.writeFileSync(path.join(projects, "-c", "con-s.jsonl"), `${JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Base directory for this skill: /x/skills/worktree-console\n\n# Worktree Console" }] } })}\n`);
  const run = (args, env) => {
    const e = { ...process.env, CLAUDE_PROJECTS_DIR: projects, ...env };
    for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
    return spawnSync(process.execPath, [CONSOLE_CLI, "review", ...args, "--path", dir], { encoding: "utf8", env: e });
  };
  for (const [args, env, why] of [
    [["status"], { CLAUDE_CODE_SESSION_ID: undefined }, "沒有身分"],
    [["--session", "", "status"], { CLAUDE_CODE_SESSION_ID: undefined }, "身分是空字串"],
    [["--session", "con-s", "status"], { CLAUDE_CODE_SESSION_ID: "child-s" }, "子 session 冒用中控台的 session"],
    [[], { CLAUDE_CODE_SESSION_ID: "child-s" }, "子 session"],
  ]) {
    const r = run(["undo", "--n", "1", ...args.filter((a) => a !== "status")], env);
    assert.notEqual(r.status, 0, why);
    assert.match(r.stderr + r.stdout, /只有中控台/, why);
  }
  assert.equal(run(["pass", "--n", "1"], { CLAUDE_CODE_SESSION_ID: "con-s" }).status, 0, "中控台");
});

// A function test, not a defence: a child that unsets its shell id and passes the console's --session gets the same result (PR #58 已知限制).
test("焦點面板功能：面板沒有 shell 身分、帶自己的 --session 能跑審核狀態子指令", () => {
  const dir = reviewRepo("panel-fn");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  const projects = fs.mkdtempSync(path.join(tmp, "projects-panel-"));
  fs.mkdirSync(path.join(projects, "-c"));
  fs.writeFileSync(path.join(projects, "-c", "con-p.jsonl"), `${JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Base directory for this skill: /x/skills/worktree-console\n\n# Worktree Console" }] } })}\n`);
  const env = { ...process.env, CLAUDE_PROJECTS_DIR: projects };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [CONSOLE_CLI, "review", "pass", "--n", "1", "--session", "con-p", "--path", dir], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(review.stateOf(wt).items[0].status, "passed");
});

test("第二輪 2：子 session 貼出審核單、被要求補結尾行後最後一則只剩「等你：…」，使用者在分頁回答照樣解鎖", async () => {
  const dir = reviewRepo("tab-ending");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  const log = await import("../skills/worktree-console/scripts/log.mjs");
  log.writeManaged({ worktrees: [{ path: dir, repo: "r", ticket: "tab-ending" }], consoles: [] });
  const transcript = path.join(tmp, "tab-ending.jsonl");
  const pasted = "被擋下。\n\n審核單：tab-ending\nfeat/demo\n\n1. 先做哪個畫面？\n   當前方案：先改畫面";
  fs.writeFileSync(transcript, [
    { type: "user", message: { content: "動工" } },
    { type: "assistant", message: { content: [{ type: "text", text: pasted }] } },
    { type: "user", isMeta: true, message: { content: `Stop hook feedback:\n${handoff.ENDING_ASK}` } },
    { type: "assistant", message: { content: [{ type: "text", text: "等你：審核上面的審核單" }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = spawnSync(process.execPath, [path.join(root, "hooks", "console-log.mjs"), "user-prompt"], { input: JSON.stringify({ cwd: dir, prompt: "全部通過", transcript_path: transcript, session_id: "tab-e" }), encoding: "utf8", env: { ...process.env, ORCA_TERMINAL_HANDLE: "tab-e-term" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(review.stateOf(wt).approved);
});

test("第二輪 3：交棒失敗超過 24 小時，在你回覆前事件不刪、舊分頁照舊顯示原題；你回過之後才清掉", () => {
  const events = path.join(process.env.AUTO_HANDOFF_HOME, "events");
  fs.mkdirSync(events, { recursive: true });
  const file = path.join(events, "old-fail.json");
  const reply = "push 被擋。\n\n等你：解鎖 SSH 金鑰";
  const old = Date.now() - 3 * 24 * 3600_000;
  fs.writeFileSync(file, JSON.stringify({ status: "failed", oldHandle: "w9:p1", oldPaneKey: "w9:p1", reply, question: reply, updatedAt: old }));
  const s = { handle: "w9:p1", paneKey: "w9:p1", status: { kind: "done", text: "交棒說明寫好了。" }, agent: { stateStartedAt: old - 1000, prompt: "做" } };
  lib.applyHandoff([{ path: "/nope", sessions: [s] }], lib.handoffEvents({ pending: true }));
  assert.ok(fs.existsSync(file), "還沒回覆，事件不刪");
  assert.equal(s.status.text, reply);
  const later = { ...s, status: { kind: "done", text: "推好了。" }, agent: { stateStartedAt: Date.now(), prompt: "解鎖了" } };
  lib.applyHandoff([{ path: "/nope", sessions: [later] }], lib.handoffEvents({ pending: true }));
  assert.equal(later.status.text, "推好了。");
  lib.handoffEvents({ pending: true });
  assert.ok(!fs.existsSync(file), "回過之後清掉");
});

test("第二輪 5：只擋中控台看板上、不是主 checkout 的分頁；主 checkout 與看板沒有的分頁不擋", () => {
  const managed = { worktrees: [{ path: "/r/main", repo: "r", ticket: "main", main: true }, { path: "/r/wt", repo: "r", ticket: "wt", main: false }], repos: [{ name: "r", main: "/r/main" }], consoles: ["con"], handles: { "h-wt": { path: "/r/wt" }, "h-main": { path: "/r/main" } } };
  assert.equal(handoff.boardChild("/r/wt", "h-wt", managed), true);
  assert.equal(handoff.boardChild("/r/wt/sub", "h-wt", managed), true);
  assert.equal(handoff.boardChild("/r/main", "h-main", managed), false, "主 checkout");
  assert.equal(handoff.boardChild("/r/wt", "h-other", managed), false, "看板沒有的分頁");
  assert.equal(handoff.boardChild("/r/wt", "con", managed), false, "中控台");
});

test("第二輪 6：「第二次」要真的問過；別的 Stop hook 擋過（stop_hook_active）但沒問過時照樣先問", () => {
  const home = fs.mkdtempSync(path.join(tmp, "asked-"));
  const entries = [{ type: "user", uuid: "u1", message: { content: "做" } }, { type: "assistant", message: { content: [{ type: "text", text: "改好了。" }] } }];
  const input = (active) => ({ session_id: "s-ask", last_assistant_message: "改好了。", stop_hook_active: active });
  assert.equal(handoff.endingMissing(input(true), entries, { managed: true, home }), "ask", "沒問過，別的 hook 擋過也先問");
  assert.equal(handoff.endingMissing(input(true), entries, { managed: true, home }), "missed", "問過了");
  const next = [...entries, { type: "user", uuid: "u2", message: { content: "繼續" } }, { type: "assistant", message: { content: [{ type: "text", text: "又改好了。" }] } }];
  assert.equal(handoff.endingMissing({ ...input(false), last_assistant_message: "又改好了。" }, next, { managed: true, home }), "ask", "新的一輪重新問");
});

test("第二輪 7：反斜線引號不吃掉導向；別的 console.mjs 不算 review 指令；補不上的那則是空字串也列入；壓縮摘要不算最後一則指令", async () => {
  assert.equal(review.classifyCommand(`node "${CONSOLE_CLI}" review sheet --path \\" > a.ts`).review, null);
  assert.equal(review.classifyCommand(`node "${CONSOLE_CLI}" review sheet`).review, "sheet");
  assert.equal(review.classifyCommand("node /tmp/evil/console.mjs review sheet").review, null, "不是這個 plugin 的 console.mjs");
  const home = fs.mkdtempSync(path.join(tmp, "missed-"));
  const ending = await import("../skills/worktree-console/scripts/ending.mjs");
  ending.markMissed(home, "h-empty", "");
  assert.equal(ending.missedEnding(home, "h-empty", ""), true);
  const compacted = [
    { type: "user", message: { content: handoff.KEEPALIVE_TEXT } },
    { type: "assistant", message: { content: [{ type: "text", text: "收到" }] } },
    { type: "user", isCompactSummary: true, message: { content: "This session is being continued from a previous conversation." } },
  ];
  assert.equal(handoff.endingMissing({ session_id: "s-c", last_assistant_message: "收到", stop_hook_active: false }, compacted, { managed: true, home }), null);
});

// --- /goal 不推被擋下等審核的 session ---

test("/goal 進行中、這個 worktree 被攔截點擋下等審核、回覆以「等你：」結尾時，Stop hook 回 continue: false 停下，不讓 /goal 一直推它空轉；沒擋下或沒有 /goal 時照舊", () => {
  const dir = reviewRepo("goal-spin");
  const wt = review.worktreeOf(dir);
  const goal = { type: "attachment", attachment: { type: "goal_status", met: false, condition: "完成 verify" } };
  const stop = (name, { withGoal = true, last = "等你：審核那張審核單（建議第 1 件選「留著」）" } = {}) => {
    const transcript = path.join(tmp, `${name}.jsonl`);
    fs.writeFileSync(transcript, [{ type: "user", uuid: `u-${name}`, message: { content: "/goal 完成 verify" } }, ...(withGoal ? [goal] : []), { type: "assistant", message: { content: [{ type: "text", text: last }] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const r = spawnSync(process.execPath, [path.join(root, "hooks/auto-handoff.mjs"), "stop"], { input: JSON.stringify({ session_id: `s-${name}`, transcript_path: transcript, cwd: dir, last_assistant_message: last, stop_hook_active: true }), encoding: "utf8", env: process.env });
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  assert.equal(stop("free"), null, "沒有待審的件");
  review.addFilesItem(wt, ["skills/define-goal/scripts/goal-text.mjs"], { session: "s-held", stop: "define-goal 的 handoff-files.mjs" });
  assert.equal(review.gated(review.stateOf(wt)), true);
  review.append(wt, { event: "blocked", session: "s-held", gate: "handoff-files" });
  const held = stop("held");
  assert.equal(held?.continue, false);
  assert.match(held.stopReason, /審核/);
  assert.equal(stop("nogoal", { withGoal: false }), null, "沒有 /goal");
  assert.equal(stop("working", { last: "改好了，接著跑測試。" })?.continue, undefined, "沒在等你");
});

// --- 第三輪 ---

test("第三輪 中 5：cat、ls、head、grep 讀審核資料夾放行；導向寫入、交給 shell、串接其他指令照擋", () => {
  const home = review.reviewsHome();
  const f = path.join(home, "r", "feat", "demo", "review.jsonl");
  for (const c of [`cat ${f}`, `ls ${home}`, `ls -la "${home}/r"`, `head -5 ${f}`, `grep -rn pass ${home}`, `cat ${f} | head -3`, `grep -c done ${f}; ls ${home}`]) assert.equal(childGate(c), null, c);
  for (const c of [`cat ${f} > ${home}/x`, `echo '{}' >> ${f}`, `cat ${f} | sh`, `grep x $(node e.mjs) ${home}`, `sed -i '' s/a/b/ ${f}`, `ls ${home} && rm -rf ${home}`, `cat ${f} | tee ${home}/y`, `X=1 cat ${f}`]) assert.ok(denied(childGate(c)), c);
});

test("第三輪 中 6：Bash 裡 cd 到別的 worktree，比對還是看指令開始時的 worktree，不鎖到別的 worktree", () => {
  const a = reviewRepo("cd-from");
  const b = reviewRepo("cd-to");
  const wa = review.worktreeOf(a);
  const wb = review.worktreeOf(b);
  review.addItem(wa, item);
  const call = (id, cwd) => ({ tool_name: "Bash", tool_input: { command: `cd ${b} && ls` }, cwd, session_id: "child-cd", tool_use_id: id });
  gate.beforeBash(call("c1", a), { consoleCheck: () => false });
  assert.equal(gate.preToolUse(call("c1", a), { consoleCheck: () => false }), null);
  assert.equal(gate.postToolUse(call("c1", b)), null, "什麼都沒改");
  assert.equal(review.stateOf(wb).lock, null, "別的 worktree 沒被寫進鎖");
  assert.equal(review.stateOf(wa).lock, null);

  gate.beforeBash(call("c2", a), { consoleCheck: () => false });
  review.append(wa, { event: "pass", n: 1, by: "panel" });
  assert.equal(gate.postToolUse(call("c2", b))?.decision, "block", "原 worktree 的審核紀錄被改");
  assert.equal(review.stateOf(wa).lock?.session, "child-cd");
  assert.equal(review.stateOf(wa).items[0].status, "pending", "還原");
  assert.equal(review.stateOf(wb).lock, null);
});

test("第三輪 低 9：別的 session 追加 cleared 解不掉鎖，只有通過（approved）才解", () => {
  const dir = reviewRepo("cleared-lock");
  const wt = review.worktreeOf(dir);
  review.addItem(wt, item);
  review.append(wt, { event: "lock", session: "child-1", files: ["app.js"] });
  review.append(wt, { event: "cleared", reason: "dev-flow reopen", session: "child-2" });
  assert.equal(review.stateOf(wt).lock?.session, "child-1");
  review.append(wt, { event: "approved", by: "panel" });
  assert.equal(review.stateOf(wt).lock, null);
});

test("第三輪 中 7／低 10：/goal 只在這一輪真的被攔截點擋下時才停；只有待審件、上一輪擋過、快取交棒那一輪都不停", async () => {
  const { CACHE_HANDOFF_TEXT } = await import("../hooks/keepalive-text.mjs");
  const dir = reviewRepo("goal-hold-3");
  const wt = review.worktreeOf(dir);
  const goal = { type: "attachment", attachment: { type: "goal_status", met: false, condition: "完成 verify" } };
  const stop = (name, { last = "等你：第 4 題選 a 還是 b", extra = [] } = {}) => {
    const transcript = path.join(tmp, `${name}.jsonl`);
    fs.writeFileSync(transcript, [{ type: "user", uuid: `u-${name}`, message: { content: "/goal 完成 verify" } }, goal, ...extra, { type: "assistant", message: { content: [{ type: "text", text: last }] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const r = spawnSync(process.execPath, [path.join(root, "hooks/auto-handoff.mjs"), "stop"], { input: JSON.stringify({ session_id: `s-${name}`, transcript_path: transcript, cwd: dir, last_assistant_message: last, stop_hook_active: true }), encoding: "utf8", env: process.env });
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  review.append(wt, { event: "blocked", session: "s-old", gate: "approve" });
  review.addItem(wt, item);
  review.append(wt, { event: "done", by: "panel" });
  review.addItem(wt, { ...item, question: "第二件？" });
  assert.equal(review.gated(review.stateOf(wt)), true);
  assert.notEqual(stop("pending-only")?.continue, false, "只有待審件、這一輪沒被擋");
  review.append(wt, { event: "blocked", session: "s-held", gate: "approve" });
  assert.equal(stop("held-3")?.continue, false, "這一輪被擋下");
  const cache = stop("cache-3", { extra: [{ type: "assistant", message: { content: [{ type: "text", text: "等你：審核" }] } }, { type: "user", uuid: "u-cache", message: { content: CACHE_HANDOFF_TEXT } }], last: "等你：審核那張審核單" });
  assert.notEqual(cache?.continue, false, "快取交棒那一輪照常交棒");
});
