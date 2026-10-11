# task-list

A plugin for local task lists: create tasks, track items, submit and review evidence, and view a text graph with a committed-event timeline. No npm package dependencies. It requires Node.js, macOS or Linux, and `ps` supporting `ps -p <pid> -o lstart=`; if the process identity cannot be checked, writes stop with one `LOCK_IDENTITY` message. Windows and minimal BusyBox environments without this `ps` interface are unsupported. Skill text, runtime output and generated task READMEs are in Traditional Chinese.

## Install and remove

Add the marketplace first (`<repo>` is this repository's absolute path, or use its GitHub address):

```sh
claude plugin marketplace add <repo>
claude plugin install task-list@worktree-console
```

Disable or uninstall:

```sh
claude plugin disable task-list@worktree-console
claude plugin uninstall task-list@worktree-console
```

Both remove the skill from Claude without deleting task data.

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

`--evidence` registers one entry per submit. To register several, put them in the `data.evidence` array of a `--file` envelope (see the [state format](skills/task-writing/references/task-state-format.md#指令與驗收)):

```sh
node <plugin>/scripts/task-list.mjs task report submit --file envelope.json
```

An evidence entry is text (`npm test passed`), a URL (`https://…`), or a file inside the task folder. Submit rejects, with `INVALID_EVIDENCE`, an entry that names an existing file close could never archive: a path outside the task folder, an absolute path, a symlink, a directory, a control file, or the board. Text and files that do not exist are accepted.

`ack` records that a report was read; only `accept` completes the leaf and any parent whose active children are all complete. Reject with `report reject --id <ID> --by reviewer --reason "Insufficient evidence"`; reopen with `item reopen --id errors --reason "Requirements changed"`. Reports from older attempts or specifications cannot complete new work.

## Collapse, history, and close

The text graph lists nonzero leaf-status counts after the revision, ordered as waiting, blocked, review, doing, queued, and parked, followed by the count of all unacknowledged reports, including historical reports. It shows an empty-work summary when no leaves remain active. Groups are separated by blank lines; unfinished children and completed children with an unacknowledged report remain visible with their group headers. Completed leaves otherwise collapse into a count; `task-todos --include-completed` expands them. The graph written to `board.md` is plain text. The timeline shows the latest 20 committed events in revision order; pending reviews and unacknowledged reports are not subject to that limit. JSON retains the full tree.

All committed events remain in `task-state.json`; they are never compacted or automatically deleted.

```sh
node <plugin>/scripts/task-list.mjs task history --limit 50
node <plugin>/scripts/task-list.mjs task history --limit 50 --before-revision <nextBeforeRevision>
node <plugin>/scripts/task-list.mjs task history verify
```

Close/archive previews the registered evidence to move:

```sh
node <plugin>/scripts/task-list.mjs task close
node <plugin>/scripts/task-list.mjs task close --yes --expected-revision <preview-revision> --expected-evidence <preview-evidenceSha256>
```

`task archive` is the same operation. Preview lists blockers, files, checksums, and `applyArgs` without writing. Copy its `--expected-revision` and `--expected-evidence` values when applying; changes to the revision, evidence list, or file bytes, including deletion, require a new preview and review. Apply refuses any active item or unacknowledged report. Only task-local files registered in `reports[].evidence` are moved, including report documents and attachments; register every file to include it. A reference that does not name an existing entry is text evidence (for example `npm test passed / 12 tests passed`) and is skipped, including in reports from before a reopen. `scheme://` references are URLs and are never moved; a reference such as `proof:結果.txt` names a local file when that file exists. Files must be regular files inside the task folder, cannot be control files or the configured board, and stay bound to the preview checksum; control-file, board and `history/` matching ignores letter case. Symlinks, directories and existing paths outside the task folder are refused. Other notes in the task folder are untouched.

The close transaction copies and checksums evidence before switching state references, then removes only matching source copies, so old evidence paths stop working. Report evidence, item source references, and completion-policy targets are updated; `evidenceArchives` records source-to-history mappings. External links are not rewritten. If interrupted after the switch, preview close again and apply its new arguments to finish removing source copies. History and report records are never deleted, and cleanup never acknowledges evidence for you.

Exit 2 reports generation or post-close cleanup failure; the original successful transaction remains committed. Always reread before a new write. A failed `task-todos` read displays the last generated board with an explicit unknown-state warning rather than treating unreadable state as empty.

## Data and tests

Task location precedence is `WORKTREE_CONSOLE_TASKS_DIR`, global `tasksDir`, then `${CLAUDE_HOME:-~/.claude}/worktree-console/tasks`. `task-mode.json` stores the tasks location and the selected task. Each task's `.console/config.json` stores `boardPath` and optional `view` settings. The CLI manages authoritative state; the README describes purpose and specifications, and the board is an offline snapshot.

See [task configuration](skills/task-writing/references/task-mode-config.md), [state format](skills/task-writing/references/task-state-format.md), and the [README template](templates/task-readme.md).

Tests: `node --test plugins/task-list/test/*.test.mjs` (also part of root `npm test`).

## Licence

[MIT](LICENSE).
