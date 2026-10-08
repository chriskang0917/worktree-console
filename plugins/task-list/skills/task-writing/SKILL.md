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

`task read` and `task validate` rebuild the board. Exit 2 indicates generation, automatic compaction, or post-close cleanup failure; committed facts remain valid. Fix the cause and reread rather than blindly resubmitting acceptance. Exit 1 indicates a command or authoritative-state error. Reconsider after a revision conflict.

Use `task --dir <task-directory>` or `task-todos --dir <task-directory>` to operate on another task without changing the selection. There is no Markdown import or task-bind command.

## Display, history, and close

Completed leaves collapse into a count by default; `task-todos --include-completed` expands them. The timeline shows the latest 20 events. Unacknowledged evidence, blockers, pending reviews, and unknown/interrupted activity remain visible and must not be treated as resolved.

History is automatically compacted without loss and never automatically deleted. Use `task history --limit 50` and paginate with `nextBeforeRevision`. Before manual compaction or restore, read the [format contract](references/task-state-format.md#history-migration-and-close-contract), preview, then apply with the explicit revision. Snapshots do not support arbitrary-time rollback.

Run `task close` first, resolve each blocker, and review its files and checksums. After the user agrees to move them, run `task close --yes --expected-revision <preview-revision> --expected-evidence <preview-evidenceSha256>` using the preview's `applyArgs`; `task archive` uses the same flags. If the revision, file list, or bytes change, preview and review again. Only registered task-local report evidence and attachments move; old paths stop working and external links are not updated. Other notes, sessions, and worktrees remain untouched; closing never acknowledges reports.


## File ownership

The CLI manages `task-state.json`; `board.md` is a generated offline snapshot. Store detailed evidence in separate files referenced by reports; do not duplicate progress in the README.

Read [task configuration](references/task-mode-config.md) when changing storage or repairing selection. Read [state format](references/task-state-format.md) when writing JSON commands or mechanical evidence. Use the [README template](../../templates/task-readme.md) for task notes.
