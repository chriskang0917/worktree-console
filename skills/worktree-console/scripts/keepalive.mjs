import fs from "node:fs";
import { CACHE_HANDOFF_TEXT } from "../../../hooks/auto-handoff.mjs";
import { KEEPALIVE_REPLY, KEEPALIVE_TEXT, sessionTag, sessionTranscript, takeoverPrompt, watcherPrompt } from "./lib.mjs";

// The prompt cache lives an hour from the last model call; 10 minutes are left for polling and writing the handoff note.
export const KEEPALIVE_AFTER_MS = 50 * 60 * 1000;
export const HANDOFF_TOKENS = 150_000;
const PRUNE_MS = 24 * 60 * 60 * 1000;
const MENU_TOOL = "AskUserQuestion";

const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// ⏸ or a 💬 asked in plain text; 🔐, an open menu, 💤, archived and throwaway sessions are never touched.
function keepable(session, status) {
  if (session.archived || session.disposable || !session.agent) return false;
  if (status.kind === "done") return true;
  return status.kind === "waiting" && !status.menu && !(session.agent.toolName === MENU_TOOL && session.agent.state !== "done");
}

function entriesOf(file) {
  const out = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
  } catch {}
  return out;
}

const mainUsage = (e) => e.type === "assistant" && !e.isSidechain && e.message?.usage && e.message.model !== "<synthetic>";

// Tokens the last model call sent: everything in the context window.
export function contextTokens(entries) {
  const u = entries.findLast(mainUsage)?.message.usage;
  return u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : null;
}

const lastKeepalive = (entries) =>
  entries.findLastIndex((e) => e.type === "user" && !e.isSidechain && squash(typeof e.message?.content === "string" ? e.message.content : (e.message?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("")) === KEEPALIVE_TEXT);

// Cache numbers of the first model call after the last keepalive: a hit reads nearly the whole context and writes only the new tail.
export function keepaliveUsage(entries) {
  const at = lastKeepalive(entries);
  if (at < 0) return null;
  const u = entries.slice(at + 1).find(mainUsage)?.message.usage;
  if (!u) return null;
  return {
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? u.cache_creation_input_tokens ?? 0,
    cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    input: u.input_tokens ?? 0,
  };
}

// What the session said after the last keepalive, and how many tools it called.
export function keepaliveReply(entries) {
  const at = lastKeepalive(entries);
  if (at < 0) return null;
  const parts = entries
    .slice(at + 1)
    .filter((e) => e.type === "assistant" && !e.isSidechain)
    .flatMap((e) => (typeof e.message?.content === "string" ? [{ type: "text", text: e.message.content }] : (e.message?.content ?? [])));
  return { text: parts.filter((p) => p.type === "text").map((p) => p.text).join("\n"), tools: parts.filter((p) => p.type === "tool_use").length };
}

const obeyed = (reply) => reply.tools === 0 && squash(reply.text).replace(/[\s。.!！]/g, "") === KEEPALIVE_REPLY;

export function sessionEntries(row, session) {
  const file = sessionTranscript(session.handle, row.path, session.agent?.prompt);
  return file ? entriesOf(file) : [];
}

/**
 * One watcher poll over every session: returns the new state, what to send and the lines to print.
 * Per pane: sent (keepalive on its way) → kept (it stopped again) → handing (cache handoff sent) or expired (left to expire);
 * fresh marks the session that took over, untouched until you reply. A reply from you drops the record.
 */
export function keepaliveStep(
  rows,
  prev,
  now = Date.now(),
  { contextOf = (row, s) => contextTokens(sessionEntries(row, s)), replyOf = (row, s) => keepaliveReply(sessionEntries(row, s)) } = {},
) {
  const state = {};
  const actions = [];
  const lines = [];
  const seen = new Set();
  for (const row of rows) {
    for (const session of row.sessions) {
      seen.add(session.paneKey);
      const agent = session.agent;
      const status = session.realStatus ?? session.status;
      const stopAt = agent?.stateStartedAt;
      let rec = prev[session.paneKey] ?? null;
      if (rec && agent) {
        const replied = rec.phase === "fresh" ? !!agent.prompt && !takeoverPrompt(agent.prompt) : stopAt !== rec.stopAt && !watcherPrompt(agent.prompt);
        if (replied) rec = null;
      }
      const tag = sessionTag(row, session);
      if (!rec) {
        if (keepable(session, status) && typeof stopAt === "number" && now - stopAt >= KEEPALIVE_AFTER_MS) {
          rec = { phase: "sent", handle: session.handle, stopAt, sentAt: now, status: { kind: status.kind, text: status.text ?? "" } };
          actions.push({ type: "keepalive", row, session, tag, text: KEEPALIVE_TEXT });
        }
      } else if (rec.phase === "sent" && agent && stopAt !== rec.stopAt && watcherPrompt(agent.prompt) && status.kind !== "busy") {
        if (keepable(session, status)) {
          if (!obeyed(replyOf(row, session) ?? { text: status.text ?? "", tools: 0 })) lines.push(`[${tag}] 續命時沒照指示只回「${KEEPALIVE_REPLY}」，畫面照舊顯示原題`);
          rec = { ...rec, phase: "kept", keptAt: stopAt };
          actions.push({ type: "kept", row, session, tag });
        } else rec = { ...rec, phase: "expired" };
      } else if (rec.phase === "kept" && agent && stopAt === rec.keptAt && keepable(session, status) && now - rec.keptAt >= KEEPALIVE_AFTER_MS) {
        const tokens = contextOf(row, session);
        if (typeof tokens === "number" && tokens >= HANDOFF_TOKENS) {
          rec = { ...rec, phase: "handing", handAt: now, tokens };
          actions.push({ type: "handoff", row, session, tag, text: CACHE_HANDOFF_TEXT, tokens });
        } else rec = { ...rec, phase: "expired", tokens: tokens ?? null };
      }
      if (rec) state[session.paneKey] = { ...rec, at: now };
    }
  }
  for (const [paneKey, rec] of Object.entries(prev)) {
    if (!seen.has(paneKey) && !(paneKey in state) && now - (rec.at ?? 0) < PRUNE_MS) state[paneKey] = rec;
  }
  return { state, actions, lines };
}

// A finished cache handoff: the old pane's record goes and the new pane is marked fresh (♻️, no keepalive) until you reply;
// a failed one leaves the old session to expire.
export function handedOver(state, ev, now = Date.now()) {
  const next = { ...state };
  const old = Object.keys(next).filter((k) => k === ev.oldPaneKey || (ev.oldHandle && next[k].handle === ev.oldHandle));
  for (const paneKey of old) {
    if (ev.status === "done") delete next[paneKey];
    else next[paneKey] = { ...next[paneKey], phase: "expired", at: now };
  }
  if (ev.status === "done" && ev.newPaneKey) next[ev.newPaneKey] = { phase: "fresh", handle: ev.newHandle ?? null, at: now };
  return next;
}
