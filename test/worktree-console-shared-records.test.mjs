import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "../skills/worktree-console/scripts/lib.mjs";
import { KEEPALIVE_AFTER_MS, keepaliveStep } from "../skills/worktree-console/scripts/keepalive.mjs";
import { sweepDisposable } from "../skills/worktree-console/scripts/disposable.mjs";

// Orca and herdr consoles on one machine share ~/.config/worktree-console; neither may prune what only the other can see.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeOrca = path.join(root, "test", "fixtures", "worktree-console", "fake-orca.mjs");
const fakeHerdr = path.join(root, "test", "fixtures", "worktree-console", "fake-herdr.mjs");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MANAGED = /^(ORCA_|HERDR_|FAKE_|WORKTREE_CONSOLE_|AUTO_HANDOFF_|CLAUDE_)/;

let tmp;
let app;
let other;
let seq = 0;

const wt = (n) => path.join(tmp, "wt", `proj-${n}`);
const pane = (id) => `tab-${id}:leaf-${id}`;

const gitIn = (cwd, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function repo(dir) {
  fs.mkdirSync(dir);
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "commit", "-q", "--allow-empty", "-m", "init");
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtc-shared-")));
  app = path.join(tmp, "app");
  other = path.join(tmp, "other");
  repo(app);
  repo(other);
  for (const n of [1, 2]) gitIn(app, "worktree", "add", "-q", "-b", `proj-${n}`, wt(n), "main");
  fs.chmodSync(fakeOrca, 0o755);
  fs.chmodSync(fakeHerdr, 0o755);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function homes() {
  const dir = path.join(tmp, `h${++seq}`);
  const home = {
    WORKTREE_CONSOLE_HOME: path.join(dir, "console"),
    WORKTREE_CONSOLE_LOG_DIR: path.join(dir, "log"),
    AUTO_HANDOFF_HOME: path.join(dir, "handoff"),
    CLAUDE_PROJECTS_DIR: path.join(dir, "projects"),
  };
  fs.mkdirSync(home.WORKTREE_CONSOLE_HOME, { recursive: true });
  return home;
}

const put = (home, file, value) => fs.writeFileSync(path.join(home.WORKTREE_CONSOLE_HOME, file), JSON.stringify(value));
const get = (home, file) => JSON.parse(fs.readFileSync(path.join(home.WORKTREE_CONSOLE_HOME, file), "utf8"));

// Orca sees sessions A (proj-1) and B (proj-2), both stopped 55 minutes ago.
function orcaEnv(home, since) {
  const dir = path.join(tmp, `orca${++seq}`);
  fs.mkdirSync(dir);
  const w = (file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  const s = [
    { id: "A", n: 1 },
    { id: "B", n: 2 },
  ];
  w("repo-list.json", { ok: true, result: { repos: [{ id: "r1", path: app, displayName: "app" }] } });
  w("worktree-list.json", { ok: true, result: { worktrees: s.map(({ n }) => ({ path: wt(n), repoId: "r1", branch: `refs/heads/proj-${n}`, linkedLinearIssue: `PROJ-${n}`, displayName: `proj-${n}` })) } });
  w("terminal-list.json", { ok: true, result: { terminals: s.map(({ id, n }) => ({ handle: `term_${id}`, tabId: `tab-${id}`, leafId: `leaf-${id}`, worktreePath: wt(n), agentIdentity: "claude", createdAt: 1000 })) } });
  w("worktree-ps.json", {
    ok: true,
    result: {
      worktrees: s.map(({ id, n }) => ({
        path: wt(n),
        repoId: "r1",
        branch: `refs/heads/proj-${n}`,
        linkedLinearIssue: `PROJ-${n}`,
        agents: [{ paneKey: pane(id), state: "done", toolName: null, toolInput: null, stateStartedAt: since, prompt: "做事", lastAssistantMessage: "好了" }],
      })),
    },
  });
  return { ...home, ORCA_BIN: fakeOrca, FAKE_ORCA_DIR: dir, ORCA_TERMINAL_HANDLE: "term_self", CLAUDE_CODE_SESSION_ID: "" };
}

// herdr has only its console pane, in a repo of its own: none of Orca's worktrees or tabs are in its snapshot.
function herdrEnv(home) {
  const dir = path.join(tmp, `herdr${++seq}`);
  fs.mkdirSync(dir);
  const panes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: other, foreground_cwd: other }];
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ panes, agents: [], workspaces: [{ workspace_id: "w1" }] }));
  return { ...home, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", HERDR_BIN: fakeHerdr, FAKE_HERDR_DIR: dir, CLAUDE_CODE_SESSION_ID: "" };
}

function within(env, fn) {
  const keys = new Set([...Object.keys(process.env).filter((k) => MANAGED.test(k)), ...Object.keys(env)]);
  const prev = Object.fromEntries([...keys].map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const archiveRec = (n, id, extra = {}) => ({ path: wt(n), paneKey: pane(id), tag: `PROJ-${n}`, at: 0, kind: "done", since: null, ...extra });

function tempWorktree(name, extra = {}) {
  const main = path.join(tmp, `main-${name}`);
  repo(main);
  const p = path.join(tmp, `ask-${name}`);
  gitIn(main, "worktree", "add", "-q", "-b", `ask-${name}`, p);
  const start = gitIn(p, "rev-parse", "HEAD").stdout.trim();
  return { kind: "worktree", path: fs.realpathSync(p), main, repo: "app", branch: `ask-${name}`, start, nickname: name, title: "問", at: 0, seen: true, ...extra };
}

const herdrTabs = [{ handle: "w1:p1", tabId: "w1:t1", leafId: "p1", worktreePath: other }];

test("封存：herdr 中控台看不到 Orca 的 worktree 時不刪 Orca 的封存紀錄；回到 Orca 那個 session 仍是封存，停滿 50 分鐘也不續命", () => {
  const home = homes();
  const now = Date.now();
  const since = now - KEEPALIVE_AFTER_MS - 5 * MIN;
  const rec = archiveRec(1, "A", { source: "orca", since });
  put(home, "archive.json", [rec]);

  const herdrRows = within(herdrEnv(home), () => collect(null, { withStage: false }).rows);
  assert.ok(!herdrRows.some((r) => r.path === wt(1)), "herdr 的快照裡確實沒有那個 worktree");
  assert.deepEqual(get(home, "archive.json"), [rec], "archive.json 那筆仍在");

  const rows = within(orcaEnv(home, since), () => collect(null, { withStage: false }).rows);
  const sessions = rows.flatMap((r) => r.sessions);
  assert.equal(sessions.find((s) => s.paneKey === pane("A")).archived, true, "Orca 那邊仍是封存");
  const { actions } = keepaliveStep(rows, {}, now, { contextOf: () => 1000 });
  assert.deepEqual(actions.map((a) => a.session.paneKey), [pane("B")], "只續命沒封存的 B，封存的 A 不送");
});

test("封存（原本行為）：worktree 真的不見了，自己那邊的中控台照舊刪掉封存紀錄；另一邊的紀錄不動", () => {
  const home = homes();
  const gone = path.join(tmp, "wt", "removed");
  const orcaGone = { path: gone, paneKey: pane("X"), tag: "PROJ-9", at: 0, kind: "done", since: null, source: "orca" };
  const herdrGone = { ...orcaGone, paneKey: "w1:p9", source: "herdr" };
  put(home, "archive.json", [orcaGone, herdrGone]);
  within(herdrEnv(home), () => collect(null, { withStage: false }));
  assert.deepEqual(get(home, "archive.json"), [orcaGone], "herdr 只刪自己的");
  put(home, "archive.json", [orcaGone, herdrGone]);
  within(orcaEnv(home, Date.now()), () => collect(null, { withStage: false }));
  assert.deepEqual(get(home, "archive.json"), [herdrGone], "Orca 只刪自己的");
});

test("暫存 worktree：herdr 的 watcher 看不到 Orca 的分頁，不移除 Orca 建的暫存 worktree、紀錄仍在", () => {
  const home = homes();
  const temp = tempWorktree("orcaonly", { source: "orca" });
  const tab = { kind: "tab", source: "orca", paneKey: pane("T"), handle: "term_T", path: wt(1), title: "臨時", at: 0 };
  put(home, "disposable.json", [temp, tab]);
  const lines = within({ WORKTREE_CONSOLE_HOME: home.WORKTREE_CONSOLE_HOME }, () => sweepDisposable(herdrTabs, Date.now(), { source: "herdr" }));
  assert.deepEqual(lines, []);
  assert.ok(fs.existsSync(temp.path), "worktree 沒被移除");
  assert.deepEqual(get(home, "disposable.json"), [temp, tab], "紀錄都還在");
});

test("暫存 worktree：watcher 依所在環境判斷自己是 herdr，不動 Orca 建的", () => {
  const home = homes();
  const temp = tempWorktree("byenv", { source: "orca" });
  put(home, "disposable.json", [temp]);
  within(herdrEnv(home), () => sweepDisposable(herdrTabs, Date.now()));
  assert.ok(fs.existsSync(temp.path));
  assert.deepEqual(get(home, "disposable.json"), [temp]);
});

test("暫存 worktree（原本行為）：自己那邊的分頁關了，照常移除乾淨的暫存 worktree、清掉關掉的臨時分頁紀錄", () => {
  const home = homes();
  const herdrTemp = tempWorktree("herdrown", { source: "herdr" });
  const orcaTemp = tempWorktree("orcaown", { source: "orca" });
  const herdrTab = { kind: "tab", source: "herdr", paneKey: "w1:p7", handle: "w1:p7", path: wt(1), title: "臨時", at: 0 };
  put(home, "disposable.json", [herdrTemp, orcaTemp, herdrTab]);
  within({ WORKTREE_CONSOLE_HOME: home.WORKTREE_CONSOLE_HOME }, () => sweepDisposable(herdrTabs, Date.now(), { source: "herdr" }));
  assert.ok(!fs.existsSync(herdrTemp.path), "herdr 自己的暫存 worktree 已移除");
  assert.deepEqual(get(home, "disposable.json"), [orcaTemp], "herdr 自己的臨時分頁紀錄也清掉，Orca 的留著");
  within({ WORKTREE_CONSOLE_HOME: home.WORKTREE_CONSOLE_HOME }, () => sweepDisposable([], Date.now(), { source: "orca" }));
  assert.ok(!fs.existsSync(orcaTemp.path), "回到 Orca，Orca 的照常移除");
  assert.deepEqual(get(home, "disposable.json"), []);
});

test("tasks.json：herdr 的 watcher 不剪 Orca 分頁的任務標題；各自那邊的分頁關了超過一天照常剪", () => {
  const home = homes();
  const now = Date.now();
  const tasks = {
    [pane("A")]: { title: "Orca 的任務", handle: "term_A", source: "orca", at: now - 2 * DAY },
    "w1:p8": { title: "herdr 的任務", handle: "w1:p8", source: "herdr", at: now - 2 * DAY },
  };
  put(home, "tasks.json", tasks);
  put(home, "disposable.json", []);
  within({ WORKTREE_CONSOLE_HOME: home.WORKTREE_CONSOLE_HOME }, () => sweepDisposable(herdrTabs, now, { source: "herdr" }));
  assert.deepEqual(Object.keys(get(home, "tasks.json")), [pane("A")], "herdr 只剪自己關掉的，Orca 分頁那筆還在");
  within({ WORKTREE_CONSOLE_HOME: home.WORKTREE_CONSOLE_HOME }, () => sweepDisposable([], now, { source: "orca" }));
  assert.deepEqual(get(home, "tasks.json"), {}, "Orca 照常剪自己關掉的");
});

test("沒標來源舊紀錄：封存、暫存 worktree、tasks.json 一律當成 Orca 建的", () => {
  const home = homes();
  const now = Date.now();
  const legacyArchive = archiveRec(1, "A");
  const legacyGone = { path: path.join(tmp, "wt", "legacy-gone"), paneKey: pane("L"), tag: "PROJ-8", at: 0, kind: "done", since: null };
  const legacyTemp = tempWorktree("legacy");
  const legacyTask = { title: "舊任務", handle: "term_A", at: now - 2 * DAY };
  put(home, "archive.json", [legacyArchive, legacyGone]);
  put(home, "disposable.json", [legacyTemp]);
  put(home, "tasks.json", { [pane("A")]: legacyTask });

  within(herdrEnv(home), () => {
    collect(null, { withStage: false });
    sweepDisposable(herdrTabs, now);
  });
  assert.deepEqual(get(home, "archive.json"), [legacyArchive, legacyGone], "herdr 不刪沒標來源的封存");
  assert.ok(fs.existsSync(legacyTemp.path), "herdr 不移除沒標來源的暫存 worktree");
  assert.deepEqual(get(home, "disposable.json"), [legacyTemp]);
  assert.deepEqual(get(home, "tasks.json"), { [pane("A")]: legacyTask }, "herdr 不剪沒標來源的任務標題");

  const rows = within(orcaEnv(home, now), () => {
    const data = collect(null, { withStage: false });
    sweepDisposable(data.terminals, now);
    return data.rows;
  });
  assert.equal(rows.flatMap((r) => r.sessions).find((s) => s.paneKey === pane("A")).archived, true, "Orca 認得舊封存");
  assert.deepEqual(get(home, "archive.json"), [legacyArchive], "Orca 照舊刪掉 worktree 已不見的舊封存");
  assert.ok(!fs.existsSync(legacyTemp.path), "Orca 照舊移除分頁已關的舊暫存 worktree");
  assert.deepEqual(get(home, "disposable.json"), []);
  assert.deepEqual(Object.keys(get(home, "tasks.json")), [pane("A")], "Orca 分頁還開著，舊任務標題留著");
});

test("封存：寫入封存紀錄時標上所在的終端管理工具", () => {
  const home = homes();
  const env = orcaEnv(home, Date.now());
  const res = spawnSync(process.execPath, [path.join(root, "skills", "worktree-console", "scripts", "console.mjs"), "archive", "--repo", app, "PROJ-1"], {
    encoding: "utf8",
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !MANAGED.test(k))), ...env },
  });
  assert.equal(res.stdout.trim(), "[PROJ-1] 已封存", res.stderr);
  assert.deepEqual(get(home, "archive.json").map((a) => [a.paneKey, a.source]), [[pane("A"), "orca"]]);
});
