#!/usr/bin/env node
// Stand-in for the orca CLI: serves rendered fixture files from $FAKE_ORCA_DIR.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_ORCA_DIR;
const args = process.argv.slice(2).filter((a) => a !== "--json");
const cmd = args.slice(0, 2).join(" ");

function reply(file) {
  process.stdout.write(fs.readFileSync(path.join(dir, file), "utf8"));
  process.exit(0);
}

function error(code) {
  process.stdout.write(JSON.stringify({ id: "fake", ok: false, error: { code, message: code } }));
  process.exit(1);
}

if (process.env.FAKE_ORCA_FAIL) error("timeout");
fs.appendFileSync(path.join(dir, "calls.log"), `${args.join(" ")}\n`);

if (cmd === "worktree ps") {
  const seq = fs.readdirSync(dir).filter((f) => /^ps-\d+\.json$/.test(f)).sort();
  if (seq.length === 0) reply("worktree-ps.json");
  const counter = path.join(dir, "ps-counter");
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(n + 1));
  reply(seq[Math.min(n, seq.length - 1)]);
}
if (cmd === "worktree list") reply("worktree-list.json");
if (cmd === "repo list") reply("repo-list.json");
if (cmd === "terminal list") reply("terminal-list.json");
if (cmd === "terminal read") {
  const handle = args[args.indexOf("--terminal") + 1];
  const seq = fs.readdirSync(dir).filter((f) => f.startsWith(`screen-${handle}-`)).sort();
  if (seq.length > 0) {
    const counter = path.join(dir, `screen-counter-${handle}`);
    const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
    fs.writeFileSync(counter, String(n + 1));
    reply(seq[Math.min(n, seq.length - 1)]);
  }
  const file = `terminal-read-${handle}.json`;
  if (fs.existsSync(path.join(dir, file))) reply(file);
  error("terminal_handle_stale");
}
if (cmd === "terminal send") {
  if (process.env.FAKE_ORCA_SEND_FAIL) error("terminal_handle_stale");
  process.stdout.write(JSON.stringify({ ok: true, result: { send: { accepted: true } } }));
  process.exit(0);
}
if (cmd === "terminal create") {
  fs.appendFileSync(path.join(dir, "create.log"), `${JSON.stringify(args)}\n`);
  process.stdout.write(JSON.stringify({ ok: true, result: { terminal: { handle: "term_new" } } }));
  process.exit(0);
}
if (cmd === "terminal wait") {
  process.stdout.write(JSON.stringify({ ok: true, result: { satisfied: true } }));
  process.exit(0);
}
if (cmd === "terminal close") {
  process.stdout.write(JSON.stringify({ ok: true, result: { closed: true } }));
  process.exit(0);
}
if (cmd === "linear issue") {
  const file = `linear-issue-${args[2]}.json`;
  if (fs.existsSync(path.join(dir, file))) reply(file);
  error("linear_not_connected");
}
error("unsupported");
