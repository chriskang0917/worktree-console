import "./fixtures/isolate-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const versionOf = (text) => JSON.parse(text).version;

// Each independently installed plugin needs a new version for its changes to reach existing users.
for (const dir of ["mods/focus-show", "mods/tool-dots", "plugins/task-list"]) test(`${dir} 自上次升版後有改動，就要升它自己的版號`, (t) => {
  const manifest = `${dir}/.claude-plugin/plugin.json`;
  const bumped = git("log", "-1", "--format=%H", "-G", '"version"', "--", manifest).stdout.trim();
  if (!bumped) return t.skip("沒有 git 歷史可比對");
  const changed = git("diff", "--name-only", bumped, "--", dir, `:!${manifest}`).stdout.trim();
  if (!changed) return;
  const then = versionOf(git("show", `${bumped}:${manifest}`).stdout);
  const now = versionOf(fs.readFileSync(path.join(root, manifest), "utf8"));
  assert.notEqual(
    now,
    then,
    `${dir} 自 ${bumped.slice(0, 7)}（版號 ${then}）之後改了這些檔案，但版號沒升：\n${changed}\n請升 ${manifest} 的 version`,
  );
});
