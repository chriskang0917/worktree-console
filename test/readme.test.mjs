import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const at = (needle) => {
  const i = typeof needle === "string" ? readme.indexOf(needle) : readme.search(needle);
  assert.ok(i >= 0, `README 缺少 ${needle}`);
  return i;
};

test("README：開頭先標明 skill 與輸出是繁體中文，再接置中標題與連結列、tagline、功能條列、install、usage、development", () => {
  const order = [
    at(/Traditional Chinese/),
    at('<h1 align="center">worktree-console</h1>'),
    at(/<p align="center">\s*<a href=/),
    at(/<p align="center"><b>[^<]+<\/b><\/p>/),
    at(/^- \*\*/m),
    at(/^## Install$/m),
    at(/^## Usage$/m),
    at(/^## Development$/m),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const firstParagraph = readme.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith(">") && !p.trim().startsWith("<"));
  assert.ok(at(/Traditional Chinese/) < readme.indexOf(firstParagraph), "語言說明在第一段之前");
});

test("README：功能條列每條粗體開頭，講整個產品，專注模式獨立一條並寫出需要 Claude Code mods", () => {
  const bullets = readme.slice(at(/^- \*\*/m), at(/^## Install$/m)).split("\n").filter((l) => l.startsWith("- "));
  assert.ok(bullets.length >= 5);
  for (const b of bullets) assert.match(b, /^- \*\*[^*]+\*\*/);
  const focus = bullets.filter((b) => /^- \*\*Focus mode/.test(b));
  assert.equal(focus.length, 1);
  assert.match(focus[0], /Claude Code build with mods/);
  for (const topic of [/ticket/i, /report/i, /board/i, /handoff/i]) assert.ok(bullets.some((b) => topic.test(b)), String(topic));
});

test("README：install 寫出硬需求 Orca 或 herdr 與 node，以及安裝兩個 plugin 的指令", () => {
  const install = readme.slice(at(/^## Install$/m), at(/^## Usage$/m));
  assert.match(install, /Orca/);
  assert.match(install, /herdr/);
  assert.match(install, /Node\.js/);
  assert.match(install, /\/plugin install worktree-console@worktree-console/);
  assert.match(install, /\/plugin install focus-show@worktree-console/);
});
