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

`task-new` creates v2 state and a creation event; required collections are `items`, `reports`, `events`, and `history`. v1 is readable and migrates under the transaction lock on its first write or `task migrate`, retaining the original snapshot and migration manifest. Unknown versions are rejected; older v1 writers reject v2.

## IDs, attempts, and revisions

Items require `id`, `kind` (`group` or `leaf`), `title`, `order`, `status`, `sourceRef`, `attemptId`, and `specRevision`. Active work requires `nextAction`. Display text is single-line, contains no control characters, and has no narrow-panel length limit.

Root groups contain leaves through `parentId`; standalone leaves are allowed, nested groups are not. Sibling order is explicit and unique. Optional `blockedBy` references must exist and be acyclic; ordering alone does not imply dependency. `scheduledFor` is a valid `YYYY-MM-DD` date in the task timezone; `dueAt` and `revisitAt` require timezones.

Renaming or reordering preserves IDs. Reopening creates a new attempt; changing completion criteria requires increasing `specRevision` through a JSON command. Reports from older attempts or specifications retain `history: true` and cannot complete current work.

## Commands and acceptance

Ordinary operations are `item add/update/move/reopen/cancel`, `report submit/accept/reject/ack`, `read`, and `validate`. History and close operations are described below. The CLI provides ordinary flags; `task <operation> --file <envelope.json>` accepts:

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

Exit 2 indicates generation, automatic compaction, or post-close source removal failure without reverting committed facts. Fix the cause and reread; never replace authoritative state to repair a board. Automatic compaction is a second transaction: response `revision` remains the original command revision, while `stateRevision` is the subsequent compaction revision.

This format covers local tasks and text graphs only, not a session runner, a Focus task panel, or Markdown import.

## History, migration, and close contract

- Each `history[]` entry contains `id`, `manifest`, `sha256`, and `count`. Restore sets `restored: true`; files remain, but their events are no longer duplicated in the hot/cold union.
- `history/task-list/<id>/manifest.json` contains taskId, schemaVersion, source revision, event count, and revision range. Snapshots and JSONL segments have relative paths and SHA-256 hashes. Events retain their original `commandId/requestHash/result`. Every read verifies history; missing or damaged history blocks writes.
- Write order is snapshot, segment, manifest, then atomic state replacement. A manifest becomes committed only when state references it. Interruption before switching leaves unreferenced files; interruption after switching allows board regeneration at the same revision. Neither deletes history.
- Above 1,000 hot events or 2 MiB, a separate automatic compaction transaction retains the union of the latest 200 events and seven days. State-referenced events/commandIds and unknown extension commands remain hot. Failure returns `compactionError` without reverting the original transaction.
- `task compact` previews; `--apply --expected-revision R` applies. `task history --limit 50 --before-revision R` paginates across hot/cold events and returns `nextBeforeRevision`; `task history verify` verifies event history.
- `task history restore --archive ID` previews; `--apply --expected-revision R` restores events to hot storage and increments revision without rolling back items, reports, or attempts. Snapshots are not an event-sourcing contract for arbitrary-time replay.
- v1 `migration` references a checksum manifest and original v1 snapshot; unknown extension fields survive. Migration shares the current command's atomic state switch.
- `task close` and `task archive` preview blockers, files, checksums, and `applyArgs`. Apply with `--yes --expected-revision R --expected-evidence HASH` copied from that preview. Changed revision, evidence list, or file contents require a new preview. JSON envelopes use `expectedRevision` and `data.expectedEvidence`. Active items, unacknowledged reports, unresolved questions, and nonterminal runs/claims block apply.
- Only registered task-local `reports[].evidence` files move to `history/task-list/<id>/evidence/<original-path>`, including reports and attachments. URIs remain unchanged; filenames do not imply ownership. Control files, symlinks, and escaping paths cannot move.
- `evidenceArchives[]` stores `id` and `files[{source,destination,sha256}]`. Copy and fsync precede the state switch; only matching source copies are removed afterward. Preview and apply close again to finish interrupted removal. Report evidence, item sourceRef, and completionPolicy targets are updated; old paths stop working and external links require manual updates.
- Text graphs collapse completed leaves and show the latest 20 events by default; `--include-completed` expands them and `--json` retains the full tree. Unacknowledged current and historical evidence remains visible with group ownership. Failed reads preserve the last generated snapshot and mark its state unknown. Boards cannot overwrite registered evidence or store-owned files, including `history/`.
- Disabling or uninstalling leaves authoritative state, snapshots, history, and evidence intact. There is no automatic expiry or deletion command.
