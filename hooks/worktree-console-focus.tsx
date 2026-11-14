import type { EngineInterface, Register } from 'claude-code'
import { loadAppearance, THEMES, type Appearance, type ConsoleTheme } from './console-theme.ts'
import { statusCell, columns, truncateColumns, wrapRanges } from './status-view.ts'
import { registerKeepaliveView } from './keepalive-view.tsx'
import { SUMMARY_MAX_LINES, summaryLines } from './session-summary-view.tsx'

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
  // Waiting in 待決 rather than on the band.
  decide?: boolean
}

// The advisor's prediction for the question, read by `console.mjs focus`: still running, or ready with an answer and a reason.
// `auto`: the type is open for auto-reply, so the band counts down `seconds` and then sends `answer`.
type Advice = { state: 'pending' | 'ready'; text: string; answer?: string; reason?: string; principle?: string | null; auto?: { answer: string; meaning: string; seconds: number } }

// The tab's newest plain-language recap, written in the background after each stop.
type Brief = { text: string | null; pending: boolean }

// A second-tier question waiting in 待決 (automation.json batch on): approving sends the advisor's answer as is.
type Decision = {
  id: string
  key: string
  tag: string
  repo: string
  group: string
  verb: string | null
  action: string
  question: string
  context?: string
  options: string[]
  answer: string
  reason: string
  precedent?: { question: string; answer: string } | null
  failed: boolean
}

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
  decisions?: Decision[]
}

type Tab = 'pending' | 'all' | 'hidden' | 'decisions'

const POLL_MS = 5_000
const IDLE_EVERY = 3
const PANE = 'worktree-console-pending'
const PANE_TITLE = '中控台'
const BRIEF_EMPTY = '還沒有摘要'
const BRIEF_PENDING = '摘要產生中…'
const QUEUE_MAX = 5
const TOAST_MAX = 30
const SUMMARY_MAX = 20
const CORNER_GAP = 2
// A long 代號 is cut before the repo on its header row drops below REPO_MIN; where the row cannot hold both, the 代號 keeps TAG_MIN.
const REPO_MIN = 8
const TAG_MIN = 4
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
const DECIDE_ROWS = 3
export const MARK_SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
export const MARK_STILL = '✻'
// The popover's rows around its text: the title rule and the bottom rule.
const POP_CHROME = 2

const TABS: { id: Tab; key: string; label: string; pick: (s: Session) => boolean }[] = [
  { id: 'pending', key: 'q', label: '待回覆', pick: s => s.pending },
  { id: 'all', key: 'w', label: '全部', pick: s => !s.archived },
  { id: 'hidden', key: 'e', label: '封存', pick: s => s.archived },
]
// 待決 exists only while `console.mjs focus` sends `decisions`, i.e. automation.json turns batch approval on.
const DECIDE_TAB = { id: 'decisions' as Tab, key: 'r', label: '待決', pick: (_: Session) => false }
const DECIDE_EMPTY = '沒有等你核可的動作'
const DECIDE_EMPTY_HINT = '刪遠端 branch、@ 同事這類題會排到這裡'
const DECIDE_FOOTER = ['Enter 詳情 · y 核可 · m 自己回', 'a 全部核可 · qwer 切分頁']
const MANUAL = '自己回'
const APPROVE = '✓ 核可'
const APPROVE_FAILED = '送出失敗'
const DECIDE_TIMEOUT_MS = 300_000

const EMPTY = '目前沒有符合條件的 session'
// The band header's right side: `9: 顯示問題`, led by `8: 延後處理 · ` while the queue has one; four cells per hotkey decoration.
const SHOW_WIDTH = 4 + 8
const LATER_WIDTH = 4 + 8 + 3
// The band header's status cell: glyph, a space, the label padded to 6 cells, two spaces.
const BAND_STATUS = 10
// The countdown row's right side: `6: 立即送出 · 7: 取消`, four cells per hotkey decoration.
const COUNTDOWN_KEYS = 4 + 8 + 3 + 4 + 4

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

type Popover = { title: Run; keys: string; lines: Run[][]; print?: () => void }

function briefPopover(s: Session, width: number, theme: ConsoleTheme): Popover {
  const brief = s.brief ?? null
  const runs: Run[] = [
    brief?.text ? { text: brief.text, color: theme.fg } : { text: brief?.pending ? BRIEF_PENDING : BRIEF_EMPTY, color: theme.dim },
    ...(brief?.text && brief.pending ? [{ text: `\n新的${BRIEF_PENDING}`, color: theme.dim }] : []),
  ]
  return { title: { text: `${s.tag} 摘要`, color: theme.accent, bold: true }, keys: 'p 印出完整回報', lines: wrapRuns(runs, width) }
}

// A 待決 popover: the whole question, then the child's whole reply, the options, the advisor's suggestion and the precedent it leaned on.
function decisionPopover(d: Decision, width: number, theme: ConsoleTheme): Popover {
  const paint = advicePaint(theme)
  const picked = pickedOptions(d.answer)
  const quiet = theme.muted ?? theme.dim
  const label = (text: string): Run[] => [{ text: '\n\n' }, { text, color: theme.accent, bold: true }, { text: '\n' }]
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
  const option = (o: string, i: number): Run[] => {
    const bold = picked.has(i) || undefined
    return [
      ...(i ? [{ text: '\n' }] : []),
      { text: `${String.fromCharCode(97 + i)}.`, color: theme.accent, bold: true },
      { text: ` ${flat(o)}`, color: theme.fg, bold },
      ...(bold ? [{ text: ' ✓ 建議', color: theme.accent, bold }] : []),
    ]
  }
  const runs: Run[] = [
    { text: flat(d.question), color: theme.fg, bold: true },
    ...(d.failed ? [{ text: '\n\n上次核可沒送進子 session，可以再核可一次或自己回', color: theme.error }] : []),
    ...(d.context ? [...label('子 session 的回覆'), { text: d.context, color: theme.fg }] : []),
    ...(d.options.length ? [...label('選項'), ...d.options.flatMap(option)] : []),
    ...label('advisor 建議'),
    ...adviceSegments({ state: 'ready', text: '', answer: d.answer, reason: d.reason }, d.options).map(p => ({ text: p.text, color: paint[p.role].color, bold: paint[p.role].bold })),
    ...(d.precedent ? [...label('參考的前例'), { text: `題目：${flat(d.precedent.question)}\n你當時回：${flat(d.precedent.answer)}`, color: quiet }] : []),
  ]
  const keys = deciding.has(d.id) ? '送出中…' : `y ${APPROVE} · m ${MANUAL}`
  return { title: { text: d.action, color: theme.waiting, bold: true }, keys, lines: wrapRuns(runs, width) }
}

// Draws the popover over the cards, under the card whose rows are `start`..`end` (rows of the drawing), or over it when the card sits in
// the pane's lower half; it never reaches past the pane's rows in view, and scrolls its own text.
function popoverBox($: EngineInterface, e: any, p: Popover, at: { start: number; end: number; offset: number }, cols: number, theme: ConsoleTheme) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const view = e.props.scroll.bodyRows as number
  const shown = at.start - at.offset
  const above = shown > view / 2
  const room = above ? shown - CHROME : view - (at.end - at.offset)
  const height = Math.min(p.lines.length + POP_CHROME, Math.max(POP_CHROME + 1, room))
  const rows = height - POP_CHROME
  popView = { rows, total: p.lines.length }
  pop!.at = Math.max(0, Math.min(pop!.at, p.lines.length - rows))
  const from = pop!.at
  const inner = Math.max(1, cols - 2)
  const keys = truncateColumns(p.keys, Math.max(0, cols - 8))
  const title = truncateColumns(p.title.text, Math.max(1, cols - columns(keys) - 7))
  const scroll = p.lines.length > rows ? ` j/k 捲動 · 第 ${from + 1}–${from + rows} 行／共 ${p.lines.length} 行 ` : ''
  const fill = (n: number) => '─'.repeat(Math.max(0, n))
  return (
    <Box key="popover" position="absolute" top={above ? at.start - height : at.end} left={0} width={cols} height={height} flexDirection="column" {...('bg' in theme ? { backgroundColor: theme.bg } : {})}>
      <Box key="popover-title" flexDirection="row" height={1} flexShrink={0}>
        <Text color={theme.accent}>{'── '}</Text>
        <Text color={p.title.color} bold={p.title.bold}>{title}</Text>
        <Text color={theme.accent}>{` ${fill(cols - columns(title) - columns(keys) - 7)} `}</Text>
        <Text color={theme.dim}>{keys}</Text>
        <Text color={theme.accent}>{' ─'}</Text>
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
      <Box key="popover-keys" height={0} flexShrink={0} overflow="hidden">
        <Button key="popover-down" hotkey="j" label="" plain onPress={() => scrollPop($, 1)} />
        <Button key="popover-up" hotkey="k" label="" plain onPress={() => scrollPop($, -1)} />
        {p.print && <Button key="popover-print" hotkey="p" label="" plain onPress={p.print} />}
      </Box>
    </Box>
  )
}

// The options a bare a／b／c answer picks, by index.
function pickedOptions(answer: string): Set<number> {
  if (!/^[a-z](?:\s*[、,，]\s*[a-z])*$/i.test(answer.trim())) return new Set()
  return new Set([...answer.toLowerCase().matchAll(/[a-z]/g)].map(m => m[0].charCodeAt(0) - 97))
}

const advicePaint = (theme: ConsoleTheme): Record<AdvicePart['role'], { color: string | undefined; bold?: boolean }> => ({
  label: { color: theme.accent },
  answer: { color: theme.fg, bold: true },
  option: { color: theme.fg },
  reason: { color: theme.muted ?? theme.dim },
  note: { color: theme.waiting },
  pending: { color: theme.dim },
})

// Only a leading count lifts to the foreground; digits inside words (面板 v2 改版) stay dim.
const leadNumbers = (Text: (props: any) => any, text: string, theme: ConsoleTheme) => {
  const lead = /^\d+(?=\s)/.exec(text)?.[0]
  // The quiet part is its own run: a parent colour would leak into neutral's colourless fg.
  return lead ? [<Text key="lead" color={theme.fg}>{lead}</Text>, <Text key="rest" color={theme.dim}>{text.slice(lead.length)}</Text>] : <Text color={theme.dim}>{text}</Text>
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
let inHerdr = false
// One question counts down at a time, the one on the band; a question counted once is never counted again (sent, cancelled or refused).
let countdown: { key: string; tag: string; answer: string; meaning: string; until: number; left: number; held?: boolean } | null = null
let countdownTick: { cancel(): void } | null = null
const counted = new Set<string>()
let sending = false
const deciding = new Set<string>()
let decideSel: string | null = null
// The one popover on the pane: a card's recap or a 待決 question's detail, `at` its first text line in view.
let pop: { kind: 'brief' | 'decision'; id: string; at: number } | null = null
let popView = { rows: 0, total: 0 }
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

const markSpins = () => appearance.motion && paneFocused && (tab === 'decisions' ? chosenDecision() !== null : sel !== null && visibleKeys.includes(sel))
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
const decisions = () => focus.decisions ?? []
const batchOn = () => Array.isArray(focus.decisions)
// 待決 leads while it holds a question and sits last when empty; every tab keeps its key wherever it stands.
const tabsNow = () => (!batchOn() ? TABS : decisions().length ? [DECIDE_TAB, ...TABS] : [...TABS, DECIDE_TAB])
// Cards in the order the tab draws them: by ticket, each ticket where its first question stopped.
const decisionOrder = () => {
  const groups: { name: string; repo: string; items: Decision[] }[] = []
  for (const d of decisions()) {
    const g = groups.find(x => x.name === d.group)
    if (g) g.items.push(d)
    else groups.push({ name: d.group, repo: d.repo, items: [d] })
  }
  return groups
}
const decisionList = () => decisionOrder().flatMap(g => g.items)
const chosenDecision = () => {
  const list = decisionList()
  return list.find(d => d.id === decideSel) ?? list[0] ?? null
}
const tabCount = (t: Tab) => (t === 'decisions' ? decisions().length : rowsOf(t).length)
const byKey = (key: string | null | undefined) => sessions().find(s => s.key === key) ?? null
const queueOf = () => (focus.queue ?? []).flatMap(q => (byKey(q.key) ? [{ ...byKey(q.key)!, isNew: q.isNew }] : []))
const primaryKey = () => {
  const current = byKey(focus.current)
  if (current?.status === '等待回應' || current?.status === '等待授權') return current.key
  return queueOf().find(s => s.status === '等待回應' || s.status === '等待授權')?.key ?? null
}

// 待回覆 always follows the band: the question on screen first, then the queue in order.
function rowsOf(t: Tab): Session[] {
  if (t === 'decisions') return []
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

// The row a 待決 card's action sits on in the tab's whole drawing, or -1.
function decisionRow(id: string): number {
  let row = CHROME + 1
  for (const g of decisionOrder()) {
    row += 2
    for (const d of g.items) {
      row += 1
      if (d.id === id) return row
      row += DECIDE_ROWS
    }
  }
  return -1
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

function stopCountdown() {
  countdownTick?.cancel()
  countdownTick = null
  countdown = null
}

// Starts the countdown when an open-for-auto-reply question reaches the band, and drops it once that question leaves or loses `auto`.
async function syncCountdown($: EngineInterface) {
  const cur = byKey(focus.current)
  const auto = focus.active ? cur?.advice?.auto : undefined
  if (!cur || !auto) return stopCountdown()
  if (countdown?.key === cur.key || counted.has(cur.key)) return
  stopCountdown()
  counted.add(cur.key)
  const now = await $.clock.now()
  countdown = { key: cur.key, tag: cur.tag, answer: auto.answer, meaning: auto.meaning, until: now + auto.seconds * 1000, left: auto.seconds }
  if (inHerdr) {
    // herdr takes the title first; an option before it is refused.
    void $.process.run(['herdr', 'notification', 'show', `[${cur.tag}] ${auto.seconds} 秒後代回 ${auto.answer}`, '--body', `${auto.meaning} · 6: 立即送出 · 7: 取消`, '--sound', 'request'], { timeoutMs: 10_000 }).catch(() => {})
  }
  countdownTick = $.clock.every(1000, () => void tickCountdown($))
}

// Each second: the row's number goes down; at 0 the answer goes, but not while the console's own turn runs (the user may be answering it).
// A draft in the console's prompt holds the number where it is; once the box is sent or cleared it counts on from there.
async function tickCountdown($: EngineInterface) {
  if (!countdown) return
  const typing = !!(await $.prompt.read().catch(() => null))?.text?.trim()
  const now = await $.clock.now()
  if (!countdown) return
  if (typing || countdown.held) {
    countdown.until = now + countdown.left * 1000
    countdown.held = typing
    return
  }
  countdown.left = Math.max(0, Math.ceil((countdown.until - now) / 1000))
  $.ui.invalidate('ui.render')
  if (countdown.left === 0 && !turning) await sendAuto($, 'tick')
}

// 6, or the countdown at 0: `console.mjs focus-auto` records the auto-reply through the advisor and sends it with `reply`.
async function sendAuto($: EngineInterface, reason: 'tick' | 'key') {
  if (!countdown || sending) return
  const key = countdown.key
  sending = true
  stopCountdown()
  try {
    await act($, ['focus-auto', key, '--owner', owner, '--reason', reason, '--clock', String(await $.clock.now())])
  } finally {
    sending = false
  }
}

// 7: nothing is sent; the question stays on the band as an ordinary one.
async function cancelAuto($: EngineInterface) {
  if (!countdown) return
  const key = countdown.key
  stopCountdown()
  await act($, ['focus-cancel', key])
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
  await syncCountdown($)
  syncAnimation($)
  if (next.active) await announce($, next, pressed)
  $.ui.invalidate('ui.render')
}

async function poll($: EngineInterface, claim = false) {
  let next: Focus = { active: false }
  try {
    next = JSON.parse((await run($, ['focus', ...(sessionId ? ['--session', sessionId] : []), '--owner', owner, ...(claim ? ['--claim'] : [])])).stdout)
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
  decideSel = null
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
  const decision = tab === 'decisions' ? chosenDecision() : null
  const want = decision ? `detail:${decision.id}` : tab !== 'decisions' && sel ? `name:${sel}` : null
  if (!want || !pane?.isFocused) return endRepin()
  const res = await $.ui.focus({ requestId: PANE, key: want }).catch(() => ({ deny: 'failed' }))
  if (!res.deny && at === drawing) return void ((held = ring.indexOf(want)), endRepin())
  if (res.deny && ++repinTries >= REPIN_TRIES) return endRepin()
  $.ui.invalidate('ui.render')
}

async function openPane($: EngineInterface) {
  showTab(decisions().length ? 'decisions' : 'pending')
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

// A card's number only chooses it: on a card waiting on you that switches the band to it (and the switch prints it).
async function pickCard($: EngineInterface, s: Session) {
  sel = s.key
  follow = true
  if (s.pending && !s.decide && s.key !== focus.current) await act($, ['focus-pick', s.key])
  $.ui.invalidate('ui.render')
  const res = await $.ui.focus({ requestId: PANE, key: `name:${s.key}` }).catch(() => ({ deny: 'failed' }))
  if (!res.deny) held = ring.indexOf(`name:${s.key}`)
}

// The recap popover's p: a card waiting on you that is not on the band switches first (the switch prints it).
async function printCard($: EngineInterface, s: Session) {
  sel = s.key
  if (s.pending && !s.decide && s.key !== focus.current) await act($, ['focus-pick', s.key])
  else void show($, s.tag, s.key === focus.current ? s.key : null)
  $.ui.invalidate('ui.render')
}

function togglePop($: EngineInterface, kind: 'brief' | 'decision', id: string) {
  pop = pop?.kind === kind && pop.id === id ? null : { kind, id, at: 0 }
  $.ui.invalidate('ui.render')
}

function scrollPop($: EngineInterface, by: number) {
  if (!pop) return
  pop.at = Math.max(0, Math.min(pop.at + by, popView.total - popView.rows))
  $.ui.invalidate('ui.render')
}

// Enter on a card, or a click on its nickname, opens or closes that session's recap in a popover under the card; nothing reaches the conversation.
function toggleBrief($: EngineInterface, s: Session) {
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

// The chosen card leaving 待決 hands the choice to the card after it (before it, at the end); the focus then goes to the chosen question.
function choiceAfter(ids: string[]) {
  const list = decisionList()
  const was = chosenDecision()?.id ?? null
  const i = list.findIndex(d => d.id === was)
  const next = was && ids.includes(was) ? [...list.slice(i + 1), ...list.slice(0, i).reverse()].find(d => !ids.includes(d.id))?.id ?? null : null
  return { was, next }
}

function moveOn($: EngineInterface, after: { was: string | null; next: string | null }) {
  if (after.next && !decisions().some(d => d.id === after.was)) decideSel = after.next
  if (tab !== 'decisions') return
  startRepin()
  $.ui.invalidate('ui.render')
}

// 待決's 核可 (one card) and 全部核可: runs `console.mjs decide` straight from the mod like 取消封存, then toasts how it went.
async function approveCards($: EngineInterface, id: string | null) {
  const ids = id ? [id] : decisions().map(d => d.id)
  if (ids.length === 0 || ids.some(x => deciding.has(x))) return
  const after = choiceAfter(ids)
  for (const x of ids) deciding.add(x)
  $.ui.invalidate('ui.render')
  let out = ''
  try {
    out = (await run($, id ? ['decide', id, 'approve'] : ['decide', '--all', 'approve'], DECIDE_TIMEOUT_MS)).stdout
  } catch {}
  for (const x of ids) deciding.delete(x)
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
  const sent = lines.filter(l => l.includes('已核可並送出')).length
  const failed = lines.length - sent
  if (id && lines[0]) $.ui.toast(lines[0])
  else if (!id && lines.length) $.ui.toast(`已核可 ${sent} 題${failed ? `，${failed} 題送出失敗` : ''}`)
  await poll($)
  moveOn($, after)
}

// 自己回: `console.mjs decide <id> manual` takes it out of 待決 and puts it first on the band, where the user answers it as usual.
async function manualCard($: EngineInterface, id: string) {
  if (deciding.has(id)) return
  const after = choiceAfter([id])
  deciding.add(id)
  $.ui.invalidate('ui.render')
  let out = ''
  try {
    out = (await run($, ['decide', id, 'manual'])).stdout
  } catch {}
  deciding.delete(id)
  const line = out.trim().split('\n')[0]
  if (line) $.ui.toast(line)
  await poll($)
  moveOn($, after)
}

// Enter on a card, or a click on its question, opens or closes the question's whole context in a popover; nothing reaches the conversation.
function toggleDetail($: EngineInterface, d: Decision) {
  decideSel = d.id
  togglePop($, 'decision', d.id)
}

const SUMMARY_POLL_MS = 3_000
const SUMMARY_PANE = 'worktree-console-summary'
const SUMMARY_LABEL = '摘要'
// The label and the gap after it; wrapped lines start under the text, not under the label.
const SUMMARY_PREFIX = 6
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

// A child session's tab: its newest recap above the prompt once a turn ends; null when there is none to show.
function recapBand($: EngineInterface, e: any) {
  if (!recapHandle || e.props.hasSurvey || e.props.isWorking || (!recap.text && !recap.pending)) return null
  const { Box, Text, Button } = $.ui.resolve(e)
  const theme = THEMES[recapTheme]
  const width = Math.max(1, e.props.bodyColumns - SUMMARY_PREFIX)
  const lines = recap.pending ? [SUMMARY_PENDING] : summaryLines(recap.text!, width, Math.max(1, Math.min(SUMMARY_MAX_LINES, e.props.maxRows - 2)))
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, i) => (
        <Box key={`summary:${i}`} flexDirection="row" height={1} flexShrink={0}>
          <Box key={`summary-label:${i}`} width={SUMMARY_PREFIX} flexShrink={0}>{i === 0 ? <Text color={theme.accent} bold>{SUMMARY_LABEL}</Text> : <Text> </Text>}</Box>
          <Text color={recap.pending ? theme.dim : theme.fg} wrap="truncate-end">{line}</Text>
        </Box>
      ))}
      {!recap.pending && (
        <Box key="summary-keys" flexDirection="row" paddingLeft={SUMMARY_PREFIX} height={1} flexShrink={0}>
          <Button key="summary-full" hotkey="0" label="完整摘要" plain dimColor onPress={() => void $.ui.open({ id: SUMMARY_PANE, title: SUMMARY_LABEL, focus: true, closeOnEscape: true })} />
        </Box>
      )}
    </Box>
  )
}

// 待決: a count with 全部核可 on top, then one card per question grouped by ticket, each with its own 核可; a failed send keeps its card, marked.
function decisionsBody($: EngineInterface, e: any, cols: number, theme: ConsoleTheme) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const list = decisions()
  const inner = Math.max(1, cols - 4)
  const center = (t: string) => `${' '.repeat(Math.max(0, Math.floor((cols - 2 - columns(t)) / 2)))}${t}`
  if (list.length === 0) {
    return (
      <Box key="decide-empty" flexDirection="column" width={cols} borderStyle="round" borderColor={theme.border} paddingY={1}>
        <Text color={theme.fg}>{center(truncateColumns(DECIDE_EMPTY, cols - 2))}</Text>
        <Text color={theme.dim}>{center(truncateColumns(DECIDE_EMPTY_HINT, cols - 2))}</Text>
      </Box>
    )
  }
  const paint = advicePaint(theme)
  const allBusy = list.every(d => deciding.has(d.id))
  // `a: 全部核可`: four cells for the hotkey decoration.
  const allWidth = 4 + columns('全部核可')
  const lead = `${list.length}`
  const tail = ' 題等你核可'
  const more = ' · 核可後照建議送出'
  const headRoom = cols - 2 - allWidth - 1
  const groups = decisionOrder()
  const chosen = chosenDecision()?.id ?? null
  const card = (d: Decision) => {
    const focused = d.id === chosen
    const busy = deciding.has(d.id)
    const failed = d.failed && !busy
    const mark = <Text color={theme.accent} bold={focused || undefined}>{focused ? ` ${markGlyph()} ` : '   '}</Text>
    const rail = <Text>{'   '}</Text>
    // The chosen card names the keys that act on it.
    const approveLabel = focused ? `y ${APPROVE}` : APPROVE
    const manualLabel = focused ? `m ${MANUAL}` : MANUAL
    const rightWidth = (busy ? columns('送出中…') : columns(`${approveLabel} · ${manualLabel}`)) + (failed ? columns(APPROVE_FAILED) + 3 : 0)
    const advice = fitParts(adviceSegments({ state: 'ready', text: '', answer: d.answer, reason: d.reason }, d.options), inner)
    const question = truncateColumns(`${d.tag !== d.group ? `${d.tag} · ` : ''}${d.question}`.replace(/\s+/g, ' ').trim(), inner)
    return (
      <Box key={`decision:${d.id}`} flexDirection="column" flexShrink={0} marginTop={1}>
        <Box key={`decision-head:${d.id}`} flexDirection="row" height={1} flexShrink={0}>
          {mark}
          <Box key={`decision-top:${d.id}`} flexDirection="row" width={inner} flexShrink={0} justifyContent="space-between">
            <Text color={theme.waiting} bold wrap="truncate-end">{truncateColumns(d.action, Math.max(1, inner - rightWidth - 1))}</Text>
            <Box key={`decision-right:${d.id}`} flexDirection="row" flexShrink={0}>
              {failed && <Text color={theme.error}>{APPROVE_FAILED}</Text>}
              {failed && <Text color={theme.dim}> · </Text>}
              {busy ? <Text color={theme.dim}>送出中…</Text> : (
                <Box key={`decision-actions:${d.id}`} flexDirection="row">
                  <Button key={`approve:${d.id}`} label={approveLabel} plain onPress={() => void approveCards($, d.id)}>{focused && <Text color={theme.dim}>y </Text>}<Text color={theme.accent} bold>{APPROVE}</Text></Button>
                  <Text color={theme.dim}> · </Text>
                  <Button key={`manual:${d.id}`} label={manualLabel} plain onPress={() => void manualCard($, d.id)}>{focused && <Text color={theme.dim}>m </Text>}<Text color={theme.fg}>{MANUAL}</Text></Button>
                </Box>
              )}
            </Box>
          </Box>
        </Box>
        <Box key={`decision-question:${d.id}`} flexDirection="row" height={1} flexShrink={0}>
          {rail}
          <Button key={`detail:${d.id}`} label={question} plain autoFocus={focused ? true : undefined} onPress={() => toggleDetail($, d)}><Text color={theme.dim}>{question}</Text></Button>
        </Box>
        <Box key={`decision-advice:${d.id}`} flexDirection="row" height={1} flexShrink={0}>
          {rail}
          {advice.map((p, j) => <Text key={`decision-advice:${d.id}:${j}`} color={paint[p.role].color} bold={paint[p.role].bold}>{p.text}</Text>)}
        </Box>
      </Box>
    )
  }
  const selected = chosenDecision()
  return (
    <Box key="decisions" flexDirection="column">
      <Box key="decide-head" flexDirection="row" justifyContent="space-between" height={1} flexShrink={0} paddingX={1}>
        <Box key="decide-count" flexDirection="row" flexShrink={1} overflow="hidden">
          <Text color={theme.fg} bold>{lead}</Text>
          <Text color={theme.fg}>{tail}</Text>
          {columns(lead + tail + more) <= headRoom && <Text color={theme.dim}>{more}</Text>}
        </Box>
        {allBusy ? <Text color={theme.dim}>送出中…</Text> : <Button key="decide-all" hotkey="a" label="全部核可" plain onPress={() => void approveCards($, null)}><Text color={theme.accent} bold>全部核可</Text></Button>}
      </Box>
      {groups.map(g => {
        const label = `${g.name} · ${g.repo}`
        const count = ` ${g.items.length} 題`
        const name = truncateColumns(label, Math.max(1, cols - columns(count) - 6))
        return (
          <Box key={`decide-group:${g.name}`} flexDirection="column" flexShrink={0} marginTop={1}>
            <Text wrap="truncate-end"><Text color={theme.dim}>{'── '}</Text><Text color={theme.fg} bold>{name}</Text><Text color={theme.dim}>{` ${'─'.repeat(Math.max(2, cols - columns(name) - columns(count) - 4))}${count}`}</Text></Text>
            {g.items.map(card)}
          </Box>
        )
      })}
      <Box key="decide-footer" flexDirection="column" flexShrink={0} marginTop={1} paddingLeft={1}>
        {(columns(DECIDE_FOOTER.join(' · ')) <= cols - 1 ? [DECIDE_FOOTER.join(' · ')] : DECIDE_FOOTER).map((line, i) => <Text key={`decide-footer:${i}`} color={theme.dim} wrap="truncate-end">{truncateColumns(line, cols - 1)}</Text>)}
      </Box>
      <Box key="decide-keys" height={0} flexShrink={0} overflow="hidden">
        <Button key="decide-yes" hotkey="y" label="" plain onPress={() => void (selected && approveCards($, selected.id))} />
        <Button key="decide-manual" hotkey="m" label="" plain onPress={() => void (selected && manualCard($, selected.id))} />
      </Box>
    </Box>
  )
}

// The worktree-console focus band: polls `console.mjs focus`, draws the question on screen, the queue, the side pane and the counts.
export const register: Register = on => {
  registerKeepaliveView(on)
  on('session.start', async ($, e, next) => {
    inHerdr = (await $.env.get('HERDR_ENV')) === '1'
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
    if (tab === 'decisions') {
      // ↑↓ step a whole card and land on its question, and every button that sends hands the focus to a question, so Enter opens the popover and never approves.
      const list = decisionList()
      const hit = /^(detail|approve|manual):(.+)$/.exec(e.element ?? '')
      const sends = /^decide-(all|yes|manual)$/.test(e.element ?? '')
      const n = ring.length
      const to = ring.indexOf(e.element ?? '')
      const from = held !== null && held < n && /^(detail|approve|manual):/.test(ring[held]!) ? held : null
      const dir = e.origin.kind !== 'person' || to < 0 || from === null ? 0 : to === (from + 1) % n ? 1 : to === (from - 1 + n) % n ? -1 : 0
      const i = list.findIndex(d => d.id === chosenDecision()?.id)
      const target = dir !== 0 && i >= 0 ? list[Math.max(0, Math.min(list.length - 1, i + dir))] : hit ? list.find(d => d.id === hit[2]) : sends ? chosenDecision() : undefined
      if (!target) {
        const res = await next(e)
        if (!res.deny) held = to < 0 ? null : to
        return res
      }
      decideSel = target.id
      if (pop && pop.id !== target.id) pop = null
      $.ui.invalidate('ui.render')
      const want = `detail:${target.id}`
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
    if (!focus.active || !frame || tab === 'decisions') return next(e)
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
    if (tab === 'decisions' && !batchOn()) showTab('pending')
    const tabList = tabsNow()
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
    if (pop && (!e.props.isFocused || (pop.kind === 'decision' ? tab !== 'decisions' || !decisions().some(d => d.id === pop!.id) : tab === 'decisions' || tab === 'hidden' || popAt < top || popAt >= end))) pop = null
    ring = [
      ...tabList.map(x => `tab:${x.id}`),
      ...(tab === 'decisions' ? ['decide-all', ...decisionList().flatMap(d => [`approve:${d.id}`, `manual:${d.id}`, `detail:${d.id}`]), 'decide-yes', 'decide-manual'] : []),
      ...rows.flatMap((r, i) => [...(numberOf(tab, i) ? [`num:${r.key}`] : []), `name:${r.key}`]),
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
    const shell = (body: any, extra: any = null) => <Box flexDirection="column" {...('bg' in theme ? { backgroundColor: theme.bg } : {})}>{tabs}{underline}{body}{extra}</Box>
    if (tab === 'decisions') {
      const d = pop?.kind === 'decision' ? decisions().find(x => x.id === pop!.id) : undefined
      const row = d ? decisionRow(d.id) : -1
      const over = d && row >= 0 ? popoverBox($, e, decisionPopover(d, Math.max(1, cols - 2), theme), { start: row, end: row + DECIDE_ROWS, offset: e.props.scroll.offset ?? 0 }, cols, theme) : null
      return shell(decisionsBody($, e, cols, theme), over)
    }
    const hidden = tab === 'hidden'
    const press = (r: Session) => (hidden ? unarchiveCard($, r) : toggleBrief($, r))
    // The header row past the blank column, the mark and the right margin; the question row also leaves the number column blank.
    const head = Math.max(1, cols - 4)
    const onPending = tab === 'pending'
    const card = (r: Session, i: number) => {
      const isSel = r.key === chosen
      const num = numberOf(tab, i)
      const status = statusCell(r.status, animationTick, { primary: r.key === primaryKey(), animated: appearance.motion })
      const cell = r.decide ? { ...status, label: DECIDE_TAB.label } : status
      const mark = <Text color={theme.accent} bold={isSel || undefined}>{isSel ? ` ${markGlyph()} ` : '   '}</Text>
      const rail = <Text>{'   '}</Text>
      // The advisor's suggestion is ready: ✓ 建議, only the ✓ below 46 columns.
      const ready = r.advice?.state === 'ready'
      const hintWidth = ready ? (cols >= 46 ? 7 : 2) : 0
      // The number, status and its gap left of the 代號, plus 取消封存 and its gap after it on 封存.
      const lead = 13 + (hidden ? 10 : 0)
      const room = head - lead - CORNER_GAP - hintWidth
      const tag = truncateColumns(r.tag, Math.max(1, room - REPO_MIN, Math.min(TAG_MIN, room - 1)))
      const repoWidth = Math.max(0, room - columns(tag))
      const repo = truncateColumns(r.repo, repoWidth)
      const name = <Text color={isSel ? theme.accent : theme.fg} bold>{tag}</Text>
      const summary = truncateColumns(r.summary, cols <= 36 ? 15 : SUMMARY_MAX)
      const question = truncateColumns(r.question.replace(/\s+/g, ' ').trim(), Math.max(1, head - 3 - (summary ? columns(summary) + CORNER_GAP : 0)))
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
              {(ready || repoWidth > 0) && (
                <Box key={`right:${r.key}`} flexDirection="row" flexShrink={0}>
                  {ready && <Box key={`hint:${r.key}`} flexDirection="row" width={hintWidth} flexShrink={0}><Text color={theme.accent}>✓</Text>{cols >= 46 && <Text color={theme.dim}> 建議</Text>}</Box>}
                  {repoWidth > 0 && <Box key={`card-repo:${r.key}`} width={repoWidth} flexShrink={0}><Text color={theme.dim} dimColor>{`${' '.repeat(repoWidth - columns(repo))}${repo}`}</Text></Box>}
                </Box>
              )}
            </Box>
          </Box>
          <Box key={`card-question:${r.key}`} flexDirection="row" height={1} flexShrink={0}>
            {rail}
            <Box key={`card-bottom:${r.key}`} flexDirection="row" width={head} flexShrink={0} justifyContent="space-between">
              <Box key={`question:${r.key}`} flexDirection="row" flexShrink={1} overflow="hidden">
                <Text>   </Text>
                <Text color={theme.dim} wrap="truncate-end">{question}</Text>
              </Box>
              <Box key={`summary:${r.key}`} flexDirection="row" flexShrink={0}>
                {onPending ? <Text color={theme.dim} wrap="truncate-end">{summary}</Text> : <Text wrap="truncate-end">{leadNumbers(Text, summary, theme)}</Text>}
              </Box>
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
        </Box>
        {top >= lastTop(rows) && (
          <Box key="footer" flexShrink={0} marginTop={1}>
            <Text color={theme.dim}>{ruledLine(batchOn() ? FOOTER.replace('qwe', 'qwer') : FOOTER, cols)}</Text>
          </Box>
        )}
        {briefOver}
      </Box>
    )
  })

  // The whole recap, uncut, in the side pane 0 opens from a child tab.
  on('ui.render', { component: 'Pane', requestId: SUMMARY_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const theme = THEMES[recapTheme]
    return (
      <Box flexDirection="column" {...('bg' in theme ? { backgroundColor: theme.bg } : {})}>
        <Box key="summary-text">{recap.text ? <Text color={theme.fg} wrap="wrap">{recap.text}</Text> : <Text color={theme.dim}>{BRIEF_EMPTY}</Text>}</Box>
        {recap.pending && <Box key="summary-pending"><Text color={theme.dim}>{`新的摘要${SUMMARY_PENDING}`}</Text></Box>}
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
    const counting = cur && countdown?.key === cur.key ? countdown : null
    const answerRoom = counting ? Math.max(1, cols - 4 - COUNTDOWN_KEYS - 1 - columns(`代回倒數 ${counting.left} 秒：`)) : 0
    const countdownAnswer = counting ? truncateColumns(counting.answer, answerRoom) : ''
    const meaningRoom = counting ? answerRoom - columns(countdownAnswer) - 1 : 0
    const countdownMeaning = counting && countdownAnswer === counting.answer && meaningRoom >= 2 ? truncateColumns(counting.meaning.replace(/\s+/g, ' ').trim(), meaningRoom) : ''
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
        {cur && budget.advice > 0 && counting && <Box flexDirection="row" paddingLeft={2} height={budget.advice} flexShrink={0} overflow="hidden">{rail}<Box key="countdown" flexDirection="row" width={head} flexShrink={0} justifyContent="space-between">
          <Box key="countdown-left" flexDirection="row" flexShrink={1} overflow="hidden">
            <Text color={theme.waiting}>代回倒數 </Text>
            <Text bold color={theme.fg}>{String(counting.left)}</Text>
            <Text color={theme.waiting}> 秒：</Text>
            <Text bold color={theme.fg}>{countdownAnswer}</Text>
            {countdownMeaning ? <Text color={theme.fg}>{` ${countdownMeaning}`}</Text> : null}
          </Box>
          <Box key="countdown-keys" flexDirection="row" width={COUNTDOWN_KEYS} flexShrink={0} justifyContent="flex-end">
            <Button key="auto-now" hotkey="6" label="立即送出" plain onPress={() => void sendAuto($, 'key')}><Text color={theme.fg}>立即送出</Text></Button>
            <Text color={theme.dim}> · </Text>
            <Button key="auto-cancel" hotkey="7" label="取消" plain onPress={() => void cancelAuto($)}><Text color={theme.fg}>取消</Text></Button>
          </Box>
        </Box></Box>}
        {cur && budget.advice > 0 && !counting && <Box flexDirection="row" paddingLeft={2} height={budget.advice} flexShrink={0} overflow="hidden">{rail}<Box key="advice" flexDirection="row" width={Math.max(1, cols - 6)} flexShrink={0}>{budget.adviceParts.map(p => <Text key={`advice:${p.role}`} color={paint[p.role].color} bold={paint[p.role].bold}>{p.text}</Text>)}</Box></Box>}
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
