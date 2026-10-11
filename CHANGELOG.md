# Changelog

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
