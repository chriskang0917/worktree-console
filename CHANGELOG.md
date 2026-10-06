# Changelog

## 1.0.0

- First standalone release. worktree-console, the handoff skill, the auto-handoff, console-log and focus band hooks, and the focus-show mod moved here from agent-skills.
- Kickoff can start with a built-in interview (goal, acceptance criteria, non-goals) before any coding, then hand the goal to a fresh session. It does not depend on any other plugin. Whether it runs by default is asked once and kept as `interview` in `~/.config/worktree-console/config.json`; say `需求訪談預設開／關` to change it, or override a single ticket while aligning.
- The console reads a prompt file when it loads (`references/prompt.md`, or your own `~/.config/worktree-console/prompt.md`), which holds extra console rules and the interview rules.
- Branch naming rules now ship inside the plugin (`references/branch-naming.md`).
