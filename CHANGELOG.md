# Changelog

## 1.10.0

- feat(console): batch interview questions into one self-answered sheet

## 1.9.0

- feat(trial): remind the console when the trial ends and batch second-tier questions in a 待決 tab

## 1.8.2

- fix(stage): read dev-flow run folders under ~/.sara-dev-flow and add console.mjs stage

## 1.8.1

- fix(watch): wake the console on every finalize and catch up missed ones on restart

## 1.8.0

- feat(focus): recap each child session's stop and mark ready suggestions on cards

## 1.7.0

- feat(focus): count down before the advisor auto-replies on the band

## 1.6.2

- fix(console): skip transcript-only notices and idle compaction summaries when judging a turn over

## 1.6.1

- fix(tool-dots): draw failed calls as a red ✕ after the dots

## 1.6.0

- The focus band shows the agent-skills advisor's suggestion on a row of its own under the question: `建議產生中…` while the background prediction runs, then `建議：<答案>，<一句理由>` on the next poll, with `（原則性：<類別>）` for a principle question. No row when the prediction failed, for 🔐 or ⏸, or without `~/.advisor/`; `/focus-show` reports stay as they were.

## 1.5.3

- fix(console): confirm delivery from the transcript, close a temp worktree the watcher already removed

## tool-dots 0.1.2

- A failed, denied or interrupted call is drawn as a red `✕` instead of a red dot, after the yellow and green dots of its line, so it no longer looks raised next to green dots. `✕` is one cell wide, so `tool_call:` starts in the same column as before.

## tool-dots 0.1.1

- fix(console): one-line band question, hide keepalive, align tool_call, menu lead text

## 1.5.2

- fix(console): one-line band question, hide keepalive, align tool_call, menu lead text

## 1.5.1

- fix(console): wait for the turn to end before asking, keep tables, gate cache handoff

## focus-show 0.2.0

- feat(focus): version the focus.json format focus-show reads

## 1.5.0

- feat(focus): version the focus.json format focus-show reads

## 1.4.0

- feat(console): name every session, remote control, herdr ask, CI version bumps

## 1.3.0

- The side panel has three tabs, 待回覆 (q), 全部 (w) and 封存 (e); the 閒置 tab and its `r` key are gone, and the footer reads `qwe 切分頁`. 全部 now lists every session that is not archived, idle ones included with their 閒置 status, so a pushed session that went idle no longer drops out of every tab. What counts as 待回覆 is unchanged.
- The focus band's header carries `9: 顯示問題 · 8: 延後處理` on its right, in the theme's dim colour (only `9: 顯示問題` while the queue is empty); the row of buttons under the question is gone and its row goes to the question. On a narrow band the name is cut with `…` and both buttons stay whole on the one row. The keys 9 and 8 work as before.
- Removed the classic appearance: the panel and band have one look. The `appearance` setting is gone; a `config.json` that still has it toasts once 「appearance 已移除，一律用預設外觀」 and the panel draws as usual.
- The README is in Traditional Chinese now, with the English one in `README.en.md`; each links to the other at the top. The same goes for the task-list README.
- New `tool-dots` mod in this marketplace, a separate plugin (see `tool-dots 0.1.0`). CI runs `claude plugin test mods/tool-dots`.

## tool-dots 0.1.0

- New `tool-dots` plugin: a run of tool calls with no reply text or message of yours between them draws as one line, a dot per call (yellow running, green done, red failed) and then `tool_call: Bash ×3 · Read ×2` in the order each tool first ran, with ` - N error(s)` when any failed. Reminders riding on a tool result do not split a run. Past 24 calls a dim `+N` follows the dots; MCP tools show as `server:tool`. Folded, result blocks are hidden; ctrl+o (or `--verbose`) shows every call and its result as usual.

## task-list 0.1.1

- The README is in Traditional Chinese, with the English one in `README.en.md`; each links to the other at the top.

## task-list 0.1.0

- 新增 `task-list` plugin：建立本機任務與待辦項目，提交並驗收證據（任務內檔案、URL 或一般文字），以文字圖與時間線查看進度，並可先預覽再確認地結案、封存證據。需要 Node.js、macOS／Linux 與支援程序啟動時間的 `ps`。

## 1.2.0

- Switching tabs right after `0` opens the side panel no longer leaves the highlight on a card number; it lands on the selected card's name.
- Removed the `狀態` command: typing it now goes to the conversation like any other text, and the side panel opens only from the band's `0`. On Claude Code 2.1.295 and later a dropped prompt stays in the input box, which kept the panel from taking the keys.
- Removed the reply-habit memory: the reply list no longer has a 你通常會回 column, nothing asks to remember a habit any more, and `memory.mjs` with its replay, remember and decline commands is gone. The scripts no longer read or write `~/.worktree-console/memory.md`; an existing file is left as it is.
- `0` opens the side panel at any terminal width; it no longer waits undrawn below 144 columns.
- `config.json` is read only in the console's own tab, so another tab never toasts about it, and a file that is not valid JSON now toasts once instead of silently falling back to the defaults.
- ✨ on a queued name now counts as two columns when the band lays out its keys.
- `neutral-light`, `gruvbox` and `light` borders now reach at least 3:1 contrast against their panel backgrounds; gruvbox's selected frame uses `#fbf1c7` so it differs from its secondary text.
- Added optional `neutral-light`, `dracula`, `gruvbox`, and `light` themes through `config.json`; the classic appearance ignores the theme.
- Named themes now paint their own side-panel backgrounds, including card spacing and unused rows; neutral and classic continue to follow Claude Code. Dracula borders use `#9aa1c2` to remain visible on `#282a36`. Ink border cells and Claude Code's own frame retain the host background.
- The refined focus-band reply count uses the theme's dim text color, while its trailing rule retains the border color; neutral colors remain unchanged.
- The focus panel now defaults to a refined appearance with compact status icons, terminal-native neutral colors, responsive stage labels, and optional animation. Configure `appearance`, `theme: neutral`, and `motion` in `config.json`; choose `appearance: classic` to keep the original look and shortcuts.
- Fixed refined focus-band hidden queue counts and question-height budgeting; narrow card headers no longer reserve unused trailing spaces.
- Corrected narrow-card header regression fixtures and drawn-tree lookup so both normal and archived cards are checked for complete names and full-row width at 46 and 36 columns.
- Only the primary question alternates ◆/◇ every 900ms. Every visible authorization ◆ breathes together (1.2 seconds blocked, 0.6 seconds dim), while its label and focus-band rail retain the blocked color. Rendering updates only when the visible animation frame changes; working sessions and errors remain static.
- Refined cards show the stage as a grey tag at the right of the header from 46 columns up, and first in the bottom row below that; 未開工 is omitted. Every status has its own colour: 已回覆 gets bright cyan, 待授權 moves to bright magenta for contrast, 異常 to bright red. Hierarchy by subtraction: the focus band's session name is the one bold lead; status labels, repo rules, counts and the footer stay regular or grey, and only a leading count in a summary (`1 未核對`) lifts to the foreground. The band's name is plain text now; `9: 顯示問題` prints the question. Classic keeps its look, but switching tabs and choosing cards change in both appearances: a tab key (pressed again too) puts the selection and keyboard focus on that tab's first card, ↓ then moves one card from there, and `0` reopens the panel on 待回覆 with the band's question selected.
- 修正 refined 窄版分頁列：不足 46 欄時僅縮短未選分頁為快捷鍵與計數，所選分頁保留完整名稱與計數，底線同步對齊；維持單行以防計數覆畫首卡標頭。46 欄以上維持完整標籤；classic 沒有這條分頁底線，分頁列照舊。回歸測試直接檢查隔離 tmux 中的真實終端畫面，不再以元件樹模擬裁切。

## 1.1.0

- Focus pane cards keep only one line for the question: grey, never bold even when chosen, cut with `…` when too long, and no options. The repo / ticket line at the bottom is a darker grey.
- A pushed session that stops and waits on you stays in 待回覆 instead of dropping off the band, the pane and the board list. The stage 已 push is renamed 已推送.
- `console.mjs prune` lists merged branches and worktrees, and deletes them only with `--apply`.
- Handoff: a session is told its context usage once each time it crosses 30/50/70% (off until `context-notice.mjs enable`).

## 1.0.0

- First standalone release. worktree-console, the handoff skill, the auto-handoff, console-log and focus band hooks, and the focus-show mod moved here from agent-skills.
- The console reads a prompt file when it loads: the near-empty built-in `references/prompt.md`, or your own `~/.config/worktree-console/prompt.md`. Its `## 中控台` section holds extra console rules.
- Kickoff interview: when your prompt has a `## 需求訪談` section, every ticket starts with an interview (goal, acceptance criteria, non-goals) before any coding, then the goal goes to a fresh session. No other plugin is needed. `templates/prompt.md` is a ready-to-copy example; the README lists the format the console relies on.
- herdr: new tabs go to the workspace named after the repo (lowest number when several share the name), or a new one; `console.mjs move` moves a stopped session to another workspace and keeps its conversation and ticket.
- Branch naming rules now ship inside the plugin (`references/branch-naming.md`).
