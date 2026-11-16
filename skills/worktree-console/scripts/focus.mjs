import fs from "node:fs";
import path from "node:path";
import { LABELS, batchSheet, readNames, textStop, textOptionLabels, consoleHome, fillTitle, firstInstruction, lastActivity, needsYou, pendingItems, recycledMark, reportLines, sessionCaption, sessionTag, sessionTranscript } from "./lib.mjs";
import { isConsoleSession } from "./log.mjs";
import { adviceFor, advisorHome, advisorState, loadAdvice } from "./advice.mjs";
import { readSummary, stopDigest } from "./summary.mjs";
import { digestLayers, digestMarkdown } from "../../../hooks/digest.mjs";
import { verdicts } from "./delegate.mjs";
import { sheetLines, sheetProblems, stateOf, tagOf, worktreeOf } from "./review.mjs";
import { isLiveStop, sheetPath } from "./urgency.mjs";

export const FOCUS_WAIT_MS = 60_000;
// How long a question that just reached the band waits for its recap before it prints without one.
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
  return { modsAt: 0, current: null, currentAt: 0, reported: [], wait: null, answered: [], replied: [], back: {}, bumped: {}, seen: {}, titles: {}, firsts: {} };
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
export function saveTitles(titles, firsts = loadFocus().firsts) {
  saveFocus({ ...loadFocus(), titles, firsts });
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

// One entry per pending session stop; a new stop of the same session gets a new key.
function focusEntries(rows) {
  return pendingItems(rows).map((item) => {
    const since = item.session.since ?? item.session.agent?.stateStartedAt ?? null;
    const kind = item.session.status.kind;
    return {
      key: `${item.session.paneKey}@${since ?? `${kind}:${item.entries[0].question}`}`,
      paneKey: item.session.paneKey,
      handle: item.session.handle,
      tag: item.tag,
      kind,
      since,
      item,
    };
  });
}

// Tiers, each first stopped first out: ⚠️, back after a reply, 🔐, the rest, then the skipped ones by when they were skipped.
function order(entries, state) {
  const tier = (e) => (e.kind === "anomaly" ? -1 : state.back?.[e.key] ? 0 : e.kind === "permission" ? 1 : 2);
  const rank = (e) => (state.bumped?.[e.key] ? [3, state.bumped[e.key]] : [tier(e), e.since ?? state.seen[e.key] ?? 0]);
  return [...entries].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1];
  });
}

// Picks the one question on screen: the session just answered gets up to 60 s to stop again before the queue moves on.
// `busy` holds sessions now working: one whose question left the screen that way was answered in its own tab, and gets the same wait.
export function focusStep(prev, entries, now = Date.now(), busy = []) {
  const live = new Set(entries.map((e) => e.key));
  const keepLive = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => live.has(k)));
  const replied = prev.replied ?? [];
  const after = (s, e) => sameSession(s, e) && (s.at != null && e.since != null ? e.since >= s.at : !prev.seen?.[e.key]);
  const returned = entries.filter((e) => replied.some((s) => after(s, e)));
  const fresh = entries.filter((e) => !prev.seen?.[e.key]);
  const state = {
    ...prev,
    answered: (prev.answered ?? []).filter((k) => live.has(k)),
    reported: (prev.reported ?? []).filter((k) => live.has(k)),
    replied: replied.filter((s) => !returned.some((e) => sameSession(s, e))),
    back: { ...keepLive(prev.back), ...Object.fromEntries(returned.map((e) => [e.key, replied.find((s) => after(s, e)).at ?? true])) },
    bumped: keepLive(prev.bumped),
    seen: { ...keepLive(prev.seen), ...Object.fromEntries(fresh.map((e) => [e.key, now])) },
  };
  const open = order(entries.filter((e) => !state.answered.includes(e.key)), state);
  let wait = state.wait && now < state.wait.until ? state.wait : null;
  const resumed = !wait && state.current && !live.has(state.current) ? busy.find((b) => state.current.startsWith(`${b.paneKey}@`)) : null;
  if (resumed) wait = { paneKey: resumed.paneKey, handle: resumed.handle ?? null, tag: resumed.tag ?? null, until: now + FOCUS_WAIT_MS };
  let current = null;
  if (wait) {
    current = open.find((e) => sameSession(wait, e)) ?? null;
    if (current) wait = null;
  } else current = open.find((e) => e.key === state.current) ?? open[0] ?? null;
  const key = current?.key ?? null;
  const currentAt = key && key !== state.current ? now : state.currentAt ?? 0;
  return { state: { ...state, wait, current: key, currentAt }, current, queue: open.filter((e) => e !== current), wait };
}

function sameSession(a, b) {
  return !!((a.paneKey && a.paneKey === b.paneKey) || (a.handle && a.handle === b.handle));
}

// After a reply: the stop it answered is done with, a stop after it was sent counts as back, and the focus waits for that session (the one on screen when several were answered).
export function focusReplied(prev, entries, sessions, now = Date.now()) {
  const backAt = (s) => entries.map((e) => sameSession(s, e) && prev.back?.[e.key]).find((v) => typeof v === "number") ?? null;
  const sentAt = (s) => s.at ?? (prev.replied ?? []).find((r) => sameSession(r, s))?.at ?? backAt(s);
  const answers = (e) => sessions.find((s) => sameSession(s, e));
  const done = entries.filter((e) => {
    const s = answers(e);
    const at = s && sentAt(s);
    return s && (e.since == null || at == null || e.since < at);
  });
  if (done.length === 0 && !sessions.length) return prev;
  const target = done.find((e) => e.key === prev.current) ?? done.at(-1) ?? null;
  const wanted = target ?? sessions.at(-1);
  const person = (s, by) => ({ paneKey: s.paneKey ?? null, handle: s.handle ?? null, at: sentAt(by) });
  const returned = (s) => entries.some((e) => sameSession(s, e) && prev.back?.[e.key] && !done.includes(e));
  const who = [...done.map((e) => person(e, answers(e))), ...sessions.filter((s) => !returned(s)).map((s) => person(s, s))];
  return {
    ...prev,
    answered: [...new Set([...(prev.answered ?? []), ...done.map((e) => e.key)])],
    replied: [...(prev.replied ?? []).filter((s) => !who.some((w) => sameSession(w, s))), ...who].slice(-REPLIED_MAX),
    current: null,
    wait: wanted ? { paneKey: wanted.paneKey ?? null, handle: wanted.handle ?? null, tag: wanted.tag ?? null, until: now + FOCUS_WAIT_MS, sentAt } : null,
  };
}

// 「延後處理」: the question on screen goes behind everything else and the first one in the queue comes up.
export function focusSkip(prev, now = Date.now()) {
  return { ...prev, wait: null, current: null, bumped: prev.current ? { ...prev.bumped, [prev.current]: now } : prev.bumped };
}

// A queue button or a pane card picked: that question goes on screen at once; the one it replaces counts as skipped unless it came back after a reply.
export function focusPick(prev, key, now = Date.now()) {
  const left = prev.current && prev.current !== key && !prev.back?.[prev.current] ? prev.current : null;
  return { ...prev, wait: null, current: key, bumped: left ? { ...prev.bumped, [left]: now } : prev.bumped };
}

// Marks a question as shown once the mod has printed it, so an automatic change never prints the same stop twice.
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

// Loads the saved focus, applies `change` (a reply, a pick), steps it over `rows` and saves it back.
// Only urgent questions reach the band: one the advisor is still judging, or has answered for the user, stays off it.
export function syncFocus(rows, { now = Date.now(), change = null, heartbeat = false } = {}) {
  let state = loadFocus();
  const entries = onBand(focusEntries(rows), rows, now);
  const busy = rows.flatMap((row) => row.sessions.filter((s) => s.status.kind === "busy").map((s) => ({ paneKey: s.paneKey, handle: s.handle, tag: sessionTag(row, s) })));
  if (change) state = change(state, entries, now);
  const view = focusStep(state, entries, now, busy);
  if (heartbeat) view.state.modsAt = now;
  saveFocus(view.state);
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

// A question that just reached the band holds its print while its recap is being written, up to DIGEST_WAIT_MS.
export function holdForDigest(view, { home = consoleHome(), now = Date.now() } = {}) {
  if (!view.current || now - (view.state.currentAt ?? 0) >= DIGEST_WAIT_MS) return false;
  return stopDigestLines(view.current.item.session, { home, now }).pending;
}

function plainReport(tag, status) {
  const [icon, label] = STATUS[status.kind];
  return [`### ${icon} ${tag} ${label}`, "", `> ${lastActivity(status)}`];
}

// The focus band's and pane's data: every session as a card, the question on screen, the queue in order and the counts.
export function focusPayload(rows, view, { now = Date.now(), home = consoleHome(), announce = null, announceKey = null, keys = new Set(), notice = null } = {}) {
  const items = new Map(pendingItems(rows).map((item) => [item.session, item]));
  const keyOf = new Map([view.current, ...view.queue].filter(Boolean).map((e) => [e.item.session, e.key]));
  const titles = { ...(view.state.titles ?? {}) };
  const live = new Set(rows.flatMap((row) => row.sessions.map((s) => s.paneKey)));
  const firsts = Object.fromEntries(Object.entries(view.state.firsts ?? {}).filter(([k]) => live.has(k)));
  const advice = loadAdvice(advisorHome(), now);
  const advisor = advice ? advisorState(advisorHome()) : null;
  const reviews = new Map();
  const sessions = rows.flatMap((row) =>
    row.sessions.map((session) => {
      if (!(row.path in titles)) {
        fillTitle(row, keys);
        titles[row.path] = row.title;
      }
      const tag = sessionTag(row, session);
      const item = items.get(session);
      const status = session.status;
      const question = recycledMark(
        session,
        item ? (item.entries.length > 1 ? item.entries.map((x) => x.question).join(" / ") : item.entries[0].question) : status.kind === "idle" ? "（閒置）" : lastActivity(status),
      );
      const report = needsYou(status.kind) ? reportWithDigest(row, status, session, { home, now }) : plainReport(tag, status);
      const key = keyOf.get(session) ?? session.paneKey;
      return {
        key,
        id: stopId(key),
        tag,
        repo: row.repo,
        status: STATUS[status.kind][1],
        stage: row.stage ?? "—",
        summary: cardSummary(row, session, titles[row.path], firsts),
        question,
        options: item ? optionsOf(item) : [],
        advice: item ? adviceFor(advice, { path: row.path, status, since: session.since ?? session.agent?.stateStartedAt, now, advisor }) : null,
        brief: briefOf(home, session, now),
        archived: !!session.archived,
        pending: !!item,
        report: report.join("\n"),
        branch: row.branch ?? "",
        path: row.path,
        review: reviewCount(reviews, row.path),
      };
    }),
  );
  const count = (label) => sessions.filter((s) => !s.archived && s.status === label).length;
  const since = view.state.currentAt ?? 0;
  return {
    payload: {
      active: true,
      home,
      current: view.current?.key ?? null,
      announce,
      announceKey,
      notice,
      waiting: view.wait ? { tag: view.wait.tag, seconds: Math.max(0, Math.ceil((view.wait.until - now) / 1000)) } : null,
      queue: view.queue.map((e) => ({ key: e.key, isNew: (view.state.seen?.[e.key] ?? 0) > since })),
      stats: `${count(STATUS.anomaly[1]) ? `session 異常 ${count(STATUS.anomaly[1])} | ` : ""}等待回應 ${count("等待回應")} | 等待授權 ${count("等待授權")} | 回覆完畢 ${count("回覆完畢")} | 執行中 ${count("執行中")} | 封存 ${sessions.filter((s) => s.archived).length} | 閒置 ${count("閒置")}`,
      sessions,
    },
    titles,
    firsts,
  };
}
