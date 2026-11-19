---
name: worktree-console
description: 在單一 Claude Code session 透過 orca CLI、herdr 或 Herdr app 當中控台，管理 Orca（或 herdr、Herdr app）裡所有 repo 的 worktree／claude session：丟 Linear 票就對齊後開 worktree 與子 session，子 session 停下時主動以票號回報，並能看板、詳情、指揮、關閉。Use when asked to 開中控台, worktree console, 管多個 session, 丟票開工, 現在狀況, <票號> 詳情, 關掉 <票號>. 硬需求：在 Orca、herdr 或 Herdr app 的分頁裡開。
---

# Worktree Console

把這個 session 當中控台：一張 Linear 票對應一個 worktree 與一個長駐的 claude 子 session。中控台負責開票對齊、轉達問題、送指令、看板與關閉，不能做的事見〈界線〉。一個中控台管 Orca 裡所有 repo 的 claude session。

長期原則：**中控台輸出只放問題與表格**（外加送出／開工／關閉的結果行），不加說明、加總或提示行。

## 硬需求與啟動

本 skill 只能在 Orca、herdr 或 Herdr app 的分頁裡運作，依中控台所在的工具自動選用：`HERDR_ENV=1` → herdr 模式，否則有 `HC_TERMINAL_ID` → Herdr app 模式，否則有 `ORCA_TERMINAL_HANDLE` → Orca 模式，三者皆無就停下並說明「worktree-console 只支援 Orca、herdr 與 Herdr app」。**herdr 模式先讀 `<base>/references/herdr.md`**，其中寫明與 Orca 不同的步驟（第 1 步改查 `herdr status`、開工、Linear、⚠️ 狀態）；**Herdr app 模式先讀 `herdr.md` 再讀 `<base>/references/herdr-app.md`**（偵測方式、與舊 herdr 不同的地方、看板 pane 的位置與過期提示）；以下以 Orca 模式為主。

1. `command -v orca` 與 `orca status --json | jq -c 'if .ok then {ok, reachable: .result.runtime.reachable} else {ok, error: .error.code} end'`（成功只印 `ok` 與 `reachable`，`ok:false` 時另帶 `error.code`）：找不到指令、`ok:false` 或 `reachable` 不是 true → 停，回報原因。
2. 取啟動 repo：`REPO=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")`（主 checkout 絕對路徑）。`console.mjs` 一律帶 `--repo "$REPO"`；它只決定開票的預設 repo，看板、指揮、關閉涵蓋 Orca 所有 repo（`orca repo list --json` 有每個 repo 的 `path` 與 `displayName`）。
3. 腳本一律用本 skill 載入時給的 base directory 組絕對路徑：`node <base>/scripts/console.mjs …`、`node <base>/scripts/watch.mjs …`，不要依賴 cwd。orca 執行檔可用 `ORCA_BIN` 覆寫。接著跑 `console.mjs prompt`，用 Read 完整讀它印的 `檔案：` 那份中控台 prompt，照其中〈中控台〉一段做；**每次啟動都要讀，不可略過**（使用者的自訂版本放在中控台設定目錄的 `prompt.md`，有就取代內建版本）。
4. 清殘留：`pgrep -f "worktree-console/scripts/watch.mjs"` 找到的程序中，`ps -o ppid= -p <pid>` 為 1 的（孤兒）直接 `kill`。
5. 跑 `console.mjs board --repo "$REPO"`，再跑 `console.mjs archived --repo "$REPO"`，兩段輸出依序原樣貼給使用者（`archived` 沒輸出就不貼）。
6. 掛 watcher（見〈主動回報〉），第一次掛不帶 `--baseline`；中控台這一輪停下後，watcher 會替中控台自己的 session 送一次 `/remote-control`（手機的 remote control 清單就看得到中控台），中控台不用自己送、也不要再送（重送會跳出對話框）。子 session 一律不開 remote control，watcher 會以第一輪輪詢為基準。印 `[watch] already-running` 表示另一個中控台（或舊版帶 `--repo` 的 watcher）正在監看：問「已有另一個中控台在監看，要不要由這裡接手？」，回要就加 `--takeover` 重掛（會先停掉舊的），回不要就不掛，之後只在使用者開口時看板。中控台是被自動交棒開起來的（接手指令會寫明）時直接加 `--takeover`，不問。
7. 跑 `console.mjs todo --repo "$REPO"`（見〈待開工的票〉）。

orca `--json` 回傳一律是 `{ok, result}`；`ok:false` 時看 `error.code`（例如 `timeout`、`terminal_handle_stale`、`linear_issue_required`）。branch 顯示前剝掉 `refs/heads/`。

## 腳本一覽（除 `answer`、`send`、`close`、`prune`、`handoff`、`ask`、`ask-tab`、`rename`、`review done` 外不動 Orca 與 git；封存、專注模式與問問題的子指令見各自段落）

| 指令 | 用途 |
| --- | --- |
| `console.mjs board --repo R [--aligning "[<repo>/]<票號>=<票名>"]…` | 看板：依 repo 分成多張 markdown 表格，每張上方一行 `**<repo 名稱>**`（只有一個 repo 也照樣有），表頭 `狀態｜票號｜摘要｜階段｜最後動態`，一個 session 一列（多 session 的 worktree 標 `<票號>#n`）；💤 閒置與封存的 session 移出表格，整張看板最下面空一行列跨 repo 合計 `封存 N 個、閒置 M 個`（只有數量、同一 worktree 的多個 session 各算一個；為 0 的項目不寫，全 0 不印），某 repo 全部閒置／封存時只有 `**<repo 名稱>**` 與一行 `全部閒置／封存`；只列有 claude session 的 worktree；待回覆清單不是空的時，空一行後附上。順便把自己登記成中控台 |
| `console.mjs after-send --repo R <票號>[#n]… [--aligning …]` | 送出後接著跑，可一次帶多個 tag；印出什麼見〈指揮〉第 6 步。有 mods 時改印一行 `等 <代號> 回應中…　還有 N 題排隊`（見 `references/focus.md`） |
| `console.mjs detail --repo R <票號或數字>[#n]` | `摘要：<完整票名>`、repo、branch、worktree 路徑；單一 session 列 terminal 與狀態，多 session 時逐一列出 `#n <狀態>｜<handle>｜最後指令：…`，帶 `#n` 只看該 session；其下每個待你處理的 session 各空一行接一段回報，與 watcher 回報同一格式（標題＋完整引用框或選單表格），🔄 執行中、💤 閒置不出 |
| `console.mjs resolve --repo R <票號或數字>[#n]` | `{match:"none"\|"one"\|"many", rows:[{repo,main,ticket,branch,path,handle,session,tag,status,prompt}]}`，一筆＝一個 session；沒有 session 的 worktree 也找得到（handle 為 null）|
| `console.mjs answer --repo R <票號>[#n] <答案>` | 代按子 session 開著的選單，或回 🔐 授權請求 `允許`／`拒絕`（見〈指揮〉），送完等它離開等待狀態；輸出 `[票號] 已選擇：…`／`[票號] 已允許`／`[票號] 已拒絕`，失敗 exit 1 且不送任何按鍵 |
| `console.mjs send --terminal H --tag T -- <文字>` | 把文字送進子 session 並讀畫面確認（見〈指揮〉第 1 步）：`[T] 已送出`、`[T] 已送出（排隊中）`、`[T] 已送出（已按 Esc 退回對話後重送）`；子 session 執行中卻還沒在畫面上看到那句時印未確認狀態 `[T] 已送出（子 session 執行中，畫面上還沒看到這句，等它停下再確認）` 並 exit 0；未送達印 `[T] 未送達：<原因>` 加畫面最後幾行並 exit 1 |
| `console.mjs nickname --repo R <branch 或代號> <暱稱>` | 存中控台替 worktree 取的暱稱（3～5 個英文小寫字母）：`[<暱稱>] 已存暱稱：<branch>（<repo>）`；格式不對印 `[<暱稱>] 暱稱要 3～5 個英文小寫字母`、跟任何 repo 已有的暱稱或代號撞名印 `[<暱稱>] 暱稱已被使用，請換一個`，都 exit 1 |
| `console.mjs rename --repo R <代號> <名稱>` | 「<代號> 改名 <名稱>」：存下名稱，看板、專注橫條、待回覆清單、herdr 分頁名稱立刻換成新名稱；停著的 session 立刻送 `/rename <名稱>` 改 Claude Code session 名稱，還在跑（或等你回應、授權）的記下來，等它停下由 watcher 送。輸出 `[<名稱>] 已改名：<舊代號> → <名稱>`，有沒停下的再加一行 `<代號> 還沒停下，Claude Code session 名稱等它停下再改`；名稱不合格式或撞名印 `[<名稱>] 不能用：<原因>` 並 exit 1 |
| `console.mjs asks [--since YYYY-MM-DD] [--days N]` | 使用者說「問了幾次」「被問幾次」時跑，輸出原樣貼出。只讀 advisor 的 `answers.jsonl`（`ADVISOR_HOME`，預設 `~/.advisor`），期間預設 `--days 7`、結束在今天（帶 `--since` 就從那天起算）。每個 worktree 一列 `代號｜問你幾次｜agent 自己能回答｜比例`，依問的次數由多到少；最下面一行本期合計，再一行前一個等長期間的合計與差值。「問你幾次」只算 `source` 是 `console` 或 `tab`、`kind` 是 `text` 或 `menu` 的回答（代回、代錯改正、自由提問不算）；「自己能回答」＝有 `childSuggestion`，且回答開頭的選項字母和它相同、回「照建議」「全照建議」開頭，或批改單回 a、b。同一個 worktree 跨交棒的 session 合成一列（`path` 往上找到 `.git` 所在的目錄），代號用它最後一筆紀錄的 `tag`。沒有紀錄印 `期間內沒有回答紀錄`。最後一行 `等待判斷：看板顯示回覆完畢、沒列入等待 N 次，其中你接著回答了 M 次（P%）` 讀事件紀錄的停下事件：⏸ 而且沒列入等待的停下，在它下次停下前你回答了它（選項字母、照建議、好／確認這類短回答，或題目裡「」引起來的字）就算一次；你另外下的新指令、續命那輪的「收到」、還沒記「有沒有列入等待」的舊停下都不算。不登記中控台、不需要 Orca 或 herdr |
| `console.mjs qa [<代號>…] [--grep 關鍵字] [--days N \| --since 時間 [--until 時間]] [--limit N]` | 使用者要查「問過什麼、怎麼回的」時跑，輸出原樣貼出。一題一行 `時間｜代號｜問什麼｜怎麼回｜誰回的`（使用者／代回／分頁直接回），時間由舊到新。只讀不寫 advisor 的 `answers.jsonl`；沒記題目的，用同一個 session 稍早的停下事件，或子 session 最後一段補上（先讀對話副本，副本已刪就讀 `~/.claude/projects` 的原始對話），補不到寫 `（沒記到題目）`。時間接受 `YYYY-MM-DD`、`YYYY-MM-DD HH:mm`、`today`、`yesterday`、`3h`、`2d`，`--until` 給日期時算到那天結束；不帶時間只列今天，`--days N` 是含今天往前 N 天。沒有符合的印 `這段時間沒有問答紀錄`。不登記中控台、不需要 Orca 或 herdr |
| `console.mjs waiting-line --repo R` | 印一行 `等待：…｜自動處理中：…｜在跑：…｜延後處理：…`（代號以「、」分隔，空的寫「無」）。先看子 session 回覆的最後一行（續命中的 session 看續命前記下的原題，不看「收到」；交棒失敗的舊分頁在你回覆前、接手的新分頁在你回覆前，看交棒前那則回覆；閒置時被壓縮不算新指令）：`等你：…` 算等待、`已完成`（舊寫法 `不用等你`）不算，但 worktree 還有沒 commit 的改動或遠端同名分支沒有最新 commit 時仍算等待；沒寫這行時（中控台管的 worktree 裡，Stop hook 會先擋一次要它補上；續命、交棒那一輪不擋；第二次仍沒寫照樣放行，那則一律算等待），💬、選單、🔐、⚠️ 一律算等待；⏸ 先看這次停下的背景摘要第四層（`要你決定` 算、`下一步` 不算；Orca 的摘要要是這一則回覆的才算），摘要還沒好時，看最後一段（後面只接備註、提醒、標題、分隔線時往前看，最多倒數第 4 段）有沒有在等使用者（「等你」「請確認」「說「定稿」」「按「送出決定」」「審核頁＋按／勾／選」「回 a／b／c」這類字，「跟我說」「告訴我」不算）。自動處理中＝中控台代回後還在跑這一輪的（卡片顯示「↻ 代回中」）；在跑＝其他 🔄；延後處理＝在等你、但你在焦點橫條按過延後處理（`focus.json` 的 `bumped`）的，停下超過一天加 `（等了 N 小時）`。**中控台每則回覆的第一行原樣貼它的輸出。** |
| `console.mjs guide [<代號>…] --repo R [--mine "<建議>，<理由>"] [--self <題號,…>]` | 中控台每則回覆最後原樣貼它印的兩行：`` `建議`：… ``（帶 `--mine` 時是「回 <代號> <中控台建議>，<理由>」；否則目前這件有 advisor 建議時「回 <代號> <答案>，<理由>」、在等你但沒有建議時「回 <代號>（按 9 看題目）」、已完成但還沒推時寫缺什麼與下一步、沒有一件在等你時「不用做事，等 <代號> 回報」或「不用做事」）與 `` `等待`：… ``（`waiting-line` 的內容，開頭的「等待」包進行內程式碼）。帶代號時先替每個代號印原題：批改單只印每個「待決定 N」的題目行、選項與「建議：」行；其他文字題印最後一個「第 N 題」那段，沒有出題格式時印最後一段；選單題印題目與選項；每個「建議：<答案>」都接「，<一句理由>」，沒有 advisor 建議時寫「，子 session 自己的建議」。`--mine` 另印一行「中控台的建議：…」，`--self` 列要使用者本人回的題號（其他算照建議）；這些與兩行結尾記進該 session 這次停下的紀錄（`guide.json`），狀態區照它畫，session 再停下就作廢 |
| `console.mjs stage --path <worktree>` | 印一行 JSON `{"stage":"<未開工｜規劃中｜實作中｜已推送>","source":"<判斷依據>"}`，判斷規則同看板的「階段」欄（見 `references/status-stage.md`），`source` 是 `dirty`、`pushed`、`ahead`、`dev-flow-plan`、`goal-file`、`interview-comment` 或 `none`；不是 git worktree 印 `{"stage":"unknown","source":"not-a-worktree"}`。只讀 git 與檔案，不登記中控台、不需要 Orca 或 herdr；給 advisor 這類背景腳本查階段用（腳本路徑記在 `~/.worktree-console/.state/managed.json` 的 `script`） |
| `console.mjs review add --question Q --plan P (--basis 沒有前例[；補充] \| --source <出處>) --impact I --by advisor\|child --stop S [--path W]` | 記一筆沒問使用者就做的決定，寫進 `~/.worktree-console/reviews/<repo>/<branch>/review.jsonl`（編號、時間、repo、branch、票號、worktree 路徑、session、題目、當前方案、依據、影響範圍、誰代回、對應停點）。寫入時就檢查格式：缺欄位、說明句超過 40 字、程式碼區塊或行內程式碼以外的程式碼都當場拒寫並印 `第 N 件「欄位」不合格：…`。`review correct --n N …` 寫一行更正覆蓋該件內容。紀錄只往後追加，以 worktree 路徑＋編號對應，branch 改名後照樣找得到 |
| `console.mjs review sheet [--path W] [--markdown]` | 印出這個 worktree 還沒審的審核單（格式見〈實作前審核〉）；有不合格的件就拒絕產生並印哪一件哪一欄。`--markdown` 印給 draft PR／MR 說明用的版本 |
| `console.mjs review elsewhere\|reviewed --path W` | 只有中控台能跑：使用者不在審核單上回答（見〈實作前審核〉）時記成審完並解鎖；`elsewhere` 把還沒審的件標「在別處回覆」、不寫回 advisor 的猜中與否 |
| `console.mjs review data\|pass\|edit\|undo\|pass-all\|ask\|done --path W …` | 焦點面板的審核單畫面用：`data` 給 JSON、`pass --n N` 通過、`edit --n N --to T` 改、`undo --n N` 把通過或改過的那件退回待審、`pass-all` 通過「照你過去的回答」那區剩下的、`ask --n N [--q Q]` 就地問（不帶 `--q` 是要範例；帶 `--q` 時在背景的 claude 答：工作目錄是這個 worktree，只開 Read、Grep、Glob，帶 `--restricted --strict-mcp-config`，用 `--add-dir` 加上這張票存在的規劃資料夾（`~/.sara-dev-flow/<repo>/<branch>`、主 checkout 的 `.goals/`），100 秒逾時；prompt 列這張票的規劃檔路徑（dev-flow 規劃資料夾裡的檔、`.goals/<slug>.md` 與它的 checklist、這條 branch 相對 base 新增或改過、或未追蹤的 spec／plan／goal／userflow／handoff／decisions／assumptions .md；找不到 base 時只列未追蹤的）並貼子 session 的對話最後一段，要它先讀規劃檔與相關程式碼再答、三句內、最後一行寫「出處：<檔案:行號>」，讀完仍查不到才回「查不到：…」）、`done` 審完：寫已審標記、把結果寫回 advisor、送一則「（中控台自動訊息，不是使用者的新指令）審核完成：N 件通過、M 件已改，請重跑剛才被擋的指令」回原 session。改狀態的子指令只有中控台與面板能跑：子 session 的 Bash 真的執行到 `console.mjs review <改狀態的子指令>`（含旗標、變數、反斜線、命令替換、`sh -c`、`xargs` 的寫法），或子指令要跑了才知道的，hook 一律擋下；只是讀、搜尋、改 console.mjs 的指令不擋。子 session 每個 Bash 指令前後，hook 比對這個 worktree 的審核狀態（審完沒、每件的狀態），被改了就還原並鎖住 session，不管指令怎麼寫；中控台、面板與在別處回覆寫入前會留時間戳記，同一段時間的改動不算。指令本身也會檢查呼叫者（Claude Code 給 shell 的 session，面板帶自己的 `--session`），拿不到、空的或對不上一律拒絕，但這只是輔助：可信的身分只有 hook 拿到的 session_id |
| `node <base>/scripts/involvement.mjs [--from D] [--until D] [--days N]` | 印出涉入佔比（你回答÷全部回答）、每天回答次數、每天超過 25 分鐘沒被打斷的段數；只讀事件紀錄與 advisor 的 `answers.jsonl` |
| `watch.mjs [--baseline <快照>] [--takeover]` | 全機唯一的常駐監看，涵蓋 Orca 所有 repo；有 session 進入待你處理的狀態就輸出回報＋完整看板並結束（有 mods 時只為定稿叫醒，只印那一則回報）；暫存 worktree 的最後一個分頁關掉後，乾淨的自動移除（見 `references/ask.md`） |

狀態只有五種（herdr 模式多一種 ⚠️ session 異常，需手動排程，見 `references/herdr.md`）：🔄 執行中（子 session 正在做事）、🔐 等待授權（等你允許它執行工具）、💬 等待回應（問了問題或開了選單在等你答）、⏸ 回覆完畢（這一輪回完，等你下一步指令）、💤 閒置（沒有在跑）；「待你處理」包含等待授權、等待回應、回覆完畢三種。

階段只有四種：未開工、規劃中、實作中、已推送。

要知道是哪個 💤 閒置 session，看專注面板的「全部」分頁（卡片標「閒置」），或用代號跑 `detail`（`resolve`、指揮照樣找得到閒置 session）。watcher 回報後的看板與 `after-send` 貼的看板同一規則。為了讓整列壓在 100 欄內（中文與 emoji 算 2 格），狀態、票號、階段三欄保持原字，剩下的寬度分給摘要與最後動態，放不下就截短並以「…」結尾；完整票名看「詳情」。

同一個 worktree 有兩個以上 claude session（扣掉中控台自己）時，依開啟順序編號成 `<票號>#1`、`<票號>#2`（Orca 沒給建立時間就依 paneKey 固定排序）；只有一個時不加編號。`resolve` 候選與 `detail` 用最後一則指令區分各 session；指令為空（例如接續舊對話的 session）就改顯示 `說：<該 session 最後回覆最後一段的前 20 字>`，兩者都空才顯示「（無）」。回報標題、看板列、`resolve` 的 `tag`、`detail` 都用同一套編號。不同 repo 的代號撞名時，看板、回報、待回覆清單、`resolve` 都改用加了 repo 的代號，指揮也用它；沒撞名時代號不加 repo：

- 同一張票開在多個 repo：票號後面接 repo 的縮寫，例如 `sara-v2-frontend` 與 `sara-v2-backend` 的 `SARA-7063` 顯示成 `SARA-7063-fe`、`SARA-7063-be`。縮寫先看 `~/.config/worktree-console/config.json` 的 `repoAbbreviations`（`{"<repo 名稱>": "<縮寫>"}`），沒設定就把這幾個 repo 名稱共同的開頭字去掉，再把 `frontend`／`backend` 縮成 `fe`／`be`；縮完兩邊還是一樣時改接完整 repo 名稱（`SARA-7063-sara-v2-frontend`），不會出現兩個一樣的代號。
- 其他代號撞名（例如兩個 repo 的主 checkout 都是 `dev`）：改用 `<repo 名稱>/<代號>`（如 `proj-v2/dev`）。

## 實作前審核

子 session 規劃時，非緊急題由中控台直接代回、它自己推測的決定也記下來；這些決定在進入實作前集中成一張審核單，由使用者在焦點面板一次審完（畫面與按鍵見 `references/focus.md`〈審核單〉）。

- 開場規則：worktree-console 的 SessionStart hook 替每個 session 加四條規則：緊急名單 10 類一律停下問使用者；其他推測的決定用 `console.mjs review add --by child` 記下；CLAUDE.md〈停點〉五個條件都成立就直接做，不在結尾等「開工」「OK」「繼續」，「送出並合併」仍等使用者本人說；每次停下，最後一行固定寫 `等你：<要使用者做什麼>` 或 `已完成`。
- 緊急名單 10 類（一律不代回、當下上待回覆）：等待授權、session 異常、不可逆或對外動作（推 main、force push、合併、刪資料或 branch、寫 Linear／Slack、改遠端設定）、代價高的決定（方向、範圍、資料寫入、權限）、需使用者本人判定的驗收與原型確認、加進〈不做〉或拿掉先前決定、要用秘密值、要連 SSH 或 RDS、連續 3 個假設失敗、判斷不出是否緊急。一則訊息只要有一題緊急，整則算緊急。判斷由 agent-skills advisor 的背景預測做（模型＋關鍵字補網），超過 2 分鐘判不出來算緊急。
- 代回：watcher 每一輪把判成非緊急的題先記成審核項目，再用 `console.mjs reply --only <代號>` 送出（不倒數、不看題型猜中率），送失敗補一行「未送出」；中控台輸入框有字時不代回。哪些題照常上橫條、批改單與 implement 的「送審」怎麼處理，見 `references/focus.md`〈只有緊急題上橫條〉〈代回〉。
- 攔截點（`hooks/review-gate.mjs` 的 PreToolUse）：這個 worktree 有待審代回、又沒有「已通過實作前審核」標記時，擋下前端 dev-flow 的 `approve`（含 `--auto`、`--user-said`）、後端的 `confirm-spec`、define-goal 的 `handoff-files.mjs`，以及 Edit、Write、MultiEdit、NotebookEdit 改 worktree 裡的檔（worktree 外、`.goals/`、dev-flow run folder、`spec.md`、`plan.md`、自動交棒說明檔放行），並印「先跑 console.mjs review sheet、停下等使用者審核」。比對的是子命令：flow 腳本後第一個詞是 `approve`／`confirm-spec` 才擋，`event start --phase approve` 不擋；`console.mjs review` 開頭的指令放行，但後面用 `;`、`&`、`|`、`(`、換行、`$(` 或反引號串了其他指令時照一般指令檢查。前三個攔截點另外檢查 worktree：規劃產物以外有任何改動就擋下。讀不到審核紀錄或出錯時一律擋下並寫原因。
- Bash：攔截點不比對 Bash 的寫法。有待審代回且沒有已審標記時，PostToolUse 在每次 Bash 前後用 `git status` 比對 worktree；規劃產物以外多出改動就鎖住這個 session（之後的改檔工具與 Bash 一律擋下，只放行 `console.mjs review` 開頭的指令），不還原檔案，審核單「先看」那區照編號多一件「規劃階段改了這些檔」列出檔名，由使用者決定留著或還原。
- 已審標記：審完（面板 `done`，或下面「不在審核單上回答」的兩種情況）時寫入；dev-flow `reopen` 或後端 spec 改回 `status: draft` 時清掉。有標記之後新記的代回屬於實作階段，不擋流程。
- 審核單格式：第一行 `審核單：<代號>`；第二行左邊 branch（有 PR／MR 時接 ` · PR #N`）、右邊 repo；只分「先看：沒有前例」（每件四行：題目、當前方案、依據、影響範圍）與「照你過去的回答」（每件兩行：題目、當前方案＋出處）；沒有開頭說明句、沒有提醒。每欄一句白話、40 字內、不放程式碼（寫入時就檢查）。
- 什麼時候給使用者看：子 session 被攔截點擋下時照擋下訊息貼出審核單並停下；define-goal 與前端精簡路徑的批改單、前端完整路徑原型開好那次停下時，回報後面直接接上審核單（卡片同時顯示原型確認與「需審核 N 件」），子 session 因攔截點停下的那則訊息一律不代回。
- 不在審核單上回答：使用者本人打的訊息（不是續命、交棒訊息，不以代回前綴、「（中控台自動」、`接手交棒：` 開頭）只在兩種情況記成審完並解鎖：(1) 回覆的是攔截點擋下、貼出整張審核單的那則（在中控台用 `reply`／指揮送出，或直接在子 session 分頁回答都算）；(2) 在中控台回 define-goal 或前端精簡路徑的批改單。還沒審的件標「在別處回覆」，不寫回 advisor 的猜中與否；面板卡片的 `待審核`、`需審核 N 件` 跟著消失。在子 session 分頁直接回批改單照舊不解鎖，動工時由攔截點擋下貼出審核單。
- 審完之後：整張審完一律送一則訊息回原 session（有改的件附在後面）；原 session 已交棒時沿交棒事件的舊／新 session 找到現在的 session，它正在工作就先排隊、停下再送；找不到交棒鏈（超過 24 小時或 dev-flow 自己換分頁）時送給那個 worktree 目前沒封存的 session。通過的件記成 advisor 猜中、改了的記成猜錯（用 advisor 的 `verdict`），在別處回覆的件不記。
- draft PR／MR：watcher 偵測到這張票的 draft PR／MR 開好後，把審核單的 Markdown 版與實作階段的代回補進說明一次，和「請先看」合成一份。
- 沒有 mods 時：使用者說「<代號> 審核」就跑 `review sheet` 原樣貼出；回「<代號> 第 N 件改成 …」跑 `review edit`，「<代號> 審核通過」把其餘的件 `review pass` 後跑 `review done`，輸出逐字轉貼。

## 名稱

中控台開的每個 session 都有名稱：開 claude 時一律帶 `claude --name <名稱>`（正式開工、暫存 session、臨時分頁、`open`、`move`、需求訪談交棒、自動交棒都一樣；Orca 用 `orca worktree create` 開的 session 改由 watcher 在它停下時送 `/rename`），herdr 模式的分頁也一律有名稱，中控台自己的分頁叫 `console`。名稱沒另外給時就是它的代號（票號、暱稱或 branch）。

- 使用者可以在開工或開暫存 session 時給名稱（例如「PROJ-123 開工，名稱 login-fix」「問：README 在講什麼？名稱 docs」），開了之後用「<代號> 改名 <名稱>」改（跑 `console.mjs rename`，輸出逐字轉貼）。沒給名稱就照舊由中控台取暱稱。
- 名稱只收英文小寫、數字、`-`，2～20 字元，不能和既有名稱、任何代號（含票號）或 repo 名稱重複；名稱同時是指揮用的代號，所以不合格式或撞名一律拒絕並印原因（大寫、中文、空白、21 字元都會被拒絕）。
- 有名稱的 session，看板、專注橫條、待回覆清單、回報都顯示名稱，不顯示票號，也不加 repo；票號只出現在「詳情」的 `票號：` 一行。打名稱或原本的票號都指揮得到它。
- herdr 模式：watcher 每一輪會替名稱還是純數字、裡面有 claude 在跑的分頁補上名稱（有使用者名稱用名稱，否則有票號用票號，再不然用 branch 或資料夾名），已經有非數字名稱的分頁不改；中控台自己的分頁改成 `console`。Orca 模式不改分頁名稱。

沒票也沒暱稱的 worktree（同票同 repo 有多個 worktree 時括號裡那段也是）由中控台替它取暱稱：`board`、`after-send`、watcher 回報最後出現 `待取暱稱：<branch>（<repo>）、…` 時，這一輪先替每個 branch 取一個 3～5 個英文小寫字母、念得出意思的暱稱（例如 `feat/backend-api-request-comment` → `cmnt`），用 `console.mjs nickname` 存下（撞名就換一個再存），不必告訴使用者，存好再處理其他事。暱稱存在 `~/.config/worktree-console/nicknames.json`，之後看板、卡片、回報、`/focus-show` 都用它當代號（同票同 repo 是 `<票號>(<暱稱>)`），不加 repo 前綴；還沒取名前代號是拿掉類型前綴、截到 8 格加「…」的 branch（例如 `backend…`）。指揮時打暱稱、截短代號或完整 branch 名稱都認得。

中控台之間互相排除：每個中控台跑 `board` 時會把自己的 Orca 分頁登記在 `~/.config/worktree-console/consoles.json`，登記過的分頁不上看板、不被回報；分頁關掉後自動除名。正在自動交棒的舊 session（寫交棒說明起）與新 session（確認接手前）同樣不上看板、不被回報。

## 主動回報（watcher）

用 Bash `run_in_background: true`、`timeout: 7200000` 執行：

```bash
node <base>/scripts/watch.mjs [--baseline "<上一輪最後一行 baseline: 後面的內容>"] [--takeover]
```

- 整台機器只掛一支（所有 repo 共用）；腳本自己會用 `pgrep` 檢查，印 `[watch] already-running` 時照〈硬需求與啟動〉第 6 步問要不要接手。
- 每一輪順手做三件不出聲的事（不叫醒中控台、不印任何東西）：中控台自己的 session 停下後送一次 `/remote-control`（每個中控台 session 只送一次，自動交棒換成新的中控台 session 時再送一次）；herdr 模式替純數字的分頁補名稱、把中控台的分頁改成 `console`（見〈名稱〉）；送出等 session 停下的 `/rename`。
- 被 watcher 叫醒時，讀它的輸出：
  - 回報：每則以 `### <emoji> <票號[#n]> <等你回應／等你選擇／等你授權／回覆完畢>` 開頭，空一行後是子 session 原文（引用框內、不截斷；原文裡的 markdown 表格放在引用框外，照樣畫成表格；herdr 模式是你上一則指令之後這一輪說的所有文字）或選單表格；文字題有這次停下的摘要時，最下面接 `── 摘要 ──` 與四層摘要（watcher 等摘要最多 15 秒）；同一輪有幾個 session 變動就有幾則。接著是先前回報過、還停在 💬／🔐 的 session，各自完整重貼一次，標題結尾加「（先前已回報，尚未回覆）」，免得使用者往上捲找。全部之後是 `---` 與一張完整看板；待回覆清單不是空的時，最後再附上。有 mods 時（只有定稿會叫醒）只印定稿那幾則回報，不附看板、待回覆清單與 `待取暱稱：`。除了最後一行 `baseline:`，其餘**整段原樣貼出**，不改寫、不摘要、不合併、不摺疊。然後立刻帶 `baseline:` 後面的內容重掛。
  - 待回覆清單：標題 `### 📋 待回覆`（不含題數），下接表格 `狀態｜代號｜問題｜選項｜建議`，收 💬、🔐，以及 ⏸ 回覆完畢（子 session 回完一輪、在等你下一步指令；問題欄放最後一句；已推送 的也收）。代號就是看板的 tag，選單多題時每題一列並加圈號（`6923①`）；選項一律以 a、b、c 標示：文字題的選項欄由腳本截取（只看最後一個「第 N 題」之後；子 session 問「選哪個／哪一種」、建議點名清單裡的代號、或選項標「（建議）」才算選項，是非題與理由清單一律「—」；大小寫字母與數字都認，照子 session 原寫法送出）成 `a 專注模式當預設／b 預設維持現在的全…`（行首粗體段，否則到第一個「，：。—（」為止，每項最多 8 個中文字；`**A（建議）：…**` 這種寫法也認；子 session 把選項寫成表格、第一欄是 A、B 或 1、2 這類代號時，取第一欄當代號、下一欄當標籤），選單題是「字母 標籤」；回報的選單表格同樣用 a、b、c，文字題回報在引用框後附一份 `- a. …` 對照。建議只轉述子 session 自己給的（選單標 Recommended、文字寫「建議是：」「我建議」「推薦」或選項行標「（建議）」「（我的建議）」「（Recommended）」、⏸ 最後一段的「下一步建議…」），沒有就是「—」，**中控台不自己補建議**。
  - `[watch] orca-unreachable`：跑一次 `orca status --json` 回報使用者，**不重掛**，等使用者下次開口時先檢查 orca 再重掛。
  - `[watch] timeout`：直接帶 baseline 重掛，不必告訴使用者。
  - `[<暱稱>] 未移除：…`：使用者關掉暫存 worktree 最後一個分頁，但它有未 commit 改動或有 commit 所以沒自動移除（見 `references/ask.md`），只原樣貼這一行，不當待處理、不貼看板，帶 baseline 重掛。
  - `[票號] 已自動交棒（context N%）`、`[票號] 已自動交棒（快取將到期）`、`[票號] 已交棒（手動）`、`[票號] 自動交棒失敗：…`：子 session 換手的結果（見 `handoff` skill 與〈快取續命〉），只原樣貼這一行，不當待處理、不貼看板，帶 baseline 重掛。`[票號] 續命時沒照指示只回「收到」…` 一行同樣處理。
  - `[試營運] 到期，報告：<路徑>`：試營運到期（`automation.json` 的 `trial.until` 當天或之後、這一期還沒有報告），watcher 已用 advisor 的 `trial-report --final` 產生報告。照中控台 prompt〈中控台〉一段的試營運規則處理（內建範本 `templates/prompt.md` 有寫；自訂版沒寫就只原樣貼這一行），不貼看板，帶 baseline 重掛。開始滿 7 天時 watcher 另寫一份期中報告 `~/.advisor/reports/trial-<到期日>-midterm.md`，不印、不叫醒中控台。沒有 `automation.json`、沒裝 advisor 或產報告失敗時 watcher 什麼都不做。
  - 沒有任何輸出就結束（被另一個中控台接手停掉）：**不重掛**，回一行「監看已交給另一個中控台」。
  - 收到 watcher 背景工作被停掉的通知（task-notification 狀態 `stopped`，或寫「didn't finish before the previous session ended」，常見於中控台的 Claude Code session 重啟）：不問使用者，直接帶最後一次的 `baseline:` 加 `--takeover` 重掛；手上沒有 baseline 時只加 `--takeover`。
- 觸發條件：任一 session 進入等待授權、等待回應或回覆完畢，且跟上一輪不同；回覆完畢與文字提問要等子 session 這一輪真的結束（Stop hook 記下結束時間）才算，選單與授權框跳出來就算（細節見 `status-stage.md`）（轉成執行中或閒置不叫醒你，下次回報的看板會反映）。不帶 `--baseline` 掛的第一輪只當基準，但停在「定稿完成（動工）：」或「定稿完成：」、停下紀錄裡還沒有這次停下的 session 會補叫醒一次（watcher 沒在跑時漏掉的定稿），只印那一則回報。使用者直接在 Orca 分頁打字造成的變動一樣會被回報（看的是狀態轉換，不是誰送的）。
- 中控台自己的每一則回報也要以 `[票號]` 開頭；沒綁票號的用暱稱，沒有暱稱才用 branch 名稱。

## 快取續命（watcher 自動做，中控台不用動手）

子 session 的 prompt 快取從它停下起算一小時失效，過期後下一句話要整段重讀、貴很多。watcher 在跑時自動處理：

- ⏸ 回覆完畢、或用純文字出題的 💬，停下滿 50 分鐘（Orca 的 `stateStartedAt`）沒人回：送一次固定的續命訊息，只請它回「收到」、不要做任何事。原題由中控台記住，從送出續命到你回覆前，看板、待回覆清單、專注面板一直顯示原題與原選項，不會出現「收到」。續命完全不出聲：不叫醒中控台、不重新回報、不算你回覆過，專注排隊順序不變。它多講話或動了工具時才印 `[票號] 續命時沒照指示只回「收到」，畫面照舊顯示原題`；跳出授權或選單時照實顯示。
- 續命那輪停下後再滿 50 分鐘仍沒人回：原題是 💬 等你回答、而且 context 超過自動交棒的比例門檻（`handoff` skill 設定的比例，預設 40%）時，才用既有 handoff 流程換新 session（新 session 讀完交棒說明只原樣貼出原題），印 `[票號] 已自動交棒（快取將到期）`；⏸ 回覆完畢或 context 未達門檻就不交棒、不再送任何訊息，讓它自然過期。
- 換手過的 session 在你回覆前不續命、不交棒（畫面不另加標記）。你回覆任一子 session 後，它的計數歸零，下次停下重新計時。
- 🔐 等待授權、開著選單的 💬、封存、💤 閒置與拋棄式（見 `references/ask.md`）的 session 一律不碰；watcher 沒在跑時也不續命、不交棒。紀錄在 `~/.config/worktree-console/keepalive.json`。

## 待開工的票

有輸出表格時原樣貼出並問「要開工哪幾張？（可複選）」；使用者回 a、c 這類代號字母或直接回票號都認，選了就逐張走〈開票（對齊）〉，沒選的本 session 不再問。沒有輸出時不提。

輸出 `skip:no-config` 時讀 `<base>/references/todo-config.md` 照做。`skip:disabled` 與其他 `skip:…` 時不提。

## 要改檔案時

使用者的要求只要最後會動到檔案（不論有沒有票），一聽出來就先問「要不要開 session 做？」，不先讀 code 查原因（查原因也交給開出來的 session）。同意 → 有票走〈開票（對齊）〉，沒票走其中的〈沒有票〉；不同意 → 不改任何檔案。只是在 repo 裡問問題（不改檔案）走 `references/ask.md`。唯一例外是〈待開工的票〉的個人設定檔。

## 用到才讀

下列流程的內文在 `<base>/references/`，到了該時機才讀，讀完照做：

| 時機 | 讀哪份 |
| --- | --- |
| 丟票、選了待開工的票、同意開 session（〈開票（對齊）〉、〈沒有票〉、〈開工〉） | `kickoff.md` |
| 需求訪談的子 session 回報「定稿完成」（交棒） | `handoff.md` |
| 「關掉 <票號>」（〈關閉〉） | `close.md` |
| 「清理 branch」「prune」（列出並清掉已合併的本地 branch 與 worktree） | `prune.md` |
| 「報表」「最近卡在哪」等要看紀錄（〈過程紀錄〉） | `process-log.md` |
| `todo` 印 `skip:no-config`（待開工提醒的設定與篩選規則） | `todo-config.md` |
| 使用者問為什麼是這個狀態或階段，或寫詳情建議需要判斷階段時 | `status-stage.md` |
| 「封存 <代號>」（〈封存〉） | `archive.md` |
| 中控台在 herdr 分頁裡（`HERDR_ENV=1`）：啟動前；使用者說「<票號> 狀態錯了，其實是 X」；「把 <票號> 搬到 <工作區>」 | `herdr.md` |
| 中控台在 Herdr app 分頁裡（有 `HC_TERMINAL_ID`、沒有 `HERDR_ENV=1`）：啟動前（先讀 `herdr.md`）；看板 pane 沒出現或顯示過期 | `herdr-app.md` |
| 「問：<問題>」、「問 <repo>：<問題>」、「<代號> 問：<問題>」，或開頭那個字像 repo 名稱（3 個字元以上）且不是中控台指令（〈問問題〉） | `ask.md` |
| 對話出現 `/focus-show` 的輸出，或 `after-send` 印出 `等 <代號> 回應中…`（〈專注模式〉） | `focus.md` |

## 指揮（把話送進某張票）

1. 使用者的話開頭是數字或票號，可帶 `#n` 指定 session、`<repo>/` 指定 repo（例如「6923 跑測試」、「PROJ-6923 繼續」、「6923#2 停下」、「proj-v2/dev 繼續」）；任何 repo 的 session 都一樣送 → `console.mjs resolve --repo "$REPO" <開頭那段>`：
   - `one` 且有 handle：`console.mjs send --terminal <handle> --tag <tag> -- "<其餘內容>"`，輸出逐字轉貼。不直接用 `orca terminal send`：它回 `accepted:true` 只代表 Orca 收下，子 session 停在 `/workflows` 這類檢視頁時文字會被吃掉。腳本送出後讀畫面：那句話已進對話或排隊中才算送達；子 session 執行中（畫面有轉圈行、Orca 回報不是停下，或查不到狀態都算）卻沒看到那句時，一律不送 Esc（執行中按 Esc 會中斷工作）、不重送，回報未確認（exit 0，算送出成功，照第 6 步接著跑）；子 session 已停下時，畫面不是一般對話（看不到輸入框或認出檢視頁）就送 Esc 退回對話重送一次；一般對話畫面卻沒看到（可能被收成 `Pasted text`）時改讀子 session 對話紀錄的最後一則指令，含這段文字就算送達；紀錄也沒有才不送 Esc、不重送，直接回報未送達。未送達不自行再送。
   - `one` 但 handle 是 null（💤 閒置、沒有 claude 分頁）：
     `orca terminal create --worktree path:<path> --command "claude --continue" --json` →
     `orca terminal wait --terminal <新 handle> --for tui-idle --timeout-ms 60000 --json`，`satisfied:true` 才照上一條用 `console.mjs send --terminal <新 handle>` 送第一句；否則回報未送出。
   - 回的是待回覆清單上的題目且答案用 a、b、c（例如 `6923 b`）→ 改跑 `console.mjs reply --repo "$REPO" -- "<整則訊息>"`，輸出逐字轉貼；它照子 session 原寫法轉成 `B`／`2`／選單編號再用 `send`／`answer` 送出。為什麼值得加：清單與回報都改標 a、b、c，子 session 卻是照自己寫的 A／1 在等，不轉會送錯。
   - `many`：反問「要送哪一個？」，下面每個候選列一行 `- a. <tag>  <status>｜<prompt>`（字母依序 a、b、c；編號、狀態、最後一則指令前 20 字），不自己挑。使用者回字母（例如 `b`）就把原本那句話照本步送給該候選。
   - `none`：回報找不到這張票，附上看板。
2. 沒帶票號：處於待你處理（等待授權／等待回應／回覆完畢）的 session 只有一個就送它，並在回覆開頭標明 `[票號]` 或 `[票號#n]`；兩個以上（包含同一 worktree 的多個 session）就反問「要回哪一個？」，下面每個候選列一行 `- a. <tag>  <status>｜<prompt>`（格式同第 1 步 `many`），**不猜**；使用者回字母就把原本那句話照第 1 步送給該候選；一個都沒有就當成對中控台說的話。
3. 選單或授權畫面開著時，Orca 會擋下 `--text … --enter`（`agent_prompt_blocked`），所以這兩種情況照下面送，不走第 1 步的送法：
   - 「等你選擇」（選單）：使用者回 `<票號>[#n] <字母或編號>`、`<票號>[#n] 其他：<文字>`，多題用「；」分隔（例如 `6923 2；其他：XL`）→ `console.mjs answer --repo "$REPO" <票號>[#n] <答案>`，輸出逐字轉貼。不要自己用 `terminal send` 送數字。有預覽框的題目（選項右側有預覽）腳本會在數字後補按 Enter 確認。可複選題、有預覽框的題目回「其他：」、或回覆不是編號／「其他：」格式：先送 Esc（`--text $'\e'`）取消選單，再照第 1 步把回覆當文字送入，並告訴使用者「已取消選單，改用文字轉達」。
   - 「🔐 等待授權」：明確允許 → `console.mjs answer --repo "$REPO" <票號>[#n] 允許`；明確拒絕 → 同指令帶 `拒絕`；其他內容 → 先帶 `拒絕` 取消，再照第 1 步送文字，並告訴使用者「已取消該權限請求」。輸出逐字轉貼。
4. 看板上的外部 worktree（不是中控台開的）一樣能指揮，代號規則同〈主動回報〉最後一條。
5. 每張票送各自的內容，不做群發（同一段話送給多張票）。`terminal_handle_stale` 時重跑 `resolve` 取新 handle，只送新的那個。
6. 送出成功後（文字指揮、選單代答、授權允許／拒絕都算），接著跑 `console.mjs after-send --repo "$REPO" <剛送出的 tag>…`（還在對齊的票照〈看板與詳情〉帶 `--aligning`），輸出原樣貼在送出回報的下一段：
   - 扣掉剛回的仍有 💬／🔐 在等 → 只貼剩下的待回覆清單。
   - 已無 💬／🔐 在等（只剩 ⏸ 也算）→ 貼完整看板。
   - 送出失敗（未送出、`send` 回未送達、找不到票、`many` 反問要送哪一個、`answer` exit 1）→ 兩者都不貼，不跑 `after-send`。
7. 「<代號> 改名 <名稱>」：照〈名稱〉跑 `console.mjs rename --repo "$REPO" <代號> <名稱>`，輸出逐字轉貼，不跑 `after-send`，不送任何文字進子 session（`/rename` 由腳本送）。
8. 「<代號> 照建議」（或 `<代號> 好`／`<代號> 可以` 等明確同意，或「<代號> 照建議，第 n 題改成…」）：中控台把該代號詳情建議的具體做法展開成一段完整指令（改過的題目換成使用者的版本，其餘照建議），照第 1 步用 `console.mjs send` 送出、照第 6 步跑 `after-send`；選單或授權畫面開著時照第 3 步用 `answer` 送建議的編號或允許。**不把「照建議」原文送進子 session**。
   - 只認本次對話最近一次對該代號貼出的詳情建議，且之後 watcher 沒再回報過該代號（子 session 沒有新回覆）。不符合就不送，回一行 `[代號] 沒有可用的詳情建議，請先看「<代號> 詳情」或直接回答案`；不改用看板或待回覆清單上子 session 自己的建議。
   - 為什麼值得加：子 session 看不懂「照建議」三個字，所以要展開成完整指令。限定最近一次詳情是因為畫面上同時有子 session 自己的建議，混用會不知道送出的是哪一份。

## 看板與詳情

- 「現在狀況」→ 跑 `board` 原樣貼出（含附在後面的待回覆清單）；對話中還在對齊、尚未建 worktree 的票，每張帶一個 `--aligning "<票號>=<票名>"`（預定 repo 不是啟動 repo 時寫成 `<repo>/<票號>=<票名>`），腳本會在該 repo 表格最後補一列 `| 💬 等待回應 | <票號> | <摘要> | 未開工 | 等你確認開工 |`、套用同樣的截短規則。不要自己手寫這一列。
- 「<票號> 詳情」→ 跑 `detail` 原樣貼出（回報段格式見〈主動回報〉）。
- 詳情建議：貼出 `detail` 後，對其中每段回報（待你處理的 session）由中控台另起一段建議；沒有回報段就不寫。**只有「詳情」這個入口准中控台補建議**，watcher 回報與待回覆清單仍不自己補建議。
  - 一個 session 一段：`[代號]` 開頭、一句現況、具體做法（多題逐題編號，各一行）、一句問句收尾，例如：

    ```text
    [PROJ-6923] 卡在 API 命名與測試範圍兩題。
    1. 命名用 fetchOrders，跟 plan.md 的 service 層一致
    2. 只補 service 層單元測試，E2E 留到下一張票
    照這樣回嗎？
    ```

  - ⏸ 回覆完畢寫「下一步該叫它做什麼」；沒有東西等拍板就不寫。
  - 子 session 自己附了建議也要寫出每題的具體做法，不能只寫「照它的建議」：同意就照抄具體內容，不同意或從 git／規劃檔看到矛盾就直說並給自己的版本。
  - 資料來源只限子 session 的完整回覆＋worktree 狀態（branch、`git status`、未 push commit、階段、目標檔／`plan.md` 等規劃檔），**不讀實作 code**；查不到的事實寫成「先叫子 session 查 X」。
  - 為什麼值得加：使用者打「詳情」就是要拍板，只看原文還得自己想答案；中控台補上每題的具體做法，看建議段就能回，也是〈指揮〉「照建議」展開時的內容來源。
- 中控台關掉重開後，重新走〈硬需求與啟動〉即可：看板只讀 Orca 的 worktree、票號綁定與 git；狀態檔只有中控台登記表、封存紀錄、專注狀態與續命紀錄，都在 `~/.config/worktree-console/`。

## 界線

- 中控台不寫實作 code、不 commit、不 push、不開 PR／MR；階段只追到「已推送」。過程紀錄的 commit 由 watcher 在 `~/.worktree-console` 自己做，中控台不碰。
- Linear 只讀。herdr 模式的 Linear API key 只放在 macOS 鑰匙圈，由使用者自己在終端機設定；key 不進對話、指令參數或任何輸出。
- 同一時間只留一個中控台。
- 不走 Orca orchestration 的一次性任務模式（Run／Dispatch／worker_done）。
- 除了開工時的 `--comment interview` 標記，不把階段寫進 worktree comment（子 session 的 orca-cli skill 會覆寫它）。
