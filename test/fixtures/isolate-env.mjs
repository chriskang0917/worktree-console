// Tests must never reach the real herdr, Herdr app or Orca: a run inside one of their tabs would open real tabs, and the console watching them records their repos.
for (const key of Object.keys(process.env)) if (/^(HERDR_|HC_|ORCA_)/.test(key)) delete process.env[key];
// Nor the real advisor records, which would put suggestions on the cards.
process.env.ADVISOR_HOME ??= "/nonexistent/wtc-test-advisor";
// Nor the real dev-flow run folders, which would move the stage column.
process.env.SARA_DEV_FLOW_HOME ??= "/nonexistent/wtc-test-sara-dev-flow";
// The shell a test runs in is a child session's by default, never the real session running the tests: the review state subcommands
// refuse it, so a test that needs the console runs as `consoleIdentity()`.
process.env.CLAUDE_CODE_SESSION_ID = "test-child-session";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The env of a console session: a transcript that loaded the worktree-console skill, under its own projects folder.
export function consoleIdentity(id = "test-console-session") {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-console-id-"));
  fs.mkdirSync(path.join(projects, "-console"));
  fs.writeFileSync(path.join(projects, "-console", `${id}.jsonl`), `${JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Base directory for this skill: /x/skills/worktree-console\n\n# Worktree Console" }] } })}\n`);
  return { CLAUDE_CODE_SESSION_ID: id, CLAUDE_PROJECTS_DIR: projects };
}
