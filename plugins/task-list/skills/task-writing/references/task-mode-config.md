# Task configuration

Installing `task-list` makes it available immediately; text todo graphs and committed-event timelines are always shown. There is no `task-mode enable/disable` command or task switch. Disable with `claude plugin disable task-list@worktree-console`, or uninstall with `claude plugin uninstall task-list@worktree-console`. Neither deletes task data.

## Global storage and selection

Settings use `${WORKTREE_CONSOLE_HOME:-~/.config/worktree-console}/task-mode.json` and retain only location and current selection:

```json
{ "tasksDir": "/absolute/tasks", "task": "/absolute/tasks/task-id" }
```

Edit this file directly to customize `tasksDir`; `task-new` sets `task`. Legacy `enabled` and `todoGraph` fields no longer control behavior and are removed when settings are written.

Task directory precedence:

1. `WORKTREE_CONSOLE_TASKS_DIR`.
2. Global `tasksDir`.
3. `${CLAUDE_HOME:-~/.claude}/worktree-console/tasks`.

`task-new` returns the actual directory and creates the README, authoritative state, configuration, and board. Use `task --dir <directory> read` or `task-todos --dir <directory>` to view another task without changing selection; repeated `--dir` flags use the last value.

## Per-task board location

Each task's `.console/config.json` contains:

```json
{
  "boardPath": "board.md",
  "view": { "completed": "collapsed", "timelineLimit": 20 },
  "history": {
    "autoCompact": true,
    "triggerEvents": 1000,
    "triggerBytes": 2097152,
    "keepRecentEvents": 200,
    "keepRecentDays": 7
  }
}
```

`boardPath` must be relative to the task directory. It cannot traverse symlinks, leave the directory, or overwrite authoritative state, the README, configuration, or evidence. `snapshots/board.md` is valid. Legacy `todoGraph` fields no longer affect output; `task-todos --json` returns the item tree.

These are safe defaults for omitted fields. `view.completed` accepts `collapsed` or `expanded`; counts, bytes, and days must be positive integers, and `autoCompact` must be boolean. Invalid settings fail explicitly. Retention conditions are combined as a union, so hot events may remain above the trigger. Set `autoCompact: false` to stop automatic compaction while retaining explicit preview/apply operations. History never expires or gets automatically deleted.

`history/` is reserved and cannot contain the board. `task-todos --include-completed` expands completed items for one invocation. See the [format contract](task-state-format.md#history-migration-and-close-contract) for pagination, checksum verification, restore, and close.

## Invalid selection and recovery

No selected task returns `TASK_REQUIRED`; an invalid selection returns `INVALID_BINDING`, without falling back to machine-wide session operations. Supply a valid task with `--dir` or create one; importing existing Markdown directories is not supported.

Exit 1 indicates input, authoritative-state, selection, or transaction conflicts; failed reads preserve the last board and mark its state unknown. Exit 2 indicates generation, automatic compaction, or post-close cleanup failure without reverting committed work. Fix configuration or filesystem problems and reread rather than blindly repeating successful acceptance.

Linear tickets awaiting kickoff still use the main plugin's `todo` and `config.json`. Local tasks use their own authoritative state and `task-mode.json`; the two configurations do not overwrite each other.
