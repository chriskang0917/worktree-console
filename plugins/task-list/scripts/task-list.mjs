#!/usr/bin/env node
import { coreTaskMain } from "./task-core-cli.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["task-new", "task", "task-todos"].includes(command)) {
  console.log(JSON.stringify({ ok: false, code: "INVALID_COMMAND", message: "用法：task-list.mjs task-new <名稱>、task <操作> 或 task-todos" }));
  process.exitCode = 1;
} else {
  process.exitCode = await coreTaskMain(command, args);
}
