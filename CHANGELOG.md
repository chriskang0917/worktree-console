# Changelog

## 1.0.0

- First standalone release. worktree-console, the handoff skill, the auto-handoff, console-log and focus band hooks, and the focus-show mod moved here from agent-skills.
- The console reads a prompt file when it loads: the near-empty built-in `references/prompt.md`, or your own `~/.config/worktree-console/prompt.md`. Its `## 中控台` section holds extra console rules.
- Kickoff interview: when your prompt has a `## 需求訪談` section, every ticket starts with an interview (goal, acceptance criteria, non-goals) before any coding, then the goal goes to a fresh session. No other plugin is needed. `templates/prompt.md` is a ready-to-copy example; the README lists the format the console relies on.
- herdr: new tabs go to the workspace named after the repo (lowest number when several share the name), or a new one; `console.mjs move` moves a stopped session to another workspace and keeps its conversation and ticket.
- Branch naming rules now ship inside the plugin (`references/branch-naming.md`).
