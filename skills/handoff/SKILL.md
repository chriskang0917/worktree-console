---
name: handoff
description: 立刻把目前的 Claude Code session 交棒給新 session：先寫交棒說明，Orca、herdr 或 Herdr app 內自動開新分頁接手並關掉舊的，三者以外只寫說明並提示。也管自動交棒（context 用到上限一定比例時自動換手）的開關與比例。Use when 使用者輸入 /worktree-console:handoff、說「現在交棒」「換新 session 接手」「handoff now」，或要開關、調整自動交棒。
---

# Handoff

交棒的實際流程由本 plugin 的 Stop hook（`hooks/auto-handoff.mjs`）執行，這個 skill 只負責觸發與設定。

## 手動交棒（使用者輸入 `/worktree-console:handoff`）

不要開始新的工作，也不要自己寫交棒說明：用一句話回「收到，結束這一輪後開始交棒」就結束這一輪。Stop hook 會擋下並告訴你交棒說明要寫到哪個檔、要寫哪些內容，照它做即可。用量沒到門檻、自動交棒沒開啟也照樣交棒。

## 自動交棒的設定

設定檔在 `~/.config/claude-handoff/config.json`，用 hook 腳本改（`<root>` 是本 skill base directory 往上兩層的 plugin 根目錄）：

| 指令 | 作用 |
| --- | --- |
| `node <root>/hooks/auto-handoff.mjs enable` | 開啟自動交棒 |
| `node <root>/hooks/auto-handoff.mjs disable` | 關閉（之後的 session 也不再詢問） |
| `node <root>/hooks/auto-handoff.mjs ratio 0.3` | 門檻改成上限的 30%（預設 40%） |
| `node <root>/hooks/auto-handoff.mjs status` | 看目前設定 |

- 門檻照 session 實際的 context 上限算：200k 的模型 40% 是 80k，1M 的模型是 400k。
- 單一 session 不想參與：啟動前設環境變數 `AUTO_HANDOFF_OFF=1`（只擋自動觸發，手動交棒照樣可用）。
- 交棒說明寫在 `~/.config/claude-handoff/notes/<session id>.md`。
- 另有 context 用量通知（預設關閉）：`node <root>/hooks/context-notice.mjs enable`，用量跨過 30%／50%／70% 時各告知 session 一次（`bands 20,40,60` 改門檻、`disable` 關閉、`show` 看目前用量）；`AUTO_HANDOFF_OFF=1` 同樣不通知。

## 交棒時會發生什麼

1. Stop hook 擋下，要模型把交棒說明寫到指定檔；連停 2 次都沒寫，hook 從對話紀錄擷取一份保底（最初指令、`/goal` 原文、最後幾則對話、`git status`）。
2. hook 在說明最後附上：最後一則在等使用者回答時的問題原文、進行中的 `/goal` 原文與「收工前須在本 session 重新執行並貼出 `/goal` 全部證據」。
3. Orca、herdr 或 Herdr app 內（依 `HERDR_ENV=1`、`HC_TERMINAL_ID`、`ORCA_TERMINAL_HANDLE` 依序判斷，herdr 優先；herdr 在同一個工作區、Herdr app 在同一個 space 開新分頁）：開新分頁（同一工作目錄、同一個 `--permission-mode`；中控台開的 session 沿用原本的名稱帶 `claude --name`，herdr 分頁也用同一個名稱，中控台自己叫 `console`）→ 等就緒 → 送接手指令 → 確認送達 → 有 `/goal` 就送同一段並確認畫面出現 `Goal set` → 關舊分頁。任一步失敗都不關舊分頁，並告訴使用者卡在哪一步。
4. 三者以外：提示一次「自動交棒只支援 Orca、herdr 與 Herdr app」與交棒說明的路徑（有 `/goal` 時附原文），由使用者自己開新 session 接手。

### Herdr app 與舊 herdr 不同的地方

- 新分頁用 `herdr-app do tab.new` 開在舊分頁所在的 space，開完切回原本看的分頁（Herdr app 開分頁會搶畫面）。
- hc 不回報 Claude 的 session id，新 session 用 `claude --session-id <新 id>` 啟動，靠這個 id 找它的對話紀錄確認接手指令送達。
- 就緒看 `hc get` 回報 idle；接手指令與 `/goal` 用 `hc send` 送，送出時不帶舊分頁的位址，否則會被包成 `<hc from=…>`，`/goal` 不會執行。
- 舊分頁只有自己一個終端機時用 `tab.close` 關整個分頁，否則只關它的 pane。
