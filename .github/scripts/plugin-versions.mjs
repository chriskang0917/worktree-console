#!/usr/bin/env node
// Bumps every plugin a pull request touches, always counting from the version on main, so reruns land on the same number.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export const PLUGINS = [
  { name: "focus-show", dir: "mods/focus-show", heading: (v) => `## focus-show ${v}` },
  { name: "tool-dots", dir: "mods/tool-dots", heading: (v) => `## tool-dots ${v}` },
  { name: "task-list", dir: "plugins/task-list", heading: (v) => `## task-list ${v}` },
  { name: "worktree-console", dir: ".", heading: (v) => `## ${v}` },
];
const CHANGELOG = "CHANGELOG.md";
const NOT_SHIPPED = /^(\.github\/|CHANGELOG\.md$|AGENTS\.md$|CLAUDE\.md$|package\.json$|\.gitignore$)|(^|\/)test\//;
const manifestOf = (p) => path.join(p.dir, ".claude-plugin", "plugin.json").replace(/^\.\//, "");
const VERSION = "(\\d+\\.\\d+\\.\\d+)";

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: res.status === 0, out: (res.stdout ?? "").trim() };
}

export function level(title) {
  if (/^\w+(\([^)]*\))?!:/.test(title)) return "major";
  return /^feat(\(|:)/.test(title) ? "minor" : "patch";
}

export function bump(version, how) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function pluginOf(file) {
  if (NOT_SHIPPED.test(file) || PLUGINS.some((p) => file === manifestOf(p))) return null;
  return PLUGINS.find((p) => p.dir === "." || file.startsWith(`${p.dir}/`)).name;
}

const headingRe = (p) => new RegExp(`^${p.heading("0.0.0").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("0\\.0\\.0", VERSION)}$`);

// Sections this PR added to the changelog: headings that were not there where it branched off main.
function plan(cwd, base, title) {
  const fork = git(cwd, ["merge-base", base, "HEAD"]).out;
  const files = git(cwd, ["diff", "--name-only", `${fork}`, "HEAD"]).out.split("\n").filter(Boolean);
  const touched = new Set(files.map(pluginOf).filter(Boolean));
  const how = level(title);
  return PLUGINS.filter((p) => touched.has(p.name)).map((p) => {
    const onMain = git(cwd, ["show", `${base}:${manifestOf(p)}`]);
    const mainVersion = onMain.ok ? JSON.parse(onMain.out).version : JSON.parse(fs.readFileSync(path.join(cwd, manifestOf(p)), "utf8")).version;
    return { ...p, mainVersion, version: bump(mainVersion, how) };
  });
}

function readAt(cwd, ref, file) {
  const res = git(cwd, ["show", `${ref}:${file}`]);
  return res.ok ? res.out : "";
}

function ownHeadings(cwd, base, lines) {
  const fork = git(cwd, ["merge-base", base, "HEAD"]).out;
  const before = new Set(readAt(cwd, fork, CHANGELOG).split("\n").filter((l) => l.startsWith("## ")));
  return lines.map((l, i) => (l.startsWith("## ") && !before.has(l) ? i : -1)).filter((i) => i >= 0);
}

// The changelog with this PR's heading of each plugin set to `version`; notes written by hand stay, a missing section gets the PR title.
export function rewriteChangelog(text, own, targets, title) {
  const lines = text.split("\n");
  const missing = [];
  for (const t of targets) {
    const at = own.find((i) => headingRe(t).test(lines[i]));
    if (at === undefined) missing.push(t);
    else lines[at] = t.heading(t.version);
  }
  if (missing.length === 0) return lines.join("\n");
  const top = lines.findIndex((l) => l.startsWith("## "));
  const add = missing.flatMap((t) => [t.heading(t.version), "", `- ${title}`, ""]);
  const at = top < 0 ? lines.length : top;
  return [...lines.slice(0, at), ...add, ...lines.slice(at)].join("\n");
}

export function run(cwd, { base, title, check = false }) {
  const targets = plan(cwd, base, title);
  const file = path.join(cwd, CHANGELOG);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Changelog\n\n";
  const lines = text.split("\n");
  const own = ownHeadings(cwd, base, lines);
  const wrong = [];
  for (const t of targets) {
    const manifest = path.join(cwd, manifestOf(t));
    const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const listed = own.some((i) => lines[i] === t.heading(t.version));
    if (json.version !== t.version || !listed) wrong.push(`${t.name}：應升成 ${t.version}（main 是 ${t.mainVersion}，目前 plugin.json 是 ${json.version}${listed ? "" : "，CHANGELOG.md 缺這個版號的段落"}）`);
    if (!check && json.version !== t.version) fs.writeFileSync(manifest, `${JSON.stringify({ ...json, version: t.version }, null, 2)}\n`);
  }
  if (!check) fs.writeFileSync(file, rewriteChangelog(text, own, targets, title));
  return { targets, wrong };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { base: { type: "string", default: "origin/main" }, title: { type: "string", default: "" }, check: { type: "boolean", default: false }, cwd: { type: "string", default: process.cwd() } } });
  const { targets, wrong } = run(values.cwd, values);
  if (targets.length === 0) console.log("沒有改到任何 plugin，版號不動");
  if (values.check) {
    for (const line of wrong) console.log(line);
    if (wrong.length > 0) {
      console.log("從 fork 開的 PR 不能由 CI 推 commit，請照上面的版號手動升 plugin.json 並在 CHANGELOG.md 加段落");
      process.exit(1);
    }
    for (const t of targets) console.log(`${t.name}：${t.version} 正確`);
  } else for (const t of targets) console.log(`${t.name}：${t.mainVersion} → ${t.version}`);
}
