[English](./README.en.md)｜[中文](./README.md)

> **語言說明：** skill、它們的 prompt，以及中控台印出的所有內容都是繁體中文。這是中文版 README；英文版見 [README.en.md](./README.en.md)。

<h1 align="center">worktree-console</h1>

<p align="center">
  <a href="#安裝">安裝</a> ·
  <a href="#使用方式">使用方式</a> ·
  <a href="#自訂中控台-prompt">自訂</a> ·
  <a href="#開發">開發</a> ·
  <a href="./CHANGELOG.md">更新紀錄</a> ·
  <a href="./LICENSE">MIT 授權</a>
</p>

<p align="center"><b>用一個 Claude Code session 管十幾個：中控台幫你開 session、盯著它們，把每個問題送到你面前。</b></p>

worktree-console 是一個 Claude Code plugin。在 [Orca](https://github.com/stablyai/orca) 或 [herdr](https://github.com/herdrdev/herdr) 的一個分頁裡打開它，那個 session 就成了你所有 repo 裡每個 worktree 與 Claude Code session 的中控台。

- **丟一張票，就有一個跑起來的 session。** 給它一張 Linear 票（或直接講任務）。它會讀票、找出母票、提議 repo 與 branch 名稱，你確認後就建好 worktree，並在那裡開一個 Claude Code session。
- **session 自己回報。** watcher 盯著每個 session。哪個停下來問問題、做完了、或要授權，中控台就告訴你是哪張票、它要什麼。
- **專注模式：一次一題，按一個鍵就回。** 輸入框上方的橫條永遠顯示目前這題和它的選項。回 `b`，中控台就送出那個 session 要的寫法（`B`、`2` 或正確的選單項目）。其他題在排隊列等著（`1`–`5` 跳過去、`8` 延後、`9` 再印一次題目、`0` 打開側邊面板，每個 session 一張卡片，分成「待回覆、全部、封存」三個分頁）。完整回報直接印進對話，不花 token。專注模式需要支援 mods（plugin 函式 hook）的 Claude Code，以及本 marketplace 另外提供的 `focus-show` plugin。
- **用手機連上中控台。** 中控台啟動時會替自己的 session 打開 Remote Control（只開它自己，不開它開出來的 session），所以手機 Claude app 的 Remote Control 清單看得到中控台。中控台自動交棒換成新 session 後，會再打開一次。
- **每個 session 都有名稱。** 中控台開的每個 session 都用 `claude --name <名稱>` 啟動；在 herdr 裡，它開的每個分頁也都有名稱（中控台自己的分頁叫 `console`）。開 session 時可以給名稱，之後也能改名；有名稱時，看板顯示名稱而不是票號。
- **一張看板看全部。** `現在狀況` 每個 repo 印一張表：狀態、票號、摘要、階段（未開工、規劃中、實作中、已推送）與最後動態，每個 session 走到哪一眼看完。
- **在同一個地方指揮、關閉、封存。** 用票號對任何 session 下指令，branch 合併後關掉 worktree，或把不想看到的 session 封存起來。
- **自動交棒。** session 的 context 用量超過門檻，或你不在時 prompt 快取快過期，它會寫一份交棒說明，由新分頁裡的新 session 接手。`/worktree-console:handoff` 可以隨時手動交棒。
- **context 用量提醒（預設關閉）。** 打開後，session 的實際 context 用量跨過 30%、50%、70% 時各提醒一次，讓背景或無人看管的 session 在用滿前收尾。用 `node hooks/context-notice.mjs enable` 打開，`bands 20,40,60` 改門檻。
- **工作過程有紀錄。** 中控台與每個 session 的事件都記在 `~/.worktree-console/`，事後可以回頭看開了什麼、問了什麼、回了什麼。
- **工具呼叫收成一行（選用）。** 另外安裝的 `tool-dots` mod 把連續的工具呼叫收成一行彩色圓點加次數；按 ctrl+o 照樣看得到全部。見〈[安裝 tool-dots](#安裝-tool-dots選用)〉。
- **照你的習慣改。** 中控台啟動時會讀一份 prompt 檔，你可以換成自己的版本，加上中控台規則，或讓每個 session 寫 code 前先訪談你。見〈[自訂中控台 prompt](#自訂中控台-prompt)〉。

## 安裝

需求：

- [Orca](https://github.com/stablyai/orca) 或 [herdr](https://github.com/herdrdev/herdr)。中控台只在它們的分頁裡運作。
- [Node.js](https://nodejs.org/) 20 以上。
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。專注模式另需支援 mods 的版本。
- 選用：透過 Orca 存取 Linear（`orca linear …`），丟票開工時用。

在 Claude Code 裡：

```text
/plugin marketplace add chriskang0917/worktree-console
/plugin install worktree-console@worktree-console
/plugin install focus-show@worktree-console
```

`focus-show` 只有專注模式需要。

## 使用方式

在 Orca 或 herdr 分頁裡、你的某個 repo 下打開 Claude Code，然後：

| 輸入 | 會發生什麼 |
| --- | --- |
| `/worktree-console:worktree-console` 或 `開中控台` | 啟動中控台：看板、封存清單、watcher |
| `<票號>`，例如 `PROJ-123` | 先對齊這張票，你確認後開 worktree 與 session |
| `現在狀況` | 印出看板 |
| `<票號> 詳情` | 顯示那個 session 最近在做什麼 |
| `b` 或任何回覆 | 回答專注橫條上目前這題 |
| `問：<問題>` | 在中控台啟動的 repo 開一個暫存 worktree，在那裡問這個問題（herdr 與 Orca 都可以） |
| `問 <repo>：<問題>` | 同上，開在指定的 repo |
| `<票號>，名稱 <名稱>` 或 `問：<問題>，名稱 <名稱>` | 開 session 時順便給名稱（見〈[session 名稱](#session-名稱)〉） |
| `<代號> 改名 <名稱>` | 替 session 改名：看板、專注橫條、herdr 分頁與 Claude Code session 名稱一起換 |
| `關掉 <票號>` | 確認 worktree 可以安全移除，再關掉它 |
| `清理 branch` 或 `prune` | 列出本機 branch 與 worktree，標 CANDIDATE 或 KEEP（已合併或 squash 合併，附原因）；你確認後才刪 |
| `/worktree-console:handoff` | 把目前的 session 交棒給新的 session |

狀態存在 `~/.config/worktree-console/`（中控台登記、專注狀態、封存、設定與你自己的 `prompt.md`）、`~/.config/claude-handoff/`（交棒設定與說明）和 `~/.worktree-console/`（過程紀錄）。用到 Linear token 時，它存在 macOS 鑰匙圈的 `worktree-console-linear`。

中控台管理的子 session 每次停下，背景會用 `claude -p --model sonnet` 把這一輪回覆摘要成幾句白話：子 session 分頁的輸入框上方顯示摘要（輸入框空白時按 `0` 看全文），中控台面板的卡片按 Enter 跳出該 session 的摘要。要換模型就在 `config.json` 設 `"summaryModel": "haiku"`。每次呼叫的 token 與 `total_cost_usd` 記在 `~/.config/worktree-console/summary-usage.jsonl`。

## session 名稱

中控台開的每個 session 都用 `claude --name <名稱>` 啟動：正式開工、暫存 session、臨時分頁、重新打開與搬移的 session、需求訪談交棒，以及自動交棒。你沒給名稱時，名稱就是 session 的代號（票號、暱稱或 branch）。在 Orca 裡，`orca worktree create` 開的 session 第一次停下時，中控台送 `/rename` 補上名稱。在 herdr 裡，中控台開的每個分頁都有名稱、不會是數字（新工作區的第一個分頁也一樣），中控台自己的分頁叫 `console`。watcher 看到跑著 Claude Code 的數字分頁，會照它的 session 補上名稱：有你給的名稱就用名稱，否則用票號，再沒有就用 branch 或資料夾名。已經有名稱的分頁不會被改。

- **開的時候給名稱。** 在要求後面加 `名稱 <名稱>`，例如 `PROJ-123，名稱 login-fix` 或 `問：README 在講什麼？名稱 docs`。沒給的話，中控台照舊自己取暱稱。
- **之後改名。** `<代號> 改名 <名稱>`（例如 `PROJ-123 改名 login-fix`）會一起換掉看板、專注橫條、待回覆清單、herdr 分頁與 Claude Code session 名稱。session 還在跑時，等它停下，watcher 才送 `/rename`。
- **格式。** 只收英文小寫、數字和 `-`，2～20 個字元。名稱不能和別的 session 的名稱或代號（包含票號）重複，也不能和 repo 名稱相同，因為你也用它打字指揮 session。其他寫法（大寫、中文、空白、21 個字元）都會被拒絕，並印出原因。
- **顯示在哪裡。** 有名稱的 session，在看板、專注橫條、待回覆清單和回報裡都顯示名稱，不顯示票號；`<名稱> 詳情` 仍列出票號。打名稱或原本的票號都指揮得到它。

## 安裝 task-list（選用）

`task-list` 是另一個 plugin，管本機的任務清單：建立任務、追蹤項目、提交與驗收證據，並用文字圖加上已提交事件的時間線查看進度。

```text
/plugin install task-list@worktree-console
```

它需要 Node.js、macOS 或 Linux，以及支援 `ps -p <pid> -o lstart=` 的 `ps`；核對不了程序身分時會安全地停止寫入。明確下 `task close` 會先預覽要封存的證據；`--yes` 要等未完成的工作與未讀的回報都處理完、且預覽的 revision 與證據 checksum 都沒變才會套用。指令、儲存位置、證據與驗收見 [task-list README](./plugins/task-list/README.md)。用 `claude plugin` 停用或解除安裝；任務資料會保留。

## 安裝 tool-dots（選用）

`tool-dots` 是另一個 mod，把對話裡連續的工具呼叫收成一行：每次呼叫一個點（執行中黃點、成功綠點；失敗、被拒或被中斷畫成紅色 `✕`，排在同一列最後面），接著照各工具第一次出現的先後列出工具與次數，有失敗時再註明幾個：

```text
●●●●✕ tool_call: Bash ×3 · Read ×2 - 1 error
```

中間出現回覆文字或你的訊息，就從下一行重新算。超過 24 次時點只畫 24 個，後面接淡色的 `+N`。MCP 工具顯示成 `server:tool`。折疊時工具的結果區塊不顯示；按 ctrl+o（或用 `--verbose`）時，每個工具呼叫和結果照原樣全部顯示。需要支援 mods 的 Claude Code。

```text
/plugin install tool-dots@worktree-console
```

## 自訂中控台 prompt

中控台每次啟動都會完整讀一份 prompt 檔並照著做。內建的那份幾乎是空的。要用你自己的：

1. 把它複製到 `~/.config/worktree-console/prompt.md`（有設 `$WORKTREE_CONSOLE_HOME` 就放在那底下）。要訪談就從 [`templates/prompt.md`](./templates/prompt.md) 開始，不要就從 `skills/worktree-console/references/prompt.md` 開始。
2. 編輯它。這個檔存在時中控台只讀它，不讀內建那份，plugin 更新也不會動到它。
3. 重開中控台。`node <plugin>/skills/worktree-console/scripts/console.mjs prompt` 會印出用的是哪個檔、是不是你的、有沒有訪談段落。

這個檔依標題最多分兩段：

- `## 中控台`：給中控台本身的額外規則，用白話寫。
- `## 需求訪談`（訪談）：有這一段時，每張票開工前都先訪談、再寫 code；沒有的話 session 直接開工。對齊時仍可以對單張票說「這張要訪談」或「這張不用訪談」。

訪談時，新 session 讀你的 `## 需求訪談` 段落，一題一題問你直到目標定下來，寫出目標檔後停下。中控台把每一題轉給你，再把目標交給新的 session 實作。這一段不管你怎麼寫，下面幾點要保留，否則中控台會跟丟：

- **題目格式。** 一次問一題，用純文字（不要選單），照這個樣子寫。專注橫條從這裡讀出選項，你回 `b` 這類答案時會照字母送回去。

  ```text
  **第 N 題：<question>？**

  <optional background>

  - **a.** <option>: <explanation>
  - **b.** <option>: <explanation>

  建議：<letter>, <reason>
  ```

  選項用小寫 `a`、`b`、`c`。選項後面除了 `建議：` 那一行，不要再放別的。
- **目標檔。** 寫到主 checkout 的 `.goals/<slug>.md`，slug 用第一則訊息給的。交棒時會把它的 `**驗收準則**` 清單轉成實作 session 必須展示的檢查（標 🔧 沒測試、⚠️ 需人工判定的項目略過），並填上 `**實作方案**` 那一行。
- **收尾。** 目標定下來時，只回 `定稿完成：<目標檔的絕對路徑>` 然後等。接下來由中控台處理。

`templates/prompt.md` 是一份完整可用的範例：該問什麼、怎麼寫可測的驗收準則，以及目標檔的格式。

## 外觀

專注面板與橫條只有一種外觀：精簡的狀態圖示，搭配同風格的專注橫條。每個狀態有自己的顏色（工作中綠、待回答黃、待授權亮洋紅、已回覆亮青、異常亮紅、閒置灰）。46 欄以上時，階段是卡片標題列右側的灰色小標；更窄時放在底列最前面；未開工不顯示。專注橫條的標題列左邊是狀態與代號，右邊用主題的淡色寫 `9: 顯示問題 · 8: 延後處理`（排隊列是空的時只有 `9: 顯示問題`）；橫條太窄時先把代號以 `…` 截短。代號不能聚焦也不能點，要看題目按 `9`。按分頁鍵（`q`、`w`、`e`，重按同一個也算）會把選取和鍵盤焦點放到那個分頁的第一張卡片，之後按 ↓ 從那裡往下一張；`0` 會打開面板到「待回覆」並選中橫條上這題；其他快捷鍵與 session 資料不變。面板的「全部」分頁列出所有沒封存的 session，閒置的也在裡面（卡片照樣標「閒置」）；封存的只出現在「封存」。

把這些鍵加進你現有的 `~/.config/worktree-console/config.json`（或 `$WORKTREE_CONSOLE_HOME/config.json`），其他設定保留：

```json
{
  "theme": "neutral",
  "motion": true
}
```

- **theme：** `neutral`（預設，用終端機的顏色）、`neutral-light`、`dracula`、`gruvbox` 或 `light`。`neutral` 讓前景文字維持終端機的預設色。
- **motion：** `true`（預設）時，只有主要那題的圖示每 900ms 在 ◆／◇ 之間切換。目前這題優先，沒有的話是排隊列第一個問題或授權請求。所有看得到的授權 ◆ 同步呼吸：1.2 秒授權色、0.6 秒淡色；狀態字與橫條左側直線維持授權色。工作中與異常不動。`false` 讓所有圖示停在第一格，並關掉動畫計時器。

### repo 縮寫

同一張票開在好幾個 repo 時，看板在票號後面接 repo 的縮寫：`sara-v2-frontend` 和 `sara-v2-backend` 顯示成 `SARA-7063-fe` 和 `SARA-7063-be`。預設會去掉這幾個 repo 名稱相同的開頭，再把 `frontend`／`backend` 縮成 `fe`／`be`；兩個字都沒有的 repo 名稱就留下剩下的部分（`acme-billing` 和 `acme-admin-portal` 並列時顯示 `billing`）。要用自己的縮寫，設定 `repoAbbreviations`：

```json
{
  "repoAbbreviations": {
    "sara-v2-frontend": "web",
    "sara-v2-backend": "api"
  }
}
```

縮完兩邊還是一樣時，看板改用完整 repo 名稱（`SARA-7063-sara-v2-frontend`），兩個 session 不會用到同一個代號。中控台每次列 session 都會讀這個鍵，不用重開。

設定在 session 啟動時、以及每次打開面板時讀取，改完重開面板就生效。只有中控台自己的分頁會讀這個檔。沒寫的設定用預設值；不認得的值退回預設，同一個錯誤值在一個 session 裡只跳一次通知；檔案不是有效的 JSON 時全部用預設，跳一次通知。

面板把執行中的 session 叫 **工作中**、問題叫 **待回答**、授權請求叫 **待授權**、回覆完畢叫 **已回覆**。這些只是顯示用的標籤；對話裡的看板維持原本的狀態用字。按鈕字型與快捷鍵顏色由 Claude Code 決定；可點的名稱與按鍵維持它原生的樣式。

### 主題

在 `config.json` 把 `theme` 設成 `neutral`、`neutral-light`、`dracula`、`gruvbox` 或 `light`，再重開面板。`neutral` 保留終端機原生的前景色，背景跟著 Claude Code 的面板。命名主題會畫自己的面板背景：`dracula` — `#282a36`、`gruvbox` — `#282828`、`light` — `#fdf6e3`、`neutral-light` — `#f7f7f5`。換主題只換顏色，不動 session 資料、版面或快捷鍵。

面板最外層的背景蓋住文字、卡片間距與沒用到的列；裡面的文字列不必各自上背景。Ink 的框線格子不會繼承這個背景。Claude Code 自己的外框、關閉列與分頁列維持它的主題色。專注橫條與終端機其他部分維持原本的背景；用淺色配色時，這些地方請搭配淺色的 Claude Code 主題。兩個淺色配色的淡色文字對面板背景至少 4.5:1；每個命名主題的卡片框線對面板背景至少 3:1。

每個配色的授權狀態字都維持授權色，◆ 圖示則在授權色與淡色之間呼吸。不認得的主題名稱退回 `neutral`，同一個錯誤值在一個 session 裡只跳一次通知。

## 開發

```sh
git clone https://github.com/chriskang0917/worktree-console.git
cd worktree-console
npm test
```

在 herdr 分頁裡跑測試要用 `env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID npm test`。專注橫條、`focus-show` 與 `tool-dots` 的測試用 `claude plugin test .`、`claude plugin test mods/focus-show` 與 `claude plugin test mods/tool-dots` 跑。

真實終端畫面回歸測試另需 `tmux` 與支援 mods 的 `claude`。單獨執行：`node --test test/worktree-console-focus-terminal.test.mjs`；使用臨時 HOME、假資料及獨立 tmux socket，不讀取現有中控台狀態。本機沒有 `tmux` 時這些測試會略過並寫明原因；CI（設了 `CI` 環境變數）上沒有 `tmux` 則直接失敗。CI 由 `.github/workflows/ci.yml` 執行：安裝固定版本的 `@anthropic-ai/claude-code` 與 `tmux`，跑 `npm test`、`claude plugin test .`、`claude plugin test mods/focus-show` 與 `claude plugin test mods/tool-dots`。

plugin 版號由 CI 在每個 pull request 自動升。`version` job 找出 PR 改到哪些 plugin（`mods/focus-show`、`mods/tool-dots`、`plugins/task-list`，其餘都算 `worktree-console`），以 `main` 目前的版號為基準各升一號（`feat` 升 minor，其他升 patch，PR 標題有 `!` 升 major），在 `CHANGELOG.md` 加一段 PR 標題，再推一個 `chore: bump plugin versions` commit 到 PR branch。它每次都從 `main` 重算，所以同一個 PR 推多次版號不變；別的 PR 先 merge 了，下次執行就改成下一號。你自己在那段 changelog 寫的說明會保留，只改版號標題。從 fork 開的 PR，CI 推不了 commit，改成檢查：沒升或升錯就失敗，並印出每個 plugin 該升成幾號。腳本是 `.github/scripts/plugin-versions.mjs`。

不想換掉已安裝的版本、只想試本機 checkout 時：

```sh
claude --plugin-dir . --plugin-dir ./mods/focus-show --plugin-dir ./mods/tool-dots
```

目錄：

- `skills/worktree-console/`：中控台 skill、它的 references 與 scripts
- `skills/handoff/`：交棒 skill
- `hooks/`：專注橫條 mod、自動交棒 hook 與過程紀錄 hook
- `mods/focus-show/`：`/focus-show` 指令，獨立的 plugin
- `mods/tool-dots/`：工具呼叫折疊 mod，獨立的 plugin
- `test/`：Node test runner 的測試與測試資料

版本規則見 [AGENTS.md](./AGENTS.md)。
