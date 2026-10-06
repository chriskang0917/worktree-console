#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOTIFICATION, SKIP_PROMPT, archiveDir, ensureLogRepo, promptText, readEntries, readEvents } from "./log.mjs";

export const SCENES = { A: "有未 commit 的改動", B: "已 commit、還沒合進 base", C: "已合進 base", D: "問定稿", E: "問開始" };
export const CHOICE = "選擇題";
const DAY = 24 * 3600 * 1000;
export const WINDOW_MS = 30 * DAY;
export const PROPOSE_AT = 3;
const SHOW_AT = 3;
const FILE = "memory.md";
const STATE = path.join(".state", "memory.json");
const CACHE = path.join(".state", "memory-prompts.json");
const SCENE_CACHE = path.join(".state", "memory-scenes.json");
const PLAN_DIR = ":(top,exclude)docs/dev-flow";
const ROUND_MAX_MS = 10 * 60 * 1000;

// Order is the order a label lists them in; rebase and 升版 are steps taken first, never a different way of doing it.
const KEYWORDS = [
  ["commit", /commit|提交/gi],
  ["rebase", /rebase/gi],
  ["升版", /處理版本|升版|升級版本|版號|版本|bump/gi],
  ["squash", /squash(?:\s*merge)?|merge(?:\s*back)?|合併|合進/gi],
  ["push", /push/gi],
  ["關閉", /關閉|關掉|收工|close/gi],
  ["定稿", /定稿/gi],
  ["開工", /開工|開始/gi],
];
const PREREQ = new Set(["rebase", "升版"]);
const GIT_STEPS = new Set(["commit", "rebase", "升版", "squash", "push", "關閉"]);
const FILLER_WORDS = new Set(["完成", "然後", "並且", "之後", "本機", "一起", "依序", "幫我", "這個", "worktree", "session", "branch", "main", "master", "back", "into", "to", "後", "完", "再", "並", "先", "回", "進", "到", "把", "就", "都", "了", "吧", "也"]);
const MARK = "\u0001";
const FILLER_PHRASES = /完成|然後|並且|之後|本機|一起|依序|幫我|這個/g;
const GLUE = /[後完再並先回進到把就都了吧也]+(?=\s*\u0001)|(?<=\u0001\s*)[後完再並先回進到把就都了吧也]+/g;
const AGREE = /^(照建議|依建議|用建議|照這樣回?|照它的?建議|好|好的|可以|OK|同意|沒問題|要)[。！!.]?$/i;
const CODE = /^\**\s*([A-Za-z]|\d{1,2})(?![A-Za-z0-9])/;

const logDir = () => path.dirname(archiveDir());
export const memoryFile = () => path.join(logDir(), FILE);

function git(cwd, args) {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: res.status === 0, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch {}
}

// ---- what a reply says ----

// { decisions, unknown }: the keywords found, in table order, and the words left over that are neither a keyword nor filler.
export function classify(text) {
  let rest = ` ${String(text ?? "")} `;
  const found = new Set();
  for (const [name, re] of KEYWORDS) {
    rest = rest.replace(re, () => {
      found.add(name);
      return MARK;
    });
  }
  const unknown = rest
    .replace(FILLER_PHRASES, " ")
    .replace(GLUE, "")
    .split(/[\s\u0001，,。、；;：:！!？?（）()「」.\-—…]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !FILLER_WORDS.has(w.toLowerCase()));
  return { decisions: KEYWORDS.map(([n]) => n).filter((n) => found.has(n)), unknown };
}

// The way of doing it: the decisions without the steps taken first.
export function wayKey(decisions) {
  return decisions.filter((d) => !PREREQ.has(d)).join("+");
}

export const wayLabel = (key) => key.split("+").join("、");

// ---- which scene a session is in ----

function defaultBase(dir) {
  const head = git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const name = head.ok ? head.out.replace(/^origin\//, "") : null;
  return [...new Set([name, "main", "master"].filter(Boolean))];
}

function bases(dir, baseRef) {
  const names = [];
  const add = (n) => n && !names.includes(n) && git(dir, ["rev-parse", "--verify", "--quiet", `${n}^{commit}`]).ok && names.push(n);
  const want = baseRef ? [baseRef.replace(/^origin\//, "")] : [];
  for (const n of [...want, ...defaultBase(dir)]) {
    add(n);
    add(`origin/${n}`);
  }
  return names;
}

// Merging `head` into `base` would change nothing: a squash or plain merge already brought it in.
function alreadyIn(dir, base, head) {
  const merged = git(dir, ["merge-tree", "--write-tree", base, head]);
  if (!merged.ok) return false;
  return merged.out.split("\n")[0] === git(dir, ["rev-parse", `${base}^{tree}`]).out;
}

function mergedAsParent(dir, base, head) {
  return git(dir, ["rev-list", "--merges", "--parents", "-n", "200", base]).out.split("\n").some((l) => l.split(" ").slice(2).includes(head));
}

// A (uncommitted changes), B (commits not in base yet), C (all of it in base), or null.
export function gitScene(dir, baseRef = null) {
  if (!dir || !fs.existsSync(dir)) return null;
  if (!git(dir, ["rev-parse", "--git-dir"]).ok) return null;
  if (git(dir, ["status", "--porcelain", "--untracked-files=all", "--", ":(top)", PLAN_DIR]).out) return "A";
  const list = bases(dir, baseRef);
  if (list.length === 0) return null;
  const head = git(dir, ["rev-parse", "HEAD"]).out;
  return sceneOfCommits(dir, list, head);
}

function sceneOfCommits(dir, list, head) {
  if (!head) return null;
  const ahead = Number(git(dir, ["rev-list", "--count", `${list[0]}..${head}`, "--", ":(top)", PLAN_DIR]).out || 0);
  if (ahead > 0) return list.some((b) => alreadyIn(dir, b, head)) ? "C" : "B";
  return list.some((b) => mergedAsParent(dir, b, head)) ? "C" : null;
}

function refAt(dir, ref, iso) {
  const at = git(dir, ["rev-parse", "--verify", "--quiet", `${ref}@{${iso}}`]);
  if (at.ok && !/only goes back/.test(at.err)) return at.out;
  return git(dir, ["rev-list", "-1", `--before=${iso}`, ref]).out || null;
}

// The scene at a past moment, from the reflogs: uncommitted work is not in git, so a branch with nothing ahead
// then that committed afterwards counts as A.
export function sceneAt(main, branch, iso) {
  if (!main || !branch || !fs.existsSync(main)) return null;
  if (!git(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) return null;
  const list = defaultBase(main).filter((n) => git(main, ["rev-parse", "--verify", "--quiet", `${n}^{commit}`]).ok);
  if (list.length === 0) return null;
  const head = refAt(main, branch, iso);
  const then = list.map((b) => refAt(main, b, iso)).filter(Boolean);
  if (!head || then.length === 0) return null;
  const scene = sceneOfCommits(main, then, head);
  if (scene) return scene;
  const later = git(main, ["reflog", "show", "--format=%gd %gs", "--date=iso-strict", branch]).out.split("\n");
  return later.some((l) => / commit/.test(l) && (l.match(/@\{([^}]+)\}/)?.[1] ?? "") > iso) ? "A" : null;
}

// The scene of a pending item on the reply list; null for a one-off question.
export function itemScene(item) {
  const kind = item?.session?.status?.kind;
  if (!kind || kind === "permission") return null;
  if (kind === "done") return gitScene(item.row?.path, item.row?.baseRef ?? null);
  const question = (item.entries ?? []).map((e) => e.question).join(" ");
  if (/定稿/.test(question)) return "D";
  if (/開始|開工/.test(question)) return "E";
  return (item.entries ?? []).some((e) => e.suggest && e.suggest !== "—") ? CHOICE : null;
}

// ---- what you typed in the console ----

const baseTag = (t) => String(t ?? "").replace(/#\d+$/, "");

function sameTicket(a, b) {
  const x = baseTag(a).toUpperCase();
  const y = baseTag(b).toUpperCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = /^\d+$/.test(x) ? [x, y] : /^\d+$/.test(y) ? [y, x] : [null, null];
  return !!short && long.endsWith(`-${short}`);
}

function consoleTranscripts(events) {
  const out = new Map();
  for (const e of events.filter((e) => e.event === "session" && e.role === "console" && e.sessionId)) {
    const copy = path.join(archiveDir(), `${e.sessionId}.jsonl`);
    const own = e.transcript && fs.existsSync(e.transcript) ? e.transcript : null;
    const file = own ?? (fs.existsSync(copy) ? copy : null);
    if (file) out.set(e.sessionId, file);
  }
  return [...out.values()];
}

function isTyped(text) {
  return !SKIP_PROMPT.test(text) && !NOTIFICATION.test(text) && !/<command-name>|<local-command|<system-reminder>/.test(text);
}

// What you typed into every console, cached by file size and time so a 5-second poll does not reread them.
export function consolePrompts(events = readEvents()) {
  const cacheFile = path.join(logDir(), CACHE);
  const cache = readJson(cacheFile, {});
  const next = {};
  const out = [];
  for (const file of consoleTranscripts(events)) {
    let sig;
    try {
      const st = fs.statSync(file);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      continue;
    }
    let prompts = cache[file]?.sig === sig ? cache[file].prompts : null;
    if (!prompts) {
      prompts = [];
      for (const e of readEntries(file) ?? []) {
        if (e.isSidechain || !e.timestamp) continue;
        const text = promptText(e);
        if (text !== null && text.trim()) prompts.push({ ts: e.timestamp, text: text.trim(), typed: isTyped(text) });
      }
    }
    next[file] = { sig, prompts };
    out.push(...prompts);
  }
  if (JSON.stringify(Object.keys(next).map((k) => next[k].sig)) !== JSON.stringify(Object.keys(next).map((k) => cache[k]?.sig))) writeJson(cacheFile, next);
  const seen = new Set();
  return out.sort((a, b) => a.ts.localeCompare(b.ts)).filter((p) => !seen.has(`${p.ts}\u0000${p.text}`) && seen.add(`${p.ts}\u0000${p.text}`));
}

const CLOSE_HEAD = /^(?:關掉|關閉)\s*(\S+)\s*$/;

// One part of a message: the ticket it names (`<代號> …` or `關掉 <代號>`) and the rest.
function splitPart(part, tickets) {
  const t = part.trim();
  const close = t.match(CLOSE_HEAD);
  if (close && tickets.some((k) => sameTicket(k, close[1]))) return { ticket: tickets.find((k) => sameTicket(k, close[1])), text: "關閉" };
  const m = t.match(/^(\S+)\s*([\s\S]*)$/);
  if (m && tickets.some((k) => sameTicket(k, m[1]))) return { ticket: tickets.find((k) => sameTicket(k, m[1])), text: m[2].trim() };
  return { ticket: null, text: t };
}

function sitesOf(events) {
  const sites = new Map();
  for (const e of events) {
    if (!e.ticket || e.ticket === "中控台") continue;
    const key = baseTag(e.ticket);
    const s = sites.get(key) ?? { ticket: key, repo: null, path: null, sessions: new Set(), transcripts: new Set() };
    if (e.repo) s.repo = e.repo;
    if (e.path) s.path = e.path;
    for (const id of [e.sessionId, ...(e.sessionIds ?? []), e.oldSessionId, e.newSessionId]) if (id) s.sessions.add(id);
    if (e.transcript) s.transcripts.add(e.transcript);
    sites.set(key, s);
  }
  return sites;
}

function lastBranch(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return [...new Set([...text.matchAll(/"gitBranch":"([^"]+)"/g)].map((m) => m[1]))].reverse();
}

// Main checkout and branch a ticket ran on, even after its worktree was removed.
function whereRan(site, managed) {
  if (!site) return null;
  let main = null;
  let branch = null;
  if (site.path && fs.existsSync(site.path)) {
    const common = git(site.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.ok) main = path.dirname(common.out);
    branch = git(site.path, ["branch", "--show-current"]).out || null;
  }
  if (!main) main = (managed?.repos ?? []).find((r) => r.name === site.repo)?.main ?? null;
  if (!main) return null;
  if (!branch) {
    const files = [...site.transcripts, ...[...site.sessions].map((id) => path.join(archiveDir(), `${id}.jsonl`))];
    for (const f of files) {
      branch = lastBranch(f).find((b) => git(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).ok) ?? null;
      if (branch) break;
    }
  }
  return branch ? { main, branch } : null;
}

// A question answered with a git step (squash, 關閉…) is a flow gate all the same, so its scene comes from git.
function pastScene(stop, at, site, managed, memo, decisions) {
  if (!stop) return null;
  if (stop.status === "waiting" && /定稿/.test(stop.question ?? "")) return "D";
  if (stop.status === "waiting" && /開始|開工/.test(stop.question ?? "")) return "E";
  if (stop.status !== "done" && !decisions.some((d) => GIT_STEPS.has(d))) return null;
  if (stop.scene !== undefined) return stop.scene;
  const id = `${site?.repo}/${site?.ticket}`;
  if (!(id in memo.where)) memo.where[id] = whereRan(site, managed);
  const where = memo.where[id];
  if (!where) return null;
  const key = `${where.main}|${where.branch}|${at}`;
  if (!(key in memo.scene)) {
    const scene = sceneAt(where.main, where.branch, new Date(at).toISOString());
    if (scene || Date.now() - at > DAY) memo.scene[key] = scene;
    else return null;
  }
  return memo.scene[key];
}

// Past scenes never change once found (an A only gains later commits), so they are kept between runs.
function sceneMemo() {
  const saved = readJson(path.join(logDir(), SCENE_CACHE), {});
  return { where: {}, scene: saved.scene ?? {}, size: Object.keys(saved.scene ?? {}).length };
}

const landed = (e) => e.event === "close" || /^(delivered|queued)$/.test(e.delivery ?? "");

// Your replies to flow gates, one per stop: parts of your console messages sent to the same session before it
// stopped again are one reply, and a 關閉 right after the stop that reply caused joins it too.
export function flowReplies({ events = readEvents(), prompts = consolePrompts(events), managed = null } = {}) {
  const sites = sitesOf(events);
  const tickets = [...sites.keys()];
  const stops = events.filter((e) => e.event === "stop");
  const acts = events.filter((e) => (e.event === "answer" || e.event === "close") && landed(e));
  const typed = prompts.filter((p) => p.typed);
  const parts = [];
  typed.forEach((p, i) => {
    const start = Date.parse(p.ts);
    const end = Math.min(typed[i + 1] ? Date.parse(typed[i + 1].ts) : Infinity, start + ROUND_MAX_MS);
    const window = acts.filter((e) => Date.parse(e.ts) >= start && Date.parse(e.ts) < end);
    const sentTo = [...new Set(window.map((e) => baseTag(e.ticket)))];
    for (const raw of p.text.split(/[；;\n]/)) {
      if (!raw.trim()) continue;
      const { ticket, text } = splitPart(raw, tickets);
      const target = ticket ? baseTag(ticket) : sentTo.length === 1 ? sentTo[0] : null;
      if (!target || !text) continue;
      if (!ticket && !window.some((e) => sameTicket(e.ticket, target))) continue;
      parts.push({ ts: Date.parse(p.ts), ticket: target, text });
    }
  });
  const stopsOf = (ticket, from, to) => stops.filter((s) => sameTicket(s.ticket, ticket) && Date.parse(s.ts) > from && Date.parse(s.ts) < to).length;
  const memo = sceneMemo();
  const open = new Map();
  const out = [];
  for (const part of parts) {
    const c = classify(part.text);
    const prev = open.get(part.ticket);
    const between = prev ? stopsOf(part.ticket, prev.last, part.ts) : Infinity;
    const closeOnly = c.decisions.length === 1 && c.decisions[0] === "關閉" && c.unknown.length === 0;
    if (prev && (between === 0 || (closeOnly && between <= 1 && prev.decisions.length > 0))) {
      prev.last = part.ts;
      prev.texts.push(part.text);
      prev.decisions = KEYWORDS.map(([n]) => n).filter((n) => prev.decisions.includes(n) || c.decisions.includes(n));
      prev.unknown.push(...c.unknown);
      continue;
    }
    const stop = stops.filter((s) => sameTicket(s.ticket, part.ticket) && Date.parse(s.ts) < part.ts).at(-1) ?? null;
    const scene = pastScene(stop, part.ts, sites.get(part.ticket), managed, memo, c.decisions);
    const reply = { ts: part.ts, last: part.ts, ticket: part.ticket, scene, texts: [part.text], decisions: c.decisions, unknown: [...c.unknown] };
    open.set(part.ticket, reply);
    out.push(reply);
  }
  if (Object.keys(memo.scene).length !== memo.size) writeJson(path.join(logDir(), SCENE_CACHE), { scene: memo.scene });
  return out
    .filter((r) => r.scene && SCENES[r.scene])
    .map((r) => ({ ts: r.ts, ticket: r.ticket, scene: r.scene, text: r.texts.join("，"), decisions: r.decisions, key: wayKey(r.decisions), unknown: r.unknown }));
}

const codeOf = (text) => String(text ?? "").trim().match(CODE)?.[1]?.toUpperCase() ?? null;
const TOOK = /照你的?(建議|版本|分組|定的|說的)|照建議|依建議/;
const AGREEING = /^(可以|OK|好|同意|對|沒問題|要)(?![^\s，,。：:；;]*不)/i;

// The child's suggestion taken: an agreeing word, 「照你的建議」, the same option code, or the suggestion's own words.
export function tookSuggestion(answer, suggestion) {
  const a = String(answer ?? "").trim();
  const s = String(suggestion ?? "").replace(/\*\*/g, "").trim();
  if (!a || !s) return false;
  if (AGREE.test(a) || TOOK.test(a) || AGREEING.test(a)) return true;
  const want = /^([A-Za-z]|\d{1,2})(?:$|[\s、，,。:：.)）＋+])/.test(s) ? codeOf(s) : null;
  const said = codeOf(a.length <= 3 ? a : "") ?? a.match(/選\s*([A-Za-z]|\d{1,2})(?![A-Za-z0-9])/)?.[1]?.toUpperCase() ?? null;
  if (want) return said === want || a.toUpperCase().startsWith(s.toUpperCase());
  return Array.from(s).length >= 2 && a.startsWith(Array.from(s).slice(0, 6).join(""));
}

// Answers to questions that came with the child's own suggestion, and whether you took it.
export function choiceReplies(events = readEvents()) {
  return events
    .filter((e) => e.event === "answer" && e.suggestion && landed(e) && (e.via === "text" || e.via === "menu"))
    .map((e) => ({ ts: Date.parse(e.ts), ticket: baseTag(e.ticket), followed: e.via === "menu" ? e.offSuggestion === false : tookSuggestion(e.answer, e.suggestion) }));
}

// ---- memory.md ----

const NOTE = /\s*[（(][^（）()]*[）)]\s*$/;

// Sections `## <letter> <說明>`, one entry per `- ` line; an entry with no scene letter or no keyword is left alone.
export function readMemory(file = memoryFile()) {
  let text = "";
  let mtime = 0;
  try {
    text = fs.readFileSync(file, "utf8");
    mtime = fs.statSync(file).mtimeMs;
  } catch {}
  const lines = text.split("\n");
  const entries = [];
  let scene = null;
  lines.forEach((line, i) => {
    const head = line.match(/^##\s+(.*)$/);
    if (head) {
      scene = head[1].trim().match(/^([A-Z])(?![A-Za-z0-9])/)?.[1] ?? null;
      return;
    }
    if (!/^\s*-\s+\S/.test(line)) return;
    const body = line.replace(/^\s*-\s+/, "");
    const say = body.replace(NOTE, "").trim();
    const key = wayKey(classify(say).decisions);
    const date = body.match(/記住\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    entries.push({ line: i, scene: scene && SCENES[scene] ? scene : null, text: say, key, date, readable: !!(scene && SCENES[scene] && key) });
  });
  return { text, lines, entries, mtime };
}

function commitMemory(message) {
  const dir = ensureLogRepo();
  git(dir, ["add", FILE]);
  spawnSync("git", ["-C", dir, "-c", "user.name=worktree-console", "-c", "user.email=worktree-console@localhost", "commit", "-q", "-m", message, "--", FILE], { encoding: "utf8" });
}

function writeMemory(lines) {
  ensureLogRepo();
  fs.writeFileSync(memoryFile(), lines.join("\n"));
}

const today = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function addEntry(scene, key, now, count) {
  const mem = readMemory();
  const lines = mem.text ? [...mem.lines] : ["# 回覆習慣", ""];
  while (lines.length && lines.at(-1) === "") lines.pop();
  const entry = `- ${wayLabel(key)}（記住 ${today(now)}，30 天內 ${count} 次）`;
  let at = lines.findIndex((l) => l.match(/^##\s+(.*)$/)?.[1].trim().match(/^([A-Z])(?![A-Za-z0-9])/)?.[1] === scene);
  if (at < 0) {
    lines.push("", `## ${scene} ${SCENES[scene]}`);
    at = lines.length - 1;
  }
  let end = at + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  while (end > at + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, entry);
  writeMemory([...lines, ""]);
  commitMemory(`memory: 記住 ${scene} ${wayLabel(key)}`);
}

function readState() {
  return { declines: [], resets: [], remembered: [], ...readJson(path.join(logDir(), STATE), {}) };
}

const saveState = (s) => writeJson(path.join(logDir(), STATE), s);

// When an entry counts from: the exact time it was remembered here, else the end of its date, else the file's time.
function entrySince(entry, state, mtime) {
  const exact = state.remembered.filter((r) => r.scene === entry.scene && r.key === entry.key).at(-1)?.at;
  if (exact) return exact;
  if (entry.date) return Date.parse(`${entry.date}T23:59:59`);
  return mtime;
}

// A reply with a different way of doing it removes that scene's entries, which then build up again from short-term.
function dropOverruled(replies, state) {
  const mem = readMemory();
  const gone = [];
  for (const entry of mem.entries.filter((e) => e.readable)) {
    const since = entrySince(entry, state, mem.mtime);
    const other = replies.find((r) => r.scene === entry.scene && r.key && r.key !== entry.key && r.ts > since);
    if (other) gone.push({ entry, at: other.ts });
  }
  if (gone.length === 0) return state;
  const drop = new Set(gone.map((g) => g.entry.line));
  writeMemory(mem.lines.filter((_, i) => !drop.has(i)));
  commitMemory(`memory: 移除 ${gone.map((g) => `${g.entry.scene} ${g.entry.text}`).join("；")}（改回了別的做法）`);
  const next = { ...state, resets: [...state.resets, ...gone.map((g) => ({ scene: g.entry.scene, at: g.at }))] };
  saveState(next);
  return next;
}

// ---- habits ----

const after = (list, scene, key = null) =>
  Math.max(0, ...list.filter((x) => x.scene === scene && (key === null || x.key === key)).map((x) => x.at));

// Counts of each way in the last 30 days for a scene, from the last reset on; `declined` also starts after a 不記.
function counts(replies, state, scene, now, { declined = false } = {}) {
  const from = Math.max(now - WINDOW_MS, after(state.resets, scene));
  const hits = replies.filter((r) => r.scene === scene && r.key && r.ts >= from && r.ts <= now);
  const by = new Map();
  for (const r of hits) {
    if (declined && r.ts < after(state.declines, scene, r.key)) continue;
    const c = by.get(r.key) ?? { key: r.key, n: 0, last: null };
    c.n++;
    c.last = r;
    by.set(r.key, c);
  }
  return { list: [...by.values()].sort((a, b) => b.n - a.n || b.last.ts - a.last.ts), latest: hits.at(-1) ?? null };
}

// The way to suggest remembering for a scene: the latest reply's way, done 3 times in 30 days, not remembered yet.
function proposal(replies, state, mem, scene, now) {
  const { list, latest } = counts(replies, state, scene, now, { declined: true });
  if (!latest) return null;
  const hit = list.find((c) => c.key === latest.key);
  if (!hit || hit.n < PROPOSE_AT) return null;
  if (mem.entries.some((e) => e.readable && e.scene === scene && e.key === hit.key)) return null;
  return hit;
}

export function loadMemory({ now = Date.now(), events = null, managed = null } = {}) {
  const evs = events ?? readEvents();
  let replies = [];
  try {
    replies = flowReplies({ events: evs, managed: managed ?? readJson(path.join(logDir(), ".state", "managed.json"), null) });
  } catch {}
  let state = readState();
  try {
    state = dropOverruled(replies, state);
  } catch {}
  return { now, replies, choices: choiceReplies(evs), state, mem: readMemory() };
}

let shared = null;

// One read per few seconds for every caller in a process: the watcher lives for hours, a command for a moment.
export function forgetMemoryContext() {
  shared = null;
}

export function memoryContext(now = Date.now()) {
  if (shared && now - shared.now < 5_000) return shared;
  try {
    shared = loadMemory({ now });
  } catch {
    shared = { now, replies: [], choices: [], state: readState(), mem: readMemory() };
  }
  return shared;
}

// What you usually answer here, copied from your own past replies: { text, basis, short } or null.
export function habitFor(ctx, item, scene = itemScene(item)) {
  if (!scene) return null;
  if (scene === CHOICE) {
    const recent = ctx.choices.filter((c) => c.ts >= ctx.now - WINDOW_MS);
    if (recent.length === 0) return null;
    const m = recent.filter((c) => c.followed).length;
    const pick = (item.entries ?? [])[0]?.suggest?.match(/^([a-z])(?:\s|$)/)?.[1] ?? null;
    const mostly = m * 2 >= recent.length;
    return {
      text: mostly ? `照建議${pick ? ` ${pick}` : ""}` : "多半自己回",
      basis: `最近 30 天 ${recent.length} 次有 ${m} 次照建議`,
      short: `30 天 ${recent.length} 次有 ${m} 次照建議`,
    };
  }
  const entry = ctx.mem.entries.find((e) => e.readable && e.scene === scene);
  if (entry) {
    const since = entrySince(entry, ctx.state, ctx.mem.mtime);
    return { text: entry.text, basis: `長期記憶，${entry.date ?? today(since)} 記住`, short: "長期記憶" };
  }
  const top = counts(ctx.replies, ctx.state, scene, ctx.now).list[0];
  if (!top || top.n < SHOW_AT) return null;
  return { text: wayLabel(top.key), basis: `你最近 30 天回過 ${top.n} 次`, short: `近 30 天 ${top.n} 次` };
}

// The list cell keeps the basis short.
export const habitCell = (h) => (h ? `${h.text}（${h.short ?? h.basis}）` : "—");

// The four lines asking to remember a 3-times way for one scene; none when that scene has nothing to ask.
export function proposalLines(ctx, scene) {
  const p = SCENES[scene] ? proposal(ctx.replies, ctx.state, ctx.mem, scene, ctx.now) : null;
  if (!p) return [];
  return [
    "要記住這個習慣嗎？",
    `(${scene}) ${SCENES[scene]} 時，你 30 天內 ${p.n} 次都回「${wayLabel(p.key)}」`,
    "",
    `輸入「記住 ${scene}」記下來，「不記 ${scene}」略過`,
  ];
}

// Every scene's ask, a blank line between two, for the bottom of the reply list and the board.
export function memoryNotes(ctx) {
  return Object.keys(SCENES)
    .map((scene) => proposalLines(ctx, scene))
    .filter((lines) => lines.length > 0)
    .flatMap((lines, i) => (i === 0 ? lines : ["", ...lines]));
}

// Entries the script cannot read, shown only under 狀態.
export function unreadableNotes(ctx) {
  const bad = ctx.mem.entries.filter((e) => !e.readable).length;
  return bad > 0 ? [`memory.md 有 ${bad} 條看不懂（沒有情境字母或認得的關鍵字），腳本不改不刪`] : [];
}

// 記住 <字母>: the proposed way goes into memory.md and is committed.
export function remember(scene, now = Date.now()) {
  const ctx = loadMemory({ now });
  const p = SCENES[scene] ? proposal(ctx.replies, ctx.state, ctx.mem, scene, now) : null;
  if (!p) return `[記憶] ${scene} 目前沒有要記住的做法`;
  addEntry(scene, p.key, now, p.n);
  saveState({ ...ctx.state, remembered: [...ctx.state.remembered, { scene, key: p.key, at: now }] });
  return `[記憶] 已記住 ${scene}：${wayLabel(p.key)}`;
}

// 不記 <字母>: nothing is written; that way counts again from now and is asked again after 3 more.
export function decline(scene, now = Date.now()) {
  const ctx = loadMemory({ now });
  const p = SCENES[scene] ? proposal(ctx.replies, ctx.state, ctx.mem, scene, now) : null;
  if (!p) return `[記憶] ${scene} 目前沒有要記住的做法`;
  saveState({ ...ctx.state, declines: [...ctx.state.declines, { scene, key: p.key, at: now }] });
  return `[記憶] 這次不記 ${scene}，同樣做法再 ${PROPOSE_AT} 次才再問`;
}

// ---- replay ----

function table(head, rows) {
  if (rows.length === 0) return ["（沒有資料）"];
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`)];
}

const stamp = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};

// Every past reply run through the same rules: ways per scene, the suggestion rate, and the replies not recognised.
export function replayLines({ events = readEvents(), managed = readJson(path.join(logDir(), ".state", "managed.json"), null) } = {}) {
  const replies = flowReplies({ events, managed });
  const out = ["### 各情境做法次數", ""];
  const rows = [];
  for (const scene of Object.keys(SCENES)) {
    const by = new Map();
    for (const r of replies.filter((r) => r.scene === scene)) by.set(r.key, [...(by.get(r.key) ?? []), r]);
    for (const [key, list] of [...by].sort((a, b) => b[1].length - a[1].length)) {
      rows.push([`${scene} ${SCENES[scene]}`, key ? wayLabel(key) : "（認不出）", list.length, list.map((r) => `${r.ticket} ${stamp(r.ts)}`).join("、")]);
    }
  }
  out.push(...table(["情境", "做法", "次數", "代號與日期"], rows), "");
  const choices = choiceReplies(events);
  out.push("### 選擇題", "", `有建議的回覆 ${choices.length} 次，照建議 ${choices.filter((c) => c.followed).length} 次`, "");
  const unknown = replies.filter((r) => r.unknown.length > 0);
  out.push(`### 認不出的回覆 ${unknown.length} 筆`, "");
  out.push(...table(["代號", "日期", "情境", "原話", "認不出的字"], unknown.map((r) => [r.ticket, stamp(r.ts), r.scene, r.text.replace(/\s+/g, " ").slice(0, 60), r.unknown.join("、")])));
  return out;
}

const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) {
  const [command, arg] = process.argv.slice(2);
  const letter = String(arg ?? "").trim().toUpperCase();
  if (command === "replay") for (const line of replayLines()) console.log(line);
  else if (command === "remember") console.log(remember(letter));
  else if (command === "decline") console.log(decline(letter));
  else {
    console.log("用法：memory.mjs <replay|remember <情境字母>|decline <情境字母>>");
    process.exit(1);
  }
}
