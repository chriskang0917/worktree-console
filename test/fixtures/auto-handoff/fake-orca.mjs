#!/usr/bin/env node
// Stand-in orca for the handoff flow; FAKE_FAIL_STEP makes one step fail, every call lands in calls.log.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_ORCA_DIR;
const fail = process.env.FAKE_FAIL_STEP ?? "";
const args = process.argv.slice(2).filter((a) => a !== "--json");
const cmd = args.slice(0, 2).join(" ");
const opt = (name) => args[args.indexOf(name) + 1];
const sendsFile = path.join(dir, "sends.jsonl");
const sends = () => (fs.existsSync(sendsFile) ? fs.readFileSync(sendsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const NEW = { handle: "term_new", tabId: "tab_new", paneKey: "tab_new:leaf_new" };

fs.appendFileSync(path.join(dir, "calls.log"), `${JSON.stringify(args)}\n`);

function ok(result) {
  process.stdout.write(JSON.stringify({ id: "fake", ok: true, result }));
  process.exit(0);
}

function error(code) {
  process.stdout.write(JSON.stringify({ id: "fake", ok: false, error: { code, message: code } }));
  process.exit(1);
}

if (cmd === "terminal list") {
  ok({ terminals: [{ handle: process.env.ORCA_TERMINAL_HANDLE, worktreePath: process.env.FAKE_WORKTREE, tabId: "tab_old", leafId: "leaf_old", agentIdentity: "claude" }] });
}
if (cmd === "terminal create") {
  if (fail === "create") error("create_failed");
  ok({ terminal: NEW });
}
if (cmd === "terminal wait") {
  if (fail === "wait") error("timeout");
  ok({ wait: { satisfied: true } });
}
if (cmd === "terminal send") {
  const text = opt("--text");
  const isGoal = text.startsWith("/goal ");
  if (fail === "send" && !isGoal) error("terminal_handle_stale");
  if (fail === "goal-send" && isGoal) error("agent_prompt_blocked");
  fs.appendFileSync(sendsFile, `${JSON.stringify({ terminal: opt("--terminal"), text })}\n`);
  ok({ send: { accepted: true } });
}
if (cmd === "worktree ps") {
  const first = sends().find((s) => s.terminal === NEW.handle && !s.text.startsWith("/goal "));
  const agents = first && fail !== "deliver" ? [{ paneKey: NEW.paneKey, state: "done", prompt: Array.from(first.text).slice(0, 60).join("") }] : [];
  ok({ worktrees: [{ path: process.env.FAKE_WORKTREE, agents }] });
}
if (cmd === "terminal read") {
  const goal = sends().find((s) => s.text.startsWith("/goal "));
  const tail = !goal ? ["❯"] : fail === "goal-set" ? ["❯ [Pasted text #1 +2 lines]"] : ["⎿ Goal set: …", "❯"];
  ok({ terminal: { handle: opt("--terminal"), tail } });
}
if (cmd === "terminal close") ok({ close: { handle: opt("--terminal"), closeMode: "tab" } });
error("unsupported");
