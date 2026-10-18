#!/usr/bin/env node
// Stand-in for the herdr CLI: live state in $FAKE_HERDR_DIR/state.json, every call in calls.log, sends in sends.jsonl.
// Like the real one, pane send-text and send-keys print nothing when they succeed.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_HERDR_DIR;
const args = process.argv.slice(2);
const cmd = args.slice(0, 2).join(" ");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const stateFile = path.join(dir, "state.json");
const load = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
const screenFile = (pane) => path.join(dir, `screen-${pane.replace(/:/g, "_")}.txt`);

fs.appendFileSync(path.join(dir, "calls.log"), `${JSON.stringify(args)}\n`);

function ok(result) {
  process.stdout.write(JSON.stringify({ id: "fake", result }));
  process.exit(0);
}

function error(code) {
  process.stderr.write(JSON.stringify({ id: "fake", error: { code, message: code } }));
  process.exit(1);
}

if (process.env.FAKE_HERDR_FAIL) error("server_unavailable");
const state = load();
state.seq ??= 100;
const agentOf = (target) => state.agents.find((a) => a.pane_id === target || a.name === target);

// Like herdr, a tab opened without a label, and the first tab of a new workspace, is called by its number.
function newPane(workspace, cwd, label) {
  state.seq += 1;
  const tabLabel = label ?? String(state.panes.filter((p) => p.workspace_id === workspace).length + 1);
  const pane = { pane_id: `${workspace}:p${state.seq}`, tab_id: `${workspace}:t${state.seq}`, workspace_id: workspace, cwd, foreground_cwd: cwd, label: tabLabel };
  state.panes.push(pane);
  return pane;
}

// A prompt lands in the session's transcript as a user turn followed by a finished reply, like a real quick turn;
// /rename and /remote-control are local commands that leave the session as it was.
function converse(agent, text) {
  const tdir = process.env.FAKE_HERDR_TRANSCRIPTS;
  if (!tdir || !agent.agent_session) return;
  const file = path.join(tdir, "fake-project", `${agent.agent_session.value}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ts = new Date().toISOString();
  const lines = [
    { type: "user", timestamp: ts, message: { role: "user", content: text } },
    { type: "assistant", timestamp: ts, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "依交棒說明：好的。" }] } },
  ];
  fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// An answered menu or permission prompt: the transcript gets the result of the call it was waiting on.
function answered(agent) {
  const base = process.env.CLAUDE_PROJECTS_DIR;
  const id = agent.agent_session?.value;
  if (!base || !id || !fs.existsSync(base)) return;
  for (const d of fs.readdirSync(base)) {
    const file = path.join(base, d, `${id}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
    const parts = entries.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
    const call = parts.filter((p) => p.type === "tool_use").at(-1);
    if (call && !parts.some((p) => p.type === "tool_result" && p.tool_use_id === call.id)) fs.appendFileSync(file, `${JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "ok" }] } })}\n`);
  }
}

const tabs = () => [...new Map(state.panes.map((p) => [p.tab_id, { tab_id: p.tab_id, workspace_id: p.workspace_id, label: state.tabLabels?.[p.tab_id] ?? p.label ?? "1" }])).values()];
if (cmd === "api snapshot") ok({ type: "session_snapshot", snapshot: { panes: state.panes, agents: state.agents, workspaces: state.workspaces ?? [], tabs: tabs() } });
if (cmd === "tab rename") {
  if (!state.panes.some((p) => p.tab_id === args[2])) error("tab_not_found");
  (state.tabLabels ??= {})[args[2]] = args.slice(3).join(" ");
  save(state);
  ok({ type: "tab_info", tab: tabs().find((t) => t.tab_id === args[2]) });
}
if (cmd === "pane read") {
  const file = screenFile(args[2]);
  if (!state.panes.some((p) => p.pane_id === args[2])) error("pane_not_found");
  process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "❯\n");
  process.exit(0);
}
if (cmd === "pane send-text") {
  if (process.env.FAKE_HERDR_SEND_FAIL) error("pane_not_found");
  fs.appendFileSync(path.join(dir, "sends.jsonl"), `${JSON.stringify({ via: "send-text", pane: args[2], text: args[3] })}\n`);
  process.exit(0);
}
if (cmd === "pane send-keys") {
  if (process.env.FAKE_HERDR_SEND_FAIL) error("pane_not_found");
  fs.appendFileSync(path.join(dir, "sends.jsonl"), `${JSON.stringify({ via: "send-keys", pane: args[2], keys: args.slice(3) })}\n`);
  const agent = agentOf(args[2]);
  if (agent && process.env.FAKE_HERDR_UNBLOCK) {
    if (agent.agent_status === "blocked") agent.agent_status = "working";
    save(state);
    answered(agent);
  }
  process.exit(0);
}
if (cmd === "pane close") {
  state.panes = state.panes.filter((p) => p.pane_id !== args[2]);
  state.agents = state.agents.filter((a) => a.pane_id !== args[2]);
  save(state);
  ok({ type: "ok" });
}
if (cmd === "tab create") {
  const pane = newPane(opt("--workspace") ?? "w1", opt("--cwd"), opt("--label"));
  save(state);
  ok({ type: "tab_created", tab: { tab_id: pane.tab_id }, root_pane: pane });
}
if (cmd === "workspace create") {
  state.seq += 1;
  const ws = `w${state.seq}`;
  (state.workspaces ??= []).push({ workspace_id: ws, label: opt("--label") });
  const pane = newPane(ws, opt("--cwd"), null);
  save(state);
  ok({ type: "workspace_created", workspace: { workspace_id: ws }, root_pane: pane });
}
if (cmd === "agent start") {
  const pane = opt("--pane");
  if (process.env.FAKE_HERDR_START_FAIL) error("agent_not_ready");
  const p = state.panes.find((x) => x.pane_id === pane);
  const argv = args.includes("--") ? args.slice(args.indexOf("--") + 1) : [];
  const resumed = argv.includes("--resume") && !process.env.FAKE_HERDR_RESUME_LOST ? argv[argv.indexOf("--resume") + 1] : null;
  const agent = { agent: "claude", name: args[2], pane_id: pane, cwd: p?.cwd, agent_status: "idle", agent_session: { kind: "id", value: resumed ?? `sess-${pane.replace(/:/g, "-")}` }, argv };
  state.agents.push(agent);
  save(state);
  ok({ type: "agent_started", agent });
}
if (cmd === "agent wait") ok({ type: "agent_waited", agent: agentOf(args[2]) });
if (cmd === "agent get") {
  const agent = agentOf(args[2]);
  if (!agent) error("agent_not_found");
  ok({ type: "agent_info", agent });
}
if (cmd === "agent prompt") {
  const agent = agentOf(args[2]);
  if (!agent) error("agent_not_found");
  if (agent.agent_status === "blocked") error("agent_blocked");
  const text = args[3];
  fs.appendFileSync(path.join(dir, "sends.jsonl"), `${JSON.stringify({ via: "prompt", pane: agent.pane_id, text })}\n`);
  if (text.startsWith("/goal ")) {
    fs.writeFileSync(screenFile(agent.pane_id), process.env.FAKE_HERDR_PASTE ? "❯ [Pasted text #1 +3 lines]\n  paste again to expand\n" : "⎿ Goal set: …\n❯\n");
    agent.agent_status = process.env.FAKE_HERDR_TRANSCRIPTS ? "done" : "working";
  } else if (!/^\/(rename|remote-control)\b/.test(text)) {
    converse(agent, text);
    agent.agent_status = process.env.FAKE_HERDR_TRANSCRIPTS ? "done" : "working";
  }
  save(state);
  ok({ type: "agent_prompted", agent });
}
error("unsupported");
