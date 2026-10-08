# Task state format

## File ownership

- `README.md`: purpose, scope, and specification links written by a person or agent; use the [template](../../../templates/task-readme.md).
- `task-state.json`: authoritative state managed by the CLI; do not edit manually.
- `.console/config.json`: board location; see [task configuration](task-mode-config.md).
- `.console/transaction.lock` and `previous-<revision>.json`: transaction protection and durable revision backups.
- `board.md` (or the configured path): generated offline snapshot, never read back as authoritative state.
- Evidence files: written by the work's producer and referenced by reports; the core imposes no evidence directory layout.

## Minimal state

```json
{
  "schemaVersion": 2,
  "taskId": "stable-task-id",
  "revision": 0,
  "title": "Login cleanup",
  "timezone": "UTC",
  "createdAt": "2026-10-08T00:00:00Z",
  "updatedAt": "2026-10-08T00:00:00Z",
  "items": [],
  "reports": [],
  "events": [],
  "history": []
}
```

`task-new` 建立 v2 正本及建立事件；必要集合為 `items`、`reports`、`events`、`history`。v1 可唯讀，首次寫入或 `task migrate` 時在交易鎖內遷移，保留原始 snapshot 與 migration manifest；未知版本拒絕處理，舊 v1 writer 會拒絕 v2。

## IDs, attempts, and revisions

Items require `id`, `kind` (`group` or `leaf`), `title`, `order`, `status`, `sourceRef`, `attemptId`, and `specRevision`. Active work requires `nextAction`. Display text is single-line, contains no control characters, and has no narrow-panel length limit.

Root groups contain leaves through `parentId`; standalone leaves are allowed, nested groups are not. Sibling order is explicit and unique. Optional `blockedBy` references must exist and be acyclic; ordering alone does not imply dependency. `scheduledFor` is a valid `YYYY-MM-DD` date in the task timezone; `dueAt` and `revisitAt` require timezones.

Renaming or reordering preserves IDs. Reopening creates a new attempt; changing completion criteria requires increasing `specRevision` through a JSON command. Reports from older attempts or specifications retain `history: true` and cannot complete current work.

## Commands and acceptance

一般操作為 `item add/update/move/reopen/cancel`、`report submit/accept/reject/ack`、`read`、`validate`。歷史與結案操作見下節。CLI 提供一般旗標；`task <operation> --file <envelope.json>` 接受：

```json
{
  "commandId": "unique-request-id",
  "expectedRevision": 0,
  "actor": { "host": "local", "id": "writer" },
  "data": {}
}
```

`data` allows only fields defined for that operation. When writing commands, read `applyTaskOperation` in `scripts/task-core-commands.mjs`. For example, item update uses `{ "id": "leaf-id", "changes": { "title": "New title" } }`; item move uses `{ "id": "leaf-id", "parentId": "group-id", "order": 1 }` (`null` removes the parent).

Every leaf has a nonempty `completionPolicy`; each condition requires `criterion`, `target`, `evidenceType`, and `verifier`. `sha256` verifies a task-relative file: report evidence must include that path, and the condition uses `evidenceType: "file"` and lowercase `expectedSha256`. All other verifier names require explicit acceptance and do not run external processes.

Reports record `id`, `itemId`, `attemptId`, `specRevision`, `outcome`, `evidence`, `ack`, and `acceptance`. Successful delivery for semantic criteria requires `review: { reviewer, revisitAt, nextAction }`; the revisit time must be future and include a timezone, and the leaf enters `review`. Only the designated reviewer can accept or reject the current pending report. Failure outcomes, unmet mechanical conditions, or rejection block the leaf; rejection retains its reason. Ack means read, not accepted.

Acceptance completes the leaf and, in the same transaction, its parent if it has at least one active child and all active children are complete. Empty groups and groups with only cancelled children are not complete; cancellation is tracked separately. Reopening a completed leaf returns its completed parent to `queued`.

## Events and boards

Writes acquire an exclusive process-identity lock, check revision and references, apply the operation and completion propagation, validate the full state, save the previous revision, then atomically commit state and events with fsync/rename. The previous revision and up to 20 older backups are retained; locks whose liveness cannot be determined are not reclaimed.

Events contain `id`, `revision`, `entity`, `actor`, `occurredAt`, `recordedAt`, and `commandId`; committed operations also retain their result and request hash. Retrying the same command ID with identical content returns the original result; changing content or actor with that ID fails. Failed transactions add no timeline event.

Generated headers contain `GENERATED`, `taskId`, `revision`, `generatedAt`, and an offline-snapshot marker. They identify a state snapshot, not live session or Git status. `task-todos` displays committed events; `task read` and `task validate` rebuild the board from authoritative state, overwriting handwritten generated content.

## Errors and recovery

Exit 1 indicates an input, authoritative-state, revision, lock, or selection error. On `REVISION_CONFLICT`, reread and reconsider before submitting. On `COMMAND_ID_CONFLICT`, use a new ID only for a genuinely new request; do not retry blindly.

Exit 2 表示生成、自動壓縮或結案後移除原副本失敗，不撤銷已提交事實。修正問題後重新讀取；不得為修看板覆蓋今天的正本。自動壓縮是第二筆交易，回應 `revision` 保留原指令 revision，`stateRevision` 才是後續壓縮 revision。

This format covers local tasks and text graphs only, not a session runner, a Focus task panel, or Markdown import.

## 歷史、遷移與結案契約

- `history[]` 每筆含 `id`、`manifest`、`sha256`、`count`；還原後設 `restored: true`，檔案仍保留，但事件不再重複加入冷熱聯集。
- `history/task-list/<id>/manifest.json` 含 taskId、schemaVersion、來源 revision、事件數及 revision 範圍；snapshot 與 JSONL segment 各自有相對路徑及 SHA-256。事件物件原樣保存，`commandId/requestHash/result` 不重編。每次讀取驗證歷史；損壞或缺失拒絕寫入。
- 寫入順序為 snapshot → segment → manifest → 原子替換正本；正本指向 manifest 才算採用。切換前中止只留下未採用檔案，切換後可重建同 revision 的看板；兩種情況都不刪歷史。
- 交易後熱事件超過 1,000 筆或 2 MiB 時自動另開壓縮交易；保留最近 200 筆與最近七天的聯集。狀態引用的事件／commandId、未知擴充指令留在熱資料。自動壓縮失敗回報 `compactionError`，不撤銷原交易。
- `task compact` 預覽；`--apply --expected-revision R` 套用。`task history --limit 50 --before-revision R` 跨冷熱分頁，回傳 `nextBeforeRevision`；`task history verify` 驗證事件歷史。
- `task history restore --archive ID` 預覽；加 `--apply --expected-revision R` 將事件搬回熱資料，revision 加一，items/reports/attempts 不回退。snapshot 不是可重播至任意 revision 的 event-sourcing 契約。
- v1 遷移的 `migration` 指向含 checksum 的 manifest 及原始 v1 snapshot；保留未知擴充欄位。遷移與當次命令共用正本切換點。
- `task close`／`task archive` 預覽；`--yes` 才套用。所有 active items、未 ack reports、未結問題、非終態 runs/claims 都阻擋套用。
- 僅搬移 `reports[].evidence` 明確引用的任務內檔案至 `history/task-list/<id>/evidence/<原路徑>`，包含報告與附件。URI 留在原處；不掃描檔名推測所有權。控制檔、符號連結及越界路徑不可搬移。
- `evidenceArchives[]` 保存 `id` 與 `files[{source,destination,sha256}]`。先複製並 fsync，正本切換後才移除 checksum 相符的原副本；重跑 close 可完成中斷搬移。更新 report evidence、item sourceRef 與 completionPolicy target；外部連結須依對照查歷史。
- 文字圖預設收合完成項並顯示最近 20 筆；`--include-completed` 展開、`--json` 保留完整樹。未核對與歷史證據待核對獨立呈現。讀取失敗保留最後生成快照並標未知；看板不得寫入 `history/`。
- 停用／移除插件不動正本、snapshot、歷史或證據；沒有自動到期或刪除指令。

