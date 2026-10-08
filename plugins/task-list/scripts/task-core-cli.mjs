import fs from "node:fs";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readTask, taskPath, fail } from "./task-store.mjs";
import { createCoreTask, selectedTask, readTaskMode } from "./task-core-home.mjs";
import { executeCoreCommand } from "./task-core-commands.mjs";
import { renderTaskGraph, taskTree } from "./task-core-generated.mjs";
import { allTaskEvents, readCleanupConfig } from "./task-history.mjs";
export function parseCoreTaskArgs(args) {
  const strings = ["dir", "file", "id", "item", "parent", "title", "next", "source", "criterion", "target", "verifier", "evidence-type", "evidence", "reviewer", "revisit", "by", "reason", "attempt", "spec-revision", "order", "outcome", "limit", "before-revision", "expected-revision", "expected-evidence", "archive"];
  const options = Object.fromEntries(strings.map((key) => [key, { type: "string" }]));
  for (const key of ["json", "include-completed", "apply", "yes"]) options[key] = { type: "boolean" };
  return parseArgs({ args, allowPositionals: true, options });
}
export async function coreTaskMain(command, args, { env = process.env, execute = executeCoreCommand, parsed } = {}) {
  let displayRoot;
  let json = false;
  try {
    const { values: v, positionals: p } = parsed ?? parseCoreTaskArgs(args);
    json = v.json ?? false;
    if (command === "task-todos") displayRoot = v.dir ?? readTaskMode(env).task;
    let result;
    if (command === "task-new") result = { task: createCoreTask(p.join(" "), { env }), next: "task-list.mjs task item add --title <名稱> --criterion <完成條件>" };
    else {
      const root = v.dir ?? selectedTask(env);
      if (command === "task-todos") {
        const result = execute(root, "read");
        const { state } = result;
        const { view } = readCleanupConfig(root);
        console.log(v.json ? JSON.stringify(taskTree(state)) : renderTaskGraph(state, { includeCompleted: v["include-completed"] ?? view.completed === "expanded", timelineLimit: view.timelineLimit, timeline: allTaskEvents(root, state) }));
        for (const error of result.viewErrors ?? []) console.error(error);
        return result.viewErrors?.length ? 2 : 0;
      }
      let operation = p.join(" ");
      if (operation === "history") {
        result = execute(root, operation, { ...(v.limit !== undefined ? { limit: Number(v.limit) } : {}), ...(v["before-revision"] !== undefined ? { beforeRevision: Number(v["before-revision"]) } : {}) });
        console.log(JSON.stringify(result)); return 0;
      }
      if (["compact", "history restore"].includes(operation) && !v.apply) operation += " preview";
      if (["close", "archive"].includes(operation) && !v.yes) operation += " preview";
      if (operation.endsWith(" preview") || operation === "history verify") {
        result = execute(root, operation, { archive: v.archive });
        console.log(JSON.stringify(result)); return 0;
      }
      const state = readTask(root);
      let envelope = v.file ? JSON.parse(fs.readFileSync(v.file, "utf8")) : null;
      if (!envelope && !["read", "validate"].includes(operation)) {
        const data = {};
        if (v.id) data.id = v.id;
        if (operation === "item add") {
          if (v.parent && !v.criterion) fail("CRITERION_REQUIRED", "子項（--parent）必須提供 --criterion <完成條件>；只有根層項目可以是不帶完成條件的群組");
          Object.assign(data, { kind: v.criterion ? "leaf" : "group", title: v.title, nextAction: v.next ?? "依完成條件執行", sourceRef: v.source ?? "README.md", order: v.order === undefined ? Math.max(-1, ...state.items.filter((item) => item.parentId === v.parent).map((item) => item.order)) + 1 : Number(v.order) });
          if (v.parent) data.parentId = v.parent;
          if (v.criterion) data.completionPolicy = [{ criterion: v.criterion, target: v.target ?? v.criterion, evidenceType: v["evidence-type"] ?? "report", verifier: v.verifier ?? "human" }];
        } else if (operation === "report submit") {
          Object.assign(data, { itemId: v.item, outcome: v.outcome ?? "success", evidence: v.evidence ? [v.evidence] : [] });
          if (v.attempt) data.attemptId = v.attempt;
          if (v["spec-revision"]) data.specRevision = Number(v["spec-revision"]);
          if (v.reviewer) data.review = { reviewer: v.reviewer, revisitAt: v.revisit ?? new Date(Date.now() + 86400000).toISOString(), nextAction: v.next ?? "核對完成證據" };
        } else if (operation === "item update") data.changes = { ...(v.title ? { title: v.title } : {}), ...(v.next ? { nextAction: v.next } : {}) };
        else if (operation === "item move") { data.order = Number(v.order); data.parentId = v.parent ?? null; }
        else if (["item reopen", "item cancel", "report reject"].includes(operation)) data.reason = v.reason;
        else if (operation === "history restore") data.archive = v.archive;
        if (["close", "archive"].includes(operation)) data.expectedEvidence = v["expected-evidence"];
        if (v.by) data.by = v.by;
        if (["compact", "history restore", "close", "archive"].includes(operation) && v["expected-revision"] === undefined) fail("REVISION_REQUIRED", "套用清理必須提供預覽的 --expected-revision");
        envelope = { commandId: randomUUID(), expectedRevision: v["expected-revision"] === undefined ? state.revision : Number(v["expected-revision"]), actor: { host: "local", id: "task-cli" }, data };
      }
      result = execute(root, operation, envelope ?? {});
    }
    console.log(JSON.stringify(result)); return result.viewErrors?.length || result.archiveErrors?.length || result.compactionError ? 2 : 0;
  } catch (error) {
    const failure = { ok: false, code: error.code ?? "ERROR", message: error.message, errors: error.errors };
    if (command === "task-todos" && !json && displayRoot) {
      try {
        const config = JSON.parse(fs.readFileSync(taskPath(displayRoot, ".console/config.json"), "utf8"));
        const previous = fs.readFileSync(taskPath(displayRoot, config.boardPath ?? "board.md"), "utf8");
        if (previous.startsWith("<!-- GENERATED / taskId=")) {
          console.log(`讀取失敗，狀態未知；以下保留最後離線快照：\n${previous}`);
          console.error(JSON.stringify(failure)); return 1;
        }
      } catch { /* An unreadable cached view must not hide the original error. */ }
    }
    console.log(JSON.stringify(failure)); return 1;
  }
}
