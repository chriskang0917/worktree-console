import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consoleScript = path.join(root, "skills", "worktree-console", "scripts", "console.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-asks-"));
const wtA = path.join(tmp, "wt", "alpha");
const wtB = path.join(tmp, "wt", "beta");
for (const wt of [wtA, wtB]) {
  fs.mkdirSync(path.join(wt, "sub", "deep"), { recursive: true });
  fs.mkdirSync(path.join(wt, "other"));
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: /nowhere\n");
}

const now = new Date();
const daysAgo = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12).toISOString();
const ask = (extra) => ({ event: "answer", source: "console", kind: "text", path: wtA, tag: "alpha", ts: daysAgo(1), ...extra });

function advisor(records) {
  const home = fs.mkdtempSync(path.join(tmp, "advisor-"));
  fs.writeFileSync(path.join(home, "answers.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return home;
}

function asks(home, ...args) {
  const res = spawnSync(process.execPath, [consoleScript, "asks", ...args], { encoding: "utf8", env: { ...process.env, ADVISOR_HOME: home } });
  return { status: res.status, lines: res.stdout.trimEnd().split("\n") };
}

const row = (lines, tag) => lines.find((l) => l.startsWith(`${tag}｜`));

test("asks：代回、代錯改正、judge、自由提問都不算「問你幾次」，只算 console／tab 的出題格式與選單題", () => {
  const home = advisor([
    ask({ answer: "a" }),
    ask({ source: "tab", kind: "menu", answer: "b" }),
    ask({ source: "auto", answer: "a" }),
    ask({ source: "override", answer: "b" }),
    { event: "judge", path: wtA, tag: "alpha", ts: daysAgo(1) },
    ask({ kind: "free", answer: "貼完了" }),
    ask({ kind: null, answer: "先補拍" }),
  ]);
  const { status, lines } = asks(home);
  assert.equal(status, 0);
  assert.equal(row(lines, "alpha"), "alpha｜2｜0｜0%");
});

test("asks：回答開頭的選項字母等於子 session 建議的字母、或回「照建議」「全照建議」算自答；沒有 childSuggestion 不算自答", () => {
  const home = advisor([
    ask({ answer: "a，另外多加一個", childSuggestion: "a，改動最小" }),
    ask({ answer: "b", childSuggestion: "a。比較穩" }),
    ask({ answer: "照建議", childSuggestion: "c，先看" }),
    ask({ answer: "全照建議", childSuggestion: "a" }),
    ask({ kind: "menu", answer: "a", childSuggestion: "a. 送出並合併" }),
    ask({ answer: "squash", childSuggestion: "s，壓成一個" }),
    ask({ answer: "照建議", childSuggestion: null }),
  ]);
  assert.equal(row(asks(home).lines, "alpha"), "alpha｜7｜4｜57%");
});

test("asks：批改單回 a 或 b 都算自答，回 c 不算", () => {
  const home = advisor([
    ask({ format: "批改單", answer: "a", childSuggestion: "a，資料都查清楚了" }),
    ask({ format: "批改單", answer: "b", childSuggestion: "a，資料都查清楚了" }),
    ask({ format: "批改單", answer: "aaa", childSuggestion: "a，資料都查清楚了" }),
    ask({ format: "批改單", answer: "c 第 3 題改成…", childSuggestion: "a，資料都查清楚了" }),
  ]);
  assert.equal(row(asks(home).lines, "alpha"), "alpha｜4｜3｜75%");
});

test("asks：worktree 底下子目錄的紀錄歸回同一列，代號用該 worktree 最後一筆紀錄的 tag，依問的次數由多到少排", () => {
  const home = advisor([
    ask({ tag: "SARA-1", path: wtA, ts: daysAgo(3), answer: "a" }),
    ask({ tag: "SARA-1", path: path.join(wtA, "sub", "deep"), ts: daysAgo(2), answer: "a" }),
    ask({ tag: "alpha", path: path.join(wtA, "sub"), ts: daysAgo(1), answer: "a" }),
    ask({ tag: "beta", path: path.join(wtB, "sub"), answer: "a" }),
    ask({ tag: "beta", path: path.join(wtB, "other"), answer: "a" }),
  ]);
  const { lines } = asks(home);
  assert.deepEqual(lines.slice(1, 4), ["代號｜問你幾次｜agent 自己能回答｜比例", "alpha｜3｜0｜0%", "beta｜2｜0｜0%"]);
  assert.equal(row(lines, "SARA-1"), undefined);
});

test("asks：最下面是本期合計，再一行是前一個等長期間的合計與差值；--days 改期間長度", () => {
  const home = advisor([
    ask({ ts: daysAgo(1), answer: "a", childSuggestion: "a" }),
    ask({ ts: daysAgo(6), answer: "b", childSuggestion: "a" }),
    ask({ ts: daysAgo(8), answer: "a", childSuggestion: "a" }),
    ask({ ts: daysAgo(9), answer: "a", childSuggestion: "a" }),
    ask({ ts: daysAgo(13), answer: "b", childSuggestion: "a" }),
    ask({ ts: daysAgo(14), answer: "a", childSuggestion: "a" }),
  ]);
  const week = asks(home).lines;
  assert.match(week[0], /（7 天）$/);
  assert.equal(week.at(-2), "本期 2 次（自答 1，50%）");
  assert.match(week.at(-1), /^前期 \d\d\/\d\d–\d\d\/\d\d：3 次（自答 2，67%）· −1 次$/);
  const twoDays = asks(home, "--days", "2").lines;
  assert.equal(twoDays.at(-2), "本期 1 次（自答 1，100%）");
  assert.match(twoDays.at(-1), /：0 次（自答 0，—）· \+1 次$/);
});

test("asks：--since 從那天起算到今天，前期是它之前等長的天數", () => {
  const home = advisor([ask({ ts: daysAgo(2), answer: "a" }), ask({ ts: daysAgo(4), answer: "a" }), ask({ ts: daysAgo(5), answer: "a" })]);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
  const since = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const { lines } = asks(home, "--since", since);
  assert.match(lines[0], /（3 天）$/);
  assert.equal(lines.at(-2), "本期 1 次（自答 0，0%）");
  assert.match(lines.at(-1), /：2 次（自答 0，0%）· −1 次$/);
  assert.equal(asks(home, "--since", "11/13").status, 1);
});

test("asks：沒有 advisor 目錄、或期間內沒有紀錄時印一行「期間內沒有回答紀錄」並 exit 0", () => {
  assert.deepEqual(asks(path.join(tmp, "missing")), { status: 0, lines: ["期間內沒有回答紀錄"] });
  const old = advisor([ask({ ts: daysAgo(10), answer: "a" }), ask({ source: "auto", answer: "a" })]);
  assert.deepEqual(asks(old), { status: 0, lines: ["期間內沒有回答紀錄"] });
});
