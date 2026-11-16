// Sends a finished review back to the session that waits for it: along its handoffs to the session now running, queued while it works.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsYou, sessionTag } from "./lib.mjs";
import { readEvents, sessionFor } from "./log.mjs";
import { reviewsHome } from "./review.mjs";

const OUTBOX = () => path.join(reviewsHome(), "outbox.json");
export const CHAIN_MS = 24 * 3600_000;
const CONSOLE = fileURLToPath(new URL("./console.mjs", import.meta.url));

export function readOutbox() {
  try {
    const v = JSON.parse(fs.readFileSync(OUTBOX(), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeOutbox(list) {
  fs.mkdirSync(path.dirname(OUTBOX()), { recursive: true });
  fs.writeFileSync(OUTBOX(), JSON.stringify(list, null, 2));
}

// The session a handoff chain leads to from `start`; null when a link is older than a day.
export function followHandoffs(start, events = readEvents(), now = Date.now()) {
  let cur = start;
  for (let i = 0; i < 20 && cur; i++) {
    const next = events.filter((e) => e.event === "handoff" && e.ok !== false && e.oldSessionId === cur && e.newSessionId).at(-1);
    if (!next) return cur;
    if (now - (Date.parse(next.ts) || 0) > CHAIN_MS) return null;
    cur = next.newSessionId;
  }
  return cur;
}

// Where a review goes: the session the chain ends at; without a chain (too old, or dev-flow opened its own tab) the worktree's live session.
export function targetSession(rows, wtPath, sessions, { events = readEvents(), now = Date.now(), idOf = (s) => (s.handle ? sessionFor(s.handle, events) : null) } = {}) {
  const here = rows.filter((r) => r.path === wtPath).flatMap((row) => row.sessions.filter((s) => !s.archived && s.handle).map((s) => ({ row, s })));
  for (const start of [...sessions].reverse()) {
    const end = followHandoffs(start, events, now);
    const hit = end ? here.find(({ s }) => idOf(s) === end) : null;
    if (hit) return hit;
  }
  return here.find(({ s }) => needsYou(s.status.kind)) ?? here[0] ?? null;
}

const sendOnly = (tag, text) => {
  const r = spawnSync(process.execPath, [CONSOLE, "reply", "--only", tag, "--", text], { encoding: "utf8", env: process.env, timeout: 120_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

// Sends now when the session has stopped, else queues it for the watcher; returns the line to print.
export function deliverReview(rows, wtPath, message, sessions, { send = sendOnly, ...opts } = {}) {
  const hit = targetSession(rows, wtPath, sessions, opts);
  const queue = (why) => {
    writeOutbox([...readOutbox().filter((x) => x.path !== wtPath), { path: wtPath, message, sessions, at: new Date().toISOString() }]);
    return why;
  };
  if (!hit) return queue("找不到這個 worktree 的 session，審核結果排隊，它出現再送");
  const tag = sessionTag(hit.row, hit.s);
  if (!needsYou(hit.s.status.kind)) return queue(`[${tag}] 正在工作，審核結果排隊，停下再送`);
  const r = send(tag, message);
  if (!r.ok) return queue(`[${tag}] 審核結果沒送出，排隊等下一輪再送：${r.out}`);
  return r.out || `[${tag}] 已送出`;
}

// The watcher's poll: each queued review whose session has now stopped is sent.
export function flushOutbox(rows, { send = sendOnly, ...opts } = {}) {
  const lines = [];
  const left = [];
  for (const x of readOutbox()) {
    const hit = targetSession(rows, x.path, x.sessions ?? [], opts);
    if (!hit || !needsYou(hit.s.status.kind)) {
      left.push(x);
      continue;
    }
    const r = send(sessionTag(hit.row, hit.s), x.message);
    if (r.ok) lines.push(r.out);
    else left.push(x);
  }
  if (left.length !== readOutbox().length) writeOutbox(left);
  return lines;
}
