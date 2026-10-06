import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "../skills/worktree-console/scripts/lib.mjs";
import { emptyFocus, focusPayload, focusReplied, focusStep, markReported, syncFocus } from "../skills/worktree-console/scripts/focus.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills", "worktree-console", "scripts");
const fakeOrca = path.join(root, "test", "fixtures", "worktree-console", "fake-orca.mjs");
const LONG = "feat/backend-api-request-comment";

// Worktrees by id: repo, branch, linked ticket and Orca display name (the branch when none).
const TREES = {
  backend: { repo: "app", branch: LONG },
  alpha: { repo: "app", branch: "proj-1-alpha", ticket: "PROJ-1" },
  beta: { repo: "app", branch: "proj-1-beta", ticket: "PROJ-1" },
  apptwo: { repo: "app", branch: "proj-2-web", ticket: "PROJ-2" },
  review: { repo: "app", branch: "chore/rev-stuff", name: "review" },
  cleanup: { repo: "app", branch: "chore/tidy-up", name: "cleanups" },
  apitwo: { repo: "api", branch: "proj-2-api", ticket: "PROJ-2" },
  apireview: { repo: "api", branch: "chore/api-rev", name: "review" },
  spike: { repo: "api", branch: "chore/try-it", name: "spike" },
  other: { repo: "api", branch: "fix/other-thing" },
};

let tmp;
let seq = 0;
const gitIn = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const main = (repo) => path.join(tmp, repo);
const wt = (id) => path.join(tmp, "wt", id);
const pane = (id) => `tab-${id}:leaf-${id}`;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-nick-")));
  for (const repo of ["app", "api"]) {
    fs.mkdirSync(main(repo));
    gitIn(main(repo), "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(main(repo), "a.txt"), "a\n");
    gitIn(main(repo), "add", ".");
    gitIn(main(repo), "commit", "-qm", "init");
  }
  for (const [id, t] of Object.entries(TREES)) gitIn(main(t.repo), "worktree", "add", "-q", "-b", t.branch, wt(id), "main");
  fs.chmodSync(fakeOrca, 0o755);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fake Orca world where every worktree has one stopped claude session.
function world() {
  const dir = path.join(tmp, `w${++seq}`);
  fs.mkdirSync(dir);
  const put = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  const ids = Object.keys(TREES);
  const repoId = (repo) => (repo === "app" ? "r1" : "r2");
  const tree = (id) => ({ path: wt(id), repoId: repoId(TREES[id].repo), branch: `refs/heads/${TREES[id].branch}`, linkedLinearIssue: TREES[id].ticket ?? null, displayName: TREES[id].name ?? TREES[id].branch });
  put("repo-list.json", { ok: true, result: { repos: [{ id: "r1", path: main("app"), displayName: "app" }, { id: "r2", path: main("api"), displayName: "api" }] } });
  put("worktree-list.json", { ok: true, result: { worktrees: ids.map(tree) } });
  put("terminal-list.json", { ok: true, result: { terminals: ids.map((id, i) => ({ handle: `term_${id}`, tabId: `tab-${id}`, leafId: `leaf-${id}`, worktreePath: wt(id), agentIdentity: "claude", createdAt: 1000 + i })) } });
  const agent = (id) => ({ paneKey: pane(id), state: "done", toolName: null, toolInput: null, stateStartedAt: 1_790_000_000_000, prompt: `做 ${id}`, lastAssistantMessage: `${id} 做好了，要繼續嗎？` });
  put("worktree-ps.json", { ok: true, result: { worktrees: ids.map((id) => ({ ...tree(id), agents: [agent(id)] })) } });
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

function envFor(dir, home) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORCA_|WATCH_|WORKTREE_CONSOLE_|AUTO_HANDOFF_|CLAUDE_|HERDR_)/.test(k))),
    ORCA_BIN: fakeOrca,
    FAKE_ORCA_DIR: dir,
    ORCA_TERMINAL_HANDLE: "term_self",
    CLAUDE_CODE_SESSION_ID: "",
    WATCH_INTERVAL_MS: "20",
    WATCH_TIMEOUT_MS: "400",
    WATCH_PGREP_PATTERN: `${tmp}/never/watch\\.mjs`,
    ...home,
  };
}

function run(dir, home, script, args) {
  const res = spawnSync(process.execPath, [path.join(scripts, script), ...args], { cwd: os.tmpdir(), encoding: "utf8", env: envFor(dir, home) });
  return { code: res.status, out: res.stdout.trim(), lines: res.stdout.trim().split("\n") };
}

const consoleRun = (dir, home, ...args) => run(dir, home, "console.mjs", args);
const board = (dir, home) => consoleRun(dir, home, "board", "--repo", main("app"));
const tags = (out) => out.split("\n").filter((l) => /^\| (💬|🔐|⏸|🔄|💤)/.test(l)).map((l) => l.split(" | ")[1]);
const resolve = (dir, home, q) => JSON.parse(consoleRun(dir, home, "resolve", "--repo", main("app"), q).out);

function inWorld(dir, home, fn) {
  const env = envFor(dir, home);
  const prev = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(ORCA_|WATCH_|WORKTREE_CONSOLE_|AUTO_HANDOFF_|CLAUDE_|HERDR_|FAKE_)/.test(k)) delete process.env[k];
  Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([k]) => /^(ORCA_|WATCH_|WORKTREE_CONSOLE_|AUTO_HANDOFF_|CLAUDE_|FAKE_)/.test(k))));
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
}

// The focus pane's card 代號 and what the band hands /focus-show, as the mod gets them from `console.mjs focus`.
function cardTags(dir, home) {
  return inWorld(dir, home, () => {
    const data = collect(null, { withStage: false });
    const view = syncFocus(data.rows);
    const { payload } = focusPayload(data.rows, view, { keys: data.keys, announce: view.current?.item.tag ?? null, announceKey: view.current?.key ?? null });
    return { tags: payload.sessions.map((s) => s.tag), announce: payload.announce, reports: payload.sessions.map((s) => s.report.split("\n")[0]) };
  });
}

test("暱稱：沒票也沒暱稱的 worktree 取名前代號是拿掉類型前綴截到 8 格加「…」的 branch（backend…），中控台輸出「待取暱稱」；存好暱稱後卡片、看板、watcher 回報、/focus-show 都改用暱稱並一直沿用", () => {
  const dir = world();
  const home = homes();
  const before = board(dir, home);
  assert.ok(tags(before.out).includes("backend…"), before.out);
  assert.ok(tags(before.out).includes("other-th…"), before.out);
  const wanted = before.lines.find((l) => l.startsWith("待取暱稱："));
  assert.deepEqual(wanted?.replace("待取暱稱：", "").split("、").sort(), [`${LONG}（app）`, "fix/other-thing（api）", "proj-1-alpha（app）", "proj-1-beta（app）"]);
  assert.ok(cardTags(dir, home).tags.includes("backend…"));

  const saved = consoleRun(dir, home, "nickname", "--repo", main("app"), LONG, "cmnt");
  assert.deepEqual([saved.code, saved.out], [0, `[cmnt] 已存暱稱：${LONG}（app）`]);
  const stored = JSON.parse(fs.readFileSync(path.join(home.WORKTREE_CONSOLE_HOME, "nicknames.json"), "utf8"));
  assert.deepEqual(stored[wt("backend")], { ...stored[wt("backend")], nickname: "cmnt", branch: LONG, repo: "app" });

  for (let i = 0; i < 2; i++) {
    const after = board(dir, home);
    assert.ok(tags(after.out).includes("cmnt") && !tags(after.out).includes("backend…"), after.out);
    assert.ok(!after.out.includes(`待取暱稱：${LONG}`), "取好名就不再要求");
  }
  const cards = cardTags(dir, home);
  assert.ok(cards.tags.includes("cmnt") && !cards.tags.some((t) => t.startsWith("backend")), cards.tags.join(","));
  assert.ok(cards.reports.includes("### 💬 cmnt 等你回應"), `/focus-show 印的報告標題用暱稱：${cards.reports.join(" | ")}`);
  const baseline = Object.keys(TREES).map((id) => `${pane(id)}=busy`).join(",");
  const watched = run(dir, home, "watch.mjs", ["--baseline", baseline]);
  assert.ok(watched.lines.includes("### 💬 cmnt 等你回應"), watched.out);
  assert.ok(!watched.out.includes("backend…"), watched.out);
});

test("暱稱：存檔時跨所有 repo 檢查不重複、撞名就拒絕，存下的暱稱不加 repo 前綴；同票同 repo 多個 worktree 顯示 <票號>(<暱稱>)；只有同一票號或同一 Orca 暱稱出現在多個 repo 才保留 repo 前綴", () => {
  const dir = world();
  const home = homes();
  const first = tags(board(dir, home).out);
  assert.ok(first.includes("PROJ-1(alpha)") && first.includes("PROJ-1(beta)"), first.join(","));
  assert.equal(consoleRun(dir, home, "nickname", "--repo", main("app"), LONG, "cmnt").code, 0);
  const taken = consoleRun(dir, home, "nickname", "--repo", main("app"), "fix/other-thing", "cmnt");
  assert.deepEqual([taken.code, taken.out], [1, "[cmnt] 暱稱已被使用，請換一個"], "另一個 repo 已存的暱稱");
  const orca = consoleRun(dir, home, "nickname", "--repo", main("app"), "fix/other-thing", "spike");
  assert.deepEqual([orca.code, orca.out], [1, "[spike] 暱稱已被使用，請換一個"], "Orca 已有的暱稱");
  assert.equal(consoleRun(dir, home, "nickname", "--repo", main("app"), "fix/other-thing", "othr").code, 0);
  assert.equal(consoleRun(dir, home, "nickname", "--repo", main("app"), "proj-1-alpha", "alfa").code, 0);
  assert.equal(consoleRun(dir, home, "nickname", "--repo", main("app"), "proj-1-beta", "alfa").code, 1, "括號裡的暱稱也照同一套查重");
  assert.equal(consoleRun(dir, home, "nickname", "--repo", main("app"), "proj-1-beta", "beto").code, 0);
  const after = tags(board(dir, home).out);
  for (const t of ["cmnt", "othr", "PROJ-1(alfa)", "PROJ-1(beto)", "app/PROJ-2", "api/PROJ-2", "app/review", "api/review", "spike", "cleanups"]) assert.ok(after.includes(t), `${t} 不在 ${after.join(",")}`);
  assert.ok(!after.some((t) => /^(app|api)\/(cmnt|othr|PROJ-1)/.test(t)), after.join(","));
});

test("暱稱：指揮時打暱稱或完整 branch 名稱都對到同一個 session，取名前打截短代號也一樣", () => {
  const dir = world();
  const home = homes();
  const one = (q) => {
    const r = resolve(dir, home, q);
    assert.equal(r.match, "one", `${q}: ${JSON.stringify(r)}`);
    return r.rows[0].handle;
  };
  assert.equal(one(LONG), "term_backend");
  assert.equal(one("backend…"), "term_backend");
  assert.equal(one("fix/other-thing"), "term_other");
  consoleRun(dir, home, "nickname", "--repo", main("app"), LONG, "cmnt");
  consoleRun(dir, home, "nickname", "--repo", main("app"), "proj-1-alpha", "alfa");
  assert.equal(one("cmnt"), "term_backend");
  assert.equal(one(LONG), "term_backend");
  assert.equal(one("alfa"), "term_alpha");
  assert.equal(one("PROJ-1(alfa)"), "term_alpha");
  assert.equal(one("proj-1-alpha"), "term_alpha");
  assert.equal(resolve(dir, home, "cmnt").rows[0].tag, "cmnt");
});

test("暱稱：console.mjs ask --nickname 與 nickname 只接受 3～5 個英文小寫字母，6 個字母以上報錯；已存在的 3～8 個字母 Orca／herdr 暱稱照原樣顯示", () => {
  const dir = world();
  const home = homes();
  const ask = (nick) => consoleRun(dir, home, "ask", "--repo", main("app"), "--target", "app", "--nickname", nick, "--title", "問問題", "--", "這段怎麼運作？");
  for (const nick of ["abcdef", "abcdefgh", "ab", "Abc", "ab1"]) assert.deepEqual([ask(nick).code, ask(nick).out], [1, `[${nick}] 暱稱要 3～5 個英文小寫字母`], nick);
  for (const nick of ["abc", "abcde"]) assert.ok(!ask(nick).out.includes("暱稱要"), `${nick}: ${ask(nick).out}`);
  const long = consoleRun(dir, home, "nickname", "--repo", main("app"), LONG, "comment");
  assert.deepEqual([long.code, long.out], [1, "[comment] 暱稱要 3～5 個英文小寫字母"]);
  const t = tags(board(dir, home).out);
  assert.ok(t.includes("cleanups") && t.includes("spike"), t.join(","));
});

test("漏印重送：回完答案後 60 秒內同一 session 又出題，中控台每輪都 announce 新題直到 focus-shown；after-send 也不會把它算成已回覆或已印", () => {
  const entry = (key, paneKey, since) => ({ key, paneKey, handle: `h-${paneKey}`, tag: paneKey, kind: "done", since, item: {} });
  const t0 = 1_791_256_000_000;
  const asked = entry(`w9:p1@${t0}`, "w9:p1", t0);
  const other = entry(`w7:p2@${t0 - 5_000}`, "w7:p2", t0 - 5_000);
  const announced = (view) => (view.current && !view.state.reported.includes(view.current.key) ? view.current.key : null);
  let view = focusStep(emptyFocus(), [asked, other], t0);
  view = { ...view, state: markReported(view.state, asked.key) };
  const sentAt = t0 + 60_000;
  view = focusStep(focusReplied(view.state, [asked, other], [{ paneKey: "w9:p1", handle: "h-w9:p1", tag: "w9:p1", at: sentAt }], sentAt), [other], sentAt);
  assert.deepEqual([view.current, view.wait?.tag], [null, "w9:p1"]);
  const again = entry(`w9:p1@${sentAt + 15_000}`, "w9:p1", sentAt + 15_000);
  view = focusStep(view.state, [other, again], sentAt + 16_000);
  assert.equal(announced(view), again.key, "同 session 15 秒後又問：直接上橫條並 announce");
  view = focusStep(view.state, [other, again], sentAt + 21_000);
  assert.equal(announced(view), again.key, "沒收到 focus-shown 就每輪再 announce");
  view = focusStep(focusReplied(view.state, [other, again], [{ paneKey: "w9:p1", handle: "h-w9:p1", tag: "w9:p1" }], sentAt + 25_000), [other, again], sentAt + 25_000);
  assert.deepEqual([view.current?.key, announced(view), view.state.answered.includes(again.key), view.state.reported.includes(again.key)], [again.key, again.key, false, false], "after-send 晚到也不吃掉新題");
  view = { ...view, state: markReported(view.state, again.key) };
  assert.equal(announced(focusStep(view.state, [other, again], sentAt + 30_000)), null, "focus-shown 之後才算印過");
});
