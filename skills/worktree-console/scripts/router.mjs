// Which backend a new implementation session runs on: Claude Code while its plan has room, else omp with Sonnet 5.5,
// through Command Code first and the Anthropic API once Command Code is spent too.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openingRules } from "../../../hooks/review-gate.mjs";

export const LIMIT = 90;
export const STALE_MS = 15 * 60 * 1000;
export const SONNET = "claude-sonnet-5-5";
export const BACKENDS = [
  { backend: "claude", provider: null, model: null, label: "Claude Code" },
  { backend: "omp", provider: "commandcode", model: `commandcode/${SONNET}`, label: "omp＋Command Code Sonnet 5.5" },
  { backend: "omp", provider: "anthropic", model: `anthropic/${SONNET}`, label: "omp＋Anthropic API Sonnet 5.5" },
];
export const ROLES = new Set(["interview", "planning", "console", "implement"]);
export const BRIDGE = fileURLToPath(new URL("../../../omp/bridge.mjs", import.meta.url));
const COMMAND_CODE_TTL_MS = 5 * 60 * 1000;

const home = () => process.env.WORKTREE_CONSOLE_HOME || path.join(os.homedir(), ".config", "worktree-console");
export const usageFile = () => process.env.WORKTREE_CONSOLE_USAGE || path.join(home(), "usage.json");
const stateFile = () => path.join(home(), "router.json");

const pct = (n) => `${Math.round(n)}%`;
const clock = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Windows at or past the limit, as { name, used, resetsAt }; a window without a number counts as unknown, not full.
function overLimit(windows) {
  return Object.entries(windows ?? {})
    .filter(([, w]) => typeof w?.used === "number" && w.used >= LIMIT)
    .map(([name, w]) => ({ name, used: w.used, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null }));
}

const NAMES = { fiveHour: "5 小時", weekly: "每週" };
const describe = (who, over) => over.map((o) => `${who} ${NAMES[o.name]}用量 ${pct(o.used)}`).join("、");

const pick = (i, reason, extra = {}) => {
  const b = BACKENDS[i];
  return { backend: b.backend, provider: b.provider, model: b.model, label: b.label, reason, ...extra };
};

/**
 * The backend for one new session. Pure: everything it reads comes in.
 * claude: { at, fiveHour: { used, resetsAt }, weekly: { used, resetsAt } } or null when the usage file was never written;
 * commandCode: { fiveHour, weekly } or null when unknown; previous: the last choice ({ backend, provider, model, resetsAt });
 * percentages are 0–100 and times epoch ms.
 */
export function route({ role, claude = null, commandCode = null, previous = null, now = Date.now() }) {
  if (role !== "implement") return pick(0, "需求訪談與規劃一律用 Claude Code");
  if (!claude) return pick(0, "讀不到 Claude 用量（用量檔還沒寫過），用 Claude Code");
  const age = now - (claude.at ?? 0);
  if (age > STALE_MS) {
    const minutes = Math.round(age / 60000);
    if (previous && previous.backend !== "claude" && typeof previous.resetsAt === "number" && now < previous.resetsAt) {
      const i = BACKENDS.findIndex((b) => b.provider === previous.provider);
      return pick(i < 0 ? 1 : i, `Claude 用量 ${minutes} 分鐘沒更新，沿用上次的選擇，到 ${clock(previous.resetsAt)} 重置後回 Claude Code`, { resetsAt: previous.resetsAt });
    }
    if (previous && previous.backend !== "claude") return pick(0, `Claude 用量 ${minutes} 分鐘沒更新，上次切走的上限已過重置時間，回 Claude Code`);
    return pick(0, `Claude 用量 ${minutes} 分鐘沒更新，沿用上次的 Claude Code`);
  }
  const over = overLimit({ fiveHour: claude.fiveHour, weekly: claude.weekly });
  if (over.length === 0) {
    const shown = [claude.fiveHour?.used, claude.weekly?.used].every((n) => typeof n === "number") ? `（5 小時 ${pct(claude.fiveHour.used)}、每週 ${pct(claude.weekly.used)}）` : "";
    return pick(0, `Claude 用量都在 ${LIMIT}% 以下${shown}，用 Claude Code`);
  }
  const resetsAt = Math.max(...over.map((o) => o.resetsAt ?? now));
  const why = `${describe("Claude", over)} ≥ ${LIMIT}%`;
  if (!commandCode) return pick(1, `${why}；Command Code 用量讀不到，先用 Command Code`, { resetsAt });
  const spent = overLimit(commandCode);
  if (spent.length === 0) return pick(1, `${why}，改用 Command Code`, { resetsAt });
  return pick(2, `${why}，${describe("Command Code", spent)} ≥ ${LIMIT}%，改用 Anthropic API`, { resetsAt });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// What the statusline wrote: { at, rate_limits: { five_hour: { used_percentage, resets_at (s) }, seven_day } }.
export function readClaudeUsage(file = usageFile()) {
  const raw = readJson(file);
  if (!raw || typeof raw.at !== "number") return null;
  const win = (w) => (w && typeof w.used_percentage === "number" ? { used: w.used_percentage, resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : null } : null);
  return { at: raw.at, fiveHour: win(raw.rate_limits?.five_hour), weekly: win(raw.rate_limits?.seven_day) };
}

// `omp usage --json`'s Command Code windows as percentages; null when omp is missing or reports nothing for it.
export function parseCommandCode(report) {
  const limits = (report?.reports ?? []).filter((r) => r.provider === "commandcode").flatMap((r) => r.limits ?? []);
  const win = (id) => {
    const l = limits.find((x) => x.window?.id === id);
    const f = l?.amount?.usedFraction;
    return typeof f === "number" ? { used: f * 100, resetsAt: l.window?.resetsAt ?? null } : null;
  };
  const out = { fiveHour: win("5h"), weekly: win("7d") };
  return out.fiveHour || out.weekly ? out : null;
}

function ompBin() {
  return process.env.OMP_BIN || "omp";
}

export function commandCodeUsage({ now = Date.now(), fresh = false } = {}) {
  const st = readJson(stateFile(), {});
  if (!fresh && st.commandCode && now - (st.commandCode.at ?? 0) < COMMAND_CODE_TTL_MS) return st.commandCode.value;
  const res = spawnSync(ompBin(), ["usage", "--json"], { encoding: "utf8", timeout: 20000 });
  let value = null;
  try {
    value = res.status === 0 ? parseCommandCode(JSON.parse(res.stdout)) : null;
  } catch {}
  writeState({ ...readJson(stateFile(), {}), commandCode: { at: now, value } });
  return value;
}

function writeState(st) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2));
  } catch {}
}

export const lastChoice = () => readJson(stateFile(), {}).last ?? null;

// The choice for a session opened now; an implementation choice is remembered for the next stale read.
export function decide(role, { now = Date.now() } = {}) {
  const claude = readClaudeUsage();
  const previous = lastChoice();
  const needsCommandCode = role === "implement" && claude && now - claude.at <= STALE_MS && overLimit({ fiveHour: claude.fiveHour, weekly: claude.weekly }).length > 0;
  const choice = route({ role, claude, commandCode: needsCommandCode ? commandCodeUsage({ now }) : null, previous, now });
  if (role === "implement") writeState({ ...readJson(stateFile(), {}), last: { backend: choice.backend, provider: choice.provider, model: choice.model, resetsAt: choice.resetsAt ?? null, reason: choice.reason, at: now } });
  return choice;
}

// The board's line: what the next implementation session would run on, without asking omp unless Claude is over.
export function routerLine({ now = Date.now() } = {}) {
  const claude = readClaudeUsage();
  const needsCommandCode = claude && now - claude.at <= STALE_MS && overLimit({ fiveHour: claude.fiveHour, weekly: claude.weekly }).length > 0;
  const choice = route({ role: "implement", claude, commandCode: needsCommandCode ? commandCodeUsage({ now }) : null, previous: lastChoice(), now });
  return `實作後端：${choice.label}（${choice.reason}）`;
}

export function rulesFile() {
  return path.join(home(), "omp-rules.md");
}

// The argv that starts a session on the chosen backend: claude takes the console's own arguments; omp its model,
// the bridge extension and the console rules (omp reads --append-system-prompt from a file when the value is one).
export function launchArgv(choice, { name = null, args = [], rules = openingRules() } = {}) {
  if (choice?.backend !== "omp") return ["claude", ...(name ? ["--name", name] : []), ...args];
  const file = rulesFile();
  if (rules !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rules);
  }
  return ["omp", "--model", choice.model, "-e", BRIDGE, "--append-system-prompt", file, ...args];
}

// `router.mjs launch --role <role> [--name N] [-- args…]`: the choice and the argv as JSON, for the hooks that must not
// import the console's modules (auto-handoff would wait on itself through lib.mjs).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const cut = rest.indexOf("--");
  const opts = cut < 0 ? rest : rest.slice(0, cut);
  const args = cut < 0 ? [] : rest.slice(cut + 1);
  const opt = (k) => (opts.includes(k) ? opts[opts.indexOf(k) + 1] : null);
  if (command === "launch") {
    const choice = decide(opt("--role") ?? "implement");
    const argv = launchArgv(choice, { name: opt("--name"), args });
    const word = (w) => (/^[\w.\/:=@%+-]+$/.test(w) ? w : `'${String(w).replace(/'/g, `'\\''`)}'`);
    process.stdout.write(JSON.stringify({ choice, argv, command: argv.map(word).join(" ") }));
  } else if (command === "line") console.log(routerLine());
  else {
    console.error("用法：router.mjs launch --role <interview|implement|console> [--name N] [-- args…]｜router.mjs line");
    process.exit(1);
  }
}
