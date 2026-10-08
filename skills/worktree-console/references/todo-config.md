# 待開工的票：設定與篩選

此設定只管 Linear 待開工票；本機任務清單與文字線圖請另裝 [task-list 插件](../../../plugins/task-list/README.md)。
| 指令 | 用途 |
| --- | --- |
| `console.mjs todo --repo R` | 待開工的票：`### 待開工`，空一行後是 markdown 表格 `代號｜票號｜標題`（代號依序 a、b、c）（每列不超過 100 欄）；沒有符合的票就什麼都不印；沒有設定檔印 `skip:no-config`，`titlePrefixes` 為空印 `skip:disabled`，Linear 或 Orca 讀不到印 `skip:<error.code>` |

`todo` 從 Linear 抓出「指派給我、狀態類型是 unstarted、有排進任何 Cycle」的票，再依個人設定檔 `config.json` 篩選（放在中控台設定目錄：有設 `WORKTREE_CONSOLE_HOME` 就是它，否則 `~/.config/worktree-console/`；寫之前先 `echo "${WORKTREE_CONSOLE_HOME:-$HOME/.config/worktree-console}"` 確認目錄）：

```json
{ "titlePrefixes": ["[FE]", "Chris - "], "excludeLabels": ["會議"] }
```

- 標題開頭要符合 `titlePrefixes` 其中之一；帶有 `excludeLabels` 任一標籤的排除。`titlePrefixes` 為空就不查。
- 已開工過的排除：任一 repo 的主 checkout 有 `.goals/<票號小寫>.md`，或 Orca 任一 repo 的 worktree 綁了這張票、branch 名稱含這個票號。
- 篩選不分 repo：Linear 只有一份，在哪個 repo 開中控台看到的清單都一樣；開在哪個 repo 照〈開票（對齊）〉的預定 repo。

輸出 `skip:no-config` 時問一次：「要不要開啟待開工提醒？請給要納入的標題前綴（例如 `[FE]`、`[BE]`），以及要排除的標籤（可不填）；不需要就回『不用』。」
- 使用者給了前綴 → 寫入設定檔（目錄不存在就建立），再跑一次 `todo` 照上面處理。
- 使用者回不用 → 寫入 `{ "titlePrefixes": [] }`，之後印 `skip:disabled`，不再詢問；要重新開啟就改這個檔。
