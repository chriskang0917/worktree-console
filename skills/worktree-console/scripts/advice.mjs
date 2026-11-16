// The agent-skills advisor predicts each child question in the background (~/.advisor/predictions.jsonl); the focus band shows it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ADVICE_PENDING = "建議產生中…";
// Only these keep a question from auto-reply; older 範圍與目標／產品行為 labels go through the trial like any other.
const PRINCIPLE_LABEL = { 不可逆: "不可逆或對外動作", 沒有前例: "沒有前例", 未定題: "dev-flow 未定題，只收你本人回答" };
// A stop and its prediction are written by different processes; the stop time can trail the prediction by this much.
const STOP_SLACK_MS = 120_000;

export const advisorHome = () => process.env.ADVISOR_HOME || path.join(os.homedir(), ".advisor");
const timeoutMs = () => (Number(process.env.ADVISOR_PREDICT_TIMEOUT_MS) || 180_000) + 60_000;

function lines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const ms = (t) => (typeof t === "number" ? t : Date.parse(t ?? "")) || 0;

// Open predictions by worktree path, newest last; one an answer already used is gone, one whose worker never reported is failed.
export function loadAdvice(home = advisorHome(), now = Date.now(), file = "predictions.jsonl") {
  if (!fs.existsSync(home)) return null;
  const used = new Set(lines(path.join(home, "answers.jsonl")).map((a) => a.predictionId).filter(Boolean));
  const byId = new Map();
  for (const l of lines(path.join(home, file))) {
    if (l.event === "start") byId.set(l.id, { id: l.id, path: l.path, kind: l.kind ?? null, question: l.question ?? "", at: ms(l.at), seenAt: ms(l.at), status: "pending" });
    const p = byId.get(l.ref);
    if (!p) continue;
    if (l.event === "repost") p.seenAt = ms(l.at);
    if (l.event === "done") Object.assign(p, { status: "ready", answer: l.answer, reason: l.reason, type: l.type ?? null, principle: l.principle ?? null, precedent: l.precedent ?? null, tier: l.tier ?? null, verb: l.verb ?? null, ...("urgent" in l ? { urgent: l.urgent } : {}), brief: l.brief ?? null, precedentText: l.precedentText ?? null });
    if (l.event === "fail") p.status = "failed";
  }
  const byPath = new Map();
  for (const p of byId.values()) {
    if (used.has(p.id)) continue;
    if (p.status === "pending" && now - p.at > timeoutMs()) p.status = "failed";
    byPath.set(p.path, [...(byPath.get(p.path) ?? []), p]);
  }
  return byPath;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// The advisor's own script (state.json): worktree-console runs it to record an answer it gave for the user.
export function advisorState(home = advisorHome()) {
  const state = readJson(path.join(home, "state.json"));
  if (!state?.script) return null;
  return { script: state.script, types: state.types ?? {} };
}

// The newest prediction of a worktree made for this stop, not an older one.
export function latestFor(byPath, target, since) {
  const stop = ms(since);
  return (byPath?.get(target) ?? []).filter((x) => !stop || x.seenAt >= stop - STOP_SLACK_MS).at(-1) ?? null;
}

// 需求訪談's batch sheet is always the user's to read: its title (the first line of the question) names 批改單.
export const isSheet = (p) => p?.principle === "批改單" || String(p?.question ?? "").split("\n")[0].includes("批改單");

// An older label written over a missing precedent still means 沒有前例.
const blocking = (p) => (PRINCIPLE_LABEL[p.principle] ? p.principle : p.principle && !p.precedent ? "沒有前例" : null);


// The band's suggestion row for a session waiting on a text or menu question: pending, ready, or null (failed, 🔐, nothing predicted).
export function adviceFor(byPath, { path: target, status, since, now = Date.now() }) {
  if (!byPath || status?.kind !== "waiting") return null;
  const p = latestFor(byPath, target, since);
  if (!p || p.status === "failed") return null;
  if (p.status === "pending") return { state: "pending", text: `${ADVICE_PENDING} ${Math.max(0, Math.round((now - p.at) / 1000))} 秒` };
  const principle = blocking(p);
  const label = principle ? PRINCIPLE_LABEL[principle] : null;
  const note = label ? `（原則性：${label}）` : "";
  return { state: "ready", text: `建議：${p.answer}，${p.reason}${note}`, answer: p.answer, reason: p.reason, principle: label };
}
