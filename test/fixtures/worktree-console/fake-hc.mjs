#!/usr/bin/env node
// Stand-in for herdr-core's `hc`: terminals in $FAKE_HERDR_APP_DIR/state.json (shared with fake-herdr-app.mjs),
// every call in calls.log, every send in sends.jsonl with whether the caller's address went along.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_HERDR_APP_DIR;
const raw = process.argv.slice(2);
const args = raw.filter((x) => x !== "--json");
const stateFile = path.join(dir, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const screenFile = (t) => path.join(dir, `screen-${t}.txt`);

fs.appendFileSync(path.join(dir, "calls.log"), `${JSON.stringify(["hc", ...args])}\n`);

function out(value) {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
}

function error(kind, code = 3) {
  process.stderr.write(JSON.stringify({ error: { kind, message: kind, hint: "" } }));
  process.exit(code);
}

if (process.env.FAKE_HC_FAIL) error("unreachable", 1);
const cmd = args[0];
const term = (address) => state.terminals[address] ?? error("not_found");

function transcriptFile(t) {
  const base = process.env.CLAUDE_PROJECTS_DIR;
  if (!base || !t.session) return null;
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, `${t.session}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  }
  return path.join(base, "fake-project", `${t.session}.jsonl`);
}

// A prompt becomes a user turn and a finished reply; /goal shows Goal set; /rename leaves the session as it was.
function converse(t, address, text) {
  if (text.startsWith("/goal ")) {
    fs.writeFileSync(screenFile(address), process.env.FAKE_HC_PASTE ? "❯ [Pasted text #1 +3 lines]\n  paste again to expand\n" : "⎿ Goal set: …\n❯\n");
    t.status = "done";
    return;
  }
  if (/^\/(rename|remote-control)\b/.test(text)) return;
  const file = process.env.FAKE_HC_CONVERSE ? transcriptFile(t) : null;
  if (file) {
    const ts = new Date().toISOString();
    const lines = [
      { type: "user", timestamp: ts, message: { role: "user", content: text } },
      { type: "assistant", timestamp: ts, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "依交棒說明：好的。" }] } },
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  t.status = file ? "done" : "working";
}

// An answered menu or permission prompt: the transcript gets the result of the call it was waiting on.
function answered(t) {
  const file = transcriptFile(t);
  if (!file || !fs.existsSync(file)) return;
  const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const parts = entries.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
  const call = parts.filter((p) => p.type === "tool_use").at(-1);
  if (call && !parts.some((p) => p.type === "tool_result" && p.tool_use_id === call.id)) {
    fs.appendFileSync(file, `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "ok" }] } })}\n`);
  }
}

if (cmd === "ls") {
  out({ hidden_finished: 0, terminals: Object.entries(state.terminals).map(([address, t]) => ({ address, agent: t.agent ?? null, cwd: t.cwd, state: "live", status: t.status ?? null })) });
}
if (cmd === "get") {
  const t = term(args[1]);
  out({ address: args[1], state: "live", cwd: t.cwd, argv: t.argv ?? [], status: t.status ? { app: "claude-code", state: t.status } : null });
}
if (cmd === "read") {
  term(args[1]);
  process.stdout.write(fs.existsSync(screenFile(args[1])) ? fs.readFileSync(screenFile(args[1]), "utf8") : "❯\n");
  process.exit(0);
}
if (cmd === "send") {
  const force = args.includes("--force");
  const rest = args.filter((x) => x !== "--force");
  const address = rest[1];
  const text = rest[2] === "--" ? rest[3] : rest[2];
  const t = term(address);
  if (process.env.FAKE_HC_SEND_FAIL) error("not_found");
  if (t.status === "blocked" && !force) error("blocked", 9);
  fs.appendFileSync(path.join(dir, "sends.jsonl"), `${JSON.stringify({ via: force ? "force" : "send", terminal: address, text, from: process.env.HC_TERMINAL_ID ?? null })}\n`);
  converse(t, address, text);
  save();
  out({ started: true, status: t.status, turn: 1 });
}
if (cmd === "keys") {
  const t = term(args[1]);
  if (process.env.FAKE_HC_SEND_FAIL) error("not_found");
  fs.appendFileSync(path.join(dir, "sends.jsonl"), `${JSON.stringify({ via: "keys", terminal: args[1], keys: args.slice(2) })}\n`);
  if (process.env.FAKE_HC_UNBLOCK && t.status === "blocked") {
    t.status = "working";
    answered(t);
  }
  save();
  out({ status: t.status, turn: 1 });
}
error("unsupported", 2);
