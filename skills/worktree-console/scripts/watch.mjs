#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  collect,
  decorate,
  formatBaseline,
  handoffEvents,
  handoffLines,
  mainCheckout,
  markHandoffReported,
  nameLines,
  needsYou,
  parseBaseline,
  readKeepalive,
  reportBlock,
  reportLines,
  snapshot,
  stopFields,
  writeKeepalive,
} from "./lib.mjs";
import { terminals } from "./terminals.mjs";
import { handedOver, keepaliveStep, keepaliveUsage, sessionEntries } from "./keepalive.mjs";
import { sweepDisposable } from "./disposable.mjs";
import { loadFocus, modsActive } from "./focus.mjs";
import { answeredStops, commitLog, distillReminder, logEvent, registerConsole, sessionFor } from "./log.mjs";
import { gitScene } from "./memory.mjs";

// The git scene goes with each stop, so a later reply is learnt under the scene it answered.
const stopEvent = (row, x) => ({ ...stopFields(row, x), scene: gitScene(row.path, row.baseRef) });

const { values } = parseArgs({
  options: { baseline: { type: "string" }, takeover: { type: "boolean", default: false } },
});

const INTERVAL = Number(process.env.WATCH_INTERVAL_MS || 10_000);
const TIMEOUT = Number(process.env.WATCH_TIMEOUT_MS || 110 * 60_000);

function ancestors() {
  const pids = new Set([String(process.pid)]);
  let pid = String(process.ppid);
  for (let i = 0; i < 20 && pid && pid !== "0" && pid !== "1"; i++) {
    pids.add(pid);
    pid = spawnSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8" }).stdout.trim();
  }
  return pids;
}

// One watcher per machine, old `--repo` ones included; `--takeover` stops the others first.
const PATTERN = process.env.WATCH_PGREP_PATTERN || "worktree-console/scripts/watch\\.mjs";
const mine = ancestors();
const others = spawnSync("pgrep", ["-f", PATTERN], { encoding: "utf8" })
  .stdout.split("\n")
  .map((s) => s.trim())
  .filter((pid) => pid && !mine.has(pid));
if (others.length > 0 && !values.takeover) {
  console.log("[watch] already-running");
  process.exit(0);
}
for (const pid of others) {
  try {
    process.kill(Number(pid), "SIGTERM");
  } catch {}
}

let unreachable = null;

function poll() {
  try {
    return collect(null, { withStage: false, register: true });
  } catch (error) {
    if (error.unsupported) {
      console.log(`[watch] ${error.message}`);
      process.exit(1);
    }
    if (!error.terminal) throw error;
    unreachable = error.terminal;
    return null;
  }
}

let baseline = values.baseline !== undefined ? parseBaseline(values.baseline) : null;
const started = Date.now();
let first = true;

for (;;) {
  const data = poll();
  if (!data) {
    console.log(`[watch] ${unreachable}-unreachable`);
    process.exit(0);
  }
  if (first) registerConsole({ handle: data.self.handle, paneKey: data.self.paneKey, repo: path.basename(mainCheckout(process.cwd())) });
  const start = first && values.baseline === undefined;
  commitLog(start ? { force: true, reason: "中控台啟動" } : {});
  first = false;
  const current = snapshot(data.rows);
  const distill = distillReminder({ start });
  if (distill) {
    console.log(distill);
    console.log(`baseline: ${formatBaseline(baseline ?? current)}`);
    process.exit(0);
  }
  const handoffs = handoffLines(data.rows, handoffEvents());
  if (handoffs.length > 0) {
    let kept = readKeepalive();
    for (const { ev, line, row } of handoffs) {
      console.log(line);
      markHandoffReported(ev);
      if (ev.cache) kept = handedOver(kept, ev);
      const ok = ev.status !== "failed";
      logEvent("handoff", {
        repo: row?.repo ?? null,
        ticket: row?.label ?? null,
        kind: ev.cache ? "cache" : ev.percent == null ? "manual" : "auto",
        ok,
        reason: ok ? null : ev.step ?? "未知步驟",
        oldHandle: ev.oldHandle ?? null,
        newHandle: ev.newHandle ?? null,
        oldSessionId: path.basename(ev.file ?? "", ".json") || sessionFor(ev.oldHandle),
        newSessionId: sessionFor(ev.newHandle),
      });
    }
    writeKeepalive(kept);
    console.log(`baseline: ${formatBaseline(current)}`);
    process.exit(0);
  }
  const unremoved = sweepDisposable(data.terminals);
  if (unremoved.length > 0) {
    for (const line of unremoved) console.log(line);
    console.log(`baseline: ${formatBaseline(current)}`);
    process.exit(0);
  }
  const kept = keepaliveStep(data.rows, readKeepalive());
  for (const { type, row, session, tag, text, tokens } of kept.actions) {
    const fields = { repo: row.repo, ticket: tag, handle: session.handle, paneKey: session.paneKey };
    if (type === "kept") {
      logEvent("keepalive", { ...fields, step: "kept", usage: keepaliveUsage(sessionEntries(row, session)) });
      continue;
    }
    const sent = session.handle ? terminals().send(session.handle, text, { enter: true }) : { ok: false, code: "no-handle" };
    logEvent("keepalive", { ...fields, step: type === "handoff" ? "handoff" : "sent", tokens: tokens ?? null, ok: sent.ok, reason: sent.ok ? null : sent.code ?? "unknown" });
  }
  writeKeepalive(kept.state);
  if (kept.lines.length > 0) {
    for (const line of kept.lines) console.log(line);
    console.log(`baseline: ${formatBaseline(current)}`);
    process.exit(0);
  }
  const answered = answeredStops();
  for (const row of data.rows) {
    for (const x of row.sessions) {
      const prev = x.handle ? answered.get(x.handle) : null;
      if (!prev || !x.agent || !needsYou(x.status.kind) || (baseline && baseline.get(x.paneKey) !== x.status.kind)) continue;
      const fields = stopFields(row, x);
      if (fields.status !== prev.status || fields.question !== prev.question) logEvent("stop", stopEvent(row, x));
    }
  }
  const focused = modsActive(loadFocus());
  if (baseline) {
    const changed = [];
    for (const row of data.rows) {
      for (const x of row.sessions) {
        if (x.agent && !x.archived && needsYou(x.status.kind) && baseline.get(x.paneKey) !== x.status.kind) changed.push({ row, x });
      }
    }
    for (const { row, x } of changed) logEvent("stop", stopEvent(row, x));
    if (changed.length > 0 && !focused) {
      decorate(data, { withStage: true, withTitles: true });
      const fresh = new Set(changed.map(({ x }) => x));
      const unanswered = data.rows.flatMap((row) =>
        row.sessions.filter((x) => x.agent && !x.archived && !fresh.has(x) && ["waiting", "permission"].includes(x.status.kind)).map((x) => ({ row, x })),
      );
      const reports = [
        ...changed.map(({ row, x }) => reportLines(row, x.status, x)),
        ...unanswered.map(({ row, x }) => reportLines(row, x.status, x, { again: true })),
      ];
      const names = nameLines(data.rows);
      console.log([...reportBlock(reports, data.rows), ...(names.length > 0 ? ["", ...names] : [])].join("\n"));
      console.log(`baseline: ${formatBaseline(current)}`);
      process.exit(0);
    }
  }
  baseline = current;
  if (Date.now() - started >= TIMEOUT) {
    console.log("[watch] timeout");
    console.log(`baseline: ${formatBaseline(current)}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
