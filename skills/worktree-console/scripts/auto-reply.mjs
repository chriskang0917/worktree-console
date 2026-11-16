import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Kept free of lib.mjs: herdr-app.mjs reads it, and lib.mjs already reaches herdr-app.mjs through terminals.mjs.
export const DELEGATED_FILE = "delegated.json";
const home = () => process.env.WORKTREE_CONSOLE_HOME || path.join(os.homedir(), ".config", "worktree-console");
// How far the turn's start may sit from the answer that started it: the send lands a few seconds before the agent reports working.
const BEFORE_MS = 10_000;
const AFTER_MS = 120_000;

export function readDelegated(dir = home()) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, DELEGATED_FILE), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// The answer the console sent for the user when it is what this running turn works on, else null; it clears once the session stops.
export function autoReplyOf(session, delegated = readDelegated()) {
  if (session?.status?.kind !== "busy") return null;
  const id = session.paneKey ?? session.handle;
  if (!id) return null;
  const last = Object.entries(delegated)
    .filter(([k, v]) => k.startsWith(`${id}@`) && v && !v.failed && typeof v.at === "number")
    .map(([, v]) => v)
    .sort((a, b) => b.at - a.at)[0];
  if (!last) return null;
  const raw = session.agent?.stateStartedAt;
  const started = typeof raw === "number" ? raw : Date.parse(raw ?? "");
  if (!Number.isFinite(started) || started < last.at - BEFORE_MS || started > last.at + AFTER_MS) return null;
  const answer = last.submit ? "送審" : String(last.answer ?? "").trim();
  return answer || null;
}
