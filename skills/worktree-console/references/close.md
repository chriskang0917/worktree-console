# 關閉（「關掉 <票號>」）

| 指令 | 用途 |
| --- | --- |
| `console.mjs close-check --path P` | `ok` 或 `blocked:<原因>`，另列 `!!` 開頭的 ignored 項；blocked 時 exit 1 |
| `console.mjs close --path P` | 關票（見〈關閉〉）：`[票號] 已關閉：worktree 已移除，branch <名稱> 保留`（branch 有未 push commit 時後面加 `（含 N 個未 push commit）`），暫存 worktree 是 `[<暱稱>] 已關閉：暫存 worktree 已移除`（有 commit 時改成 `…，branch <名稱> 保留（含 N 個 commit）`）；或 `[票號] 未關閉：<原因>` 加 `!!` 開頭的 ignored 項並 exit 1 |

1. `resolve` 找到唯一的 worktree（不論哪個 repo、有沒有 session）：所有候選的 `path` 相同就算唯一（關閉以 worktree 為單位，會連同其中所有 session 一起關）；指向不同 worktree 才反問「要關哪一個？」，下面每個 worktree 列一行 `- a. <tag>  <path>`（字母依序 a、b、c，同一 worktree 只列一次），使用者回字母就關該 worktree，不自己挑。
2. `console.mjs close --path <path>`，輸出逐字轉貼。腳本依序：檢查（主 checkout、中控台所在 worktree、未 commit 改動、session 執行中都擋下；未 push commit 不擋，commit 留在保留的 branch 上）→ 關掉該 worktree 所有分頁 → 再檢查一次 → `git worktree remove`（不加 `--force`）。`未關閉：…` 時連同 `!!` 開頭的 ignored 項逐字回報，等使用者處理。
   - 不要用 `orca worktree rm`：它會嘗試刪掉已合併的本地 branch。branch 一律保留，只有下一條例外。
   - 暫存 worktree（`ask` 開的，見 `ask.md`）照同樣的檢查與步驟關，移除後連它的拋棄式 branch 一起刪；拋棄式 branch 上有 commit 就不刪、照保留回報。
