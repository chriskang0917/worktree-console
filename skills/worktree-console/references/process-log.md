# 過程紀錄

`report`、`distilled` 不帶 `--repo`。

| 指令 | 用途 |
| --- | --- |
| `console.mjs report [--since 24h\|7d\|<日期>]` | 過程紀錄報表（見〈過程紀錄〉）：常卡的問題、等待時間、token 與費用、偏離建議的回答，加上每個 session 一列的總表（觸發、skill、停下、回應與處理時間、完畢後再指令次數、總時間、產出），以及從中控台對話紀錄算出的指令用量、詳情建議去向、中控台 token（依觸發與子指令） |
| `console.mjs distilled` | 使用者打 `已蒸餾` 時跑：記下這批 20 份處理完，下一批從下一份起算；輸出一行 `[蒸餾] …`，原樣貼 |

為什麼值得加：事後要回答子 session 常卡在哪、每次等使用者多久、每張票與中控台各花多少 token、使用者偏離建議的回覆是什麼；模型手記會漏記又多吃工具呼叫，所以全由腳本與 hook 順帶寫出。

- 紀錄在 `~/.worktree-console/`（本機 git、沒有 remote），一天一個 JSONL。停下事件由 watcher 寫；回答、開工、交棒、關閉由 `send`／`answer`／`await-start`／`handoff`／`close` 寫；子 session 收到的每句話與分頁↔session 登記由 plugin hook 寫；token、skill、處理時間由 watcher 定期從對話紀錄重算並負責 commit。
- **中控台不寫紀錄、不組紀錄內容、不 commit 紀錄**，照常呼叫上面的腳本即可。
- 使用者要看紀錄（「報表」「最近卡在哪」）→ 跑 `console.mjs report [--since 7d]` 原樣貼出。
- watcher 同一時機把中控台與受管子 session 的對話紀錄（含子代理）遮罩後複製進 `~/.worktree-console/transcripts/`（不進 git、不自動刪），每滿 20 份由 watcher 印一行 `[蒸餾] …` 提醒（附路徑清單檔），未標記前每次中控台啟動再印一次；使用者打 `已蒸餾` → 跑 `console.mjs distilled` 原樣貼出。中控台不讀、不改這些複製檔。為什麼值得加：Claude Code 約 30 天清掉對話紀錄，報表的指令用量、詳情建議去向、中控台 token 與日後的蒸餾都靠這份副本；提醒與標記全由腳本做，中控台只轉貼。
