import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { throwaway } from "../hooks/auto-handoff.mjs";
import { collect, repoLead, stripPrompt } from "../skills/worktree-console/scripts/lib.mjs";
import { keepaliveStep } from "../skills/worktree-console/scripts/keepalive.mjs";
import { focusPayload, syncFocus } from "../skills/worktree-console/scripts/focus.mjs";
import { sweepDisposable } from "../skills/worktree-console/scripts/disposable.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills", "worktree-console", "scripts");
const fakeOrca = path.join(root, "test", "fixtures", "worktree-console", "fake-orca.mjs");
const MIN = 60_000;
const DEFINE_GOAL = "/agent-skills:define-goal PROJ-1234（母票 PROJ-1200）：修登入頁；slug 用 proj-1234（有母票時也用子票號，不用母票號）；以純文字一次問一題，不要用 AskUserQuestion 或任何選單介面";

let tmp;
let app;
let watchScripts;
let seq = 0;

const gitIn = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-cards-")));
  app = path.join(tmp, "app");
  fs.mkdirSync(app);
  gitIn(app, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(app, "a.txt"), "a\n");
  gitIn(app, "add", ".");
  gitIn(app, "commit", "-qm", "init");
  for (const n of [1, 2]) gitIn(app, "worktree", "add", "-q", "-b", `proj-${n}`, path.join(tmp, "wt", `proj-${n}`), "main");
  watchScripts = path.join(tmp, "cards-scripts");
  fs.symlinkSync(scripts, watchScripts);
  fs.chmodSync(fakeOrca, 0o755);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const wt = (n) => path.join(tmp, "wt", `proj-${n}`);
const pane = (id) => `tab-${id}:leaf-${id}`;

const agentOf = (s) => ({ paneKey: pane(s.id), state: s.state ?? "done", toolName: null, toolInput: null, stateStartedAt: s.since, prompt: s.prompt ?? "做事", lastAssistantMessage: s.text ?? null });

// A fake Orca world: sessions with the same n share worktree proj-<n>.
function world(sessions, names = {}) {
  const dir = path.join(tmp, `w${++seq}`);
  fs.mkdirSync(dir);
  const put = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  const byN = new Map();
  for (const s of sessions) byN.set(s.n, [...(byN.get(s.n) ?? []), s]);
  put("repo-list.json", { ok: true, result: { repos: [{ id: "r1", path: app, displayName: "app" }] } });
  const branch = (n) => (names[n] ? `refs/heads/ask-${names[n]}` : `refs/heads/proj-${n}`);
  const linked = (n) => (names[n] ? null : `PROJ-${n}`);
  put("worktree-list.json", { ok: true, result: { worktrees: [1, 2].map((n) => ({ path: wt(n), repoId: "r1", branch: branch(n), linkedLinearIssue: linked(n), displayName: names[n] ?? `proj-${n}` })) } });
  put("terminal-list.json", {
    ok: true,
    result: { terminals: sessions.map((s, i) => ({ handle: `term_${s.id}`, tabId: `tab-${s.id}`, leafId: `leaf-${s.id}`, worktreePath: wt(s.n), agentIdentity: "claude", createdAt: 1000 + i })) },
  });
  put("worktree-ps.json", { ok: true, result: { worktrees: [...byN].map(([n, list]) => ({ path: wt(n), repoId: "r1", branch: branch(n), linkedLinearIssue: linked(n), agents: list.map(agentOf) })) } });
  return dir;
}

function homes() {
  const dir = path.join(tmp, `h${++seq}`);
  const env = {
    WORKTREE_CONSOLE_HOME: path.join(dir, "console"),
    WORKTREE_CONSOLE_LOG_DIR: path.join(dir, "log"),
    AUTO_HANDOFF_HOME: path.join(dir, "handoff"),
    CLAUDE_PROJECTS_DIR: path.join(dir, "projects"),
  };
  fs.mkdirSync(env.WORKTREE_CONSOLE_HOME, { recursive: true });
  return env;
}

const putHome = (home, file, value) => fs.writeFileSync(path.join(home.WORKTREE_CONSOLE_HOME, file), JSON.stringify(value));

function envFor(dir, home) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORCA_|WATCH_|WORKTREE_CONSOLE_|AUTO_HANDOFF_|CLAUDE_)/.test(k))),
    ORCA_BIN: fakeOrca,
    FAKE_ORCA_DIR: dir,
    ORCA_TERMINAL_HANDLE: "term_self",
    CLAUDE_CODE_SESSION_ID: "",
    WATCH_INTERVAL_MS: "20",
    WATCH_TIMEOUT_MS: "400",
    WATCH_PGREP_PATTERN: `${watchScripts}/watch\\.mjs`,
    ...home,
  };
}

function watch(dir, home) {
  const res = spawnSync(process.execPath, [path.join(watchScripts, "watch.mjs")], { encoding: "utf8", env: envFor(dir, home) });
  return res.stdout.trim().split("\n").filter((l) => !l.startsWith("baseline:"));
}

const sends = (dir) =>
  (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n") : []).filter((l) => l.startsWith("terminal send")).map((l) => l.split(" ")[3]);

function inWorld(dir, home, fn) {
  const env = envFor(dir, home);
  const keys = Object.keys(env).filter((k) => /^(ORCA_|WATCH_|WORKTREE_CONSOLE_|AUTO_HANDOFF_|CLAUDE_|FAKE_)/.test(k));
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, Object.fromEntries(keys.map((k) => [k, env[k]])));
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// The focus pane's cards and queue, as the console would draw them.
function cards(dir, home, now = Date.now()) {
  return inWorld(dir, home, () => {
    const data = collect(null, { withStage: true });
    for (const r of data.rows) r.title = r.ticket === "PROJ-1" ? "[FE] 登入頁改版" : null;
    const view = syncFocus(data.rows, { now });
    const { payload } = focusPayload(data.rows, view, { now, keys: data.keys });
    return { cards: Object.fromEntries(payload.sessions.map((s) => [s.tag, s])), queue: [view.current, ...view.queue].filter(Boolean).map((e) => e.item.tag) };
  });
}

function registerTranscript(home, id, entries) {
  const file = path.join(home.CLAUDE_PROJECTS_DIR, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.mkdirSync(home.WORKTREE_CONSOLE_LOG_DIR, { recursive: true });
  fs.appendFileSync(
    path.join(home.WORKTREE_CONSOLE_LOG_DIR, `${new Date().toLocaleDateString("sv")}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), event: "session", role: "child", handle: `term_${id}`, sessionId: `sess-${id}`, transcript: file }) + "\n",
  );
}

const typed = (text) => ({ type: "user", message: { role: "user", content: text } });
const command = (name, args) => typed(`<command-message>${name.slice(1)}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`);

test("剝殼：define-goal 首則指令只剩任務那段；票號、母票號、斜線指令名、slug 起的固定交代段都拿掉", () => {
  assert.equal(stripPrompt(DEFINE_GOAL), "修登入頁");
  assert.equal(stripPrompt("<command-name>/agent-skills:define-goal</command-name>\n<command-args>PROJ-1234（母票 PROJ-1200）：修登入頁；slug 用 proj-1234</command-args>"), "修登入頁", "對話紀錄裡的斜線指令格式也認");
  assert.equal(stripPrompt("/agent-skills:define-goal login：修登入頁；slug 用 login；以純文字一次問一題"), "修登入頁", "沒票時以暱稱代替票號");
  assert.equal(stripPrompt("PROJ-1234（母票 PROJ-1200）：修登入頁錯誤訊息，只改前端"), "修登入頁錯誤訊息，只改前端", "不跑 define-goal 的首則指令");
  assert.equal(stripPrompt("PROJ-77：補單元測試"), "補單元測試");
  assert.equal(stripPrompt("/goal 本次任務依 /Users/x/projects/app/.goals/proj-1234.md 執行：先完整讀過該檔（含 Non-goals）"), "proj-1234", "交棒的 /goal 只留目標檔名");
  assert.equal(stripPrompt("幫我看 README 寫得怎樣"), "幫我看 README 寫得怎樣", "沒有殼的照原樣");
  assert.equal(stripPrompt("/clear"), "");
  assert.equal(stripPrompt(""), "");
});

test("卡片右下角：同一個 worktree 兩個以上 session 時各顯示自己的任務標題／剝殼後的首則指令（超過 20 個中文字截短）／最後回覆前 20 字；單一 session 照舊顯示票名", () => {
  const now = Date.now();
  const home = homes();
  putHome(home, "tasks.json", { [pane("A")]: { title: "修登入頁錯誤訊息", handle: "term_A", at: now } });
  registerTranscript(home, "B", [command("/agent-skills:define-goal", "PROJ-1（母票 PROJ-0）：修登入頁；slug 用 proj-1；以純文字一次問一題"), { type: "assistant", message: { content: [{ type: "text", text: "好" }] } }, typed("第二句")]);
  registerTranscript(home, "D", [typed("PROJ-1：把整個註冊流程的錯誤訊息全部改成中文並補上對應的單元測試與端對端測試")]);
  const dir = world([
    { id: "A", n: 1, text: "改好了。", prompt: "繼續", since: now - 5 * MIN },
    { id: "B", n: 1, text: "要先改哪一頁？", prompt: "第二句", since: now - 4 * MIN },
    { id: "C", n: 1, text: "這是一則很長的最後回覆，前二十個字之後的內容不會出現在卡片上", prompt: "", since: now - 3 * MIN, state: "done" },
    { id: "D", n: 1, text: "做完了。", prompt: "再跑一次", since: now - 2 * MIN },
    { id: "E", n: 2, text: "也做完了。", since: now - MIN },
  ]);
  const { cards: c } = cards(dir, home, now);
  assert.equal(c["PROJ-1#1"].summary, "修登入頁錯誤訊息", "中控台寫的任務標題");
  assert.equal(c["PROJ-1#2"].summary, "修登入頁", "沒有標題：首則指令剝殼");
  assert.equal(c["PROJ-1#3"].summary, "這是一則很長的最後回覆，前二十個字之後的…", "首則指令讀不到：最後回覆前 20 字");
  assert.equal(c["PROJ-1#4"].summary, "把整個註冊流程的錯誤訊息全部改成中文並補…", "剝殼後超過 20 個中文字以「…」截短");
  assert.equal(c["PROJ-2"].summary, "proj-2", "單一 session：沒有票名用 branch");
  const single = cards(world([{ id: "F", n: 1, text: "好了。", since: now - MIN }]), home, now).cards;
  assert.equal(single["PROJ-1"].summary, "[FE] 登入頁改版", "單一 session：票名");
  assert.ok(Object.values(c).every((x) => !("suggest" in x)), "卡片資料不再帶建議");
});

test("repo 名稱開頭：唯一對到才算、對到多個要反問、對不到照原規則；同時是 session 代號時以代號優先", () => {
  const repos = ["proj-agents-configuration", "proj-v2-frontend", "proj-v3-frontend", "agent-skills", "hours-dashboard"].map((name) => ({ name, main: `/r/${name}` }));
  assert.deepEqual(repoLead("proj-agent", repos), { match: "one", repo: repos[0] });
  assert.deepEqual(repoLead("PROJ-AGENT", repos).repo?.name, "proj-agents-configuration", "不分大小寫");
  assert.deepEqual(repoLead("proj-v", repos), { match: "many", repos: [repos[1], repos[2]] });
  assert.deepEqual(repoLead("proj-v2-frontend", repos).repo?.name, "proj-v2-frontend");
  assert.deepEqual(repoLead("zzz", repos), { match: "none" });
  assert.deepEqual(repoLead("a", repos), { match: "none" }, "a、b、c 是回答，不當 repo 開頭");
  assert.deepEqual(repoLead("ag", repos), { match: "none" }, "少於 3 個字元不算");
  const rows = [{ repo: "app", label: "hours", ticket: null, branch: "feat/hours", base: "hours", sessions: [{ n: null }] }];
  assert.deepEqual(repoLead("hours", repos, rows), { match: "session" }, "等於 session 代號時當成指揮該 session");
  assert.deepEqual(repoLead("hours", repos).repo?.name, "hours-dashboard");
});

test("拋棄式 session（暫存 worktree 與臨時分頁）不續命、不交棒；回覆完畢照常進待回覆排隊、上專注橫條", () => {
  const now = Date.now();
  const home = homes();
  putHome(home, "disposable.json", [
    { kind: "tab", paneKey: pane("T"), handle: "term_T", path: wt(1), title: "問登入流程", at: now },
    { kind: "worktree", path: wt(2), main: app, repo: "app", branch: "proj-2", start: null, nickname: "skills", title: "有哪些 skill", at: now, seen: true },
  ]);
  const list = [
    { id: "K", n: 1, text: "登入頁改好了。", since: now - 51 * MIN },
    { id: "T", n: 1, text: "登入流程是先打 /auth 再導回首頁。", since: now - 52 * MIN },
    { id: "W", n: 2, text: "這個 repo 有 12 個 skill。", since: now - 53 * MIN },
  ];
  const dir = world(list, { 2: "skills" });
  watch(dir, home);
  watch(dir, home);
  assert.deepEqual(sends(dir), ["term_K"], "只有一般 session 收到續命訊息");
  const rows = inWorld(dir, home, () => collect(null, { withStage: false }).rows);
  const by = Object.fromEntries(rows.flatMap((r) => r.sessions.map((s) => [s.paneKey, s])));
  assert.deepEqual([by[pane("K")].disposable, by[pane("T")].disposable, by[pane("W")].disposable], [false, true, true]);
  let state = {};
  for (let t = now; t < now + 8 * 60 * MIN; t += 5 * MIN) {
    const step = keepaliveStep(rows, state, t, { contextOf: () => 900_000 });
    assert.ok(step.actions.every((a) => a.session.paneKey === pane("K")), "拋棄式 session 從頭到尾不續命、不交棒");
    state = step.state;
  }
  const view = cards(dir, home, now);
  assert.deepEqual(view.queue.sort(), ["PROJ-1#1", "PROJ-1#2", "skills"].sort(), "回覆完畢照常進待回覆排隊");
  assert.equal(view.cards.skills.summary, "有哪些 skill", "暫存 worktree 的卡片顯示任務標題");
  assert.equal(view.cards["PROJ-1#2"].summary, "問登入流程");
});

test("自動交棒 hook：拋棄式 session（暫存 worktree 裡、或登記過的臨時分頁）不交棒，其他照舊", () => {
  const home = homes();
  putHome(home, "disposable.json", [
    { kind: "tab", paneKey: pane("T"), handle: "term_T", path: wt(1) },
    { kind: "worktree", path: wt(2), nickname: "skills" },
  ]);
  const prev = process.env.WORKTREE_CONSOLE_HOME;
  process.env.WORKTREE_CONSOLE_HOME = home.WORKTREE_CONSOLE_HOME;
  try {
    assert.equal(throwaway(wt(1), "term_T"), true);
    assert.equal(throwaway(path.join(wt(2), "src"), "term_X"), true);
    assert.equal(throwaway(wt(1), "term_K"), false);
    assert.equal(throwaway(app, undefined), false);
  } finally {
    if (prev === undefined) delete process.env.WORKTREE_CONSOLE_HOME;
    else process.env.WORKTREE_CONSOLE_HOME = prev;
  }
});

function tempWorktree(name) {
  const main = path.join(tmp, `main-${name}`);
  fs.mkdirSync(main);
  gitIn(main, "init", "-q", "-b", "main");
  gitIn(main, "commit", "-q", "--allow-empty", "-m", "init");
  const p = path.join(tmp, `ask-${name}`);
  gitIn(main, "worktree", "add", "-q", "-b", `ask-${name}`, p);
  const start = gitIn(p, "rev-parse", "HEAD").stdout.trim();
  return { kind: "worktree", path: fs.realpathSync(p), main, repo: "app", branch: `ask-${name}`, start, nickname: name, title: "問", at: Date.now(), seen: true };
}

const branches = (main) => gitIn(main, "branch", "--format=%(refname:short)").stdout.trim().split("\n");

function sweepIn(home, terminals, now) {
  const prev = process.env.WORKTREE_CONSOLE_HOME;
  process.env.WORKTREE_CONSOLE_HOME = home.WORKTREE_CONSOLE_HOME;
  try {
    return sweepDisposable(terminals, now, { source: "orca" });
  } finally {
    if (prev === undefined) delete process.env.WORKTREE_CONSOLE_HOME;
    else process.env.WORKTREE_CONSOLE_HOME = prev;
  }
}

const records = (home) => JSON.parse(fs.readFileSync(path.join(home.WORKTREE_CONSOLE_HOME, "disposable.json"), "utf8"));

test("watcher 清暫存 worktree：最後一個分頁關掉後乾淨的自動移除且不留 branch；有未 commit 改動或有 commit 不刪、只印一次「[<代號>] 未移除：…」", () => {
  const home = homes();
  const clean = tempWorktree("clean");
  const dirty = tempWorktree("dirty");
  const committed = tempWorktree("commit");
  const fresh = { ...tempWorktree("fresh"), seen: false };
  const open = tempWorktree("open");
  fs.writeFileSync(path.join(dirty.path, "a.txt"), "x\n");
  gitIn(committed.path, "commit", "-q", "--allow-empty", "-m", "work");
  putHome(home, "disposable.json", [clean, dirty, committed, fresh, open, { kind: "tab", paneKey: pane("gone"), handle: "term_gone", path: wt(1) }]);
  const terminals = [{ handle: "term_open", tabId: "tab-open", leafId: "leaf-open", worktreePath: open.path }];
  const lines = sweepIn(home, terminals, Date.now());
  assert.deepEqual(lines.sort(), ["[commit] 未移除：有 1 個 commit", "[dirty] 未移除：有未 commit 的改動"]);
  assert.ok(!fs.existsSync(clean.path), "乾淨的暫存 worktree 已移除");
  assert.ok(!branches(clean.main).includes("ask-clean"), "拋棄式 branch 一併刪除");
  assert.ok(fs.existsSync(dirty.path) && branches(committed.main).includes("ask-commit"), "有改動、有 commit 的不刪");
  assert.ok(fs.existsSync(fresh.path), "剛開、還沒看到分頁的不動");
  assert.ok(fs.existsSync(open.path), "還有分頁的不動");
  assert.deepEqual(records(home).map((r) => r.nickname ?? r.paneKey).sort(), ["commit", "dirty", "fresh", "open"], "關掉的臨時分頁紀錄一併清掉");
  assert.deepEqual(sweepIn(home, terminals, Date.now()), [], "同一個原因只印一次");
});

function closeRun(target, home) {
  const orca = path.join(tmp, "close-orca");
  fs.writeFileSync(orca, `#!/usr/bin/env node\nconst a = process.argv.slice(2).join(" ");\nconsole.log(JSON.stringify({ ok: true, result: a.startsWith("repo list") ? { repos: [] } : a.startsWith("terminal list") ? { terminals: [] } : { worktrees: [] } }));\n`);
  fs.chmodSync(orca, 0o755);
  return spawnSync(process.execPath, [path.join(scripts, "console.mjs"), "close", "--path", target], {
    encoding: "utf8",
    env: { ...process.env, ORCA_BIN: orca, ORCA_TERMINAL_HANDLE: "term_none", ...home },
  });
}

test("「關掉 <代號>」關暫存 worktree：移除 worktree 且不留 branch；有 commit 時 branch 保留並回報；有未 commit 改動照現有規則擋下", () => {
  const home = homes();
  const clean = tempWorktree("closeok");
  const committed = tempWorktree("closecm");
  const dirty = tempWorktree("closedt");
  gitIn(committed.path, "commit", "-q", "--allow-empty", "-m", "work");
  fs.writeFileSync(path.join(dirty.path, "a.txt"), "x\n");
  putHome(home, "disposable.json", [clean, committed, dirty]);
  const ok = closeRun(clean.path, home);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout.trim(), "[ask-closeok] 已關閉：暫存 worktree 已移除");
  assert.ok(!fs.existsSync(clean.path) && !branches(clean.main).includes("ask-closeok"));
  const kept = closeRun(committed.path, home);
  assert.equal(kept.stdout.trim(), "[ask-closecm] 已關閉：暫存 worktree 已移除，branch ask-closecm 保留（含 1 個 commit）");
  assert.ok(branches(committed.main).includes("ask-closecm"));
  const blocked = closeRun(dirty.path, home);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /未關閉：工作區有未 commit 的改動/);
  assert.ok(fs.existsSync(dirty.path) && branches(dirty.main).includes("ask-closedt"));
  assert.deepEqual(records(home).map((r) => r.nickname), ["closedt"]);
});
