> **Language note:** the skills, their prompts and everything the console prints are in Traditional Chinese (zh-TW). This README is in English; translation is planned.

<h1 align="center">worktree-console</h1>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#customizing-the-console-prompt">Customizing</a> ·
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
- **Make it yours.** On startup the console reads a prompt file you can replace with your own, to add console rules or to have every session interview you before it codes. See [Customizing the console prompt](#customizing-the-console-prompt).

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

## Customizing the console prompt

Every time the console starts, it reads one prompt file in full and follows it. The built-in one is nearly empty. To use your own:

1. Copy it to `~/.config/worktree-console/prompt.md` (under `$WORKTREE_CONSOLE_HOME` if you set it). Start from [`templates/prompt.md`](./templates/prompt.md) if you want the interview, or from `skills/worktree-console/references/prompt.md` if you don't.
2. Edit it. When this file exists the console reads only it, never the built-in one, and plugin updates never touch it.
3. Restart the console. `node <plugin>/skills/worktree-console/scripts/console.mjs prompt` prints which file is in use, whether it is yours, and whether it has an interview section.

The file has up to two sections, by heading:

- `## 中控台`: extra rules for the console itself, in plain language.
- `## 需求訪談` (the interview): if this section exists, every ticket starts with an interview before any coding; without it, sessions start coding right away. You can still say "interview this one" or "skip the interview" for a single ticket while aligning.

During an interview the new session reads your `## 需求訪談` section, asks you questions until the goal is settled, writes a goal file, and stops. The console relays each question to you, then hands the goal to a fresh session to build it. Whatever you write in the section, keep these, or the console loses track:

- **Question format.** Ask one question at a time, in plain text (no menus), in this shape. The focus band reads the options from it, and an answer like `b` is sent back by letter.

  ```text
  **第 N 題：<question>？**

  <optional background>

  - **a.** <option>: <explanation>
  - **b.** <option>: <explanation>

  建議：<letter>, <reason>
  ```

  Options use lowercase `a`, `b`, `c`. Put nothing after the options except the `建議：` (recommendation) line.
- **Goal file.** Write it to `.goals/<slug>.md` in the main checkout, using the slug the first message gives. The handoff turns its `**驗收準則**` (acceptance criteria) list into the checks the building session must show, skipping items marked 🔧 (no test yet) or ⚠️ (needs a human), and fills in the `**實作方案**` (approach) line.
- **Finish line.** When the goal is settled, reply with only `定稿完成：<absolute path of the goal file>` and wait. The console takes it from there.

`templates/prompt.md` is a complete working example: what to ask about, how to write testable acceptance criteria, and the goal file layout.

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
