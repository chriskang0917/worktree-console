---
name: worktree-console
description: 在單一 Claude Code session 透過 orca CLI 或 herdr 當中控台，管理 Orca（或 herdr）裡所有 repo 的 worktree／claude session：丟 Linear 票就對齊後開 worktree 與子 session，子 session 停下時主動以票號回報，並能看板、詳情、指揮、關閉。Use when asked to 開中控台, worktree console, 管多個 session, 丟票開工, 現在狀況, <票號> 詳情, 關掉 <票號>. 硬需求：在 Orca 或 herdr 的分頁裡開。
---

# Worktree Console

把這個 session 當中控台：一張 Linear 票對應一個 worktree 與一個長駐的 claude 子 session。中控台負責開票對齊、轉達問題、送指令、看板與關閉，不能做的事見〈界線〉。一個中控台管 Orca 裡所有 repo 的 claude session。

長期原則：**中控台輸出只放問題與表格**（外加送出／開工／關閉的結果行），不加說明、加總或提示行。

## 硬需求與啟動

本 skill 只能在 Orca 或 herdr 的分頁裡運作，依中控台所在的工具自動選用：`HERDR_ENV=1` → herdr 模式，有 `ORCA_TERMINAL_HANDLE` → Orca 模式，兩者皆無就停下並說明「worktree-console 只支援 Orca 與 herdr」。**herdr 模式先讀 `<base>/references/herdr.md`**，其中寫明與 Orca 不同的步驟（第 1 步改查 `herdr status`、開工、Linear、⚠️ 狀態）；以下以 Orca 模式為主。

1. `command -v orca` 與 `orca status --json | jq -c 'if .ok then {ok, reachable: .result.runtime.reachable} else {ok, error: .error.code} end'`（成功只印 `ok` 與 `reachable`，`ok:false` 時另帶 `error.code`）：找不到指令、`ok:false` 或 `reachable` 不是 true → 停，回報原因。
2. 取啟動 repo：`REPO=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")`（主 checkout 絕對路徑）。`console.mjs` 一律帶 `--repo "$REPO"`；它只決定開票的預設 repo，看板、指揮、關閉涵蓋 Orca 所有 repo（`orca repo list --json` 有每個 repo 的 `path` 與 `displayName`）。
3. 腳本一律用本 skill 載入時給的 base directory 組絕對路徑：`node <base>/scripts/console.mjs …`、`node <base>/scripts/watch.mjs …`，不要依賴 cwd。orca 執行檔可用 `ORCA_BIN` 覆寫。
4. 清殘留：`pgrep -f "worktree-console/scripts/watch.mjs"` 找到的程序中，`ps -o ppid= -p <pid>` 為 1 的（孤兒）直接 `kill`。
5. 跑 `console.mjs board --repo "$REPO"`，再跑 `console.mjs archived --repo "$REPO"`，兩段輸出依序原樣貼給使用者（`archived` 沒輸出就不貼）。
6. 掛 watcher（見〈主動回報〉），第一次掛不帶 `--baseline`，watcher 會以第一輪輪詢為基準。印 `[watch] already-running` 表示另一個中控台（或舊版帶 `--repo` 的 watcher）正在監看：問「已有另一個中控台在監看，要不要由這裡接手？」，回要就加 `--takeover` 重掛（會先停掉舊的），回不要就不掛，之後只在使用者開口時看板。中控台是被自動交棒開起來的（接手指令會寫明）時直接加 `--takeover`，不問。
7. 跑 `console.mjs todo --repo "$REPO"`（見〈待開工的票〉）。

orca `--json` 回傳一律是 `{ok, result}`；`ok:false` 時看 `error.code`（例如 `timeout`、`terminal_handle_stale`、`linear_issue_required`）。branch 顯示前剝掉 `refs/heads/`。

## 腳本一覽（除 `answer`、`send`、`close`、`handoff`、`ask`、`ask-tab` 外不動 Orca 與 git；封存、專注模式與問問題的子指令見各自段落）

| 指令 | 用途 |
| --- | --- |
| `console.mjs board --repo R [--aligning "[<repo>/]<票號>=<票名>"]…` | 看板：依 repo 分成多張 markdown 表格，每張上方一行 `**<repo 名稱>**`（只有一個 repo 也照樣有），表頭 `狀態｜票號｜摘要｜階段｜最後動態`，一個 session 一列（多 session 的 worktree 標 `<票號>#n`）；💤 閒置與封存的 session 移出表格，整張看板最下面空一行列跨 repo 合計 `封存 N 個、閒置 M 個`（只有數量、同一 worktree 的多個 session 各算一個；為 0 的項目不寫，全 0 不印），某 repo 全部閒置／封存時只有 `**<repo 名稱>**` 與一行 `全部閒置／封存`；只列有 claude session 的 worktree；待回覆清單不是空的時，空一行後附上；memory.md 有看不懂的條目時，最後空一行接「memory.md 有 N 條看不懂」。順便把自己登記成中控台 |
| `console.mjs after-send --repo R <票號>[#n]… [--aligning …]` | 送出後接著跑，可一次帶多個 tag；印出什麼見〈指揮〉第 6 步。有 mods 時改印一行 `等 <代號> 回應中…　還有 N 題排隊`（見〈專注模式〉） |
| `console.mjs detail --repo R <票號或數字>[#n]` | `摘要：<完整票名>`、repo、branch、worktree 路徑；單一 session 列 terminal 與狀態，多 session 時逐一列出 `#n <狀態>｜<handle>｜最後指令：…`，帶 `#n` 只看該 session；其下每個待你處理的 session 各空一行接一段回報，與 watcher 回報同一格式（標題＋完整引用框或選單表格），🔄 執行中、💤 閒置不出 |
| `console.mjs resolve --repo R <票號或數字>[#n]` | `{match:"none"\|"one"\|"many", rows:[{repo,main,ticket,branch,path,handle,session,tag,status,prompt}]}`，一筆＝一個 session；沒有 session 的 worktree 也找得到（handle 為 null）|
| `console.mjs answer --repo R <票號>[#n] <答案>` | 代按子 session 開著的選單，或回 🔐 授權請求 `允許`／`拒絕`（見〈指揮〉），送完等它離開等待狀態；輸出 `[票號] 已選擇：…`／`[票號] 已允許`／`[票號] 已拒絕`，失敗 exit 1 且不送任何按鍵 |
| `console.mjs send --terminal H --tag T -- <文字>` | 把文字送進子 session 並讀畫面確認（見〈指揮〉第 1 步）：`[T] 已送出`、`[T] 已送出（排隊中）`、`[T] 已送出（已按 Esc 退回對話後重送）`；子 session 執行中卻還沒在畫面上看到那句時印未確認狀態 `[T] 已送出（子 session 執行中，畫面上還沒看到這句，等它停下再確認）` 並 exit 0；未送達印 `[T] 未送達：<原因>` 加畫面最後幾行並 exit 1 |
| `console.mjs nickname --repo R <branch 或代號> <暱稱>` | 存中控台替 worktree 取的暱稱（3～5 個英文小寫字母）：`[<暱稱>] 已存暱稱：<branch>（<repo>）`；格式不對印 `[<暱稱>] 暱稱要 3～5 個英文小寫字母`、跟任何 repo 已有的暱稱或代號撞名印 `[<暱稱>] 暱稱已被使用，請換一個`，都 exit 1 |
| `watch.mjs [--baseline <快照>] [--takeover]` | 全機唯一的常駐監看，涵蓋 Orca 所有 repo；有 session 進入待你處理的狀態就輸出回報＋完整看板並結束；暫存 worktree 的最後一個分頁關掉後，乾淨的自動移除（見 `references/ask.md`） |

狀態只有五種（herdr 模式多一種 ⚠️ session 異常，需手動排程，見 `references/herdr.md`）：🔄 執行中（子 session 正在做事）、🔐 等待授權（等你允許它執行工具）、💬 等待回應（問了問題或開了選單在等你答）、⏸ 回覆完畢（這一輪回完，等你下一步指令）、💤 閒置（沒有在跑）；「待你處理」包含等待授權、等待回應、回覆完畢三種。

階段只有四種：未開工、規劃中、實作中、已 push。

要知道是哪個 💤 閒置 session，看專注面板的「閒置」分頁，或用代號跑 `detail`（`resolve`、指揮照樣找得到閒置 session）。watcher 回報後的看板與 `after-send` 貼的看板同一規則。為了讓整列壓在 100 欄內（中文與 emoji 算 2 格），狀態、票號、階段三欄保持原字，剩下的寬度分給摘要與最後動態，放不下就截短並以「…」結尾；完整票名看「詳情」。

同一個 worktree 有兩個以上 claude session（扣掉中控台自己）時，依開啟順序編號成 `<票號>#1`、`<票號>#2`（Orca 沒給建立時間就依 paneKey 固定排序）；只有一個時不加編號。`resolve` 候選與 `detail` 用最後一則指令區分各 session；指令為空（例如接續舊對話的 session）就改顯示 `說：<該 session 最後回覆最後一段的前 20 字>`，兩者都空才顯示「（無）」。回報標題、看板列、`resolve` 的 `tag`、`detail` 都用同一套編號。不同 repo 的代號撞名時（例如兩個 repo 的主 checkout 都是 `dev`），看板、回報、待回覆清單、`resolve` 都改用 `<repo 名稱>/<代號>`（如 `proj-v2/dev`），指揮也用它；沒撞名時代號不加前綴。

沒票也沒暱稱的 worktree（同票同 repo 有多個 worktree 時括號裡那段也是）由中控台替它取暱稱：`board`、`after-send`、watcher 回報最後出現 `待取暱稱：<branch>（<repo>）、…` 時，這一輪先替每個 branch 取一個 3～5 個英文小寫字母、念得出意思的暱稱（例如 `feat/backend-api-request-comment` → `cmnt`），用 `console.mjs nickname` 存下（撞名就換一個再存），不必告訴使用者，存好再處理其他事。暱稱存在 `~/.config/worktree-console/nicknames.json`，之後看板、卡片、回報、`/focus-show` 都用它當代號（同票同 repo 是 `<票號>(<暱稱>)`），不加 repo 前綴；還沒取名前代號是拿掉類型前綴、截到 8 格加「…」的 branch（例如 `backend…`）。指揮時打暱稱、截短代號或完整 branch 名稱都認得。

中控台之間互相排除：每個中控台跑 `board` 時會把自己的 Orca 分頁登記在 `~/.config/worktree-console/consoles.json`，登記過的分頁不上看板、不被回報；分頁關掉後自動除名。正在自動交棒的舊 session（寫交棒說明起）與新 session（確認接手前）同樣不上看板、不被回報。

## 主動回報（watcher）

用 Bash `run_in_background: true`、`timeout: 7200000` 執行：

```bash
node <base>/scripts/watch.mjs [--baseline "<上一輪最後一行 baseline: 後面的內容>"] [--takeover]
```

- 整台機器只掛一支（所有 repo 共用）；腳本自己會用 `pgrep` 檢查，印 `[watch] already-running` 時照〈硬需求與啟動〉第 6 步問要不要接手。
- 被 watcher 叫醒時，讀它的輸出：
  - 回報：每則以 `### <emoji> <票號[#n]> <等你回應／等你選擇／等你授權／回覆完畢>` 開頭，空一行後是子 session 原文（引用框內、不截斷）或選單表格；同一輪有幾個 session 變動就有幾則。接著是先前回報過、還停在 💬／🔐 的 session，各自完整重貼一次，標題結尾加「（先前已回報，尚未回覆）」，免得使用者往上捲找。全部之後是 `---` 與一張完整看板；待回覆清單不是空的時，最後再附上。除了最後一行 `baseline:`，其餘**整段原樣貼出**，不改寫、不摘要、不合併、不摺疊。然後立刻帶 `baseline:` 後面的內容重掛。
  - 待回覆清單：標題 `### 📋 待回覆`（不含題數），下接表格 `狀態｜代號｜問題｜選項｜建議｜你通常會回`，收 💬、🔐，以及階段還沒到已 push 的 ⏸ 回覆完畢（子 session 回完一輪、在等你下一步指令；問題欄放最後一句）；已 push 的 ⏸ 不收。代號就是看板的 tag，選單多題時每題一列並加圈號（`6923①`）；選項一律以 a、b、c 標示（數字留給專注橫條切題）：文字題的選項欄由腳本截取（只看最後一個「第 N 題」之後；子 session 問「選哪個／哪一種」、建議點名清單裡的代號、或選項標「（建議）」才算選項，是非題與理由清單一律「—」；大小寫字母與數字都認，照子 session 原寫法送出）成 `a 專注模式當預設／b 預設維持現在的全…`（行首粗體段，否則到第一個「，：。—（」為止，每項最多 8 個中文字；`**A（建議）：…**` 這種寫法也認），選單題是「字母 標籤」；回報的選單表格同樣用 a、b、c，文字題回報在引用框後附一份 `- a. …` 對照。建議只轉述子 session 自己給的（選單標 Recommended、文字寫「建議是：」「我建議」「推薦」或選項行標「（建議）」「（我的建議）」「（Recommended）」、⏸ 最後一段的「下一步建議…」），沒有就是「—」，**中控台不自己補建議**。「你通常會回」是腳本照搬使用者過去回覆的另一個來源（見 `references/memory.md`），表格下方可能空一行接「要記住這個習慣嗎？」四行，一併原樣貼。
  - `[watch] orca-unreachable`：跑一次 `orca status --json` 回報使用者，**不重掛**，等使用者下次開口時先檢查 orca 再重掛。
  - `[watch] timeout`：直接帶 baseline 重掛，不必告訴使用者。
  - `[<暱稱>] 未移除：…`：使用者關掉暫存 worktree 最後一個分頁，但它有未 commit 改動或有 commit 所以沒自動移除（見 `references/ask.md`），只原樣貼這一行，不當待處理、不貼看板，帶 baseline 重掛。
  - `[票號] 已自動交棒（context N%）`、`[票號] 已自動交棒（快取將到期）`、`[票號] 已交棒（手動）`、`[票號] 自動交棒失敗：…`：子 session 換手的結果（見 `handoff` skill 與〈快取續命〉），只原樣貼這一行，不當待處理、不貼看板，帶 baseline 重掛。`[票號] 續命時沒照指示只回「收到」…`、`[蒸餾] …` 一行（保存的對話紀錄滿 20 份的提醒）同樣處理。
  - 沒有任何輸出就結束（被另一個中控台接手停掉）：**不重掛**，回一行「監看已交給另一個中控台」。
- 觸發條件：任一 session 進入等待授權、等待回應或回覆完畢，且跟上一輪不同（轉成執行中或閒置不叫醒你，下次回報的看板會反映）。使用者直接在 Orca 分頁打字造成的變動一樣會被回報（看的是狀態轉換，不是誰送的）。
- 中控台自己的每一則回報也要以 `[票號]` 開頭；沒綁票號的用暱稱，沒有暱稱才用 branch 名稱。

## 快取續命（watcher 自動做，中控台不用動手）

子 session 的 prompt 快取從它停下起算一小時失效，過期後下一句話要整段重讀、貴很多。watcher 在跑時自動處理：

- ⏸ 回覆完畢、或用純文字出題的 💬，停下滿 50 分鐘（Orca 的 `stateStartedAt`）沒人回：送一次固定的續命訊息，只請它回「收到」、不要做任何事。原題由中控台記住，從送出續命到你回覆前，看板、待回覆清單、專注面板一直顯示原題與原選項，不會出現「收到」。續命完全不出聲：不叫醒中控台、不重新回報、不算你回覆過，專注排隊順序不變。它多講話或動了工具時才印 `[票號] 續命時沒照指示只回「收到」，畫面照舊顯示原題`；跳出授權或選單時照實顯示。
- 續命那輪停下後再滿 50 分鐘仍沒人回：context 滿 15 萬 token 就用既有 handoff 流程換新 session（新 session 讀完交棒說明只原樣貼出原題），印 `[票號] 已自動交棒（快取將到期）`；未滿 15 萬就不再送任何訊息，讓它自然過期。
- 換手過的 session 在看板、待回覆清單、專注卡片的最後動態／問題前加「♻️」，你回覆它後消失；在你回覆前它不續命、不交棒。你回覆任一子 session 後，它的計數歸零，下次停下重新計時。
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
| 丟票、選了待開工的票、同意開 session（〈開票（對齊）〉、〈沒有票〉、〈開工〉）、「define-goal 預設開／關」 | `kickoff.md` |
| define-goal 訪談 session 回報「定稿完成」（交棒） | `handoff.md` |
| 「關掉 <票號>」（〈關閉〉） | `close.md` |
| 「報表」「最近卡在哪」等要看紀錄、打「已蒸餾」（〈過程紀錄〉） | `process-log.md` |
| `todo` 印 `skip:no-config`（待開工提醒的設定與篩選規則） | `todo-config.md` |
| 使用者問為什麼是這個狀態或階段，或寫詳情建議需要判斷階段時 | `status-stage.md` |
| 「封存 <代號>」（〈封存〉） | `archive.md` |
| 中控台在 herdr 分頁裡（`HERDR_ENV=1`）：啟動前；使用者說「<票號> 狀態錯了，其實是 X」；要看 herdr 試跑評估 | `herdr.md` |
| 「問 <repo>：<問題>」、「<代號> 問：<問題>」，或開頭那個字像 repo 名稱（3 個字元以上）且不是中控台指令（〈問問題〉） | `ask.md` |
| 對話出現 `/focus-show` 的輸出，或 `after-send` 印出 `等 <代號> 回應中…`（〈專注模式〉） | `focus.md` |
| 使用者回「記住 <字母>」「不記 <字母>」、問「你通常會回」怎麼來的、要重播回覆習慣 | `memory.md` |

## 指揮（把話送進某張票）

1. 使用者的話開頭是數字或票號，可帶 `#n` 指定 session、`<repo>/` 指定 repo（例如「6923 跑測試」、「PROJ-6923 繼續」、「6923#2 停下」、「proj-v2/dev 繼續」）；任何 repo 的 session 都一樣送 → `console.mjs resolve --repo "$REPO" <開頭那段>`：
   - `one` 且有 handle：`console.mjs send --terminal <handle> --tag <tag> -- "<其餘內容>"`，輸出逐字轉貼。不直接用 `orca terminal send`：它回 `accepted:true` 只代表 Orca 收下，子 session 停在 `/workflows` 這類檢視頁時文字會被吃掉。腳本送出後讀畫面：那句話已進對話或排隊中才算送達；子 session 執行中（畫面有轉圈行、Orca 回報不是停下，或查不到狀態都算）卻沒看到那句時，一律不送 Esc（執行中按 Esc 會中斷工作）、不重送，回報未確認（exit 0，算送出成功，照第 6 步接著跑）；子 session 已停下時，畫面不是一般對話（看不到輸入框或認出檢視頁）就送 Esc 退回對話重送一次；一般對話畫面卻沒看到（可能被收成 `Pasted text`）不送 Esc、不重送，直接回報未送達。未送達不自行再送。
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
7. 「<代號> 照建議」（或 `<代號> 好`／`<代號> 可以` 等明確同意，或「<代號> 照建議，第 n 題改成…」）：中控台把該代號詳情建議的具體做法展開成一段完整指令（改過的題目換成使用者的版本，其餘照建議），照第 1 步用 `console.mjs send` 送出、照第 6 步跑 `after-send`；選單或授權畫面開著時照第 3 步用 `answer` 送建議的編號或允許。**不把「照建議」原文送進子 session**。
   - 只認本次對話最近一次對該代號貼出的詳情建議，且之後 watcher 沒再回報過該代號（子 session 沒有新回覆）。不符合就不送，回一行 `[代號] 沒有可用的詳情建議，請先看「<代號> 詳情」或直接回答案`；不改用看板或待回覆清單上子 session 自己的建議。
   - 為什麼值得加：子 session 看不懂「照建議」三個字，所以要展開成完整指令。限定最近一次詳情是因為畫面上同時有子 session 自己的建議，混用會不知道送出的是哪一份。

## 看板與詳情

- 「現在狀況」→ 跑 `board` 原樣貼出（含附在後面的待回覆清單）；對話中還在對齊、尚未建 worktree 的票，每張帶一個 `--aligning "<票號>=<票名>"`（預定 repo 不是啟動 repo 時寫成 `<repo>/<票號>=<票名>`），腳本會在該 repo 表格最後補一列 `| 💬 等待回應 | <票號> | <摘要> | 未開工 | 要不要先跑 define-goal？ |`（沒裝 define-goal、或已設定開工預設跑不跑時，最後一欄是「等你確認開工」）、套用同樣的截短規則。不要自己手寫這一列。
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

- 中控台不寫實作 code、不 commit、不 push、不開 PR／MR；階段只追到「已 push」。過程紀錄的 commit 由 watcher 在 `~/.worktree-console` 自己做，中控台不碰。
- Linear 只讀。herdr 模式的 Linear API key 只放在 macOS 鑰匙圈，由使用者自己在終端機設定；key 不進對話、指令參數或任何輸出。
- 同一時間只留一個中控台。
- 不走 Orca orchestration 的一次性任務模式（Run／Dispatch／worker_done）。
- 除了開工時的 `--comment define-goal` 標記，不把階段寫進 worktree comment（子 session 的 orca-cli skill 會覆寫它）。
