# Changelog

## 1.0.0

- First standalone release. worktree-console, the handoff skill, the auto-handoff, console-log and focus band hooks, and the focus-show mod moved here from agent-skills.
- define-goal is optional: when it is not installed, kickoff never mentions it; when it is, the console reads its handoff rules (`references/handoff.md`) from where it is actually installed.
- Whether kickoff runs define-goal first is asked once and kept as `defineGoal` in `~/.config/worktree-console/config.json`; say `define-goal 預設開／關` to change it, or override a single ticket while aligning.
- Branch naming rules now ship inside the plugin (`references/branch-naming.md`).
