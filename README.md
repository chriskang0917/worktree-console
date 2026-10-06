> **Language note:** the skills, their prompts and everything the console prints are in Traditional Chinese (zh-TW). This README is in English; translation is planned.

<h1 align="center">worktree-console</h1>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#development">Development</a> ·
  <a href="./CHANGELOG.md">Changelog</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

<p align="center"><b>Run a dozen Claude Code sessions from one: a console that starts them, watches them, and brings every question to you.</b></p>

worktree-console is a Claude Code plugin. You open it in one tab of [Orca](https://github.com/stablyai/orca) or [herdr](https://github.com/herdrdev/herdr), and that session becomes the console for every worktree and Claude Code session across all your repos.

- **Hand it a ticket, get a running session.** Give it a Linear ticket (or just a task). It reads the ticket, finds the parent ticket, proposes a repo and branch name, and after you confirm it creates the worktree and starts a Claude Code session there.
- **Sessions report back by themselves.** A watcher follows every session. When one stops to ask something, finishes, or needs a permission, the console tells you which ticket it is and what it wants.
- **Focus mode: one question at a time, answered with one key.** A band above your input box always shows the current question with its options. Answer `b` and the console sends what that session expects (`B`, `2`, or the right menu item). Other questions wait in a queue (`1`–`5` to jump, `8` to put one off, `0` for a side panel with every session as a card). Full reports print straight into the chat without spending tokens. Focus mode needs a Claude Code build with mods (plugin function hooks), plus the separate `focus-show` plugin from this marketplace.
- **One board for everything.** `現在狀況` prints a table per repo: status, ticket, summary, stage (not started, planning, implementing, pushed) and the latest activity, so you can see where every session is.
- **Direct, close and archive from one place.** Send instructions to any session by ticket, close a worktree when its branch is merged, or archive sessions you want out of sight.
- **Automatic handoff.** When a session's context fills past a threshold, or its prompt cache is about to expire while you are away, it writes a handoff note and a fresh session takes over in a new tab. `/worktree-console:handoff` does it on demand.
- **A log of how you work.** Every console and session event is recorded under `~/.worktree-console/`, so you can look back at what was started, asked and answered.
- **Ask first, then build.** Before a session starts coding, it can interview you one question at a time until the goal and acceptance criteria are written down, then the console hands that goal to a fresh session to execute. You decide once whether kickoff does this by default.
- **Make it yours.** On startup the console reads a prompt file. Copy it to `~/.config/worktree-console/prompt.md` and edit it to add your own console rules or change how the interview asks questions; plugin updates never overwrite your copy.

## Install

Requirements:

- [Orca](https://github.com/stablyai/orca) or [herdr](https://github.com/herdrdev/herdr). The console only runs inside one of their tabs.
- [Node.js](https://nodejs.org/) 20 or later.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Focus mode also needs a build with mods.
- Optional: Linear access through Orca (`orca linear …`) for ticket kickoff.

In Claude Code:

```text
/plugin marketplace add chriskang0917/worktree-console
/plugin install worktree-console@worktree-console
/plugin install focus-show@worktree-console
```

`focus-show` is only needed for focus mode.

## Usage

Open Claude Code in an Orca or herdr tab inside one of your repos, then:

| Say | What happens |
| --- | --- |
| `/worktree-console:worktree-console` or `開中控台` | Starts the console: board, archived sessions, watcher |
| `<ticket>`, e.g. `PROJ-123` | Aligns on the ticket, then starts a worktree and session after you confirm |
| `現在狀況` | Prints the board |
| `<ticket> 詳情` | Shows what that session has been doing |
| `b`, or any reply | Answers the question currently on the focus band |
| `關掉 <ticket>` | Checks the worktree is safe to remove, then closes it |
| `/worktree-console:handoff` | Hands the current session over to a fresh one |

State lives in `~/.config/worktree-console/` (console registry, focus state, archive, settings and your own `prompt.md`), `~/.config/claude-handoff/` (handoff settings and notes) and `~/.worktree-console/` (the activity log). The Linear token, when used, is kept in the macOS keychain under `worktree-console-linear`.

## Development

```sh
git clone https://github.com/chriskang0917/worktree-console.git
cd worktree-console
npm test
```

Run tests inside a herdr tab as `env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID npm test`. The focus band and `focus-show` tests run with `claude plugin test .` and `claude plugin test mods/focus-show`.

To try a local checkout without replacing your installed copy:

```sh
claude --plugin-dir . --plugin-dir ./mods/focus-show
```

Layout:

- `skills/worktree-console/`: the console skill, its references and scripts
- `skills/handoff/`: the handoff skill
- `hooks/`: the focus band mod, the auto-handoff hook and the console log hook
- `mods/focus-show/`: the `/focus-show` command, a separate plugin
- `test/`: Node test runner tests and fixtures

See [AGENTS.md](./AGENTS.md) for versioning rules.
