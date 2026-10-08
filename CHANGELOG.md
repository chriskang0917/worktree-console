# Changelog

## Unreleased

- The focus panel now defaults to a refined appearance with compact status icons, terminal-native neutral colors, responsive stage labels, and optional animation. Configure `appearance`, `theme: neutral`, and `motion` in `config.json`; choose `appearance: classic` to keep the original look and shortcuts.
- Fixed refined focus-band hidden queue counts and question-height budgeting; narrow card headers no longer reserve unused trailing spaces.
- Corrected narrow-card header regression fixtures and drawn-tree lookup so both normal and archived cards are checked for complete names and full-row width at 46 and 36 columns.
- Only the primary question alternates ◆/◇ every 900ms. Every visible authorization ◆ breathes together (1.2 seconds blocked, 0.6 seconds dim), while its label and focus-band rail retain the blocked color. Rendering updates only when the visible animation frame changes; working sessions and errors remain static.
- Refined cards show stage values after the repo in the bottom row at every width, without a repeated label or the 59/60-column layout switch. Names can use 62 columns in an 80-column panel; classic appearance is unchanged.
- Fixed refined tab labels wrapping out of their row in narrow panels: the trailing idle count could paint a stray digit over the first card header. Tab painting is now clipped to one row; card names and headers are unchanged.

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
