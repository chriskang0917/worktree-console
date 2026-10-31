[English](./README.en.md)｜[中文](./README.md)

> **Language note:** the skills, their prompts and everything the console prints are in Traditional Chinese (zh-TW). This is the English README; the Traditional Chinese one is [README.md](./README.md).

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

worktree-console is a Claude Code plugin. You open it in one tab of [Orca](https://github.com/stablyai/orca), [herdr](https://github.com/herdrdev/herdr) or the Herdr app (herdr's desktop app), and that session becomes the console for every worktree and Claude Code session across all your repos.

- **Hand it a ticket, get a running session.** Give it a Linear ticket (or just a task). It reads the ticket, finds the parent ticket, proposes a repo and branch name, and after you confirm it creates the worktree and starts a Claude Code session there.
- **Sessions report back by themselves.** A watcher follows every session. When one stops to ask something, finishes, or needs a permission, the console tells you which ticket it is and what it wants.
- **Focus mode: one question at a time, answered with one key.** A band above your input box always shows the current question with its options. Answer `b` and the console sends what that session expects (`B`, `2`, or the right menu item). Other questions wait in a queue (`1`–`5` to jump, `8` to put one off, `9` to print the question again, `0` for a side panel with every session as a card, under the tabs 待回覆, 全部 and 封存). Full reports print straight into the chat without spending tokens. Focus mode needs a Claude Code build with mods (plugin function hooks), plus the separate `focus-show` plugin from this marketplace.
- **Reach the console from your phone.** When the console starts, it turns on Remote Control for its own session (only that one, never the sessions it opens), so the console shows up in the Claude app's Remote Control list. A console that took over through an automatic handoff turns it on again.
- **Every session has a name.** Each session the console opens starts with `claude --name <name>`, and in herdr every tab it opens is named too (the console's own tab is `console`). You can name a session when you open it and rename it later; the name then replaces the ticket on the board.
- **One board for everything.** `現在狀況` prints a table per repo: status, ticket, summary, stage (not started, planning, implementing, pushed) and the latest activity, so you can see where every session is.
- **Direct, close and archive from one place.** Send instructions to any session by ticket, close a worktree when its branch is merged, or archive sessions you want out of sight.
- **Automatic handoff.** When a session's context fills past a threshold, or its prompt cache is about to expire while you are away, it writes a handoff note and a fresh session takes over in a new tab. `/worktree-console:handoff` does it on demand.
- **Context usage notices (off by default).** Turn it on and a session that crosses 30%, 50% or 70% of its real context window is told so, once per band, so a background or headless session can wrap up before the window fills. `node hooks/context-notice.mjs enable`, and `bands 20,40,60` to change the bands.
- **A log of how you work.** Every console and session event is recorded under `~/.worktree-console/`, so you can look back at what was started, asked and answered.
- **Tool calls in one line (optional).** The separate `tool-dots` mod folds a run of tool calls into one line of coloured dots and counts; ctrl+o still shows everything. See [Install tool-dots](#install-tool-dots-optional).
- **Make it yours.** On startup the console reads a prompt file you can replace with your own, to add console rules or to have every session interview you before it codes. See [Customizing the console prompt](#customizing-the-console-prompt).

## Install

Requirements:

- [Orca](https://github.com/stablyai/orca), [herdr](https://github.com/herdrdev/herdr) or the Herdr app. The console only runs inside one of their tabs.
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

Open Claude Code in an Orca, herdr or Herdr app tab inside one of your repos, then:

| Say | What happens |
| --- | --- |
| `/worktree-console:worktree-console` or `開中控台` | Starts the console: board, archived sessions, watcher |
| `<ticket>`, e.g. `PROJ-123` | Aligns on the ticket, then starts a worktree and session after you confirm |
| `現在狀況` | Prints the board |
| `<ticket> 詳情` | Shows what that session has been doing |
| `b`, or any reply | Answers the question currently on the focus band |
| `問：<question>` | Opens a temporary worktree in the repo the console was started in and asks the question there (herdr and Orca) |
| `問 <repo>：<question>` | Same, in the named repo |
| `<ticket>，名稱 <name>` or `問：<question>，名稱 <name>` | Gives the new session a name while opening it (see [Session names](#session-names)) |
| `<tag> 改名 <name>` | Renames a session: board, focus band, herdr tab and Claude Code session name all change |
| `關掉 <ticket>` | Checks the worktree is safe to remove, then closes it |
| `清理 branch` or `prune` | Lists local branches and worktrees as CANDIDATE or KEEP (merged or squash-merged, with the reason); deletes only after you confirm |
| `/worktree-console:handoff` | Hands the current session over to a fresh one |

State lives in `~/.config/worktree-console/` (console registry, focus state, archive, settings and your own `prompt.md`), `~/.config/claude-handoff/` (handoff settings and notes) and `~/.worktree-console/` (the activity log). The Linear token, when used, is kept in the macOS keychain under `worktree-console-linear`.

Each time a child session the console manages stops, a background `claude -p --model sonnet` call recaps that turn's reply in a few plain sentences: the child tab shows the recap above its prompt (press `0` on an empty prompt for the full text), and Enter on a card in the console panel opens that session's recap. Set `"summaryModel": "haiku"` in `config.json` to change the model. Every call's tokens and `total_cost_usd` go to `~/.config/worktree-console/summary-usage.jsonl`.

## Session names

Every session the console opens is started with `claude --name <name>`: kickoff, temporary sessions, extra tabs, reopened and moved sessions, the interview handoff and automatic handoffs. Without a name of your own, the name is the session's tag (ticket, nickname or branch). In Orca, a session started by `orca worktree create` gets its name through `/rename` once it first stops. In herdr, every tab the console opens has a name instead of a number (the first tab of a new workspace included), the console's own tab is `console`, and the watcher names any numbered tab running Claude Code after its session: your name, else the ticket, else the branch or folder. Tabs that already have a name are left alone.

- **Give a name when opening.** Add `名稱 <name>` to the request, e.g. `PROJ-123，名稱 login-fix` or `問：README 在講什麼？名稱 docs`. Without one, the console picks a nickname as before.
- **Rename later.** `<tag> 改名 <name>` (e.g. `PROJ-123 改名 login-fix`) changes the board, the focus band, the reply list, the herdr tab and the Claude Code session name. A session that is still running gets `/rename` as soon as it stops; the watcher sends it.
- **Format.** Lowercase letters, digits and `-`, 2 to 20 characters. A name must not repeat another session's name or tag (tickets included) or a repo name, because you also type it to direct the session. Anything else (capitals, Chinese, spaces, 21 characters) is refused with the reason.
- **Where it shows.** A named session shows its name instead of the ticket on the board, the focus band, the reply list and reports; `<name> 詳情` still lists the ticket. Typing the name or the old ticket both reach it.

## Herdr app mode

The console picks its tool from the environment: `HERDR_ENV=1` means herdr, otherwise `HC_TERMINAL_ID` means the Herdr app, otherwise `ORCA_TERMINAL_HANDLE` means Orca. herdr started inside a Herdr app terminal still counts as herdr. Kickoff, the board, details, commands, answering, handoff, moving and closing all work as in herdr. What differs:

- **Worktrees** always go to `~/.herdr/worktrees/<repo>/<branch>`, where the Herdr app's own New worktree puts them; a `/` in the branch becomes `-`.
- **Tabs** open in the space named after the repo (one is made if there is none). The Herdr app switches to a tab it opens, so the console switches you back to the tab you were on.
- **Text** goes through herdr-core's `hc send`; an auto-reply countdown posts no system notification and only counts down on the focus band.
- **Side board**: the first time the console reads statuses in the Herdr app, it copies the board mod to `~/.config/herdr-app/mods/worktree-board/`, and the Herdr app docks it on the right (240 wide). Each row shows only the status icon, the tag and how long it has waited; sessions waiting on you (💬, 🔐, ⚠️) are on top, and clicking a row switches to that session's tab. The board only reads the state file the console writes; once that file is more than 2 minutes old, the top says 「中控台未在執行，資料停在 HH:MM」 (the console isn't running, data as of HH:MM) and the rows turn grey.

## Install task-list (optional)

`task-list` is a separate plugin for local task lists: create tasks, track items, submit and review evidence, and view a text graph with a committed-event timeline.

```text
/plugin install task-list@worktree-console
```

It needs Node.js, macOS or Linux, and `ps` supporting `ps -p <pid> -o lstart=`; if the process identity cannot be checked, writes stop safely. Explicit `task close` previews the evidence it would archive; `--yes` applies only after outstanding work and unread reports are resolved and the preview revision and evidence checksum still match. See the [task-list README](./plugins/task-list/README.en.md) for commands, storage, evidence and acceptance. Disable or uninstall it with `claude plugin`; task data is kept.

## Install tool-dots (optional)

`tool-dots` is a separate mod that folds a run of tool calls in the conversation into one line: one dot per call (yellow while running, green when done; a failed, denied or interrupted call is a red `✕`, placed after the dots), then each tool and its count in the order they first ran, and the number of failures when there are any:

```text
●●●●✕ tool_call: Bash ×3 · Read ×2 - 1 error
```

Reply text or a message from you starts a new line. Past 24 calls the dots stop and a dim `+N` follows. MCP tools show as `server:tool`. While folded, the tools' result blocks are hidden; ctrl+o (or `--verbose`) shows every call and its result as usual. It needs a Claude Code build with mods.

```text
/plugin install tool-dots@worktree-console
```

## Customizing the console prompt

Every time the console starts, it reads one prompt file in full and follows it. The built-in one is nearly empty. To use your own:

1. Copy it to `~/.config/worktree-console/prompt.md` (under `$WORKTREE_CONSOLE_HOME` if you set it). Start from [`templates/prompt.md`](./templates/prompt.md) if you want the interview, or from `skills/worktree-console/references/prompt.md` if you don't.
2. Edit it. When this file exists the console reads only it, never the built-in one, and plugin updates never touch it.
3. Restart the console. `node <plugin>/skills/worktree-console/scripts/console.mjs prompt` prints which file is in use, whether it is yours, and whether it has an interview section.

The file has up to two sections, by heading:

- `## 中控台`: extra rules for the console itself, in plain language.
- `## 需求訪談` (the interview): if this section exists, every ticket starts with an interview before any coding; without it, sessions start coding right away. You can still say "interview this one" or "skip the interview" for a single ticket while aligning.

During an interview the new session reads your `## 需求訪談` section, asks you questions until the goal is settled, writes a goal file, and stops (the template answers every question itself first, with sources, and shows them to you as one batch sheet). The console relays each question to you, then hands the goal to a fresh session to build it. Whatever you write in the section, keep these, or the console loses track:

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
- **Batch sheet.** When the question title has 批改單 (`**第 N 題：批改單這樣定稿嗎？**`), list its questions one per line as `1.`, `2.`, `3.` and mark the red ones 🔴: the band shows `批改單 N 題（🔴 M 題要你看）` and `9` prints the whole sheet into the chat; the advisor only suggests an answer for it, never counts down, auto-replies or moves it to 待決.

`templates/prompt.md` is a complete working example: what to ask about, how to write testable acceptance criteria, and the goal file layout.

## Look and feel

The focus panel and band have one look: compact status icons and a matching focus band. Each status has its own colour (工作中 green, 待回答 yellow, 待授權 bright magenta, 已回覆 bright cyan, 異常 bright red, 閒置 grey). The stage is a quiet grey tag at the right of the card header from 46 columns up, and the first item of the bottom row below that; 未開工 is not shown. The focus band's header shows the status and the name on the left and `9: 顯示問題 · 8: 延後處理` in the theme's dim colour on the right (only `9: 顯示問題` while the queue is empty); when the band is narrow the name is cut with `…` first. The name is not focusable or clickable; use `9` to show the question. A tab key (`q`, `w`, `e`; pressed again too) puts the selection and keyboard focus on that tab's first card, ↓ then moves one card from there, and `0` opens the panel on 待回覆 with the band's question selected; the other shortcuts and session data are unchanged. The panel's 全部 tab lists every session that is not archived, idle ones included (their cards still say 閒置); archived sessions show only under 封存.

Add these keys to your existing `~/.config/worktree-console/config.json` (or `$WORKTREE_CONSOLE_HOME/config.json`); keep any other settings:

```json
{
  "theme": "neutral",
  "motion": true
}
```

- **theme:** `neutral` (default, uses terminal colors), `neutral-light`, `dracula`, `gruvbox`, or `light`. `neutral` leaves foreground text in your terminal's default color.
- **motion:** `true` (default) alternates ◆/◇ every 900ms only for the primary question. The current item takes priority, otherwise the first queued question or authorization request does. Every visible authorization ◆ breathes in sync: 1.2 seconds in the blocked color, then 0.6 seconds dim; the label and focus-band rail keep the blocked color. Working sessions and errors stay still. `false` keeps all icons at their initial frame and disables the animation timer.

### Repo abbreviations

When the same ticket runs in several repos, the board puts a short form of the repo after the ticket: `SARA-7063-fe` and `SARA-7063-be` for `sara-v2-frontend` and `sara-v2-backend`. By default the words every one of those repo names starts with are dropped and `frontend` / `backend` become `fe` / `be`; a repo name with neither keeps what is left (`acme-billing` next to `acme-admin-portal` gives `billing`). Set your own short forms with `repoAbbreviations`:

```json
{
  "repoAbbreviations": {
    "sara-v2-frontend": "web",
    "sara-v2-backend": "api"
  }
}
```

If two short forms would still be the same, the board uses the full repo names instead (`SARA-7063-sara-v2-frontend`), so two sessions never share a tag. The console reads this key every time it lists sessions; no restart needed.

Settings load when the session starts and each time the panel opens, so reopen the panel to apply edits. Only the console's own tab reads the file. Missing settings use the defaults; an unknown value falls back to its default with one toast per distinct invalid value in the session, and a file that is not valid JSON falls back to all defaults with one toast.

The panel calls running sessions **工作中**, questions **待回答**, authorization requests **待授權**, and answered sessions **已回覆**. These are display labels only; the conversation board retains its original status wording. The host controls button typography and hotkey colors; clickable names and keys retain its native styling.

### Themes

Set `theme` in `config.json` to `neutral`, `neutral-light`, `dracula`, `gruvbox`, or `light`, then reopen the panel. `neutral` keeps terminal-native foreground colors and follows Claude Code's panel background. Named themes paint their own panel background: `dracula` — `#282a36`, `gruvbox` — `#282828`, `light` — `#fdf6e3`, `neutral-light` — `#f7f7f5`. Theme changes affect only colors, not session data, layout, or shortcuts.

The outer panel background covers text, card spacing, and unused rows; inner text rows do not need separate backgrounds. Ink's border cells do not inherit that background. Claude Code's own frame, close row, and tab row remain in its theme colors. The focus band and the rest of the terminal retain their existing backgrounds; pair light palettes with a light Claude Code theme for those surfaces. Both light palettes keep dim text contrast at least 4.5:1 on their panel backgrounds. Every named theme's card borders keep at least 3:1 contrast on its panel background.

Every palette keeps authorization labels in its blocked color while the ◆ glyph breathes between blocked and dim. Invalid theme names fall back to `neutral` with one toast per distinct invalid value in the session.

## Development

```sh
git clone https://github.com/chriskang0917/worktree-console.git
cd worktree-console
npm test
```

Run tests inside a herdr tab as `env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID npm test`; inside a Herdr app tab plain `npm test` never reaches the real Herdr app, because the tests drop every `HC_` variable first. After changing the board mod, run `herdr-app check herdr-app/mods/worktree-board`. The focus band, `focus-show` and `tool-dots` tests run with `claude plugin test .`, `claude plugin test mods/focus-show` and `claude plugin test mods/tool-dots`.

The real-terminal regression tests also need `tmux` and a `claude` build with mods. Run them alone with `node --test test/worktree-console-focus-terminal.test.mjs`; they use a temporary HOME, fake data and their own tmux socket, and never read your console state. Without `tmux` they are skipped locally with the reason; on CI (with the `CI` environment variable set) a missing `tmux` fails them. CI runs from `.github/workflows/ci.yml`: it installs a pinned `@anthropic-ai/claude-code` and `tmux`, then runs `npm test`, `claude plugin test .`, `claude plugin test mods/focus-show` and `claude plugin test mods/tool-dots`.

Plugin versions are bumped by CI on each pull request. The `version` job finds which plugins the PR changes (`mods/focus-show`, `mods/tool-dots`, `plugins/task-list`, or everything else for `worktree-console`), bumps each from the version currently on `main` (`feat` → minor, anything else → patch, a `!` in the PR title → major), adds a `CHANGELOG.md` section with the PR title, and pushes a `chore: bump plugin versions` commit to the PR branch. It always recomputes from `main`, so pushing more commits keeps the same version, and if another PR merges first the next run moves to the following number. Notes you write in that changelog section yourself are kept; only the version heading changes. For a PR from a fork CI cannot push, so it checks instead and fails with the version each plugin should have. The script is `.github/scripts/plugin-versions.mjs`.

To try a local checkout without replacing your installed copy:

```sh
claude --plugin-dir . --plugin-dir ./mods/focus-show --plugin-dir ./mods/tool-dots
```

Layout:

- `skills/worktree-console/`: the console skill, its references and scripts
- `skills/handoff/`: the handoff skill
- `hooks/`: the focus band mod, the auto-handoff hook and the console log hook
- `mods/focus-show/`: the `/focus-show` command, a separate plugin
- `mods/tool-dots/`: the tool-call folding mod, a separate plugin
- `test/`: Node test runner tests and fixtures

See [AGENTS.md](./AGENTS.md) for versioning rules.
