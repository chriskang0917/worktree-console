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
  status: 'pending' | 'passed' | 'edited'
  edit: string | null
  asks: ReviewAsk[]
  example: string | null
  by?: string
}
type ReviewSheet = { tag: string; path: string; repo: string; branch: string; pr: string | null; fresh: ReviewItem[]; past: ReviewItem[]; problems?: string[] }

// `input`: the field open under an item; `asking`: questions still waiting on `review ask`, '' for an example.
type SheetView = { sel: number | null; input: { n: number; mode: 'edit' | 'ask' } | null; expanded: Set<number>; asking: Map<number, string> }

type Paint = 'fg' | 'item' | 'title' | 'section' | 'label' | 'dim' | 'edited' | 'busy'
type Seg = { text: string; paint: Paint }
type SheetLine =
  | { kind: 'text'; key: string; segs: Seg[]; right?: Seg[]; n?: number }
  | { kind: 'item'; key: string; n: number; done: boolean; segs: Seg[]; right?: Seg[] }
  | { kind: 'input'; key: string; n: number; mode: 'edit' | 'ask' }

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
      ? fieldRows(`ask:${x.n}:${i}:a`, x.n, '範例', a.a, width)
      : [...fieldRows(`ask:${x.n}:${i}:q`, x.n, '問', a.q, width), ...fieldRows(`ask:${x.n}:${i}:a`, x.n, '答', a.a, width)]
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
  const right = x.status === 'edited' ? [seg('已改', 'edited')] : undefined
  const title = truncateColumns(`${x.n}. ${flat(x.question)}`, Math.max(1, room - (right ? 3 : 0)))
  const head: SheetLine = { kind: 'item', key: `item:${x.n}`, n: x.n, done, segs: [seg(title, done ? 'dim' : 'item')], right }
  const input: SheetLine[] = view.input?.n === x.n ? [{ kind: 'input', key: `input:${x.n}`, n: x.n, mode: view.input.mode }] : []
  if (x.status === 'passed') return [head]
  if (x.status === 'edited') return [head, ...fieldRows(`edit:${x.n}`, x.n, EDIT_LABEL, x.edit ?? '', width), ...input]
  const fields = past
    ? fieldRows(`plan:${x.n}`, x.n, '當前方案', `${flat(x.plan)}（出處：${flat(x.basis)}）`, width)
    : [...fieldRows(`plan:${x.n}`, x.n, '當前方案', x.plan, width), ...fieldRows(`basis:${x.n}`, x.n, '依據', x.basis, width), ...fieldRows(`impact:${x.n}`, x.n, '影響範圍', x.impact, width)]
  return [head, ...fields, ...askRows(x, view, width), ...input]
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
    for (const x of list) rows.push(...itemRows(x, past, view, width))
  }
  section('sheet-fresh', FRESH_TITLE, s.fresh, false)
  section('sheet-past', PAST_TITLE, s.past, true)
  return rows
}

// The keys that act on the selected item, in the keys line's order.
function sheetKeys(s: ReviewSheet, view: SheetView): string[] {
  if (view.input) return ['Enter 送出', 'Esc 取消']
  const x = itemOf(s, view.sel)
  const open = x?.status === 'pending'
  return [
    ...(sheetItems(s).length > 1 ? ['↑↓ 選'] : []),
    ...(open ? ['Enter 通過', 'e 改', 'x 問'] : []),
    ...(x && x.asks.length > 1 ? [view.expanded.has(x.n) ? 'h 收起問答' : 'h 展開問答'] : []),
    ...(x?.example ? ['o 開範例'] : []),
    ...(canPassAll(s, view.sel) ? ['a 全部通過'] : []),
    ...(x ? ['c 討論'] : []),
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

type Status = '等待回應' | '等待授權' | '回覆完畢' | '執行中' | '閒置'

type Session = {
  key: string
  id: string
  tag: string
  repo: string
  status: Status
  summary: string
  question: string
  options: string[]
  advice?: Advice | null
  brief?: Brief | null
  archived: boolean
  pending: boolean
  report: string
  // Decisions made without the user still waiting in this worktree's pre-implementation review sheet.
  review?: number
  branch?: string
  path?: string
}

// The advisor's prediction for the question, read by `console.mjs focus`: still running, or ready with an answer and a reason.
type Advice = { state: 'pending' | 'ready'; text: string; answer?: string; reason?: string; principle?: string | null }

// The tab's newest plain-language recap, written in the background after each stop.
type Brief = { text: string | null; pending: boolean }

type Focus = {
  active: boolean
  home?: string
  current?: string | null
  announce?: string | null
  announceKey?: string | null
  notice?: string | null
  waiting?: { tag: string | null; seconds: number } | null
  queue?: { key: string; isNew: boolean }[]
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
const QUEUE_MAX = 5
const TOAST_MAX = 30
const CORNER_GAP = 2
// A long 代號 is cut before the question on its header row drops below QUESTION_MIN (and a branch before the repo drops below REPO_MIN);
// where the row cannot hold both, the 代號 keeps TAG_MIN.
const REPO_MIN = 8
const TAG_MIN = 4
const QUESTION_MIN = 8
const SENT_MAX = 50
const MISS_TOAST = 3
const SHOW_LOG_MAX = 200
// focus-show's answer when it cannot read focus.json's format; sending it again cannot help.
const FORMAT_MISMATCH = '不認得這個檔案格式'
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
// The band header's right side: `9: 顯示問題`, led by `8: 延後處理 · ` while the queue has one; four cells per hotkey decoration.
const SHOW_WIDTH = 4 + 8
const LATER_WIDTH = 4 + 8 + 3
// The band header's status cell: glyph, a space, the label padded to 6 cells, two spaces.
const BAND_STATUS = 10

export function focusBandRows({ cols, maxRows, question, queue, hiddenCount, hasCurrent = true, advice = null, options = [] }: {
  cols: number
  maxRows: number
  question: string
  queue: { tag: string; isNew: boolean }[]
  hiddenCount: number
  hasCurrent?: boolean
  advice?: Advice | null
  options?: string[]
}) {
  const inner = Math.max(1, cols - 6)
  const nameLimit = Math.max(1, cols < 60 ? cols - 26 : 20)
  const visible = queue.slice(0, cols < 60 ? 1 : QUEUE_MAX)
  const hidden = hiddenCount + queue.length - visible.length
  const queueLabels = visible.map(q => `${truncateColumns(q.tag, nameLimit)}${q.isNew ? ' ✨' : ''}`)
  // Reserve four cells for the hotkey decoration, independent of its terminal style.
  const keyWidths = [2, ...(visible.length ? [5] : []), ...queueLabels.map(label => columns(label) + 7), ...(hidden ? [columns(`＋${hidden} · `)] : []), 8]
  const keyLines: { index: number; width: number }[][] = [[]]
  let used = 0
  for (const [index, size] of keyWidths.entries()) {
    if (used > 0 && used + size > cols - 2) {
      keyLines.push([])
      used = 0
    }
    keyLines[keyLines.length - 1]!.push({ index, width: size })
    used += size
  }
  const keys = keyLines.length
  // 9 and 8 sit on the header row, so no row of their own.
  const actions = 0
  const margin = 1
  const separator = 1
  const header = 1
  const available = Math.max(0, maxRows - margin - separator - header - keys)
  const questionRows = hasCurrent ? Math.min(1, available) : 0
  const questionText = questionRows ? truncateColumns(question.replace(/\s+/g, ' ').trim(), inner) : ''
  const adviceRows = hasCurrent && advice ? Math.max(0, Math.min(1, available - questionRows)) : 0
  const adviceParts = adviceRows ? fitParts(adviceSegments(advice!, options), inner) : []
  return { margin, separator, header, actions, keys, question: questionRows, questionText, advice: adviceRows, adviceParts, queueLabels, keyLines }
}

type AdvicePart = { role: 'label' | 'answer' | 'option' | 'reason' | 'note' | 'pending'; text: string }

// A bare a／b／c answer carries its option's own words, so the row reads without pressing 9.
function optionWords(answer: string, options: string[]): string {
  if (!/^[a-z](?:\s*[、,，]\s*[a-z])*$/i.test(answer)) return ''
  const words = [...answer.toLowerCase().matchAll(/[a-z]/g)].map(m => options[m[0].charCodeAt(0) - 97]?.split(/[：:]/)[0]?.trim()).filter(Boolean)
  return words.length ? ` ${words.join('、')}` : ''
}

function adviceSegments(advice: Advice, options: string[] = []): AdvicePart[] {
  if (advice.state === 'pending' || !advice.answer) return [{ role: 'pending', text: advice.text }]
  const answer = advice.answer.replace(/\s+/g, ' ').trim()
  const words = optionWords(answer, options)
  const reason = (advice.reason ?? '').replace(/\s+/g, ' ').trim()
  return [
    { role: 'label', text: '建議：' },
    { role: 'answer', text: answer },
    ...(words ? [{ role: 'option' as const, text: words }] : []),
    ...(reason ? [{ role: 'reason' as const, text: `，${reason}` }] : []),
    ...(advice.principle ? [{ role: 'note' as const, text: `（原則性：${advice.principle}）` }] : []),
  ]
}

// Fits the parts in `width` columns: the reason gives way first (cut with …), then the option words; the answer and the principle note stay.
function fitParts(parts: AdvicePart[], width: number): AdvicePart[] {
  const total = (list: AdvicePart[]) => list.reduce((n, p) => n + columns(p.text), 0)
  let out = parts
  for (const role of ['reason', 'option'] as const) {
    const over = total(out) - width
    if (over <= 0) return out
    const part = out.find(p => p.role === role)
    if (!part) continue
    const room = columns(part.text) - over
    out = room >= 3 ? out.map(p => (p === part ? { ...p, text: truncateColumns(p.text, room) } : p)) : out.filter(p => p !== part)
  }
  if (total(out) <= width) return out
  const cut: AdvicePart[] = []
  let left = width
  for (const p of out) {
    if (columns(p.text) <= left) {
      cut.push(p)
      left -= columns(p.text)
      continue
    }
    if (left > 0) cut.push({ ...p, text: truncateColumns(p.text, left) })
    break
  }
  return cut
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

const advicePaint = (theme: ConsoleTheme): Record<AdvicePart['role'], { color: string | undefined; bold?: boolean }> => ({
  label: { color: theme.accent },
  answer: { color: theme.fg, bold: true },
  option: { color: theme.fg },
  reason: { color: theme.muted ?? theme.dim },
  note: { color: theme.waiting },
  pending: { color: theme.dim },
})

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
let known: Set<string> | null = null
let tick = 0
let sessionId = ''
// Names this band instance; the newest one claims the band, so a band left over from a reload or an older console stops.
let owner = ''
// The console's own model turn: a /focus-show sent during it would wait in the input queue, so announces hold until it ends.
let turning = false
const sent: string[] = []
const misses = new Map<string, number>()
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
type Review = { tag: string; path: string; sheet: ReviewSheet | null; view: SheetView; top: number; finishing: boolean }
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
    } else if (session.status === '等待回應' && session.key === primary) {
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
const queueOf = () => (focus.queue ?? []).flatMap(q => (byKey(q.key) ? [{ ...byKey(q.key)!, isNew: q.isNew }] : []))
const primaryKey = () => {
  const current = byKey(focus.current)
  if (current?.status === '等待回應' || current?.status === '等待授權') return current.key
  return queueOf().find(s => s.status === '等待回應' || s.status === '等待授權')?.key ?? null
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

// TEMP: tells what an announced /focus-show got back when a print goes missing; remove once the cause is confirmed.
async function logShow($: EngineInterface, entry: object) {
  const file = `${focus.home}/focus-show-debug.jsonl`
  let text = ''
  try { text = await $.fs.read(file) } catch {}
  const line = JSON.stringify({ at: await $.clock.now(), ...entry })
  await $.fs.write(file, [...text.split('\n').filter(Boolean).slice(-SHOW_LOG_MAX + 1), line].join('\n') + '\n').catch(() => {})
}

// Prints one question's full report through the focus-show mod, never through the model. A stop counts as printed only when
// /focus-show answered with its report; anything else but the format line is sent again on the next poll, with a toast after 3 misses in a row.
async function show($: EngineInterface, tag: string, key: string | null = null) {
  const s = sessions().find(x => x.tag === tag)
  if (!s || !focus.home) return
  await $.fs.write(`${focus.home}/show/${encodeURIComponent(tag)}.md`, s.report)
  const id = key && s.id
  if (id) await $.fs.write(`${focus.home}/show/${encodeURIComponent(tag)}@${id}.md`, s.report)
  const res = await $.command.run({ command: 'focus-show', args: id ? `${tag} ${id}` : tag }).catch(() => null)
  if (key) await logShow($, { key, tag, id, turning, answer: res ? (res.text === s.report ? 'report' : res.text ?? '') : null })
  if (!key) {
    if (!res) $.ui.toast('印不出題目：需要另外安裝 focus-show')
    return
  }
  if (res?.text === s.report) {
    misses.delete(key)
    await run($, ['focus-shown', key]).catch(() => {})
    return
  }
  if (res?.text?.includes(FORMAT_MISMATCH)) return
  const n = (misses.get(key) ?? 0) + 1
  misses.set(key, n)
  // Each resent 略過 line lands in the conversation, so a stop answered with one 3 times is left to 9.
  if (!res?.text || n < MISS_TOAST) {
    const i = sent.indexOf(key)
    if (i >= 0) sent.splice(i, 1)
  }
  if (n !== MISS_TOAST) return
  const installed = res || (await $.command.list().catch(() => [])).some(c => c.name === 'focus-show')
  $.ui.toast(installed ? `[${tag}] 題目沒印出，按 9 印` : '印不出題目：需要另外安裝 focus-show')
}

// A poll repeats an announce until `focus-shown` lands; while the console's turn runs only a press prints, and once it
// ends the question then on the band is the one printed.
async function announce($: EngineInterface, next: Focus, pressed: boolean) {
  const key = next.announceKey ?? null
  if (!next.announce || (!pressed && turning) || (key && !pressed && sent.includes(key))) return
  if (key && !sent.includes(key)) {
    sent.push(key)
    if (sent.length > SENT_MAX) sent.shift()
  }
  void show($, next.announce, key)
}

async function apply($: EngineInterface, next: Focus, pressed = false) {
  // Only the console reads config.json, so another tab never toasts about it.
  if (next.active && !focus.active) await loadPreferences($)
  if (next.active) {
    const live = [next.current, ...(next.queue ?? []).map(q => q.key)].filter((k): k is string => !!k)
    for (const q of next.queue ?? []) {
      const s = next.sessions?.find(x => x.key === q.key)
      if (known && s && !known.has(q.key)) $.ui.toast(`${s.tag} 進排隊：${truncateColumns(s.question.replace(/\s+/g, ' '), TOAST_MAX)}`)
    }
    known = new Set(live)
    // A stop that left the band before /focus-show ran was not printed; the console announces it again once it is back.
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i] !== next.current) sent.splice(i, 1)
    for (const k of misses.keys()) if (k !== next.current) misses.delete(k)
  }
  focus = next
  if (next.active && next.notice) $.ui.toast(next.notice)
  syncAnimation($)
  if (next.active) await announce($, next, pressed)
  $.ui.invalidate('ui.render')
}

// `--typing`: while the console's prompt holds a draft the server answers no question for the user.
async function poll($: EngineInterface, claim = false) {
  let next: Focus = { active: false }
  const typing = !!(await $.prompt.read().catch(() => null))?.text?.trim()
  try {
    next = JSON.parse((await run($, ['focus', ...(sessionId ? ['--session', sessionId] : []), '--owner', owner, '--typing', typing ? '1' : '0', ...(claim ? ['--claim'] : [])])).stdout)
  } catch {}
  await apply($, next)
}

async function act($: EngineInterface, args: string[]) {
  try {
    await apply($, JSON.parse((await run($, args)).stdout), true)
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
  const want = review ? (review.view.input ? null : review.view.sel !== null ? `item:${review.view.sel}` : null) : sel ? `name:${sel}` : null
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

// A card's number, Enter on it or a click on its nickname: a card with decisions to review opens its review sheet; on a card waiting on you
// that switches the band to it (and the switch prints it); any other card is only chosen.
async function pickCard($: EngineInterface, s: Session) {
  sel = s.key
  follow = true
  if ((s.review ?? 0) > 0 && s.path) return openReview($, s)
  if (s.pending && s.key !== focus.current) await act($, ['focus-pick', s.key])
  $.ui.invalidate('ui.render')
  const res = await $.ui.focus({ requestId: PANE, key: `name:${s.key}` }).catch(() => ({ deny: 'failed' }))
  if (!res.deny) held = ring.indexOf(`name:${s.key}`)
}

// The recap popover's p: a card waiting on you that is not on the band switches first (the switch prints it).
async function printCard($: EngineInterface, s: Session) {
  sel = s.key
  if (s.pending && s.key !== focus.current) await act($, ['focus-pick', s.key])
  else void show($, s.tag, s.key === focus.current ? s.key : null)
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
const emptyView = (): SheetView => ({ sel: null, input: null, expanded: new Set(), asking: new Map() })

// `console.mjs review <sub> --path <worktree>`; a failure toasts the line it printed and gives null.
async function reviewCall($: EngineInterface, r: Review, sub: string, args: string[] = [], timeoutMs = 60_000): Promise<string | null> {
  let res: { exitCode: number; stdout: string; stderr: string }
  try {
    res = await run($, ['review', sub, '--path', r.path, ...args], timeoutMs)
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

// `review data`: only the first load asks for the PR (`--json` calls gh); a sheet with nothing left pending closes the round.
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
  if (allDone(sheet)) await finishReview($, r)
}

async function openReview($: EngineInterface, s: Session) {
  review = { tag: s.tag, path: s.path!, sheet: null, view: emptyView(), top: 0, finishing: false }
  pop = null
  $.ui.invalidate('ui.render')
  await loadSheet($, review, true)
}

// Every item passed or edited: `review done` sends the result back to the child session, and the pane goes back to the cards.
async function finishReview($: EngineInterface, r: Review) {
  if (r.finishing) return
  r.finishing = true
  const out = await reviewCall($, r, 'done')
  r.finishing = false
  if (out === null) return
  if (out) $.ui.toast(out.split('\n').map(l => l.trim()).filter(Boolean).join(' · '))
  if (review === r) leaveReview($)
  await poll($)
}

// After an item is settled the selection moves on to the next pending one.
async function settle($: EngineInterface, r: Review, sub: string, args: string[], n: number | null) {
  if ((await reviewCall($, r, sub, args)) === null) return
  if (review !== r || !r.sheet) return
  r.view.sel = nextPending(r.sheet, n) ?? r.view.sel
  await loadSheet($, r)
}

function passItem($: EngineInterface, r: Review, n: number) {
  const x = r.sheet && itemOf(r.sheet, n)
  if (!x || x.status !== 'pending' || r.view.input) return
  r.view.sel = n
  x.status = 'passed'
  return settle($, r, 'pass', ['--n', String(n)], n)
}

function passPast($: EngineInterface, r: Review) {
  if (!r.sheet || r.view.input || !canPassAll(r.sheet, r.view.sel)) return
  return settle($, r, 'pass-all', [], r.sheet.past.at(-1)?.n ?? null)
}

function openInput($: EngineInterface, r: Review, mode: 'edit' | 'ask') {
  const x = r.sheet && itemOf(r.sheet, r.view.sel)
  if (!x || x.status !== 'pending') return
  r.view.input = { n: x.n, mode }
  startRepin()
  $.ui.invalidate('ui.render')
}

// An empty 問 asks for an example; `review ask` may take a minute, so it runs in the background and the sheet redraws when it returns.
async function submitInput($: EngineInterface, r: Review, value: string) {
  const open = r.view.input
  if (!open || review !== r) return
  const text = value.trim()
  r.view.input = null
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

function deepTalk($: EngineInterface, r: Review) {
  const x = r.sheet && itemOf(r.sheet, r.view.sel)
  if (x && !r.view.input) void $.prompt.submit({ text: deepTalkText(r.sheet!, x) }).catch(() => {})
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
  const room = dock ? Math.max(1, e.props.scroll.bodyRows - keys.length - 1) : lines.length
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
    return <Button key={`item:${l.n}`} label={label} plain autoFocus={isSel && !r.view.input ? true : undefined} onPress={() => void passItem($, r, l.n)}>{shown ? runs(l, `item-text:${l.n}`) : null}</Button>
  }
  const hiddenItems = (part: SheetLine[], key: string) => (
    <Box key={key} height={0} flexShrink={0} overflow="hidden">{part.flatMap(l => (l.kind === 'item' ? [itemButton(l, false)] : []))}</Box>
  )
  const row = (l: SheetLine) => {
    if (l.kind === 'input') {
      order.push(REVIEW_INPUT)
      return (
        <Box key={`row:${l.key}`} flexDirection="row" height={1} flexShrink={0}>
          <Text>{' '.repeat(MARK_COLS * 2)}</Text>
          <Box key="review-input-box" width={Math.max(1, cols - MARK_COLS * 2)} flexShrink={0}>
            <Input key={REVIEW_INPUT} label={`${l.mode === 'edit' ? EDIT_LABEL : ASK_LABEL} `} placeholder={l.mode === 'ask' ? ASK_HINT : undefined} submitLabel={l.mode === 'edit' ? '改' : '問'} onSubmit={value => void submitInput($, r, value)} />
          </Box>
        </Box>
      )
    }
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
  ]
  const tree = (
    <Box flexDirection="column" {...bg}>
      {above}
      {body}
      {below}
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
    const res = await next(e)
    if (e.agentId === undefined) {
      if (recapHandle) void pollRecap($)
      turning = false
      if (focus.active) void poll($)
    }
    return res
  })

  // The engine walks ↑↓ one Button back or forth through the pane, keeping its place by index: a step from where it held is one card up or down.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (review) {
      // ↑↓ step one item; moving off an open field cancels it.
      const items = review.sheet ? sheetItems(review.sheet).map(x => x.n) : []
      if (e.element === REVIEW_INPUT) return next(e)
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
      const cell = reviewing > 0 ? REVIEW_STATUS : statusCell(r.status, animationTick, { primary: r.key === primaryKey(), animated: appearance.motion })
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
      const tag = truncateColumns(r.tag, Math.max(1, room - CORNER_GAP - QUESTION_MIN, Math.min(TAG_MIN, room - 1)))
      const questionWidth = Math.max(0, room - columns(tag) - CORNER_GAP)
      const question = questionWidth >= 2 ? truncateColumns(r.question.replace(/\s+/g, ' ').trim(), questionWidth) : ''
      const name = <Text color={isSel ? theme.accent : theme.fg} bold>{tag}</Text>
      const inner = Math.max(1, head - 3)
      const branch = (r.branch ?? '').trim()
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
                {question && <Text>  </Text>}
                {question && <Box key={`question:${r.key}`} width={questionWidth} flexShrink={0} overflow="hidden"><Text color={theme.dim} wrap="truncate-end">{question}</Text></Box>}
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!focus.active || e.props.hasSurvey) {
      bandKey = null
      syncAnimation($)
      return (!focus.active && recapBand($, e)) || next(e)
    }
    const cur = byKey(focus.current)
    const fullQueue = queueOf()
    const queue = fullQueue.slice(0, QUEUE_MAX)
    if (!cur && queue.length === 0 && !focus.waiting) {
      bandKey = null
      syncAnimation($)
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const theme = THEMES[appearance.theme]
    bandKey = cur?.key ?? null
    syncAnimation($)
    const cols = e.props.bodyColumns
    const cell = cur && statusCell(cur.status, animationTick, { primary: cur.key === primaryKey(), animated: appearance.motion })
    const others = queue.slice(0, cols < 60 ? 1 : QUEUE_MAX)
    const budget = focusBandRows({ cols, maxRows: e.props.maxRows, question: cur?.question ?? '', queue, hiddenCount: fullQueue.length - queue.length, hasCurrent: !!cur, advice: cur?.advice ?? null, options: cur?.options ?? [] })
    const paint = advicePaint(theme)
    const rail = <Text color={cell ? theme[cell.color] : theme.dim}>│ </Text>
    const label = `── 待回覆 ${cur ? 1 : 0}/${fullQueue.length + (cur ? 1 : 0)} `
    const head = Math.max(1, cols - 4)
    const actionsWidth = SHOW_WIDTH + (queue.length > 0 ? LATER_WIDTH : 0)
    const keyItems = [
      rail,
      ...(others.length ? [<Text color={theme.dim}>其他 </Text>] : []),
      ...others.map((q, i) => <Box key={`other:${i}`} flexDirection="row"><Button key={`queue:${i}`} hotkey={String(i + 1)} label={budget.queueLabels[i]!} plain dimColor onPress={() => act($, ['focus-pick', q.key])} /><Text color={theme.dim}> · </Text></Box>),
      ...(fullQueue.length > others.length ? [<Text color={theme.dim}>{`＋${fullQueue.length - others.length} · `}</Text>] : []),
      <Button key="pane" hotkey="0" label="面板" plain onPress={() => void openPane($)} />,
    ]
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row"><Text color={theme.dim}>{label}</Text><Text color={theme.border}>{'─'.repeat(Math.max(0, cols - columns(label)))}</Text></Box>
        <Box flexDirection="row" paddingLeft={2} height={1} flexShrink={0}>
          {rail}
          {cur && cell ? (
            <Box key="band-head" flexDirection="row" width={head} flexShrink={0} justifyContent="space-between">
              <Box flexDirection="row" flexShrink={1} overflow="hidden">
                <Text color={theme[cell.glyphColor]}>{cell.glyph}</Text>
                <Text color={theme[cell.color]}>{` ${cell.label}${' '.repeat(Math.max(0, 6 - columns(cell.label)))}  `}</Text>
                <Box key="band-name" flexShrink={0}><Text bold color={theme.fg}>{truncateColumns(cur.tag, Math.max(1, head - BAND_STATUS - actionsWidth - 1))}</Text></Box>
              </Box>
              <Box key="band-actions" flexDirection="row" width={actionsWidth} flexShrink={0} justifyContent="flex-end">
                {queue.length > 0 && <Box flexDirection="row"><Button key="later" hotkey="8" label="延後處理" plain onPress={() => act($, ['focus-later'])}><Text color={theme.dim}>延後處理</Text></Button><Text color={theme.dim}> · </Text></Box>}
                <Button key="show" hotkey="9" label="顯示問題" plain onPress={() => void show($, cur.tag, cur.key)}><Text color={theme.dim}>顯示問題</Text></Button>
              </Box>
            </Box>
          ) : <Text color={theme.dim}>{`等 ${focus.waiting?.tag ?? '—'} 回應中…`}</Text>}
        </Box>
        {cur && budget.question > 0 && <Box flexDirection="row" paddingLeft={2} height={budget.question} flexShrink={0} overflow="hidden">{rail}<Box key="question" width={Math.max(1, cols - 6)} flexShrink={0}><Text color={theme.fg} wrap="truncate-end">{budget.questionText}</Text></Box></Box>}
        {cur && budget.advice > 0 && <Box flexDirection="row" paddingLeft={2} height={budget.advice} flexShrink={0} overflow="hidden">{rail}<Box key="advice" flexDirection="row" width={Math.max(1, cols - 6)} flexShrink={0}>{budget.adviceParts.map(p => <Text key={`advice:${p.role}`} color={paint[p.role].color} bold={paint[p.role].bold}>{p.text}</Text>)}</Box></Box>}
        <Box key="keys" flexDirection="column" height={budget.keys} flexShrink={0}>
          {budget.keyLines.map((items, row) => <Box key={`keys:${row}`} flexDirection="row" paddingLeft={2} height={1} flexShrink={0}>
            {items.map(item => <Box key={`key:${item.index}`} width={item.width} flexShrink={0}>{keyItems[item.index]}</Box>)}
          </Box>)}
        </Box>
        <Box height={0} overflow="hidden">{queue.slice(others.length).map((q, j) => <Button key={`queue:${others.length + j}`} hotkey={String(others.length + j + 1)} label="" plain onPress={() => act($, ['focus-pick', q.key])} />)}</Box>
      </Box>
    )
  })
}
