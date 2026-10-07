# 清理（「清理 branch」「prune」）

關票只移除 worktree、branch 一律保留（見 `close.md`），已合併的 branch 會越積越多。`prune` 把本地 branch 與 worktree 列出來，標 CANDIDATE（可清理）或 KEEP（保留）並寫理由，確認後才刪。

| 指令 | 用途 |
| --- | --- |
| `console.mjs prune [--repo R]` | 預覽（dry run）：每個本地 branch 一行 `CANDIDATE｜KEEP  <branch>（worktree：<路徑>）  <理由>`，最後一行 `預覽：N 個可清理、M 個保留；沒有刪任何東西…`。什麼都不刪。`--repo` 可給主 checkout 路徑或 herdr 記得的 repo 名稱，沒給就用目前所在的 repo |
| `console.mjs prune [--repo R] --apply` | 先重新列一次，再清理 CANDIDATE：逐個 `[<branch>] 已清理：…`；有任何一個沒清成功 exit 1 |

判斷依據：

- CANDIDATE：branch 已是預設分支（`origin/HEAD`，沒有就 `main`／`master`）或其 `origin/` 的祖先（`已合進 …`）；或 squash 合併過——merge 之後結果與預設分支相同（沿用 `memory.mjs` 的 `alreadyIn`，理由寫 `squash 合併進 …`）。
- KEEP：預設分支；主 checkout 目前所在的 branch；你現在所在的 worktree；worktree 有未 commit 的改動（含未追蹤檔）；worktree 有 session 開著，或在 Orca／herdr 裡查不到 session 狀態（在 Orca／herdr 之外跑就不查這項，先用 `close` 關掉再清）；detached HEAD 的 worktree；還沒合併的 branch；和預設分支指向同一個 commit 的 branch（沒有自己的 commit，可能剛開，分不出「已合併」與「剛建立」，所以不動）。

清理方式：

1. 先跑預覽，把輸出原樣貼給使用者，問「要清理這 N 個嗎？」；使用者同意才加 `--apply`，不自己決定。
2. CANDIDATE 有 worktree 就先 `git worktree remove`（不加 `--force`，失敗就保留 branch 並回報）。
3. 祖先型 branch 用 `git branch -d`；squash 型用 `git branch -D`，而且刪之前再確認一次內容還在預設分支裡（branch 之後又有新 commit 就保留並回報），輸出會標明「改用 -D」。
4. 不碰遠端 branch：沒有 `git push --delete`、不 `fetch --prune`。
