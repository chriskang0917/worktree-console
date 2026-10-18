[English](./README.en.md)｜[中文](./README.md)

# task-list

管本機任務清單的 plugin：建立任務、追蹤項目、提交與驗收證據，並用文字圖加上已提交事件的時間線查看進度。不依賴任何 npm 套件。需要 Node.js、macOS 或 Linux，以及支援 `ps -p <pid> -o lstart=` 的 `ps`；核對不了程序身分時，寫入會停下並印一則 `LOCK_IDENTITY` 訊息。不支援 Windows，也不支援沒有這個 `ps` 介面的精簡 BusyBox 環境。Skill 文字、執行輸出與產生的任務 README 都是繁體中文。

## 安裝與移除

先加入 marketplace（`<repo>` 是這個 repo 的絕對路徑，或用它的 GitHub 位址）：

```sh
claude plugin marketplace add <repo>
claude plugin install task-list@worktree-console
```

停用或解除安裝：

```sh
claude plugin disable task-list@worktree-console
claude plugin uninstall task-list@worktree-console
```

兩者都只把 skill 從 Claude 拿掉，不刪任務資料。

## 三步上手

`<plugin>` 是安裝好的 task-list 目錄，或這個 checkout 裡的 `plugins/task-list`。也可以直接請 agent「建一個登入整理的任務」或「看我的待辦」，task-writing skill 會幫你跑指令。

1. 建立任務（JSON 回應裡的 `task` 是它實際的目錄）：
   ```sh
   node <plugin>/scripts/task-list.mjs task-new "Login cleanup"
   ```
2. 加一個群組和一個可驗收的葉項目：
   ```sh
   node <plugin>/scripts/task-list.mjs task item add --id login --title "Login cleanup"
   node <plugin>/scripts/task-list.mjs task item add --id errors --parent login --title "Improve error messages" --criterion "Failures explain how to retry"
   ```
3. 看文字圖：
   ```sh
   node <plugin>/scripts/task-list.mjs task-todos
   ```

```text
Login cleanup（task-id）
revision 2
○ 1 待辦

○ Login cleanup 0/1 — 依完成條件執行
╰─ ○ Improve error messages — 依完成條件執行
```

## 提交與驗收

```sh
node <plugin>/scripts/task-list.mjs task report submit --item errors --evidence report.md --reviewer reviewer
node <plugin>/scripts/task-list.mjs task report accept --id <returned-report-id> --by reviewer
node <plugin>/scripts/task-list.mjs task-todos
```

`--evidence` 每次提交登記一筆。要登記多筆，放進 `--file` 信封的 `data.evidence` 陣列（見[狀態格式](skills/task-writing/references/task-state-format.md#指令與驗收)）：

```sh
node <plugin>/scripts/task-list.mjs task report submit --file envelope.json
```

一筆證據可以是文字（`npm test passed`）、URL（`https://…`），或任務資料夾裡的檔案。如果某筆證據指向一個存在、但結案時永遠無法封存的檔案，提交會以 `INVALID_EVIDENCE` 拒絕：任務資料夾外的路徑、絕對路徑、symlink、目錄、控制檔或看板。文字與不存在的檔案都接受。

`ack` 記下某則回報已讀；只有 `accept` 會完成那個葉項目，以及底下有效子項目全部完成的上層。用 `report reject --id <ID> --by reviewer --reason "Insufficient evidence"` 退回；用 `item reopen --id errors --reason "Requirements changed"` 重開。舊嘗試或舊規格的回報不能完成新的工作。

## 收合、歷史與結案

文字圖在 revision 後面列出不為零的葉項目狀態數，依序是等待、卡住、待驗收、進行中、排隊與擱置，接著是所有未讀回報的數量（含歷史回報）。沒有進行中的葉項目時顯示空工作摘要。群組之間空一行；沒完成的子項目，以及完成但還有未讀回報的子項目，連同群組標題一起保留顯示。其餘完成的葉項目收成一個數字；`task-todos --include-completed` 會全部展開。寫進 `board.md` 的圖是純文字。時間線依 revision 順序顯示最近 20 筆已提交事件；待驗收與未讀回報不受這個上限影響。JSON 保留完整的樹。

所有已提交事件都留在 `task-state.json`；不會壓縮，也不會自動刪除。

```sh
node <plugin>/scripts/task-list.mjs task history --limit 50
node <plugin>/scripts/task-list.mjs task history --limit 50 --before-revision <nextBeforeRevision>
node <plugin>/scripts/task-list.mjs task history verify
```

結案／封存會先預覽要搬走的已登記證據：

```sh
node <plugin>/scripts/task-list.mjs task close
node <plugin>/scripts/task-list.mjs task close --yes --expected-revision <preview-revision> --expected-evidence <preview-evidenceSha256>
```

`task archive` 是同一個操作。預覽列出擋住的原因、檔案、checksum 與 `applyArgs`，不寫入任何東西。套用時照抄它的 `--expected-revision` 與 `--expected-evidence`；revision、證據清單或檔案內容一有變動（包括刪除），都要重新預覽、重新檢查。只要還有進行中的項目或未讀回報，套用就拒絕。只搬 `reports[].evidence` 裡登記過、位於任務資料夾內的檔案，包括回報文件與附件；要納入的檔案都得登記。指不到既有項目的參照算文字證據（例如 `npm test passed / 12 tests passed`），會略過，重開前的回報也一樣。`scheme://` 參照是 URL，永遠不搬；像 `proof:結果.txt` 這種參照，在那個檔案存在時算本機檔案。檔案必須是任務資料夾內的一般檔案，不能是控制檔或設定的看板，並綁定預覽時的 checksum；比對控制檔、看板與 `history/` 時不分大小寫。symlink、目錄，以及任務資料夾外的既有路徑都會被拒絕。任務資料夾裡的其他筆記不受影響。

結案交易先複製證據並計算 checksum，再切換狀態裡的參照，最後只刪掉吻合的原始複本，所以舊的證據路徑之後會失效。回報證據、項目的來源參照與完成條件的目標都會更新；`evidenceArchives` 記錄來源到歷史的對應。外部連結不改寫。如果在切換之後中斷，重新預覽結案並套用新的參數，就能把原始複本清完。歷史與回報紀錄永遠不刪，清理也不會替你把證據標成已讀。

結束碼 2 表示產生看板或結案後的清理失敗；原本成功的交易仍然算數。寫入前一律重新讀一次。`task-todos` 讀取失敗時，會顯示最後產生的看板並明確警告狀態不明，而不是把讀不到的狀態當成空的。

## 資料與測試

任務位置的優先順序是 `WORKTREE_CONSOLE_TASKS_DIR`、全域的 `tasksDir`，再來是 `${CLAUDE_HOME:-~/.claude}/worktree-console/tasks`。`task-mode.json` 存任務位置與目前選取的任務。每個任務的 `.console/config.json` 存 `boardPath` 與選用的 `view` 設定。CLI 管理正本狀態；README 說明目的與規格，看板是離線快照。

見[任務設定](skills/task-writing/references/task-mode-config.md)、[狀態格式](skills/task-writing/references/task-state-format.md)與 [README 範本](templates/task-readme.md)。

測試：`node --test plugins/task-list/test/*.test.mjs`（也包含在根目錄的 `npm test` 裡）。

## 授權

[MIT](LICENSE)。
