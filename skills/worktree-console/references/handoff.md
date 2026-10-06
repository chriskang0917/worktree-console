# 交棒（define-goal 定稿後）

`<base>` 是 worktree-console 的 base directory，`<define-goal>` 是 `console.mjs define-goal` 印的 `目錄：` 那個路徑（define-goal 實際安裝的位置，不是 `<base>` 旁邊）。

| 指令 | 用途 |
| --- | --- |
| `console.mjs handoff --path P --from <訪談 handle> --file <暫存檔>` | define-goal 定稿後交棒執行（見〈開工〉）：`[票號] 已交棒執行`，或 `[票號] 交棒失敗：<步驟與原因>` 加 `/goal` 原文並 exit 1 |

收到「定稿完成」後改由新分頁執行，訪談 session 不再送任何指令：

1. 照 `<define-goal>/SKILL.md`〈交棒〉選「執行」的規格組 `/goal`，錨點檔＝主 checkout 的 `.goals/<slug>.md`（絕對路徑）：開頭一句照該節固定句，後接 `<define-goal>/references/orca-handoff.md` 的工作目錄句與 commit／不 push 句，再接 2–4 條證據句（🔧 與 ⚠️ 不入）與結尾句；整段單一一行、連同 `/goal ` ≤800 字元（超過會被 Claude Code 收成貼上內容而不執行，依據與精簡順序見 `<define-goal>/references/orca-handoff.md`〈`/goal` 條件的共用規格〉）。送出前把目標檔 `**實作方案**` 那行改成「直接實作（`/goal` 錨在本檔，<YYYY-MM-DD>）」。
2. `/goal` 原文先用 Write 寫進暫存檔，照 orca-handoff 第 4 步量長度確認 ≤800，再跑 `console.mjs handoff --path <path> --from <訪談 handle> --file <暫存檔>`，輸出逐字轉貼。腳本在同一個 worktree 開新分頁、等就緒、送出，看到 `Goal set` 才關訪談分頁；失敗時訪談分頁保留並印出 `/goal` 原文，不自行重試；失敗原因是「被當成貼上內容收起」時提醒使用者先清空新分頁的輸入框再貼。
