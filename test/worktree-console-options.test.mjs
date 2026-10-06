import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentStatus, childAnswer, pendingItems } from "../skills/worktree-console/scripts/lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const replies = fs
  .readFileSync(path.join(root, "test", "fixtures", "worktree-console", "options-replies.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
// `missed`: the child did offer these options, but the rule leaves them out rather than risk a wrong pick.
const expected = (r) => (r.missed ? [] : r.options);

const session = (text) => ({ n: null, handle: "h", agent: { state: "done" }, status: agentStatus({ state: "done", lastAssistantMessage: text }) });
const item = (text) => pendingItems([{ repo: "app", label: "PROJ-1", ticket: "PROJ-1", branch: "proj-1", title: "x", stage: "實作中", sessions: [session(text)] }])[0];

test("真實子 session 回覆：截到的選項代號與標準答案逐則相同，抓錯 0 則，已知漏抓只有 #42", () => {
  const wrong = replies.filter((r) => (item(r.text).choices ?? []).join() !== expected(r).join()).map((r) => `#${r.id}: ${(item(r.text).choices ?? []).join() || "—"} ≠ ${expected(r).join() || "—"}`);
  assert.deepEqual(wrong, []);
  assert.deepEqual(replies.filter((r) => r.missed).map((r) => r.id), [42]);
});

test("真實子 session 回覆：有選項時 b 送出子 session 自己的第二個代號，沒有選項時 b 原樣送出", () => {
  for (const r of replies) assert.equal(childAnswer(item(r.text), "b"), expected(r)[1] ?? "b", `#${r.id}`);
});

test("是非題前面只有 1. 2. 3. 條列時，選項欄與建議欄都是「—」，b 原樣送出", () => {
  const it = item("我打算這樣改：\n\n1. 先改 API\n2. 再改畫面\n3. 最後補測試\n\n照這樣可以嗎？");
  assert.equal(it.entries[0].options, "—");
  assert.equal(childAnswer(it, "b"), "b");
});

test("粗體 A./B./C. 方案後面附「原因有三個：1. 2. 3.」時，選項是方案，b 送 B", () => {
  const text = [
    "**第 2 題：要怎麼處理？**",
    "",
    "- **A.** 全部重做：成本最高",
    "- **B.** 只修壞掉的：範圍最小",
    "- **C.** 先不動：等下一版",
    "",
    "我建議選 **B**。原因有三個：",
    "1. 範圍小",
    "2. 風險低",
    "3. 今天做得完",
    "",
    "你選哪個？",
  ].join("\n");
  const it = item(text);
  assert.equal(it.entries[0].options, "a 全部重做／b 只修壞掉的／c 先不動");
  assert.equal(it.entries[0].suggest, "b");
  assert.equal(childAnswer(it, "b"), "B");
});

test("define-goal 固定骨架：選擇題、是非題、有建議的開放題、複選題都截到 a、b、c，送出原樣", () => {
  const choice = item("**第 1 題：放哪裡？**\n\n背景說明。\n\n- **a.** 主檔：每次都讀\n- **b.** reference：用到才讀\n\n建議：b，主檔太大。");
  assert.equal(choice.entries[0].options, "a 主檔／b reference");
  assert.equal(choice.entries[0].suggest, "b");
  assert.equal(childAnswer(choice, "b"), "b");

  const yesNo = item("**第 2 題：這樣切可以嗎？**\n\n1. 啟動留主檔\n2. 設定搬到 reference\n\n- **a.** 同意：照這樣切\n- **b.** 不同意：請說要改哪裡\n\n建議：a，兩部分都已對過。");
  assert.equal(yesNo.entries[0].options, "a 同意／b 不同意");
  assert.equal(yesNo.entries[0].suggest, "a");

  const open = item("**第 3 題：slug 要叫什麼？**\n\n- **a.** options：直接講功能\n- **b.** choices：比較口語\n- **c.** extract：講動作\n\n建議：a，跟 worktree 名稱一致。");
  assert.equal(open.entries[0].options, "a options／b choices／c extract");
  assert.equal(open.entries[0].suggest, "a");

  const multi = item("**第 4 題：要記哪些事件？（可複選）**\n\n- **a.** 盯盤頻率：多常叫看板\n- **b.** 指令用量：各指令幾次\n- **c.** 詳情採用：照建議幾次\n\n建議：b、c，這兩項現在查不到。");
  assert.equal(multi.entries[0].options, "a 盯盤頻率／b 指令用量／c 詳情採用");
  assert.equal(multi.entries[0].suggest, "b、c，這兩項現在查不到");
  assert.equal(childAnswer(multi, "b、c"), "b、c");
});

test("define-goal 固定骨架：完全沒有建議的開放題，選項欄與建議欄都是「—」", () => {
  const it = item("**第 5 題：你想怎麼規劃這張票？**\n\n先說背景：目前有三個子任務還沒排順序。");
  assert.equal(it.entries[0].options, "—");
  assert.equal(it.entries[0].suggest, "—");
});
