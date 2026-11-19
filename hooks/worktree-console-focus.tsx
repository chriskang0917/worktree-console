import type { EngineInterface, Register } from 'claude-code'
import { loadAppearance, THEMES, type Appearance, type ConsoleTheme } from './console-theme.ts'
import { statusCell, columns, truncateColumns, wrapColumns, wrapRanges } from './status-view.ts'
import { registerKeepaliveView } from './keepalive-view.tsx'
import { DIGEST_RULE } from './digest.mjs'
import { SUMMARY_MAX_LINES, bandDigestRows, digestRows, parseDigest, summaryLines, type DigestPart } from './session-summary-view.tsx'

// --- The review-sheet screen's rows, as plain data the pane draws. ---
type ReviewAsk = { q: string; a: string; example?: string | null; at?: number }
type ReviewItem = {
  n: number
  kind?: string
  question: string
  plan: string
  basis: string
  precedent: boolean
  impact: string
  status: 'pending' | 'passed' | 'edited' | 'elsewhere'
  edit: string | null
  asks: ReviewAsk[]
  example: string | null
  by?: string
}
type ReviewSheet = { tag: string; path: string; repo: string; branch: string; pr: string | null; fresh: ReviewItem[]; past: ReviewItem[]; problems?: string[] }

// `input`: the field open under an item; `asking`: questions still waiting on `review ask`, '' for an example.
// `draft`: what the open field holds so far, so the field grows with it; `undo`: items settled in this sitting, newest last.
type SheetView = { sel: number | null; input: { n: number; mode: 'edit' | 'ask' } | null; draft: string; expanded: Set<number>; asking: Map<number, string>; undo: number[] }

type Paint = 'fg' | 'item' | 'title' | 'section' | 'label' | 'dim' | 'edited' | 'busy'
type Seg = { text: string; paint: Paint }
type SheetLine =
  | { kind: 'text'; key: string; segs: Seg[]; right?: Seg[]; n?: number }
  | { kind: 'item'; key: string; n: number; done: boolean; segs: Seg[]; right?: Seg[] }
  | { kind: 'input'; key: string; n: number; mode: 'edit' | 'ask'; rows: number }
  // The rows an input taller than one row covers, so the window counts them; they draw nothing.
  | { kind: 'pad'; key: string; n: number }

const FRESH_TITLE = '先看：沒有前例'
const PAST_TITLE = '照你過去的回答'
const EDIT_LABEL = '改成'
const ASK_LABEL = '問'
const ASK_HINT = '空白直接按 Enter＝要一個實際範例'
const EXAMPLE_ASK = '（要範例）'
// The selection mark's column, then the indent of an item's field rows.
const MARK_COLS = 3
const INDENT = 3
// The widest label (影響範圍), then a two-column gap.
const LABEL_COLS = 8
const LABEL_GAP = 2

const seg = (text: string, paint: Paint): Seg => ({ text, paint })
const flat = (text: string) => String(text ?? '').replace(/\s+/g, ' ').trim()
// A model's answer may come with Markdown emphasis; the pane shows the words without the marks.
const unmark = (text: string) => String(text ?? '').replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => a ?? b)
const pad = (text: string, width: number) => `${text}${' '.repeat(Math.max(0, width - columns(text)))}`

const sheetItems = (s: ReviewSheet) => [...s.fresh, ...s.past]
const itemOf = (s: ReviewSheet, n: number | null) => sheetItems(s).find(x => x.n === n) ?? null
const isPast = (s: ReviewSheet, n: number | null) => s.past.some(x => x.n === n)
const allDone = (s: ReviewSheet) => sheetItems(s).length > 0 && sheetItems(s).every(x => x.status !== 'pending')
// 全部通過 covers only 照你過去的回答, and only while the selection sits there.
const canPassAll = (s: ReviewSheet, sel: number | null) => isPast(s, sel) && s.past.some(x => x.status === 'pending')
const isExample = (a: ReviewAsk) => !!a.example || a.q === EXAMPLE_ASK || !flat(a.q)

// The first still-pending item after `from` in sheet order, wrapping to the top; null when none is left.
function nextPending(s: ReviewSheet, from: number | null): number | null {
  const list = sheetItems(s)
  const i = list.findIndex(x => x.n === from)
  return [...list.slice(i + 1), ...list.slice(0, Math.max(0, i + 1))].find(x => x.status === 'pending')?.n ?? null
}

// A label in the fixed column and its text wrapped under the text column, the first row led by the label.
function fieldRows(key: string, n: number, label: string, text: string, width: number, paint: Paint = 'fg'): SheetLine[] {
  const lead = MARK_COLS + INDENT
  const room = Math.max(1, width - lead - LABEL_COLS - LABEL_GAP)
  const pieces = wrapColumns(flat(text) || '—', room)
  return pieces.map((piece, i) => ({
    kind: 'text' as const,
    key: `${key}:${i}`,
    n,
    segs: [seg(' '.repeat(lead), 'fg'), seg(pad(i ? '' : label, LABEL_COLS + LABEL_GAP), 'label'), seg(piece, paint)],
  }))
}

function askRows(x: ReviewItem, view: SheetView, width: number): SheetLine[] {
  const rows: SheetLine[] = []
  const round = (a: ReviewAsk, i: number) =>
    isExample(a)
      ? fieldRows(`ask:${x.n}:${i}:a`, x.n, '範例', unmark(a.a), width)
      : [...fieldRows(`ask:${x.n}:${i}:q`, x.n, '問', a.q, width), ...fieldRows(`ask:${x.n}:${i}:a`, x.n, '答', unmark(a.a), width)]
  const earlier = x.asks.slice(0, -1)
  if (earlier.length) {
    const open = view.expanded.has(x.n)
    rows.push({ kind: 'text', key: `asks-fold:${x.n}`, n: x.n, segs: [seg(' '.repeat(MARK_COLS + INDENT), 'fg'), seg(truncateColumns(`前面 ${earlier.length} 輪問答（h ${open ? '收起' : '展開'}）`, Math.max(1, width - MARK_COLS - INDENT)), 'dim')] })
    if (open) earlier.forEach((a, i) => rows.push(...round(a, i)))
  }
  if (x.asks.length) rows.push(...round(x.asks.at(-1)!, x.asks.length - 1))
  if (view.asking.has(x.n)) {
    const q = view.asking.get(x.n)!
    if (q) rows.push(...fieldRows(`asking:${x.n}:q`, x.n, '問', q, width))
    rows.push(...fieldRows(`asking:${x.n}:a`, x.n, q ? '答' : '範例', q ? '想一下…' : '產生中…', width, 'busy'))
  }
  return rows
}

function itemRows(x: ReviewItem, past: boolean, view: SheetView, width: number): SheetLine[] {
  const room = Math.max(1, width - MARK_COLS)
  const done = x.status !== 'pending'
  const right = x.status === 'edited' ? [seg('已改', 'edited')] : x.status === 'elsewhere' ? [seg('在別處回覆', 'dim')] : undefined
  const title = truncateColumns(`${x.n}. ${flat(x.question)}`, Math.max(1, room - (x.status === 'edited' ? 3 : right ? columns(right[0]!.text) + 1 : 0)))
  const head: SheetLine = { kind: 'item', key: `item:${x.n}`, n: x.n, done, segs: [seg(title, done ? 'dim' : 'item')], right }
  const input: SheetLine[] = []
  if (view.input?.n === x.n) {
    const rows = inputRows(view.input.mode, view.draft, width)
    input.push({ kind: 'input', key: `input:${x.n}`, n: x.n, mode: view.input.mode, rows }, ...Array.from({ length: rows - 1 }, (_, i) => ({ kind: 'pad' as const, key: `input-pad:${x.n}:${i}`, n: x.n })))
  }
  if (x.status === 'passed' || x.status === 'elsewhere') return [head]
  if (x.status === 'edited') return [head, ...fieldRows(`edit:${x.n}`, x.n, EDIT_LABEL, x.edit ?? '', width), ...input]
  const fields = past
    ? fieldRows(`plan:${x.n}`, x.n, '當前方案', `${flat(x.plan)}（出處：${flat(x.basis)}）`, width)
    : [...fieldRows(`plan:${x.n}`, x.n, '當前方案', x.plan, width), ...fieldRows(`basis:${x.n}`, x.n, '依據', x.basis, width), ...fieldRows(`impact:${x.n}`, x.n, '影響範圍', x.impact, width)]
  return [head, ...fields, ...askRows(x, view, width), ...input]
}

// How many rows the open field needs for what it holds: the text wraps in the field's room after its label and the Enter word beside it.
function inputRows(mode: 'edit' | 'ask', draft: string, width: number): number {
  const label = `${mode === 'edit' ? EDIT_LABEL : ASK_LABEL} `
  const room = Math.max(1, width - MARK_COLS * 2 - columns(label) - columns(mode === 'edit' ? '改' : '問') - 3)
  return Math.max(1, draft ? wrapColumns(draft.replace(/\n/g, ' '), room).length : 1)
}

// `share` of `a` mixed into `b` for hex colors; a terminal-named color (neutral) keeps `b` so it follows the terminal's palette.
function tint(a: string | undefined, b: string | undefined, share: number): string | undefined {
  const rgb = (c: string | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) : null)
  const [x, y] = [rgb(a), rgb(b)]
  if (!x || !y) return b
  return `#${x.map((v, i) => Math.round(v * share + y[i]! * (1 - share)).toString(16).padStart(2, '0')).join('')}`
}

// The sheet's rows above the keys line: the title, branch and repo, then each section's items.
function sheetLines(s: ReviewSheet, view: SheetView, width: number): SheetLine[] {
  const left = `${flat(s.branch)}${s.pr ? ` · ${s.pr}` : ''}`
  // The repo keeps up to half the row before the branch and PR give way.
  const repoWidth = Math.min(columns(s.repo), Math.max(8, width - columns(left) - 2, Math.floor((width - 2) / 2)))
  const repo = truncateColumns(s.repo, repoWidth)
  const rows: SheetLine[] = [
    { kind: 'text', key: 'sheet-title', segs: [seg(truncateColumns(`審核單：${s.tag}`, width), 'title')] },
    { kind: 'text', key: 'sheet-meta', segs: [seg(truncateColumns(left, Math.max(1, width - columns(repo) - 2)), 'dim')], right: repo ? [seg(repo, 'dim')] : undefined },
  ]
  const section = (key: string, title: string, list: ReviewItem[], past: boolean) => {
    if (!list.length) return
    rows.push({ kind: 'text', key: `${key}-gap`, segs: [] }, { kind: 'text', key, segs: [seg(truncateColumns(title, width), 'section')] })
    list.forEach((x, i) => {
      if (i) rows.push({ kind: 'text', key: `${key}-gap:${x.n}`, segs: [] })
      rows.push(...itemRows(x, past, view, width))
    })
  }
  section('sheet-fresh', FRESH_TITLE, s.fresh, false)
  section('sheet-past', PAST_TITLE, s.past, true)
  return rows
}

// The keys that act on the selected item, in the keys line's order.
function sheetKeys(s: ReviewSheet, view: SheetView): string[] {
  if (view.input) return ['Enter 送出', 'Esc 取消']
  if (allDone(s)) return ['Enter 送出審核結果', ...(view.undo.length ? ['u 退回上一件'] : []), 'Esc 返回']
  const x = itemOf(s, view.sel)
  const open = x?.status === 'pending'
  return [
    ...(sheetItems(s).length > 1 ? ['↑↓ 選'] : []),
    ...(open ? ['Enter 通過', 'e 改', 'x 問'] : []),
    ...(x && x.asks.length > 1 ? [view.expanded.has(x.n) ? 'h 收起問答' : 'h 展開問答'] : []),
    ...(x?.example ? ['o 開範例'] : []),
    ...(canPassAll(s, view.sel) ? ['a 全部通過'] : []),
    ...(x ? ['c 討論'] : []),
    ...(view.undo.length ? ['u 退回'] : []),
    'Esc 返回',
  ]
}

// The keys joined by ` · `, wrapped between keys so none is cut; a key wider than the row alone is cut with ….
function keyLines(keys: string[], width: number): string[] {
  const lines: string[] = []
  for (const k of keys) {
    const last = lines.at(-1)
    if (last !== undefined && columns(`${last} · ${k}`) <= width) lines[lines.length - 1] = `${last} · ${k}`
    else lines.push(truncateColumns(k, width))
  }
  return lines
}

// What c submits to the console: the item's four fields, for a deeper talk in the conversation.
function deepTalkText(s: ReviewSheet, x: ReviewItem): string {
  return [`討論審核單 ${s.tag} 第 ${x.n} 件：`, `題目：${flat(x.question)}`, `當前方案：${flat(x.edit ?? x.plan)}`, `依據：${flat(x.basis)}`, `影響範圍：${flat(x.impact)}`].join('\n')
}

type Status = '輪到你' | '等待回應' | '等待授權' | '回覆完畢' | '執行中' | '閒置'

type Session = {
  key: string
  id: string
  tag: string
  repo: string
  status: Status
  summary: string
  options: string[]
  advice?: Advice | null
  brief?: Brief | null
  archived: boolean
  pending: boolean
  report: string
  // Decisions made without the user still waiting in this worktree's pre-implementation review sheet.
  review?: number
  autoReply?: string | null
  branch?: string
  path?: string
}

// The advisor's prediction for the question, read by `console.mjs focus`: still running, or ready with an answer and a reason.
type Advice = { state: 'pending' | 'ready'; text: string; answer?: string; reason?: string; principle?: string | null }

// The tab's newest plain-language recap, written in the background after each stop.
type Brief = { text: string | null; pending: boolean }

// The status band as `console.mjs focus` composed it: each row's forms widest first (the first that fits is drawn) and the keys on its right.
// Colors are names: see bandColor.
export type BandRun = { text: string; color?: string; bold?: boolean }
export type BandKey = { key: string; label: string; action: 'later' | 'next' | 'show' | 'pane' }
export type BandRow = { variants: BandRun[][]; keys?: BandKey[] }
export type Band = { title: string; rail: string; rows: BandRow[] }

type Focus = {
  active: boolean
  home?: string
  current?: string | null
  notice?: string | null
  waiting?: { tag: string | null } | null
  queue?: { key: string }[]
  band?: Band | null
  sessions?: Session[]
}

type Tab = 'pending' | 'all' | 'hidden'

const POLL_MS = 5_000
const IDLE_EVERY = 3
const PANE = 'worktree-console-pending'
const PANE_TITLE = '中控台'
const BRIEF_EMPTY = '還沒有摘要'
const BRIEF_PENDING = '摘要產生中…'
const BRIEF_KEYS = 'd 收起 · p 印出完整回報'
const CORNER_GAP = 2
// A branch is cut before the repo on a card's second row drops below REPO_MIN.
const REPO_MIN = 8
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
const FOOTER = 'qwe 切分頁 · 1-9,0/↑↓ 選卡片'
// Rows of the pane above the cards: the tab row and its underline.
const CHROME = 2
// The keys line after the last card and the gap above it, drawn only once the cards are scrolled to the end.
const FOOT = 2
// A card: the blank row above it, then its two rows.
const CARD_ROWS = 3
const CARD_BODY = 2
const REVIEW_STATUS = { glyph: '◈', label: '待審核', color: 'waiting' as const, glyphColor: 'waiting' as const }
const AUTO_STATUS = { glyph: '↻', label: '代回中', color: 'answered' as const, glyphColor: 'answered' as const }
const REVIEW_TIMEOUT_MS = 120_000
export const MARK_SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
export const MARK_STILL = '✻'
// The popover's rows around its text: the title rule and the bottom rule.
const POP_CHROME = 2

const TABS: { id: Tab; key: string; label: string; pick: (s: Session) => boolean }[] = [
  { id: 'pending', key: 'q', label: '待回覆', pick: s => s.pending },
  { id: 'all', key: 'w', label: '全部', pick: s => !s.archived },
  { id: 'hidden', key: 'e', label: '封存', pick: s => s.archived },
]
const EMPTY = '目前沒有符合條件的 session'
// Between two keys on the band's first row.
const KEY_GAP = 3
const HOTKEY_NAME: Record<BandKey['action'], string> = { later: 'later', next: 'later', show: 'show', pane: 'pane' }

const runsWidth = (runs: BandRun[]) => runs.reduce((n, r) => n + columns(r.text), 0)

// The runs cut to `width` columns from the end, the last kept piece ending in ….
function cutRuns(runs: BandRun[], width: number): BandRun[] {
  if (runsWidth(runs) <= width) return runs
  const out: BandRun[] = []
  let left = width
  for (const r of runs) {
    const w = columns(r.text)
    if (w < left) {
      out.push(r)
      left -= w
      continue
    }
    if (left > 0) out.push({ ...r, text: truncateColumns(r.text, left) })
    break
  }
  return out
}

// The first of a row's forms that fits `width`; when none does, the last one cut.
export function fitRow(variants: BandRun[][], width: number): BandRun[] {
  return variants.find(v => runsWidth(v) <= width) ?? cutRuns(variants.at(-1) ?? [], width)
}

// A key reads `8 延後處理`; where the row is too narrow for that, only its digit.
const keyText = (k: BandKey, compact: boolean) => (compact ? k.key : `${k.key} ${k.label}`)
export const keysWidth = (keys: BandKey[], compact = false) => keys.reduce((n, k, i) => n + columns(keyText(k, compact)) + (i ? (compact ? 1 : KEY_GAP) : 0), 0)
// The row keeps this much room left of its keys before they shrink to digits.
const KEYS_ROOM = 12

function bandColor(theme: ConsoleTheme, name: string | undefined): string | undefined {
  const map: Record<string, string | undefined> = {
    fg: theme.fg,
    dim: theme.dim,
    accent: theme.accent,
    waiting: theme.waiting,
    auto: theme.answered,
    running: theme.busy,
    skipped: theme.dim,
    closable: theme.closable,
    blocked: theme.blocked,
    error: theme.error,
  }
  return name ? map[name] ?? theme.fg : theme.fg
}

type Run = { text: string; color?: string; bold?: boolean }

// The runs laid out over lines of `width` columns as wrapColumns breaks them, a newline starting a line; each piece keeps its run's style.
function wrapRuns(runs: Run[], width: number): Run[][] {
  const paragraphs: { c: string; run: Run }[][] = [[]]
  for (const run of runs) {
    for (const c of run.text) {
      if (c === '\n') paragraphs.push([])
      else paragraphs[paragraphs.length - 1]!.push({ c, run })
    }
  }
  return paragraphs.flatMap(chars =>
    wrapRanges(chars.map(x => x.c).join(''), width).map(r => {
      const line: Run[] = []
      for (const { c, run } of chars.slice(r.from, r.to)) {
        const last = line[line.length - 1]
        if (last && last.color === run.color && last.bold === run.bold) line[line.length - 1] = { ...last, text: last.text + c }
        else line.push({ color: run.color, bold: run.bold, text: c })
      }
      return line
    }),
  )
}

// `footer`: a row of its own under the bottom rule, for keys that belong under the text.
type Popover = { title: Run; keys: string; lines: Run[][]; footer?: string; print?: () => void }

// The four layers as runs: labels dim in their column, text in the foreground, the ▶ 要你決定 row bold in the accent.
function digestRuns(rows: DigestPart[][], theme: ConsoleTheme): Run[][] {
  return rows.map(row => row.map(p => (p.decide ? { text: p.text, color: theme.accent, bold: true } : { text: p.text, color: p.role === 'label' ? theme.dim : theme.fg })))
}

function briefPopover(s: Session, width: number, theme: ConsoleTheme): Popover {
  const brief = s.brief ?? null
  const layers = parseDigest(brief?.text)
  const note: Run[] = brief?.text && brief.pending ? [{ text: `新的${BRIEF_PENDING}`, color: theme.dim }] : []
  const lines = layers
    ? [...digestRuns(digestRows(layers, width), theme), ...(note.length ? [[], note] : [])]
    : wrapRuns([brief?.text ? { text: brief.text, color: theme.fg } : { text: brief?.pending ? BRIEF_PENDING : BRIEF_EMPTY, color: theme.dim }, ...note.map(r => ({ ...r, text: `\n${r.text}` }))], width)
  return { title: { text: `${s.tag} 摘要`, color: theme.accent, bold: true }, keys: '', lines, footer: BRIEF_KEYS }
}

// Draws the popover over the cards, under the card whose rows are `start`..`end` (rows of the drawing), or over it when the card sits in
// the pane's lower half; it never reaches past the pane's rows in view, and scrolls its own text.
function popoverBox($: EngineInterface, e: any, p: Popover, at: { start: number; end: number; offset: number }, cols: number, theme: ConsoleTheme) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const view = e.props.scroll.bodyRows as number
  const shown = at.start - at.offset
  const above = shown > view / 2
  const room = above ? shown - CHROME : view - (at.end - at.offset)
  const chrome = POP_CHROME + (p.footer ? 1 : 0)
  const height = Math.min(p.lines.length + chrome, Math.max(chrome + 1, room))
  const rows = height - chrome
  popView = { rows, total: p.lines.length }
  pop!.at = Math.max(0, Math.min(pop!.at, p.lines.length - rows))
  const from = pop!.at
  const inner = Math.max(1, cols - 2)
  const keys = truncateColumns(p.keys, Math.max(0, cols - 8))
  const keysCols = keys ? columns(keys) + 1 : 0
  const title = truncateColumns(p.title.text, Math.max(1, cols - keysCols - 6))
  const footer = p.footer ? truncateColumns(p.footer, Math.max(1, cols - 2)) : ''
  const scroll = p.lines.length > rows ? ` j/k 捲動 · 第 ${from + 1}–${from + rows} 行／共 ${p.lines.length} 行 ` : ''
  const fill = (n: number) => '─'.repeat(Math.max(0, n))
  return (
    <Box key="popover" position="absolute" top={above ? at.start - height : at.end} left={0} width={cols} height={height} flexDirection="column" {...('bg' in theme ? { backgroundColor: theme.bg } : {})}>
      <Box key="popover-title" flexDirection="row" height={1} flexShrink={0}>
        <Text color={theme.accent}>{'── '}</Text>
        <Text color={p.title.color} bold={p.title.bold}>{title}</Text>
        <Text color={theme.accent}>{` ${fill(cols - columns(title) - keysCols - 6)}${keys ? ' ' : ''}`}</Text>
        {keys ? <Text color={theme.dim}>{keys}</Text> : null}
        <Text color={theme.accent}>{keys ? ' ─' : '──'}</Text>
      </Box>
      {p.lines.slice(from, from + rows).map((line, n) => (
        <Box key={`popover-line:${from + n}`} flexDirection="row" height={1} flexShrink={0}>
          <Text color={theme.accent}>{'┃ '}</Text>
          {line.map((r, j) => <Text key={`popover-run:${from + n}:${j}`} color={r.color} bold={r.bold}>{r.text}</Text>)}
          <Text>{' '.repeat(Math.max(0, inner - line.reduce((w, r) => w + columns(r.text), 0)))}</Text>
        </Box>
      ))}
      <Box key="popover-bottom" flexDirection="row" height={1} flexShrink={0}>
        <Text color={theme.accent}>{'──'}</Text>
        <Text color={theme.dim}>{scroll}</Text>
        <Text color={theme.accent}>{fill(cols - 2 - columns(scroll))}</Text>
      </Box>
      {footer ? (
        <Box key="popover-footer" flexDirection="row" height={1} flexShrink={0}>
          <Text color={theme.dim}>{`  ${footer}`}</Text>
          <Text>{' '.repeat(Math.max(0, cols - 2 - columns(footer)))}</Text>
        </Box>
      ) : null}
      <Box key="popover-keys" height={0} flexShrink={0} overflow="hidden">
        <Button key="popover-down" hotkey="j" label="" plain onPress={() => scrollPop($, 1)} />
        <Button key="popover-up" hotkey="k" label="" plain onPress={() => scrollPop($, -1)} />
        {p.print && <Button key="popover-print" hotkey="p" label="" plain onPress={p.print} />}
      </Box>
    </Box>
  )
}

// The text centred across `cols` between runs of ─, at least 2 on each side with a space next to the text, the text cut first.
function ruledLine(text: string, cols: number) {
  const shown = truncateColumns(text, Math.max(1, cols - 6))
  const left = Math.max(2, Math.floor((cols - columns(shown) - 2) / 2))
  return `${'─'.repeat(left)} ${shown} ${'─'.repeat(Math.max(2, cols - columns(shown) - 2 - left))}`
}

let focus: Focus = { active: false }
let tab: Tab = 'pending'
let sel: string | null = null
let top = 0
let follow = true
let frame: { avail: number } | null = null
let ring: string[] = []
let held: number | null = null
let tick = 0
let sessionId = ''
// Names this band instance; the newest one claims the band, so a band left over from a reload or an older console stops.
let owner = ''
// The console's own model turn: the band takes no new stop while it runs (`--turn 1`).
let turning = false
let appearance: Appearance = { theme: 'neutral', motion: true }
let animation: { cancel(): void } | null = null
let animationTick = 0
let paneFocused = false
let visibleKeys: string[] = []
let bandKey: string | null = null
const warned = new Set<string>()
// The one popover on the pane: a card's recap, `at` its first text line in view.
let pop: { kind: 'brief'; id: string; at: number } | null = null
let popView = { rows: 0, total: 0 }
// The review-sheet screen over the cards: the sheet as `review data` last printed it, null while it loads; `top` its first row in view.
// `busy`: pass, edit and undo calls still running; `talked`: items c has sent to the console since the sheet opened.
type Review = { tag: string; path: string; sheet: ReviewSheet | null; view: SheetView; top: number; finishing: boolean; busy: Set<Promise<unknown>>; talked: Set<number> }
let review: Review | null = null
let paneHadKeys = false
async function loadPreferences($: EngineInterface) {
  const home = await $.env.get('WORKTREE_CONSOLE_HOME') || `${await $.env.get('HOME')}/.config/worktree-console`
  const warnings: string[] = []
  let text = '{}'
  try { text = await $.fs.read(`${home}/config.json`) } catch {}
  appearance = loadAppearance(text, warnings)
  for (const message of warnings) {
    if (!warned.has(message)) {
      warned.add(message)
      $.ui.toast(message)
    }
  }
}

const markSpins = () => appearance.motion && paneFocused && (review ? review.view.sel !== null : sel !== null && visibleKeys.includes(sel))
const markGlyph = () => (markSpins() ? MARK_SPIN[animationTick % MARK_SPIN.length]! : MARK_STILL)

function visibleAnimationFrame(tick: number): number {
  const primary = primaryKey()
  let frame = markSpins() ? 16 | ((tick % MARK_SPIN.length) << 5) : 0
  for (const session of sessions()) {
    if (!visibleKeys.includes(session.key) && bandKey !== session.key) continue
    if (session.status === '等待授權') {
      frame |= 4
      if (statusCell(session.status, tick).glyphColor === 'dim') frame |= 1
    } else if ((session.status === '等待回應' || session.status === '輪到你') && session.key === primary) {
      frame |= 8
      if (statusCell(session.status, tick, { primary: true }).glyph === '◇') frame |= 2
    }
  }
  return frame
}

function syncAnimation($: EngineInterface) {
  const moving = appearance.motion && focus.active && visibleAnimationFrame(animationTick) !== 0
  if (!moving) {
    animation?.cancel()
    animation = null
    animationTick = 0
  } else if (!animation) {
    animation = $.clock.every(150, () => {
      const previous = visibleAnimationFrame(animationTick)
      animationTick += 1
      if (visibleAnimationFrame(animationTick) !== previous) $.ui.invalidate('ui.render')
    })
  }
}

const sessions = () => focus.sessions ?? []
const tabCount = (t: Tab) => rowsOf(t).length
const byKey = (key: string | null | undefined) => sessions().find(s => s.key === key) ?? null
const queueOf = () => (focus.queue ?? []).flatMap(q => (byKey(q.key) ? [byKey(q.key)!] : []))
const asks = (s: Session | null | undefined) => s?.status === '輪到你' || s?.status === '等待回應' || s?.status === '等待授權'
const primaryKey = () => {
  const current = byKey(focus.current)
  if (asks(current)) return current!.key
  return queueOf().find(asks)?.key ?? null
}

// 待回覆 always follows the band: the question on screen first, then the queue in order.
function rowsOf(t: Tab): Session[] {
  if (t !== 'pending') return sessions().filter(TABS.find(x => x.id === t)!.pick)
  return [byKey(focus.current), ...queueOf()].filter((s): s is Session => !!s)
}

const chosenOf = (rows: Session[]) => (rows.some(r => r.key === sel) ? sel : (rows[0]?.key ?? null))

// 待回覆 numbers the queue as the band does (the question on screen gets none); the other tabs number by place.
function numberOf(t: Tab, i: number): string | undefined {
  if (t !== 'pending') return DIGITS[i]
  const n = byKey(focus.current) ? i - 1 : i
  return n < 0 ? undefined : DIGITS[n]
}

const ruled = (rows: Session[], i: number, first: number) => tab !== 'pending' && (i === first || rows[i]!.repo !== rows[i - 1]!.repo)

// A card's rows as drawn: the blank row, header and question rows; plus its repo rule and the blank row above it outside 待回覆.
function blockRows(rows: Session[], i: number, first: number): number {
  return CARD_ROWS + (ruled(rows, i, first) ? 2 : 0)
}

// The pane row a card's header sits on, counted from the pane's top.
function cardRow(rows: Session[], i: number): number {
  let row = CHROME
  for (let k = top; k < i; k++) row += blockRows(rows, k, top)
  return row + blockRows(rows, i, top) - CARD_BODY
}

function fits(rows: Session[], from: number, to: number, avail: number, extra = 0): boolean {
  let used = extra
  for (let i = from; i <= to; i++) used += blockRows(rows, i, from)
  return used <= avail
}

function endOf(rows: Session[], from: number): number {
  if (!frame) return rows.length
  let end = Math.min(rows.length, from + 1)
  while (end < rows.length && fits(rows, from, end, frame.avail)) end += 1
  return end
}

// The first card when scrolled to the end, where the last cards and the keys line under them fit.
function lastTop(rows: Session[]): number {
  if (!frame) return 0
  let last = Math.max(0, rows.length - 1)
  while (last > 0 && fits(rows, last - 1, rows.length - 1, frame.avail, FOOT)) last -= 1
  return last
}

function clampTop(rows: Session[]) {
  top = Math.max(0, Math.min(top, lastTop(rows)))
}

function reveal(rows: Session[], i: number) {
  if (!frame || i < 0) return
  if (i < top) top = i
  while (top < i && !fits(rows, top, i, frame.avail)) top += 1
  if (i === rows.length - 1) top = Math.max(top, lastTop(rows))
}

function run($: EngineInterface, args: string[], timeoutMs = 60_000) {
  return $.process.run(['node', `${$.plugin.root}/skills/worktree-console/scripts/console.mjs`, ...args], { timeoutMs })
}

// Prints one question's full report through the focus-show mod, never through the model; only a press (9, or p on a recap) prints.
async function show($: EngineInterface, tag: string, key: string | null = null) {
  const s = sessions().find(x => x.tag === tag)
  if (!s || !focus.home) return
  await $.fs.write(`${focus.home}/show/${encodeURIComponent(tag)}.md`, s.report)
  const id = key && s.id
  if (id) await $.fs.write(`${focus.home}/show/${encodeURIComponent(tag)}@${id}.md`, s.report)
  const res = await $.command.run({ command: 'focus-show', args: id ? `${tag} ${id}` : tag }).catch(() => null)
  if (!res) return void $.ui.toast('印不出題目：需要另外安裝 focus-show')
  if (key && res.text === s.report) await run($, ['focus-shown', key]).catch(() => {})
}

async function apply($: EngineInterface, next: Focus) {
  // Only the console reads config.json, so another tab never toasts about it.
  if (next.active && !focus.active) await loadPreferences($)
  focus = next
  if (next.active && next.notice) $.ui.toast(next.notice)
  syncAnimation($)
  $.ui.invalidate('ui.render')
}

// `--typing`: a draft in the console's prompt; `--turn`: the console's turn still runs. Either holds a new stop off the band.
async function poll($: EngineInterface, claim = false) {
  let next: Focus = { active: false }
  const typing = !!(await $.prompt.read().catch(() => null))?.text?.trim()
  try {
    next = JSON.parse((await run($, ['focus', ...(sessionId ? ['--session', sessionId] : []), '--owner', owner, '--typing', typing ? '1' : '0', '--turn', turning ? '1' : '0', ...(claim ? ['--claim'] : [])])).stdout)
  } catch {}
  await apply($, next)
}

async function act($: EngineInterface, args: string[]) {
  try {
    await apply($, JSON.parse((await run($, args)).stdout))
  } catch {}
}

function showTab(t: Tab) {
  tab = t
  pop = null
  sel = t === 'pending' ? (focus.current ?? null) : (rowsOf(t)[0]?.key ?? null)
  top = 0
  follow = true
}

// The ring resolves a key against the drawing on screen and keeps only the index, so a focus asked before a tab's
// new drawing lands on whatever takes that index there (an unselected card's number). A tab reset or a reopen stays
// pending until a focus asked a frame after a drawing lands with no newer drawing in between; the engine refusing it
// REPIN_TRIES times in a row, or a pane without the keys, ends it. Our own `$.ui.focus` does not come back through our
// `ui.focus` hook, so the held index is written where it is asked.
let repin = false
let repinTries = 0
let repinGen = 0
let drawing = 0
const FRAME_MS = 50
const REPIN_TRIES = 10
const startRepin = () => ((repin = true), (repinTries = 0), (repinGen += 1))

async function focusSel($: EngineInterface, at: number, gen: number) {
  if (at !== drawing) return
  const endRepin = () => void (gen === repinGen && (repin = false))
  const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  const want = review ? (review.view.input ? REVIEW_INPUT : review.sheet && allDone(review.sheet) ? REVIEW_FINISH : review.view.sel !== null ? `item:${review.view.sel}` : null) : sel ? `name:${sel}` : null
  if (!want || !pane?.isFocused) return endRepin()
  const res = await $.ui.focus({ requestId: PANE, key: want }).catch(() => ({ deny: 'failed' }))
  if (!res.deny && at === drawing) return void ((held = ring.indexOf(want)), endRepin())
  if (res.deny && ++repinTries >= REPIN_TRIES) return endRepin()
  $.ui.invalidate('ui.render')
}

// A review sheet left open (Esc out of its field) is still there when the pane opens again.
async function openPane($: EngineInterface) {
  if (!review) showTab('pending')
  startRepin()
  // Asked within the press itself, so the engine seats the pane at any width; an open after an await counts as unasked.
  const opened = $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, backgroundColor: 'transparent' })
  await loadPreferences($)
  $.ui.invalidate('ui.render')
  await opened
  // The pane takes the keys back only now (the band's `0` held them), its ring still on the old tab's index.
  startRepin()
  $.ui.invalidate('ui.render')
}

// A card's number, Enter on it or a click on its nickname: a card with decisions to review opens its review sheet; any other card is
// only chosen, and the band keeps its stop.
async function pickCard($: EngineInterface, s: Session) {
  sel = s.key
  follow = true
  if ((s.review ?? 0) > 0 && s.path) return openReview($, s)
  $.ui.invalidate('ui.render')
  const res = await $.ui.focus({ requestId: PANE, key: `name:${s.key}` }).catch(() => ({ deny: 'failed' }))
  if (!res.deny) held = ring.indexOf(`name:${s.key}`)
}

// The recap popover's p: prints the card's full report; the band keeps its stop.
async function printCard($: EngineInterface, s: Session) {
  sel = s.key
  void show($, s.tag, s.key === focus.current ? s.key : null)
  $.ui.invalidate('ui.render')
}

function togglePop($: EngineInterface, kind: 'brief', id: string) {
  pop = pop?.kind === kind && pop.id === id ? null : { kind, id, at: 0 }
  $.ui.invalidate('ui.render')
}

function scrollPop($: EngineInterface, by: number) {
  if (!pop) return
  pop.at = Math.max(0, Math.min(pop.at + by, popView.total - popView.rows))
  $.ui.invalidate('ui.render')
}

// d opens or closes the chosen card's recap in a popover under the card; nothing reaches the conversation.
function toggleBrief($: EngineInterface, s: Session | null) {
  if (!s) return
  sel = s.key
  togglePop($, 'brief', s.key)
}

// The 封存 tab's button: runs `console.mjs unarchive` straight from the mod, so nothing reaches the conversation.
async function unarchiveCard($: EngineInterface, s: Session) {
  try {
    await run($, ['unarchive', s.tag])
  } catch {}
  await poll($)
}

const SUMMARY_POLL_MS = 3_000
const SUMMARY_PENDING = '產生中…'
const SUMMARY_TIMEOUT_MS = 120_000
const SUMMARY_SLACK_MS = 60_000

// A child tab's newest recap, written by scripts/summary.mjs after each stop.
let recap: Brief = { text: null, pending: false }
let recapHome = ''
let recapHandle = ''
let recapTheme: Appearance['theme'] = 'neutral'

async function readJsonFile($: EngineInterface, file: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(file))
  } catch {
    return null
  }
}

// A recap only counts for the session now in the tab.
async function pollRecap($: EngineInterface) {
  const name = encodeURIComponent(recapHandle)
  const [summary, marker, id, now] = await Promise.all([
    readJsonFile($, `${recapHome}/summaries/${name}.json`),
    readJsonFile($, `${recapHome}/summaries/${name}.pending.json`),
    $.session.id().catch(() => ''),
    $.clock.now(),
  ])
  const mine = (x: any) => !!x && (!x.sessionId || !id || x.sessionId === id)
  const next: Brief = {
    text: mine(summary) && typeof summary.text === 'string' && summary.text.trim() ? summary.text.trim() : null,
    pending: mine(marker) && now - (marker.since ?? 0) < (marker.timeoutMs ?? SUMMARY_TIMEOUT_MS) + SUMMARY_SLACK_MS,
  }
  if (next.text === recap.text && next.pending === recap.pending) return
  recap = next
  $.ui.invalidate('ui.render')
}

// The tab this session runs in: herdr first, then the Herdr app, then Orca; '' anywhere else.
async function terminalHandle($: EngineInterface) {
  if ((await $.env.get('HERDR_ENV')) === '1') return (await $.env.get('HERDR_PANE_ID')) ?? ''
  return (await $.env.get('HC_TERMINAL_ID')) || ((await $.env.get('ORCA_TERMINAL_HANDLE')) ?? '')
}

// In an Orca, herdr or Herdr app tab, watch this tab's recap files.
async function startRecap($: EngineInterface) {
  recapHandle = await terminalHandle($)
  if (!recapHandle) return
  recapHome = (await $.env.get('WORKTREE_CONSOLE_HOME')) || `${await $.env.get('HOME')}/.config/worktree-console`
  let config = '{}'
  try { config = await $.fs.read(`${recapHome}/config.json`) } catch {}
  recapTheme = loadAppearance(config, []).theme
  await pollRecap($)
  $.clock.every(SUMMARY_POLL_MS, () => void pollRecap($))
}

// A child session's tab: a 「── 摘要 ──」 rule, then its newest recap above the prompt once a turn ends, one row per layer; null when there is none to show.
// A recap written without the layer labels keeps its own lines.
function recapBand($: EngineInterface, e: any) {
  if (!recapHandle || e.props.hasSurvey || e.props.isWorking || (!recap.text && !recap.pending)) return null
  const { Box, Text } = $.ui.resolve(e)
  const theme = THEMES[recapTheme]
  const cols = Math.max(1, e.props.bodyColumns)
  const max = Math.max(1, Math.min(SUMMARY_MAX_LINES, e.props.maxRows - 2))
  const layers = recap.pending ? null : parseDigest(recap.text)
  const rows: DigestPart[][] = recap.pending
    ? [[{ role: 'text', text: SUMMARY_PENDING, decide: false }]]
    : layers
      ? bandDigestRows(layers, cols, max)
      : summaryLines(recap.text!, cols, max).map(text => [{ role: 'text', text, decide: false }])
  const head = `── ${DIGEST_RULE} `
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box key="summary-rule" flexDirection="row" height={1} flexShrink={0}>
        <Text color={theme.dim}>{'── '}</Text>
        <Text color={theme.accent} bold>{DIGEST_RULE}</Text>
        <Text color={theme.dim}>{` ${'─'.repeat(Math.max(2, cols - columns(head)))}`}</Text>
      </Box>
      {rows.map((row, i) => (
        <Box key={`summary:${i}`} flexDirection="row" height={1} flexShrink={0}>
          {row.map((p, j) => (
            <Text key={`summary-part:${i}:${j}`} color={recap.pending ? theme.dim : p.decide ? theme.accent : p.role === 'label' ? theme.dim : theme.fg} bold={p.decide || undefined} wrap="truncate-end">{p.text}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

const REVIEW_INPUT = 'review-input'
const emptyView = (): SheetView => ({ sel: null, input: null, draft: '', expanded: new Set(), asking: new Map(), undo: [] })
const REVIEW_FINISH = 'review-finish'
// Longer than the 120 s `review done` may spend sending the result back to the child session.
const DONE_TIMEOUT_MS = 180_000

// `console.mjs review <sub> --path <worktree>`; a failure toasts the line it printed and gives null.
async function reviewCall($: EngineInterface, r: Review, sub: string, args: string[] = [], timeoutMs = 60_000): Promise<string | null> {
  let res: { exitCode: number; stdout: string; stderr: string }
  try {
    res = await run($, ['review', sub, '--path', r.path, ...(sessionId ? ['--session', sessionId] : []), ...args], timeoutMs)
  } catch {
    $.ui.toast(`[${r.tag}] 審核單沒有回應`)
    return null
  }
  if (res.exitCode !== 0) {
    $.ui.toast((res.stderr || res.stdout).trim().split('\n')[0] || `[${r.tag}] 審核單 ${sub} 沒有成功`)
    return null
  }
  return res.stdout.trim()
}

function leaveReview($: EngineInterface) {
  review = null
  startRepin()
  $.ui.invalidate('ui.render')
}

// `review data`: only the first load asks for the PR (`--json` calls gh). A sheet with every item settled, here or in an earlier
// opening, waits for Enter on 送出審核結果; nothing else sends `review done`.
async function loadSheet($: EngineInterface, r: Review, first = false) {
  const out = await reviewCall($, r, 'data', first ? ['--json'] : [])
  if (review !== r) return
  let sheet: ReviewSheet | null = null
  try { sheet = out ? JSON.parse(out) : null } catch {}
  if (!sheet) return void (r.sheet || leaveReview($))
  if (!first && r.sheet) sheet.pr = r.sheet.pr
  r.sheet = sheet
  if (!itemOf(sheet, r.view.sel)) r.view.sel = nextPending(sheet, null) ?? sheetItems(sheet)[0]?.n ?? null
  startRepin()
  $.ui.invalidate('ui.render')
}

async function openReview($: EngineInterface, s: Session) {
  review = { tag: s.tag, path: s.path!, sheet: null, view: emptyView(), top: 0, finishing: false, busy: new Set(), talked: new Set() }
  pop = null
  $.ui.invalidate('ui.render')
  await loadSheet($, review, true)
}

// Every item passed or edited: `review done` sends the result back to the child session, and the pane goes back to the cards.
// It first waits for any pass, edit or undo still running, so an item just taken back is never sent as reviewed.
async function finishReview($: EngineInterface, r: Review) {
  if (r.finishing) return
  r.finishing = true
  while (r.busy.size) await Promise.allSettled([...r.busy])
  if (review !== r || !r.sheet || !allDone(r.sheet)) return void (r.finishing = false)
  const out = await reviewCall($, r, 'done', [], DONE_TIMEOUT_MS)
  r.finishing = false
  if (out === null) return
  if (out) $.ui.toast(out.split('\n').map(l => l.trim()).filter(Boolean).join(' · '))
  if (review === r) leaveReview($)
  await poll($)
}

function track<T>(r: Review, p: Promise<T>): Promise<T> {
  r.busy.add(p)
  void p.catch(() => {}).finally(() => r.busy.delete(p))
  return p
}

// After an item is settled the selection moves on to the next pending one.
const settle = ($: EngineInterface, r: Review, sub: string, args: string[], n: number | null, settled?: number[]) => track(r, settleNow($, r, sub, args, n, settled))

async function settleNow($: EngineInterface, r: Review, sub: string, args: string[], n: number | null, settled: number[] = n === null ? [] : [n]) {
  // A failed call reloads the sheet, so an item shown settled ahead of the call goes back to what the records say.
  if ((await reviewCall($, r, sub, args)) === null) return void (review === r && (await loadSheet($, r)))
  if (review !== r || !r.sheet) return
  r.view.undo.push(...settled)
  r.view.sel = nextPending(r.sheet, n) ?? r.view.sel
  await loadSheet($, r)
}

function passItem($: EngineInterface, r: Review, n: number) {
  const x = r.sheet && itemOf(r.sheet, n)
  if (!x || x.status !== 'pending' || r.view.input) return
  r.view.sel = n
  x.status = 'passed'
  $.ui.invalidate('ui.render')
  return settle($, r, 'pass', ['--n', String(n)], n)
}

function passPast($: EngineInterface, r: Review) {
  if (!r.sheet || r.view.input || !canPassAll(r.sheet, r.view.sel)) return
  const left = r.sheet.past.filter(x => x.status === 'pending').map(x => x.n)
  return settle($, r, 'pass-all', [], r.sheet.past.at(-1)?.n ?? null, left)
}

// u: the item settled last in this sitting goes back to pending and is selected; pressed again, the one before it.
function undoLast($: EngineInterface, r: Review) {
  const n = r.view.undo.at(-1)
  if (n === undefined || r.view.input || !r.sheet || r.finishing) return
  return track(r, undoNow($, r, n))
}

async function undoNow($: EngineInterface, r: Review, n: number) {
  if ((await reviewCall($, r, 'undo', ['--n', String(n)])) === null) return
  if (review !== r) return
  r.view.undo.pop()
  r.view.sel = n
  startRepin()
  await loadSheet($, r)
}

function openInput($: EngineInterface, r: Review, mode: 'edit' | 'ask') {
  const x = r.sheet && itemOf(r.sheet, r.view.sel)
  if (!x || x.status !== 'pending') return
  r.view.input = { n: x.n, mode }
  r.view.draft = ''
  startRepin()
  $.ui.invalidate('ui.render')
}

// An empty 問 asks for an example; `review ask` may take a minute, so it runs in the background and the sheet redraws when it returns.
async function submitInput($: EngineInterface, r: Review, value: string) {
  const open = r.view.input
  if (!open || review !== r) return
  const text = value.trim()
  r.view.input = null
  r.view.draft = ''
  const x = open.mode === 'edit' && text && r.sheet ? itemOf(r.sheet, open.n) : null
  if (x) Object.assign(x, { status: 'edited', edit: text })
  startRepin()
  $.ui.invalidate('ui.render')
  if (open.mode === 'edit') {
    if (text) await settle($, r, 'edit', ['--n', String(open.n), '--to', text], open.n)
    return
  }
  r.view.asking.set(open.n, text)
  const out = await reviewCall($, r, 'ask', ['--n', String(open.n), ...(text ? ['--q', text] : [])], REVIEW_TIMEOUT_MS)
  r.view.asking.delete(open.n)
  if (review !== r) return
  $.ui.invalidate('ui.render')
  if (out !== null) await loadSheet($, r)
}

function toggleAsks($: EngineInterface, r: Review) {
  const n = r.view.sel
  if (n === null || r.view.input) return
  if (r.view.expanded.has(n)) r.view.expanded.delete(n)
  else r.view.expanded.add(n)
  $.ui.invalidate('ui.render')
}

function openExample($: EngineInterface, r: Review) {
  const x = r.sheet && itemOf(r.sheet, r.view.sel)
  if (x?.example && !r.view.input) void $.process.run(['open', x.example], { timeoutMs: 10_000 }).catch(() => {})
}

// c sends each item once per opening of the sheet: marked when pressed, unmarked only if the send fails.
function deepTalk($: EngineInterface, r: Review) {
  const x = r.sheet && itemOf(r.sheet, r.view.sel)
  if (!x || r.view.input) return
  if (r.talked.has(x.n)) return void $.ui.toast(`第 ${x.n} 件已送去討論`)
  r.talked.add(x.n)
  void $.prompt.submit({ text: deepTalkText(r.sheet!, x) }).then(() => $.ui.toast(`已送到中控台：第 ${x.n} 件`), () => void r.talked.delete(x.n))
}

// The review sheet in the pane: its rows windowed to the pane, the selected item kept in view, the keys line under them.
function reviewScreen($: EngineInterface, e: any, r: Review, cols: number, theme: ConsoleTheme, dock: boolean) {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const bg = 'bg' in theme ? { backgroundColor: theme.bg } : {}
  const style: Record<Paint, { color?: string; bold?: true; dimColor?: true }> = {
    fg: { color: theme.fg },
    item: { color: tint(theme.accent, theme.fg, 0.6), bold: true },
    title: { color: theme.accent, bold: true },
    section: { color: theme.fg, bold: true },
    label: { color: theme.dim, dimColor: true },
    dim: { color: theme.dim },
    edited: { color: theme.accent },
    busy: { color: theme.dim },
  }
  if (!r.sheet) {
    ring = []
    return (
      <Box flexDirection="column" {...bg}>
        <Text key="sheet-title" color={theme.accent} bold>{truncateColumns(`審核單：${r.tag}`, cols)}</Text>
        <Text key="sheet-loading" color={theme.dim}>讀取中…</Text>
      </Box>
    )
  }
  const sheet = r.sheet
  const lines = sheetLines(sheet, r.view, cols)
  const keys = keyLines(sheetKeys(sheet, r.view), Math.max(1, cols - 1))
  const room = dock ? Math.max(1, e.props.scroll.bodyRows - keys.length - 1 - (allDone(sheet) ? 2 : 0)) : lines.length
  const picked = lines.flatMap((l, i) => ('n' in l && l.n === r.view.sel ? [i] : []))
  if (picked.length && lines.length > room) {
    const [first, last] = [picked[0]!, picked.at(-1)!]
    if (first < r.top) r.top = first
    if (last >= r.top + room) r.top = Math.min(first, last - room + 1)
  }
  r.top = Math.max(0, Math.min(r.top, lines.length - room))
  const runs = (l: SheetLine & { segs: any[] }, key: string) => l.segs.map((s, j) => <Text key={`${key}:${j}`} {...style[s.paint as Paint]}>{s.text}</Text>)
  const order: string[] = []
  const itemButton = (l: Extract<SheetLine, { kind: 'item' }>, shown: boolean) => {
    order.push(`item:${l.n}`)
    const isSel = l.n === r.view.sel
    const label = l.segs.map(s => s.text).join('')
    return <Button key={`item:${l.n}`} label={label} plain autoFocus={isSel && !r.view.input && !allDone(sheet) ? true : undefined} onPress={() => void passItem($, r, l.n)}>{shown ? runs(l, `item-text:${l.n}`) : null}</Button>
  }
  const hiddenItems = (part: SheetLine[], key: string) => (
    <Box key={key} height={0} flexShrink={0} overflow="hidden">{part.flatMap(l => (l.kind === 'item' ? [itemButton(l, false)] : []))}</Box>
  )
  const row = (l: SheetLine) => {
    if (l.kind === 'input') {
      order.push(REVIEW_INPUT)
      return (
        <Box key={`row:${l.key}`} flexDirection="row" height={l.rows} flexShrink={0}>
          <Text>{' '.repeat(MARK_COLS * 2)}</Text>
          <Box key="review-input-box" width={Math.max(1, cols - MARK_COLS * 2)} height={l.rows} flexShrink={0}>
            <Input
              key={REVIEW_INPUT}
              label={`${l.mode === 'edit' ? EDIT_LABEL : ASK_LABEL} `}
              placeholder={l.mode === 'ask' ? ASK_HINT : undefined}
              submitLabel={l.mode === 'edit' ? '改' : '問'}
              value={r.view.draft}
              rows={l.rows}
              autoFocus
              onInput={value => {
                if (review !== r || !r.view.input) return
                const grew = inputRows(r.view.input.mode, value, cols) !== inputRows(r.view.input.mode, r.view.draft, cols)
                r.view.draft = value
                if (grew) $.ui.invalidate('ui.render')
              }}
              onSubmit={value => void submitInput($, r, value)}
            />
          </Box>
        </Box>
      )
    }
    if (l.kind === 'pad') return null
    const right = l.right ? <Box key={`right:${l.key}`} flexDirection="row" flexShrink={0}>{l.right.map((s, j) => <Text key={`right:${l.key}:${j}`} {...style[s.paint]}>{s.text}</Text>)}</Box> : null
    if (l.kind === 'item') {
      const isSel = l.n === r.view.sel
      return (
        <Box key={`row:${l.key}`} flexDirection="row" height={1} flexShrink={0}>
          <Text color={isSel || !l.done ? theme.accent : theme.busy} bold={isSel || undefined}>{isSel ? ` ${markGlyph()} ` : l.done ? ' ✓ ' : '   '}</Text>
          <Box key={`item-row:${l.n}`} flexDirection="row" width={Math.max(1, cols - MARK_COLS)} flexShrink={0} justifyContent="space-between">
            {itemButton(l, true)}
            {right}
          </Box>
        </Box>
      )
    }
    return (
      <Box key={`row:${l.key}`} flexDirection="row" height={1} flexShrink={0} width={cols} justifyContent={right ? 'space-between' : undefined}>
        <Box key={`left:${l.key}`} flexDirection="row" flexShrink={1} overflow="hidden">{runs(l, `text:${l.key}`)}</Box>
        {right}
      </Box>
    )
  }
  const above = hiddenItems(lines.slice(0, r.top), 'sheet-above')
  const body = lines.slice(r.top, r.top + room).map(row)
  const below = hiddenItems(lines.slice(r.top + room), 'sheet-below')
  const hotkeys: [string, string, () => unknown][] = [
    ['review-edit', 'e', () => openInput($, r, 'edit')],
    ['review-ask', 'x', () => openInput($, r, 'ask')],
    ['review-asks', 'h', () => toggleAsks($, r)],
    ['review-open', 'o', () => openExample($, r)],
    ['review-all', 'a', () => passPast($, r)],
    ['review-talk', 'c', () => deepTalk($, r)],
    ['review-undo', 'u', () => undoLast($, r)],
  ]
  const done = allDone(sheet)
  if (done) order.push(REVIEW_FINISH)
  const finish = done ? (
    <Box key="review-finish-row" flexDirection="row" flexShrink={0} marginTop={1}>
      <Text color={theme.accent} bold>{` ${markGlyph()} `}</Text>
      <Button key={REVIEW_FINISH} label="全部審完，按 Enter 送出審核結果" plain autoFocus={!r.view.input ? true : undefined} onPress={() => void finishReview($, r)}>
        <Text color={theme.accent} bold>全部審完，按 Enter 送出審核結果</Text>
      </Button>
    </Box>
  ) : null
  const tree = (
    <Box flexDirection="column" {...bg}>
      {above}
      {body}
      {below}
      {finish}
      <Box key="review-keys" flexDirection="column" flexShrink={0} marginTop={1}>
        {keys.map((k, i) => <Text key={`review-keys:${i}`} color={theme.dim}>{k}</Text>)}
      </Box>
      <Box key="review-hotkeys" height={0} flexShrink={0} overflow="hidden">
        {hotkeys.map(([key, hotkey, press]) => <Button key={key} hotkey={hotkey} label="" plain onPress={() => void press()} />)}
      </Box>
    </Box>
  )
  ring = [...order, ...hotkeys.map(([key]) => key)]
  return tree
}

// The worktree-console focus band: polls `console.mjs focus`, draws the question on screen, the queue, the side pane and the counts.
export const register: Register = on => {
  registerKeepaliveView(on)
  on('session.start', async ($, e, next) => {
    const inHerdr = (await $.env.get('HERDR_ENV')) === '1'
    await startRecap($)
    if ((await $.env.get('ORCA_TERMINAL_HANDLE')) || inHerdr || (await $.env.get('HC_TERMINAL_ID'))) {
      sessionId = await $.session.id().catch(() => '')
      owner = `${sessionId}@${await $.clock.now()}`
      void poll($, true)
      $.clock.every(POLL_MS, () => {
        tick += 1
        if (focus.active || tick % IDLE_EVERY === 0) void poll($)
      })
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) turning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) turning = false
    try {
      return await next(e)
    } finally {
      if (e.agentId === undefined) {
        if (recapHandle) void pollRecap($)
        if (focus.active) void poll($)
      }
    }
  })

  // The engine walks ↑↓ one Button back or forth through the pane, keeping its place by index: a step from where it held is one card up or down.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (review) {
      // ↑↓ step one item; moving off an open field cancels it.
      const items = review.sheet ? sheetItems(review.sheet).map(x => x.n) : []
      if (e.element === REVIEW_INPUT || e.element === REVIEW_FINISH) return next(e)
      const hit = /^item:(\d+)$/.exec(e.element ?? '')
      const n = ring.length
      const to = ring.indexOf(e.element ?? '')
      const from = held !== null && held < n && /^item:/.test(ring[held]!) ? held : null
      const dir = e.origin.kind !== 'person' || to < 0 || from === null ? 0 : to === (from + 1) % n ? 1 : to === (from - 1 + n) % n ? -1 : 0
      const i = items.indexOf(review.view.sel ?? -1)
      const target = dir !== 0 && i >= 0 ? items[Math.max(0, Math.min(items.length - 1, i + dir))] : hit ? Number(hit[1]) : review.view.sel
      if (target === null || target === undefined || !items.includes(target)) {
        const res = await next(e)
        if (!res.deny) held = to < 0 ? null : to
        return res
      }
      if (review.view.input && e.origin.kind === 'person') review.view.input = null
      review.view.sel = target
      $.ui.invalidate('ui.render')
      const want = `item:${target}`
      const res = await next({ ...e, element: want })
      if (!res.deny) held = ring.indexOf(want)
      return res
    }
    const m = /^(num|name):(.+)$/.exec(e.element ?? '')
    const rows = rowsOf(tab)
    const chosen = chosenOf(rows)
    const n = ring.length
    const to = ring.indexOf(e.element ?? '')
    const from = held !== null && held < n ? held : null
    const dir =
      e.origin.kind !== 'person' || to < 0 ? 0 : from === null ? (to === 0 ? 1 : to === n - 1 ? -1 : 0) : to === (from + 1) % n ? 1 : to === (from - 1 + n) % n ? -1 : 0
    const i = rows.findIndex(r => r.key === chosen)
    // While a new drawing is being re-pinned, the engine re-asserts the card it last held (reopening the pane does): keep the selection.
    const repinning = !!m && e.origin.kind !== 'person' && repin && i >= 0
    const target = repinning ? rows[i] : dir !== 0 && i >= 0 ? rows[Math.max(0, Math.min(rows.length - 1, i + dir))] : rows.find(r => r.key === m?.[2])
    if (!target) {
      const res = await next(e)
      if (!res.deny) held = to < 0 ? null : to
      return res
    }
    sel = target.key
    if (pop && pop.id !== target.key) pop = null
    reveal(rows, rows.indexOf(target))
    $.ui.invalidate('ui.render')
    const want = `name:${target.key}`
    const res = await next({ ...e, element: want })
    if (!res.deny) held = ring.indexOf(want)
    return res
  })

  // The pane keeps its own window over the cards, the keys line riding after the last one: the wheel moves a card, a page key a screenful.
  // An open popover takes the wheel and the page keys for its own text.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const page = !e.pointer && Math.abs(e.by) >= e.bodyRows
    if (focus.active && pop) {
      scrollPop($, Math.sign(e.by) * (page ? Math.max(1, popView.rows) : 1))
      return {}
    }
    if (focus.active && review) {
      review.top = Math.max(0, review.top + Math.sign(e.by) * (page ? Math.max(1, e.bodyRows - 2) : 1))
      $.ui.invalidate('ui.render')
      return {}
    }
    if (!focus.active || !frame) return next(e)
    const rows = rowsOf(tab)
    top += Math.sign(e.by) * (page ? Math.max(1, endOf(rows, top) - top) : 1)
    clampTop(rows)
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      visibleKeys = []
      paneFocused = false
      pop = null
      review = null
      syncAnimation($)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!focus.active) return <Text dimColor>中控台沒有在專注模式</Text>
    const cols = e.props.bodyColumns
    const theme = THEMES[appearance.theme]
    const dock = e.props.placement === 'dock'
    // Esc hands the keys back to the prompt: out of an open field it only closes the field, else it leaves the sheet for the cards.
    const hasKeys = !!e.props.isFocused
    if (review && paneHadKeys && !hasKeys) {
      if (review.view.input) review.view.input = null
      else review = null
      startRepin()
    }
    paneHadKeys = hasKeys
    if (review) {
      visibleKeys = []
      paneFocused = hasKeys
      syncAnimation($)
      const at = (drawing += 1)
      const screen = reviewScreen($, e, review, cols, theme, dock)
      if (repin) {
        const gen = repinGen
        $.clock.after(FRAME_MS, () => void focusSel($, at, gen))
      }
      return screen
    }
    const tabList = TABS
    const rows = rowsOf(tab)
    const chosen = chosenOf(rows)
    frame = dock ? { avail: Math.max(1, e.props.scroll.bodyRows - CHROME) } : null
    if (chosen !== sel) (sel = chosen), (follow = true)
    if (follow) reveal(rows, rows.findIndex(r => r.key === chosen))
    follow = false
    clampTop(rows)
    const end = endOf(rows, top)
    visibleKeys = rows.slice(top, end).map(r => r.key)
    paneFocused = !!e.props.isFocused
    syncAnimation($)
    // Esc hands the keys back to the prompt, which closes the popover; so does its card leaving the tab or the window.
    const popAt = pop?.kind === 'brief' ? rows.findIndex(r => r.key === pop!.id) : -1
    if (pop && (!e.props.isFocused || tab === 'hidden' || popAt < top || popAt >= end)) pop = null
    ring = [
      ...tabList.map(x => `tab:${x.id}`),
      ...rows.flatMap((r, i) => [...(numberOf(tab, i) ? [`num:${r.key}`] : []), `name:${r.key}`]),
      ...(tab !== 'hidden' ? ['brief-key'] : []),
      ...(pop ? ['popover-down', 'popover-up', ...(pop.kind === 'brief' ? ['popover-print'] : [])] : []),
    ]
    const at = (drawing += 1)
    if (repin) {
      const gen = repinGen
      $.clock.after(FRAME_MS, () => void focusSel($, at, gen))
    }
    // Keep the selected label intact; only unselected labels shorten below 46 columns.
    const tabLabels = tabList.map(x => `${cols < 46 && x.id !== tab ? '' : `${x.label} `}${tabCount(x.id)}`)
    const tabIndex = tabList.findIndex(x => x.id === tab)
    const tabWidths = tabList.map((x, i) => columns(`${x.key}: ${tabLabels[i]}`))
    // space-between spreads the spare columns evenly; the layout rounds each tab's start to a whole column.
    const tabSpare = Math.max(0, cols - tabWidths.reduce((a, b) => a + b, 0)) / Math.max(1, tabList.length - 1)
    const tabStart = Math.min(cols, Math.round(tabWidths.slice(0, tabIndex).reduce((a, b) => a + b, 0) + tabIndex * tabSpare))
    const tabWidth = Math.min(Math.max(0, cols - tabStart), tabWidths[tabIndex]!)
    const tabs = (
      <Box key="tabs" flexDirection="row" justifyContent="space-between" height={1} flexShrink={0} overflow="hidden">
        {tabList.map((x, i) => (
          <Button
            key={`tab:${x.id}`}
            hotkey={x.key}
            label={tabLabels[i]!}
            plain
            dimColor={x.id !== tab}
            onPress={() => {
              showTab(x.id)
              startRepin()
              $.ui.invalidate('ui.render')
            }}
          />
        ))}
      </Box>
    )
    const underline = <Text color={theme.border}>{'─'.repeat(Math.min(cols, tabStart))}<Text color={theme.accent}>{'━'.repeat(tabWidth)}</Text>{'─'.repeat(Math.max(0, cols - tabStart - tabWidth))}</Text>
    const hidden = tab === 'hidden'
    const press = (r: Session) => (hidden ? unarchiveCard($, r) : pickCard($, r))
    // The header row past the blank column, the mark and the right margin; the branch row also leaves the number column blank.
    const head = Math.max(1, cols - 4)
    const card = (r: Session, i: number) => {
      const isSel = r.key === chosen
      const num = numberOf(tab, i)
      const reviewing = r.review ?? 0
      const auto = (r.autoReply ?? '').replace(/\s+/g, ' ').trim()
      const cell = auto ? AUTO_STATUS : reviewing > 0 ? REVIEW_STATUS : statusCell(r.status, animationTick, { primary: r.key === primaryKey(), animated: appearance.motion })
      const mark = <Text color={theme.accent} bold={isSel || undefined}>{isSel ? ` ${markGlyph()} ` : '   '}</Text>
      const rail = <Text>{'   '}</Text>
      // The advisor's suggestion is ready: ✓ 建議, only the ✓ below 46 columns.
      const ready = r.advice?.state === 'ready'
      const hintWidth = ready ? (cols >= 46 ? 6 : 1) : 0
      const reviewLabel = reviewing > 0 ? `需審核 ${reviewing} 件` : ''
      const rightWidth = hintWidth + columns(reviewLabel) + (hintWidth && reviewLabel ? 1 : 0)
      // The number, status and its gap left of the 代號, plus 取消封存 and its gap after it on 封存; one blank column before the right end.
      const lead = 13 + (hidden ? 10 : 0)
      const room = head - lead - (rightWidth ? rightWidth + 1 : 0)
      const tag = truncateColumns(r.tag, Math.max(1, room))
      const name = <Text color={isSel ? theme.accent : theme.fg} bold>{tag}</Text>
      const inner = Math.max(1, head - 3)
      const branch = auto ? `已代回：${auto}` : (r.branch ?? '').trim()
      const repoWidth = Math.min(columns(r.repo), branch ? Math.max(REPO_MIN, inner - columns(branch) - CORNER_GAP) : inner, inner)
      const repo = truncateColumns(r.repo, repoWidth)
      const branchWidth = inner - columns(repo) - (repo ? CORNER_GAP : 0)
      const branchText = branch && branchWidth >= 1 ? truncateColumns(branch, branchWidth) : ''
      return (
        <Box key={`card:${r.key}`} flexDirection="column" flexShrink={0} marginTop={1}>
          <Box key={`card-head:${r.key}`} flexDirection="row" height={1} flexShrink={0}>
            {mark}
            <Box key={`card-top:${r.key}`} flexDirection="row" width={head} flexShrink={0} justifyContent="space-between">
              <Box flexDirection="row">
                <Box key={`number:${r.key}`} width={3} flexShrink={0} overflow="hidden">{num ? <Button key={`num:${r.key}`} hotkey={num} label="" plain onPress={() => pickCard($, r)} /> : <Text>   </Text>}</Box>
                <Box flexDirection="row"><Box key={`status:${r.key}`} flexDirection="row" width={8} flexShrink={0}><Text color={theme[cell.glyphColor]}>{cell.glyph}</Text><Text color={theme[cell.color]}>{` ${cell.label}${' '.repeat(Math.max(0, 6 - columns(cell.label)))}`}</Text></Box><Text>  </Text></Box>
                {hidden && name}
                {hidden && <Text>  </Text>}
                {hidden ? <Button key={`name:${r.key}`} label="取消封存" plain autoFocus={isSel ? true : undefined} onPress={() => press(r)} /> : <Button key={`name:${r.key}`} label={tag} plain autoFocus={isSel ? true : undefined} onPress={() => press(r)}>{name}</Button>}
              </Box>
              {rightWidth > 0 && (
                <Box key={`right:${r.key}`} flexDirection="row" flexShrink={0}>
                  {ready && <Box key={`hint:${r.key}`} flexDirection="row" width={hintWidth} flexShrink={0}><Text color={theme.accent}>✓</Text>{cols >= 46 && <Text color={theme.dim}> 建議</Text>}</Box>}
                  {ready && reviewLabel && <Text> </Text>}
                  {reviewLabel && <Box key={`card-review:${r.key}`} flexShrink={0}><Text color={theme.waiting}>{reviewLabel}</Text></Box>}
                </Box>
              )}
            </Box>
          </Box>
          <Box key={`card-branch:${r.key}`} flexDirection="row" height={1} flexShrink={0}>
            {rail}
            <Box key={`card-bottom:${r.key}`} flexDirection="row" width={head} flexShrink={0} justifyContent="space-between">
              <Box key={`branch:${r.key}`} flexDirection="row" flexShrink={1} overflow="hidden">
                <Text>   </Text>
                <Text color={theme.dim} wrap="truncate-end">{branchText}</Text>
              </Box>
              {repo && <Box key={`card-repo:${r.key}`} width={columns(repo)} flexShrink={0}><Text color={theme.dim} dimColor>{repo}</Text></Box>}
            </Box>
          </Box>
        </Box>
      )
    }
    const empty = (
      <Box key="empty" width={cols} borderStyle="round" borderColor={theme.border} paddingY={1}>
        <Text color={theme.dim}>{`${' '.repeat(Math.max(0, Math.floor((cols - 2 - columns(EMPTY)) / 2)))}${EMPTY}`}</Text>
      </Box>
    )
    const body = rows.slice(top, end).flatMap((r, j) => {
      const i = top + j
      const out = []
      if (tab !== 'pending' && (j === 0 || r.repo !== rows[i - 1]!.repo)) {
        const tail = ` 共 ${sessions().filter(x => x.repo === r.repo).length} 個`
        out.push(
          <Box key={`repo:${r.repo}`} flexShrink={0} marginTop={1}>
            <Text wrap="truncate-end"><Text color={theme.dim}>{'── '}</Text><Text color={theme.fg}>{r.repo}</Text><Text color={theme.dim}>{` ${'─'.repeat(Math.max(2, cols - columns(r.repo) - columns(tail) - 4))}${tail}`}</Text></Text>
          </Box>,
        )
      }
      out.push(card(r, i))
      return out
    })
    // Cards scrolled out of the window keep their buttons, in order and zero rows tall, so their numbers work and the ring keeps its places.
    const offscreen = (key: string, part: Session[], from: number) => (
      <Box key={key} height={0} flexShrink={0} overflow="hidden">
        {part.flatMap((r, j) => {
          const num = numberOf(tab, from + j)
          return [
            ...(num ? [<Button key={`num:${r.key}`} hotkey={num} label="" plain onPress={() => pickCard($, r)} />] : []),
            <Button key={`name:${r.key}`} label="" plain onPress={() => press(r)} />,
          ]
        })}
      </Box>
    )
    const briefSession = pop?.kind === 'brief' ? rows[popAt] : undefined
    const briefRow = briefSession ? cardRow(rows, popAt) : 0
    const briefOver = briefSession
      ? popoverBox($, e, { ...briefPopover(briefSession, Math.max(1, cols - 2), theme), print: () => void ((pop = null), printCard($, briefSession)) }, { start: briefRow, end: briefRow + CARD_BODY, offset: 0 }, cols, theme)
      : null
    return (
      <Box flexDirection="column" height={dock ? e.props.scroll.bodyRows : undefined} {...('bg' in theme ? { backgroundColor: theme.bg } : {})}>
        {tabs}
        {underline}
        <Box key="cards" flexDirection="column" flexShrink={1} overflow="hidden">
          {offscreen('above', rows.slice(0, top), 0)}
          {rows.length === 0 ? empty : body}
          {offscreen('below', rows.slice(end), end)}
          {!hidden && (
            <Box key="brief-keys" height={0} flexShrink={0} overflow="hidden">
              <Button key="brief-key" hotkey="d" label="" plain onPress={() => toggleBrief($, rows.find(r => r.key === chosen) ?? null)} />
            </Box>
          )}
        </Box>
        {top >= lastTop(rows) && (
          <Box key="footer" flexShrink={0} marginTop={1}>
            <Text color={theme.dim}>{ruledLine(FOOTER, cols)}</Text>
          </Box>
        )}
        {briefOver}
      </Box>
    )
  })

  // The status band: a rule, then the rows `console.mjs focus` composed, each led by a rail in the band's color; the keys on the first row's right.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = focus.band
    if (!focus.active || e.props.hasSurvey || !band?.rows?.length) {
      bandKey = null
      syncAnimation($)
      return (!focus.active && recapBand($, e)) || next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const theme = THEMES[appearance.theme]
    const cur = byKey(focus.current)
    bandKey = cur?.key ?? null
    syncAnimation($)
    const cols = e.props.bodyColumns
    const inner = Math.max(1, cols - 4)
    const rail = <Text color={bandColor(theme, band.rail)}>│ </Text>
    const title = `── ${band.title} `
    const press = (k: BandKey) => {
      if (k.action === 'pane') return void openPane($)
      if (k.action === 'show') return void (cur && show($, cur.tag, cur.key))
      return void act($, ['focus-later'])
    }
    const rows = band.rows.slice(0, Math.max(1, e.props.maxRows - 2))
    const keys = rows.flatMap(r => r.keys ?? [])
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row"><Text color={theme.dim}>{title}</Text><Text color={theme.border}>{'─'.repeat(Math.max(0, cols - columns(title)))}</Text></Box>
        {rows.map((row, i) => {
          const compact = !!row.keys?.length && keysWidth(row.keys) + 2 + KEYS_ROOM > inner
          const kw = row.keys?.length ? keysWidth(row.keys, compact) : 0
          const runs = fitRow(row.variants, Math.max(1, inner - (kw ? kw + 2 : 0)))
          return (
            <Box key={`band:${i}`} flexDirection="row" paddingLeft={2} height={1} flexShrink={0}>
              {rail}
              <Box key={`band-row:${i}`} flexDirection="row" width={inner} flexShrink={0} justifyContent="space-between">
                <Box flexDirection="row" flexShrink={1} overflow="hidden">
                  {runs.map((r, j) => <Text key={`band-run:${i}:${j}`} color={bandColor(theme, r.color)} bold={r.bold || undefined}>{r.text}</Text>)}
                </Box>
                {kw > 0 && (
                  <Box key={`band-keys:${i}`} flexDirection="row" width={kw} flexShrink={0}>
                    {row.keys!.map((k, j) => (
                      <Box key={`band-key:${k.key}`} flexDirection="row">
                        {j > 0 && <Text>{' '.repeat(compact ? 1 : KEY_GAP)}</Text>}
                        <Text bold>{k.key}</Text>
                        {!compact && <Text color={theme.dim}>{` ${k.label}`}</Text>}
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            </Box>
          )
        })}
        <Box key="band-hotkeys" height={0} overflow="hidden">
          {keys.map(k => <Button key={HOTKEY_NAME[k.action]} hotkey={k.key} label="" plain onPress={() => press(k)} />)}
        </Box>
      </Box>
    )
  })
}
