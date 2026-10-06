# 問問題（拋棄式 session）

| 指令 | 用途 |
| --- | --- |
| `console.mjs repo-match --repo R <開頭那個字>` | `{match:"session"\|"one"\|"many"\|"none", repo?, repos?}`：先比 session 代號，再比 repo 名稱（完整名稱一定算；否則要 3 個字元以上、只對到一個 repo 名稱的開頭才算 `one`） |
| `console.mjs ask --repo R --target <repo> --nickname <暱稱> --title <任務標題> -- <問題>` | 開暫存 worktree、把問題當首則指令送進去：`[<暱稱>] 已開暫存 worktree（<repo>），問題已送出`；失敗印原因（含 `[<暱稱>] 未開工：…`、對到多個 repo、找不到 repo、暱稱已被使用）並 exit 1 |
| `console.mjs ask-tab --repo R --title <任務標題> <代號> -- <問題>` | 在該代號的 worktree 多開一個臨時分頁並送出問題：`[<代號#n>] 已開臨時分頁，問題已送出`，或失敗原因並 exit 1 |

拋棄式 session 有兩種，都只由中控台開（使用者自己在 Orca 開的分頁不算）：暫存 worktree（`ask`）與既有 worktree 裡的臨時分頁（`ask-tab`）。

## 怎麼認

1. 「問 <repo>：<問題>」：一律開暫存 worktree，不判斷內容，直接跑 `ask --target <repo>`；對到多個 repo 時把腳本列的名稱反問一行「要問哪個 repo：…？」。
2. 「<代號> 問：<問題>」：跑 `ask-tab`。
3. 開頭那個字（第一個空白前）不是中控台自己的指令、也不是回答用的 a、b、c，而且像 repo 名稱（3 個字元以上的英文、數字、`-`）：跑 `repo-match`。
   - `session`：當成指揮那個 session，照〈指揮〉送。
   - `none`：照原規則處理（有 mods 時交給 `reply`，否則照〈指揮〉第 2 步）。
   - `many`：反問一行「<那個字> 是指哪個 repo：…？」。
   - `one`：看其餘內容分流。在問事情（有什麼、怎麼運作、為什麼、在哪裡）→ 開暫存 worktree；要改東西（加、改、修、刪）→ 照〈要改檔案時〉問「要不要開 session 做？」，同意就以這個 repo 為預定 repo 走正式開工；分不出來 → 只反問一行「要問問題還是要開工？」，由使用者拍板，不猜。

## 開暫存 worktree

- 不經對齊、不問使用者：暱稱照〈沒有票〉的規則從問題取一個 3～5 個英文小寫字母的常見單字（腳本只收 3～5 個字母），任務標題從問題濃縮成 ≤ 15 字的中文。暱稱已被使用就換一個重跑。
- `ask` 輸出逐字轉貼，不跑 `after-send`。回覆照一般 session 由 watcher／專注橫條轉來。
- Orca 不能在 `git worktree add --detach` 開的 worktree 開分頁（實測 `orca worktree list` 不列、`orca terminal create` 逾時），所以 `ask` 用 `orca worktree create` 開，branch 是拋棄式的 `ask-<暱稱>`，移除 worktree 時一併刪除（只刪沒有 commit 的）。
- 結束方式兩種：
  - 使用者打「關掉 <暱稱>」→ 照 `close.md`，移除 worktree 並刪掉拋棄式 branch；有未 commit 改動照常擋下。
  - 使用者在 Orca 關掉它最後一個分頁 → watcher 自動移除（乾淨的才移除）；有未 commit 改動或有 commit 就不刪，watcher 印一行 `[<暱稱>] 未移除：…`，等使用者打「關掉 <暱稱>」或自行處理。
  - watcher 只處理自己那邊（Orca 或 herdr）開的暫存 worktree 與臨時分頁；另一邊的分頁不在清單裡，不算已關（沒標來源的舊紀錄算 Orca 的）。

## 臨時分頁

- 主 checkout 不開臨時分頁（腳本會擋下並提示改用「問 <repo>：…」）。
- `ask-tab` 輸出逐字轉貼，不跑 `after-send`。分頁關掉後自動除名。

## 拋棄式 session 的待遇

- 不續命、不交棒：watcher 不送續命與快取交棒訊息，context 用量到了也不自動交棒。
- 其餘照一般 session：回覆完畢照常進待回覆排隊、上專注橫條，看板、詳情、指揮、封存都一樣。
