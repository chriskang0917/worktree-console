---
name: task-writing
description: 建立本機任務、查看文字待辦圖、提交或驗收證據、重開工作、查閱任務歷史、結案或封存任務時使用；尚待開工的 Linear 票不適用。
---

# 本機任務清單

所有指令都用 `node <plugin>/scripts/task-list.mjs` 執行。`<plugin>` 是本 skill 目錄往上兩層的位置，不是目前工作目錄。安裝後即可使用，預設顯示文字圖與已提交事件的時間線。需要 Node.js，以及支援 `ps -p <pid> -o lstart=` 的 macOS／Linux；無法核對程序身分時會安全停止寫入。

## 建立、新增與查看

1. 執行 `task-new "<名稱>"`；JSON 回應的 `task` 是實際任務目錄。README 只放目的、範圍與規格連結。
2. 用 `task item add --id <group-id> --title "<群組>"` 建立群組。用 `task item add --id <leaf-id> --parent <group-id> --title "<工作>" --criterion "<可觀察的完成條件>"` 新增能獨立驗收的小項。改名或排序都保留 ID；標題與下一步必須是單行文字。
3. 執行 `task-todos`，展示實際待辦與時間線輸出。

小項可以省略 `--parent`；省略 `--criterion` 會建立群組。能獨立驗收的工作用小項表示，不手動勾選群組。

## 提交與驗收

- 執行 `task report submit --item <leaf-id> --evidence <證據引用> --reviewer "<驗收者>"`，取得 report ID。要安排驗收時間，加上 `--revisit <含時區的未來-ISO-timestamp>` 與 `--next "<驗收動作>"`。證據可以是任務內檔案、URL 或一般文字，例如 `npm test passed`；`--evidence` 一次登錄一筆，要登錄多筆時改用 `--file` 的 JSON，`data.evidence` 放陣列。指向既有但不能封存的項目（任務外或絕對路徑、連結、資料夾、控制檔、看板）會在提交時被拒絕。
- 宣稱成功或程序 exit code 不等於驗收。依完成條件讀取證據；只有指定驗收者可以執行 `task report accept --id <report-id> --by "<驗收者>"`。
- 條件未達成時，執行 `task report reject --id <report-id> --by "<驗收者>" --reason "<未達成條件>"`；小項變成 blocked，並保留原因。
- `task report ack --id <report-id>` 只記錄已讀，不代表完成。
- 驗收通過會在同一交易內完成小項，以及所有有效子項均完成的父群組。空群組與只有取消子項的群組不算完成。

## 重開與恢復

修改已完成工作前，先執行 `task item reopen --id <leaf-id> --reason "<範圍變更或修正>"`。舊 attempt 或舊規格的報告保留為歷史，不能完成新工作。取消用 `task item cancel --id <id> --reason "<原因>"`。

`task read` 與 `task validate` 會重建 board。Exit 2 表示生成文件或結案後清理失敗，已提交的事實仍有效。修正原因後重讀，不盲目重送驗收。Exit 1 表示指令或正本狀態錯誤；revision 衝突後應重讀並重新判斷。

用 `task --dir <任務目錄>` 或 `task-todos --dir <任務目錄>` 操作另一個任務，不改變目前選取。

## 顯示、歷史與結案

完成小項預設收合成計數；`task-todos --include-completed` 可展開。時間線顯示最近 20 筆事件。未核對證據、阻塞與待驗收仍顯示，不可當成已解決。

事件全部保留在正本，不自動壓縮或刪除。用 `task history --limit 50` 查閱，依 `nextBeforeRevision` 分頁；`task history verify` 驗證正本事件。

先執行 `task close`，處理每個阻擋條件，核對檔案與 checksum。使用者同意搬移後，使用預覽的 `applyArgs` 執行 `task close --yes --expected-revision <preview-revision> --expected-evidence <preview-evidenceSha256>`；`task archive` 使用相同參數。revision、檔案清單或內容改變時，要重新預覽與核對。只有報告登錄的任務內證據檔案與附件會搬移；不存在的檔案引用視為文字證據，URL 與文字保持不變。舊檔案路徑失效，外部連結不會更新。任務資料夾內的其他筆記不動；結案不會代為核對報告。

## 檔案歸屬

CLI 管理 `task-state.json`；`board.md` 是生成的離線快照。詳細證據另存檔案並由報告引用，不在 README 重複記錄進度。

變更儲存位置或修復選取時，讀[任務設定](references/task-mode-config.md)。撰寫 JSON 指令或機械驗證證據時，讀[狀態格式](references/task-state-format.md)。任務筆記使用 [README 範本](../../templates/task-readme.md)。
