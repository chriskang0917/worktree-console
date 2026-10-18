# focus.json 與 show/ 的共用格式（給 focus-show 讀）

主 plugin（worktree-console）寫、獨立安裝的 `focus-show` plugin 讀的檔案只有兩種：中控台家目錄（`WORKTREE_CONSOLE_HOME`，沒設時是 `~/.config/worktree-console`）底下的 `focus.json`，與 `show/` 資料夾。兩個 plugin 裝在不同目錄、不能互相 import，所以靠這份約定對齊。`config.json`、`archive.json` 等其他檔案只有主 plugin 自己用，不在約定內、也不帶版本號。

## focus.json 中 focus-show 會讀的欄位

由 `scripts/focus.mjs` 的 `saveFocus` 寫入，每次存檔都重算這三個欄位：

- `version`：格式版本號，目前是 `1`（`focus.mjs` 的 `FOCUS_VERSION`）。
- `currentId`：橫條上目前這題的題目編號；橫條沒有題目時是 `null`。
- `queuedIds`：還在排隊等你回的題目編號陣列，不含 `currentId`。

其餘欄位（`current`、`seen`、`reported`、`titles`…）是主 plugin 自己用的，focus-show 0.2.0 起不讀。`current` 與 `seen` 仍要保留原樣：focus-show 0.1.2 以前是讀這兩個欄位自己算編號。

## 題目編號的傳法

- 題目編號（`stopId`）只在 `scripts/focus.mjs` 算：一題的 key（session＋停下時間）算成一段短字串。`focusPayload` 把它放在每張卡片的 `id`，`saveFocus` 寫進 `currentId`／`queuedIds`。
- 橫條印題目時送 `/focus-show <代號> <編號>`，編號就是那張卡片的 `id`；手打或按 Enter 印非橫條上的題目時只送 `/focus-show <代號>`。
- focus-show 只拿參數裡的編號跟 `currentId`、`queuedIds` 比對字串：等於 `currentId` 就印，在 `queuedIds` 裡回「這題已退回排隊，輪到時再印」，都不是回「這題已回覆或已交棒，略過」，讀不到 `focus.json` 回「這題已不在橫條上，略過」。
- 公式不要改：還沒更新的 focus-show 0.1.2 自己用同一條公式算，改了它就悄悄印不出題目。

## show/ 檔名規則

- `show/<代號>.md`：該題的完整回報（markdown），每次印都覆寫，給只帶代號的 `/focus-show <代號>` 用。
- `show/<代號>@<編號>.md`：同一份回報，給帶編號的 `/focus-show <代號> <編號>` 用。
- `<代號>` 一律先做 `encodeURIComponent`（例如 `upgrade#2` 存成 `upgrade%232.md`）。

## 版本號何時加 1

只在 focus-show 會讀的部分（上面三個欄位、或 show/ 檔名規則）**改名、刪除、換意思**時加 1，同時更新 focus-show 認得的版本號（`mods/focus-show/hooks/register.tsx` 的 `VERSION`）。新增欄位、或只改主 plugin 自己用的欄位，版本號不變。

focus-show 只認得一個版本號，對不上就在對話印一行、不印題目：

- `focus.json` 的版本號比它認得的新：`[<代號>] 印不出題目：focus-show 太舊，不認得這個檔案格式，請更新 focus-show`
- `focus.json` 沒有版本號（或比它認得的舊）：`[<代號>] 印不出題目：worktree-console 太舊，不認得這個檔案格式，請更新 worktree-console`

這一行算 focus-show 有回應，橫條不會每輪輪詢重送。
