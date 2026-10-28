import type { EngineInterface, Register } from 'claude-code'
import { loadAppearance, THEMES, type Appearance, type ConsoleTheme } from './console-theme.ts'
import { statusCell, columns, truncateColumns } from './status-view.ts'
import { registerKeepaliveView } from './keepalive-view.tsx'
import { refreshSummary, registerSummaryView, startSummary, summaryBand } from './session-summary-view.tsx'

type Status = '等待回應' | '等待授權' | '回覆完畢' | '執行中' | '閒置'

type Session = {
  key: string
  id: string
  tag: string
  repo: string
  status: Status
  stage: string
  summary: string
  question: string
  options: string[]
  advice?: Advice | null
  brief?: Brief | null
  archived: boolean
  pending: boolean
  report: string
}

// The advisor's prediction for the question, read by `console.mjs focus`: still running, or ready with an answer and a reason.
// `auto`: the type is open for auto-reply, so the band counts down `seconds` and then sends `answer`.
type Advice = { state: 'pending' | 'ready'; text: string; answer?: string; reason?: string; principle?: string | null; auto?: { answer: string; meaning: string; seconds: number } }

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
const BRIEF = 'worktree-console-brief'
const BRIEF_EMPTY = '還沒有摘要'
const BRIEF_PENDING = '摘要產生中…'
const QUEUE_MAX = 5
const TOAST_MAX = 30
const SUMMARY_MAX = 20
const CORNER_GAP = 2
const REPO_MIN = 4
const SENT_MAX = 50
const MISS_TOAST = 3
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
const FOOTER = 'qwe 切分頁 · 1-9,0/↑↓ 選卡片'
// Rows of the pane above the cards: the tab row and its underline.
const CHROME = 2
// The keys line after the last card and the gap above it, drawn only once the cards are scrolled to the end.
const FOOT = 2
const CARD_ROWS = 5

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

// Only a leading count lifts to the foreground; digits inside words (面板 v2 改版) stay dim.
const leadNumbers = (Text: (props: any) => any, text: string, theme: ConsoleTheme) => {
  const lead = /^\d+(?=\s)/.exec(text)?.[0]
  // The quiet part is its own run: a parent colour would leak into neutral's colourless fg.
  return lead ? [<Text key="lead" color={theme.fg}>{lead}</Text>, <Text key="rest" color={theme.dim}>{text.slice(lead.length)}</Text>] : <Text color={theme.dim}>{text}</Text>
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
// The console's own model turn: a /focus-show sent during it would wait in the input queue, so announces hold until it ends.
let turning = false
const sent: string[] = []
const misses = new Map<string, number>()
let appearance: Appearance = { theme: 'neutral', motion: true }
let animation: { cancel(): void } | null = null
let animationTick = 0
let visibleKeys: string[] = []
let bandKey: string | null = null
const warned = new Set<string>()
let inHerdr = false
// One question counts down at a time, the one on the band; a question counted once is never counted again (sent, cancelled or refused).
let countdown: { key: string; tag: string; answer: string; meaning: string; until: number; left: number } | null = null
let countdownTick: { cancel(): void } | null = null
const counted = new Set<string>()
let sending = false
let briefFor: { key: string; tag: string } | null = null
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

function visibleAnimationFrame(tick: number): number {
  const primary = primaryKey()
  let frame = 0
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

// A card's rows as drawn: frame, header, question, corner line; plus its repo rule outside 待回覆.
function blockRows(rows: Session[], i: number, first: number): number {
  const r = rows[i]!
  const rule = tab !== 'pending' && (i === first || r.repo !== rows[i - 1]!.repo) ? (i === first ? 1 : 2) : 0
  return CARD_ROWS + rule
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

function run($: EngineInterface, args: string[]) {
  return $.process.run(['node', `${$.plugin.root}/skills/worktree-console/scripts/console.mjs`, ...args], { timeoutMs: 60_000 })
}

// Prints one question's full report through the focus-show mod, never through the model. A stop counts as printed only when
// /focus-show answered with its report; anything else is sent again on the next poll, with a toast after 3 misses in a row.
async function show($: EngineInterface, tag: string, key: string | null = null) {
  const s = sessions().find(x => x.tag === tag)
  if (!s || !focus.home) return
  await $.fs.write(`${focus.home}/show/${encodeURIComponent(tag)}.md`, s.report)
  const id = key && s.id
  if (id) await $.fs.write(`${focus.home}/show/${encodeURIComponent(tag)}@${id}.md`, s.report)
  const res = await $.command.run({ command: 'focus-show', args: id ? `${tag} ${id}` : tag }).catch(() => null)
  if (!key) {
    if (!res) $.ui.toast('印不出題目：需要另外安裝 focus-show')
    return
  }
  if (res?.text === s.report) {
    misses.delete(key)
    await run($, ['focus-shown', key]).catch(() => {})
    return
  }
  if (res?.text) return
  const i = sent.indexOf(key)
  if (i >= 0) sent.splice(i, 1)
  const n = (misses.get(key) ?? 0) + 1
  misses.set(key, n)
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
async function tickCountdown($: EngineInterface) {
  if (!countdown) return
  countdown.left = Math.max(0, Math.ceil((countdown.until - (await $.clock.now())) / 1000))
  $.ui.invalidate('ui.render')
  if (countdown.left === 0 && !turning) await sendAuto($)
}

// 6, or the countdown at 0: `console.mjs focus-auto` records the auto-reply through the advisor and sends it with `reply`.
async function sendAuto($: EngineInterface) {
  if (!countdown || sending) return
  const key = countdown.key
  sending = true
  stopCountdown()
  try {
    await act($, ['focus-auto', key])
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

async function poll($: EngineInterface) {
  let next: Focus = { active: false }
  try {
    next = JSON.parse((await run($, ['focus', ...(sessionId ? ['--session', sessionId] : [])])).stdout)
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
  if (!sel || !pane?.isFocused) return endRepin()
  const want = `name:${sel}`
  const res = await $.ui.focus({ requestId: PANE, key: want }).catch(() => ({ deny: 'failed' }))
  if (!res.deny && at === drawing) return void ((held = ring.indexOf(want)), endRepin())
  if (res.deny && ++repinTries >= REPIN_TRIES) return endRepin()
  $.ui.invalidate('ui.render')
}

async function openPane($: EngineInterface) {
  showTab('pending')
  startRepin()
  // Asked within the press itself, so the engine seats the pane at any width; an open after an await counts as unasked.
  const opened = $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
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
  if (s.pending && s.key !== focus.current) await act($, ['focus-pick', s.key])
  $.ui.invalidate('ui.render')
  const res = await $.ui.focus({ requestId: PANE, key: `name:${s.key}` }).catch(() => ({ deny: 'failed' }))
  if (!res.deny) held = ring.indexOf(`name:${s.key}`)
}

// The recap dialog's 印出完整回報, as Enter on a card once did: a card waiting on you that is not on the band switches first (the switch prints it).
async function printCard($: EngineInterface, s: Session) {
  sel = s.key
  if (s.pending && s.key !== focus.current) await act($, ['focus-pick', s.key])
  else void show($, s.tag, s.key === focus.current ? s.key : null)
  $.ui.invalidate('ui.render')
}

// Enter on a card, or a click on its nickname, opens that session's recap in a dialog Esc closes; nothing reaches the conversation.
async function openBrief($: EngineInterface, s: Session) {
  sel = s.key
  briefFor = { key: s.key, tag: s.tag }
  const opened = $.ui.open({ id: BRIEF, title: `${s.tag} 摘要`, focus: true, closeOnEscape: true })
  $.ui.invalidate('ui.render')
  await opened
}

const briefSession = () => (briefFor ? (byKey(briefFor.key) ?? sessions().find(s => s.tag === briefFor!.tag) ?? null) : null)

// The 封存 tab's button: runs `console.mjs unarchive` straight from the mod, so nothing reaches the conversation.
async function unarchiveCard($: EngineInterface, s: Session) {
  try {
    await run($, ['unarchive', s.tag])
  } catch {}
  await poll($)
}

const countsText = () => {
  const count = (s: Status) => sessions().filter(x => !x.archived && x.status === s).length
  return `工作中 ${count('執行中')} · 已回覆 ${count('回覆完畢')}`
}

// The worktree-console focus band: polls `console.mjs focus`, draws the question on screen, the queue, the side pane and the counts.
export const register: Register = on => {
  registerKeepaliveView(on)
  registerSummaryView(on)
  on('session.start', async ($, e, next) => {
    inHerdr = (await $.env.get('HERDR_ENV')) === '1'
    await startSummary($)
    if ((await $.env.get('ORCA_TERMINAL_HANDLE')) || inHerdr) {
      sessionId = await $.session.id().catch(() => '')
      void poll($)
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
      refreshSummary($)
      turning = false
      if (focus.active) void poll($)
    }
    return res
  })

  // The engine walks ↑↓ one Button back or forth through the pane, keeping its place by index: a step from where it held is one card up or down.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
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
    reveal(rows, rows.indexOf(target))
    $.ui.invalidate('ui.render')
    const want = `name:${target.key}`
    const res = await next({ ...e, element: want })
    if (!res.deny) held = ring.indexOf(want)
    return res
  })

  // The pane keeps its own window over the cards, the keys line riding after the last one: the wheel moves a card, a page key a screenful.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!focus.active || !frame) return next(e)
    const rows = rowsOf(tab)
    const page = !e.pointer && Math.abs(e.by) >= e.bodyRows
    top += Math.sign(e.by) * (page ? Math.max(1, endOf(rows, top) - top) : 1)
    clampTop(rows)
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      visibleKeys = []
      syncAnimation($)
    }
    if (e.id === BRIEF) briefFor = null
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!focus.active) return <Text dimColor>中控台沒有在專注模式</Text>
    const cols = e.props.bodyColumns
    const theme = THEMES[appearance.theme]
    const dock = e.props.placement === 'dock'
    const rows = rowsOf(tab)
    const chosen = chosenOf(rows)
    frame = dock ? { avail: Math.max(1, e.props.scroll.bodyRows - CHROME) } : null
    if (chosen !== sel) (sel = chosen), (follow = true)
    if (follow) reveal(rows, rows.findIndex(r => r.key === chosen))
    follow = false
    clampTop(rows)
    const end = endOf(rows, top)
    visibleKeys = rows.slice(top, end).map(r => r.key)
    syncAnimation($)
    ring = [...TABS.map(x => `tab:${x.id}`), ...rows.flatMap((r, i) => [...(numberOf(tab, i) ? [`num:${r.key}`] : []), `name:${r.key}`])]
    const at = (drawing += 1)
    if (repin) {
      const gen = repinGen
      $.clock.after(FRAME_MS, () => void focusSel($, at, gen))
    }
    // Keep the selected label intact; only unselected labels shorten below 46 columns.
    const tabLabels = TABS.map(x => `${cols < 46 && x.id !== tab ? '' : `${x.label} `}${rowsOf(x.id).length}`)
    const tabIndex = TABS.findIndex(x => x.id === tab)
    const tabStart = TABS.slice(0, tabIndex).reduce((n, x, i) => n + columns(`${x.key}: ${tabLabels[i]}`) + 2, 0)
    const tabWidth = Math.min(Math.max(0, cols - tabStart), columns(`${TABS[tabIndex]!.key}: ${tabLabels[tabIndex]}`))
    const tabs = (
      <Box key="tabs" flexDirection="row" columnGap={2} height={1} flexShrink={0} overflow="hidden">
        {TABS.map((x, i) => (
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
    const hidden = tab === 'hidden'
    const press = (r: Session) => (hidden ? unarchiveCard($, r) : openBrief($, r))
    const inner = Math.max(1, cols - 6)
    const card = (r: Session, i: number) => {
      const isSel = r.key === chosen
      const num = numberOf(tab, i)
      const cell = statusCell(r.status, animationTick, { primary: r.key === primaryKey(), animated: appearance.motion })
      // Stage is the ticket's progress, not a repo attribute: a quiet header tag where the name can spare it, else first on the bottom row.
      const stageWord = r.stage !== '—' && r.stage !== '未開工' ? r.stage : ''
      const stageInHeader = !!stageWord && cols >= 46
      // The advisor's suggestion is ready: ✓ 建議, only the ✓ below 46 columns.
      const ready = r.advice?.state === 'ready'
      const hintWidth = ready ? (cols >= 46 ? 7 : 2) : 0
      const tag = truncateColumns(r.tag, Math.max(1, inner - 13 - (hidden ? 10 : 0) - (stageInHeader ? 7 : 0) - hintWidth))
      const summary = truncateColumns(r.summary, cols <= 36 ? 15 : SUMMARY_MAX)
      const room = inner - columns(summary) - CORNER_GAP - (stageWord && !stageInHeader ? columns(stageWord) + 3 : 0)
      const repo = tab === 'pending' && room >= REPO_MIN && cols > 36 ? truncateColumns(r.repo, room) : ''
      return (
        <Box key={`card:${r.key}`} flexDirection="column" flexShrink={0} borderStyle={isSel ? 'double' : 'round'} borderColor={isSel ? theme.accent : theme.border} paddingX={2}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row">
              <Box key={`number:${r.key}`} width={3} flexShrink={0} overflow="hidden">{num ? <Button key={`num:${r.key}`} hotkey={num} label="" plain onPress={() => pickCard($, r)} /> : <Text>   </Text>}</Box>
              <Box flexDirection="row"><Box key={`status:${r.key}`} flexDirection="row" width={8} flexShrink={0}><Text color={theme[cell.glyphColor]}>{cell.glyph}</Text><Text color={theme[cell.color]}>{` ${cell.label}${' '.repeat(Math.max(0, 6 - columns(cell.label)))}`}</Text></Box><Text>  </Text></Box>
              {hidden && <Text color={theme.fg}>{`${tag}  `}</Text>}
              <Button key={`name:${r.key}`} label={hidden ? '取消封存' : tag} plain autoFocus={isSel ? true : undefined} onPress={() => press(r)} />
            </Box>
            {(ready || stageInHeader) && (
              <Box key={`right:${r.key}`} flexDirection="row" flexShrink={0}>
                {ready && <Box key={`hint:${r.key}`} flexDirection="row" flexShrink={0} marginLeft={1}><Text color={theme.accent}>✓</Text>{cols >= 46 && <Text color={theme.dim}> 建議</Text>}</Box>}
                {stageInHeader && <Box key={`stage:${r.key}`} width={columns(stageWord)} flexShrink={0} marginLeft={1}><Text color={theme.dim}>{stageWord}</Text></Box>}
              </Box>
            )}
          </Box>
          <Text color={theme.dim} wrap="truncate-end">{truncateColumns(r.question.replace(/\s+/g, ' ').trim(), inner)}</Text>
          <Box flexDirection="row" justifyContent="space-between">
            <Box key={`corner:${r.key}`} flexDirection="row" flexShrink={0}>
              <Text wrap="truncate-end" color={theme.dim}>{stageInHeader || !stageWord ? repo : `${stageWord}${repo ? ` · ${repo}` : ''}`}</Text>
            </Box>
            <Box key={`summary:${r.key}`} flexDirection="row" flexShrink={0}>
              <Text wrap="truncate-end">{leadNumbers(Text, summary, theme)}</Text>
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
          <Box key={`repo:${r.repo}`} flexShrink={0} marginTop={j === 0 ? 0 : 1}>
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
    return (
      <Box flexDirection="column" height={dock ? e.props.scroll.bodyRows : undefined} {...('bg' in theme ? { backgroundColor: theme.bg } : {})}>
        {tabs}
        <Text color={theme.border}>{'─'.repeat(Math.min(cols, tabStart))}<Text color={theme.accent}>{'━'.repeat(tabWidth)}</Text>{'─'.repeat(Math.max(0, cols - tabStart - tabWidth))}</Text>
        <Box key="cards" flexDirection="column" flexShrink={1} overflow="hidden">
          {offscreen('above', rows.slice(0, top), 0)}
          {rows.length === 0 ? empty : body}
          {offscreen('below', rows.slice(end), end)}
        </Box>
        {top >= lastTop(rows) && (
          <Box key="footer" flexShrink={0} marginTop={1} paddingLeft={1}>
            <Text color={theme.dim}>{FOOTER}</Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: BRIEF }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const theme = THEMES[appearance.theme]
    const s = briefSession()
    if (!s) return <Text color={theme.dim}>{BRIEF_EMPTY}</Text>
    const brief = s.brief ?? null
    return (
      <Box flexDirection="column" {...('bg' in theme ? { backgroundColor: theme.bg } : {})}>
        <Box key="brief-text">{brief?.text ? <Text color={theme.fg} wrap="wrap">{brief.text}</Text> : <Text color={theme.dim}>{brief?.pending ? BRIEF_PENDING : BRIEF_EMPTY}</Text>}</Box>
        {brief?.text && brief.pending ? <Box key="brief-pending"><Text color={theme.dim}>{`新的${BRIEF_PENDING}`}</Text></Box> : null}
        <Box key="brief-actions" marginTop={1} flexDirection="row">
          <Button
            key="brief-print"
            label="印出完整回報"
            autoFocus
            onPress={async () => {
              await $.ui.close({ id: BRIEF }).catch(() => {})
              await printCard($, s)
            }}
          />
          <Text color={theme.dim}>  Esc 關閉</Text>
        </Box>
      </Box>
    )
  })

  // The console's counts sit after 「auto mode on」 under the prompt box; any other session keeps the engine's hint.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!focus.active) return next(e)
    return next({ ...e, props: { ...e.props, tail: countsText() } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!focus.active || e.props.hasSurvey) {
      bandKey = null
      syncAnimation($)
      return (!focus.active && summaryBand($, e)) || next(e)
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
    const paint: Record<AdvicePart['role'], { color: string | undefined; bold?: boolean }> = {
      label: { color: theme.accent },
      answer: { color: theme.fg, bold: true },
      option: { color: theme.fg },
      reason: { color: theme.muted ?? theme.dim },
      note: { color: theme.waiting },
      pending: { color: theme.dim },
    }
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
            <Button key="auto-now" hotkey="6" label="立即送出" plain onPress={() => void sendAuto($)}><Text color={theme.fg}>立即送出</Text></Button>
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
