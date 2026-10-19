import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { focusPayload } from "../skills/worktree-console/scripts/focus.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-advice-"));
process.env.WORKTREE_CONSOLE_HOME = home;
const advisor = path.join(home, "advisor");

const NOW = Date.parse("2026-10-19T08:00:00Z");
const iso = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

function write(predictions, answers = []) {
  fs.rmSync(advisor, { recursive: true, force: true });
  fs.mkdirSync(advisor);
  fs.writeFileSync(path.join(advisor, "predictions.jsonl"), predictions.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(advisor, "answers.jsonl"), answers.map((l) => JSON.stringify(l)).join("\n") + (answers.length ? "\n" : ""));
}

const start = (id, secondsAgo = 5, wt = "/wt/a") => ({ event: "start", id, at: iso(secondsAgo), path: wt, tag: "PROJ-2", kind: "text", question: "**第 2 題：要不要先跑測試？**" });
const done = (ref, extra = {}) => ({ event: "done", ref, at: iso(1), answer: "a", reason: "改動小，先跑最快", type: "流程關卡", principle: null, precedent: null, ...extra });

function sessionOf({ kind = "waiting", since = NOW - 4000 } = {}) {
  const row = { path: "/wt/a", repo: "app", label: "PROJ-2", ticket: "PROJ-2", branch: "proj-2", title: "x", stage: "實作中", sessions: [{ n: null, handle: "h", paneKey: "pane-a", since, agent: { state: "done" }, status: { kind, text: "要不要先跑測試？" } }] };
  const prev = process.env.ADVISOR_HOME;
  process.env.ADVISOR_HOME = advisor;
  try {
    const { payload } = focusPayload([row], { current: null, queue: [], wait: null, state: { titles: {} } }, { home, now: NOW });
    return payload.sessions[0];
  } finally {
    process.env.ADVISOR_HOME = prev;
  }
}

test("橫條建議：預測還在跑顯示「建議產生中…」與已等的秒數，好了下一次輪詢換成「建議：<答案>，<一句理由>」", () => {
  write([start("p1")]);
  assert.deepEqual(sessionOf().advice, { state: "pending", text: "建議產生中… 5 秒" });
  write([start("p1"), done("p1")]);
  assert.equal(sessionOf().advice.text, "建議：a，改動小，先跑最快");
  assert.equal(sessionOf().advice.state, "ready");
});

test("橫條建議：原則性題目註明類別", () => {
  write([start("p1"), done("p1", { principle: "產品行為" })]);
  const advice = sessionOf().advice;
  assert.equal(advice.text, "建議：a，改動小，先跑最快（原則性：產品行為與 UX）");
  assert.equal(advice.principle, "產品行為與 UX");
});

test("橫條建議：預測失敗、背景沒回報逾時、🔐 等你授權、⏸ 回覆完畢都不顯示建議行", () => {
  write([start("p1"), { event: "fail", ref: "p1", at: iso(1), error: "timeout" }]);
  assert.equal(sessionOf().advice, null);
  write([start("p1", 600)]);
  assert.equal(sessionOf({ since: NOW - 600_000 }).advice, null, "超過逾時還沒回報算失敗");
  write([start("p1"), done("p1")]);
  assert.equal(sessionOf({ kind: "permission" }).advice, null);
  assert.equal(sessionOf({ kind: "done" }).advice, null);
});

test("橫條建議：已被回答用掉的預測、比這次停下早很多的舊預測都不拿來顯示；交棒重貼後照樣顯示原本那份", () => {
  write([start("p1"), done("p1")], [{ event: "answer", id: "a1", predictionId: "p1", answer: "a" }]);
  assert.equal(sessionOf().advice, null);
  write([start("p1", 3600), done("p1")]);
  assert.equal(sessionOf({ since: NOW - 4000 }).advice, null);
  write([start("p1", 3600), done("p1"), { event: "repost", ref: "p1", at: iso(3) }]);
  assert.equal(sessionOf({ since: NOW - 4000 }).advice.text, "建議：a，改動小，先跑最快");
});

test("橫條建議：沒有 ~/.advisor/ 時不顯示，/focus-show 的完整回報也不放建議", () => {
  fs.rmSync(advisor, { recursive: true, force: true });
  assert.equal(sessionOf().advice, null);
  write([start("p1"), done("p1")]);
  assert.doesNotMatch(sessionOf().report, /建議：a/);
});
