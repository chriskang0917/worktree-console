import type { EngineInterface, Register } from 'claude-code'
import { loadAppearance, THEMES, type Appearance } from './console-theme.ts'
import { statusCell, columns, truncateColumns } from './status-view.ts'

type Status = '等待回應' | '等待授權' | '回覆完畢' | '執行中' | '閒置'

type Session = {
  key: string
  tag: string
  repo: string
  status: Status
  stage: string
  summary: string
  question: string
  options: string[]
  archived: boolean
  pending: boolean
  report: string
}

type Focus = {
  active: boolean
  home?: string
  current?: string | null
  announce?: string | null
  announceKey?: string | null
  waiting?: { tag: string | null; seconds: number } | null
  queue?: { key: string; isNew: boolean }[]
  unreadable?: string | null
  sessions?: Session[]
}

type Tab = 'pending' | 'all' | 'hidden' | 'idle'

const POLL_MS = 5_000
const IDLE_EVERY = 3
const PANE = 'worktree-console-pending'
const PANE_TITLE = '中控台'
const QUEUE_MAX = 5
const TOAST_MAX = 30
const SUMMARY_MAX = 20
const CORNER_GAP = 2
const REPO_MIN = 4
const SENT_MAX = 50
const MISS_TOAST = 3
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
const FOOTER = 'qwer 切分頁　1-9,0/↑↓ 選卡片'
// Rows of the pane above the cards: the tab row and its gap.
const CHROME = 2
// The keys line after the last card and the gap above it, drawn only once the cards are scrolled to the end.
const FOOT = 2
const CARD_ROWS = 5

const TABS: { id: Tab; key: string; label: string; pick: (s: Session) => boolean }[] = [
  { id: 'pending', key: 'q', label: '待回覆', pick: s => s.pending },
  { id: 'all', key: 'w', label: '全部', pick: s => !s.archived && s.status !== '閒置' },
  { id: 'hidden', key: 'e', label: '封存', pick: s => s.archived },
  { id: 'idle', key: 'r', label: '閒置', pick: s => s.status === '閒置' },
]

const STATUS_BG: Record<Status, string> = { 等待回應: '#3b3624', 等待授權: '#3e2a2a', 回覆完畢: '#26323f', 執行中: '#263a2d', 閒置: '#303030' }
const STAGE_BG: Record<string, string> = { 未開工: '#303030', 規劃中: '#352c40', 實作中: '#24363a', 已推送: '#28382c' }
const TAG_FG = '#c8c8c8'
const CORNER_FG = '#6a6a6a'
const EMPTY = '目前沒有符合條件的 session'
const EMPTY_BORDER = '#4a4a4a'

const width = (t: string) => [...t].reduce((n, c) => n + (c.codePointAt(0)! > 0x2e80 ? 2 : 1), 0)

function cut(text: string, max: number): string {
  if (width(text) <= max) return text
  let out = ''
  for (const c of text) {
    if (width(out + c) > max - 1) break
    out += c
  }
  return `${out}…`
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
const sent: string[] = []
const misses = new Map<string, number>()
let appearance: Appearance = { appearance: 'refined', theme: 'neutral', motion: true }
let animation: { cancel(): void } | null = null
let animationTick = 0
let visibleKeys: string[] = []
let bandKey: string | null = null
const refined = () => appearance.appearance === 'refined'
const warned = new Set<string>()
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
  const moving = refined() && appearance.motion && focus.active && visibleAnimationFrame(animationTick) !== 0
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

// Must match stopId in mods/focus-show: names one stop so /focus-show can tell it is still on the band when it finally runs.
const stopId = (key: string) => [...key].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36)

// Prints one question's full report through the focus-show mod, never through the model. A stop counts as printed only when
// /focus-show answered with its report; anything else is sent again on the next poll, with a toast after 3 misses in a row.
async function show($: EngineInterface, tag: string, key: string | null = null) {
  const s = sessions().find(x => x.tag === tag)
  if (!s || !focus.home) return
  await $.fs.write(`${focus.home}/show/${encodeURIComponent(tag)}.md`, s.report)
  const id = key && stopId(key)
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
  $.ui.toast(installed ? `[${tag}] 題目沒印出，按 Enter 印` : '印不出題目：需要另外安裝 focus-show')
}

// A poll repeats an announce until `focus-shown` lands, which can wait on the console's turn; a press always prints.
async function announce($: EngineInterface, next: Focus, pressed: boolean) {
  const key = next.announceKey ?? null
  if (!next.announce || (key && !pressed && sent.includes(key))) return
  if (key && !sent.includes(key)) {
    sent.push(key)
    if (sent.length > SENT_MAX) sent.shift()
  }
  void show($, next.announce, key)
}

async function apply($: EngineInterface, next: Focus, pressed = false) {
  if (next.active) {
    const live = [next.current, ...(next.queue ?? []).map(q => q.key)].filter((k): k is string => !!k)
    for (const q of next.queue ?? []) {
      const s = next.sessions?.find(x => x.key === q.key)
      if (known && s && !known.has(q.key)) $.ui.toast(`${s.tag} 進排隊：${cut(s.question.replace(/\s+/g, ' '), TOAST_MAX)}`)
    }
    known = new Set(live)
    // A stop that left the band before /focus-show ran was not printed; the console announces it again once it is back.
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i] !== next.current) sent.splice(i, 1)
    for (const k of misses.keys()) if (k !== next.current) misses.delete(k)
  }
  focus = next
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

const focusSel = ($: EngineInterface) => sel && void $.ui.focus({ requestId: PANE, key: `name:${sel}` }).catch(() => {})

async function openPane($: EngineInterface, t: Tab = 'pending') {
  await loadPreferences($)
  showTab(t)
  $.ui.invalidate('ui.render')
  return $.ui.open({ id: PANE, title: PANE_TITLE, focus: true })
}

// A card's number only chooses it: on a card waiting on you that switches the band to it (and the switch prints it).
async function pickCard($: EngineInterface, s: Session) {
  sel = s.key
  follow = true
  if (s.pending && s.key !== focus.current) await act($, ['focus-pick', s.key])
  $.ui.invalidate('ui.render')
  void $.ui.focus({ requestId: PANE, key: `name:${s.key}` }).catch(() => {})
}

// Enter on a card, or a click on its nickname, prints the question; on a card waiting on you that is not on the band, it switches first.
async function printCard($: EngineInterface, s: Session) {
  sel = s.key
  if (s.pending && s.key !== focus.current) await act($, ['focus-pick', s.key])
  else void show($, s.tag, s.key === focus.current ? s.key : null)
  $.ui.invalidate('ui.render')
}

// The 封存 tab's button: runs `console.mjs unarchive` straight from the mod, so nothing reaches the conversation.
async function unarchiveCard($: EngineInterface, s: Session) {
  try {
    await run($, ['unarchive', s.tag])
  } catch {}
  await poll($)
}

const countsText = () => {
  const count = (s: Status) => sessions().filter(x => !x.archived && x.status === s).length
  return refined() ? `工作中 ${count('執行中')} · 已回覆 ${count('回覆完畢')}` : `執行中 ${count('執行中')}  回覆完畢 ${count('回覆完畢')}`
}

// The worktree-console focus band: polls `console.mjs focus`, draws the question on screen, the queue, the side pane and the counts.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadPreferences($)
    if ((await $.env.get('ORCA_TERMINAL_HANDLE')) || (await $.env.get('HERDR_ENV')) === '1') {
      sessionId = await $.session.id().catch(() => '')
      void poll($)
      $.clock.every(POLL_MS, () => {
        tick += 1
        if (focus.active || tick % IDLE_EVERY === 0) void poll($)
      })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!focus.active || e.text.trim() !== '狀態') return next(e)
    const opened = await openPane($, 'all')
    if (!opened.isPlaced) return next(e)
    if (focus.unreadable) $.ui.toast(focus.unreadable)
    return { drop: '狀態已開在側邊面板' }
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
    const target = dir !== 0 && i >= 0 ? rows[Math.max(0, Math.min(rows.length - 1, i + dir))] : rows.find(r => r.key === m?.[2])
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
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!focus.active) return <Text dimColor>中控台沒有在專注模式</Text>
    const cols = e.props.bodyColumns
    const modern = refined()
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
    const tabStart = TABS.slice(0, TABS.findIndex(x => x.id === tab)).reduce((n, x) => n + width(`${x.key}: ${x.label} ${rowsOf(x.id).length}`) + 2, 0)
    const tabWidth = Math.min(Math.max(0, cols - tabStart), width(`${TABS.find(x => x.id === tab)!.key}: ${TABS.find(x => x.id === tab)!.label} ${rows.length}`))
    const tabs = (
      <Box key="tabs" flexDirection="row" columnGap={2} marginBottom={modern ? 0 : 1}>
        {TABS.map(x => (
          <Button
            key={`tab:${x.id}`}
            hotkey={x.key}
            label={`${x.label} ${rowsOf(x.id).length}`}
            plain
            dimColor={x.id !== tab}
            onPress={() => {
              showTab(x.id)
              $.ui.invalidate('ui.render')
              focusSel($)
            }}
          />
        ))}
      </Box>
    )
    const hidden = tab === 'hidden'
    const press = (r: Session) => (hidden ? unarchiveCard($, r) : printCard($, r))
    const inner = Math.max(1, cols - 6)
    const card = (r: Session, i: number) => {
      const isSel = r.key === chosen
      const num = numberOf(tab, i)
      const cell = statusCell(r.status, animationTick, { primary: r.key === primaryKey(), animated: appearance.motion })
      const tagRoom = modern ? inner - 12 - (hidden ? 10 : 0) : inner - width(` ${r.status} `) - width(` ${r.stage} `) - 3 - (hidden ? width('取消封存') + 2 : 0)
      const tag = cut(r.tag, Math.max(1, tagRoom))
      const summary = cut(r.summary, modern ? cols <= 36 ? 15 : SUMMARY_MAX : Math.min(SUMMARY_MAX, inner))
      const room = inner - width(summary) - CORNER_GAP - (modern && r.stage !== '—' ? columns(r.stage) + 3 : 0)
      const repo = tab === 'pending' && room >= REPO_MIN && !(modern && cols <= 36) ? cut(r.repo, room) : ''
      const stage = <Text backgroundColor={STAGE_BG[r.stage] ?? '#303030'} color={TAG_FG} wrap="truncate-end">{` ${r.stage} `}</Text>
      return (
        <Box key={`card:${r.key}`} flexDirection="column" flexShrink={0} borderStyle={isSel ? 'double' : 'round'} borderColor={modern ? isSel ? theme.accent : theme.border : isSel ? 'cyanBright' : '#7a7a7a'} paddingX={2}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row">
              {modern ? <Box key={`number:${r.key}`} width={2} flexShrink={0} overflow="hidden">{num ? <Button key={`num:${r.key}`} hotkey={num} label="" plain onPress={() => pickCard($, r)} /> : <Text>  </Text>}</Box> : num && <Button key={`num:${r.key}`} hotkey={num} label="" plain onPress={() => pickCard($, r)} />}
              {modern && <Box flexDirection="row"><Box key={`status:${r.key}`} width={8} flexShrink={0}><Text color={theme[cell.glyphColor]}>{cell.glyph}</Text><Text color={theme[cell.color]}>{` ${cell.label}${' '.repeat(Math.max(0, 6 - columns(cell.label)))}`}</Text></Box><Text>  </Text></Box>}
              {hidden && <Text bold={modern} color={modern ? theme.fg : undefined}>{`${tag}  `}</Text>}
              <Button key={`name:${r.key}`} label={hidden ? '取消封存' : tag} plain autoFocus={isSel ? true : undefined} onPress={() => press(r)} />
              {!modern && <Text>  </Text>}
              {!modern && <Text backgroundColor={STATUS_BG[r.status]} color={TAG_FG} wrap="truncate-end">{` ${r.status} `}</Text>}
            </Box>
            {!modern && stage}
          </Box>
          <Text dimColor={!modern} color={modern ? theme.dim : undefined} wrap="truncate-end">{cut(r.question.replace(/\s+/g, ' ').trim(), inner)}</Text>
          <Box flexDirection="row" justifyContent="space-between">
            <Box key={`corner:${r.key}`}>
              {modern ? <><Text color={theme.dim} wrap="truncate-end">{repo}</Text>{repo && r.stage !== '—' && <Text color={theme.dim}> · </Text>}{r.stage !== '—' && <Text color={theme.muted}>{r.stage}</Text>}</> : <Text color={CORNER_FG} wrap="truncate-end">{repo || ' '}</Text>}
            </Box>
            <Box key={`summary:${r.key}`} flexDirection={modern ? 'row' : undefined}>
              <Text color={modern ? theme.muted : CORNER_FG} wrap="truncate-end">{summary}</Text>
            </Box>
          </Box>
        </Box>
      )
    }
    const empty = (
      <Box key="empty" width={cols} borderStyle="round" borderColor={modern ? theme.border : EMPTY_BORDER} paddingY={1}>
        <Text dimColor>{`${' '.repeat(Math.max(0, Math.floor((cols - 2 - width(EMPTY)) / 2)))}${EMPTY}`}</Text>
      </Box>
    )
    const body = rows.slice(top, end).flatMap((r, j) => {
      const i = top + j
      const out = []
      if (tab !== 'pending' && (j === 0 || r.repo !== rows[i - 1]!.repo)) {
        const tail = ` 共 ${sessions().filter(x => x.repo === r.repo).length} 個`
        out.push(
          <Box key={`repo:${r.repo}`} flexShrink={0} marginTop={j === 0 ? 0 : 1}>
            <Text dimColor={!modern} color={modern ? theme.dim : undefined} wrap="truncate-end">{`── ${r.repo} ${'─'.repeat(Math.max(2, cols - width(r.repo) - width(tail) - 4))}${tail}`}</Text>
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
      <Box flexDirection="column" height={dock ? e.props.scroll.bodyRows : undefined}>
        {tabs}
        {modern && <Text color={theme.border}>{'─'.repeat(Math.min(cols, tabStart))}<Text color={theme.accent}>{'━'.repeat(tabWidth)}</Text>{'─'.repeat(Math.max(0, cols - tabStart - tabWidth))}</Text>}
        <Box key="cards" flexDirection="column" flexShrink={1} overflow="hidden">
          {offscreen('above', rows.slice(0, top), 0)}
          {rows.length === 0 ? empty : body}
          {offscreen('below', rows.slice(end), end)}
        </Box>
        {top >= lastTop(rows) && (
          <Box key="footer" flexShrink={0} marginTop={1} paddingLeft={1}>
            <Text dimColor={!modern} color={modern ? theme.dim : undefined}>{modern ? 'qwer 切分頁 · 1-9,0/↑↓ 選卡片' : FOOTER}</Text>
          </Box>
        )}
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
      return next(e)
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
    const modern = refined()
    const theme = THEMES[appearance.theme]
    bandKey = cur?.key ?? null
    syncAnimation($)
    if (modern) {
      const cols = e.props.bodyColumns
      const cell = cur && statusCell(cur.status, animationTick, { primary: cur.key === primaryKey(), animated: appearance.motion })
      const others = queue.slice(0, cols < 60 ? 1 : QUEUE_MAX)
      const room = Math.max(1, cols - 6) * Math.max(1, e.props.maxRows - 5)
      const rail = <Text color={cell ? theme[cell.color] : theme.dim}>│ </Text>
      const label = `── 待回覆 ${cur ? 1 : 0}/${fullQueue.length + (cur ? 1 : 0)} `
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.border}>{label + '─'.repeat(Math.max(0, cols - columns(label)))}</Text>
          <Box flexDirection="row" paddingLeft={2}>
            {rail}
            {cur && cell ? <Box flexDirection="row"><Text color={theme[cell.glyphColor]}>{cell.glyph}</Text><Text color={theme[cell.color]}>{` ${cell.label}  `}</Text><Button key="show-tag" label={truncateColumns(cur.tag, Math.max(1, cols - 14))} plain onPress={() => void show($, cur.tag, cur.key)} /></Box> : <Text color={theme.dim}>{`等 ${focus.waiting?.tag ?? '—'} 回應中…`}</Text>}
          </Box>
          {cur && <Box flexDirection="row" paddingLeft={2}>{rail}<Text key="question" color={theme.fg} wrap="wrap">{cut(cur.question, room)}</Text></Box>}
          {cur && <Box flexDirection="row" paddingLeft={2}>{rail}<Button key="show" hotkey="9" label="顯示問題" plain onPress={() => void show($, cur.tag, cur.key)} />{queue.length > 0 && <Box flexDirection="row"><Text color={theme.dim}> · </Text><Button key="later" hotkey="8" label="延後處理" plain onPress={() => act($, ['focus-later'])} /></Box>}</Box>}
          <Box key="keys" flexDirection="row" paddingLeft={2} flexWrap="wrap">
            {rail}
            {others.length > 0 && <Text color={theme.dim}>其他 </Text>}
            {others.map((q, i) => <Box key={`other:${i}`} flexDirection="row"><Button key={`queue:${i}`} hotkey={String(i + 1)} label={`${cut(q.tag, Math.max(1, cols < 60 ? cols - 26 : 20))}${q.isNew ? ' ✨' : ''}`} plain dimColor onPress={() => act($, ['focus-pick', q.key])} /><Text color={theme.dim}> · </Text></Box>)}
            {fullQueue.length > others.length && <Text color={theme.dim}>{`＋${fullQueue.length - others.length} · `}</Text>}
            <Button key="pane" hotkey="0" label="面板" plain onPress={() => void openPane($)} />
          </Box>
          <Box height={0} overflow="hidden">{queue.slice(others.length).map((q, j) => <Button key={`queue:${others.length + j}`} hotkey={String(others.length + j + 1)} label="" plain onPress={() => act($, ['focus-pick', q.key])} />)}</Box>
        </Box>
      )
    }
    const room = Math.max(1, e.props.bodyColumns - 2) * Math.max(1, e.props.maxRows - 3)
    return (
      <Box flexDirection="column" paddingLeft={2} marginTop={1}>
        {cur ? (
          <Box key="head" flexDirection="row">
            <Text backgroundColor={STATUS_BG[cur.status]} color={TAG_FG}>{` ${cur.status} `}</Text>
            <Text> </Text>
            <Button key="show-tag" label={cur.tag} plain onPress={() => void show($, cur.tag, cur.key)} />
            <Text> </Text>
            <Text backgroundColor={STAGE_BG[cur.stage] ?? '#303030'} color={TAG_FG}>{` ${cur.stage} `}</Text>
          </Box>
        ) : (
          <Text key="head" dimColor>{`等 ${focus.waiting?.tag ?? '—'} 回應中…`}</Text>
        )}
        {cur && (
          <Text key="question" wrap="wrap">
            {cut(cur.question, room)}
          </Text>
        )}
        <Box key="keys" flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="pane" hotkey="0" label="面板" plain onPress={() => void openPane($)} />
          {queue.map((q, i) => (
            <Button key={`queue:${i}`} hotkey={String(i + 1)} label={`${q.tag}${q.isNew ? ' ✨' : ''}`} plain dimColor onPress={() => act($, ['focus-pick', q.key])} />
          ))}
          {cur && queue.length > 0 && <Button key="later" hotkey="8" label="延後處理" plain onPress={() => act($, ['focus-later'])} />}
          {cur && <Button key="show" hotkey="9" label="顯示問題" plain onPress={() => void show($, cur.tag, cur.key)} />}
        </Box>
      </Box>
    )
  })
}
