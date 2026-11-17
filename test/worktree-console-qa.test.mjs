import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWhen, qaRange } from "../skills/worktree-console/scripts/qa.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consoleScript = path.join(root, "skills", "worktree-console", "scripts", "console.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-qa-"));

const now = new Date();
const at = (daysAgo, hour, minute = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute);
const iso = (d) => d.toISOString();
const hhmm = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
// Today's records sit at 00:01–00:05 so they are never later than now.
const T = (m) => at(0, 0, m);

function world(records, { events = [], copies = {}, originals = {} } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, "advisor-"));
  fs.writeFileSync(path.join(home, "answers.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const log = fs.mkdtempSync(path.join(tmp, "log-"));
  const byDay = new Map();
  for (const e of events) byDay.set(e.ts.slice(0, 10), [...(byDay.get(e.ts.slice(0, 10)) ?? []), e]);
  for (const [day, list] of byDay) fs.writeFileSync(path.join(log, `${day}.jsonl`), list.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.mkdirSync(path.join(log, "transcripts"));
  for (const [id, entries] of Object.entries(copies)) fs.writeFileSync(path.join(log, "transcripts", `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const projects = fs.mkdtempSync(path.join(tmp, "projects-"));
  fs.mkdirSync(path.join(projects, "-wt"));
  for (const [id, entries] of Object.entries(originals)) fs.writeFileSync(path.join(projects, "-wt", `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const run = (...args) => {
    const res = spawnSync(process.execPath, [consoleScript, "qa", ...args], { encoding: "utf8", env: { ...process.env, ADVISOR_HOME: home, WORKTREE_CONSOLE_LOG_DIR: log, CLAUDE_PROJECTS_DIR: projects } });
    return { status: res.status, lines: res.stdout.trimEnd().split("\n") };
  };
  return { home, run };
}

const answer = (extra) => ({ event: "answer", ts: iso(T(1)), tag: "alpha", source: "console", kind: "text", question: "要先改 A 還是 B？", answer: "a", ...extra });

test("qa：一題一行「時間｜代號｜問什麼｜怎麼回｜誰回的」，誰回的分使用者／代回／分頁直接回；judge 不列；不帶時間只列今天", () => {
  const w = world([
    answer({ ts: iso(T(1)) }),
    answer({ ts: iso(T(2)), source: "auto", answer: "b" }),
    answer({ ts: iso(T(3)), source: "tab", tag: "beta", kind: "menu", answer: "紅" }),
    answer({ ts: iso(T(4)), source: "override", answer: "c" }),
    { event: "judge", ts: iso(T(4)), tag: "alpha", hit: true },
    answer({ ts: iso(at(1, 12)), answer: "昨天的" }),
  ]);
  assert.deepEqual(w.run().lines, [
    `${hhmm(T(1))}｜alpha｜要先改 A 還是 B？｜a｜使用者`,
    `${hhmm(T(2))}｜alpha｜要先改 A 還是 B？｜b｜代回`,
    `${hhmm(T(3))}｜beta｜要先改 A 還是 B？｜紅｜分頁直接回`,
    `${hhmm(T(4))}｜alpha｜要先改 A 還是 B？｜c｜使用者`,
  ]);
});

test("qa：沒記題目時，用同一個 session 稍早的停下事件補，再不行用對話副本（副本已刪就讀 ~/.claude/projects 的原始對話）裡子 session 最後一段，都補不到寫「（沒記到題目）」", () => {
  const w = world(
    [
      answer({ ts: iso(T(2)), question: "", sessionId: "s1", answer: "照做" }),
      answer({ ts: iso(T(3)), question: "", sessionId: "s2", tag: "beta", answer: "好" }),
      answer({ ts: iso(T(4)), question: "", sessionId: "s3", tag: "gamma", answer: "嗯" }),
      answer({ ts: iso(T(5)), question: "", sessionId: "s4", tag: "delta", answer: "可以" }),
    ],
    {
      events: [{ ts: iso(T(1)), event: "stop", ticket: "alpha", sessionId: "s1", status: "done", question: "在審核頁按「送出決定」。" }],
      copies: { s2: [{ type: "assistant", timestamp: iso(T(1)), message: { content: [{ type: "text", text: "改好了。\n\n要合併嗎？" }] } }] },
      originals: { s4: [{ type: "assistant", timestamp: iso(T(1)), message: { content: [{ type: "text", text: "副本刪了。\n\n原始對話還在嗎？" }] } }] },
    },
  );
  assert.deepEqual(w.run().lines.map((l) => l.split("｜")[2]), ["在審核頁按「送出決定」。", "要合併嗎？", "（沒記到題目）", "原始對話還在嗎？"]);
});

test("qa：可帶多個代號、--grep 比對代號題目與回答、--limit 只留最新 N 筆；沒有符合的印「這段時間沒有問答紀錄」", () => {
  const w = world([answer({ ts: iso(T(1)) }), answer({ ts: iso(T(2)), tag: "beta", answer: "改用 API" }), answer({ ts: iso(T(3)), tag: "gamma" }), answer({ ts: iso(T(4)), tag: "beta" })]);
  assert.deepEqual(w.run("alpha", "gamma").lines.map((l) => l.split("｜")[1]), ["alpha", "gamma"]);
  assert.deepEqual(w.run("--grep", "api").lines.map((l) => l.split("｜")[3]), ["改用 API"]);
  assert.deepEqual(w.run("--limit", "2").lines.map((l) => l.split("｜")[1]), ["gamma", "beta"]);
  assert.deepEqual(w.run("nope").lines, ["這段時間沒有問答紀錄"]);
  assert.equal(w.run("--limit", "0").status, 1);
});

test("qa：--days N 含今天往前 N 天；--since／--until 接受日期、日期加時間、today、yesterday、3h、2d；看不懂的時間 exit 1", () => {
  const w = world([answer({ ts: iso(at(2, 12)), answer: "前天" }), answer({ ts: iso(at(1, 9)), answer: "昨天早" }), answer({ ts: iso(at(1, 15)), answer: "昨天下午" }), answer({ ts: iso(T(1)), answer: "今天" })]);
  const answers = (...args) => w.run(...args).lines.map((l) => l.split("｜")[3]);
  assert.deepEqual(answers("--days", "2"), ["昨天早", "昨天下午", "今天"]);
  assert.deepEqual(answers("--since", "yesterday", "--until", "yesterday"), ["昨天早", "昨天下午"]);
  const y = at(1, 0);
  const ymd = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  assert.deepEqual(answers("--since", `${ymd} 12:00`, "--until", "today"), ["昨天下午", "今天"]);
  assert.deepEqual(answers("--since", "3d"), ["前天", "昨天早", "昨天下午", "今天"]);
  assert.equal(w.run("--since", "上週").status, 1);
});

test("qa：只讀 advisor 的紀錄，不寫也不改它", () => {
  const w = world([answer({})]);
  const before = fs.readdirSync(w.home).map((f) => [f, fs.statSync(path.join(w.home, f)).mtimeMs, fs.statSync(path.join(w.home, f)).size]);
  w.run("--days", "3");
  const after = fs.readdirSync(w.home).map((f) => [f, fs.statSync(path.join(w.home, f)).mtimeMs, fs.statSync(path.join(w.home, f)).size]);
  assert.deepEqual(after, before);
});

test("qa 的時間解析：日期當 --until 是那天結束；相對時間從現在往回算", () => {
  const n = new Date(2026, 10, 16, 15, 30).getTime();
  assert.equal(parseWhen("2026-11-15", { now: n }), new Date(2026, 10, 15).getTime());
  assert.equal(parseWhen("2026-11-15", { end: true, now: n }), new Date(2026, 10, 16).getTime());
  assert.equal(parseWhen("2026-11-15 08:05", { end: true, now: n }), new Date(2026, 10, 15, 8, 5).getTime());
  assert.equal(parseWhen("3h", { now: n }), n - 3 * 3600e3);
  assert.equal(parseWhen("30m", { now: n }), n - 30 * 60e3);
  assert.equal(parseWhen("today", { end: true, now: n }), new Date(2026, 10, 17).getTime());
  assert.deepEqual(qaRange({ now: n }), { from: new Date(2026, 10, 16).getTime(), to: new Date(2026, 10, 17).getTime() });
  assert.throws(() => qaRange({ days: 0, now: n }), /--days 要是正整數/);
});
