# Herdr app 模式

`<base>` 是 worktree-console 的 base directory。Herdr app 是 herdr 的桌面版：視窗由 `herdr-app` 管 space、分頁與側欄，終端機與 agent 由 herdr-core（`hc`）跑。中控台在 Herdr app 的分頁裡開就是 Herdr app 模式。

## 怎麼偵測

只看環境變數，沒有設定檔：

| 環境 | 模式 |
| --- | --- |
| 有 `HERDR_ENV=1` | 舊 herdr（就算同時有 `HC_TERMINAL_ID`，例如在 Herdr app 的終端機裡再開 herdr，也是舊 herdr） |
| 有 `HC_TERMINAL_ID`、沒有 `HERDR_ENV=1` | Herdr app |
| 只有 `ORCA_TERMINAL_HANDLE` | Orca |
| 都沒有 | 腳本報「worktree-console 只支援 Orca、herdr 與 Herdr app」 |

`console-log`、`auto-handoff` 與專注橫條的摘要監看三處 hook 用同一套順序。`hc` 或 `herdr-app` 叫不到（Herdr app 沒開）時腳本報 `[console] herdr-app-unreachable`，不改用別的工具。

## 啟動檢查（取代 SKILL.md 第 1 步）

`herdr-app status` 與 `hc ls --json` 都成功才繼續，任一失敗就停下回報（多半是 Herdr app 沒開）。其餘啟動步驟照 SKILL.md；Linear 一律用 `<base>/scripts/linear.mjs`，規則同 `herdr.md`〈開工〉。

## 跟舊 herdr 不同的地方

狀態判斷、⚠️ session 異常、repo 名單、票號自記、暫存 session、`/goal` 長度都照 `herdr.md`。不同的只有下表：

| 項目 | Herdr app 模式 |
| --- | --- |
| 代號 | 子 session 的 handle 是 hc 的終端機位址（例如 `t5`），`send --terminal`、`--from` 都用它 |
| 新 worktree 的位置 | 固定 `~/.herdr/worktrees/<repo>/<branch>`，branch 裡 `/` 這類字元換成 `-`（`feat/login` → `feat-login`），與 Herdr app 內建的 New worktree 同一處。`start` 的 `--dir` 可省略，給了也不用 |
| 新分頁放哪個 space | 名稱等於 repo 資料夾名的 space；沒有就用 `space.new` 開一個並命名為 repo 名。分頁一律有名稱（session 名稱或代號）。Herdr app 開分頁會把畫面切過去，中控台開完會切回原本的分頁 |
| 對話紀錄 | hc 不回報 Claude 的 session id，中控台開 claude 時用 `--session-id` 指定並記在 `~/.config/worktree-console/herdr-app-sessions.json`；子 session `/clear` 後換成 console-log hook 登記的那份（兩份取最近寫入的） |
| 送文字 | `hc send`：子 session 卡在選單或授權時會被拒絕（同舊 herdr 的 `agent prompt`）。送出時不帶中控台自己的位址，否則文字會被包成 `<hc from=…>`，`/goal`、`/rename` 就不會執行 |
| 只打字不按 Enter | hc 做不到（`hc keys` 也不收中文）：選單選「其他」要打的字會先暫存，按 Enter 那一步改用 `hc send --force` 一次送出 |
| 讀畫面、按鍵 | `hc read <t>`、`hc keys <t> <鍵>`（`enter`、`esc`、`down`、數字） |
| 關閉 | 分頁裡只有這個 worktree 的終端機就 `tab.close`，和別的終端機同分頁就只關它的 pane；中控台自己的分頁一律不關 |
| 交棒與搬移 | 手動與自動交棒都在舊分頁所在的 space 開新分頁（沿用名稱、`--session-id`、同一個 `--permission-mode`），接手指令與 `/goal` 走 `hc send`，全部成功才關舊分頁。`move` 在目標 space 開新分頁 `--resume` 同一段對話，新分頁就緒才關舊分頁 |
| 倒數代回 | 不發系統通知（Herdr app 沒有對外的通知指令），只在橫條上倒數 |
| 試跑紀錄 | `herdr-audit.jsonl` 的讀取與人工誤判多帶 `terminal: "herdr-app"`；`herdr-report` 把舊 herdr 與 Herdr app 的讀取次數、異常與誤判分開列 |

〈指揮〉裡寫 `orca terminal …` 的步驟在 Herdr app 模式改成：讀畫面 `hc read <t>`、送按鍵 `hc keys <t> <鍵>`、開 claude 分頁 `console.mjs open`。`未開工：新分頁沒就緒` 時用 `hc read` 看畫面，信任資料夾的對話框用 `hc keys <t> down enter` 回應後再送首則指令。

## 指令

與 `herdr.md`〈指令〉相同（`start`、`open`、`move`、`misjudge`、`herdr-report` 都能用），差別只有 `start` 的 `--dir` 可省略。

## 看板 pane

中控台分頁右側的看板 pane，只顯示中控台算好的狀態，自己不判斷：

- **位置**：原始碼在 plugin 的 `herdr-app/mods/worktree-board/`。中控台每次讀狀態（看板、watcher 每 10 秒一次）都會確認 `~/.config/herdr-app/mods/worktree-board/` 與原始碼一致，不一致才寫。Herdr app 不會把新 mod 放進它內建的版面，所以中控台自己讀狀態（`board`、watcher）時，用 `pane.split` 在中控台所在的分頁右側切出看板 pane，焦點留在中控台。每個分頁只切一次（記在 `~/.config/worktree-console/herdr-app-board-panes.json`）；使用者關掉後不會再切，中控台交棒到新分頁時新分頁會再切一次。寬度由使用者拖拉調整，Herdr app 會記住。`mod.json` 是 `"place": "none"`，避免 Herdr app 另外再放一份。
- **資料**：`~/.config/worktree-console/herdr-app-board.json`，中控台每次讀狀態就整份重寫；mod 從同資料夾的 `.board-path` 得知這份檔案在哪。
- **每列**：依 repo 分組，每列第一行是狀態圖示、代號、階段、等待時間（這個狀態維持多久），第二行是最後動態（和中控台看板的「最後動態」欄同一套：💬 放問題、🔐 放要執行的內容、🔄 放最後送的指令、⏸ 放最後一句）。⚠️／🔐／💬 排在 🔄／⏸／💤 前面，同狀態等最久的在上；組的順序跟著組裡最需要處理的那一列。點一列切到該子 session 的分頁。
- **過期提示**：狀態檔超過 2 分鐘沒更新（中控台關了或 watcher 沒在跑），頂部顯示「中控台未在執行，資料停在 HH:MM」，列表變灰但保留最後的資料。
- **修改後**：在 Herdr app 裡驗證前先跑 `herdr-app check ~/.config/herdr-app/mods/worktree-board`。
