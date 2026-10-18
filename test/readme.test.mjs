import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const readme = read("README.en.md");
const at = (needle) => {
  const i = typeof needle === "string" ? readme.indexOf(needle) : readme.search(needle);
  assert.ok(i >= 0, `README 缺少 ${needle}`);
  return i;
};

test("README.en.md：開頭先標明 skill 與輸出是繁體中文，再接置中標題與連結列、tagline、功能條列、install、usage、development", () => {
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
  const firstParagraph = readme.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith(">") && !p.trim().startsWith("<") && p.trim() !== LINKS);
  assert.ok(at(/Traditional Chinese/) < readme.indexOf(firstParagraph), "語言說明在第一段之前");
});

test("README.en.md：功能條列每條粗體開頭，講整個產品，專注模式獨立一條並寫出需要 Claude Code mods", () => {
  const bullets = readme.slice(at(/^- \*\*/m), at(/^## Install$/m)).split("\n").filter((l) => l.startsWith("- "));
  assert.ok(bullets.length >= 5);
  for (const b of bullets) assert.match(b, /^- \*\*[^*]+\*\*/);
  const focus = bullets.filter((b) => /^- \*\*Focus mode/.test(b));
  assert.equal(focus.length, 1);
  assert.match(focus[0], /Claude Code build with mods/);
  for (const topic of [/ticket/i, /report/i, /board/i, /handoff/i]) assert.ok(bullets.some((b) => topic.test(b)), String(topic));
});

test("README.en.md：install 寫出硬需求 Orca 或 herdr 與 node，以及安裝兩個 plugin 的指令", () => {
  const install = readme.slice(at(/^## Install$/m), at(/^## Usage$/m));
  assert.match(install, /Orca/);
  assert.match(install, /herdr/);
  assert.match(install, /Node\.js/);
  assert.match(install, /\/plugin install worktree-console@worktree-console/);
  assert.match(install, /\/plugin install focus-show@worktree-console/);
});

const PAIRS = [["README.md", "README.en.md"], ["plugins/task-list/README.md", "plugins/task-list/README.en.md"]];
const LINKS = "[English](./README.en.md)｜[中文](./README.md)";
const headings = (text) => text.replace(/```[\s\S]*?```/g, "").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => l.match(/^#+/)[0].length);

for (const [zh, en] of PAIRS) {
  test(`${zh} 是中文、${en} 是英文，開頭都是「English｜中文」互連，章節一一對應`, () => {
    const [zhText, enText] = [read(zh), read(en)];
    assert.equal(zhText.split("\n")[0], LINKS);
    assert.equal(enText.split("\n")[0], LINKS);
    assert.deepEqual(headings(zhText), headings(enText));
    const han = (text) => (text.replace(/```[\s\S]*?```/g, "").match(/[\u4e00-\u9fff]/g) ?? []).length;
    const latin = (text) => (text.replace(/```[\s\S]*?```/g, "").match(/\b[A-Za-z]{3,}\b/g) ?? []).length;
    assert.ok(han(zhText) > latin(zhText), `${zh} 應以中文為主`);
    assert.ok(latin(enText) > han(enText) * 2, `${en} 應以英文為主`);
  });
}

test("repo 內 markdown 的相對連結與錨點都指得到", () => {
  const broken = [];
  const anchor = (title) => title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  const files = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter((f) => f && !f.startsWith("test/") && fs.existsSync(path.join(root, f)));
  for (const file of files) {
    const text = read(file).replace(/```[\s\S]*?```/g, "");
    for (const [, target] of text.matchAll(/(?:\]\(|href=")([^)"\s]+)[)"]/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [rel, hash] = target.split("#");
      const dest = rel ? path.join(path.dirname(path.join(root, file)), decodeURIComponent(rel)) : path.join(root, file);
      if (!fs.existsSync(dest)) broken.push(`${file}: ${target}`);
      else if (hash && dest.endsWith(".md") && !headingAnchors(read(path.relative(root, dest)), anchor).has(decodeURIComponent(hash))) broken.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

function headingAnchors(text, anchor) {
  return new Set(text.replace(/```[\s\S]*?```/g, "").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => anchor(l.replace(/^#+ /, ""))));
}
