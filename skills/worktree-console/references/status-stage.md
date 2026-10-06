# 狀態與階段怎麼判斷

## 狀態

狀態只有五種：🔄 執行中、🔐 等待授權、💬 等待回應、⏸ 回覆完畢、💤 閒置；「待你處理」包含等待授權、等待回應、回覆完畢三種。⏸ 回覆完畢只代表子 session 這一輪回完了，整張票做到哪看「階段」欄。子 session 開 AskUserQuestion 選單時算 💬 等待回應，不是等待授權；一般文字回覆在程式碼區塊與引用框以外任何一行有「?」或「？」也算 💬 等待回應。這一輪以 API 錯誤結束（例如 safeguards 擋下）時算 ⏸ 回覆完畢，回報內容是對話紀錄裡的錯誤訊息（前面加 ⚠️），不用 Orca 給的最後回覆（可能是空的，或是前一個失敗工具的輸出）。子 session 跑 `/goal` 時，評審駁回後自動接續前的停下算 🔄 執行中，達成或結束才算回覆完畢，細節見 `references/focus.md`。「最後動態」欄最多 30 字：等待回應放最後一個含問號的那一行、等待授權放要執行的內容、執行中放最後送的指令、回覆完畢放最後一句。

## 階段

階段只有四種：未開工、規劃中、實作中、已 push。中控台還在確認要不要開 session 的票（`--aligning`）一律是未開工；其餘由腳本依 worktree 留下的東西依序判斷，**不採信子 session 自述**。以下「改動」「commit」都只算動到 `docs/dev-flow/` 以外檔案的（dev-flow 的規劃檔不算）；目標檔＝該 repo 主 checkout 的 `.goals/<票號小寫或暱稱>.md`；run folder＝worktree 裡的 `docs/dev-flow/<branch 斜線換破折號>/`（舊版 `YYYYMMDD-HHmm-<slug>/` 不認）：
1. 工作區有未 commit 的改動 → 實作中。
2. 已 push：有 base branch 時＝相對 base 有 commit 且 `git rev-list HEAD --not --remotes` 沒有 commit；找不到 base 時＝branch 有 upstream 且 `git rev-list HEAD --not --remotes` 沒有 commit。
3. 相對 base 有 commit、run folder 的 `plan.md` 檔頭是 `status: approved`、或目標檔 `**實作方案**` 那行含「直接實作」或 `-spec.md` → 實作中。
4. 有 run folder、有目標檔、或 worktree comment 含 `interview`（舊 worktree 的 `define-goal` 也算） → 規劃中。
5. 其餘 → 未開工。
