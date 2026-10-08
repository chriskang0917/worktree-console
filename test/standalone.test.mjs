import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { agentStatus, aligningRow, pendingItems } = await import("../skills/worktree-console/scripts/lib.mjs");
const consoleScript = path.join(root, "skills", "worktree-console", "scripts", "console.mjs");
const builtinPrompt = path.join(root, "skills", "worktree-console", "references", "prompt.md");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

function tracked() {
  const res = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return res.stdout.split("\n").filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
}

const consoleHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "wtc-home-"));

function cli(home, args, extra = {}) {
  const res = spawnSync(process.execPath, [consoleScript, ...args], { encoding: "utf8", env: { ...process.env, WORKTREE_CONSOLE_HOME: home, ...extra } });
  return { code: res.status, out: res.stdout.trim() };
}

test("中控台 prompt：沒有自訂檔時用內建的 references/prompt.md，內建版沒有需求訪談", () => {
  assert.deepEqual(cli(consoleHome(), ["prompt"]), { code: 0, out: `檔案：${builtinPrompt}\n來源：內建\n需求訪談：無` });
});

test("中控台 prompt：設定目錄有 prompt.md 時改用它，有〈需求訪談〉一段才算有", () => {
  const home = consoleHome();
  const custom = path.join(home, "prompt.md");
  fs.writeFileSync(custom, "# 我的中控台 prompt\n\n說明裡提到 ## 需求訪談 不算\n");
  assert.deepEqual(cli(home, ["prompt"]), { code: 0, out: `檔案：${custom}\n來源：自訂\n需求訪談：無` });
  fs.copyFileSync(path.join(root, "templates", "prompt.md"), custom);
  assert.deepEqual(cli(home, ["prompt"]), { code: 0, out: `檔案：${custom}\n來源：自訂\n需求訪談：有` });
});

test("主說明：啟動時一定要讀 console.mjs prompt 印的檔案", () => {
  const skill = read("skills/worktree-console/SKILL.md");
  const start = skill.slice(skill.indexOf("## 硬需求與啟動"), skill.indexOf("## 腳本一覽"));
  assert.match(start, /`console\.mjs prompt`/);
  assert.match(start, /每次啟動都要讀，不可略過/);
});

test("內建 prompt 只有〈中控台〉一段並說明怎麼自訂；範本多一段〈需求訪談〉，出題範例截得出 a、b 與建議", () => {
  const builtin = read("skills/worktree-console/references/prompt.md");
  assert.match(builtin, /^## 中控台$/m);
  assert.doesNotMatch(builtin, /^## 需求訪談$/m);
  assert.match(builtin, /~\/\.config\/worktree-console\/prompt\.md/);
  assert.match(builtin, /templates\/prompt\.md/);
  const template = read("templates/prompt.md");
  assert.match(template, /^## 中控台$/m);
  assert.match(template, /^## 需求訪談$/m);
  const sample = template.match(/```text\n([\s\S]*?)```/)[1].replace("<問題>", "放哪裡").replace("<字母>", "b").replace(/<[^>]+>/g, "說明");
  const session = { n: null, handle: "h", agent: { state: "done" }, status: agentStatus({ state: "done", lastAssistantMessage: sample }) };
  const [item] = pendingItems([{ repo: "app", label: "PROJ-1", ticket: "PROJ-1", branch: "proj-1", title: "x", stage: "規劃中", sessions: [session] }]);
  assert.deepEqual(item.choices, ["a", "b"]);
  assert.match(item.entries[0].suggest, /^b/);
});

test("看板對齊列：一律是「等你確認開工」", () => {
  assert.equal(aligningRow("PROJ-1", "x", "app").activity, "等你確認開工");
});

test("README 說明怎麼客製中控台 prompt 與需求訪談要守的格式", () => {
  const readme = read("README.md");
  const section = readme.slice(readme.indexOf("## Customizing the console prompt"), readme.indexOf("## Development"));
  for (const want of ["~/.config/worktree-console/prompt.md", "templates/prompt.md", "## 需求訪談", "## 中控台", "定稿完成：", ".goals/<slug>.md", "建議："]) assert.ok(section.includes(want), want);
});

test("開工與交棒說明：做不做需求訪談看中控台 prompt 有沒有那一段；/goal 規則寫在中控台自己的交棒說明", () => {
  const kickoff = read("skills/worktree-console/references/kickoff.md");
  const handoff = read("skills/worktree-console/references/handoff.md");
  assert.match(kickoff, /`console\.mjs prompt` 印的 `需求訪談：`/);
  assert.doesNotMatch(kickoff, /console\.mjs interview/);
  assert.match(kickoff, /先完整讀 <`console\.mjs prompt` 印的檔案絕對路徑>，照其中〈需求訪談〉一段做/);
  assert.match(handoff, /未展示者一律視為未完成。/);
  assert.match(handoff, /≤800 字元/);
});

test("不依賴任何 define-goal skill：說明與程式只在認舊標記時提到 define-goal", () => {
  const hits = [];
  for (const file of tracked().filter((f) => !f.startsWith("test/") && f !== "CHANGELOG.md")) {
    read(file).split("\n").forEach((line, i) => {
      if (/define-goal/i.test(line) && !/舊|rec\.defineGoal|define-goal\|interview/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("repo 自給自足：沒有 import 或路徑指到 repo 外", () => {
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

test("「agent-skills:」只出現在 README 與舊對話紀錄的測試資料", () => {
  const hits = [];
  for (const file of tracked().filter((f) => f !== "README.md" && !f.startsWith("test/"))) {
    for (const line of read(file).split("\n")) if (line.includes("agent-skills:")) hits.push(`${file}: ${line.trim().slice(0, 80)}`);
  }
  assert.deepEqual(hits, []);
});

test("plugin 名稱是 worktree-console；marketplace 列出 worktree-console、focus-show 與 task-list", () => {
  assert.equal(json(".claude-plugin/plugin.json").name, "worktree-console");
  const market = json(".claude-plugin/marketplace.json");
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [["worktree-console", "."], ["focus-show", "./mods/focus-show"], ["task-list", "./plugins/task-list"]]);
  assert.equal(json("mods/focus-show/.claude-plugin/plugin.json").name, "focus-show");
  assert.equal(json("plugins/task-list/.claude-plugin/plugin.json").name, "task-list");
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
