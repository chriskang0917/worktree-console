import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { aligningRow } = await import("../skills/worktree-console/scripts/lib.mjs");
const consoleScript = path.join(root, "skills", "worktree-console", "scripts", "console.mjs");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

function tracked() {
  const res = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return res.stdout.split("\n").filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
}

function configDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wtc-claude-config-"));
}

function skill(dir) {
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: define-goal\n---\n");
  fs.writeFileSync(path.join(dir, "references", "orca-handoff.md"), "# handoff\n");
}

function installedPlugins(config, plugins) {
  fs.mkdirSync(path.join(config, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

function defineGoal(config) {
  const res = spawnSync(process.execPath, [consoleScript, "define-goal"], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
  return { code: res.status, out: res.stdout.trim() };
}

test("define-goal 沒裝：印「define-goal 未安裝」", () => {
  assert.deepEqual(defineGoal(configDir()), { code: 0, out: "define-goal 未安裝" });
});

test("define-goal 由某個 plugin 安裝：印那個 plugin 的斜線指令與它實際的安裝目錄", () => {
  const config = configDir();
  const install = path.join(config, "plugins", "cache", "someone", "agent-skills", "9.9.9");
  skill(path.join(install, "skills", "define-goal"));
  installedPlugins(config, {
    "other@market": [{ scope: "user", installPath: path.join(config, "plugins", "cache", "market", "other", "1.0.0") }],
    "agent-skills@someone": [{ scope: "user", installPath: install }],
  });
  const { code, out } = defineGoal(config);
  assert.equal(code, 0);
  assert.equal(out, `指令：/agent-skills:define-goal\n目錄：${path.join(install, "skills", "define-goal")}`);
  assert.ok(fs.existsSync(path.join(out.split("目錄：")[1], "references", "orca-handoff.md")), "orca-handoff.md 從實際安裝位置讀得到");
});

test("define-goal 只裝在某個專案的 plugin 不算；裝成使用者 skill 時指令是 /define-goal", () => {
  const config = configDir();
  const install = path.join(config, "plugins", "cache", "x", "agent-skills", "1.0.0");
  skill(path.join(install, "skills", "define-goal"));
  installedPlugins(config, { "agent-skills@x": [{ scope: "project", projectPath: "/somewhere", installPath: install }] });
  assert.equal(defineGoal(config).out, "define-goal 未安裝");
  skill(path.join(config, "skills", "define-goal"));
  assert.equal(defineGoal(config).out, `指令：/define-goal\n目錄：${path.join(config, "skills", "define-goal")}`);
});

test("沒裝 define-goal：對齊中的票最後動態是「等你確認開工」，不問要不要跑 define-goal", () => {
  assert.equal(aligningRow("PROJ-1", "x", "app", false).activity, "等你確認開工");
  assert.equal(aligningRow("PROJ-1", "x", "app", true).activity, "要不要先跑 define-goal？");
});

test("開工與交棒說明：先查 define-goal 有沒有裝、沒裝不提供跑它的選項、有裝從實際安裝位置讀 orca-handoff.md", () => {
  const kickoff = read("skills/worktree-console/references/kickoff.md");
  const handoff = read("skills/worktree-console/references/handoff.md");
  assert.match(kickoff, /`console\.mjs define-goal`/);
  assert.match(kickoff, /沒裝時整個流程都不提 define-goal/);
  assert.match(kickoff, /`<base>\/references\/branch-naming\.md`/);
  assert.doesNotMatch(kickoff, /`\/agent-skills:define-goal </);
  assert.match(handoff, /`<define-goal>\/references\/orca-handoff\.md`/);
  assert.ok(fs.existsSync(path.join(root, "skills", "worktree-console", "references", "branch-naming.md")));
});

test("repo 自給自足：沒有 import 或路徑指到 repo 外，也不用相對路徑找 define-goal", () => {
  const offenders = [];
  for (const file of tracked().filter((f) => /\.(mjs|tsx|md|json)$/.test(f) && !f.startsWith("test/fixtures/"))) {
    const text = read(file);
    if (text.includes(["<base>", "../"].join("/"))) offenders.push(`${file}: <base>/..`);
    for (const [, spec] of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.resolve(path.dirname(path.join(root, file)), spec);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) offenders.push(`${file}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("「agent-skills:」只出現在偵測 define-goal 的地方與 README", () => {
  const hits = [];
  for (const file of tracked().filter((f) => f !== "README.md" && !f.startsWith("test/fixtures/"))) {
    for (const line of read(file).split("\n")) if (line.includes("agent-skills:") && !line.includes("define-goal")) hits.push(`${file}: ${line.trim().slice(0, 80)}`);
  }
  assert.deepEqual(hits, []);
});

test("plugin 名稱是 worktree-console；marketplace 列出 worktree-console 與 focus-show", () => {
  assert.equal(json(".claude-plugin/plugin.json").name, "worktree-console");
  const market = json(".claude-plugin/marketplace.json");
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [["worktree-console", "."], ["focus-show", "./mods/focus-show"]]);
  assert.equal(json("mods/focus-show/.claude-plugin/plugin.json").name, "focus-show");
});

test("hooks.json 註冊專注橫條、自動交棒與過程紀錄，指到的檔案都在", () => {
  const hooks = json("hooks/hooks.json");
  assert.deepEqual(hooks.modules, ["./worktree-console-focus.tsx"]);
  const commands = Object.values(hooks.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  for (const want of ["auto-handoff.mjs\" session-start", "auto-handoff.mjs\" pre-tool-use", "auto-handoff.mjs\" stop", "console-log.mjs\" session-start", "console-log.mjs\" user-prompt"]) {
    assert.ok(commands.some((c) => c.includes(want)), want);
  }
  for (const c of commands) {
    const file = c.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/)[1];
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
  assert.ok(fs.existsSync(path.join(root, "hooks", "worktree-console-focus.tsx")));
});

test("資料路徑與鑰匙圈名稱照舊", () => {
  assert.match(read("skills/worktree-console/scripts/lib.mjs"), /path\.join\(os\.homedir\(\), "\.config", "worktree-console"\)/);
  assert.match(read("hooks/auto-handoff.mjs"), /path\.join\(os\.homedir\(\), "\.config", "claude-handoff"\)/);
  assert.match(read("skills/worktree-console/scripts/linear.mjs"), /SERVICE = "worktree-console-linear"/);
  assert.match(read("skills/worktree-console/scripts/memory.mjs") + read("skills/worktree-console/scripts/log.mjs"), /\.worktree-console/);
});

test("每個測試檔先載入 isolate-env，跑測試不會碰到真的 herdr 或 Orca", () => {
  const files = fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.mjs"));
  const missing = files.filter((f) => !read(`test/${f}`).startsWith('import "./fixtures/isolate-env.mjs";'));
  assert.deepEqual(missing, []);
});
