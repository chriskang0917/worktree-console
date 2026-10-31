#!/usr/bin/env node
// Stand-in for the herdr-app CLI: spaces, tabs and terminals in $FAKE_HERDR_APP_DIR/state.json (shared with
// fake-hc.mjs), every call in calls.log. Like the real one, tab.new and space.new focus the new tab.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_HERDR_APP_DIR;
const args = process.argv.slice(2);
const stateFile = path.join(dir, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

fs.appendFileSync(path.join(dir, "calls.log"), `${JSON.stringify(["herdr-app", ...args])}\n`);

function out(value, code = 0) {
  process.stdout.write(JSON.stringify(value, null, 2));
  process.exit(code);
}
const error = (message) => out({ error: message }, 1);

if (process.env.FAKE_HERDR_APP_FAIL) error("Herdr isn't running");
state.seq ??= 100;
const next = (prefix) => `${prefix}${(state.seq += 1)}`;
const tabOf = (id) => state.spaces.flatMap((s) => s.tabs.map((t) => ({ space: s, tab: t }))).find((x) => x.tab.id === id);

// A terminal running argv: idle once Claude Code is up, unless the test wants it never to report.
function terminal(folder, argv) {
  const address = `t${(state.seq += 1)}`;
  const at = argv.indexOf("--session-id");
  const resume = argv.indexOf("--resume");
  const session = at >= 0 ? argv[at + 1] : resume >= 0 && !process.env.FAKE_HC_RESUME_LOST ? argv[resume + 1] : null;
  state.terminals[address] = { cwd: folder, status: process.env.FAKE_HC_NOT_READY ? null : "idle", agent: process.env.FAKE_HC_NOT_READY ? null : "claude-code", argv, session };
  return { terminal: address, pane: `pa${address}`, name: null };
}

function view() {
  return {
    spaces: state.spaces.map((s) => ({
      id: s.id,
      name: s.name,
      folder: s.folder,
      machine: null,
      active: state.focus?.space === s.id,
      tabs: s.tabs.map((t) => ({
        id: t.id,
        name: t.name,
        active: state.focus?.tab === t.id,
        settled: false,
        terminals: t.terminals.map((x) => ({ ...x, status: state.terminals[x.terminal]?.status ?? null, app: state.terminals[x.terminal]?.agent ?? null, sub_agents: [] })),
      })),
    })),
  };
}

function closeTerminals(list) {
  for (const t of list) delete state.terminals[t.terminal];
}

if (args[0] === "ls") out(view());
if (args[0] === "status") out({ space: state.focus?.space ?? null, tab: state.focus?.tab ?? null, focused_pane: state.focus?.pane ?? null, layout: "main", errors: [] });
if (args[0] !== "do") error(`unknown: ${args[0]}`);

const command = args[1];
const a = JSON.parse(args[2] ?? "{}");
if (command === "tab.new") {
  const space = state.spaces.find((s) => s.id === a.space);
  if (!space) error(`no space "${a.space}"`);
  const t = terminal(a.folder, a.argv ?? []);
  const tab = { id: next("tb"), name: a.name ?? String(space.tabs.length + 1), terminals: [t] };
  space.tabs.push(tab);
  state.focus = { space: space.id, tab: tab.id };
  save();
  out({ space: space.id, tab: tab.id, terminal: t.terminal });
}
if (command === "space.new") {
  const t = terminal(a.folder, a.argv ?? []);
  const tab = { id: next("tb"), name: a.tab ?? "1", terminals: [t] };
  const space = { id: next("sp"), name: a.name ?? path.basename(a.folder ?? "~"), folder: a.folder, tabs: [tab] };
  state.spaces.push(space);
  state.focus = { space: space.id, tab: tab.id };
  save();
  out({ space: space.id, tab: tab.id, terminal: t.terminal });
}
if (command === "tab.select") {
  const hit = tabOf(a.id);
  if (!hit) error(`no tab "${a.id}"`);
  state.focus = { space: hit.space.id, tab: hit.tab.id };
  save();
  out({ ok: true });
}
if (command === "tab.rename") {
  const hit = tabOf(a.id);
  if (!hit) error(`no tab "${a.id}"`);
  hit.tab.name = a.name;
  save();
  out({ ok: true });
}
if (command === "tab.close") {
  const hit = tabOf(a.id);
  if (!hit) error(`no tab "${a.id}"`);
  if (process.env.FAKE_HERDR_APP_CLOSE_FAIL) error("close refused");
  closeTerminals(hit.tab.terminals);
  hit.space.tabs = hit.space.tabs.filter((t) => t.id !== a.id);
  if (hit.space.tabs.length === 0) state.spaces = state.spaces.filter((s) => s !== hit.space);
  save();
  out({ ok: true });
}
// A mod pane beside a terminal's pane; like the real one it may take the focus.
if (command === "pane.split") {
  const hit = state.spaces.flatMap((s) => s.tabs).find((t) => t.terminals.some((x) => x.pane === a.pane));
  if (!hit) error(`no pane "${a.pane}"`);
  const pane = next("pm");
  (hit.mods ??= []).push({ pane, mod: a.mod, direction: a.direction });
  state.focus = { ...state.focus, pane };
  save();
  out({ pane });
}
if (command === "pane.focus") {
  state.focus = { ...state.focus, pane: a.pane };
  save();
  out({ ok: true });
}
if (command === "pane.close") {
  const hit = state.spaces.flatMap((s) => s.tabs.map((t) => ({ space: s, tab: t }))).find((x) => x.tab.terminals.some((t) => t.pane === a.pane));
  if (!hit) error(`no pane "${a.pane}"`);
  closeTerminals(hit.tab.terminals.filter((t) => t.pane === a.pane));
  hit.tab.terminals = hit.tab.terminals.filter((t) => t.pane !== a.pane);
  save();
  out({ ok: true });
}
error(`unsupported command ${command}`);
