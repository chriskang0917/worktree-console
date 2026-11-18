// Reading the recaps scripts/summary.mjs writes, kept apart so lib.mjs can read them without loading the Stop hook itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
// A worker that died without clearing its marker stops counting as running after its timeout and this much more.
const PENDING_SLACK_MS = 60_000;

export const summaryHome = () => process.env.WORKTREE_CONSOLE_HOME || path.join(os.homedir(), ".config", "worktree-console");
const dirOf = (home) => path.join(home, "summaries");
const slug = (handle) => encodeURIComponent(handle);
export const summaryFile = (home, handle) => path.join(dirOf(home), `${slug(handle)}.json`);
export const pendingFile = (home, handle) => path.join(dirOf(home), `${slug(handle)}.pending.json`);
export const usageFile = (home) => path.join(home, "summary-usage.jsonl");
export const timeoutMs = () => Number(process.env.WORKTREE_CONSOLE_SUMMARY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// The tab's newest recap and whether a newer one is being written: { text, at, sessionId, pending }.
export function readSummary(home, handle, now = Date.now()) {
  if (!handle) return { text: null, at: null, sessionId: null, pending: false };
  const saved = readJson(summaryFile(home, handle));
  const marker = readJson(pendingFile(home, handle));
  const pending = !!marker && now - (marker.since ?? 0) < (marker.timeoutMs ?? timeoutMs()) + PENDING_SLACK_MS;
  return { text: saved?.text ?? null, at: saved?.at ?? null, sessionId: saved?.sessionId ?? null, replyAt: saved?.replyAt ?? null, pending };
}

// The recap of the stop a card shows, or null: only a recap whose replyAt matches the stop counts; herdr and the Herdr app read
// the stop time from the same transcript entry, Orca's own clock is not compared. A recap still being written for it is `pending`.
export function stopDigest(home, session, now = Date.now()) {
  const { text, pending, replyAt } = readSummary(home, session?.handle, now);
  const since = session?.since ?? session?.agent?.stateStartedAt ?? null;
  const comparable = !!session?.agent?.herdr && typeof replyAt === "number" && typeof since === "number";
  const matches = comparable ? replyAt === since : !pending;
  return { text: text && matches ? text : null, pending };
}

