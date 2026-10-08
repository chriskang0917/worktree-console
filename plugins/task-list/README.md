# task-list

A standalone plugin for local task lists. Install it to create tasks and view text graphs and committed-event timelines without a `task-mode.json` switch, Linear, Focus, or a terminal host. The CLI requires only Node.js; all modules ship inside this plugin. Runtime output and generated task READMEs remain in Traditional Chinese.

## Install and remove

Add this repository's local marketplace first (`<repo>` is an absolute path):

```sh
claude plugin marketplace add <repo>
claude plugin install task-list@worktree-console
```

Disable or uninstall:

```sh
claude plugin disable task-list@worktree-console
claude plugin uninstall task-list@worktree-console
```

Both remove the skill from Claude without deleting task data. Running retained CLI files directly is independent of the plugin's enabled state.

## Get started in three steps

`<plugin>` is the installed task-list directory or `plugins/task-list` in this checkout. You can also ask the agent to “create a login cleanup task” or “show my todos”; the task-writing skill runs the commands.

1. Create a task (the JSON response includes its actual `task` directory):
   ```sh
   node <plugin>/scripts/task-list.mjs task-new "Login cleanup"
   ```
2. Add a group and a reviewable leaf item:
   ```sh
   node <plugin>/scripts/task-list.mjs task item add --id login --title "Login cleanup"
   node <plugin>/scripts/task-list.mjs task item add --id errors --parent login --title "Improve error messages" --criterion "Failures explain how to retry"
   ```
3. View the text graph:
   ```sh
   node <plugin>/scripts/task-list.mjs task-todos
   ```

```text
Login cleanup（task-id）
revision 2
○ 1 待辦

○ Login cleanup 0/1 — 依完成條件執行
╰─ ○ Improve error messages — 依完成條件執行
```

## Submit and review

```sh
node <plugin>/scripts/task-list.mjs task report submit --item errors --evidence report.md --reviewer reviewer
node <plugin>/scripts/task-list.mjs task report accept --id <returned-report-id> --by reviewer
node <plugin>/scripts/task-list.mjs task-todos
```

`ack` records that a report was read; only `accept` completes the leaf and any parent whose active children are all complete. Reject with `report reject --id <ID> --by reviewer --reason "Insufficient evidence"`; reopen with `item reopen --id errors --reason "Requirements changed"`. Reports from older attempts or specifications cannot complete new work.

## Collapse, compact, and close

文字線圖在 `revision N` 後列出子項狀態摘要，依序為 `◆ 待回答`、`! 受阻`、`◇ 待驗收`、`▶ 進行`、`○ 待辦`、`= 停泊`，省略零項狀態；最後的 `★ 未核對` 計算所有未核對報告（含歷史報告）。沒有未完成子項時顯示 `沒有未完成項目`。群組之間留空行，不收合未完成子項、不加顏色。已完成子項預設收成 `已完成 N 項`（不計群組），但帶 `★` 的完成項仍顯示；`task-todos --include-completed` 顯示全部完成項。時間線依提交 revision 列出最近 20 筆事件；問題、待驗收、未核對報告與未知／中斷的執行狀態不受時間線限制。JSON 保留完整樹。

After a successful write, automatic compaction runs as a separate transaction when hot events exceed 1,000 entries or 2 MiB. It retains the latest 200 **and** the last seven days, plus events referenced by current state and unknown extension commands. These are retention floors, not a hard size cap. History never expires or gets automatically deleted.

```sh
node <plugin>/scripts/task-list.mjs task history --limit 50
node <plugin>/scripts/task-list.mjs task history --limit 50 --before-revision <nextBeforeRevision>
node <plugin>/scripts/task-list.mjs task compact
node <plugin>/scripts/task-list.mjs task compact --apply --expected-revision <preview-revision>
node <plugin>/scripts/task-list.mjs task history verify
node <plugin>/scripts/task-list.mjs task history restore --archive <archive-id>
node <plugin>/scripts/task-list.mjs task history restore --archive <archive-id> --apply --expected-revision <revision>
node <plugin>/scripts/task-list.mjs task migrate
```

Compaction stores verbatim event objects in immutable JSONL segments, a full pre-compaction snapshot, and a checksum manifest under `history/task-list/<id>/`. A single atomic state replacement commits the history reference. Re-sent commands still use cold-history receipts; unavailable or damaged history blocks writes. Restore is a new revision that brings events back into hot storage without rolling back items, reports, or attempts. Snapshots are recovery points, **not** event replay to arbitrary revisions. v1 tasks are migrated on their next write, retaining the original snapshot and migration manifest; older v1 writers reject v2.

Close/archive is separate from event compaction:

```sh
node <plugin>/scripts/task-list.mjs task close
node <plugin>/scripts/task-list.mjs task close --yes
```

`task archive` is the same operation. Preview lists blockers and files without writing. Apply refuses any active item, unacknowledged report, unresolved question, or nonterminal run/claim present in state. Only task-local files explicitly registered in `reports[].evidence` are moved, including report documents and attachments; register every file to include it. Remote URI references are retained. Unregistered notes, sessions, worktrees, and branches are untouched.

The close transaction copies and checksums evidence before switching state references, then removes only matching source copies. Report evidence, item source references, and completion-policy targets are updated; `evidenceArchives` records source-to-history mappings. External links are not rewritten. If interrupted after the switch, rerun close to finish removing source copies. History and report records are never deleted, and cleanup never acknowledges evidence for you.

Exit 2 can also report automatic-compaction or post-close cleanup failure; the original successful transaction remains committed. The response's `revision` belongs to that command receipt; `stateRevision`, when present, is the subsequent automatic-compaction revision. Always reread before a new write. A failed `task-todos` read displays the last generated board with an explicit unknown-state warning rather than treating missing history as empty.


## Data and tests

Task location precedence is `WORKTREE_CONSOLE_TASKS_DIR`, global `tasksDir`, then `${CLAUDE_HOME:-~/.claude}/worktree-console/tasks`. `task-mode.json` stores location and selection, not enablement. Each task's `.console/config.json` stores `boardPath` and optional `view`/`history` retention settings. The CLI manages authoritative state; the README describes purpose and specifications, and the board is an offline snapshot.

See [task configuration](skills/task-writing/references/task-mode-config.md), [state format](skills/task-writing/references/task-state-format.md), and the [README template](templates/task-readme.md). This plugin does not include a session runner, a Focus task panel, or Markdown import.

Root `npm test` runs both the main plugin tests and `plugins/task-list/test/*.test.mjs`; no separate dependencies or package command are needed. `claude plugin test` tests mods. This plugin has no mod; its CLI behavior is covered by the Node.js tests above.

## Licence and credit

Based on worktree-console by Chris Kang. Copyright (c) 2026 Chris Kang. Distributed under the [MIT License](LICENSE); the complete notice is included in this installable plugin.
