# herdr 模式

`<base>` 是 worktree-console 的 base directory。中控台在 herdr 分頁裡開（`HERDR_ENV=1`）就是 herdr 模式，在 Orca 分頁裡開（有 `ORCA_TERMINAL_HANDLE`）就是 Orca 模式；沒有設定檔、沒有預設值，也不混搭（在 Orca 開的中控台不管 herdr 的 session，反之亦然）。兩者都不是時腳本直接報錯「只支援 Orca 與 herdr」。herdr 連不上時腳本報 `herdr-unreachable`，不會改用 Orca。

## 跟 Orca 模式不同的地方

| 項目 | herdr 模式 |
| --- | --- |
| 啟動檢查 | `herdr status`：`server` 段的 `status: running` 才繼續，否則停下回報 |
| 代號 | 子 session 的 handle 是 herdr 的 pane id（例如 `w2:p3`），`send --terminal`、`--from` 都用它 |
| repo 名單 | herdr 目前開著的工作區所在的 repo，加上中控台記住的 repo（開工或掃描時遇到就記，存在 `~/.config/worktree-console/herdr-repos.json`）；工作區關掉後該 repo 的票照樣在。第一次用主 checkout 完整路徑帶 `--repo`，之後可以只寫 repo 名稱 |
| 票號 | 開工時中控台自記 worktree 路徑↔票號、暱稱、是否做需求訪談（`herdr-worktrees.json`）；沒記到的照 branch 名稱推 |
| Linear | 一律用 `<base>/scripts/linear.mjs`（直接呼叫 Linear API，Orca 關著也能用），不用 `orca linear` |
| 新 worktree 的位置 | herdr 設定檔 `[worktrees] directory`，沒設就是 `~/.herdr/worktrees/<repo>/<資料夾名稱>` |
| 狀態 | 多一種 **⚠️ session 異常，需手動排程**（見下） |

## 指令

| 指令 | 用途 |
| --- | --- |
| `console.mjs start --repo R --branch B --dir <資料夾名稱> [--ticket KEY-n \| --name <暱稱>] [--interview] -- <首則指令>` | herdr 模式的開工：建 worktree（預定 repo 已有 worktree 用著 B 就沿用、不改自記紀錄）、自記票號、在該 repo 的工作區開分頁啟動 claude、送首則指令。印 `worktree: <path>` 與 `terminal: <pane id>`；失敗印 `[票號] 未開工：<原因>` 並 exit 1 |
| `console.mjs open --path P [--continue]` | 在沒有 claude 分頁的 worktree 開一個（`--continue` 接續上次對話），印 `terminal: <pane id>` |
| `console.mjs misjudge --repo R <代號>[#n] <實際狀態>` | 使用者說「<代號> 狀態錯了，其實是 X」時跑：記一筆人工誤判（看板當下顯示、herdr 原始狀態、使用者說的實際狀態），輸出逐字轉貼 |
| `console.mjs herdr-report [--since 7d] [--out <檔案>] [--notes <試跑筆記.md>]` | 試跑評估報告（HTML），印報告路徑與結論段，原樣轉貼；`--notes` 把筆記裡每個 `- ` 開頭的行列成「試跑中發現的問題與處理」 |
| `linear.mjs issue <票號>`、`linear.mjs todo` | 讀票（含母票與子票）、列待開工的票；加 `--json` 給程式讀 |

其餘指令（`board`、`detail`、`resolve`、`answer`、`send`、`reply`、`after-send`、`close`、`await-start`、`handoff`、`archive`、`watch.mjs`）用法與 Orca 模式相同，腳本自己依環境選 herdr。〈指揮〉裡寫 `orca terminal …` 的步驟在 herdr 模式改成：讀畫面 `herdr pane read <pane id> --source visible`、送按鍵 `herdr pane send-keys <pane id> <鍵>`、開 claude 分頁 `console.mjs open`。

## 開工（取代 kickoff.md 的 orca 步驟）

1. 讀票：`node <base>/scripts/linear.mjs issue <KEY-n>`。回傳已含母票（`母票：…`）與母票的 branch，不必另外反查；其餘對齊步驟照 `kickoff.md`。
2. 鑰匙圈沒有 Linear key 時，`linear.mjs` 會報錯並把設定指令複製到剪貼簿：原樣轉貼它的輸出，請使用者自己在終端機貼上執行。**不要請使用者把 key 貼進對話，也不要自己跑 `security add-generic-password`。**
3. 開工：`console.mjs start --repo "$TARGET" --branch <預定 branch> --dir <資料夾名稱> [--ticket <母票號或 KEY-n> | --name <暱稱>] [--interview] -- "<首則指令>"`，再照 `kickoff.md` 第 3 步跑 `await-start`。`--ticket` 照 `kickoff.md` 第 1 步的規則：有母票（對齊時確認過）就帶母票號，否則帶這張票本身；首則指令也照第 4 步的母票寫法。`未開工：新分頁沒就緒` 時用 `herdr pane read` 看畫面，trust／onboarding 對話框用 `herdr pane send-keys` 回應後再送首則指令。

## 狀態怎麼判斷

herdr 只回報 idle／working／blocked／done／unknown，中控台再讀子 session 的對話紀錄（herdr 給的 session id，或 console-log hook 登記的檔案）補上細節：

- blocked：紀錄最後一筆還在等的工具是提問選單 → 💬 等待回應（選項從紀錄讀出）；其他工具 → 🔐 等待授權（附工具名稱與內容）。
- unknown：紀錄最後一筆是 Claude 回完話 → 照一般規則判 ⏸ 回覆完畢或 💬 等待回應；工具還在跑 → 🔄 執行中，畫面上開著授權框或選單 → 照 blocked 規則分類。
- idle／done：herdr 看過的完成也會變 idle，所以紀錄裡下過指令且回完話就算 ⏸ 回覆完畢，沒下過指令才算 💤 閒置。
- blocked 或 unknown 但紀錄讀不到（hook 沒登記、檔案損毀）→ **⚠️ session 異常，需手動排程**：排在待回覆與專注排隊的最前面，詳情附子 session 畫面；使用者回它時原文照送（打字＋Enter，不轉成 a、b、c），送完回一行 `[代號] 已原文送出（session 異常，請到分頁確認）`。

每次讀狀態腳本都會在 `~/.config/worktree-console/herdr-audit.jsonl` 寫一筆對照紀錄（herdr 原始狀態、中控台顯示的狀態、只從對話紀錄與畫面推出的狀態，三者不一致時標出），中控台不讀、不改它。

## 交棒與 `/goal`

`console.mjs handoff` 與自動交棒在 herdr 一樣可用，送文字走 `herdr agent prompt`。實測 `/goal` 連同前綴超過 800 字元會被 Claude Code 收成貼上內容而不執行（800 字元以內正常），所以 `/goal` 長度規格照 `handoff.md` 不變。

## 試跑與評估

使用者要看 herdr 版準不準時跑 `console.mjs herdr-report`，把印出的路徑與結論段原樣貼出。結論只有兩種：「herdr 版可以放心用」（補判斷後 session 異常佔全部狀態讀取不到 5%，且人工誤判裡沒有任何一次「實際在等使用者回應或授權，看板卻顯示執行中或回覆完畢」），或「還不行＋原因」。
