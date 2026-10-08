import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite, taskPath, readTask, checked, fail } from "./task-store.mjs";
import { generateCoreViews } from "./task-core-generated.mjs";
export const modeHome = (env = process.env) => path.resolve(env.WORKTREE_CONSOLE_HOME || path.join(os.homedir(), ".config/worktree-console"));
export function readTaskMode(env = process.env) { try { const { tasksDir, task } = JSON.parse(fs.readFileSync(path.join(modeHome(env), "task-mode.json"), "utf8")); return { ...(tasksDir !== undefined ? { tasksDir } : {}), ...(task !== undefined ? { task } : {}) }; } catch (error) { if (error.code === "ENOENT") return {}; throw error; } }
export const tasksDirectory = (env = process.env) => path.resolve(env.WORKTREE_CONSOLE_TASKS_DIR || readTaskMode(env).tasksDir || path.join(env.CLAUDE_HOME || path.join(os.homedir(), ".claude"), "worktree-console/tasks"));
export function writeTaskMode(changes, env = process.env) { const config = { ...readTaskMode(env), ...changes }; fs.mkdirSync(modeHome(env), { recursive: true }); atomicWrite(path.join(modeHome(env), "task-mode.json"), JSON.stringify(config, null, 2) + "\n"); return config; }
export function selectedTask(env = process.env) { const mode = readTaskMode(env); if (!mode.task) fail("TASK_REQUIRED", "請先 task-new <名稱>"); try { const root = fs.realpathSync(mode.task); readTask(root); return root; } catch (error) { fail("INVALID_BINDING", `任務選取失效，請用 task-new 建立任務或 task --dir <資料夾> 指定有效任務：${error.message}`); } }
export function createCoreTask(title, { env = process.env, now = new Date() } = {}) {
  const time = now.toISOString();
  const taskId = randomUUID();
  const state = checked({ schemaVersion: 2, history: [], taskId, revision: 0, title, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, createdAt: time, updatedAt: time, items: [], reports: [], events: [{ id: randomUUID(), revision: 0, entity: { type: "task", id: taskId }, actor: { host: "local", id: "task-new" }, occurredAt: time, recordedAt: time, commandId: randomUUID(), command: "建立任務" }] });
  fs.mkdirSync(tasksDirectory(env), { recursive: true });
  const root = path.join(tasksDirectory(env), taskId); fs.mkdirSync(root);
  atomicWrite(taskPath(root, ".console/config.json", true), JSON.stringify({ boardPath: "board.md" }) + "\n");
  atomicWrite(taskPath(root, "task-state.json"), JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(taskPath(root, "README.md"), `# ${title}\n\n## 目的\n\n${title}\n\n## 範圍\n\n依已確認需求拆成可驗收待辦；進度只由 CLI 維護。\n\n## 規格入口\n\n有規格時在此連結。board.md 為生成的離線快照，不回寫。\n`);
  const errors = generateCoreViews(root, state); if (errors.length) fail("GENERATED_VIEW", errors.join("\n"));
  writeTaskMode({ task: root }, env);
  return root;
}
