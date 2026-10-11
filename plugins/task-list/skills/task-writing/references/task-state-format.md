# 任務狀態格式

## 檔案歸屬

- `README.md`：人或 agent 撰寫的目的、範圍與規格連結；使用[範本](../../../templates/task-readme.md)。
- `task-state.json`：CLI 管理的正本，不手動編輯。
- `.console/config.json`：board 位置；見[任務設定](task-mode-config.md)。
- `.console/transaction.lock` 與 `previous-<revision>.json`：交易保護與持久化版本備份。
- `board.md` 或設定的位置：生成的離線快照，不當成正本讀回。
- 證據檔案：由工作產出者撰寫並由報告引用；核心不限定證據目錄配置。

## 最小狀態

```json
{
  "schemaVersion": 2,
  "taskId": "stable-task-id",
  "revision": 0,
  "title": "登入清理",
  "timezone": "UTC",
  "createdAt": "2026-10-08T00:00:00Z",
  "updatedAt": "2026-10-08T00:00:00Z",
  "items": [],
  "reports": [],
  "events": []
}
```

`task-new` 建立 schemaVersion 2 的狀態與建立事件；必要集合是 `items`、`reports`、`events`。其他 schemaVersion 一律拒絕。

## ID、attempt 與 revision

項目必須有 `id`、`kind`（`group` 或 `leaf`）、`title`、`order`、`status`、`sourceRef`、`attemptId` 與 `specRevision`。有效工作需要 `nextAction`。顯示文字必須單行、沒有控制字元。

根群組透過 `parentId` 包含小項；允許獨立小項，不允許巢狀群組。同層排序必須明確且唯一。選填的 `blockedBy` 引用必須存在且無循環；排序不代表相依。`scheduledFor` 是任務時區中的有效 `YYYY-MM-DD` 日期；`dueAt` 與 `revisitAt` 必須含時區。

改名或排序保留 ID。重開建立新 attempt；修改完成條件必須透過 JSON 指令提高 `specRevision`。舊 attempt 或舊規格的報告保留 `history: true`，不能完成目前工作。

## 指令與驗收

一般操作是 `item add/update/move/reopen/cancel`、`report submit/accept/reject/ack`、`read` 與 `validate`。歷史與結案操作見下節。CLI 支援一般旗標；`task <operation> --file <envelope.json>` 接受：

```json
{
  "commandId": "unique-request-id",
  "expectedRevision": 0,
  "actor": { "host": "local", "id": "writer" },
  "data": {}
}
```

`data` 只接受該操作定義的欄位。撰寫指令時讀 `scripts/task-core-commands.mjs` 的 `applyTaskOperation`。例如 item update 使用 `{ "id": "leaf-id", "changes": { "title": "新標題" } }`；item move 使用 `{ "id": "leaf-id", "parentId": "group-id", "order": 1 }`（`null` 表示移除父群組）。

每個小項都有非空 `completionPolicy`；每個條件需要 `criterion`、`target`、`evidenceType` 與 `verifier`。`sha256` 驗證任務內相對路徑檔案：報告證據必須包含該路徑，條件使用 `evidenceType: "file"` 與小寫 `expectedSha256`。其他 verifier 名稱都需要明確驗收，不執行外部程序。

報告記錄 `id`、`itemId`、`attemptId`、`specRevision`、`outcome`、`evidence`、`ack` 與 `acceptance`。語意條件的成功交付需要 `review: { reviewer, revisitAt, nextAction }`；revisit 時間必須在未來且含時區，小項進入 `review`。只有指定驗收者能接受或拒絕目前待驗收報告。失敗、機械條件未達成或拒絕會阻塞小項；拒絕保留原因。Ack 表示已讀，不是接受。

驗收完成小項，並在同一交易內完成至少有一個有效子項且所有有效子項都完成的父群組。空群組與只有取消子項的群組不算完成；取消另行計數。重開已完成小項會讓已完成父群組回到 `queued`。

## 事件與 board

寫入先取得核對程序身分的互斥鎖，再檢查 revision 與引用、套用操作並傳遞完成狀態、驗證完整狀態、儲存前版，最後以 fsync／rename 原子提交狀態與事件。保留前版及最多 20 份更舊備份；無法判斷存活的鎖不回收。需要 macOS／Linux 的 `ps -p <pid> -o lstart=`；無法核對自身程序時以 `LOCK_IDENTITY` 停止寫入，不以 PID 單獨判斷鎖身分。

事件包含 `id`、`revision`、`entity`、`actor`、`occurredAt`、`recordedAt` 與 `commandId`；已提交操作也保留結果與 request hash。相同 command ID 與內容重送回傳原結果；同 ID 改內容或 actor 會失敗。失敗交易不新增時間線事件。

生成檔標頭包含 `GENERATED`、`taskId`、`revision`、`generatedAt` 與離線快照標記，表示狀態快照，不是即時狀態。`task-todos` 顯示已提交事件；`task read` 與 `task validate` 從正本重建 board，覆寫生成區中的手寫內容。

## 錯誤與恢復

Exit 1 表示輸入、正本狀態、revision、鎖或選取錯誤。`REVISION_CONFLICT` 後先重讀並重新判斷；`COMMAND_ID_CONFLICT` 時，只有真正的新請求才用新 ID，不盲目重試。

Exit 2 表示生成文件或結案後移除原檔失敗，不撤銷已提交事實。修正原因後重讀，不以覆寫正本修復 board。


## 歷史與結案契約

- 所有事件保留在 `events`。`task history --limit 50 --before-revision R` 依 revision 由新到舊分頁，回傳 `nextBeforeRevision`；`task history verify` 驗證正本並回傳事件數。
- `task close` 與 `task archive` 預覽 blockers、files、checksum 與 `applyArgs`。套用時照預覽提供 `--yes --expected-revision R --expected-evidence HASH`。revision、證據清單或內容改變時要重新預覽。JSON envelope 使用 `expectedRevision` 與 `data.expectedEvidence`。有效項目與未核對報告都會阻擋套用。
- 只有 `reports[].evidence` 登錄的任務內檔案會搬到 `history/task-list/<id>/evidence/<原路徑>`，包含報告與附件。不存在的檔案引用視為文字證據略過；URL 與文字保持不變。檔名不代表歸屬。控制檔、看板、資料夾、symlink、絕對路徑與越界路徑不能搬移，`report submit` 在提交時就以同一個判定拒絕它們（`INVALID_EVIDENCE`）；控制檔、看板與 `history/` 的比對不分大小寫。
- `evidenceArchives[]` 儲存 `id` 與 `files[{source,destination,sha256}]`。複製與 fsync 在狀態切換前完成；切換後只移除內容相符的原檔。移除中斷時重新預覽並套用結案。報告證據、項目 sourceRef 與 completionPolicy target 都會更新；舊路徑失效，外部連結需手動更新。
- 文字圖預設收合已完成小項並顯示最近 20 筆事件；`--include-completed` 展開，`--json` 保留完整項目樹。目前與歷史未核對證據都保留所屬群組。讀取失敗保留最後生成快照並標記狀態未知。board 不可覆寫登錄證據或 CLI 管理的檔案，包含 `history/`。
- 停用或移除 plugin 會保留正本、版本備份與證據。沒有自動到期或刪除指令。
