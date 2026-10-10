import "../isolate-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function focusFixture(counts, summaries = []) {
  const [pending, all, hidden, idle] = counts;
  const make = (prefix, count, extra) => Array.from({ length: count }, (_, i) => ({
    key: `${prefix}${i}@1`, tag: `${prefix}${i}`, repo: "fixture", status: "回覆完畢", stage: "實作中",
    summary: "假資料摘要", question: "假資料問題", options: [], archived: false, pending: false, report: "假資料", ...extra,
  }));
  const queue = make("reply", pending, { pending: true }).map((s, i) => (summaries[i] ? { ...s, summary: summaries[i] } : s));
  return { active: true, current: queue[0].key, queue: queue.slice(1).map(s => ({ key: s.key, isNew: false })),
    sessions: [...queue, ...make("work", all - pending, { status: "執行中" }), ...make("archive", hidden, { archived: true }), ...make("idle", idle, { status: "閒置" })] };
}

export async function terminalFixture({ counts, summaries, columns = 120, socket = `wtc-focus-test-${process.pid}`, appearance = "refined", source = process.env.WTC_FOCUS_SOURCE } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-focus-"));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude/.claude.json"), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.294",
    customApiKeyResponses: { approved: ["fixture-no-network"], rejected: [] },
    projects: { [fs.realpathSync(home)]: { hasTrustDialogAccepted: true } },
  }));
  const plugin = path.join(home, "plugin");
  fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(plugin, "hooks"));
  fs.writeFileSync(path.join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "worktree-console", version: "1.0.0" }));
  fs.writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./worktree-console-focus.tsx"] }));
  for (const name of ["worktree-console-focus.tsx", "console-theme.ts", "status-view.ts"])
    fs.copyFileSync(name === "worktree-console-focus.tsx" && source ? source : path.join(root, "hooks", name), path.join(plugin, "hooks", name));
  const input = path.join(home, "input");
  fs.mkdirSync(path.join(input, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(input, "hooks"));
  fs.writeFileSync(path.join(input, ".claude-plugin/plugin.json"), JSON.stringify({ name: "fixture-input", version: "1.0.0" }));
  fs.writeFileSync(path.join(input, "hooks/hooks.json"), JSON.stringify({ modules: ["./fixture.tsx"] }));
  fs.writeFileSync(path.join(input, "hooks/fixture.tsx"), `export const register = on => {
  on('fs.read', async () => ({ value: ${JSON.stringify(JSON.stringify({ appearance, motion: false }))} }))
  on('env.get', async (_$, e) => ({ value: e.name === 'ORCA_TERMINAL_HANDLE' ? 'fixture-only' : e.name === 'HOME' ? ${JSON.stringify(home)} : undefined }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: ${JSON.stringify(JSON.stringify(focusFixture(counts, summaries)))}, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
}
`);
  const tmux = (...args) => {
    const result = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ANTHROPIC_API_KEY: "fixture-no-network", ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", TERM: "xterm-256color", LANG: "en_US.UTF-8" };
  const launch = spawnSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", "fixture", "-x", String(columns), "-y", "48", "-c", home,
    "env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "claude", "--plugin-dir", plugin, "--plugin-dir", input, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"skipDangerousModePermissionPrompt":true}', "--dangerously-skip-permissions"], { encoding: "utf8" });
  assert.equal(launch.status, 0, launch.stderr);
  const capture = () => tmux("capture-pane", "-p", "-t", "fixture:0.0");
  const plain = text => text.replace(/\x1b\[[0-9;:]*m/g, "");
  // The prompt row is empty, and inside the panel the framed card's name is the inverse focus run.
  const ready = () => {
    const lines = tmux("capture-pane", "-p", "-e", "-t", "fixture:0.0").split("\n");
    const text = lines.map(plain);
    const prompt = text.find(line => line.startsWith("❯"));
    if (!prompt || !/^❯\s*(?:│|$)/.test(prompt) || !text.some(line => line.includes("│q:"))) return false;
    return lines.some((line, i) => {
      const at = text[i].indexOf("│", 40);
      if (at < 0 || !text[i].slice(at + 1).startsWith("║")) return false;
      return /\x1b\[7m[^\x1b]*\S/.test(line);
    });
  };
  const typedZero = () => capture().split("\n").some(line => /^❯\s+0+\s*(?:│|$)/.test(line));
  const waitFor = async (predicate, description) => {
    for (let i = 0; i < 100; i++) {
      const frame = capture();
      if (predicate(frame)) return frame;
      await delay(100);
    }
    throw new Error(`${description}\n${capture()}`);
  };
  return {
    home, tmux, capture, waitFor,
    async open() {
      await waitFor(frame => frame.includes("0: 面板"), "等待假資料專注列");
      // The band's digits arm only once the engine has laid out its window, some 500ms after it first paints; a `0`
      // before that stays typed in the prompt (an armed one shows there briefly too, then opens the panel and is wiped).
      for (let attempt = 0; attempt < 5; attempt++) {
        tmux("send-keys", "-t", "fixture:0.0", "0");
        const deadline = Date.now() + 1_500;
        while (Date.now() < deadline) {
          if (ready()) return capture();
          await delay(50);
        }
        if (typedZero()) tmux("send-keys", "-t", "fixture:0.0", "C-u");
        await delay(300);
      }
      throw new Error(`按 0 後面板沒有就緒（輸入框為空且選取卡片反白）\n${capture()}`);
    },
    async press(key, expectedContent) {
      tmux("send-keys", "-t", "fixture:0.0", key);
      let frame = "";
      const deadline = Date.now() + 5_000;
      do {
        frame = capture();
        const lines = frame.split("\n");
        const row = lines.findIndex(line => line.includes("│q:"));
        if (row >= 0) {
          const start = lines[row].indexOf("q:");
          const tabs = lines[row].slice(start).trimEnd();
          const segmentStart = tabs.indexOf(`${key}:`);
          const segment = tabs.slice(segmentStart).split(/  (?=[qwer]:)/)[0];
          const width = text => [...text].reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 2 : 1), 0);
          const markerStart = width(tabs.slice(0, segmentStart));
          // Each row is cut at its own sidebar divider: wide characters left of it can shift string indexes between rows.
          const below = lines[row + 1] ?? "";
          const divider = below.search(/│(?=[─━])/);
          const underline = divider >= 0 ? below.slice(divider + 1).trimEnd() : "";
          if (segmentStart >= 0 && underline.slice(markerStart, markerStart + width(segment)) === "━".repeat(width(segment))
            && !underline.slice(0, markerStart).includes("━") && !underline.slice(markerStart + width(segment)).includes("━")
            && expectedContent(frame)) return frame;
        }
        await delay(50);
      } while (Date.now() < deadline);
      throw new Error(`等待 ${key} 分頁選取標記與內容逾時\n${frame}`);
    },
    async close() {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
      await delay(500);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
