import "./fixtures/isolate-env.mjs";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flushRenames, queueRename, readRenames } from "../skills/worktree-console/scripts/lib.mjs";

let home;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-renames-"));
  process.env.WORKTREE_CONSOLE_HOME = home;
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

const manager = (name) => {
  const sent = [];
  return { name, sent, send: (handle, text, opts) => (sent.push([handle, text, opts.enter]), { ok: true }) };
};
const rows = (states) => [{ sessions: Object.entries(states).map(([handle, state]) => ({ handle, agent: { state } })) }];

test("待改名：session 停下（done／idle）才送 /rename，執行中與開著選單或授權的留著；分頁已關的除名；只處理自己這邊（Orca 或 herdr）的", () => {
  queueRename("term_a", "PROJ-1", "orca");
  queueRename("term_b", "PROJ-2", "orca");
  queueRename("term_c", "PROJ-3", "orca");
  queueRename("term_gone", "PROJ-4", "orca");
  queueRename("w1:p2", "PROJ-5", "herdr");
  const orca = manager("orca");
  const terminals = ["term_a", "term_b", "term_c"].map((handle) => ({ handle }));
  flushRenames(rows({ term_a: "done", term_b: "working", term_c: "waiting" }), terminals, orca);
  assert.deepEqual(orca.sent, [["term_a", "/rename PROJ-1", true]]);
  assert.deepEqual(Object.keys(readRenames()).sort(), ["term_b", "term_c", "w1:p2"]);
  flushRenames(rows({ term_b: "idle", term_c: "done" }), terminals, orca);
  assert.deepEqual(orca.sent.slice(1), [["term_b", "/rename PROJ-2", true], ["term_c", "/rename PROJ-3", true]]);
  assert.deepEqual(Object.keys(readRenames()), ["w1:p2"], "herdr 的留給 herdr 中控台");
});
