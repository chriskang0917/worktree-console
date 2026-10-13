# 任務設定

安裝 `task-list` 後即可使用，預設顯示文字待辦圖與已提交事件的時間線。沒有啟用指令。停用用 `claude plugin disable task-list@worktree-console`；移除用 `claude plugin uninstall task-list@worktree-console`。兩者都不刪除任務資料。

## 全域儲存位置與選取

設定檔是 `${WORKTREE_CONSOLE_HOME:-~/.config/worktree-console}/task-mode.json`，只保留位置與目前選取：

```json
{ "tasksDir": "/absolute/tasks", "task": "/absolute/tasks/task-id" }
```

直接編輯此檔可自訂 `tasksDir`；`task-new` 會設定 `task`。

任務目錄優先順序：

1. `WORKTREE_CONSOLE_TASKS_DIR`。
2. 全域 `tasksDir`。
3. `${CLAUDE_HOME:-~/.claude}/worktree-console/tasks`。

`task-new` 回傳實際目錄，建立 README、正本狀態、設定與 board。用 `task --dir <目錄> read` 或 `task-todos --dir <目錄>` 查看另一個任務，不改變選取；重複 `--dir` 時採用最後一個值。

## 個別任務的 board 位置

每個任務的 `.console/config.json` 包含：

```json
{
  "boardPath": "board.md",
  "view": { "completed": "collapsed", "timelineLimit": 20 }
}
```

`boardPath` 必須是任務內相對路徑，不可經過 symlink、越界，或覆寫正本狀態、README、設定與證據。`snapshots/board.md` 是有效路徑。`task-todos --json` 回傳項目樹。

省略欄位時使用上述預設值。`view.completed` 接受 `collapsed` 或 `expanded`；`timelineLimit` 必須是正整數。無效設定會明確失敗。事件全部留在正本，不壓縮或自動刪除。

`history/` 保留給證據封存，不可放 board。`task-todos --include-completed` 只為當次指令展開完成項。分頁與結案契約見[狀態格式](task-state-format.md#歷史與結案契約)。

## 無效選取與恢復

沒有選取任務時回傳 `TASK_REQUIRED`；無效選取回傳 `INVALID_BINDING`。用 `--dir` 提供有效任務，或建立新任務。

Exit 1 表示輸入、正本狀態、選取或交易衝突；讀取失敗會保留最後 board 並標記狀態未知。Exit 2 表示生成或結案後清理失敗，不撤銷已提交工作。修復設定或檔案系統問題後重讀，不盲目重複已成功的驗收。

