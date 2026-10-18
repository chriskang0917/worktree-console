import "./fixtures/isolate-env.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-tables-"));
process.env.WORKTREE_CONSOLE_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { agentStatus, boardLines, childAnswer, lastActivity, pendingBlock, pendingItems, reportLines } = await import("../skills/worktree-console/scripts/lib.mjs");
const { focusPayload, syncFocus } = await import("../skills/worktree-console/scripts/focus.mjs");

const TABLE = ["| 項目 | 結果 |", "| --- | --- |", "| 測試 | 全過 |", "| lint | 兩個警告 |"];
const rowOf = (text, extra = {}) => ({
  repo: "app",
  label: "PROJ-1",
  ticket: "PROJ-1",
  path: "/tmp/wt-proj-1",
  branch: "proj-1",
  title: "登入頁",
  stage: "實作中",
  sessions: [{ n: null, paneKey: "t:1", handle: "h1", agent: { state: "done", stateStartedAt: 1 }, status: agentStatus({ state: "done", lastAssistantMessage: text }), ...extra }],
});
const tableIn = (lines) => {
  const at = lines.indexOf(TABLE[0]);
  return at >= 0 ? lines.slice(at, at + TABLE.length) : null;
};

test("回報裡的 markdown 表格留在引用框外面畫成表格：/focus-show 的回報、watcher 回報與 detail 共用的 reportLines 都一樣", () => {
  const text = ["檢查完了：", "", ...TABLE, "", "要我修掉警告嗎？"].join("\n");
  const row = rowOf(text);
  const lines = reportLines(row, row.sessions[0].status, row.sessions[0]);
  assert.deepEqual(tableIn(lines), TABLE, lines.join("\n"));
  const at = lines.indexOf(TABLE[0]);
  assert.equal(lines[at - 1], "", "表格前空一行，引用框在這裡結束");
  assert.equal(lines[at + TABLE.length], "", "表格後空一行再接引用框");
  assert.ok(lines.includes("> 檢查完了：") && lines.includes("> 要我修掉警告嗎？"), lines.join("\n"));
  assert.ok(!lines.some((l) => /^>\s*\|/.test(l)), "沒有一行是引用框裡的 | 原始文字");
  const view = syncFocus([row], { now: 10 });
  const { payload } = focusPayload([row], view, { now: 10 });
  assert.deepEqual(tableIn(payload.sessions[0].report.split("\n")), TABLE, "/focus-show 印的回報同樣畫成表格");
});

test("程式碼區塊裡的 | 不當表格，照舊留在引用框", () => {
  const text = ["例子：", "```", ...TABLE, "```", "這樣可以嗎？"].join("\n");
  const row = rowOf(text);
  const lines = reportLines(row, row.sessions[0].status, row.sessions[0]);
  assert.equal(tableIn(lines), null);
  assert.ok(lines.includes(`> ${TABLE[0]}`), lines.join("\n"));
});

test("回覆最後一段是表格時，看板、待回覆清單、卡片與橫條的題目那一行都不是表格列", () => {
  for (const text of [["改好了，結果如下。", "", ...TABLE].join("\n"), ["要合併嗎？", "", ...TABLE].join("\n"), TABLE.join("\n")]) {
    const row = rowOf(text);
    const shown = [
      lastActivity(row.sessions[0].status),
      ...boardLines([row]).filter((l) => l.includes("PROJ-1")),
      ...pendingBlock([row]).filter((l) => l.includes("PROJ-1")),
    ];
    const view = syncFocus([row], { now: 10 });
    const { payload } = focusPayload([row], view, { now: 10 });
    const question = payload.sessions[0].question;
    for (const line of [shown[0], question]) assert.doesNotMatch(line, /\|\s*(---|測試|lint|項目)/, `${text}\n→ ${line}`);
    for (const line of shown.slice(1)) assert.doesNotMatch(line, /\\\|/, `${text}\n→ ${line}`);
  }
  const row = rowOf(["改好了，結果如下。", "", ...TABLE].join("\n"));
  assert.equal(lastActivity(row.sessions[0].status), "改好了，結果如下。");
  assert.equal(lastActivity(rowOf(["要合併嗎？", "", ...TABLE].join("\n")).sessions[0].status), "要合併嗎？");
});

test("子 session 用表格列選項（第一欄是 A、B 或 1、2）：待回覆選項欄列 a、b、c，回 b 送出原本的代號", () => {
  const cases = [
    { text: ["這次要怎麼做，選哪個？", "", "| 代號 | 方案 | 說明 |", "| --- | --- | --- |", "| A | 只改前端 | 快 |", "| **B** | 前後端一起改（建議） | 完整 |", "| C | 先不改 | — |"].join("\n"), codes: ["A", "B", "C"], options: "a 只改前端／b 前後端一起改／c 先不改", suggest: "b" },
    { text: ["要用哪一種部署方式？", "", "| # | 方式 |", "|---|---|", "| 1 | 直接部署 |", "| 2 | 先上 staging |"].join("\n"), codes: ["1", "2"], options: "a 直接部署／b 先上 staging", suggest: "—" },
  ];
  for (const c of cases) {
    const row = rowOf(c.text);
    const [item] = pendingItems([row]);
    assert.equal(item.kind, "text");
    assert.deepEqual(item.choices, c.codes, c.text);
    assert.equal(item.entries[0].options, c.options);
    assert.equal(item.entries[0].suggest, c.suggest);
    assert.equal(childAnswer(item, "b"), c.codes[1], "回 b 送子 session 的第二個代號");
    const block = pendingBlock([row]).join("\n");
    assert.match(block, new RegExp(c.options.split("／")[0]));
  }
});
