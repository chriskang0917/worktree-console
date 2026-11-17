// omp extension that lets the worktree console run an omp session like a Claude Code one: it calls the console's
// Claude Code hooks with their own input format at the matching omp events, and keeps a Claude-format stand-in
// transcript (with /goal's goal_status) for the hooks that read one.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeEntries } from "../skills/worktree-console/scripts/omp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDIT_TOOLS = new Set(["edit", "write", "notebook"]);
const SHELL_TOOLS = new Set(["bash", "eval"]);
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$|^\*\*\* Move to:\s*(.+?)\s*$/gm;
const NO_PATH = "解析不出這次要改的檔案路徑，先不放行；請改成一次改一個檔、寫明 path。";

const consoleHome = () => process.env.WORKTREE_CONSOLE_HOME || path.join(os.homedir(), ".config", "worktree-console");
export const shadowPath = (sessionId) => path.join(consoleHome(), "omp-transcripts", `${sessionId}.jsonl`);

// agent-skills (the advisor and the goal-scope hook) as Claude Code installed it.
export function agentSkillsRoot() {
  if (process.env.AGENT_SKILLS_ROOT) return process.env.AGENT_SKILLS_ROOT;
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    const all = JSON.parse(fs.readFileSync(path.join(dir, "plugins", "installed_plugins.json"), "utf8")).plugins ?? {};
    const key = Object.keys(all).find((k) => k.startsWith("agent-skills@"));
    return key ? all[key]?.[0]?.installPath ?? null : null;
  } catch {
    return null;
  }
}

// The Claude Code hooks each omp event stands for, as argv lists; a missing script is skipped.
export function hooks(root = ROOT, skills = agentSkillsRoot()) {
  const node = process.env.OMP_BRIDGE_NODE || "node";
  const own = (file, ...args) => [node, path.join(root, file), ...args];
  const theirs = (file, ...args) => (skills ? [node, path.join(skills, file), ...args] : null);
  const keep = (list) => list.filter((argv) => argv && fs.existsSync(argv[1]));
  return {
    sessionStart: keep([own("hooks/console-log.mjs", "session-start")]),
    stop: keep([own("skills/worktree-console/scripts/summary.mjs", "stop"), theirs("hooks/advisor-record.mjs", "stop"), own("hooks/auto-handoff.mjs", "stop")]),
    preEdit: keep([own("hooks/review-gate.mjs", "pre-tool-use"), theirs("hooks/goal-scope.mjs")]),
    preBash: keep([own("hooks/review-gate.mjs", "pre-tool-use")]),
    post: keep([own("hooks/review-gate.mjs", "post-tool-use")]),
  };
}

export function runHook(argv, input, { env = process.env, timeoutMs = 900_000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(out.trim() ? JSON.parse(out) : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// Every file one edit/write call touches; null when none can be read off its input, which is then refused.
export function editPaths(input) {
  const a = input && typeof input === "object" ? input : {};
  const found = [];
  for (const key of ["path", "file_path", "notebook_path"]) if (typeof a[key] === "string" && a[key].trim()) found.push(a[key]);
  for (const list of [a.edits, a.files, a.changes]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const p = item?.path ?? item?.file_path;
      if (typeof p !== "string" || !p.trim()) return null;
      found.push(p);
    }
  }
  for (const key of ["input", "patch"]) {
    if (typeof a[key] !== "string") continue;
    const hits = [...a[key].matchAll(PATCH_FILE)].map((m) => m[1] ?? m[2]);
    if (hits.length === 0) return null;
    found.push(...hits);
  }
  const paths = [...new Set(found)];
  return paths.length > 0 ? paths : null;
}

// One omp tool call as the Claude Code PreToolUse calls it stands for: an edit per file, a shell call as Bash; [] for any other tool.
export function claudeCalls(toolName, input) {
  if (SHELL_TOOLS.has(toolName)) {
    const command = input?.command ?? input?.code ?? input?.cmd ?? "";
    return [{ tool_name: "Bash", tool_input: { command: String(command) } }];
  }
  if (!EDIT_TOOLS.has(toolName)) return [];
  const paths = editPaths(input);
  if (!paths) return null;
  const tool = toolName === "write" ? "Write" : "Edit";
  return paths.map((file_path) => ({ tool_name: tool, tool_input: { ...(paths.length === 1 ? input : {}), file_path } }));
}

export const denial = (out) => (out?.hookSpecificOutput?.permissionDecision === "deny" ? out.hookSpecificOutput.permissionDecisionReason || "被 hook 擋下" : null);

export function goalLine(goal) {
  if (!goal?.condition) return null;
  return { type: "attachment", attachment: { type: "goal_status", met: !!goal.met, condition: goal.condition }, timestamp: new Date().toISOString() };
}

function readOmp(file) {
  if (!file) return [];
  try {
    return fs.readFileSync(file, "utf8").split("\n").flatMap((l) => {
      if (!l.trim()) return [];
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

// The stand-in transcript: the omp conversation in Claude Code entries, then the goal's status as the last line.
export function writeShadow({ sessionId, file, goal }) {
  const out = shadowPath(sessionId);
  const lines = [...claudeEntries(readOmp(file), sessionId), goalLine(goal)].filter(Boolean);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return out;
}

const lastText = (messages) => {
  const m = [...(messages ?? [])].reverse().find((x) => x?.role === "assistant");
  const parts = Array.isArray(m?.content) ? m.content : [];
  return parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim();
};

export function createBridge(pi, { hookList = hooks(), run = runHook } = {}) {
  const s = { sessionId: null, file: null, cwd: process.cwd(), goal: null, stopActive: false };
  const refresh = (ctx) => {
    try {
      s.file = ctx?.sessionManager?.getSessionFile?.() ?? s.file;
      s.sessionId = ctx?.sessionManager?.getSessionId?.() ?? s.sessionId;
    } catch {}
    s.cwd = ctx?.cwd ?? s.cwd;
  };
  const base = (event) => ({ session_id: s.sessionId, transcript_path: writeShadow(s), cwd: s.cwd, permission_mode: "default", hook_event_name: event });
  const each = async (list, input) => {
    const outs = [];
    for (const argv of list) outs.push(await run(argv, input));
    return outs;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx?.hasUI === false) return;
    refresh(ctx);
    if (!s.sessionId) return;
    await each(hookList.sessionStart, { session_id: s.sessionId, transcript_path: s.file, cwd: s.cwd, source: "startup", hook_event_name: "SessionStart" });
  });

  pi.on("goal_updated", (event) => {
    const g = event?.goal;
    s.goal = g?.objective ? { condition: g.objective, met: g.status === "complete" } : s.goal?.condition ? { ...s.goal, met: true } : null;
  });

  pi.on("tool_call", async (event, ctx) => {
    refresh(ctx);
    const calls = claudeCalls(event?.toolName, event?.input);
    if (calls === null) return { block: true, reason: NO_PATH };
    for (const c of calls) {
      const list = c.tool_name === "Bash" ? hookList.preBash : hookList.preEdit;
      for (const out of await each(list, { ...base("PreToolUse"), ...c, tool_use_id: event.toolCallId })) {
        const reason = denial(out);
        if (reason) return { block: true, reason };
      }
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    refresh(ctx);
    const calls = claudeCalls(event?.toolName, event?.input) ?? [];
    const reasons = [];
    for (const c of calls) {
      for (const out of await each(hookList.post, { ...base("PostToolUse"), ...c, tool_use_id: event.toolCallId, tool_response: event.content })) {
        if (out?.decision === "block" && out.reason) reasons.push(out.reason);
      }
    }
    if (reasons.length === 0) return undefined;
    return { content: [...(event.content ?? []), { type: "text", text: reasons.join("\n") }], isError: true };
  });

  // Not awaited: auto-handoff's Stop can wait minutes for the new tab, and omp must settle to idle meanwhile.
  pi.on("agent_end", (event, ctx) => {
    if (event?.willContinue === true) return;
    refresh(ctx);
    if (!s.sessionId) return;
    const input = { ...base("Stop"), stop_hook_active: s.stopActive, last_assistant_message: lastText(event?.messages) };
    s.pending = each(hookList.stop, input).then((outs) => {
      const block = outs.find((o) => o?.decision === "block" && o.reason);
      for (const o of outs) if (o?.systemMessage) ctx?.ui?.notify?.(o.systemMessage, "info");
      s.stopActive = !!block;
      if (block) pi.sendUserMessage(block.reason, { deliverAs: "followUp" });
      return outs;
    });
  });

  return s;
}

export default function (pi) {
  if (process.env.OMPCODE === "1" && process.env.OMP_BRIDGE_NESTED !== "1") return;
  createBridge(pi);
}
