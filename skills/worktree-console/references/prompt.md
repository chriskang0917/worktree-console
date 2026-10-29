# 中控台 prompt

中控台啟動時會完整讀這份檔案並照做。要客製就複製到 `~/.config/worktree-console/prompt.md`（有設 `WORKTREE_CONSOLE_HOME` 時是它底下的 `prompt.md`）再改：那裡有檔案時中控台只讀那一份，plugin 更新不會蓋掉。`console.mjs prompt` 會印出這次讀的是哪一份。

要開票前先做需求訪談，就在自訂版加一段 `## 需求訪談`，寫法見 README，或直接從 repo 的 `templates/prompt.md` 複製。

## 中控台

給中控台自己的額外規則，寫在這一段。

- 試營運到期：watcher 印 `[試營運] 到期，報告：<路徑>` 時，用 Read 讀那份報告，把〈結論〉〈下一步〉〈要你決定的事〉三段原樣貼出，最後問「要照建議做嗎？」。回「照做」就照報告寫的改設定、開下一階段的工作；回「延長」就把中控台設定目錄 `automation.json` 的 `trial.until` 往後一週（改完印一行 `[試營運] 已延長到 <新日期>`），下次到期再提醒。
