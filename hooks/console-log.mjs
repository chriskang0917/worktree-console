#!/usr/bin/env node
// Child sessions of worktree-console: register tab ↔ session on start, record every prompt they receive. Silent everywhere else.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watcherPrompt } from "../skills/worktree-console/scripts/lib.mjs";
import { clip, logEvent, managedTarget } from "../skills/worktree-console/scripts/log.mjs";

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function consoleHandles() {
  try {
    const file = path.join(process.env.WORKTREE_CONSOLE_HOME || path.join(os.homedir(), ".config", "worktree-console"), "consoles.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// The new tab a console hands over to logs nothing before it registers as the console.
function consoleTakeover(handle) {
  const dir = path.join(process.env.AUTO_HANDOFF_HOME || path.join(os.homedir(), ".config", "claude-handoff"), "events");
  try {
    return fs.readdirSync(dir).some((f) => {
      try {
        const ev = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        return ev.isConsole === true && ev.newHandle === handle && ev.status !== "failed";
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// Consoles only run in Orca or herdr, so a session anywhere else has nothing to log.
function terminalOf() {
  if (process.env.HERDR_ENV === "1") return { handle: process.env.HERDR_PANE_ID, paneKey: process.env.HERDR_PANE_ID ?? null };
  if (process.env.ORCA_TERMINAL_HANDLE) return { handle: process.env.ORCA_TERMINAL_HANDLE, paneKey: process.env.ORCA_PANE_KEY ?? null };
  return null;
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

try {
  const command = process.argv[2];
  const term = terminalOf();
  const handle = term?.handle;
  const input = readStdin();
  const cwd = input.cwd ? realpath(input.cwd) : null;
  const target = handle && cwd && !consoleHandles().includes(handle) && !consoleTakeover(handle) ? managedTarget(cwd, handle) : null;
  if (target) {
    const base = { repo: target.repo, ticket: target.ticket, handle, paneKey: term.paneKey, sessionId: input.session_id ?? null };
    if (command === "session-start") logEvent("session", { ...base, role: "child", source: input.source ?? null, transcript: input.transcript_path ?? null, path: target.path, cwd });
    if (command === "user-prompt" && !watcherPrompt(input.prompt)) logEvent("prompt", { ...base, text: clip(input.prompt ?? "") });
  }
} catch {}
