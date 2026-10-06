# Agent Instructions

`AGENTS.md` is the canonical source of repository agent instructions; `CLAUDE.md` only imports it.

## Tests

- Inside a herdr tab, always run tests as
  `env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID npm test`.
  Otherwise the handoff tests (and others that open tabs) open real tabs in
  your herdr session.
- The focus band and `/focus-show` mod tests (`*.test.tsx`) run with
  `claude plugin test .` and `claude plugin test mods/focus-show`.

## Versioning

- Bump `version` in `.claude-plugin/plugin.json` (SemVer) when publishing
  changes, in its own `chore:` commit together with a new `## <version>`
  section at the top of `CHANGELOG.md`.
- `mods/focus-show` is a separate plugin with its own `version` in
  `mods/focus-show/.claude-plugin/plugin.json`. Bump it whenever anything
  under `mods/focus-show` changes; `npm test` fails otherwise.

## Language

Skill bodies, references, script output and test strings are Traditional
Chinese. Keep them that way; code identifiers, comments and commit messages
are English.
