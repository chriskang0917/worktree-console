---
name: task-writing
description: Use to create local tasks, view text todo graphs, submit or review evidence, reopen work, inspect or restore task history, compact events, or close/archive a task; not for Linear tickets awaiting kickoff.
---

# Local task lists

Run all commands with `node <plugin>/scripts/task-list.mjs`. Resolve `<plugin>` two levels above this skill's directory, not from the working directory. Installation makes the skill available immediately; text graphs and committed-event timelines are shown by default without an enable setting, terminal host, Linear, or Focus. Runtime output and generated task READMEs remain in Traditional Chinese.

## Create, add, and view

1. Run `task-new "<name>"`; the JSON response returns the actual `task` directory. Keep the README limited to purpose, scope, and specification links.
2. Add a group with `task item add --id <group-id> --title "<group>"`. Add an independently reviewable leaf with `task item add --id <leaf-id> --parent <group-id> --title "<work>" --criterion "<observable completion criterion>"`. IDs stay stable across renaming and reordering; titles and next actions must be single-line text.
3. Run `task-todos` and show the actual todo and timeline output.

Leaves may omit `--parent`; omitting `--criterion` creates a group. Represent independently reviewable work as leaves rather than manual group checkmarks.

## Submit and review

- Run `task report submit --item <leaf-id> --evidence <evidence-reference> --reviewer "<reviewer>"` to obtain a report ID. To schedule review, add `--revisit <future-ISO-timestamp-with-timezone>` and `--next "<review-action>"`.
- A success claim or process exit code is not acceptance. Read the evidence against the completion criteria; only the designated reviewer may run `task report accept --id <report-id> --by "<reviewer>"`.
- If criteria are unmet, run `task report reject --id <report-id> --by "<reviewer>" --reason "<unmet-criterion>"`; the leaf becomes blocked and retains the reason.
- `task report ack --id <report-id>` records reading only, not completion.
- Acceptance completes the leaf and any parent whose active children are all complete in the same transaction. Empty groups and groups with only cancelled children are not complete.

## Reopen and recover

Before changing completed work, run `task item reopen --id <leaf-id> --reason "<scope-change-or-fix>"`. Reports from older attempts or specifications remain historical and cannot complete new work. Cancel with `task item cancel --id <id> --reason "<reason>"`.

`task read` 與 `task validate` 重建看板。Exit 2 表示生成、自動壓縮或結案後收尾失敗，已提交事實仍有效；先修正原因並重讀，不盲目重送驗收。Exit 1 表示指令或正本錯誤。遇 revision 衝突先重新判斷。

Use `task --dir <task-directory>` or `task-todos --dir <task-directory>` to operate on another task without changing the selection. There is no Markdown import or task-bind command.

## 整理顯示、歷史與結案

完成項預設收成「已完成 N 項」，`task-todos --include-completed` 展開；時間線只顯示最近 20 筆。未核對、阻塞、驗收及未知／中斷活動分開顯示，不能當成已解決。

歷史會自動無損壓縮，但不自動刪除。查舊事件用 `task history --limit 50`，依 `nextBeforeRevision` 分頁。人工壓縮或還原前讀[格式契約](references/task-state-format.md#歷史遷移與結案契約)，先預覽，再帶明確 revision 套用；snapshot 不是任意時間回滾工具。

結案先執行 `task close`，逐項處理 blockers 並核對 files；使用者同意搬移後才執行 `task close --yes`。只搬明確登錄在 report evidence 的任務內報告／附件，不掃描其他筆記、不替人 ack、不操作 sessions 或 worktrees。


## File ownership

The CLI manages `task-state.json`; `board.md` is a generated offline snapshot. Store detailed evidence in separate files referenced by reports; do not duplicate progress in the README.

Read [task configuration](references/task-mode-config.md) when changing storage or repairing selection. Read [state format](references/task-state-format.md) when writing JSON commands or mechanical evidence. Use the [README template](../../templates/task-readme.md) for task notes.
