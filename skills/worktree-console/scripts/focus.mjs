import fs from "node:fs";
import path from "node:path";
import { LABELS, YOUR_TURN, awaitsUser, yourTurn, batchSheet, closable, finishedState, readKeepalive, readNames, textStop, consoleHome, fillTitle, firstInstruction, lastActivity, needsYou, pendingItems, reportLines, sessionCaption, sessionTag, sessionTranscript, stopFields } from "./lib.mjs";
import { judgedStatus, waitingGroups } from "./waiting-line.mjs";
import { bandRows, weeklyReport } from "./band.mjs";
import { guideFor, readGuide } from "./guide-record.mjs";
import { logEvent } from "./log.mjs";
import { isConsoleSession } from "./log.mjs";
import { adviceFor, advisorHome, advisorState, loadAdvice } from "./advice.mjs";
import { readSummary, stopDigest } from "./summary.mjs";
import { digestLayers, digestMarkdown } from "../../../hooks/digest.mjs";
import { verdicts } from "./delegate.mjs";
import { autoReplyOf, readDelegated } from "./auto-reply.mjs";
import { sheetLines, sheetProblems, stateOf, tagOf, worktreeOf } from "./review.mjs";
import { isGateStop, isLiveStop, sheetPath } from "./urgency.mjs";

// How long the watcher, printing a report itself without the band, waits for that stop's recap.
export const DIGEST_WAIT_MS = 15_000;
const MODS_TTL_MS = 30_000;
const FILE = "focus.json";
const CONSOLE_SESSIONS_MAX = 10;
const OWNER_TTL_MS = 30_000;
const REPLIED_MAX = 20;
// The focus.json format version mods/focus-show checks; when to bump it is in references/focus-contract.md.
export const FOCUS_VERSION = 1;

// Names one stop so /focus-show can tell it is still on the band when it finally runs. focus-show 0.1.2 and older compute it themselves, so keep the formula.
export const stopId = (key) => [...key].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36);

export function emptyFocus() {
  return { modsAt: 0, current: null, currentAt: 0, reported: [], wait: null, answered: [], replied: [], back: {}, bumped: {}, seen: {}, sent: null, hold: false, closables: {}, titles: {}, firsts: {} };
}

export function loadFocus() {
  try {
    return { ...emptyFocus(), ...JSON.parse(fs.readFileSync(path.join(consoleHome(), FILE), "utf8")) };
  } catch {
    return emptyFocus();
  }
}

export function saveFocus(state) {
  try {
    fs.mkdirSync(consoleHome(), { recursive: true });
    const currentId = state.current ? stopId(state.current) : null;
    const queuedIds = Object.keys(state.seen ?? {}).map(stopId).filter((id) => id !== currentId);
    // focus-show may read at any moment; a rename never shows it a half-written file.
    const file = path.join(consoleHome(), FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, version: FOCUS_VERSION, currentId, queuedIds }));
    fs.renameSync(tmp, file);
  } catch {}
}

// Writes only the title and first-instruction caches over what is on disk now: a reply saved while the band was being drawn must not be undone.
export function saveTitles(titles, firsts = loadFocus().firsts, extra = {}) {
  saveFocus({ ...loadFocus(), titles, firsts, ...extra });
}

// The mod polls `console.mjs focus` every few seconds; a fresh poll means the console screen draws the focus band.
export function modsActive(state, now = Date.now()) {
  return now - (state.modsAt ?? 0) < MODS_TTL_MS;
}

// Only a session that loaded the console skill gets the band, not a spare session sharing its tab; a hit is kept so the long transcript is read once.
export function consoleSessionOk(sessionId, check = isConsoleSession) {
  if (!sessionId) return true;
  const state = loadFocus();
  if ((state.consoleSessions ?? []).includes(sessionId)) return true;
  if (!check(sessionId)) return false;
  saveFocus({ ...state, consoleSessions: [...(state.consoleSessions ?? []), sessionId].slice(-CONSOLE_SESSIONS_MAX) });
  return true;
}

// One band at a time draws and counts down: the newest one claims it, since a reloaded mod or a new console can leave the old band running.
// Another band takes over only once the owner has not polled for OWNER_TTL_MS, e.g. its window was closed.
export function focusOwnerOk(owner, { claim = false, now = Date.now() } = {}) {
  const state = loadFocus();
  const held = state.owner;
  const live = !!held && now - held.at < OWNER_TTL_MS;
  if (!owner) return !live;
  if (!claim && live && held.id !== owner) return false;
  saveFocus({ ...state, owner: { id: owner, at: now } });
  return true;
}

// One entry per stop that is your turn; a new stop of the same session gets a new key. A 已完成 stop with nothing left is closable, not your turn.
function focusEntries(rows, keepalive = readKeepalive()) {
  return pendingItems(rows)
    .filter((item) => item.kind !== "text" || awaitsUser(judgedStatus(item.session, keepalive), { row: item.row, session: item.session }))
    .map((item) => {
      const since = item.session.since ?? item.session.agent?.stateStartedAt ?? null;
      const kind = item.session.status.kind;
      const text = String(item.session.status.text ?? "");
      return {
        key: `${item.session.paneKey}@${since ?? `${kind}:${item.entries[0].question}`}`,
        paneKey: item.session.paneKey,
        handle: item.session.handle,
        tag: item.tag,
        kind,
        since,
        sheet: item.kind === "text" && (!!batchSheet(text) || isGateStop(text)),
        turn: yourTurn(item.row, item.session),
        item,
      };
    });
}

// A reply that came back within this long counts as a continued conversation.
export const RETURN_WINDOW_MS = 10 * 60_000;

// Tiers from the user's own records: ⚠️, a continued conversation, 🔐, the rest newest first, batch sheets and gate stops newest first, then what 8 put off.
// A stop that comes back after you replied to it on the band (or pressed 8 while waiting for it) is a continued conversation however late.
function rank(e, state) {
  const since = e.since ?? state.seen?.[e.key] ?? 0;
  if (e.kind === "anomaly") return [0, since];
  if (state.bumped?.[e.key]) return [5, state.bumped[e.key]];
  const back = state.back?.[e.key];
  if (back && (back.pin || since - (back.at ?? since) <= RETURN_WINDOW_MS)) return [1, since];
  if (e.kind === "permission") return [2, since];
  return [e.sheet ? 4 : 3, -since];
}

export function order(entries, state) {
  return [...entries].sort((a, b) => {
    const [x, y] = [rank(a, state), rank(b, state)];
    return x[0] - y[0] || x[1] - y[1];
  });
}

function sameSession(a, b) {
  return !!(a && b && ((a.paneKey && a.paneKey === b.paneKey) || (a.handle && a.handle === b.handle)));
}

const person = (s, at, extra = {}) => ({ paneKey: s.paneKey ?? null, handle: s.handle ?? null, tag: s.tag ?? null, at, ...extra });

// You replied to the stop on the band: the first other one in the queue comes up at once, or the band waits for this session with no time limit.
function afterReply(state, entries, who, at, text = null) {
  const open = order(entries.filter((e) => !state.answered.includes(e.key) && !sameSession(who, e)), state);
  const replied = [...(state.replied ?? []).filter((s) => !sameSession(s, who)), person(who, at, { text, pin: true })].slice(-REPLIED_MAX);
  const next = open[0] ?? null;
  if (next) return { ...state, replied, current: next.key, wait: null, sent: person(who, at, { text }) };
  return { ...state, replied, current: null, wait: person(who, at, { text }), sent: null };
}

// One poll: the current stop stays until you reply to it, put it off with 8, or it leaves; `sessions` is every session's kind and stop time,
// `hold` (a draft in the prompt, or the console's turn running) defers taking a new current stop.
export function focusStep(prev, entries, now = Date.now(), { sessions = [], hold = false } = {}) {
  const live = new Set(entries.map((e) => e.key));
  const keepLive = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => live.has(k)));
  const replied = prev.replied ?? [];
  const after = (s, e) => sameSession(s, e) && (s.at != null && e.since != null ? e.since >= s.at : !prev.seen?.[e.key]);
  const returned = entries.filter((e) => replied.some((s) => after(s, e)));
  const fresh = entries.filter((e) => !prev.seen?.[e.key]);
  const backOf = (e) => {
    const s = replied.find((r) => after(r, e));
    return { at: s.at ?? now, pin: !!s.pin };
  };
  let state = {
    ...prev,
    answered: (prev.answered ?? []).filter((k) => live.has(k)),
    reported: (prev.reported ?? []).filter((k) => live.has(k)),
    replied: replied.filter((s) => !returned.some((e) => sameSession(s, e))),
    back: { ...keepLive(prev.back), ...Object.fromEntries(returned.map((e) => [e.key, backOf(e)])) },
    bumped: keepLive(prev.bumped),
    seen: { ...keepLive(prev.seen), ...Object.fromEntries(fresh.map((e) => [e.key, now])) },
    sent: prev.sent && !returned.some((e) => sameSession(prev.sent, e)) ? prev.sent : null,
  };
  const open = () => order(entries.filter((e) => !state.answered.includes(e.key)), state);
  const sessionOf = (who) => sessions.find((s) => sameSession(s, who)) ?? null;
  if (state.current && !open().some((e) => e.key === state.current)) {
    const paneKey = state.current.slice(0, state.current.indexOf("@"));
    const s = sessionOf({ paneKey });
    // Answered in its own tab: it is working now, as after a reply here.
    state = s?.kind === "busy" ? afterReply(state, entries, s, now) : { ...state, current: null };
  }
  let wait = state.wait ?? null;
  let current = state.current ? open().find((e) => e.key === state.current) ?? null : null;
  if (!current && wait) {
    const back = open().find((e) => sameSession(wait, e) && (e.since == null || wait.at == null || e.since >= wait.at));
    const s = sessionOf(wait);
    if (back) {
      if (!hold) (current = back), (wait = null);
    } else if (!s || s.archived || (s.kind === "busy" && s.goal) || (s.kind !== "busy" && s.since != null && wait.at != null && s.since >= wait.at)) wait = null;
  }
  if (!current && !wait && !hold) current = open()[0] ?? null;
  if (current) wait = null;
  const key = current?.key ?? null;
  const currentAt = key && key !== prev.current ? now : state.currentAt ?? 0;
  const queue = open().filter((e) => e !== current);
  return { state: { ...state, wait, current: key, currentAt }, current, queue, wait };
}

// After a reply: the stop it answered is done with and a stop after it was sent counts as back.
// A reply to the stop on the band moves the band on (afterReply); one sent to another session by its tag leaves the band as it was.
export function focusReplied(prev, entries, sessions, now = Date.now()) {
  const backAt = (s) => entries.map((e) => sameSession(s, e) && prev.back?.[e.key]?.at).find((v) => typeof v === "number") ?? null;
  const sentAt = (s) => s.at ?? (prev.replied ?? []).find((r) => sameSession(r, s))?.at ?? backAt(s) ?? now;
  const answers = (e) => sessions.find((s) => sameSession(s, e));
  const done = entries.filter((e) => {
    const s = answers(e);
    const at = s && sentAt(s);
    return s && (e.since == null || at == null || e.since < at);
  });
  if (done.length === 0 && !sessions.length) return prev;
  let state = { ...prev, answered: [...new Set([...(prev.answered ?? []), ...done.map((e) => e.key)])], replied: prev.replied ?? [] };
  const onBand = (s) => done.some((e) => e.key === prev.current && sameSession(s, e)) || (!prev.current && (!prev.wait || sameSession(prev.wait, s)));
  for (const s of sessions) {
    const at = sentAt(s);
    if (onBand(s)) state = afterReply(state, entries, s, at, s.text ?? null);
    else state = { ...state, replied: [...state.replied.filter((r) => !sameSession(r, s)), person(s, at, { text: s.text ?? null })].slice(-REPLIED_MAX) };
  }
  return state;
}

// 8 on the band: the stop on screen goes behind everything else and the first one in the queue comes up;
// while the band waits for a session, the first one in the queue comes up and that session goes first when it is back.
export function focusSkip(prev, entries = [], now = Date.now()) {
  const open = (state) => order(entries.filter((e) => !(state.answered ?? []).includes(e.key)), state);
  if (prev.current) {
    const state = { ...prev, bumped: { ...prev.bumped, [prev.current]: now } };
    const next = open(state).find((e) => e.key !== prev.current);
    return next ? { ...state, current: next.key, wait: null } : prev;
  }
  if (prev.wait) {
    const next = open(prev)[0];
    if (!next) return prev;
    const replied = (prev.replied ?? []).map((r) => (sameSession(r, prev.wait) ? { ...r, pin: true } : r));
    return { ...prev, replied, current: next.key, wait: null };
  }
  return prev;
}

// Marks a stop as printed by /focus-show.
export function markReported(state, key) {
  return state.reported.includes(key) ? state : { ...state, reported: [...state.reported, key] };
}

function queueLine(n) {
  return n > 0 ? `還有 ${n} 題排隊` : null;
}

export function waitLine(view) {
  const tag = view.wait?.tag;
  return [tag ? `等 ${tag} 回應中…` : null, queueLine(view.queue.length)].filter(Boolean).join("　");
}

// Every session's kind and stop time, for the rules that watch a session leave or come back.
function sessionFacts(rows) {
  return rows.flatMap((row) =>
    row.sessions.map((s) => ({
      paneKey: s.paneKey,
      handle: s.handle,
      tag: sessionTag(row, s),
      kind: s.status.kind,
      since: s.since ?? s.agent?.stateStartedAt ?? null,
      goal: s.status.kind === "busy" && (!!s.status.goal || /^\s*\/goal\b/.test(String(s.agent?.prompt ?? s.status.text ?? ""))),
      archived: !!s.archived,
    })),
  );
}

// Loads the saved focus, applies `change` (a reply, 8), steps it over `rows` and saves it back.
// Only urgent questions reach the band: one the advisor is still judging, or has answered for the user, stays off it.
// `hold` comes from the mod's poll (a draft in the prompt, or the console's turn running); other callers keep the last one it saved.
export function syncFocus(rows, { now = Date.now(), change = null, heartbeat = false, hold = undefined } = {}) {
  let state = loadFocus();
  const entries = onBand(focusEntries(rows), rows, now);
  if (change) state = change(state, entries, now);
  if (hold !== undefined) state = { ...state, hold };
  const sessions = sessionFacts(rows);
  const view = focusStep(state, entries, now, { sessions, hold: !!state.hold });
  if (heartbeat) view.state.modsAt = now;
  saveFocus(view.state);
  // What the band takes up once the draft is cleared and the console's turn ends; never saved.
  if (state.hold) view.after = focusStep(view.state, entries, now, { sessions, hold: false });
  return view;
}

// Any failure here keeps every question on the band, so a judging bug never hides one.
function onBand(entries, rows, now) {
  try {
    const off = new Set(verdicts(rows, { now }).filter((v) => !v.verdict.band).map((v) => v.item.session));
    return entries.filter((e) => !off.has(e.item.session));
  } catch {
    return entries;
  }
}

const STATUS = Object.fromEntries(Object.entries(LABELS).map(([k, v]) => [k, [v.slice(0, v.indexOf(" ")), v.slice(v.indexOf(" ") + 1)]]));

// Option labels of a pending question, as the cards draw them.
function optionsOf(item) {
  const e = item.entries[0];
  if (["permission", "anomaly"].includes(item.kind) || item.entries.length > 1 || e.options === "—") return [];
  return e.options.split("／").filter((o) => o !== "其他").map((o) => o.replace(/^[a-z](?:\s|$)/, "").trim());
}

// How many decisions made without the user wait on this worktree's review; 0 when there are none or the records cannot be read.
function reviewCount(cache, target) {
  if (!cache.has(target)) {
    let n = 0;
    try {
      const wt = worktreeOf(target);
      n = wt ? stateOf(wt).open.filter((x) => x.status === "pending").length : 0;
    } catch {}
    cache.set(target, n);
  }
  return cache.get(target);
}

// A card's bottom right: the ticket title (a temporary worktree's task title), or per session when several share the worktree.
function cardSummary(row, session, title, firsts) {
  const plain = row.disposable?.title ?? (title && title !== "—" ? title : row.branch);
  if (row.sessions.length < 2) return plain;
  if (!session.task && !(session.paneKey in firsts)) {
    const first = firstInstruction(sessionTranscript(session.handle, row.path, session.agent?.prompt));
    if (first) firsts[session.paneKey] = first;
  }
  return sessionCaption(session, firsts[session.paneKey]) ?? plain;
}

// The tab's newest plain-language recap for the pane's recap dialog, only when it recaps the reply the card stopped at.
// Only herdr and the Herdr app read the stop time from the transcript entry replyAt comes from; Orca's own clock is not compared.
function briefOf(home, session, now) {
  const { text, pending, replyAt } = readSummary(home, session.handle, now);
  const since = session.since ?? session.agent?.stateStartedAt ?? null;
  const stale = !!session.agent?.herdr && typeof replyAt === "number" && typeof since === "number" && replyAt !== since;
  return { text: stale && !pending ? null : text, pending };
}

// The four-layer recap under a text stop's report, once the recap of that very stop is written; `pending` while it is being written.
export function stopDigestLines(session, { home = consoleHome(), now = Date.now() } = {}) {
  if (!session || !textStop(session.status, session)) return { lines: [], pending: false };
  const { text, pending } = stopDigest(home, session, now);
  return { lines: digestMarkdown(digestLayers(text)), pending: !text && pending };
}

// A stop's report as /focus-show and the watcher print it: the reply as is, then its recap at the bottom.
export function reportWithDigest(row, status, session, { again = false, home = consoleHome(), now = Date.now() } = {}) {
  return [...reportLines(row, status, session, { again }), ...reviewAppendix(row, status), ...stopDigestLines(session, { home, now }).lines];
}

// A define-goal or lean dev-flow batch sheet, and dev-flow's full path stopping with the prototype open, carry the worktree's review sheet:
// the user reviews both at the one stop.
export function reviewAppendix(row, status) {
  const text = String(status?.text ?? "");
  if (status?.kind !== "waiting" && status?.kind !== "done") return [];
  const sheet = batchSheet(text);
  if (!(sheet && sheetPath(row, text) !== "full") && !isLiveStop(text)) return [];
  try {
    const wt = worktreeOf(row.path);
    const st = wt ? stateOf(wt) : null;
    if (!st || st.open.length === 0 || sheetProblems(st.open).length) return [];
    return ["", "---", "", ...sheetLines({ tag: tagOf(wt, readNames()), wt, pr: null, open: st.open })];
  } catch {
    return [];
  }
}

function plainReport(tag, status) {
  const [icon, label] = STATUS[status.kind];
  return [`### ${icon} ${tag} ${label}`, "", `> ${lastActivity(status)}`];
}

const sameStop = (a, b) => !!(a && b && ((a.paneKey && a.paneKey === b.paneKey) || (a.handle && a.handle === b.handle)));

// The status band and pane's data: every session as a card, the stop on the band, the queue in order and the band's rows.
// `closables` lists the stops judged closable now, so the first time each is logged once.
export function focusPayload(rows, view, { now = Date.now(), home = consoleHome(), keys = new Set(), notice = null } = {}) {
  const items = new Map(pendingItems(rows).map((item) => [item.session, item]));
  const keyOf = new Map([view.current, ...view.queue].filter(Boolean).map((e) => [e.item.session, e.key]));
  const titles = { ...(view.state.titles ?? {}) };
  const live = new Set(rows.flatMap((row) => row.sessions.map((s) => s.paneKey)));
  const firsts = Object.fromEntries(Object.entries(view.state.firsts ?? {}).filter(([k]) => live.has(k)));
  const advice = loadAdvice(advisorHome(), now);
  const advisor = advice ? advisorState(advisorHome()) : null;
  const reviews = new Map();
  const delegated = readDelegated(home);
  const keepalive = readKeepalive();
  const logged = view.state.closables ?? {};
  const closables = {};
  const sessions = rows.flatMap((row) =>
    row.sessions.map((session) => {
      if (!(row.path in titles)) {
        fillTitle(row, keys);
        titles[row.path] = row.title;
      }
      const tag = sessionTag(row, session);
      const item = items.get(session);
      const status = session.status;
      const since = session.since ?? session.agent?.stateStartedAt ?? null;
      if (!session.archived && closable(row, session)) {
        const k = `${session.paneKey}@${since}`;
        closables[k] = logged[k] ?? now;
        if (!logged[k]) logEvent("stop", { ...stopFields(row, session), status: "closable", since });
      }
      const turn = yourTurn(row, { ...session, status: judgedStatus(session, keepalive) });
      const report = needsYou(status.kind) ? reportWithDigest(row, status, session, { home, now }) : plainReport(tag, status);
      const key = keyOf.get(session) ?? session.paneKey;
      return {
        key,
        id: stopId(key),
        tag,
        repo: row.repo,
        status: turn ? YOUR_TURN : STATUS[status.kind][1],
        stage: row.stage ?? "—",
        summary: cardSummary(row, session, titles[row.path], firsts),
        options: item ? optionsOf(item) : [],
        advice: item ? adviceFor(advice, { path: row.path, status, since, now, advisor }) : null,
        brief: briefOf(home, session, now),
        archived: !!session.archived,
        pending: !!item,
        report: report.join("\n"),
        branch: row.branch ?? "",
        path: row.path,
        review: reviewCount(reviews, row.path),
        autoReply: autoReplyOf(session, delegated),
      };
    }),
  );
  const cur = view.current;
  const card = cur ? sessions.find((s) => s.key === cur.key) : null;
  const sent = cur && view.state.sent && !sameStop(view.state.sent, cur) ? view.state.sent : null;
  const band = bandRows({
    current: cur ? { tag: cur.tag, kind: cur.kind === "done" && !cur.turn ? "done" : cur.kind } : null,
    wait: view.wait,
    queue: view.queue.length,
    groups: waitingGroups(rows, { delegated, keepalive, now, first: [cur, ...view.queue].filter(Boolean).map((e) => e.tag) }),
    advice: card?.advice ?? null,
    options: card?.options ?? [],
    guide: cur ? guideFor(readGuide(home), cur) : null,
    finished: cur ? finishedState(cur.item.row, cur.item.session.status) : null,
    sent,
    weekly: weeklyReport(advisorHome(), now),
  });
  return {
    payload: {
      active: true,
      home,
      current: cur?.key ?? null,
      notice,
      waiting: view.wait ? { tag: view.wait.tag } : null,
      queue: view.queue.map((e) => ({ key: e.key })),
      band,
      sessions,
    },
    titles,
    firsts,
    closables,
  };
}
