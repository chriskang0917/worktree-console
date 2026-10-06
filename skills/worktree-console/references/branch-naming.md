# Branch 命名

開工前取 branch 名稱用這份規則。只管名稱，不建 branch、不改名既有 branch。

- **使用者指定的名稱**照用；不合下面規則時在對齊摘要加一行提醒並附一個合格的建議名稱，使用者沒回應就照原名開。
- **同一張母票在別的 repo 已開過的 branch** 整串照用，不改、不提醒（前後端名稱要一模一樣）。
- **Linear 票上的 branch 名稱**（`orca linear issue <票號> --json` 的 `result.issue.branchName`）讀得到就整串照用。
- **repo 有慣例**（`CONTRIBUTING.md`、`AGENTS.md`、`CLAUDE.md`、`docs/` 有談 branch 命名，或 `git branch --sort=-committerdate` 前 20 筆過半是同一種格式）就照 repo 的格式。
- **預設格式** `<前綴>/<描述>` 或 `<前綴>/<票號>-<描述>`：前綴只用 `feat`、`fix`、`chore`、`docs`、`refactor`、`test`；票號小寫，例如 `feat/proj-6923-artifact-export`。
- **描述**至少 2 個英文單字、kebab-case，要有一個字講「做什麼」（`feat/console` 不合格、`feat/console-hide-idle` 合格）；只用小寫英數字和 `-`；整串不超過 50 字元。
