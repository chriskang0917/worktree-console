// The agent-skills advisor predicts each child question in the background (~/.advisor/predictions.jsonl); the focus band shows it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ADVICE_PENDING = "建議產生中…";
const PRINCIPLE_LABEL = { 範圍與目標: "範圍與目標", 不可逆: "不可逆或對外動作", 產品行為: "產品行為與 UX", 沒有前例: "沒有前例" };
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
export function loadAdvice(home = advisorHome(), now = Date.now()) {
  if (!fs.existsSync(home)) return null;
  const used = new Set(lines(path.join(home, "answers.jsonl")).map((a) => a.predictionId).filter(Boolean));
  const byId = new Map();
  for (const l of lines(path.join(home, "predictions.jsonl"))) {
    if (l.event === "start") byId.set(l.id, { id: l.id, path: l.path, at: ms(l.at), seenAt: ms(l.at), status: "pending" });
    const p = byId.get(l.ref);
    if (!p) continue;
    if (l.event === "repost") p.seenAt = ms(l.at);
    if (l.event === "done") Object.assign(p, { status: "ready", answer: l.answer, reason: l.reason, principle: l.principle ?? null });
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

// The band's suggestion row for a session waiting on a text or menu question: pending, ready, or null (failed, 🔐, nothing predicted).
export function adviceFor(byPath, { path: target, status, since, now = Date.now() }) {
  if (!byPath || status?.kind !== "waiting") return null;
  const stop = ms(since);
  const p = (byPath.get(target) ?? []).filter((x) => !stop || x.seenAt >= stop - STOP_SLACK_MS).at(-1);
  if (!p || p.status === "failed") return null;
  if (p.status === "pending") return { state: "pending", text: `${ADVICE_PENDING} ${Math.max(0, Math.round((now - p.at) / 1000))} 秒` };
  const note = p.principle ? `（原則性：${PRINCIPLE_LABEL[p.principle] ?? p.principle}）` : "";
  return { state: "ready", text: `建議：${p.answer}，${p.reason}${note}`, answer: p.answer, reason: p.reason, principle: p.principle ? PRINCIPLE_LABEL[p.principle] ?? p.principle : null };
}
