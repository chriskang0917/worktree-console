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

以上為省略欄位時的安全預設。`view.completed` 可為 `collapsed`／`expanded`；數量、位元組與天數須為正整數，`autoCompact` 須為布林值，無效設定明確報錯。兩種保留條件取聯集，不保證熱事件低於門檻；可設 `autoCompact: false` 停止自動壓縮，仍可明確預覽／套用。歷史無保存期限，不自動刪除。

`history/` 是保留路徑，看板不能寫入。`task-todos --include-completed` 可單次展開；分頁、checksum 驗證、還原與結案流程見[格式契約](task-state-format.md#歷史遷移與結案契約)。

## Invalid selection and recovery

No selected task returns `TASK_REQUIRED`; an invalid selection returns `INVALID_BINDING`, without falling back to machine-wide session operations. Supply a valid task with `--dir` or create one; importing existing Markdown directories is not supported.

Exit 1 表示輸入、正本、選取或交易衝突；讀取故障時保留最後看板並標記未知。Exit 2 表示生成、自動壓縮或結案後搬移收尾失敗，不撤銷已提交工作。修正設定／檔案系統後重新讀取；不要盲目重做已成功的驗收。

Linear tickets awaiting kickoff still use the main plugin's `todo` and `config.json`. Local tasks use their own authoritative state and `task-mode.json`; the two configurations do not overwrite each other.
