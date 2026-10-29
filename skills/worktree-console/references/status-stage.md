# 狀態與階段怎麼判斷

## 狀態

狀態只有五種：🔄 執行中、🔐 等待授權、💬 等待回應、⏸ 回覆完畢、💤 閒置；「待你處理」包含等待授權、等待回應、回覆完畢三種。⏸ 回覆完畢只代表子 session 這一輪回完了，整張票做到哪看「階段」欄。子 session 停下以這一輪真的結束為準：plugin 的 Stop hook 每次停下都記下時間（`~/.config/worktree-console/turn-ends/<session id>.json`），Orca 或 herdr 說停了、但對話紀錄在那之後還有新的一筆，就仍算 🔄 執行中，不出題、不進排隊；讀不到這份紀錄時 Orca 照它回報的狀態，herdr 的規則見 `references/herdr.md`〈狀態怎麼判斷〉。選單與授權框跳出來就立刻顯示，不等 Stop hook。子 session 開 AskUserQuestion 選單時算 💬 等待回應，不是等待授權；一般文字回覆在程式碼區塊與引用框以外、表格以外任何一行有「?」或「？」也算 💬 等待回應（herdr 模式回報整輪文字，但只看最後一則回覆有沒有問句）。這一輪以 API 錯誤結束（例如 safeguards 擋下）時算 ⏸ 回覆完畢，回報內容是對話紀錄裡的錯誤訊息（前面加 ⚠️），不用 Orca 給的最後回覆（可能是空的，或是前一個失敗工具的輸出）。子 session 跑 `/goal` 時，評審駁回後自動接續前的停下算 🔄 執行中，達成或結束才算回覆完畢，細節見 `references/focus.md`。「最後動態」欄最多 30 字：等待回應放最後一個含問號的那一行、等待授權放要執行的內容、執行中放最後送的指令、回覆完畢放最後一句；最後一段是表格時往前取最後一段文字，不放表格列。回報裡子 session 寫的 markdown 表格放在引用框外面，照樣畫成表格。

## 階段

階段只有四種：未開工、規劃中、實作中、已推送。中控台還在確認要不要開 session 的票（`--aligning`）一律是未開工；其餘由腳本依 worktree 留下的東西依序判斷，**不採信子 session 自述**。以下「改動」「commit」都只算動到 `docs/dev-flow/` 以外檔案的（dev-flow 的規劃檔不算）；目標檔＝該 repo 主 checkout 的 `.goals/<票號小寫或暱稱>.md`；run folder＝worktree 裡的 `docs/dev-flow/<branch 斜線換破折號>/`（舊版 `YYYYMMDD-HHmm-<slug>/` 不認），新版 dev-flow 的 run folder 也可能在 repo 外的 `~/.sara-dev-flow/<主 checkout 資料夾名>/<branch 斜線換破折號>/`（`SARA_DEV_FLOW_HOME` 可覆寫），兩處任一有就算：
1. 工作區有未 commit 的改動 → 實作中。
2. 已推送：有 base branch 時＝相對 base 有 commit 且 `git rev-list HEAD --not --remotes` 沒有 commit；找不到 base 時＝branch 有 upstream 且 `git rev-list HEAD --not --remotes` 沒有 commit。
3. 相對 base 有 commit、run folder 的 `plan.md` 檔頭是 `status: approved`、或目標檔 `**實作方案**` 那行含「直接實作」或 `-spec.md` → 實作中。
4. 有 run folder、有目標檔、或 worktree comment 含 `interview`（舊 worktree 的 `define-goal` 也算） → 規劃中。
5. 其餘 → 未開工。
