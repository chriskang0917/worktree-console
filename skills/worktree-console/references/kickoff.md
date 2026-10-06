# 開票（對齊）與開工

`<base>` 是 worktree-console 的 base directory。herdr 模式讀票與開工改用 `herdr.md`〈開工〉的指令，其餘步驟照本檔。

| 指令 | 用途 |
| --- | --- |
| `console.mjs interview [--set on\|off]` | 印 `需求訪談預設：開｜關｜未設定`；帶 `--set` 時先把預設記進 `config.json` 再印 |
| `console.mjs await-start --path P --expect <首則指令前 40 字> [--interview] [--timeout 60]` | `[票號] 已開工` 或 `[票號] 未開工：<原因>` |
| `console.mjs title --terminal H -- <任務標題>` | 記下這個 session 的任務標題（≤ 15 字），專注卡片在同一個 worktree 有多個 session 時靠它分辨；成功不印任何東西 |

## 開票（對齊）

需求訪談＝開工前先讓子 session 照中控台 prompt（`console.mjs prompt` 印的那份檔案）的〈需求訪談〉一段問清楚目標與驗收準則，定稿後再交棒執行。先跑一次 `console.mjs interview`，本 session 之後沿用結果（設定改過就重跑），照 `需求訪談預設：` 決定每張票做不做，不逐張問：

- `開`：每張票都先做需求訪談；`關`：每張票都直接開工。
- `未設定`（第一次開票）：對齊摘要最後問一次「之後開票預設要先做需求訪談嗎？」，下面列 `- a. 要：每張票先問清楚目標與驗收準則再開工` 與 `- b. 不要：每張票直接開工`。使用者回答後跑 `console.mjs interview --set on`（a）或 `--set off`（b），這張票也照這個答案，之後不再問。
- 使用者對某張票明說「這張要訪談」或「這張不訪談」就照他說的，只影響這張，不改設定。
- 使用者說「需求訪談預設開／關」時跑 `--set on`／`--set off`，把輸出轉貼。

1. 使用者只給數字時，team key 從看板上既有的票號推：只有一種就用它；沒有就問一次；多種就問「要用哪一個 team key？」，下面每個 key 列一行 `- a. <key>`，使用者回字母或直接回 key 都認；本 session 之後沿用。
2. `orca linear issue <KEY-n> --json` 讀票（Linear 只讀：不改狀態、不留言）。讀不到就說明原因，請使用者貼票的內容。
3. 找母票（orca 的回傳沒有母票欄位，只能反查）：把票名開頭的 `[…]` 前綴去掉後跑 `orca linear search "<標題>" --limit 5 --json`，扣掉這張票自己；對每個候選跑 `orca linear issue <候選> --children --json`，子票清單裡有這張票的就是母票。都沒有就當沒有母票。
4. 決定預定 repo 與 branch 名稱。預定 repo 預設是啟動中控台的 repo；使用者指定別的 repo（名稱對 `orca repo list --json` 的 `displayName`）就改用它，以下的 `$TARGET` 指它的主 checkout。branch 名稱：先讀 `<base>/references/branch-naming.md`。沒有母票時，預定 branch＝第 2 步讀到的 `result.issue.branchName`。有母票時，先看 `orca worktree list --json` 裡所有 repo 的 worktree，branch 名稱含母票號（不分大小寫）的就整串照用（前後端分在不同 repo，名稱要完全一樣）；沒有就用母票的 branchName（`orca linear issue <母票號> --json`）。讀不到 branchName 才在 `$TARGET` 照 `branch-naming.md` 取名，有母票時票號用母票號、功能描述取自母票標題。**不另外停下來問名稱**，也不要寫死任何個人前綴。
5. 回一段對齊摘要，開頭 `[KEY-n] 對齊`，內容：這張票要做什麼（2～4 行）；有母票時一行 `子票 <KEY-n> → 母票 <母票號>《<母票標題>》`請使用者確認，沒找到時一行「沒查到母票，branch 用這張票的 Linear branch 名稱」；一行 `預定 repo：<名稱>`；預定 branch 名稱（使用者指定的名稱不合規時，照 `branch-naming.md` 加一行提醒與建議名稱）；一行 `需求訪談：做` 或 `需求訪談：不做`（照預設），以及固定問句「確認後就開工？」；預設還沒設定時改問上面那題。使用者否定母票、補給母票號或改 repo，就照他說的重做第 4 步。
6. **使用者確認之前，不呼叫 `orca worktree create`、不啟動任何子 session。** 預設還沒設定時，沒回答那題也不開工；使用者改 branch 名稱或 repo 就照新的。

### 沒有票

同上，只是沒有第 2、3 步：取一個 3～8 個英文字母的暱稱當代號，摘要開頭改成 `[<暱稱>] 對齊`，branch 名稱照第 4 步慣例從任務描述取。暱稱取常見、好懂的英文單字（例如 `login`、`review`、`cleanup`），不用縮寫或自創字。使用者可以改暱稱。

## 開工

預定 repo 已有 worktree 用著預定的 branch（同一張母票的另一張子票）時，不建新 worktree：`orca terminal create --worktree path:<path> --command "claude" --json`，`orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json` 為 `satisfied:true` 後送首則指令，對這個 handle 照第 2 步跑一次 `title`，再從第 3 步接著做。該 worktree 原本綁的票不改。

1. 建 worktree 並啟動子 session（不帶 `--base-branch`，用 repo 預設 base）。`--linear-issue` 有母票（對齊時使用者確認過）就綁母票號，看板代號因此顯示母票號；沒有母票或使用者否定母票就綁這張票本身；沒有票就不帶：

   ```bash
   orca worktree create --repo "path:$TARGET" --name <資料夾名稱> --linear-issue <母票號或 KEY-n> [--comment interview] \
     --agent claude --prompt "<首則指令>" --json
   ```

   資料夾名稱＝照 `branch-naming.md` 的預設格式與描述規則取的英文短名（只決定資料夾）；預定 branch 不是 Linear branchName 時就直接用預定 branch 名稱。

   做需求訪談時一定要加 `--comment interview`：目標檔寫出來之前，看板靠這個標記把階段顯示成規劃中；不做就不加。
2. 取回 `result.worktree.path` 與 `result.agentTerminalHandle`（舊版只有 `result.startupTerminal.handle`），跑 `console.mjs title --terminal <handle> -- "<任務標題>"`：一句 ≤ 15 字、說得出這個 session 要做什麼的中文（例如「修登入頁錯誤訊息」），不放票號。`git -C <path> branch --show-current` 與預定名稱不同（Orca 會把 `/` 換成 `-`；用 Linear branchName 時資料夾名稱本來就不同）就 `git -C <path> branch -m "<預定名稱>"`。沒有票時 `orca worktree set --worktree path:<path> --display-name <暱稱> --json`：看板、回報、指揮都靠這個顯示名稱認出暱稱（3～8 個英文字母且不等於 branch 名稱）。
3. `console.mjs await-start --path <path> --expect "<首則指令前 40 字>" [--interview]`，把輸出逐字轉貼。
   - 未開工：`orca terminal read --terminal <handle> --screen --json` 看畫面；是 trust／onboarding 對話框就用 `orca terminal send --terminal <handle> --text "<對應按鍵>" --enter --json` 回應，之後重送一次首則指令、再跑一次 `await-start`。仍失敗就回報原因並停下，不自行重試第三次。
4. 首則指令：
   - **做需求訪談**：`<KEY-n>：<票名與摘要>`，有母票時寫成 `<KEY-n>（母票 <母票號>）：<子票名與摘要>`（沒有票時以暱稱代替票號），後面接這段交代：「slug 用 <這張票的票號小寫或暱稱>（有母票時也用子票號，不用母票號）；先完整讀 <`console.mjs prompt` 印的檔案絕對路徑>，照其中〈需求訪談〉一段做，定稿前不動手實作；定稿後回報『定稿完成』後等待」。訪談問題會經 watcher 以 `### 💬 <票號> 等你回應` 的回報轉來，使用者的回答照〈指揮〉送回。收到「定稿完成」就讀 `<base>/references/handoff.md` 照做。
   - **不做**：首則指令＝`<KEY-n>`（或暱稱）開頭，有母票時寫成 `<KEY-n>（母票 <母票號>）：`，接著＋對齊時確認過的任務交代（要做什麼、範圍、branch 名稱）。
