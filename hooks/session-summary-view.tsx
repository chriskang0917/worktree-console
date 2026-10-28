import type { EngineInterface, On } from 'claude-code'
import { loadAppearance, THEMES, type Appearance } from './console-theme.ts'
import { columns, truncateColumns } from './status-view.ts'

const POLL_MS = 3_000
const PANE = 'worktree-console-summary'
const PANE_TITLE = '摘要'
const LABEL = '摘要'
// The label and the gap after it; wrapped lines start under the text, not under the label.
const PREFIX = 6
const MAX_LINES = 4
const PENDING = '產生中…'
const EMPTY = '還沒有摘要'
const TIMEOUT_MS = 120_000
const PENDING_SLACK_MS = 60_000

type Saved = { text: string | null; pending: boolean }

let saved: Saved = { text: null, pending: false }
let home = ''
let handle = ''
let appearance: Appearance = { theme: 'neutral', motion: true }

async function readJson($: EngineInterface, file: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(file))
  } catch {
    return null
  }
}

// The worker's files for this tab (scripts/summary.mjs): a recap only counts for the session now in the tab.
async function poll($: EngineInterface) {
  const name = encodeURIComponent(handle)
  const [summary, marker, id, now] = await Promise.all([
    readJson($, `${home}/summaries/${name}.json`),
    readJson($, `${home}/summaries/${name}.pending.json`),
    $.session.id().catch(() => ''),
    $.clock.now(),
  ])
  const mine = (x: any) => !!x && (!x.sessionId || !id || x.sessionId === id)
  const next: Saved = {
    text: mine(summary) && typeof summary.text === 'string' && summary.text.trim() ? summary.text.trim() : null,
    pending: mine(marker) && now - (marker.since ?? 0) < (marker.timeoutMs ?? TIMEOUT_MS) + PENDING_SLACK_MS,
  }
  if (next.text === saved.text && next.pending === saved.pending) return
  saved = next
  $.ui.invalidate('ui.render')
}

// Wraps by display columns, keeping the reply's own line breaks.
export function wrapColumns(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let line = ''
    let used = 0
    for (const c of para) {
      const size = columns(c)
      if (used + size > width && line) {
        out.push(line)
        line = ''
        used = 0
      }
      line += c
      used += size
    }
    if (line.trim()) out.push(line)
  }
  return out
}

// At most `max` lines; a cut ends its last line with …
export function summaryLines(text: string, width: number, max = MAX_LINES): string[] {
  const lines = wrapColumns(text, Math.max(1, width))
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  const last = kept[max - 1]!.trimEnd()
  kept[max - 1] = columns(last) < width ? `${last}…` : truncateColumns(`${last}…`, width)
  return kept
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
}

// Called from the focus module's session.start: in an Orca or herdr tab, watch this tab's recap files.
export async function startSummary($: EngineInterface) {
  const herdr = (await $.env.get('HERDR_ENV')) === '1'
  handle = (herdr ? await $.env.get('HERDR_PANE_ID') : await $.env.get('ORCA_TERMINAL_HANDLE')) ?? ''
  if (!handle) return
  home = (await $.env.get('WORKTREE_CONSOLE_HOME')) || `${await $.env.get('HOME')}/.config/worktree-console`
  let config = '{}'
  try { config = await $.fs.read(`${home}/config.json`) } catch {}
  appearance = loadAppearance(config, [])
  await poll($)
  $.clock.every(POLL_MS, () => void poll($))
}

export function refreshSummary($: EngineInterface) {
  if (handle) void poll($)
}

// A child session's tab: its newest plain-language recap above the prompt once a turn ends; null when there is none to show.
export function summaryBand($: EngineInterface, e: any) {
  if (!handle || e.props.hasSurvey || e.props.isWorking || (!saved.text && !saved.pending)) return null
  const { Box, Text, Button } = $.ui.resolve(e)
  const theme = THEMES[appearance.theme]
  const width = Math.max(1, e.props.bodyColumns - PREFIX)
  const lines = saved.pending ? [PENDING] : summaryLines(saved.text!, width, Math.max(1, Math.min(MAX_LINES, e.props.maxRows - 2)))
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => (
        <Box key={`summary:${i}`} flexDirection="row" height={1} flexShrink={0}>
          <Box key={`summary-label:${i}`} width={PREFIX} flexShrink={0}>{i === 0 ? <Text color={theme.accent} bold>{LABEL}</Text> : <Text> </Text>}</Box>
          <Text color={saved.pending ? theme.dim : theme.fg} wrap="truncate-end">{line}</Text>
        </Box>
      ))}
      {!saved.pending && (
        <Box key="summary-keys" flexDirection="row" paddingLeft={PREFIX} height={1} flexShrink={0}>
          <Button key="summary-full" hotkey="0" label="完整摘要" plain dimColor onPress={() => void openPane($)} />
        </Box>
      )}
    </Box>
  )
}

// The whole recap, uncut, in the side pane 0 opens.
export function registerSummaryView(on: On) {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const theme = THEMES[appearance.theme]
    return (
      <Box flexDirection="column" {...('bg' in theme ? { backgroundColor: theme.bg } : {})}>
        <Box key="summary-text">{saved.text ? <Text color={theme.fg} wrap="wrap">{saved.text}</Text> : <Text color={theme.dim}>{EMPTY}</Text>}</Box>
        {saved.pending && <Box key="summary-pending"><Text color={theme.dim}>{`新的摘要${PENDING}`}</Text></Box>}
      </Box>
    )
  })
}
