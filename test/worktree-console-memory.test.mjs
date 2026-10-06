import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills/worktree-console/scripts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-memory-"));
process.env.WORKTREE_CONSOLE_LOG_DIR = path.join(tmp, "unused-log");
process.env.WORKTREE_CONSOLE_HOME = path.join(tmp, "home");

const memory = await import(path.join(scripts, "memory.mjs"));
const lib = await import(path.join(scripts, "lib.mjs"));
const { BOARD_WIDTH, displayWidth, pendingBlock } = lib;
const { classify, decline, flowReplies, gitScene, habitFor, itemScene, loadMemory, memoryNotes, proposalLines, readMemory, remember, unreadableNotes, wayKey, forgetMemoryContext } = memory;

const ASK_B = ["要記住這個習慣嗎？", "(B) 已 commit、還沒合進 base 時，你 30 天內 3 次都回「squash、關閉」", "", "輸入「記住 B」記下來，「不記 B」略過"];

const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(res.status, 0, `${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ago = (days, minutes = 0) => NOW - days * 86_400_000 + minutes * 60_000;

// A fresh log dir: the console transcript holds what you typed, the day file holds stops and answers.
function logWith({ prompts = [], events = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "log-"));
  process.env.WORKTREE_CONSOLE_LOG_DIR = dir;
  forgetMemoryContext();
  const transcript = path.join(dir, "console.jsonl");
  fs.writeFileSync(transcript, prompts.map((p) => JSON.stringify({ type: "user", timestamp: iso(p.at), message: { role: "user", content: p.text } })).join("\n") + "\n");
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const file = path.join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`);
  const all = [{ ts: iso(ago(60)), event: "session", role: "console", ticket: "中控台", sessionId: "console-1", transcript }, ...events];
  fs.writeFileSync(file, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

const stop = (ticket, at, scene, extra = {}) => ({ ts: iso(at), event: "stop", repo: "app", ticket, status: "done", question: "做完了。", suggestion: null, scene, ...extra });
const answer = (ticket, at, extra = {}) => ({ ts: iso(at), event: "answer", repo: "app", ticket, via: "text", suggestion: null, answer: "x", delivery: "delivered", ...extra });

// One B round per ticket: the child stops in B, you type `text` a minute later.
function rounds(list) {
  const prompts = [];
  const events = [];
  for (const { ticket, at, text, scene = "B" } of list) {
    events.push(stop(ticket, at - 60_000, scene));
    prompts.push({ at, text: `${ticket} ${text}` });
  }
  return { prompts, events };
}

const doneItem = (tag, row) => ({ tag, row, session: { status: { kind: "done", text: "做完了。" } }, kind: "text", entries: [{ code: tag, question: "做完了。", options: "—", suggest: "—" }] });
const askItem = (tag, question, suggest = "—") => ({ tag, row: {}, session: { status: { kind: "waiting", text: question } }, kind: "text", entries: [{ code: tag, question, options: suggest === "—" ? "—" : "a 甲／b 乙", suggest }] });
const sceneB = (tag) => ({ ...doneItem(tag, {}), scene: "B" });
const habit = (ctx, tag, scene = "B") => habitFor(ctx, doneItem(tag, {}), scene);

test("情境認定：暫存 repo 未 commit 判 A、已 commit 未合進 base 判 B、squash 合進 base 判 C；提問含定稿判 D、開始／開工判 E；有建議判選擇題；都不是不顯示", () => {
  const main = fs.mkdtempSync(path.join(tmp, "repo-"));
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "a.txt"), "1\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const wt = path.join(tmp, `wt-${path.basename(main)}`);
  git(main, "worktree", "add", "-q", "-b", "feat/x", wt);
  assert.equal(gitScene(wt), null, "還沒動工");
  fs.writeFileSync(path.join(wt, "b.txt"), "2\n");
  assert.equal(gitScene(wt), "A");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "feat");
  assert.equal(gitScene(wt), "B");
  git(main, "merge", "--squash", "feat/x");
  git(main, "commit", "-q", "-m", "squash feat/x");
  assert.equal(gitScene(wt), "C");
  assert.equal(itemScene({ ...doneItem("x", { path: wt }) }), "C");
  assert.equal(itemScene(askItem("x", "要定稿嗎？")), "D");
  assert.equal(itemScene(askItem("x", "可以開始實作了嗎？")), "E");
  assert.equal(itemScene(askItem("x", "要開工嗎？")), "E");
  assert.equal(itemScene(askItem("x", "用 A 還是 B？", "a 甲")), "選擇題");
  assert.equal(itemScene(askItem("x", "表格要放哪些欄位？")), null);
});

test("歸類回覆：logging squash merge 後關閉得 {squash, 關閉}；squash 合併回 main 與關閉 focusui 在下次停下前送出合成一次；rebase 前置不算不同做法；slim 處理後 squash 得 {squash} 並記下「處理」", () => {
  const t = ago(1);
  logWith({
    prompts: [
      { at: t, text: "logging squash merge 後關閉" },
      { at: t + 60_000, text: "squash 合併回 main" },
      { at: t + 90_000, text: "關閉 focusui" },
      { at: t + 120_000, text: "slim 處理後 squash" },
      { at: t + 150_000, text: "reader rebase 後 squash 完成後關閉" },
    ],
    events: [
      stop("logging", t - 60_000, "B"),
      stop("focusui", t - 60_000, "B"),
      answer("focusui", t + 65_000),
      stop("slim", t - 60_000, "B"),
      stop("reader", t - 60_000, "B"),
    ],
  });
  const by = Object.fromEntries(flowReplies().map((r) => [r.ticket, r]));
  assert.deepEqual(by.logging.decisions, ["squash", "關閉"]);
  assert.deepEqual(by.focusui.decisions, ["squash", "關閉"]);
  assert.equal(by.focusui.text, "squash 合併回 main，關閉");
  assert.deepEqual(by.slim.decisions, ["squash"]);
  assert.deepEqual(by.slim.unknown, ["處理"]);
  assert.equal(by.reader.key, by.logging.key, "rebase 是前置步驟，跟 squash 後關閉同一做法");
  assert.deepEqual(by.reader.unknown, []);
  assert.equal(wayKey(classify("rebase 後 squash 完成後關閉").decisions), "squash+關閉");
  assert.deepEqual(classify("處理後 squash"), { decisions: ["squash"], unknown: ["處理"] });
});

test("歸類回覆：子 session 又停下之後才送的指令是下一次回覆，不合併", () => {
  const t = ago(1);
  logWith({ prompts: [{ at: t, text: "logging squash merge" }, { at: t + 120_000, text: "logging push" }], events: [stop("logging", t - 60_000, "B"), stop("logging", t + 60_000, "B")] });
  assert.deepEqual(flowReplies().map((r) => r.key), ["squash", "push"]);
});

test("短期門檻：30 天內同情境同做法第 2 次不提議、第 3 次清單最後四行是要記住這個習慣嗎；31 天前的回覆不算", () => {
  const old = rounds([{ ticket: "aaa", at: ago(31), text: "squash merge 後關閉" }]);
  const two = rounds([
    { ticket: "bbb", at: ago(5), text: "squash merge 後關閉" },
    { ticket: "ccc", at: ago(2), text: "squash 合併後關閉" },
  ]);
  logWith({ prompts: [...old.prompts, ...two.prompts], events: [...old.events, ...two.events] });
  let ctx = loadMemory();
  assert.equal(ctx.replies.length, 3);
  assert.deepEqual(memoryNotes(ctx), [], "31 天前那次不算，30 天內只有 2 次");
  assert.equal(habit(ctx, "ddd"), null);
  const third = rounds([{ ticket: "ddd", at: ago(1), text: "squash merge，關閉" }]);
  logWith({ prompts: [...old.prompts, ...two.prompts, ...third.prompts], events: [...old.events, ...two.events, ...third.events] });
  ctx = loadMemory();
  assert.deepEqual(memoryNotes(ctx), ASK_B);
  assert.deepEqual(proposalLines(ctx, "B"), ASK_B);
  for (const other of ["A", "C", "D", "E", "選擇題"]) assert.deepEqual(proposalLines(ctx, other), [], other);
  const item = sceneB("eee");
  item.row = { path: null };
  const lines = pendingBlock([{ repo: "app", label: "eee", ticket: "eee", branch: "eee", title: "x", stage: "實作中", path: null, sessions: [{ n: null, handle: "h", agent: { state: "done" }, status: { kind: "done", text: "做完了。" } }] }]);
  assert.deepEqual(lines.slice(-5), ["", ...ASK_B], "清單最後四行，上面空一行");
});

const threeB = () => rounds([
  { ticket: "aaa", at: ago(6), text: "squash merge 後關閉" },
  { ticket: "bbb", at: ago(5), text: "squash merge 後關閉" },
  { ticket: "ccc", at: ago(4), text: "squash merge，關閉" },
]);

test("記住／不記：記住 B 後 memory.md 的 ## B 段多一行且 ~/.worktree-console 多一個 commit；不記 B 不寫檔，同做法再 3 次才再問", () => {
  const base = threeB();
  const dir = logWith(base);
  assert.equal(remember("B"), "[記憶] 已記住 B：squash、關閉");
  const text = fs.readFileSync(path.join(dir, "memory.md"), "utf8");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("## B"));
  assert.ok(at >= 0, text);
  assert.match(lines[at + 1], /^- squash、關閉（記住 \d{4}-\d{2}-\d{2}，30 天內 3 次）$/);
  assert.match(spawnSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" }).stdout, /memory: 記住 B squash、關閉/);
  assert.deepEqual(memoryNotes(loadMemory()), [], "記住後不再問");

  const dir2 = logWith(base);
  assert.equal(decline("B"), "[記憶] 這次不記 B，同樣做法再 3 次才再問");
  assert.equal(fs.existsSync(path.join(dir2, "memory.md")), false);
  assert.equal(spawnSync("git", ["-C", dir2, "log"], { encoding: "utf8" }).status === 0 && spawnSync("git", ["-C", dir2, "log", "--format=%s"], { encoding: "utf8" }).stdout.includes("memory"), false);
  assert.deepEqual(memoryNotes(loadMemory()), []);
  const state = fs.readFileSync(path.join(dir2, ".state", "memory.json"), "utf8");
  const from = Date.now();
  const more = (n) => rounds(Array.from({ length: n }, (_, i) => ({ ticket: `m${i}`, at: from + (i + 1) * 5 * 60_000, text: "squash merge 後關閉" })));
  for (const [n, asked] of [[2, false], [3, true]]) {
    const extra = more(n);
    logWith({ prompts: [...base.prompts, ...extra.prompts], events: [...base.events, ...extra.events] });
    fs.mkdirSync(path.join(process.env.WORKTREE_CONSOLE_LOG_DIR, ".state"), { recursive: true });
    fs.writeFileSync(path.join(process.env.WORKTREE_CONSOLE_LOG_DIR, ".state", "memory.json"), state);
    assert.equal(memoryNotes(loadMemory({ now: from + 3_600_000 })).length > 0, asked, `不記之後再 ${n} 次`);
  }
});

test("長期記憶生效與移除：B 再出現時顯示做法與依據（長期記憶、記住日期）；rebase 前置不算不同；回了別的做法就刪掉該行並 commit，欄位改依短期次數（不足 3 次空白）", () => {
  const base = threeB();
  const dir = logWith(base);
  remember("B");
  let ctx = loadMemory();
  const h = habit(ctx, "new");
  assert.equal(h.text, "squash、關閉");
  assert.match(h.basis, /^長期記憶，\d{4}-\d{2}-\d{2} 記住$/);
  assert.equal("prefill" in h, false);
  const later = (list) => rounds(list.map((x, i) => ({ ...x, at: NOW + (i + 1) * 60_000 })));
  const rebased = later([{ ticket: "rrr", text: "rebase 後 squash 完成後關閉" }]);
  const memo = fs.readFileSync(path.join(dir, ".state", "memory.json"), "utf8");
  const keep = (extra) => {
    const d = logWith({ prompts: [...base.prompts, ...extra.prompts], events: [...base.events, ...extra.events] });
    fs.copyFileSync(path.join(dir, "memory.md"), path.join(d, "memory.md"));
    fs.mkdirSync(path.join(d, ".state"), { recursive: true });
    fs.writeFileSync(path.join(d, ".state", "memory.json"), memo);
    spawnSync("git", ["-C", d, "init", "-q"]);
    return d;
  };
  keep(rebased);
  ctx = loadMemory({ now: NOW + 10 * 60_000 });
  assert.equal(readMemory().entries.filter((e) => e.readable).length, 1, "rebase 後 squash 後關閉不算不同做法");
  const pushed = later([{ ticket: "ppp", text: "push 就好" }]);
  const d = keep(pushed);
  ctx = loadMemory({ now: NOW + 10 * 60_000 });
  assert.equal(readMemory().entries.length, 0, fs.readFileSync(path.join(d, "memory.md"), "utf8"));
  assert.match(spawnSync("git", ["-C", d, "log", "--format=%s"], { encoding: "utf8" }).stdout, /memory: 移除 B squash、關閉/);
  assert.equal(habit(ctx, "new"), null, "刪掉後只剩 1 次 push，不足 3 次空白");
});

const listRow = (label, status, extra = {}) => ({ repo: "app", label, ticket: label, branch: label, title: "x", stage: "實作中", path: null, sessions: [{ n: null, handle: "h", agent: { state: "done" }, status }], ...extra });

test("手改容錯：改寫說明但保留關鍵字照常生效；沒有關鍵字或沒有情境字母的條目不改不刪，看不懂的提示只給狀態用、不進待回覆清單", () => {
  const dir = logWith(rounds([{ ticket: "aaa", at: ago(1), text: "squash merge 後關閉" }]));
  const hand = ["# 回覆習慣", "", "## B 已 commit 還沒合", "- 先用 squash 方式合併，接著把它關閉（記住 2026-09-01）", "- 看心情（記住 2026-09-01）", ""].join("\n");
  fs.writeFileSync(path.join(dir, "memory.md"), hand);
  const ctx = loadMemory();
  assert.equal(habit(ctx, "x").text, "先用 squash 方式合併，接著把它關閉");
  assert.deepEqual(unreadableNotes(ctx), ["memory.md 有 1 條看不懂（沒有情境字母或認得的關鍵字），腳本不改不刪"]);
  assert.deepEqual(memoryNotes(ctx), []);
  assert.ok(!pendingBlock([listRow("PROJ-1", { kind: "waiting", text: "要改嗎？" })]).join("\n").includes("看不懂"), "待回覆清單不帶");
  assert.deepEqual(pendingBlock([]), [], "沒有待回覆時也不帶");
  assert.equal(fs.readFileSync(path.join(dir, "memory.md"), "utf8"), hand);
  const noLetter = ["## 其他", "- squash 後關閉", ""].join("\n");
  fs.writeFileSync(path.join(dir, "memory.md"), noLetter);
  assert.deepEqual(unreadableNotes(loadMemory()), ["memory.md 有 1 條看不懂（沒有情境字母或認得的關鍵字），腳本不改不刪"]);
  assert.equal(fs.readFileSync(path.join(dir, "memory.md"), "utf8"), noLetter);
});

test("選擇題：欄位顯示最近 30 天 N 次有 M 次照建議；回再多次 memory.md 也不會出現選擇題條目", () => {
  const events = [];
  for (let i = 0; i < 6; i++) events.push(answer("q", ago(i + 1), { suggestion: "A", answer: i < 4 ? "A" : "C" }));
  events.push(answer("q", ago(40), { suggestion: "A", answer: "A" }));
  const dir = logWith({ events });
  const ctx = loadMemory();
  const h = habitFor(ctx, askItem("q", "用哪個？", "a 甲"));
  assert.equal(h.basis, "最近 30 天 6 次有 4 次照建議");
  assert.equal(h.text, "照建議 a");
  assert.equal("prefill" in h, false);
  assert.deepEqual(memoryNotes(ctx), []);
  for (const s of ["A", "B", "C", "D", "E", "選擇題"]) remember(s);
  assert.equal(fs.existsSync(path.join(dir, "memory.md")), false);
});

test("一次性設計題（無建議、非 A–E）欄位留空", () => {
  logWith(threeB());
  assert.equal(habitFor(loadMemory(), askItem("x", "表格要放哪些欄位？")), null);
});

test("待回覆清單多一欄你通常會回，跟建議分開、只照搬過去回覆；每列不超過 100 欄；沒有 mods 也照樣有這欄", () => {
  const main = fs.mkdtempSync(path.join(tmp, "repo-"));
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "a.txt"), "1\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const wt = path.join(tmp, `wt-${path.basename(main)}`);
  git(main, "worktree", "add", "-q", "-b", "feat/y", wt);
  fs.writeFileSync(path.join(wt, "b.txt"), "2\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "feat");
  logWith(threeB());
  const long = "這是一題很長很長的問題，".repeat(8);
  const short = "下一步建議：跑測試";
  const lines = pendingBlock([
    listRow("PROJ-1", { kind: "done", text: `做完了。\n\n${short}` }, { path: wt }),
    listRow("PROJ-2", { kind: "waiting", text: `${long}？` }),
  ]);
  assert.equal(lines[2], "| 狀態 | 代號 | 問題 | 選項 | 建議 | 你通常會回 |");
  const rows = lines.filter((l) => l.startsWith("| ") && !l.startsWith("| 狀態") && !l.startsWith("| ---")).map((l) => l.slice(2, -2).split(" | "));
  const one = rows.find((r) => r[1] === "PROJ-1");
  assert.equal(one[4], "跑測試", "子 session 的建議照舊");
  assert.ok(one[5].startsWith("squash、關閉（"), one[5]);
  assert.equal(rows.find((r) => r[1] === "PROJ-2")[5], "—");
  for (const l of lines.filter((l) => l.startsWith("|"))) assert.ok(displayWidth(l) <= BOARD_WIDTH, `${displayWidth(l)}: ${l}`);
  const plain = pendingBlock([listRow("PROJ-1", { kind: "done", text: `做完了。\n\n${short}` }, { path: wt }), listRow("PROJ-2", { kind: "waiting", text: "要改嗎？" })]);
  assert.equal(plain.find((l) => l.startsWith("| ⏸")).split(" | ").at(-1), "squash、關閉（近 30 天 3 次） |");
});

test("memory.mjs 不呼叫任何外部 API", () => {
  const src = fs.readFileSync(path.join(scripts, "memory.mjs"), "utf8");
  assert.doesNotMatch(src, /fetch|https?:\/\/|anthropic|typesafe/i);
});

test("專注面板資料：卡片不帶你通常會回與預填內容；要記住這個習慣嗎只接在同情境的題目下面，面板沒有 notes", async () => {
  const { focusPayload } = await import(path.join(scripts, "focus.mjs"));
  const main = fs.mkdtempSync(path.join(tmp, "repo-"));
  git(main, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(main, "a.txt"), "1\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const wt = path.join(tmp, `wt-${path.basename(main)}`);
  git(main, "worktree", "add", "-q", "-b", "feat/z", wt);
  fs.writeFileSync(path.join(wt, "b.txt"), "2\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "feat");
  logWith(threeB());
  const rows = [
    { ...listRow("PROJ-1", { kind: "done", text: "做完了。" }, { path: wt }), sessions: [{ n: null, handle: "h1", paneKey: "p1", agent: { state: "done" }, status: { kind: "done", text: "做完了。" } }] },
    { ...listRow("PROJ-2", { kind: "waiting", text: "表格要放哪些欄位？" }), sessions: [{ n: null, handle: "h2", paneKey: "p2", agent: { state: "done" }, status: { kind: "waiting", text: "表格要放哪些欄位？" } }] },
    { ...listRow("PROJ-3", { kind: "waiting", text: "要定稿嗎？" }), sessions: [{ n: null, handle: "h3", paneKey: "p3", agent: { state: "done" }, status: { kind: "waiting", text: "要定稿嗎？" } }] },
  ];
  fs.writeFileSync(path.join(process.env.WORKTREE_CONSOLE_LOG_DIR, "memory.md"), ["# 回覆習慣", "", "## 其他", "- 看心情（記住 2026-09-01）", ""].join("\n"));
  forgetMemoryContext();
  const { payload } = focusPayload(rows, { current: null, queue: [], wait: null, state: { titles: {} } }, { home: tmp });
  const by = Object.fromEntries(payload.sessions.map((s) => [s.tag, s]));
  for (const s of payload.sessions) assert.ok(!("habit" in s) && !("prefill" in s), `${s.tag} 不帶 habit／prefill`);
  assert.equal(payload.notes, undefined);
  assert.deepEqual(by["PROJ-1"].report.split("\n").slice(-5), ["", ...ASK_B], "B 的題目下面空一行接四行");
  for (const tag of ["PROJ-2", "PROJ-3"]) assert.ok(!by[tag].report.includes("要記住"), `${tag} 不是 B，不接`);
  for (const s of payload.sessions) assert.ok(!s.report.includes("看不懂"), `${s.tag} 不帶看不懂`);
  assert.equal(payload.unreadable, "memory.md 有 1 條看不懂（沒有情境字母或認得的關鍵字），腳本不改不刪", "給 mod 在狀態開面板時跳通知");
});
