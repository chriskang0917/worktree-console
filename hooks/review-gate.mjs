#!/usr/bin/env node
// The pre-implementation gate. PreToolUse holds back dev-flow's approve, the backend's confirm-spec, define-goal's handoff-files.mjs
// and edits inside the worktree while it has answers nobody reviewed; PostToolUse locks a session whose Bash changed the worktree meanwhile.
// When it cannot read the records it denies and says why rather than letting the call through.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_MESSAGE,
  GATE_LABEL,
  STATE_SUBCOMMANDS,
  addFilesItem,
  append,
  changedSince,
  childReviewProblem,
  classifyCommand,
  editAllowed,
  gated,
  nonPlanning,
  real,
  reviewsHome,
  snapshot,
  stateCommandIn,
  stateOf,
  touchesReviews,
  worktreeOf,
} from "../skills/worktree-console/scripts/review.mjs";
import { isConsoleSession } from "../skills/worktree-console/scripts/log.mjs";
import { URGENT } from "../skills/worktree-console/scripts/urgency.mjs";

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CONSOLE = fileURLToPath(new URL("../skills/worktree-console/scripts/console.mjs", import.meta.url));

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const fileOf = (input) => input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? null;
const snapFile = (session, id) => path.join(reviewsHome(), ".snap", `${session ?? "x"}-${id ?? "last"}.json`);
const isConsole = (input, check) => check(input.session_id);
const blockedText = (gate, extra = []) => [`${GATE_LABEL[gate] ?? "這個動作"}被擋下：這個 worktree 有還沒審的代回。${BLOCK_MESSAGE}。`, ...extra, `審核單：node "${CONSOLE}" review sheet`].join("\n");

// Exported for tests: the decision for one PreToolUse call, or null to let it through.
export function preToolUse(input, { consoleCheck = isConsoleSession } = {}) {
  const tool = input.tool_name;
  if (tool !== "Bash" && !EDITS.has(tool)) return null;
  const cmd = tool === "Bash" ? String(input.tool_input?.command ?? "") : null;
  const cls = cmd !== null ? classifyCommand(cmd, { cwd: input.cwd ?? process.cwd() }) : null;
  const file = EDITS.has(tool) ? fileOf(input) : null;
  const intoReviews = file && !path.relative(real(reviewsHome()), real(path.resolve(input.cwd ?? ".", file))).startsWith("..");
  if ((cls && ((cls.review !== null && STATE_SUBCOMMANDS.has(cls.review)) || stateCommandIn(cmd) || childReviewProblem(cmd, input.cwd ?? process.cwd()) || (cls.review === null && touchesReviews(cmd)))) || intoReviews) {
    if (!isConsole(input, consoleCheck)) return deny("審核狀態只能由中控台與焦點面板寫；子 session 只能用 console.mjs review add／correct 記下代回。");
  }
  if (cls?.review !== null && cls?.review !== undefined) return null;
  try {
    const wt = worktreeOf(input.cwd ?? process.cwd());
    if (!wt) return null;
    const st = stateOf(wt);
    if (st.approved) return null;
    if (st.lock && st.lock.session === input.session_id) {
      return deny(`這個 session 已鎖住：規劃階段用 Bash 改了 ${st.lock.files.join("、")}。只能跑 console.mjs review 開頭的指令。${BLOCK_MESSAGE}。`);
    }
    if (cls?.gate) {
      const dirty = nonPlanning(snapshot(wt.path));
      if (!gated(st) && dirty.length === 0) return null;
      if (dirty.length) addFilesItem(wt, dirty, { session: input.session_id ?? null, stop: GATE_LABEL[cls.gate] });
      append(wt, { event: "blocked", session: input.session_id ?? null, gate: cls.gate });
      return deny(blockedText(cls.gate, dirty.length ? [`規劃產物以外有改動：${dirty.join("、")}`] : []));
    }
    if (!gated(st)) return null;
    if (file) {
      if (editAllowed(wt, file)) return null;
      append(wt, { event: "blocked", session: input.session_id ?? null, gate: "edit" });
      return deny(blockedText("edit"));
    }
    fs.mkdirSync(path.dirname(snapFile(input.session_id, input.tool_use_id)), { recursive: true });
    fs.writeFileSync(snapFile(input.session_id, input.tool_use_id), JSON.stringify(snapshot(wt.path)));
    return null;
  } catch (error) {
    return deny(`讀不到審核紀錄或檢查出錯，先不放行：${error?.message ?? error}`);
  }
}

// Exported for tests: what PostToolUse says after a call, or null.
export function postToolUse(input) {
  const tool = input.tool_name;
  try {
    const wt = worktreeOf(input.cwd ?? process.cwd());
    if (!wt) return null;
    const cls = tool === "Bash" ? classifyCommand(String(input.tool_input?.command ?? ""), { cwd: input.cwd ?? process.cwd() }) : null;
    let st = stateOf(wt);
    if (st.approved && cls?.reopen) {
      append(wt, { event: "cleared", reason: "dev-flow reopen", session: input.session_id ?? null });
      return null;
    }
    if (st.approved && specBackToDraft(wt, input)) {
      append(wt, { event: "cleared", reason: "spec 改回 draft", session: input.session_id ?? null });
      return null;
    }
    if (tool !== "Bash" || cls?.review !== null) return null;
    const file = snapFile(input.session_id, input.tool_use_id);
    if (!fs.existsSync(file)) return null;
    const before = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file, { force: true });
    st = stateOf(wt);
    if (!gated(st)) return null;
    const changed = changedSince(before, snapshot(wt.path));
    if (changed.length === 0) return null;
    addFilesItem(wt, changed, { session: input.session_id ?? null, stop: "規劃階段用 Bash 改檔" });
    append(wt, { event: "lock", session: input.session_id ?? null, files: changed });
    append(wt, { event: "blocked", session: input.session_id ?? null, gate: "edit" });
    return { decision: "block", reason: `這個 session 已鎖住：還沒審核就用 Bash 改了 ${changed.join("、")}（檔案沒有還原）。之後改檔與 Bash 都會被擋，只放行 console.mjs review 開頭的指令。${BLOCK_MESSAGE}。` };
  } catch (error) {
    return { decision: "block", reason: `讀不到審核紀錄或檢查出錯：${error?.message ?? error}` };
  }
}

// The backend spec turned back to draft (status: draft) after it was confirmed: planning starts over, so does the review.
function specBackToDraft(wt, input) {
  const file = fileOf(input);
  if (!file && !/spec\.md|draft/.test(String(input.tool_input?.command ?? ""))) return false;
  const specs = file ? [file].filter((f) => path.basename(f) === "spec.md") : findSpecs(wt.path);
  return specs.some((f) => {
    try {
      return /^status:\s*draft\b/m.test(fs.readFileSync(path.resolve(input.cwd ?? wt.path, f), "utf8"));
    } catch {
      return false;
    }
  });
}

function findSpecs(root, depth = 0) {
  if (depth > 4) return [];
  let out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) out = out.concat(findSpecs(p, depth + 1));
    else if (e.name === "spec.md") out.push(p);
  }
  return out;
}

// The rules every child session starts with.
export function openingRules() {
  return [
    "【中控台規則】",
    `1. 緊急名單：碰到下面 10 類一律停下問使用者，不自己決定：${URGENT.map((u, i) => `${i + 1}. ${u === "不可逆或對外動作" ? "不可逆或對外動作（推 main、force push、合併、刪資料或 branch、寫 Linear／Slack、改遠端設定）" : u === "代價高的決定" ? "代價高的決定（方向、範圍、資料寫入、權限）" : u}`).join("；")}。一則訊息只要有一題屬於這 10 類，整則都等使用者回。`,
    `2. 其他自己推測的決定照做，並用這個指令記下來，進入實作前會集中給使用者審：node "${CONSOLE}" review add --question "<題目>" --plan "<當前方案>" --basis "沒有前例" 或 --source "<前例出處>" --impact "<影響範圍>" --by child --stop "<對應停點>"。每欄一句白話、40 字內、不放程式碼；畫面有變的決定加 --before <改前截圖> --after <改後截圖>（本機 dev server 截的），截不到時加 --prototype <原型截圖>；寫錯了用 review correct --n <第幾件> 更正。`,
    `3. CLAUDE.md〈停點〉的五個條件都成立，就直接做，不在結尾停下等「開工」「OK」「繼續」。碰到第 1 條的任一類照舊先停；「送出並合併」一定等使用者本人說。`,
    `4. 每次停下，回覆最後一行固定寫「等你：<要使用者做什麼>」或「已完成」，單獨一行、後面不接別的字；中控台靠這行判斷你在不在等使用者。`,
    `被攔截點擋下時，照擋下訊息跑 review sheet、把審核單原樣貼出，然後停下等使用者審核。`,
  ].join("\n");
}

const main = () => {
  const mode = process.argv[2];
  const input = readInput();
  let out = null;
  if (mode === "pre-tool-use") out = preToolUse(input);
  if (mode === "post-tool-use") out = postToolUse(input);
  if (mode === "session-start" && worktreeOf(input.cwd ?? process.cwd())) out = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: openingRules() } };
  if (out) process.stdout.write(JSON.stringify(out));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
