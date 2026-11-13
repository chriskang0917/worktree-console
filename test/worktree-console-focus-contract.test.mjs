import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FOCUS_VERSION, emptyFocus, focusPayload, saveFocus, stopId } from "../skills/worktree-console/scripts/focus.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-contract-"));
process.env.WORKTREE_CONSOLE_HOME = home;

// What focus-show 0.1.2's own copy of the formula gives for these keys.
const OLD = { "pane-a@100": "1dv6yji", "term_1@1760000000000": "hltllt" };

const saved = (state) => {
  saveFocus(state);
  return JSON.parse(fs.readFileSync(path.join(home, "focus.json"), "utf8"));
};

test("focus.json 帶版本號 1，並寫好橫條這題與排隊題目的編號，focus-show 只要比對字串", () => {
  const file = saved({ ...emptyFocus(), current: "pane-a@100", seen: { "pane-a@100": 1, "term_1@1760000000000": 2 } });
  assert.equal(FOCUS_VERSION, 1);
  assert.equal(file.version, 1);
  assert.equal(file.currentId, OLD["pane-a@100"]);
  assert.deepEqual(file.queuedIds, [OLD["term_1@1760000000000"]]);
  assert.deepEqual(saved(emptyFocus()), { ...emptyFocus(), version: 1, currentId: null, queuedIds: [] });
});

test("只改主 plugin 自己用的欄位（titles、reported 等）時，版本號不變", () => {
  const file = saved({ ...emptyFocus(), current: "pane-a@100", seen: { "pane-a@100": 1 }, titles: { "/wt": "票名" }, reported: ["pane-a@100"], extra: true });
  assert.equal(file.version, 1);
});

test("只更新主 plugin、仍裝 focus-show 0.1.2 時照樣印得出：編號公式沒變，focus.json 仍留著 0.1.2 要讀的 current 與 seen", () => {
  for (const [key, id] of Object.entries(OLD)) assert.equal(stopId(key), id);
  const file = saved({ ...emptyFocus(), current: "pane-a@100", seen: { "pane-a@100": 1, "term_1@1760000000000": 2 } });
  assert.equal(file.current, "pane-a@100");
  assert.deepEqual(Object.keys(file.seen), ["pane-a@100", "term_1@1760000000000"]);
});

test("按 9 時橫條送出的編號就是卡片的 id，與 focus-show 0.1.2 自己算的相同", () => {
  const row = { repo: "app", label: "PROJ-2", ticket: "PROJ-2", branch: "proj-2", title: "x", stage: "實作中", sessions: [{ n: null, handle: "h", paneKey: "pane-a@100", agent: { state: "done" }, status: { kind: "waiting", text: "要定稿嗎？" } }] };
  const { payload } = focusPayload([row], { current: null, queue: [], wait: null, state: { titles: {} } }, { home });
  assert.deepEqual(payload.sessions.map((s) => [s.key, s.id]), [["pane-a@100", OLD["pane-a@100"]]]);
});

// Answers as mods/focus-show does for an announced stop: a focus.json it cannot parse reads as the stop being off the band.
function focusShowAnswer(tag, id) {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(path.join(home, "focus.json"), "utf8"));
  } catch {}
  if (!state) return `[${tag}] 這題已不在橫條上，略過`;
  if (state.currentId === id) return "題目本身";
  return state.queuedIds?.includes(id) ? `[${tag}] 這題已退回排隊，輪到時再印` : `[${tag}] 這題已回覆或已交棒，略過`;
}

test("題目還在橫條上時，/focus-show 剛好在 focus.json 寫到一半時讀，照樣印出題目而不是回略過", () => {
  const state = { ...emptyFocus(), current: "pane-a@100", seen: { "pane-a@100": 1, "term_1@1760000000000": 2 } };
  saveFocus(state);
  const write = fs.writeFileSync;
  let during = null;
  fs.writeFileSync = (file, data, ...rest) => {
    const text = String(data);
    write(file, text.slice(0, Math.floor(text.length / 2)), ...rest);
    during = focusShowAnswer("a", OLD["pane-a@100"]);
    write(file, text, ...rest);
  };
  try {
    saveFocus({ ...state, modsAt: 5 });
  } finally {
    fs.writeFileSync = write;
  }
  assert.equal(during, "題目本身");
  assert.equal(focusShowAnswer("a", OLD["pane-a@100"]), "題目本身");
});
