import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { columns, statusCell, wrapColumns } from './status-view.ts'
import { MARK_SPIN, MARK_STILL, fitRow, keysWidth } from './worktree-console-focus.tsx'
import { THEMES } from './console-theme.ts'

const PLUGIN = 'worktree-console'
const PANE = 'worktree-console-pending'
const HOME = '/tmp/wtc-home'

type Card = {
  key: string
  id: string
  tag: string
  repo: string
  status: string
  stage: string
  summary: string
  branch: string
  path: string
  review: number
  question: string
  options: string[]
  archived: boolean
  pending: boolean
  report: string
}

const card = (tag: string, extra: Partial<Card> = {}): Card => ({
  key: `${tag}@1`,
  id: `id-${tag}-1`,
  tag,
  repo: 'agent-skills',
  status: '等待回應',
  stage: '實作中',
  summary: `feat/${tag}`,
  branch: `feat/${tag}`,
  path: `/wt/${tag}`,
  review: 0,
  question: `${tag} 要怎麼做？`,
  options: [],
  archived: false,
  pending: true,
  report: `### 💬 ${tag} 等你回應\n\n> ${tag} 要怎麼做？`,
  ...extra,
})

const SESSIONS = [
  card('focusui', { stage: '規劃中', question: '展示 mod 的樣式要套在哪裡？', options: ['只套面板', '橫條也改清單', '都套'] }),
  card('logging', { question: '照建議在真實中控台驗過了嗎？', options: ['我去中控台用一次', '先跳過'] }),
  card('tune', { repo: 'proj-agents-configuration', status: '執行中', pending: false, question: '/goal 本次任務…' }),
  card('PROJ-6668', { repo: 'proj-v2-frontend', question: '你要 A、A＋另開後端票做 B，還是其他做法？', options: ['這張票只在卡片…', '卡片直接顯示狀…', '前端自己去撈分…'], summary: '[FE] 專案檢視介面調整建議' }),
  card('upgrade#2', { repo: 'proj-v2-frontend', status: '回覆完畢', question: '頁面目前是私人的。' }),
  card('PROJ-6650', { repo: 'proj-v2-frontend', status: '回覆完畢', stage: '已推送', pending: false, archived: true }),
  card('chart', { repo: 'hours-dashboard', status: '閒置', stage: '已推送', pending: false, question: '（閒置）' }),
  card('perm', { repo: 'hours-dashboard', status: '等待授權', question: 'Bash rm -rf build' }),
]

const STATS = '等待回應 3 | 等待授權 1 | 回覆完畢 1 | 執行中 1 | 封存 1 | 閒置 1'
const keyOf = (tag: string) => `${tag}@1`
const idOf = (key: string) => `id-${key.replace('@', '-')}`

type World = { focus: any; sheet?: any; opens?: string[]; askGate?: Promise<void>; closes?: string[]; notes?: string[][]; answer?: string; skips?: string[]; submits?: string[]; sticky?: boolean; showFails?: boolean; lost?: number; dropped?: string[]; calls: string[][]; toasts: string[]; shown: string[]; writes: Record<string, string>; opened: any[]; hints: object[]; focused: string[] }
type AppearanceConfig = { appearance?: string; theme?: string; motion?: unknown }
const appearanceConfig = new WeakMap<World, AppearanceConfig | string>()

// The band rows `console.mjs focus` composes for this current stop and queue, as band.mjs writes them.
const bandOf = (current: string | null, queue: string[]) => {
  const [label, color] = SESSIONS.find(s => s.tag === current)?.status === '等待授權' ? ['等待授權', 'blocked'] : ['輪到你', 'waiting']
  return {
  title: '狀態',
  rail: current ? color : 'dim',
  rows: [
    current
      ? { variants: [[{ text: '◆', color }, { text: ` ${label}  `, color, bold: true }, { text: current, bold: true }]], keys: [...(queue.length ? [{ key: '8', label: '延後處理', action: 'later' }] : []), { key: '9', label: '顯示問題', action: 'show' }, { key: '0', label: '面板', action: 'pane' }] }
      : { variants: [[{ text: '等待  ', color: 'waiting' }, ...queue.map(t => ({ text: t, color: 'waiting', bold: true }))]], keys: [{ key: '0', label: '面板', action: 'pane' }] },
  ],
  }
}

const focusOf = (current: string, queue: string[], extra: object = {}) => ({
  active: true,
  home: HOME,
  current: keyOf(current),
  waiting: null,
  queue: queue.map(t => ({ key: keyOf(t) })),
  band: bandOf(current, queue),
  sessions: SESSIONS,
  ...extra,
})

const pending = () => focusOf('perm', ['focusui', 'logging', 'PROJ-6668', 'upgrade#2'])

// Answers `node console.mjs <sub>` from the world: focus-later sends the current one to the back, unarchive clears that tag's archived flag.
function fakeConsole(on: On, world: World) {
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'open') {
      world.opens = [...(world.opens ?? []), ...e.argv.slice(1)]
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'herdr') {
      world.notes = [...(world.notes ?? []), [...e.argv]]
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const args = e.argv.slice(2)
    world.calls.push([...args])
    const f = world.focus
    if (args[0] === 'focus-later' && f.active && f.current) {
      const [next, ...rest] = f.queue
      const tagOf = (key: string) => f.sessions.find((s: Card) => s.key === key).tag
      const queue = [...rest, { key: f.current }]
      world.focus = { ...f, current: next.key, queue, band: bandOf(tagOf(next.key), queue.map((q: any) => tagOf(q.key))) }
    } else if (args[0] === 'review') {
      return { value: await fakeReview(world, args) }
    } else if (args[0] === 'unarchive') {
      world.focus = { ...f, sessions: f.sessions.map((s: Card) => (s.tag === args[1] ? { ...s, archived: false } : s)) }
      return { value: { exitCode: 0, stdout: `[${args[1]}] 已取消封存\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout = JSON.stringify(world.focus)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

// `console.mjs review <sub> --path P …` against world.sheet, as review-cli.mjs answers: one line out, exit 1 with the message on failure.
async function fakeReview(world: World, args: string[]) {
  const ok = (stdout: string) => ({ exitCode: 0, stdout: `${stdout}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const fail = (stderr: string) => ({ exitCode: 1, stdout: '', stderr: `${stderr}\n`, isStdoutTruncated: false, isStderrTruncated: false })
  const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
  const sheet = world.sheet
  const items = [...sheet.fresh, ...sheet.past]
  const n = Number(opt('--n'))
  const it = items.find((x: any) => x.n === n)
  const sub = args[1]
  if (sub === 'data') return ok(JSON.stringify({ ...sheet, pr: args.includes('--json') ? sheet.pr : null }))
  if (sub === 'pass') return ((it.status = 'passed'), ok(`第 ${n} 件已通過`))
  if (sub === 'edit') return Object.assign(it, { status: 'edited', edit: opt('--to') }), ok(`第 ${n} 件已改：${opt('--to')}`)
  if (sub === 'undo') return Object.assign(it, { status: 'pending', edit: null }), ok(`第 ${n} 件已退回待審`)
  if (sub === 'pass-all') {
    const left = sheet.past.filter((x: any) => x.status === 'pending')
    for (const x of left) x.status = 'passed'
    return ok(`「照你過去的回答」通過 ${left.length} 件`)
  }
  if (sub === 'ask') {
    if (world.askGate) await world.askGate
    const q = opt('--q')
    const a = q ? `答覆：${q}，先照方案做。` : '如果卡片只有 46 欄，進度條縮成 6 格，狀態字只剩 ◆。'
    it.asks.push({ q: q ?? '（要範例）', a, example: q ? null : `/tmp/examples/${n}-${it.asks.length + 1}.md`, at: 1 })
    if (!q) it.example = `/tmp/examples/${n}-${it.asks.length}.md`
    return ok(a)
  }
  if (sub === 'done') {
    const left = items.filter((x: any) => x.status === 'pending').length
    if (left) return fail(`[${sheet.tag}] 還有 ${left} 件沒審`)
    world.focus = { ...world.focus, sessions: world.focus.sessions.map((s: any) => (s.path === sheet.path ? { ...s, review: 0 } : s)) }
    return ok(`[${sheet.tag}] 審核單已審完\n已送回 ${sheet.tag}`)
  }
  return fail('用法：console.mjs review …')
}

const band = (columns = 160, maxRows = 20) => ({
  plugin: PLUGIN,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: columns, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
  viewport: { columns, rows: 40, isFullscreen: true },
})

const pane = (bodyColumns = 70, bodyRows = 200) => ({
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: PANE,
  props: { title: '中控台', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} } as any,
})

// ↑↓ onto a card, d opens its recap popover, p there prints the card's whole report.
async function printFromBrief($: any, ui: any, key: string) {
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: `name:${key}`, origin: { kind: 'person' } } as any)
  await ui.press({ key: 'brief-key' })
  await ui.press({ key: 'popover-print' })
}

// The popover's rows as drawn, each row's text: title rule, text rows, bottom rule; the keys row under it is popFooter's.
const popRows = async (ui: any) => {
  const box = findKey(await ui.drawn(), 'popover')
  return box ? box.children.filter((c: any) => c?.props?.key !== 'popover-keys' && c?.props?.key !== 'popover-footer').map(textOf) : null
}

// ↑↓ onto a card, then d: its recap popover.
async function openBrief($: any, ui: any, tag: string) {
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: `name:${keyOf(tag)}`, origin: { kind: 'person' } } as any)
  await ui.press({ key: 'brief-key' })
}

const hint = { plugin: PLUGIN, component: 'PromptHint' as const, props: { isDraft: false, isWorking: false, hint: 'auto mode on' } }

async function start($: any, on: On, world: World, env: Record<string, string> = { ORCA_TERMINAL_HANDLE: 'term_self' }) {
  mock.env(on, env)
  const clock = mock.clock(on, { now: 1_000 })
  on('fs.read', async () => {
    const config = appearanceConfig.get(world) ?? { motion: false }
    return { value: typeof config === 'string' ? config : JSON.stringify(config) }
  })
  fakeConsole(on, world)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', async (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.focus', { plugin: '*' }, async (_$, e) => {
    world.focused.push((e as any).element ?? (e as any).key)
    return {}
  })
  on('ui.open', async (_$, e) => {
    world.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', async (_$, e) => {
    world.closes?.push(e.id)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 'console-session' }))
  on('fs.write', async (_$, e) => {
    world.writes[e.path] = e.text
    return { value: undefined }
  })
  // Answers /focus-show as the focus-show mod does, with the saved report; `lost` drops that many as a busy console did, answering nothing;
  // `skips` answers its lines one per call before the report, as focus-show does when it finds the stop off the band.
  on('command.run', async (_$, e) => {
    if (world.showFails) throw new Error('no focus-show')
    if (e.command !== 'focus-show') return { text: '' }
    if (world.lost) {
      world.lost -= 1
      world.dropped = [...(world.dropped ?? []), e.args]
      return {}
    }
    world.shown.push(e.args)
    if (world.skips?.length) return { text: world.skips.shift() }
    if (world.answer) return { text: world.answer }
    const [tag, id] = e.args.split(' ')
    return { text: world.writes[`${HOME}/show/${encodeURIComponent(tag)}${id ? `@${id}` : ''}.md`] ?? `[${tag}] 沒有可印的題目` }
  })
  on('ui.render', async ($, e, next) => {
    if (e.component === 'PromptHint') world.hints.push({ ...e.props })
    if (e.component === 'AbovePrompt' && e.plugin !== PLUGIN) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('prompt.submit', async (_$, e) => {
    world.submits?.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

async function openPane($: any) {
  const b = await $.ui.mount({ ...band(), surface: 'terminal' })
  await b.press({ key: 'pane' })
  await b.unmount()
}

const world = (focus: object): World => ({ focus, calls: [], toasts: [], shown: [], writes: {}, opened: [], hints: [], focused: [] })
const cardTags = async (ui: any) => (await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('name:')).map((b: any) => b.props.label)
const arrowTo = ($: any, tag: string) => $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: `name:${keyOf(tag)}`, origin: { kind: 'person' } } as any)
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((x: any) => x.text)
const labels = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => `${b.props.hotkey ? `${b.props.hotkey}: ` : ''}${b.props.label}`)

// Each band row as `│ <left>`, with ` ‖ <keys>` when the row carries keys on its right.
const bandText = async (ui: any) => {
  const root = await ui.drawn()
  const rows: string[] = []
  for (let i = 0; ; i++) {
    const row = findKey(root, `band-row:${i}`)
    if (!row) break
    const keys = findKey(row, `band-keys:${i}`)
    rows.push(`│ ${textOf(row.children[0])}${keys ? ` ‖ ${textOf(keys)}` : ''}`)
  }
  return rows
}

const withAdvice = (advice: any, tag = 'focusui') => ({ ...focusOf(tag, ['logging']), sessions: SESSIONS.map(s => (s.tag === tag ? { ...s, advice } : s)) })
const READY = { state: 'ready', text: '建議：b，兩邊都改才一致', answer: 'b', reason: '兩邊都改才一致', principle: null }
const r = (text: string, color?: string, bold?: boolean) => ({ text, ...(color ? { color } : {}), ...(bold ? { bold: true } : {}) })
const PANE_KEY = { key: '0', label: '面板', action: 'pane' }
// What band.mjs composes for flow on the band with an advisor suggestion, tidy waiting, unit answered for you, advisor-loop running, polish closable.
const DESIGN = {
  title: '狀態',
  rail: 'waiting',
  rows: [
    { variants: [[r('◆', 'waiting'), r(' 輪到你  ', 'waiting', true), r('flow', undefined, true)]], keys: [{ key: '8', label: '延後處理', action: 'later' }, { key: '9', label: '顯示問題', action: 'show' }, PANE_KEY] },
    { variants: [[r('  建議  ', 'accent'), r('a', undefined, true), r(' 全照建議並動工'), r('  7 題都照建議就能定稿', 'dim')]] },
    {
      variants: [[r('  '), r('等待  ', 'waiting'), r('flow', 'waiting', true), r('  '), r('tidy', 'waiting', true), r('     '), r('自動處理中  ', 'auto'), r('unit'), r('     '), r('在跑  ', 'running'), r('advisor-loop'), r('     '), r('可關閉  ', 'closable'), r('polish', 'closable', true)]],
    },
  ],
}

test('狀態區：照方案 D 畫腳本給的每一行——◆ 輪到你 加代號、建議、分組；按鍵行是 8 延後處理   9 顯示問題   0 面板（數字粗體、說明暗色、隔三格）；不畫題目', async ($, on) => {
  const w = world(focusOf('logging', ['perm'], { band: DESIGN }))
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  const rows = await bandText(ui)
  expect(rows[0]).toBe('│ ◆ 輪到你  flow ‖ 8 延後處理   9 顯示問題   0 面板')
  const head = findKey(await ui.drawn(), 'band-row:0')
  expect(head.props).toMatchObject({ width: 160 - 4, justifyContent: 'space-between' })
  expect(rows[1]).toBe('│   建議  a 全照建議並動工  7 題都照建議就能定稿')
  expect(rows[2]).toBe('│   等待  flow  tidy     自動處理中  unit     在跑  advisor-loop     可關閉  polish')
  expect(rows).toHaveLength(3)
  const root = await ui.drawn()
  expect(textOf(root)).toContain('── 狀態 ')
  expect(paintOf(root, '8')).toEqual({ color: undefined, bold: true })
  expect(paintOf(root, ' 延後處理')?.color).toBe(THEMES.neutral.dim)
  expect(paintOf(root, ' 面板')?.color).toBe(THEMES.neutral.dim)
  expect(paintOf(root, ' 輪到你  ')).toEqual({ color: THEMES.neutral.waiting, bold: true })
  expect(paintOf(root, '等待  ')).toEqual({ color: THEMES.neutral.waiting, bold: undefined })
  expect(paintOf(root, 'tidy')).toEqual({ color: THEMES.neutral.waiting, bold: true })
  expect(paintOf(root, '自動處理中  ')?.color).toBe(THEMES.neutral.answered)
  expect(paintOf(root, 'unit')).toEqual({ color: THEMES.neutral.fg, bold: undefined })
  expect(paintOf(root, '在跑  ')?.color).toBe(THEMES.neutral.busy)
  expect(paintOf(root, '可關閉  ')?.color).toBe('blueBright')
  expect(paintOf(root, 'polish')).toEqual({ color: 'blueBright', bold: true })
  expect(paintOf(root, '  7 題都照建議就能定稿')?.color).toBe(THEMES.neutral.dim)
  for (const s of SESSIONS) expect(textOf(root)).not.toContain(s.question)
  await ui.unmount()
})

test('狀態區：放不下時畫腳本給的下一種寫法（第一種放得下的），都放不下時把最後一種以 … 截短；不另起一行、不超出寬度', async ($, on) => {
  const variants = [
    '  等待  flow  tidy  cards     自動處理中  unit     在跑  advisor-loop  polish2     延後處理  later1     可關閉  polish',
    '  等待  flow  tidy  cards     自動處理中  unit     在跑 2     延後處理 1     可關閉  polish',
    '  等待  flow  tidy  cards     自動處理中 1     在跑 2     延後處理 1     可關閉 1',
    '  等待  flow  +2     自動處理中 1     在跑 2     延後處理 1     可關閉 1',
    '  等待  +3     自動處理中 1     在跑 2     延後處理 1     可關閉 1',
  ]
  const design = { title: '狀態', rail: 'waiting', rows: [DESIGN.rows[0]!, { variants: variants.map(v => [r(v)]) }] }
  const w = world(focusOf('logging', [], { band: design }))
  await start($, on, w)
  for (const [cols, want] of [[160, 0], [100, 1], [86, 2], [78, 3], [72, 4]] as const) {
    const ui = await $.ui.mount({ ...band(cols), surface: 'terminal' })
    const rows = await bandText(ui)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toBe(`│ ${variants[want]}`)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...band(30), surface: 'terminal' })
  const rows = await bandText(ui)
  expect(rows[1]!.endsWith('…')).toBe(true)
  expect(rows[0]).toBe('│ ◆ 輪到你  flow ‖ 8 9 0')
  for (const row of rows) expect(columns(row.replace(' ‖ ', ''))).toBeLessThanOrEqual(30 - 2)
  expect(fitRow([[r('abc'), r('defgh')]], 6).map(x => x.text)).toEqual(['abc', 'de…'])
  expect(keysWidth(DESIGN.rows[0]!.keys as any)).toBe(columns('8 延後處理   9 顯示問題   0 面板'))
  await ui.unmount()
})

test('狀態區：等某個 session 回應時第一行是 ◌ 等 <代號> 回應中…（代號粗體），有別題在等時右邊是 8 先處理下一件   0 面板；什麼都沒有時不畫狀態區', async ($, on) => {
  const waitBand = {
    title: '狀態',
    rail: 'dim',
    rows: [
      { variants: [[r('◌ 等 ', 'dim'), r('flow', undefined, true), r(' 回應中…', 'dim'), r('　你回了  ', 'dim'), r('4 b、10 a，其他照建議')]], keys: [{ key: '8', label: '先處理下一件', action: 'next' }, PANE_KEY] },
      { variants: [[r('  '), r('等待  ', 'waiting'), r('tidy', 'waiting', true), r('     '), r('在跑  ', 'running'), r('flow')]] },
    ],
  }
  const w = world(focusOf('logging', ['perm'], { current: null, waiting: { tag: 'flow' }, band: waitBand }))
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  const rows = await bandText(ui)
  expect(rows[0]).toBe('│ ◌ 等 flow 回應中…　你回了  4 b、10 a，其他照建議 ‖ 8 先處理下一件   0 面板')
  expect(rows[1]).toBe('│   等待  tidy     在跑  flow')
  expect(paintOf(findKey(await ui.drawn(), 'band-row:0'), 'flow')?.bold).toBe(true)
  expect((await ui.find({ key: 'show' }))).toBeUndefined()
  await ui.press({ key: 'later' })
  expect(w.calls.at(-1)).toEqual(['focus-later'])
  await ui.unmount()
  w.focus = { ...w.focus, band: { title: '狀態', rail: 'dim', rows: [] } }
  await clock.advance(5_000)
  const empty = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await bandText(empty)).toEqual([])
  expect(textOf(await empty.drawn())).not.toContain('狀態')
  await empty.unmount()
})

test('狀態區按鍵：8 跑 focus-later、9 印目前這件、0 開面板；1–5 不是狀態區的鍵（輸入框空白時照常打字）', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  const hotkeys = (await ui.findAll({ type: 'Button' })).map((b: any) => b.props.hotkey).filter(Boolean)
  expect(hotkeys).toEqual(['8', '9', '0'])
  await ui.press({ key: 'later' })
  expect(w.calls.at(-1)).toEqual(['focus-later'])
  expect(w.shown).toEqual([])
  expect(await bandText(ui)).toEqual(['│ ◆ 輪到你  focusui ‖ 8 延後處理   9 顯示問題   0 面板'])
  await ui.press({ key: 'show' })
  expect(w.shown).toEqual([`focusui ${idOf(keyOf('focusui'))}`])
  expect(w.writes[`${HOME}/show/focusui.md`]).toBe(SESSIONS.find(s => s.tag === 'focusui')!.report)
  await ui.press({ key: 'pane' })
  expect(w.opened.at(-1)).toMatchObject({ id: PANE, focus: true })
  await ui.unmount()
})

test('不主動跳題：目前這件換人（換題、回完輪到下一件）時不送 /focus-show、不跳浮動通知；別的 session 有新題也不跳「進排隊」通知', async ($, on) => {
  const w = world(focusOf('perm', ['focusui']))
  const clock = await start($, on, w)
  w.focus = focusOf('focusui', ['logging', 'perm'])
  await clock.advance(5_000)
  w.focus = focusOf('focusui', ['logging', 'perm', 'PROJ-6668'])
  await clock.advance(5_000)
  expect(w.shown).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([])
})

test('the console\'s prompt hint is the engine\'s own: nothing is added after auto mode on, with sessions working, answered or none', async ($, on) => {
  const w = world(pending())
  const clock = await start($, on, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const h = await $.ui.mount({ ...hint, surface })
    expect(w.hints.at(-1)).toEqual(hint.props)
    expect(await h.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await h.unmount()
  }
  w.focus = nothing()
  await clock.advance(5_000)
  const zero = await $.ui.mount({ ...hint, surface: 'terminal' })
  expect(w.hints.at(-1)).toEqual(hint.props)
  await zero.unmount()
})

test('pane tabs: only 待回覆 q, 全部 w, 封存 e with counts; the open tab is lit, the rest dim; each filters as the design says', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const tabs = (await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('tab:'))
  expect(tabs.map((t: any) => [t.key, t.props])).toMatchObject([
    ['tab:pending', { hotkey: 'q', label: '待回覆 5', dimColor: false }],
    ['tab:all', { hotkey: 'w', label: '全部 7', dimColor: true }],
    ['tab:hidden', { hotkey: 'e', label: '封存 1', dimColor: true }],
  ])
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => b.props.hotkey === 'r')).toEqual([])
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  expect((await ui.findAll({ type: 'Box' })).some((b: any) => b.key?.startsWith('repo:'))).toBe(false)
  await ui.press({ key: 'tab:all' })
  expect((await ui.find({ key: 'tab:all' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'tab:pending' }))?.props.dimColor).toBe(true)
  expect(await cardTags(ui)).toEqual(['focusui', 'logging', 'tune', 'PROJ-6668', 'upgrade#2', 'chart', 'perm'])
  await ui.press({ key: 'tab:hidden' })
  expect((await ui.find({ key: `card:${keyOf('PROJ-6650')}` }))?.text).toContain('PROJ-6650')
  await ui.unmount()
})

test('全部 lists every session not archived, idle ones included with their 閒置 status; an archived one never shows there; 待回覆 keeps leaving out a pushed idle session', async ($, on) => {
  const extra = [card('idle-new', { status: '閒置', stage: '未開工', pending: false }), card('idle-gone', { status: '閒置', stage: '已推送', pending: false, archived: true })]
  const w = world({ ...pending(), sessions: [...SESSIONS, ...extra] })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await cardTags(ui)).not.toContain('chart')
  await ui.press({ key: 'tab:all' })
  const tags = await cardTags(ui)
  expect(tags).toContain('chart')
  expect(tags).toContain('idle-new')
  expect(tags).not.toContain('idle-gone')
  expect(tags).not.toContain('PROJ-6650')
  for (const tag of ['chart', 'idle-new']) expect((await ui.find({ key: `status:${keyOf(tag)}` }))?.text).toContain('- 閒置')
  await ui.press({ key: 'tab:hidden' })
  expect(await cardTags(ui)).toEqual(['取消封存', '取消封存'])
  await ui.unmount()
})

test('pane groups by repo outside 待回覆: `── <repo> ── 共 N 個` counts every session of that repo; a blank row sits above the rule and another between the rule and its first card, as above every card', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  const rules = (await ui.findAll({ type: 'Box' })).filter((x: any) => x.key?.startsWith('repo:')).map((x: any) => x.text)
  expect(rules.map((t: string) => [t.split(' ')[1], t.split(' ').slice(-3).join(' ')])).toEqual([
    ['agent-skills', '共 2 個'],
    ['proj-agents-configuration', '共 1 個'],
    ['proj-v2-frontend', '共 3 個'],
    ['hours-dashboard', '共 2 個'],
  ])
  expect(await cardTags(ui)).toContain('chart')
  expect((await ui.find({ key: 'repo:agent-skills' }))?.props.marginTop).toBe(1)
  expect((await ui.find({ key: 'repo:proj-v2-frontend' }))?.props.marginTop).toBe(1)
  expect((await ui.find({ key: `card:${keyOf('focusui')}` }))?.props.marginTop).toBe(1)
  expect((await ui.find({ key: `card:${keyOf('logging')}` }))?.props.marginTop).toBe(1)
  await ui.unmount()
})

test('cards: number (none on the question on screen) and nickname button, status icon and word on the first row, never the question; branch and repo on the second; no stage on any tab, no options, never 建議; no frame and no rail: the status colour sits on the status icon, the chosen card leads with an accent ✻ mark and its name in the accent', async ($, on) => {
  const w = world(focusOf('focusui', ['perm', 'logging', 'PROJ-6668', 'upgrade#2']))
  await start($, on, w)
  await openPane($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(), surface })
    const first = await ui.find({ key: `card:${keyOf('focusui')}` })
    expect(first?.props.borderStyle).toBeUndefined()
    const root = await ui.drawn()
    expect(textOf(root)).not.toMatch(/[╭╮╰╯║═╔╗╚╝]/)
    const rowsOf = (key: string) => findKey(root, `card:${key}`).children
    const mark = rowsOf(keyOf('focusui'))[0].children[0]
    expect([textOf(mark), mark.props.color, mark.props.bold]).toEqual([` ${MARK_STILL} `, THEMES.neutral.accent, true])
    expect(rowsOf(keyOf('focusui')).slice(1).map(textOf).every((t: string) => t.startsWith('      '))).toBe(true)
    expect(rowsOf(keyOf('perm')).map(textOf).every((t: string) => t.startsWith('   '))).toBe(true)
    expect(textOf(root)).not.toMatch(/[│┃]/)
    expect((await ui.find({ type: 'Text', text: 'focusui' }))?.props).toMatchObject({ color: THEMES.neutral.accent, bold: true })
    expect([(await ui.find({ type: 'Text', text: 'perm' }))?.props.color, (await ui.find({ type: 'Text', text: 'perm' }))?.props.bold]).toEqual([THEMES.neutral.fg, true])
    const head = (await ui.find({ key: `card-head:${keyOf('focusui')}` }))!.text
    expect(head.trim()).toBe(`${MARK_STILL}    ◆ 待回答  focusui`)
    expect(textOf(root)).not.toContain('展示 mod')
    expect(textOf(root)).not.toContain('Bash rm')
    expect(head).not.toContain('agent-skills')
    const b = await bottomOf(ui, keyOf('focusui'))
    expect([b.branchText, b.repoText]).toEqual(['feat/focusui', 'agent-skills'])
    expect(first?.text).not.toMatch(/a\. |只套面板|橫條也改清單/)
    expect(first?.text).not.toContain('建議：')
    expect(first?.text).not.toContain('規劃中')
    expect(first?.text).not.toMatch(/💬|🔐|⏸/)
    expect(await ui.find({ key: `num:${keyOf('focusui')}` })).toBeUndefined()
    expect((await ui.find({ key: `num:${keyOf('perm')}` }))?.props).toMatchObject({ hotkey: '1', label: '', plain: true })
    expect((await ui.find({ key: `name:${keyOf('focusui')}` }))?.props).toMatchObject({ label: 'focusui', plain: true })
    expect((await ui.find({ key: `name:${keyOf('focusui')}` }))?.props.hotkey).toBeUndefined()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.press({ key: 'tab:all' })
    const permCell = statusCell('等待授權', 0)
    const icon = findKey(await ui.drawn(), `status:${keyOf('perm')}`).children[0]
    expect([textOf(icon), icon.props.color]).toEqual([permCell.glyph, THEMES.neutral[permCell.glyphColor]])
    expect((await ui.find({ key: `card-branch:${keyOf('focusui')}` }))?.text).toContain('agent-skills')
    expect((await ui.find({ key: `card:${keyOf('focusui')}` }))?.text).not.toContain('規劃中')
    await ui.press({ key: 'tab:pending' })
    await ui.unmount()
  }
})

const findKey = (node: any, key: string): any => (node?.props?.key === key ? node : (node?.children ?? []).map((c: any) => (typeof c === 'object' ? findKey(c, key) : null)).find(Boolean))
const textOf = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))

test('cards on 待回覆, 全部 (idle ones too) and 封存: no frame, two rows and a blank row above; no question text at any width; the second holds the branch; options never show', async ($, on) => {
  const long = '這是一個非常長的題目，會遠遠超過卡片的內寬，\n而且還有第二行與第三行的內容，需要被截短成一行並以刪節號結尾'
  const opts = { question: long, options: ['第一個選項', '第二個選項'] }
  const four = [
    card('p1', opts),
    card('a1', { ...opts, status: '執行中', pending: false }),
    card('h1', { ...opts, archived: true, pending: false, status: '回覆完畢' }),
    card('i1', { ...opts, status: '閒置', pending: false }),
  ]
  const w = world({ ...focusOf('p1', []), sessions: four })
  await start($, on, w)
  await openPane($)
  for (const cols of [40, 70]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    for (const [tabKey, tag] of [['tab:pending', 'p1'], ['tab:all', 'a1'], ['tab:all', 'i1'], ['tab:hidden', 'h1']]) {
      await ui.press({ key: tabKey })
      const root = await ui.drawn()
      const box = findKey(root, `card:${keyOf(tag)}`)
      expect(textOf(root)).not.toMatch(/[╭╮╰╯║═╔╗╚╝]/)
      expect(box.props.borderStyle).toBeUndefined()
      expect(box.children.length).toBe(2)
      for (const child of box.children) expect([child.props.height, child.props.marginTop ?? 0]).toEqual([1, 0])
      expect(box.props.marginTop).toBe(1)
      expect(findKey(box, `question:${keyOf(tag)}`)).toBeUndefined()
      expect(textOf(box)).not.toContain('這是一個')
      expect(textOf(findKey(box, `branch:${keyOf(tag)}`)).trim()).toBe(`feat/${tag}`)
      expect(textOf(box)).not.toMatch(/a\. |第一個選項|第二個選項/)
    }
    await ui.unmount()
  }
})

// Columns a header-row node takes: a sized box its width, a button its label, text its cells, a row the sum of its children.
const widthOf = (node: any): number => {
  if (typeof node === 'string') return cells(node)
  if (node?.props?.width !== undefined) return node.props.width
  if (node?.type === 'Button' && !(node.children ?? []).length) return cells(`${node.props?.label ?? ''}`)
  return (node?.children ?? []).reduce((n: number, c: any) => n + widthOf(c), 0)
}
// The header row as a terminal lays it out: the mark, the left part with the question, the space-between gap, the right part.
const headerOf = async (ui: any, key: string) => {
  const root = await ui.drawn()
  const top = findKey(root, `card-top:${key}`)
  const [left, right] = top.children
  const question = findKey(left, `question:${key}`)
  return { top, left, right, question, gap: top.props.width - widthOf(left) - (right ? widthOf(right) : 0), questionText: question ? textOf(question) : '' }
}
// The second row: the branch on the left, the repo flush with the row's right end.
const bottomOf = async (ui: any, key: string) => {
  const root = await ui.drawn()
  const bottom = findKey(root, `card-bottom:${key}`)
  const [left, right] = bottom.children
  return { bottom, left, right, branchText: textOf(left).trim(), repo: right, repoText: right ? textOf(right) : '' }
}

for (const name of ['neutral', 'dracula'] as const) {
  test(`卡片第二行（${name}）：待回覆、全部、封存的卡片第二行左邊是 branch、右端是 repo，都用主題淡色、repo 再加 dimColor；repo 文字右端貼齊卡片右緣；第一行不放 repo；不顯示階段`, async ($, on) => {
    const w = world({ ...pending(), current: keyOf('focusui'), queue: ['perm', 'logging', 'PROJ-6668', 'upgrade#2'].map(t => ({ key: keyOf(t), isNew: false })), sessions: SESSIONS })
    appearanceConfig.set(w, { theme: name, motion: false })
    await start($, on, w)
    await openPane($)
    const theme = THEMES[name]
    for (const cols of [80, 46, 36]) {
      const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
      for (const [tabKey, pick] of [['tab:pending', (x: Card) => x.pending && x.key !== keyOf('chart')], ['tab:all', (x: Card) => !x.archived], ['tab:hidden', (x: Card) => x.archived]] as const) {
        await ui.press({ key: tabKey })
        const root = await ui.drawn()
        for (const r of SESSIONS.filter(pick)) {
          const cell = statusCell(r.status, 0, { primary: r.key === keyOf('focusui') })
          const status = findKey(root, `status:${r.key}`)
          expect([status.children[0].props.color, status.children[1].props.color]).toEqual([theme[cell.glyphColor], theme[cell.color]])
          expect(textOf(findKey(root, `card:${r.key}`))).not.toMatch(/實作中|規劃中|已推送/)
          expect(textOf(findKey(root, `card-head:${r.key}`))).not.toContain(r.repo.slice(0, 6))
          const b = await bottomOf(ui, r.key)
          expect(b.bottom.props).toMatchObject({ width: cols - 4, justifyContent: 'space-between' })
          expect(b.repo.props.key).toBe(`card-repo:${r.key}`)
          expect(b.repo.props.width).toBe(cells(b.repoText))
          expect(r.repo.startsWith(b.repoText.replace(/…$/, ''))).toBe(true)
          expect(widthOf(b.left) + 2 + b.repo.props.width).toBeLessThanOrEqual(cols - 4)
          expect(`feat/${r.tag}`.startsWith(b.branchText.replace(/…$/, ''))).toBe(true)
          const repo = b.repo.children[0]
          expect([repo.type, repo.props.color, repo.props.dimColor, repo.props.bold]).toEqual(['Text', theme.dim, true, undefined])
          expect(paintOf(b.left, b.branchText)?.color).toBe(theme.dim)
        }
      }
      await ui.press({ key: 'tab:pending' })
      await ui.unmount()
    }
  })
}

test('卡片第二行寬度：branch 與 repo 之間至少 2 格；放得下就都完整，放不下時 repo 至少留 8 格、branch 以 … 截短；沒有 branch 時 repo 可用整行', async ($, on) => {
  const long = 'feat/backend-api-request-comment-and-more'
  const w = world(withRepos({ perm: { repo: 'proj-agents-configuration', branch: long }, focusui: { repo: 'ab' }, logging: { repo: 'sara-v2-frontend', branch: '' }, 'PROJ-6668': { repo: 'sara-v2-frontend' } }))
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  for (const cols of [36, 46, 60, 80, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const inner = cols - 4 - 3
    for (const r of w.focus.sessions.filter((x: Card) => x.pending && x.key !== keyOf('chart'))) {
      const b = await bottomOf(ui, r.key)
      const branch = (r as Card).branch
      expect(cells(b.branchText) + (branch ? 2 : 0) + cells(b.repoText)).toBeLessThanOrEqual(inner)
      if (!branch) expect(b.repoText).toBe(cells(r.repo) <= inner ? r.repo : b.repoText)
      else if (cells(branch) + 2 + cells(r.repo) <= inner) expect([b.branchText, b.repoText]).toEqual([branch, r.repo])
      else {
        expect(cells(b.repoText)).toBeGreaterThanOrEqual(Math.min(8, cells(r.repo)))
        expect(b.branchText.endsWith('…') || b.branchText === branch).toBe(true)
      }
    }
    await ui.unmount()
  }
})

test('待審核卡片：review > 0 的卡片狀態字換成「待審核」（待回答色），第一行右端靠右寫「需審核 N 件」；review 0 的卡片照原狀態、沒有這段；卡片仍是兩行', async ($, on) => {
  const w = world(withRepos({ focusui: { review: 3 }, tune: { review: 1 } }))
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  for (const cols of [70, 46]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    await ui.press({ key: 'tab:all' })
    const root = await ui.drawn()
    for (const [tag, n] of [['focusui', 3], ['tune', 1]] as const) {
      const status = findKey(root, `status:${keyOf(tag)}`)
      expect(textOf(status)).toBe('◈ 待審核')
      expect([status.children[0].props.color, status.children[1].props.color]).toEqual([THEMES.neutral.waiting, THEMES.neutral.waiting])
      const h = await headerOf(ui, keyOf(tag))
      expect(h.right.children.at(-1).props.key).toBe(`card-review:${keyOf(tag)}`)
      expect(textOf(h.right)).toBe(`需審核 ${n} 件`)
      expect(paintOf(h.right, `需審核 ${n} 件`)?.color).toBe(THEMES.neutral.waiting)
      expect(widthOf(h.left) + 1 + widthOf(h.right)).toBeLessThanOrEqual(cols - 4)
      expect(findKey(root, `card:${keyOf(tag)}`).children).toHaveLength(2)
    }
    expect(textOf(findKey(root, `status:${keyOf('logging')}`))).toBe('◆ 待回答')
    expect(findKey(root, `card-review:${keyOf('logging')}`)).toBeUndefined()
    await ui.unmount()
  }
})

test('代回中卡片：autoReply 有值的卡片狀態寫「↻ 代回中」（已回覆色），第二行左邊寫「已代回：<答案>」；需審核 N 件照舊；沒有 autoReply 的照原狀態', async ($, on) => {
  const w = world(withRepos({ focusui: { review: 2, autoReply: '先改  API' } }))
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  const root = await ui.drawn()
  const status = findKey(root, `status:${keyOf('focusui')}`)
  expect(textOf(status).trim()).toBe('↻ 代回中')
  expect([status.children[0].props.color, status.children[1].props.color]).toEqual([THEMES.neutral.answered, THEMES.neutral.answered])
  expect(textOf(findKey(root, `branch:${keyOf('focusui')}`)).trim()).toBe('已代回：先改 API')
  expect(textOf((await headerOf(ui, keyOf('focusui'))).right)).toBe('需審核 2 件')
  expect(textOf(findKey(root, `status:${keyOf('logging')}`))).toBe('◆ 待回答')
  await ui.unmount()
})

for (const tabKey of ['tab:pending', 'tab:all', 'tab:hidden'] as const) {
  test(`卡片代號（${tabKey.slice(4)}）：代號太長時以 … 截短，標題列不畫題目、永遠一行、不超出面板`, async ($, on) => {
    const huge = 'x'.repeat(60)
    const hidden = tabKey === 'tab:hidden'
    const sessions = [
      card(huge, { repo: 'proj-agents-configuration', archived: hidden, pending: !hidden, advice: { state: 'ready', text: '', answer: 'a', reason: '' } } as any),
      card('PROJ-6668-very-long-name', { repo: 'sara-v2-frontend', archived: hidden, pending: !hidden, question: '一個相當長的題目要截短才放得進去' }),
    ]
    const w = world({ ...focusOf(hidden ? 'band' : huge, hidden ? [] : ['PROJ-6668-very-long-name']), sessions: [...sessions, ...(hidden ? [card('band')] : [])] })
    appearanceConfig.set(w, { motion: false })
    await start($, on, w)
    await openPane($)
    for (const cols of [36, 46, 60]) {
      const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
      await ui.press({ key: tabKey })
      for (const r of sessions) {
        const h = await headerOf(ui, r.key)
        expect(findKey(await ui.drawn(), `card-head:${r.key}`).props.height).toBe(1)
        const tagText = hidden ? textOf(h.left.children[2]) : (await ui.find({ key: `name:${r.key}` }))!.props.label as string
        const hint = (r as any).advice ? (cols >= 46 ? 6 : 1) : 0
        expect(h.question).toBeUndefined()
        expect(textOf(h.left)).not.toContain('一個相當長的題目')
        expect(widthOf(h.left) + (hint ? 1 + widthOf(h.right) : 0)).toBeLessThanOrEqual(cols - 4)
        if (r.tag === huge) {
          expect(tagText.endsWith('…')).toBe(true)
          expect(r.tag.startsWith(tagText.slice(0, -1))).toBe(true)
        }
      }
      await ui.unmount()
    }
  })
}

test('待回覆卡片深淺：文字中只有代號是前景色粗體（選中時強調色粗體），狀態照原狀態色；題目、branch、repo 都是淡色；不顯示階段；✓ 建議照舊強調色', async ($, on) => {
  const extra = { perm: { branch: 'feat/12-items', advice: { state: 'ready', text: '', answer: 'a', reason: '照前例' } } }
  const w = world(withRepos(extra))
  appearanceConfig.set(w, { theme: 'dracula', motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const theme = THEMES.dracula
  const root = await ui.drawn()
  const rows = w.focus.sessions.filter((x: Card) => x.pending)
  const runs: any[] = []
  const walk = (node: any, inherited: any = {}) => {
    if (typeof node !== 'object' || !node) return
    const paint = node.type === 'Text' ? { color: node.props?.color ?? inherited.color, bold: node.props?.bold ?? inherited.bold, dimColor: node.props?.dimColor ?? inherited.dimColor } : inherited
    const own = (node.children ?? []).filter((c: any) => typeof c === 'string').join('')
    if (node.type === 'Text' && own.trim()) runs.push({ text: own, ...paint })
    for (const c of node.children ?? []) walk(c, paint)
  }
  for (const r of rows) {
    runs.length = 0
    walk(findKey(root, `card:${r.key}`))
    const chosen = r.key === keyOf('perm')
    const strong = runs.filter(x => x.bold)
    expect(strong.map(x => x.text.trim())).toEqual(chosen ? [MARK_STILL, r.tag] : [r.tag])
    expect(strong.at(-1).color).toBe(chosen ? theme.accent : theme.fg)
    const cell = statusCell(r.status, 0, { primary: r.key === keyOf('perm') })
    const statusRuns = [cell.glyph, ` ${cell.label}`]
    for (const x of runs.filter(x => statusRuns.some(t => x.text.startsWith(t)))) expect(x.color).toBe(x.text === cell.glyph ? theme[cell.glyphColor] : theme[cell.color])
    for (const x of runs.filter(x => !x.bold && x.text !== '✓' && !statusRuns.some(t => x.text.startsWith(t)))) expect([x.text, x.color]).toEqual([x.text, theme.dim])
    runs.length = 0
    walk(findKey(root, `card-branch:${r.key}`))
    expect(runs.every(x => x.color === theme.dim && !x.bold)).toBe(true)
  }
  for (const r of rows) expect(findKey(root, `stage:${r.key}`)).toBeUndefined()
  expect(textOf(root)).not.toMatch(/實作中|規劃中|已推送/)
  expect(textOf(findKey(root, `branch:${keyOf('perm')}`)).trim()).toBe('feat/12-items')
  expect(paintOf(root, 'feat/12-items')?.color).toBe(theme.dim)
  expect((await ui.find({ type: 'Text', text: '✓' }))?.props.color).toBe(theme.accent)
  expect((await ui.find({ type: 'Text', text: ' 建議' }))?.props.color).toBe(theme.dim)
  await ui.unmount()
})

test('卡片左邊留白：選中標記前多一格，沒選中的卡與第二行一起往右 1 欄；待回覆、全部、封存都一樣，repo 分組標題線不動', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const cardsOf = (root: any, prefix: string) => {
    const out: any[] = []
    const walk = (node: any) => {
      if (typeof node !== 'object' || !node) return
      if (node.props?.key?.startsWith(prefix) && node.children?.length >= 2 && node.props.flexDirection === 'column') return void out.push(node)
      for (const c of node.children ?? []) walk(c)
    }
    walk(root)
    return out
  }
  for (const [tabKey, prefix, rule] of [['tab:pending', 'card:', null], ['tab:all', 'card:', 'repo:'], ['tab:hidden', 'card:', 'repo:']] as const) {
    await ui.press({ key: tabKey })
    const root = await ui.drawn()
    const boxes = cardsOf(root, prefix)
    expect(boxes.length).toBeGreaterThan(0)
    let marked = 0
    for (const box of boxes) {
      const [head, ...rest] = box.children.map(textOf)
      if (head.startsWith(` ${MARK_STILL} `)) marked += 1
      else expect(head.startsWith('   ')).toBe(true)
      for (const line of rest) expect(line.startsWith('   ')).toBe(true)
    }
    expect(marked).toBe(1)
    if (rule) {
      const rules = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.key?.startsWith(rule))
      expect(rules.length).toBeGreaterThan(0)
      for (const r of rules) expect(r.text.startsWith('── ')).toBe(true)
    }
  }
  await ui.unmount()
})

{
  test(`分頁列平均分散（三個分頁）：justifyContent space-between 排滿整行，第一個貼左、最後一個貼右；粗線落在所選分頁正下方、寬度等於標籤；不足 46 欄時沒選的只留按鍵與數字、仍是一列`, async ($, on) => {
    const w = world(pending())
    appearanceConfig.set(w, { motion: false })
    await start($, on, w)
    await openPane($)
    for (const cols of [36, 45, 46, 80, 101]) {
      const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
      const row = await ui.find({ key: 'tabs' })
      expect([row?.props.justifyContent, row?.props.columnGap, row?.props.height, row?.props.flexWrap]).toEqual(['space-between', undefined, 1, undefined])
      const tabs = (await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('tab:'))
      expect(tabs).toHaveLength(3)
      for (const t of tabs) {
        await ui.press({ key: t.key })
        const now = (await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('tab:'))
        const widths = now.map((b: any) => cells(`${b.props.hotkey}: ${b.props.label}`))
        for (const b of now) {
          if (cols < 46 && b.key !== t.key) expect(b.props.label).toMatch(/^\d+$/)
          else expect(b.props.label).toMatch(/^\S+ \d+$/)
        }
        const spare = (cols - widths.reduce((a: number, b: number) => a + b, 0)) / (now.length - 1)
        const i = now.findIndex((b: any) => b.key === t.key)
        const start = Math.round(widths.slice(0, i).reduce((a: number, b: number) => a + b, 0) + i * spare)
        const line = textOf((await ui.drawn()).children[1])
        expect(cells(line)).toBe(cols)
        expect(line).toBe(`${'─'.repeat(start)}${'━'.repeat(widths[i]!)}${'─'.repeat(cols - start - widths[i]!)}`)
        if (i === 0) expect(start).toBe(0)
        if (i === now.length - 1) expect(start + widths[i]!).toBe(cols)
      }
      await ui.unmount()
    }
  })
}

for (const cols of [46, 36]) {
  test(`待回覆卡片寬度（${cols} 欄）：每列都不超出面板寬度，代號至少留 1 欄；卡與卡之間空一行、每張仍佔 3 列`, async ($, on) => {
    const huge = 'x'.repeat(60)
    const sessions = [
      card(huge, { repo: 'proj-agents-configuration', stage: '已推送', summary: '專案檢視介面調整建議與後續', advice: { state: 'ready', text: '', answer: 'a', reason: '' } } as any),
      card('短', { repo: 'a', stage: '規劃中', question: '問'.repeat(80) }),
      card('中控台中控台中控台中控台', { repo: '中控台中控台中控台' }),
    ]
    const w = world({ ...focusOf(huge, ['短', '中控台中控台中控台中控台']), sessions })
    appearanceConfig.set(w, { motion: false })
    await start($, on, w)
    await openPane($)
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const drawn = await mountedCards(ui)
    expect(drawn).toHaveLength(3)
    for (const [i, box] of drawn.entries()) {
      const lines = cardLines(box, cols)
      expect(lines).toHaveLength(3)
      expect(lines[0]).toBe(i === 0 ? lines[0] : '')
      for (const line of lines) expect(cardWidth(line)).toBeLessThanOrEqual(cols - 1)
    }
    for (const r of sessions) {
      const name = (await ui.find({ key: `name:${r.key}` }))!.props.label as string
      expect(cells(name)).toBeGreaterThanOrEqual(1)
      expect(r.tag.startsWith(name.replace(/…$/, ''))).toBe(true)
    }
    await ui.unmount()
  })
}

test('面板背景：0 開面板時要求 Claude Code 不畫面板底色（backgroundColor transparent），neutral 不另畫底色，用終端機本身的背景', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  expect(w.opened.at(-1)).toMatchObject({ id: PANE, focus: true, backgroundColor: 'transparent' })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect((await ui.findAll({ type: 'Box' })).some((b: any) => b.props.backgroundColor !== undefined)).toBe(false)
  await ui.unmount()
})

test('more than 10 cards on 待回覆: all drawn, the question on screen unnumbered, the queue 1–9 and 0, none after; arrows reach the 11th and 印出完整回報 prints it without changing the band', async ($, on) => {
  const many = Array.from({ length: 12 }, (_, i) => card(`t${i}`))
  const w = world({ ...focusOf('t0', many.slice(1).map(c => c.tag)), sessions: many })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await cardTags(ui)).toEqual(many.map(c => c.tag))
  const nums = (await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('num:'))
  expect(nums.map((b: any) => [b.key, b.props.hotkey])).toEqual(many.slice(1, 11).map((c, i) => [`num:${c.key}`, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'][i]]))
  await arrowTo($, 't10')
  expect((await ui.find({ key: `card:${keyOf('t10')}` }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await printFromBrief($, ui, keyOf('t10'))
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(w.focus.current).toBe(keyOf('t0'))
  expect(w.shown.at(-1)).toBe('t10')
  await ui.unmount()
})

test('拿掉切題：待回覆分頁按數字、Enter 或點暱稱只選中卡片，不跑 focus-pick、不換橫條上的題目、不印題目；d 再按印出完整回報才印', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  expect((await ui.find({ key: `num:${keyOf('PROJ-6668')}` }))?.props.hotkey).toBe('3')
  await ui.press({ key: `num:${keyOf('PROJ-6668')}` })
  await ui.press({ key: `name:${keyOf('logging')}` })
  await ui.press({ key: `num:${keyOf('focusui')}` })
  expect(w.calls.filter(c => c[0].startsWith('focus-') && c[0] !== 'focus-shown')).toEqual([])
  expect(w.focus.current).toBe(keyOf('perm'))
  expect(w.shown).toEqual([])
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  expect((await ui.find({ key: `card:${keyOf('focusui')}` }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  await printFromBrief($, ui, keyOf('PROJ-6668'))
  expect(w.shown).toEqual(['PROJ-6668'])
  await ui.unmount()
})

test('the pane follows the band while it is open: a defer or a new stop on the band reorders 待回覆 at once', async ($, on) => {
  const w = world(pending())
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const b = await $.ui.mount({ ...band(), surface: 'terminal' })
  await b.press({ key: 'later' })
  expect(await cardTags(ui)).toEqual(['focusui', 'logging', 'PROJ-6668', 'upgrade#2', 'perm'])
  w.focus = focusOf('upgrade#2', ['perm', 'focusui'])
  await clock.advance(5_000)
  expect(await cardTags(ui)).toEqual(['upgrade#2', 'perm', 'focusui'])
  const nums = (await ui.findAll({ type: 'Button' })).filter((x: any) => x.key.startsWith('num:'))
  expect(nums.map((x: any) => x.props.hotkey)).toEqual(['1', '2'])
  await b.unmount()
  await ui.unmount()
})

test('arrow keys land on the nickname and the chosen card follows them without switching; d opens its recap, whose 印出完整回報 prints', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: `num:${keyOf('focusui')}`, origin: { kind: 'person' } } as any)
  expect(w.focused.at(-1)).toBe(`name:${keyOf('focusui')}`)
  expect((await ui.find({ key: `card:${keyOf('focusui')}` }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await arrowTo($, 'perm')
  await printFromBrief($, ui, keyOf('perm'))
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  await ui.unmount()
})

test('on the other tabs a number only chooses the card, d then 印出完整回報 prints it; a card that also waits on you does not switch the band', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  await ui.press({ key: `num:${keyOf('tune')}` })
  await ui.press({ key: `num:${keyOf('tune')}` })
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(w.shown).toEqual([])
  expect((await ui.find({ key: `card:${keyOf('tune')}` }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  await printFromBrief($, ui, keyOf('tune'))
  expect(w.shown).toEqual(['tune'])
  await ui.press({ key: `num:${keyOf('logging')}` })
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(w.focus.current).toBe(keyOf('perm'))
  await ui.unmount()
})

test('「狀態」 typed with mods goes on to the conversation as typed and opens nothing; the pane opens only from 0', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  for (const text of ['狀態', '  狀態 ', '待回覆']) {
    const res = await $.prompt.submit({ text, wait: false, origin: { kind: 'user' } } as any)
    expect(res.drop).toBeUndefined()
    expect(res.text).toBe(text)
  }
  expect(w.opened).toEqual([])
  await openPane($)
  expect(w.opened.at(-1)).toMatchObject({ id: PANE, focus: true })
})

test('「狀態」 without mods goes on to the conversation untouched', async ($, on) => {
  const w = world({ active: false })
  await start($, on, w)
  const res = await $.prompt.submit({ text: '狀態', wait: false, origin: { kind: 'user' } } as any)
  expect(res.drop).toBeUndefined()
  expect(w.opened).toEqual([])
})

test('封存 tab cards carry 取消封存 instead of the nickname button: it runs unarchive, and the card leaves 封存 for its status tab', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  expect(await cardTags(ui)).not.toContain('取消封存')
  await ui.press({ key: 'tab:hidden' })
  expect(await cardTags(ui)).toEqual(['取消封存'])
  expect((await ui.find({ key: `card:${keyOf('PROJ-6650')}` }))?.text).toContain('PROJ-6650')
  await ui.press({ key: `name:${keyOf('PROJ-6650')}` })
  expect(w.calls.at(-2)).toEqual(['unarchive', 'PROJ-6650'])
  expect(w.calls.at(-1)).toEqual(['focus', '--session', 'console-session', '--owner', 'console-session@1000', '--typing', '0', '--turn', '0'])
  expect(w.shown).toEqual([])
  expect(await cardTags(ui)).toEqual([])
  expect((await ui.find({ key: 'tab:hidden' }))?.props.label).toBe('封存 0')
  await ui.press({ key: 'tab:all' })
  expect(await cardTags(ui)).toContain('PROJ-6650')
  expect(await cardTags(ui)).toContain('chart')
  await ui.unmount()
})

test('outside Orca, or in a session that is not the console, nothing is drawn', async ($, on) => {
  const w = world({ active: false })
  await start($, on, w, {})
  expect(w.calls).toEqual([])
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ key: 'pane' })).toBeUndefined()
  await ui.unmount()
  const h = await $.ui.mount({ ...hint, surface: 'terminal' })
  expect(w.hints.at(-1)).toEqual(hint.props)
  await h.unmount()
})

const EMPTY = '目前沒有符合條件的 session'
const nothing = () => ({ active: true, home: HOME, current: null, waiting: { tag: 'perm' }, queue: [], band: { title: '狀態', rail: 'dim', rows: [{ variants: [[{ text: '◌ 等 ', color: 'dim' }, { text: 'perm', bold: true }, { text: ' 回應中…', color: 'dim' }]], keys: [{ key: '0', label: '面板', action: 'pane' }] }] }, sessions: [] })
const cells = (t: string) => [...t].reduce((n, c) => n + (c.codePointAt(0)! > 0x2e80 ? 2 : 1), 0)

test('empty pane: every tab says 目前沒有符合條件的 session, never a bare 目前沒有', async ($, on) => {
  const w = world(nothing())
  await start($, on, w)
  await openPane($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(), surface })
    for (const key of ['tab:pending', 'tab:all', 'tab:hidden']) {
      await ui.press({ key })
      expect(await cardTags(ui)).toEqual([])
      const words = (await texts(ui)).map((t: string) => t.trim())
      expect(words).toContain(EMPTY)
      expect(words).not.toContain('目前沒有')
    }
    await ui.unmount()
  }
})

test('empty pane: a round frame as wide as the pane, a blank line above and below grey text, 5 rows tall', async ($, on) => {
  const w = world(nothing())
  await start($, on, w)
  await openPane($)
  for (const cols of [80, 144]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const box = await ui.find({ key: 'empty' })
    expect(box?.props).toMatchObject({ borderStyle: 'round', width: cols, paddingY: 1 })
    const text = await ui.find({ type: 'Text', text: EMPTY })
    expect(text?.props.color).toBe(THEMES.neutral.dim)
    expect(cells(text!.text)).toBeLessThanOrEqual(cols - 2)
    expect(2 + 2 * box!.props.paddingY + 1).toBe(5)
    await ui.unmount()
  }
})

test('empty pane: the text sits in the middle of the frame at 80 and 144 columns, the two sides at most one column apart', async ($, on) => {
  const w = world(nothing())
  await start($, on, w)
  await openPane($)
  for (const cols of [80, 144]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const line = (await ui.find({ type: 'Text', text: EMPTY }))!.text
    const left = line.length - line.trimStart().length
    const right = cols - 2 - cells(line)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
    await ui.unmount()
  }
})

test('empty pane: the frame takes the theme border colour, never the chosen card accent', async ($, on) => {
  const w = world(nothing())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const color = (await ui.find({ key: 'empty' }))!.props.borderColor as string
  expect(color).toBe(THEMES.neutral.border)
  expect(color).not.toBe(THEMES.neutral.accent)
  await ui.unmount()
})

const withRepos = (repos: Record<string, Partial<Card>>) => ({ ...pending(), sessions: SESSIONS.map(s => ({ ...s, ...repos[s.tag] })) })

test('卡片第二行在待回覆：branch 用主題淡色，不放題目、摘要或 建議：；repo 在第二行右端、不在標題列', async ($, on) => {
  const w = world(withRepos({ perm: { summary: '專案檢視介面調整建議' } }))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(paintOf(await ui.drawn(), 'feat/perm')?.color).toBe(THEMES.neutral.dim)
  for (const r of pending().sessions.filter(x => x.pending)) {
    const text = (await ui.find({ key: `card-branch:${r.key}` }))?.text ?? ''
    expect(text).toContain(r.branch)
    expect(text).toContain(r.repo)
    expect(text).not.toContain(r.question)
    expect(text).not.toContain('專案檢視介面調整建議')
    expect(text).not.toContain('建議：')
    expect((await ui.find({ key: `card-head:${r.key}` }))?.text).not.toContain(r.repo)
  }
  await ui.unmount()
})

const cardWidth = (t: string) => [...t].reduce((n, c) => n + (c.codePointAt(0)! > 0x2e80 ? 2 : 1), 0)

test('卡片寬度：每一寬度下，標題列（代號、2 格、題目）與第二行（3 格、branch、2 格、repo）都不超出面板', async ($, on) => {
  const w = world(withRepos({ perm: { repo: 'proj-agents-configuration', branch: 'feat/backend-api-request-comment' }, 'upgrade#2': { repo: 'abcdefghijklmnopqrst' }, logging: { repo: '中控台中控台中控台中控台' } }))
  await start($, on, w)
  await openPane($)
  for (const cols of [36, 40, 45, 46, 52, 70, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    for (const r of w.focus.sessions.filter((x: Card) => x.pending)) {
      const h = await headerOf(ui, r.key)
      const b = await bottomOf(ui, r.key)
      expect(widthOf(h.left) + (h.right ? 1 + widthOf(h.right) : 0)).toBeLessThanOrEqual(cols - 4)
      expect(3 + cardWidth(b.branchText) + 2 + cardWidth(b.repoText)).toBeLessThanOrEqual(cols - 4)
      expect(cardWidth(h.questionText)).toBeLessThanOrEqual(h.question?.props.width ?? 0)
    }
    await ui.unmount()
  }
})

test('卡片寬度: a ticketless worktree (backend…) keeps 代號, status and stage on one row; a 代號 too long for the row is cut with … so the status tag never stacks', async ($, on) => {
  const long = 'feat/backend-api-request-comment'
  const w = world({ ...pending(), sessions: SESSIONS.map(s => (s.tag === 'focusui' ? { ...s, tag: 'backend…' } : s.tag === 'logging' ? { ...s, tag: long } : s)) })
  await start($, on, w)
  await openPane($)
  for (const cols of [40, 52, 70, 90]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    for (const r of w.focus.sessions.filter((x: Card) => x.pending)) {
      const label = (await ui.find({ key: `name:${r.key}` }))?.props.label
      if (r.tag === 'backend…') expect(label).toBe('backend…')
      // The mark and the right margin, the number and status columns; no question takes room after the 代號.
      const room = cols - 4 - 13
      if (r.tag === long) expect(cardWidth(long) <= room ? label === long : label.endsWith('…') && long.startsWith(label.slice(0, -1))).toBe(true)
      expect(cardWidth(label)).toBeLessThanOrEqual(room)
    }
    await ui.unmount()
  }
})

test('cards on 全部 and 封存 show their repo on the second row and never the stage (規劃中, 實作中, 已推送) or 建議：, at any width', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  for (const cols of [36, 46, 70, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    await ui.press({ key: 'tab:all' })
    for (const tag of ['focusui', 'PROJ-6668', 'tune', 'perm', 'chart']) {
      const r = SESSIONS.find(s => s.tag === tag)!
      expect((await ui.find({ key: `card:${keyOf(tag)}` }))?.text).not.toMatch(/規劃中|實作中|已推送|建議：/)
      expect((await ui.find({ key: `stage:${keyOf(tag)}` }))).toBeUndefined()
      expect(r.repo.startsWith((await ui.find({ key: `card-repo:${keyOf(tag)}` }))!.text.trimStart().replace(/…$/, ''))).toBe(true)
    }
    await ui.press({ key: 'tab:hidden' })
    expect((await ui.find({ key: `card:${keyOf('PROJ-6650')}` }))?.text).not.toMatch(/規劃中|實作中|已推送|建議：/)
    expect((await ui.find({ key: `card-repo:${keyOf('PROJ-6650')}` }))?.text).toMatch(/^proj-v2/)
    await ui.press({ key: 'tab:pending' })
    await ui.unmount()
  }
})

test('band 8 with text in the prompt: the text goes on as typed and nothing is deferred', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  for (const text of ['8', '8 號那題先 commit']) {
    const res = await $.prompt.submit({ text, wait: false, origin: { kind: 'user' } } as any)
    expect(res.text).toBe(text)
  }
  expect(w.calls.filter(c => c[0] === 'focus-later')).toEqual([])
  await ui.unmount()
})

test('band: 8 only ever defers; nothing goes into the prompt box', async ($, on) => {
  const w = world(pending())
  const fills: unknown[] = []
  on('prompt.fill', async (_$, e) => {
    fills.push(e)
    return { isFilled: true, text: '', cursor: 0 } as any
  })
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ key: 'prefill' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => b.props.hotkey === '8').map((b: any) => b.key)).toEqual(['later'])
  await ui.press({ key: 'later' })
  expect(fills).toEqual([])
  expect(w.calls.at(-1)).toEqual(['focus-later'])
  await ui.unmount()
})

const FOOTER_TEXT = 'qwe 切分頁 · 1-9,0/↑↓ 選卡片'

const queued = (n: number) => Array.from({ length: n }, (_, i) => card(`q${i}`))
const chosenTag = async (ui: any) => (await ui.findAll({ type: 'Box' })).find((b: any) => b.key?.startsWith('card:') && [MARK_STILL, ...MARK_SPIN].some(m => b.text.startsWith(` ${m}`)))?.key.slice(5).replace(/@1$/, '')
const drawnTags = async (ui: any) => (await ui.findAll({ type: 'Box' })).filter((b: any) => b.key?.startsWith('card:')).map((b: any) => b.key.slice(5).replace(/@1$/, ''))
// ↑↓ as the engine moves them: its ring starts on the autoFocus nickname and keeps a numeric place across redraws (none once past the end);
// each arrow steps one Button back or forth in document order, wrapping, and lands where the hooks send it.
function arrows($: any, ui: any, w: World) {
  let at: number | null = null
  const buttons = async () => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key) as string[]
  return async (dir: 1 | -1) => {
    let keys = await buttons()
    if (at === null) {
      await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: `name:${keyOf(await chosenTag(ui))}`, origin: { kind: 'plugin', name: PLUGIN } } as any)
      keys = await buttons()
      at = keys.indexOf(w.focused.at(-1)!)
    }
    const n = keys.length
    const element = at < n ? keys[(at + dir + n) % n] : keys[dir === 1 ? 0 : n - 1]
    await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element, origin: { kind: 'person' } } as any)
    at = (await buttons()).indexOf(w.focused.at(-1)!)
  }
}
// The keys line's text, without the ─ runs around it.
const footerLines = async (ui: any) => {
  const root = await ui.drawn()
  const footer = root.children.find((c: any) => c.props.key === 'footer')
  return footer ? footer.children.map((t: any) => t.children.join('').replace(/^─+ (.*) ─+$/, '$1')) : null
}

for (const tabKey of ['tab:pending', 'tab:all', 'tab:hidden'] as const) {
  test(`按鍵說明（${tabKey.slice(4)}）：補滿整行、文字置中，前後用 ─ 夾住、兩邊至少各 2 個；太窄時先截說明文字`, async ($, on) => {
    {
      const w = world(pending())
      appearanceConfig.set(w, { motion: false })
      await start($, on, w)
      await openPane($)
      const keys = 'qwe 切分頁 · 1-9,0/↑↓ 選卡片'
      for (const cols of [20, 30, 36, 46, 70, 81]) {
        const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
        await ui.press({ key: tabKey })
        const footer = (await ui.drawn()).children.find((c: any) => c.props.key === 'footer')
        expect(footer.props.paddingLeft).toBeUndefined()
        const line = textOf(footer)
        expect(cells(line)).toBe(cols)
        const m = /^(─+) (.+) (─+)$/.exec(line)!
        expect(m).not.toBeNull()
        const [, left, text, right] = m
        expect(left!.length).toBeGreaterThanOrEqual(2)
        expect(right!.length).toBeGreaterThanOrEqual(2)
        expect(Math.abs(left!.length - right!.length)).toBeLessThanOrEqual(1)
        if (cells(keys) <= cols - 6) expect(text).toBe(keys)
        else expect([text!.endsWith('…'), keys.startsWith(text!.slice(0, -1)), cells(text!) <= cols - 6, cells(text!) >= cols - 7]).toEqual([true, true, true, true])
        expect(paintOf(await ui.drawn(), line)?.color).toBe(THEMES.neutral.dim)
        await ui.unmount()
      }
    }
  })
}

test('待回覆 numbers: the question on screen has none; the queue is 1, 2, … in order; a number only chooses that card and never switches the band', async ($, on) => {
  const many = queued(7)
  const start0 = { ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] }
  const w = world(start0)
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await ui.find({ key: `num:${keyOf('perm')}` })).toBeUndefined()
  const paneNums = (await ui.findAll({ type: 'Button' })).filter((x: any) => x.key.startsWith('num:')).map((x: any) => [x.props.hotkey, x.key.slice(4)])
  expect(paneNums).toEqual(many.map((c, i) => [String(i + 1), c.key]))
  for (const n of [1, 3, 5]) {
    await ui.press({ key: `num:${paneNums[n - 1]![1]}` })
    expect(await chosenTag(ui)).toBe(`q${n - 1}`)
  }
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(w.focus.current).toBe(keyOf('perm'))
  await ui.unmount()
})

test('狀態區只有 8、9、0 三個鍵：排隊再多，1–7 都不是狀態區的鍵，輸入框空白時照常打進輸入框、不換題', async ($, on) => {
  const many = queued(7)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  const hotkeys = (await ui.findAll({ type: 'Button' })).map((x: any) => x.props.hotkey).filter(Boolean)
  expect(hotkeys).toEqual(['8', '9', '0'])
  for (const text of ['1', '5', '6', '7']) {
    const res = await $.prompt.submit({ text, wait: false, origin: { kind: 'user' } } as any)
    expect(res.text).toBe(text)
  }
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(w.focus.current).toBe(keyOf('perm'))
  await ui.unmount()
})

test('待回覆 cards past the 5th go on 6, 7, …; the pane picks them by that number, also when scrolled out of view', async ($, on) => {
  const many = queued(8)
  const start0 = { ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] }
  const w = world(start0)
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ key: `num:${keyOf('q5')}` }))?.props.hotkey).toBe('6')
  expect((await ui.find({ key: `num:${keyOf('q6')}` }))?.props.hotkey).toBe('7')
  expect((await ui.find({ key: `num:${keyOf('q7')}` }))?.props.hotkey).toBe('8')
  await ui.press({ key: `num:${keyOf('q6')}` })
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(await chosenTag(ui)).toBe('q6')
  await ui.unmount()
  w.focus = start0
  await clock.advance(5_000)
  await openPane($)
  const small = await $.ui.mount({ ...pane(70, 13), surface: 'terminal' })
  expect(await drawnTags(small)).toEqual(['perm', 'q0', 'q1'])
  expect(await drawnTags(small)).not.toContain('q6')
  const off = await small.find({ key: `num:${keyOf('q6')}` })
  expect(off?.props.hotkey).toBe('7')
  await small.press({ key: `num:${keyOf('q6')}` })
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(await chosenTag(small)).toBe('q6')
  expect(await drawnTags(small)).toContain('q6')
  await small.unmount()
})

test('↑↓ in the pane move the chosen frame one card on every tab, and stop on the first and last card', async ($, on) => {
  const extra = [card('arch2', { archived: true, pending: false, status: '回覆完畢' }), card('idle2', { status: '閒置', pending: false })]
  const w = world({ ...pending(), sessions: [...SESSIONS, ...extra] })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const arrow = arrows($, ui, w)
  for (const key of ['tab:pending', 'tab:all', 'tab:hidden']) {
    await ui.press({ key })
    const tags = (await drawnTags(ui)) as string[]
    expect(tags.length).toBeGreaterThan(1)
    expect(await chosenTag(ui)).toBe(tags[0])
    await arrow(-1)
    expect(await chosenTag(ui)).toBe(tags[0])
    for (const t of tags.slice(1)) {
      await arrow(1)
      expect(await chosenTag(ui)).toBe(t)
      expect(w.focused.at(-1)).toBe(`name:${keyOf(t)}`)
    }
    await arrow(1)
    expect(await chosenTag(ui)).toBe(tags.at(-1))
    for (const t of tags.slice(0, -1).reverse()) {
      await arrow(-1)
      expect(await chosenTag(ui)).toBe(t)
    }
    await arrow(-1)
    expect(await chosenTag(ui)).toBe(tags[0])
  }
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await ui.unmount()
})

test('tabs switch with q/w/e (no ←→: the engine binds no left or right in a pane): 待回覆 chooses the question on screen, the others their first card, and ↓ then moves from there', async ($, on) => {
  const w = world({ ...pending(), sessions: [...SESSIONS, card('arch2', { archived: true, pending: false, status: '回覆完畢' })] })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const arrow = arrows($, ui, w)
  await arrow(1)
  await arrow(1)
  expect(await chosenTag(ui)).toBe('logging')
  await ui.press({ key: 'tab:all' })
  expect(await chosenTag(ui)).toBe('focusui')
  await arrow(1)
  expect(await chosenTag(ui)).toBe('logging')
  await ui.press({ key: 'tab:hidden' })
  expect(await chosenTag(ui)).toBe('PROJ-6650')
  await arrow(1)
  expect(await chosenTag(ui)).toBe('arch2')
  await ui.press({ key: 'tab:pending' })
  expect(await chosenTag(ui)).toBe('perm')
  await arrow(1)
  expect(await chosenTag(ui)).toBe('focusui')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('tab:')).map((b: any) => b.props.hotkey)).toEqual(['q', 'w', 'e'])
  await ui.unmount()
})

test('pane footer keys read only 「qwe 切分頁 · 1-9,0/↑↓ 選卡片」, never qwer, no Enter or Esc', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const lines = (await footerLines(ui))!
  expect(lines).toEqual(['qwe 切分頁 · 1-9,0/↑↓ 選卡片'])
  expect(lines.join('')).not.toMatch(/Enter|Esc|qwer/)
  await ui.unmount()
})

test('pane footer on every tab, the empty frame too, is only the keys line, right under the last card with one blank row between and blank space below; no 執行中 or 回覆完畢', async ($, on) => {
  const w = world(pending())
  const clock = await start($, on, w)
  await openPane($)
  for (const focus of [pending(), nothing()]) {
    w.focus = focus
    await clock.advance(5_000)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...pane(70, 200), surface })
      for (const key of ['tab:pending', 'tab:all', 'tab:hidden']) {
        await ui.press({ key })
        const root = await ui.drawn()
        expect(root.props.height).toBe(200)
        expect(root.children.map((c: any) => c.props.key)).toEqual(['tabs', undefined, 'cards', 'footer'])
        const [, , cardsBox, footer] = root.children
        expect(cardsBox.props.flexGrow).toBeUndefined()
        expect(footer.props).toMatchObject({ marginTop: 1, flexShrink: 0 })
        expect(await footerLines(ui)).toEqual([FOOTER_TEXT])
        expect((await texts(ui)).filter((t: string) => /執行中 \d|回覆完畢 \d/.test(t))).toEqual([])
      }
      await ui.unmount()
    }
  }
})

test('cards past the pane height: the keys line scrolls with the cards, out of view until the end, then whole under the last card; every row above the end goes to cards', async ($, on) => {
  const many = queued(10)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  let engineScrolled = 0
  on('ui.scroll', async () => {
    engineScrolled += 1
    return {}
  })
  await start($, on, w)
  await openPane($)
  for (const [rows, first, last] of [
    [13, ['perm', 'q0', 'q1'], ['q7', 'q8', 'q9']],
    [12, ['perm', 'q0', 'q1'], ['q8', 'q9']],
  ] as const) {
    const ui = await $.ui.mount({ ...pane(70, rows), surface: 'terminal' })
    const scroll = (by: number, pointer?: object) => $.ui.scroll({ component: 'Pane', requestId: PANE, offset: 0, by, bodyRows: rows, contentRows: rows, origin: { kind: 'person' }, ...(pointer && { pointer }) } as any)
    const check = async (end: boolean) => {
      const root = await ui.drawn()
      expect(root.props.height).toBe(rows)
      const drawn = (await drawnTags(ui)).length
      const foot = end ? 2 : 0
      expect(await footerLines(ui)).toEqual(end ? [FOOTER_TEXT] : null)
      // Each card takes 3 rows: the blank row above it and its two rows.
      expect(2 + drawn * 3 + foot).toBeLessThanOrEqual(rows)
      expect(2 + (drawn + 1) * 3 + foot).toBeGreaterThan(rows)
    }
    expect(await drawnTags(ui)).toEqual([...first])
    await check(false)
    expect(await scroll(1, { column: 5, row: 5 })).toEqual({})
    expect(await drawnTags(ui)).toEqual(['q0', 'q1', 'q2'])
    await check(false)
    await scroll(rows)
    expect(await drawnTags(ui)).toEqual(['q3', 'q4', 'q5'])
    await check(false)
    for (let i = 0; i < 10; i++) await scroll(1, { column: 5, row: 5 })
    expect(await drawnTags(ui)).toEqual([...last])
    await check(true)
    for (let i = 0; i < 4; i++) await scroll(-rows)
    expect(await drawnTags(ui)).toEqual([...first])
    await check(false)
    const arrow = arrows($, ui, w)
    for (let i = 0; i < 4; i++) {
      await arrow(1)
      await check(false)
    }
    for (let i = 0; i < 9; i++) await arrow(1)
    expect(await chosenTag(ui)).toBe('q9')
    expect(await drawnTags(ui)).toEqual([...last])
    await check(true)
    for (let i = 0; i < 13; i++) await arrow(-1)
    await ui.unmount()
  }
  expect(engineScrolled).toBe(0)
})

test('the same pane height holds more cards than when the counts and keys were pinned under them, and more than 5-row framed cards did', async ($, on) => {
  const many = queued(10)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  await start($, on, w)
  await openPane($)
  for (const rows of [17, 22, 27]) {
    const ui = await $.ui.mount({ ...pane(70, rows), surface: 'terminal' })
    expect((await drawnTags(ui)).length).toBe(Math.floor((rows - 2) / 3))
    expect((await drawnTags(ui)).length).toBeGreaterThan(Math.floor((rows - 5) / 3))
    expect((await drawnTags(ui)).length).toBeGreaterThan(Math.floor((rows - 2) / 5))
    await ui.unmount()
  }
})

test('↑↓ onto a card out of view scrolls the pane until that card shows whole', async ($, on) => {
  const many = queued(10)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(70, 13), surface: 'terminal' })
  const arrow = arrows($, ui, w)
  expect(await drawnTags(ui)).toEqual(['perm', 'q0', 'q1'])
  await arrow(1)
  await arrow(1)
  expect(await drawnTags(ui)).toEqual(['perm', 'q0', 'q1'])
  await arrow(1)
  expect(await chosenTag(ui)).toBe('q2')
  expect(await drawnTags(ui)).toEqual(['q0', 'q1', 'q2'])
  expect(w.focused.at(-1)).toBe(`name:${keyOf('q2')}`)
  for (let i = 0; i < 9; i++) await arrow(1)
  expect(await chosenTag(ui)).toBe('q9')
  expect(await drawnTags(ui)).toEqual(['q7', 'q8', 'q9'])
  for (let i = 0; i < 9; i++) await arrow(-1)
  expect(await chosenTag(ui)).toBe('q0')
  expect(await drawnTags(ui)).toEqual(['q0', 'q1', 'q2'])
  await arrow(-1)
  expect(await chosenTag(ui)).toBe('perm')
  expect(await drawnTags(ui)).toEqual(['perm', 'q0', 'q1'])
  await ui.unmount()
})

test('全部的 repo 分組線與它下面第一張卡之間空一行，捲動照新的列數算：分組線前空一行、線一行、卡上方空一行、卡兩行；↑↓ 選到的卡照舊完整露出，捲到底時按鍵說明也露出', async ($, on) => {
  const list = [card('a1', { repo: 'r1' }), card('a2', { repo: 'r1', pending: false }), card('b1', { repo: 'r2', pending: false }), card('c1', { repo: 'r3', pending: false }), card('c2', { repo: 'r3', pending: false })]
  const w = world({ ...focusOf('a1', []), sessions: list })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  // 13 rows: the tab row and its underline leave 11 for the cards; a card under a rule takes 5, any other 3.
  const ui = await $.ui.mount({ ...pane(70, 13), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  const arrow = arrows($, ui, w)
  const used = async () => {
    const cards = (await ui.drawn()).children.find((c: any) => c.props.key === 'cards')
    return cards.children.filter((c: any) => typeof c === 'object' && (c.props.key?.startsWith('card:') || c.props.key?.startsWith('repo:'))).reduce((n: number, c: any) => n + (c.props.marginTop ?? 0) + (c.props.key.startsWith('card:') ? 2 : 1), 0)
  }
  expect(await drawnTags(ui)).toEqual(['a1', 'a2'])
  expect(await used()).toBe(8)
  for (const [tag, shown, rows] of [['a2', ['a1', 'a2'], 8], ['b1', ['a2', 'b1'], 10], ['c1', ['b1', 'c1'], 10], ['c2', ['c1', 'c2'], 8]] as const) {
    await arrow(1)
    expect(await chosenTag(ui)).toBe(tag)
    expect(await drawnTags(ui)).toEqual(shown)
    expect(await used()).toBe(rows)
    expect(await used()).toBeLessThanOrEqual(11)
  }
  expect(await footerLines(ui)).toEqual([FOOTER_TEXT])
  for (const tag of ['a2', 'b1', 'c1']) {
    const box = await ui.find({ key: `card:${keyOf(tag)}` })
    if (box) expect(box.props.marginTop).toBe(1)
  }
  await ui.unmount()
})

test('階段字（規劃中、實作中、已推送、未開工）在待回覆、全部、封存的卡片上都不畫，任何寬度都一樣；repo 在卡片第二行右端', async ($, on) => {
  const name = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const cards = [card('短名', { repo: 'claude-personal' }), card(name), card('無進度', { stage: '—' }), card('沒開工', { stage: '未開工' })]
  const w = world({ ...focusOf('短名', [name, '無進度', '沒開工']), sessions: cards })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  for (const cols of [80, 60, 59, 46, 45, 39, 36]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    await ui.press({ key: 'tab:pending' })
    for (const c of cards) expect(await ui.find({ key: `stage:${c.key}` })).toBeUndefined()
    expect((await ui.find({ key: `card:${cards[0]!.key}` }))!.text).not.toContain('實作中')
    await ui.press({ key: 'tab:all' })
    for (const c of cards) {
      expect(await ui.find({ key: `stage:${c.key}` })).toBeUndefined()
      expect((await ui.find({ key: `card:${c.key}` }))!.text).not.toMatch(/實作中|未開工|階段/)
    }
    expect(await ui.find({ type: 'Text', text: '實作中' })).toBeUndefined()
    expect((await ui.find({ key: `card-repo:${cards[0]!.key}` }))!.text).toBe('claude-personal')
    await ui.press({ key: 'tab:pending' })
    await ui.unmount()
  }
})

// The mount kit exposes the drawn tree, not terminal cells. Lay out the card's
// text/box subset so a vertically stacked corner or wrapped hotkey is observable.
type CardDrawn = { type: string; props?: { key?: string; hotkey?: string; label?: string; width?: number; height?: number; overflow?: string; borderStyle?: string; paddingX?: number; flexDirection?: string; marginTop?: number }; children?: (CardDrawn | string)[] }
const drawnText = (node: CardDrawn | string): string => typeof node === 'string' ? node : node.type === 'Button'
  ? `${node.props?.hotkey ? `${node.props.hotkey}: ` : ''}${node.props?.label ?? ''}`
  : (node.children ?? []).map(drawnText).join('')
const cardLines = (node: CardDrawn | string, width: number): string[] => {
  if (typeof node === 'string' || node.type !== 'Box') {
    const text = drawnText(node)
    const lines = ['']
    for (const char of text) {
      if (char === '\n') lines.push('')
      else {
        if (cardWidth(lines[lines.length - 1]!) + cardWidth(char) > width) lines.push('')
        lines[lines.length - 1] += char
      }
    }
    return lines
  }
  const props = node.props ?? {}
  const children = node.children ?? []
  const border = props.borderStyle ? 1 : 0
  const room = (props.width ?? width) - 2 * (border + (props.paddingX ?? 0))
  let lines: string[]
  if (props.flexDirection === 'row') {
    const parts = children.map(child => {
      const natural = Math.max(1, ...cardLines(child, room).map(cardWidth))
      return cardLines(child, typeof child === 'string' ? natural : child.props?.width ?? natural)
    })
    lines = Array.from({ length: Math.max(1, ...parts.map(part => part.length)) }, (_, row) => parts.map(part => {
      const size = Math.max(...part.map(cardWidth))
      return (part[row] ?? '') + ' '.repeat(Math.max(0, size - cardWidth(part[row] ?? '')))
    }).join(''))
  } else lines = children.flatMap(child => cardLines(child, room))
  return [...Array(props.marginTop ?? 0).fill(''), ...Array(border).fill(''), ...lines, ...Array(border).fill('')]
}
const mountedCards = async (ui: { drawn(): Promise<CardDrawn> }): Promise<CardDrawn[]> => {
  const root = await ui.drawn()
  const cards = root.children!.find((node): node is CardDrawn => typeof node !== 'string' && node.props?.key === 'cards')!
  return cards.children!.filter((node): node is CardDrawn => typeof node !== 'string' && !!node.props?.key?.startsWith('card:'))
}

// The colour a terminal paints a run with: the innermost Text holding exactly that text, coloured by itself or its nearest coloured ancestor.
type Painted = { type: string; props?: { color?: string; bold?: boolean }; children?: (Painted | string)[] }
const plain = (node: Painted | string): string => typeof node === 'string' ? node : (node.children ?? []).map(plain).join('')
function paintOf(root: Painted, text: string): { color?: string; bold?: boolean } | undefined {
  let found: { color?: string; bold?: boolean } | undefined
  const walk = (node: Painted | string, color: string | undefined, bold: boolean | undefined) => {
    if (typeof node === 'string') return
    const c = node.type === 'Text' ? (node.props?.color ?? color) : color
    const b = node.type === 'Text' ? (node.props?.bold ?? bold) : bold
    if (node.type === 'Text' && plain(node) === text) found = { color: c, bold: b }
    for (const child of node.children ?? []) walk(child, c, b)
  }
  walk(root, undefined, undefined)
  return found
}

test('refined neutral：第二行的 branch 與 repo、題目同為 dim 灰；全部的卡片不畫階段，repo 是 dim 灰加 dimColor、不加粗', async ($, on) => {
  const c = card('甲', { repo: 'frontend', branch: '現場報工端埋' })
  const w = world({ ...focusOf('甲', []), sessions: [c] })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(paintOf(await ui.drawn(), '現場報工端埋')?.color).toBe('gray')
  expect(await ui.find({ type: 'Text', text: '實作中' })).toBeUndefined()
  await ui.press({ key: 'tab:all' })
  expect(await ui.find({ type: 'Text', text: '實作中' })).toBeUndefined()
  const repo = findKey(await ui.drawn(), `card-repo:${c.key}`).children[0]
  expect([textOf(repo).trimStart(), repo.props.color, repo.props.dimColor, repo.props.bold]).toEqual(['frontend', 'gray', true, undefined])
  await ui.unmount()
})

for (const cols of [36, 46, 70, 80]) {
  test(`refined：${cols} 欄第二行：branch 與 repo 只佔一行，長 branch 以 … 截短、repo 完整，不放題目與階段`, async ($, on) => {
    const c = card('甲', { repo: 'frontend', branch: `feat/${'現場報工端埋'.repeat(6)}`, question: '要怎麼做？' })
    const w = world({ ...focusOf('甲', []), sessions: [c] })
    appearanceConfig.set(w, { motion: false })
    await start($, on, w)
    await openPane($)
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const [drawn] = await mountedCards(ui)
    const line = textOf(drawn!.children!.at(-1)!)
    expect(line).not.toContain('\n')
    expect(line).not.toContain('要怎麼做？')
    expect(line).toContain('feat/現場報工端埋')
    expect(line).toMatch(/… *frontend$/)
    expect(line).not.toContain('實作中')
    expect(cardWidth(line)).toBeLessThanOrEqual(cols - 1)
    expect(textOf(drawn!.children![0]!)).not.toContain('要怎麼做？')
    await ui.unmount()
  })

  for (const options of [[], ['繼續', '停止']]) {
    test(`refined：${cols} 欄${options.length ? '有選項' : '無選項'}未選卡與選中卡等高（上方空行＋兩行）、標題列不畫問題、第二行是 branch、不顯示選項、編號後留一格`, async ($, on) => {
      const cards = ['甲', '乙'].map(tag => card(tag, { repo: 'frontend', status: '回覆完畢', question: '要繼續嗎？', options }))
      const w = world({ ...focusOf('甲', ['乙']), sessions: cards })
      appearanceConfig.set(w, { motion: false })
      await start($, on, w)
      await openPane($)
      const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
      const [selected, other] = await mountedCards(ui)
      const a = cardLines(selected!, cols)
      const b = cardLines(other!, cols)
      expect(b).toHaveLength(a.length)
      // The blank row above, the header, the branch row.
      expect(a).toHaveLength(3)
      expect(a[0]).toBe('')
      expect(a[1]!.startsWith(` ${MARK_STILL}`)).toBe(true)
      expect(b[1]!.startsWith('   ')).toBe(true)
      expect(a[1]).not.toContain('要繼續嗎？')
      expect(a[1]!.indexOf('甲')).toBe(b[1]!.indexOf('乙'))
      expect(a[2]!.trimStart().startsWith('feat/甲')).toBe(true)
      expect(a[2]!.indexOf('feat/')).toBe(b[2]!.indexOf('feat/'))
      expect(a.join('\n')).not.toContain('繼續 ·')
      expect(b[1]).toContain('1: ↩ 已回覆')
      expect(a[1]!.indexOf('↩')).toBe(b[1]!.indexOf('↩'))
      await arrowTo($, '乙')
      const swapped = await mountedCards(ui)
      expect(cardLines(swapped[0]!, cols)).toHaveLength(a.length)
      expect(cardLines(swapped[1]!, cols)).toHaveLength(b.length)
      await ui.unmount()
    })
  }
}

test('refined：每張卡的暱稱加粗（選中的用強調色），選中的標記加粗；題目、branch、repo 與狀態字都不加粗；狀態區只有狀態字、代號與按鍵數字加粗', async ($, on) => {
  const cards = [card('甲', { repo: 'frontend', branch: '1 未核對', status: '等待授權' }), card('乙', { repo: 'frontend', branch: '面板 v2 改版', status: '回覆完畢' }), card('丙', { branch: '123456789012345678901234 項', archived: true, pending: false })]
  const w = world({ ...focusOf('甲', ['乙']), sessions: cards })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const bold = async () => (await ui.findAll({ type: 'Text' })).filter((x: any) => x.props.bold).map((x: any) => x.text)
  expect(await bold()).toEqual([` ${MARK_STILL} `, '甲', '乙'])
  expect(paintOf(await ui.drawn(), '1 未核對')?.color).toBe('gray')
  await ui.press({ key: 'tab:all' })
  expect(paintOf(await ui.drawn(), '面板 v2 改版')?.color).toBe('gray')
  expect((await bold()).filter((t: string) => t !== ` ${MARK_STILL} `)).toEqual(['甲', '乙'])
  await ui.press({ key: 'tab:hidden' })
  expect((await bold()).filter((t: string) => t !== ` ${MARK_STILL} `)).toEqual(['丙'])
  await ui.unmount()
  const focusBand = await $.ui.mount({ ...band(80), surface: 'terminal' })
  const bandTexts = await focusBand.findAll({ type: 'Text' })
  expect(bandTexts.filter((x: any) => x.props.bold).map((x: any) => x.text)).toEqual([' 輪到你  ', '甲', '8', '9', '0'])
  expect(await focusBand.find({ key: 'show-tag' })).toBeUndefined()
  await focusBand.press({ key: 'show' })
  expect(w.shown.at(-1)).toMatch(/^甲/)
  await focusBand.unmount()
})

test('refined：六種狀態與未知值保留正確圖標、文字及狀態色', async ($, on) => {
  const cases = [
    ['執行中', '✳ 工作中', 'green'], ['等待回應', '◆ 待回答', 'yellow'],
    ['等待授權', '◆ 待授權', 'magentaBright'], ['回覆完畢', '↩ 已回覆', 'cyanBright'],
    ['閒置', '- 閒置', 'gray'], ['session 異常，需手動排程', '! 異常', 'redBright'],
    ['未知狀態內容', '? 未知…', 'gray'],
  ] as const
  expect(new Set(cases.slice(0, 4).map(c => c[2])).size).toBe(4)
  expect(new Set(cases.slice(0, 6).filter(c => c[0] !== '閒置').map(c => c[2])).size).toBe(5)
  const cards = cases.map(([status], i) => card(`狀態${i}`, { status }))
  const w = world({ ...focusOf('狀態0', cards.slice(1).map(c => c.tag)), sessions: cards })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  for (const [status, text, color] of cases) {
    const row = await ui.find({ key: `status:${cards[cases.findIndex(c => c[0] === status)]!.key}` })
    expect(row?.text).toContain(text)
    expect((await ui.find({ type: 'Text', text: ` ${statusCell(status, 0).label}` }))?.props.color).toBe(color)
  }
  await ui.unmount()
})

// The chosen card's mark colour, or another card's status icon colour.
const railColor = async (ui: any, key: string) => {
  const head = findKey(await ui.drawn(), `card:${key}`)?.children[0]
  return textOf(head?.children[0]).trim() ? head.children[0].props.color : findKey(head, `status:${key}`)?.children[0].props.color
}

test('refined：主題只換顏色，無效設定只提示一次且每次開面板重讀', async ($, on) => {
  const w = world(pending())
  const config: AppearanceConfig = { theme: 'dracula', motion: false }
  appearanceConfig.set(w, config)
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  // 待回覆 cards carry no status: the status colour is read on 全部, on a card it does not choose.
  const statusColor = async () => {
    await ui.press({ key: 'tab:all' })
    const color = await railColor(ui, keyOf('logging'))
    await ui.press({ key: 'tab:pending' })
    return color
  }
  expect(await railColor(ui, keyOf('perm'))).toBe('#8be9fd')
  expect(await statusColor()).toBe(THEMES.dracula[statusCell('等待回應', 0).color])
  const original = await cardTags(ui)
  for (const [name, accent, border] of [
    ['neutral', 'cyan', 'gray'], ['neutral-light', '#0f7c8c', '#868a92'],
    ['dracula', '#8be9fd', '#9aa1c2'], ['gruvbox', '#fbf1c7', '#928374'], ['light', '#1f7a73', '#7f8f90'],
  ]) {
    config.theme = name
    await openPane($)
    expect(await railColor(ui, 'perm@1')).toBe(accent)
    expect(await statusColor()).toBe(THEMES[name as keyof typeof THEMES][statusCell('等待回應', 0).color])
    expect(border).toBe(THEMES[name as keyof typeof THEMES].border)
    expect(await cardTags(ui)).toEqual(original)
  }
  config.theme = '不存在'
  await openPane($)
  expect(await railColor(ui, keyOf('perm'))).toBe('cyan')
  expect(await cardTags(ui)).toEqual(original)
  await openPane($)
  expect(w.toasts).toEqual(['config.json 的 theme 不認得：不存在，改用 neutral'])
  config.theme = '另一個不存在'
  await openPane($)
  expect(w.toasts).toEqual([
    'config.json 的 theme 不認得：不存在，改用 neutral',
    'config.json 的 theme 不認得：另一個不存在，改用 neutral',
  ])
  await ui.unmount()
})

for (const name of ['light', 'dracula'] as const) {
  test(`refined：${name} 空分頁提示用主題 dim 色`, async ($, on) => {
    const w = world(nothing())
    appearanceConfig.set(w, { theme: name, motion: false })
    await start($, on, w)
    await openPane($)
    const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
    await ui.press({ key: 'tab:hidden' })
    const hint = (await ui.findAll({ type: 'Text' })).find((x: any) => x.text.trim() === EMPTY)
    expect(hint?.props.color).toBe(THEMES[name].dim)
    await ui.unmount()
  })
}

test('主題：每個主題的工作中、待回答、待授權、已回覆、異常各用不同顏色', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    const roles = [t.busy, t.waiting, t.blocked, t.answered, t.error]
    expect(roles.every(Boolean), name).toBe(true)
    expect(new Set(roles).size, name).toBe(5)
  }
})

for (const [name, blocked, dim, border] of [
  ['neutral', 'magentaBright', 'gray', 'gray'],
  ['neutral-light', '#a3267a', '#5f646d', '#868a92'],
  ['dracula', '#ffb86c', '#9aa1c2', '#9aa1c2'],
  ['gruvbox', '#fe8019', '#bdae93', '#928374'],
  ['light', '#a34f00', '#586e75', '#7f8f90'],
]) {
  test(`refined：${name} 授權圖標呼吸但文字維持授權色，待回覆文字與線條分色`, async ($, on) => {
    const w = world(focusOf('perm', ['focusui']))
    appearanceConfig.set(w, { theme: name })
    const clock = await start($, on, w)
    await openPane($)
    const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
    await ui.press({ key: 'tab:all' })
    const focusBand = await $.ui.mount({ ...band(80), surface: 'terminal' })
    for (const [elapsed, glyphColor] of [[0, blocked], [1_200, dim]] as const) {
      await clock.advance(elapsed)
      expect(findKey(await ui.drawn(), 'status:perm@1').children[0].props.color).toBe(glyphColor)
      expect((await ui.find({ type: 'Text', text: ' 待授權' }))?.props.color).toBe(blocked)
      expect((await focusBand.find({ type: 'Text', text: ' 等待授權  ' }))?.props.color).toBe(blocked)
      expect((await focusBand.find({ type: 'Text', text: '│ ' }))?.props.color).toBe(blocked)
    }
    expect((await focusBand.find({ type: 'Text', text: '── 狀態 ' }))?.props.color).toBe(dim)
    expect((await focusBand.find({ type: 'Text', text: '─'.repeat(80 - columns('── 狀態 ')) }))?.props.color).toBe(border)
    await focusBand.unmount()
    await ui.unmount()
  })
}

test('refined：只有工作中可見時不開動畫計時器', async ($, on) => {
  const cards = [card('a', { status: '執行中', pending: false }), card('b', { status: '執行中', pending: false })]
  const w = world({ ...focusOf('a', []), sessions: cards })
  appearanceConfig.set(w, {})
  let invalidations = 0
  on('ui.invalidate', async (_$, e, next) => { invalidations += 1; return next(e) })
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), props: { ...pane(80).props, isFocused: false }, surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  const before = invalidations
  await clock.advance(1_800)
  expect(invalidations).toBe(before)
  for (const c of cards) expect((await ui.find({ key: `card:${c.key}` }))?.text).toContain('✳ 工作中')
  await ui.unmount()
})

test('refined：所有可見待授權同拍呼吸，文字不變暗，關閉 motion 停止', async ($, on) => {
  const w = world({ ...focusOf('perm', ['另一授權', 'focusui']), sessions: [...SESSIONS, card('另一授權', { status: '等待授權' })] })
  const config: AppearanceConfig = {}
  appearanceConfig.set(w, config)
  let invalidations = 0
  on('ui.invalidate', async (_$, e, next) => { invalidations += 1; return next(e) })
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), props: { ...pane(80).props, isFocused: false }, surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  const focusBand = await $.ui.mount({ ...band(80), surface: 'terminal' })
  const before = invalidations
  await clock.advance(1_050)
  expect(invalidations).toBe(before)
  await clock.advance(150)
  expect(invalidations).toBe(before + 1)
  for (const tag of ['perm', '另一授權']) expect((await ui.find({ key: `status:${keyOf(tag)}` }))?.text).toContain('◆ 待授權')
  const glyphColor = async (tag: string) => findKey(await ui.drawn(), `status:${keyOf(tag)}`).children[0].props.color
  expect([await glyphColor('perm'), await glyphColor('另一授權'), await glyphColor('focusui')]).toEqual(['gray', 'gray', 'yellow'])
  expect((await focusBand.find({ type: 'Text', text: '│ ' }))?.props.color).toBe('magentaBright')
  expect((await ui.find({ type: 'Text', text: ' 待授權' }))?.props.color).toBe('magentaBright')
  await clock.advance(600)
  expect(invalidations).toBe(before + 2)
  config.motion = false
  await openPane($)
  await ui.press({ key: 'tab:all' })
  const stopped = invalidations
  await clock.advance(900)
  expect(invalidations).toBe(stopped)
  expect((await ui.find({ key: 'status:perm@1' }))?.text).toContain('◆ 待授權')
  await focusBand.unmount()
  await ui.unmount()
})

test('狀態圖標：所有待授權只改圖標亮度，待回答只有主要那題換實心空心', () => {
  for (let tick = 0; tick < 12; tick += 1) {
    for (const primary of [false, true]) {
      for (const animated of [false, true]) {
        expect(statusCell('執行中', tick, { primary, animated }).glyph).toBe('✳')
        expect(statusCell('session 異常，需手動排程', tick, { primary, animated }).glyph).toBe('!')
        const authorization = statusCell('等待授權', tick, { primary, animated })
        expect(authorization.glyph).toBe('◆')
        expect(authorization.glyphColor).toBe(animated && tick >= 8 ? 'dim' : 'blocked')
        expect(authorization.color).toBe('blocked')
        const question = statusCell('等待回應', tick, { primary, animated })
        expect(question.glyph).toBe(primary && animated && tick >= 6 ? '◇' : '◆')
        expect(question.glyphColor).toBe('waiting')
      }
    }
  }
})

test('refined：主要待回答和非主要待授權共用時鐘，只在可見影格改變時更新', async ($, on) => {
  const w = world(focusOf('focusui', ['perm']))
  appearanceConfig.set(w, {})
  let invalidations = 0
  on('ui.invalidate', async (_$, e, next) => { invalidations += 1; return next(e) })
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(46), props: { ...pane(46).props, isFocused: false }, surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  const before = invalidations
  await clock.advance(900)
  expect(invalidations).toBe(before + 1)
  expect((await ui.find({ key: 'status:focusui@1' }))?.text).toContain('◇ 待回答')
  await clock.advance(300)
  expect(invalidations).toBe(before + 2)
  expect(findKey(await ui.drawn(), 'status:perm@1').children[0].props.color).toBe('gray')
  await clock.advance(600)
  expect(invalidations).toBe(before + 3)
  expect((await ui.find({ key: 'status:focusui@1' }))?.text).toContain('◆ 待回答')
  await ui.unmount()
})

test('選中標記：面板拿到鍵盤且 motion 開著時照 · ✢ ✳ ✶ ✻ ✽ 來回轉；鍵盤交回輸入框或 motion: false 時停在 ✻，不開計時器', async ($, on) => {
  const cards = [card('a', { status: '執行中', pending: false }), card('b', { status: '執行中', pending: false })]
  const w = world({ ...focusOf('a', []), sessions: cards })
  const config: AppearanceConfig = {}
  appearanceConfig.set(w, config)
  let invalidations = 0
  on('ui.invalidate', async (_$, e, next) => { invalidations += 1; return next(e) })
  const clock = await start($, on, w)
  await openPane($)
  const markOf = async (ui: any) => [...(await ui.find({ key: `card:${cards[0]!.key}` }))!.text][1]
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  expect((await ui.find({ key: `card:${cards[1]!.key}` }))!.text.startsWith('   ')).toBe(true)
  const seen: string[] = []
  for (let i = 0; i < MARK_SPIN.length + 1; i++) {
    seen.push((await markOf(ui))!)
    await clock.advance(150)
  }
  expect(seen).toEqual([...MARK_SPIN, MARK_SPIN[0]])
  await ui.unmount()
  const away = await $.ui.mount({ ...pane(80), props: { ...pane(80).props, isFocused: false }, surface: 'terminal' })
  await away.press({ key: 'tab:all' })
  expect(await markOf(away)).toBe(MARK_STILL)
  let before = invalidations
  await clock.advance(900)
  expect(invalidations).toBe(before)
  await away.unmount()
  config.motion = false
  await openPane($)
  const still = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  await still.press({ key: 'tab:all' })
  expect(await markOf(still)).toBe(MARK_STILL)
  before = invalidations
  await clock.advance(900)
  expect(invalidations).toBe(before)
  expect(await markOf(still)).toBe(MARK_STILL)
  await still.unmount()
})

test('refined：主要題目不可見時，可見待授權仍呼吸', async ($, on) => {
  const cards = [card('工作中', { status: '執行中', pending: false }), card('perm', { status: '等待授權', pending: false })]
  const w = world({ ...focusOf('工作中', []), sessions: cards })
  const config: AppearanceConfig = {}
  appearanceConfig.set(w, config)
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(36), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  await clock.advance(1_200)
  expect((await ui.find({ type: 'Text', text: '◆' }))?.props.color).toBe('gray')
  expect((await ui.find({ type: 'Text', text: ' 待授權' }))?.props.color).toBe('magentaBright')
  await ui.unmount()
})

test('refined：狀態區分隔線、授權色左線、不畫階段，沒有別題在等時沒有 8', async ($, on) => {
  const w = world(focusOf('perm', ['focusui']))
  appearanceConfig.set(w, { motion: false })
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(46), surface: 'terminal' })
  expect((await texts(ui)).some((t: string) => t.includes('── 狀態'))).toBe(true)
  expect((await ui.find({ type: 'Text', text: '│ ' }))?.props.color).toBe('magentaBright')
  expect((await texts(ui)).some((t: string) => t.includes('實作中'))).toBe(false)
  expect(await ui.find({ key: 'later' })).toBeDefined()
  w.focus = focusOf('perm', [])
  await clock.advance(5_000)
  expect(await ui.find({ key: 'later' })).toBeUndefined()
  expect(await ui.find({ key: 'pane' })).toBeDefined()
  await ui.unmount()
})

test('refined：選中問題不加粗', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'Bash rm -rf build' }))?.props.bold).toBeFalsy()
  await ui.unmount()
})

test('refined：編號跟著排隊順序，選排隊卡只選中、目前這件照舊不編號', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ key: 'num:perm@1' })).toBeUndefined()
  expect((await ui.find({ key: 'num:focusui@1' }))?.props.hotkey).toBe('1')
  await ui.press({ key: 'num:focusui@1' })
  expect(w.calls.some(c => c[0] === 'focus-pick')).toBe(false)
  expect(await chosenTag(ui)).toBe('focusui')
  expect(await ui.find({ key: 'num:perm@1' })).toBeUndefined()
  expect((await ui.find({ key: 'num:focusui@1' }))?.props.hotkey).toBe('1')
  await ui.unmount()
})

test('refined：上下選卡、Enter 或點暱稱都只選中卡片，不切換狀態區上的題目、不印題目；d 才開摘要小視窗', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const arrow = arrows($, ui, w)
  await arrow(1)
  expect(await chosenTag(ui)).toBe('focusui')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await ui.press({ key: 'name:focusui@1' })
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(w.shown).toEqual([])
  expect(findKey(await ui.drawn(), 'popover')).toBeUndefined()
  await ui.press({ key: 'tab:all' })
  await ui.press({ key: `name:${keyOf('tune')}` })
  expect(await chosenTag(ui)).toBe('tune')
  await ui.press({ key: `name:${keyOf('logging')}` })
  expect(await chosenTag(ui)).toBe('logging')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(w.shown).toEqual([])
  expect(w.focus.current).toBe(keyOf('perm'))
  await ui.unmount()
})

test('refined：三個分頁維持上游篩選與選中第一張卡', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  for (const [key, tags] of [
    ['tab:all', ['focusui', 'logging', 'tune', 'PROJ-6668', 'upgrade#2', 'chart', 'perm']],
    ['tab:hidden', ['PROJ-6650']],
    ['tab:pending', ['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2']],
  ] as const) {
    await ui.press({ key })
    expect(await drawnTags(ui)).toEqual([...tags])
    expect(await chosenTag(ui)).toBe(tags[0])
  }
  await ui.unmount()
})

test('refined：捲動移動卡片窗口，畫面外編號仍可選到整張卡', async ($, on) => {
  const many = queued(10)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80, 14), surface: 'terminal' })
  expect(await drawnTags(ui)).toEqual(['perm', 'q0', 'q1', 'q2'])
  await $.ui.scroll({ component: 'Pane', requestId: PANE, offset: 0, by: 1, bodyRows: 14, contentRows: 14, origin: { kind: 'person' } })
  expect(await drawnTags(ui)).toEqual(['q0', 'q1', 'q2', 'q3'])
  await ui.press({ key: 'num:q8@1' })
  expect(await chosenTag(ui)).toBe('q8')
  expect(await drawnTags(ui)).toContain('q8')
  await ui.unmount()
})

test('refined：主要待回答每 900ms 閃爍，其餘問題維持實心圖標', async ($, on) => {
  const w = world(focusOf('focusui', ['logging']))
  appearanceConfig.set(w, {})
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  expect((await ui.find({ key: 'status:focusui@1' }))?.text).toContain('◆ 待回答')
  expect((await ui.find({ key: 'status:logging@1' }))?.text).toContain('◆ 待回答')
  await clock.advance(900)
  expect((await ui.find({ key: 'status:focusui@1' }))?.text).toContain('◇ 待回答')
  await clock.advance(900)
  expect((await ui.find({ key: 'status:focusui@1' }))?.text).toContain('◆ 待回答')
  await ui.unmount()
})

test('設定檔：不是中控台的分頁不讀 config.json，設定錯了也不跳提示；成為中控台後才提示一次', async ($, on) => {
  const w = world({ active: false })
  appearanceConfig.set(w, { theme: '不存在' })
  const clock = await start($, on, w)
  await clock.advance(30_000)
  expect(w.toasts).toEqual([])
  w.focus = pending()
  await clock.advance(15_000)
  expect(w.toasts).toEqual(['config.json 的 theme 不認得：不存在，改用 neutral'])
})

test('設定檔：config.json 不是有效的 JSON 時跳一次提示並用預設外觀，重開面板不再重複', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, '{ "theme": "dracula", ')
  await start($, on, w)
  await openPane($)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(w.toasts).toEqual(['config.json 不是有效的 JSON，外觀改用預設'])
  expect(await railColor(ui, 'perm@1')).toBe('cyan')
  await ui.unmount()
})

test('設定檔：寫了 appearance（不論值）跳一次「appearance 已移除，一律用預設外觀」，外觀照常；沒寫不跳；無效 motion 也提示一次', async ($, on) => {
  const w = world(pending())
  const config: AppearanceConfig = {}
  appearanceConfig.set(w, config)
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect((await ui.find({ key: 'card:perm@1' }))?.text).toContain('◆ 待授權')
  expect(w.toasts).toEqual([])
  for (const value of ['refined', '錯誤外觀', 'refined']) {
    config.appearance = value
    config.theme = 'dracula'
    await openPane($)
    expect(w.toasts).toEqual(['appearance 已移除，一律用預設外觀'])
    expect(await railColor(ui, 'perm@1')).toBe(THEMES.dracula.accent)
    expect((await ui.find({ key: 'card:perm@1' }))?.text).toContain('◆ 待授權')
  }
  delete config.appearance
  config.motion = '否'
  await openPane($)
  await openPane($)
  expect(w.toasts).toEqual([
    'appearance 已移除，一律用預設外觀',
    'config.json 的 motion 不認得：否，改用 true',
  ])
  await ui.unmount()
})

test('refined：窄版一般與封存卡完整標頭文字包含預算內名稱且不超寬', async ($, on) => {
  // The longest 代號 each header row holds whole beside its repo: 19 and 9 on 待回覆, 9 on 封存 at 46, and 4 there at 36, which cannot hold 8 cells of repo.
  const cards = [card('abcdefghijklmnopqrs', { repo: 'fe' }), card('abcdefghi', { repo: 'fe' }), card('ABCDEFGHI', { archived: true, pending: false }), card('ABCD', { archived: true, pending: false })]
  const w = world({ ...focusOf(cards[0]!.tag, [cards[1]!.tag]), sessions: cards })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  for (const cols of [46, 36]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    for (const tab of ['tab:pending', 'tab:hidden']) {
      await ui.press({ key: tab })
      const target = cards[(tab === 'tab:hidden' ? 2 : 0) + (cols === 36 ? 1 : 0)]!
      await arrowTo($, target.tag)
      const root = await ui.drawn()
      type Drawn = { type: string; key?: string; props?: { key?: string; width?: number; hotkey?: string; label?: string }; children?: (Drawn | string)[] }
      const findCard = (node: Drawn | string): Drawn | undefined => {
        if (typeof node === 'string') return undefined
        if ((node.key ?? node.props?.key) === `card:${target.key}`) return node
        for (const child of node.children ?? []) {
          const found = findCard(child)
          if (found) return found
        }
      }
      const drawn = findCard(root)
      expect(drawn).toBeDefined()
      const row = drawn!.children![0]!
      const rowText = (node: Drawn | string): string => {
        if (typeof node === 'string') return node
        const text = node.type === 'Button' ? `${node.props?.hotkey ?? ''}${node.children?.length ? node.children.map(rowText).join('') : (node.props?.label ?? '')}` : (node.children ?? []).map(rowText).join('')
        const cells = [...text].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/u.test(c) ? 2 : 1), 0)
        return text + ' '.repeat(Math.max(0, (node.props?.width ?? cells) - cells))
      }
      const rendered = rowText(row)
      const name = target.tag
      expect(rendered.includes(name)).toBe(true)
      const cells = [...rendered].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/u.test(c) ? 2 : 1), 0)
      // The rail, then the header row, one column short of the pane's edge.
      expect(cells).toBeLessThanOrEqual(cols - 1)
    }
    await ui.unmount()
  }
})


const contrast = (a: string, b: string): number => {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(i => {
      const value = parseInt(hex.slice(i, i + 2), 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  }
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

test('主題：命名配色有底色，中性不覆蓋，淺色次要文字與 Dracula 框線可辨識', () => {
  expect(Object.hasOwn(THEMES.neutral, 'bg')).toBe(false)
  for (const name of ['dracula', 'gruvbox', 'light', 'neutral-light'] as const) {
    expect(THEMES[name].bg).toMatch(/^#[0-9a-f]{6}$/)
  }
  for (const name of ['light', 'neutral-light'] as const) {
    const theme = THEMES[name]
    expect(contrast(theme.dim!, theme.bg!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(theme.fg!, theme.bg!)).toBeGreaterThanOrEqual(4.5)
  }
  expect(contrast(THEMES.dracula.border!, THEMES.dracula.bg!)).toBeGreaterThanOrEqual(3)
})

test('主題：neutral-light、gruvbox、light 的邊框對底色至少 3:1', () => {
  for (const name of ['neutral-light', 'gruvbox', 'light'] as const) {
    const theme = THEMES[name]
    expect(contrast(theme.border!, theme.bg!), name).toBeGreaterThanOrEqual(3)
  }
})

test('主題：每個主題的選取框強調色不等於任何狀態色，gruvbox 的強調色也不等於次要文字色', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    for (const role of ['busy', 'waiting', 'blocked', 'answered', 'error'] as const) expect(t.accent, `${name} ${role}`).not.toBe(t[role])
  }
  expect(THEMES.gruvbox.accent).not.toBe(THEMES.gruvbox.muted)
})

test('面板：命名主題最外層帶底色，中性不增加底色', async ($, on) => {
  const w = world(pending())
  const config: AppearanceConfig = { theme: 'dracula', motion: false }
  appearanceConfig.set(w, config)
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  type Drawn = { type: string; props: { backgroundColor?: string }; children?: (Drawn | string)[] }
  const outer = (node: Drawn): Drawn => node.type === 'Box' ? node : outer(node.children!.find(child => typeof child !== 'string') as Drawn)
  for (const name of ['dracula', 'gruvbox', 'light', 'neutral-light', 'neutral'] as const) {
    config.theme = name
    await openPane($)
    const box = outer(await ui.drawn())
    expect(box.props.backgroundColor).toBe('bg' in THEMES[name] ? THEMES[name].bg : undefined)
    expect(Object.hasOwn(box.props, 'backgroundColor')).toBe(name !== 'neutral')
  }
  await ui.unmount()
})

test('每次輪詢都帶 --typing 與 --turn：輸入框有字時 --typing 1、中控台這一輪在跑時 --turn 1（伺服器這時不換目前這件），子 agent 的回合不算', async ($, on) => {
  const w = world(pending())
  let draft = ''
  on('prompt.read', async () => ({ value: { text: draft, cursor: draft.length } }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const clock = await start($, on, w)
  const flag = (name: string) => w.calls.filter(c => c[0] === 'focus').map(c => c[c.indexOf(name) + 1])
  draft = 'perm 先'
  await clock.advance(5_000)
  draft = '   '
  await clock.advance(5_000)
  await $.turn.start({ text: '回 perm 允許', turnId: 'console-turn' })
  await clock.advance(5_000)
  await $.turn.start({ text: '', turnId: 'sub-turn', agentId: 'sub' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub-turn', agentId: 'sub', reason: 'answer' })
  await clock.advance(5_000)
  await $.turn.complete({ answer: '好', durationMs: 1, isAborted: false, turnId: 'console-turn', reason: 'answer' })
  await clock.settle()
  expect(flag('--typing')).toEqual(['0', '1', '0', '0', '0', '0'])
  expect(flag('--turn')).toEqual(['0', '0', '0', '1', '1', '0'])
  expect(w.shown).toEqual([])
})

test('Herdr app tab (HC_TERMINAL_ID only): the band polls console.mjs focus like in Orca and herdr and posts no herdr notification', async ($, on) => {
  const w = world(withAdvice(READY))
  await start($, on, w, { HC_TERMINAL_ID: 't1' })
  expect(w.calls.some(c => c[0] === 'focus')).toBe(true)
  expect(w.notes ?? []).toEqual([])
})

test('no Orca, herdr or Herdr app: the band never polls console.mjs focus', async ($, on) => {
  const w = world(withAdvice(READY))
  await start($, on, w, {})
  expect(w.calls.filter(c => c[0] === 'focus')).toEqual([])
})

const withCards = (extra: Record<string, Partial<Card> & { advice?: any; brief?: any }>, current = 'focusui', queue = ['logging', 'PROJ-6668', 'perm']) => ({
  ...focusOf(current, queue),
  sessions: SESSIONS.map(s => (extra[s.tag] ? { ...s, ...extra[s.tag] } : s)),
})

test('卡片 ✓ 建議: a card whose suggestion is ready reads ✓ (accent) 建議 (dim) at the right end of its header, before 需審核 N 件 when it has one, on 待回覆 and 全部 alike; below 46 columns only ✓; the header stays one row', async ($, on) => {
  const w = world(withCards({ focusui: { advice: READY }, logging: { advice: { state: 'pending', text: '建議產生中… 3 秒' } }, 'PROJ-6668': { advice: null }, perm: { advice: READY, review: 2 } }))
  await start($, on, w)
  await openPane($)
  for (const cols of [70, 46]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const hint = await ui.find({ key: `hint:${keyOf('focusui')}` })
    expect(textOf(hint)).toBe('✓ 建議')
    expect(paintOf(hint, '✓')?.color).toBe(THEMES.neutral.accent)
    expect(paintOf(hint, ' 建議')?.color).toBe(THEMES.neutral.dim)
    for (const tabKey of ['tab:pending', 'tab:all']) {
      await ui.press({ key: tabKey })
      const right = textOf(findKey(await ui.drawn(), `right:${keyOf('focusui')}`))
      expect(right).toBe('✓ 建議')
      expect(right).not.toContain('agent-skills')
      expect(textOf(findKey(await ui.drawn(), `right:${keyOf('perm')}`))).toBe('✓ 建議 需審核 2 件')
    }
    await ui.press({ key: 'tab:pending' })
    const header = findKey(await ui.drawn(), `card:${keyOf('focusui')}`).children[0]
    expect(cells(textOf(header))).toBeLessThanOrEqual(cols - 1)
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(textOf(await narrow.find({ key: `hint:${keyOf('focusui')}` }))).toBe('✓')
  const header = findKey(await narrow.drawn(), `card:${keyOf('focusui')}`).children[0]
  // The mark and the header row, less the blank cell before the right part.
  expect(cells(textOf(header))).toBeLessThanOrEqual(40 - 1 - 1)
  await narrow.unmount()
})

test('卡片 ✓ 建議: no mark while the suggestion is being written, when it failed (no advice) or for a card with no suggestion; never the answer letter', async ($, on) => {
  const w = world(withCards({ focusui: { advice: READY }, logging: { advice: { state: 'pending', text: '建議產生中… 3 秒' } }, 'PROJ-6668': { advice: null } }))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  for (const tag of ['logging', 'PROJ-6668', 'perm']) {
    expect(await ui.find({ key: `hint:${keyOf(tag)}` })).toBeUndefined()
    expect(textOf(await ui.find({ key: `card:${keyOf(tag)}` }))).not.toContain('✓')
  }
  expect(textOf(await ui.find({ key: `card:${keyOf('focusui')}` }))).not.toMatch(/建議：|✓ 建議 ?b/)
  await ui.unmount()
})

test('摘要浮層: d opens the chosen card\'s recap in a popover right under the card, drawn over the cards below without moving them; nothing opens, switches, prints or reaches the conversation; d again closes it', async ($, on) => {
  const text = '登入頁改好了，測試都過。等你決定要不要也改註冊頁。'
  const w = { ...world(withCards({ logging: { brief: { text, pending: false } } })), submits: [] as string[] }
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(70, 30), surface: 'terminal' })
  const opened = w.opened.length
  const before = w.calls.length
  const tags = await drawnTags(ui)
  await openBrief($, ui, 'logging')
  expect(w.opened.length).toBe(opened)
  expect(w.shown).toEqual([])
  expect(w.submits).toEqual([])
  expect(w.calls.slice(before).filter(c => c[0] !== 'focus')).toEqual([])
  const root = await ui.drawn()
  const box = findKey(root, 'popover')
  // logging is the second card: the tab rows, then a blank row and two rows per card.
  expect(box.props).toMatchObject({ position: 'absolute', top: 2 + 3 + 1 + 2, left: 0, width: 70 })
  expect(root.children.at(-1)).toBe(box)
  expect(await drawnTags(ui)).toEqual(tags)
  const rows = (await popRows(ui))!
  expect(rows[0]).toContain('logging 摘要')
  expect(rows[0]).not.toContain('p 印出完整回報')
  // The recap starts on the first text row: no repo, stage or summary line above it.
  expect(rows[1]).toContain(text)
  expect(rows.join('\n')).not.toMatch(/agent-skills|實作中|feat\/logging/)
  expect(paintOf(box, text)?.color).toBe(THEMES.neutral.fg)
  for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(70)
  await ui.press({ key: 'brief-key' })
  expect(await popRows(ui)).toBeNull()
  await ui.unmount()
})

test('摘要浮層: one popover at a time; ↑↓ onto another card, Esc handing the keys back to the prompt, or a tab switch closes it; d then opens the newly chosen card\'s', async ($, on) => {
  const w = world(withCards({ logging: { brief: { text: '甲摘要', pending: false } }, 'PROJ-6668': { brief: { text: '乙摘要', pending: false } } }))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(70, 30), surface: 'terminal' })
  await openBrief($, ui, 'logging')
  await openBrief($, ui, 'PROJ-6668')
  expect((await ui.findAll({ type: 'Box' })).filter((b: any) => b.key === 'popover')).toHaveLength(1)
  expect((await popRows(ui))!.join('\n')).toContain('乙摘要')
  await arrowTo($, 'logging')
  expect(await chosenTag(ui)).toBe('logging')
  expect(await popRows(ui)).toBeNull()
  await ui.press({ key: 'brief-key' })
  expect(await popRows(ui)).not.toBeNull()
  await ui.press({ key: 'tab:all' })
  expect(await popRows(ui)).toBeNull()
  await ui.press({ key: 'tab:pending' })
  await openBrief($, ui, 'logging')
  expect(await popRows(ui)).not.toBeNull()
  await ui.unmount()
  const away = await $.ui.mount({ ...pane(70, 30), props: { ...pane(70, 30).props, isFocused: false }, surface: 'terminal' })
  expect(findKey(await away.drawn(), 'popover')).toBeUndefined()
  await away.unmount()
  const back = await $.ui.mount({ ...pane(70, 30), surface: 'terminal' })
  expect(await popRows(back)).toBeNull()
  await back.unmount()
})

test('摘要浮層: a session with no recap yet says 還沒有摘要; one being written says 摘要產生中…, and a newer one being written under an old recap says so under it', async ($, on) => {
  const w = world(withCards({ logging: { brief: { text: null, pending: true } }, 'PROJ-6668': { brief: { text: '上一份摘要。', pending: true } } }))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(70, 40), surface: 'terminal' })
  const read = async (tag: string) => {
    await openBrief($, ui, tag)
    const rows = (await popRows(ui))!
    await ui.press({ key: 'brief-key' })
    return rows.slice(1, -1).map(r => r.replace(/^┃ /, '').trim())
  }
  expect(await read('perm')).toEqual(['還沒有摘要'])
  expect(await read('logging')).toEqual(['摘要產生中…'])
  expect(await read('PROJ-6668')).toEqual(['上一份摘要。', '新的摘要產生中…'])
  await ui.unmount()
})

test('摘要浮層: p prints the card\'s whole report, through /focus-show, for the band question and a queued one, and closes the popover', async ($, on) => {
  const w = world(withCards({}, 'perm', ['focusui', 'logging']))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const report = (tag: string) => SESSIONS.find(s => s.tag === tag)!.report
  await openBrief($, ui, 'perm')
  expect((await ui.find({ key: 'popover-print' }))?.props).toMatchObject({ hotkey: 'p' })
  await ui.press({ key: 'popover-print' })
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  expect(w.writes[`${HOME}/show/perm@${idOf(keyOf('perm'))}.md`]).toBe(report('perm'))
  expect(await popRows(ui)).toBeNull()
  await printFromBrief($, ui, keyOf('logging'))
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(w.focus.current).toBe(keyOf('perm'))
  expect(w.shown.at(-1)).toBe('logging')
  expect(w.writes[`${HOME}/show/logging.md`]).toBe(report('logging'))
  await ui.unmount()
})

const LONG_BRIEF = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行摘要`).join('\n')

test('摘要浮層捲動: the popover stops at the pane rows in view; past that j/k, the wheel and the page keys scroll its text, its bottom reads j/k 捲動 · 第 N–M 行／共 T 行, and the cards stay put', async ($, on) => {
  const w = world(withCards({ focusui: { brief: { text: LONG_BRIEF, pending: false } } }))
  let engineScrolled = 0
  on('ui.scroll', async () => {
    engineScrolled += 1
    return {}
  })
  await start($, on, w)
  await openPane($)
  const view = 20
  const ui = await $.ui.mount({ ...pane(70, view), surface: 'terminal' })
  const scroll = (by: number, pointer?: object) => $.ui.scroll({ component: 'Pane', requestId: PANE, offset: 0, by, bodyRows: view, contentRows: view, origin: { kind: 'person' }, ...(pointer && { pointer }) } as any)
  const tags = await drawnTags(ui)
  await openBrief($, ui, 'focusui')
  const box = findKey(await ui.drawn(), 'popover')
  // focusui heads the pane: its rows are 3 and 4, so the popover takes rows 5 to the bottom of the view.
  expect([box.props.top, box.props.height]).toEqual([5, view - 5])
  const body = view - 5 - 3
  const total = 30
  const bottom = async () => (await popRows(ui))!.at(-1)!
  expect(await bottom()).toContain(`j/k 捲動 · 第 1–${body} 行／共 ${total} 行`)
  expect((await popRows(ui))![1]).toContain('第 1 行摘要')
  await ui.press({ key: 'popover-down' })
  expect(await bottom()).toContain(`第 2–${body + 1} 行`)
  expect((await popRows(ui))![1]).toContain('第 2 行摘要')
  await ui.press({ key: 'popover-up' })
  expect(await bottom()).toContain(`第 1–${body} 行`)
  expect(await scroll(1, { column: 5, row: 8 })).toEqual({})
  expect(await bottom()).toContain(`第 2–${body + 1} 行`)
  await scroll(view)
  expect(await bottom()).toContain(`第 ${2 + body}–${1 + 2 * body} 行`)
  await scroll(view)
  expect(await bottom()).toContain(`第 ${total - body + 1}–${total} 行`)
  expect((await popRows(ui))!.at(-2)).toContain('第 30 行摘要')
  await scroll(-view)
  await scroll(-view)
  await scroll(-view)
  expect(await bottom()).toContain(`第 1–${body} 行`)
  expect(await drawnTags(ui)).toEqual(tags)
  expect(engineScrolled).toBe(0)
  await ui.unmount()
})

test('摘要浮層位置: a card in the pane\'s lower half opens its popover above it, never over the tab rows; a card in the upper half opens it below; a short recap gets a short popover with no scroll line', async ($, on) => {
  const w = world(withCards({ perm: { brief: { text: LONG_BRIEF, pending: false } }, logging: { brief: { text: '短摘要', pending: false } } }, 'focusui', ['logging', 'PROJ-6668', 'perm']))
  await start($, on, w)
  await openPane($)
  const view = 20
  const ui = await $.ui.mount({ ...pane(70, view), surface: 'terminal' })
  expect(await drawnTags(ui)).toEqual(['focusui', 'logging', 'PROJ-6668', 'perm'])
  await openBrief($, ui, 'perm')
  // perm is the fourth card: its header sits on row 2 + 3 * 3 + 1 = 12, past the middle; above it are rows 2..11.
  let box = findKey(await ui.drawn(), 'popover')
  expect([box.props.top, box.props.height]).toEqual([2, 12 - 2])
  expect((await popRows(ui))!.at(-1)).toContain('j/k 捲動 · 第 1–7 行／共 30 行')
  await openBrief($, ui, 'logging')
  // logging's header is row 6, in the upper half: the popover starts under its two rows.
  box = findKey(await ui.drawn(), 'popover')
  expect([box.props.top, box.props.height]).toEqual([8, 3 + 1])
  expect((await popRows(ui))!.at(-1)).not.toContain('j/k')
  await ui.unmount()
})

const DIGEST = ['在做什麼：改登入頁的表單驗證', '卡在哪：註冊頁共用同一個驗證元件', '做了什麼：改好登入頁，單元測試全過', '順手清掉兩個舊的 lint 警告', '要你決定：要不要一起改註冊頁，建議：另開一張票'].join('\n')
const OLD_DIGEST = ['前提：改登入頁的表單驗證', '問題：註冊頁共用同一個驗證元件', '解法：改好登入頁，單元測試全過', '建議：要你決定：要不要一起改註冊頁'].join('\n')
const popText = (rows: string[]) => rows.slice(1, -1).map(r => r.replace(/^┃ /, '').trimEnd())

test('摘要小視窗排版：標籤是固定左欄、換行對齊內容欄；▶ 要你決定前空一行、整行強調色加粗；其他標籤淡色、內容前景色；底部分隔線下寫「d 收起 · p 印出完整回報」', async ($, on) => {
  const w = world(withCards({ logging: { brief: { text: DIGEST, pending: false } } }))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(40, 40), surface: 'terminal' })
  await openBrief($, ui, 'logging')
  const rows = (await popRows(ui))!
  const body = popText(rows)
  expect(body[0]).toBe('在做什麼    改登入頁的表單驗證')
  expect(body[1]).toBe('卡在哪      註冊頁共用同一個驗證元件')
  expect(body[2]).toBe('做了什麼    改好登入頁，單元測試全過')
  expect(body[3]).toBe('            順手清掉兩個舊的 lint 警告')
  expect(body[4]).toBe('')
  expect(body[5]).toBe('▶ 要你決定  要不要一起改註冊頁，建議：')
  expect(body[6]).toBe('            另開一張票')
  expect(rows.at(-1)).toMatch(/^─+$/)
  const box = findKey(await ui.drawn(), 'popover')
  expect(textOf(findKey(box, 'popover-footer')).trim()).toBe('d 收起 · p 印出完整回報')
  expect(paintOf(box, '在做什麼    ')).toEqual({ color: THEMES.neutral.dim, bold: undefined })
  expect(paintOf(box, '改登入頁的表單驗證')?.color).toBe(THEMES.neutral.fg)
  expect(paintOf(box, '▶ 要你決定  ')).toEqual({ color: THEMES.neutral.accent, bold: true })
  expect(paintOf(box, '要不要一起改註冊頁，建議：')).toEqual({ color: THEMES.neutral.accent, bold: true })
  for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(40)
  await ui.unmount()
})

test('摘要小視窗：「下一步」用一般字色、不加 ▶、前面不空行；舊摘要檔的舊標籤（前提、問題、解法、建議）畫成同一種排版；沒有標籤的摘要照原文換行', async ($, on) => {
  const next = '在做什麼：改登入頁\n做了什麼：改好了\n下一步：接著改註冊頁'
  const w = world(withCards({ logging: { brief: { text: next, pending: false } }, 'PROJ-6668': { brief: { text: OLD_DIGEST, pending: false } }, perm: { brief: { text: '沒有標籤的一段摘要。', pending: false } } }))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(70, 40), surface: 'terminal' })
  await openBrief($, ui, 'logging')
  expect(popText((await popRows(ui))!)).toEqual(['在做什麼    改登入頁', '做了什麼    改好了', '下一步      接著改註冊頁'])
  const box = findKey(await ui.drawn(), 'popover')
  expect(paintOf(box, '下一步      ')).toEqual({ color: THEMES.neutral.dim, bold: undefined })
  expect(paintOf(box, '接著改註冊頁')).toEqual({ color: THEMES.neutral.fg, bold: undefined })
  await openBrief($, ui, 'PROJ-6668')
  expect(popText((await popRows(ui))!)).toEqual(['在做什麼    改登入頁的表單驗證', '卡在哪      註冊頁共用同一個驗證元件', '做了什麼    改好登入頁，單元測試全過', '', '▶ 要你決定  要不要一起改註冊頁'])
  await openBrief($, ui, 'perm')
  expect(popText((await popRows(ui))!)).toEqual(['沒有標籤的一段摘要。'])
  await ui.unmount()
})

test('換行：英文字整個移到下一行、不從中間切開；全形標點不落在行首；比一行還長的字才逐字切；每行不超過寬度', () => {
  const text = `建議：a 現在刪掉遠端與本機的 branch，一次清乾淨，已合併進 dev 而且 CI 綠了，${'很'.repeat(5)}，遠端留著沒有用處`
  for (const max of [20, 34, 74]) {
    const lines = wrapColumns(text, max)
    for (const line of lines) expect(columns(line)).toBeLessThanOrEqual(max)
    expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
    for (let i = 1; i < lines.length; i++) {
      expect(/^[，。、？！：；）]/.test(lines[i]!)).toBe(false)
      expect(/[A-Za-z]$/.test(lines[i - 1]!) && /^[A-Za-z]/.test(lines[i]!)).toBe(false)
    }
  }
  expect(wrapColumns('a'.repeat(12), 5)).toEqual(['aaaaa', 'aaaaa', 'aa'])
})

// --- 審核單 ---

const reviewItem = (n: number, question: string, plan: string, basis: string, impact: string, precedent: boolean) => ({ n, kind: 'decision', question, plan, basis, precedent, impact, status: 'pending', edit: null, asks: [] as any[], example: null as string | null, by: 'child' })
const SAMPLE_SHEET = () => ({
  tag: 'ask-aide',
  path: '/wt/ask-aide',
  repo: 'worktree-console',
  branch: 'feat/focus-card-progress',
  pr: 'PR #52',
  problems: ['第 3 件缺影響範圍'],
  fresh: [
    reviewItem(1, '卡片進度條在 46 欄時，要先讓出什麼？', '先縮短進度條，狀態字只留符號。', '沒有前例；你說 repo 和 branch 不能讓位。', '焦點面板的卡片第一行。', false),
    reviewItem(2, '沒有驗收清單的卡片，執行段怎麼畫？', '畫淡綠虛線，不顯示數字。', '沒有前例；評審建議不要只靠變暗。', '焦點面板的進度條。', false),
  ],
  past: [reviewItem(3, '測試要補到哪一層？', '補在元件層', '11/10 你的回答', '測試', true), reviewItem(4, 'commit 要拆幾個？', '功能和升版分開', 'AGENTS.md', 'git', true)],
})
const REVIEW_CARD = card('ask-aide', { repo: 'worktree-console', branch: 'feat/focus-card-progress', path: '/wt/ask-aide', review: 4, status: '回覆完畢', question: '照審核單先做哪一件？' })
const reviewWorld = () => {
  const w = world({ ...focusOf('perm', ['ask-aide', 'focusui']), sessions: [...SESSIONS, REVIEW_CARD] })
  w.sheet = SAMPLE_SHEET()
  w.submits = []
  return w
}
const reviewCalls = (w: World) => w.calls.filter(c => c[0] === 'review').map(c => c.slice(1))
const REVIEW_PATH = ['--path', '/wt/ask-aide']

// The drawing as a terminal lays it out, one string per row: a column stacks its rows (a margin adds blank rows, a zero-height box none),
// a row joins its parts and space-between pads between the first part and the rest to the row's width.
function screenLines(node: any, width: number): string[] {
  if (typeof node === 'string') return [node]
  if (!node) return []
  if (node.type === 'Text') return [textOf(node)]
  if (node.type === 'Button') return [(node.children ?? []).length ? textOf(node) : `${node.props?.label ?? ''}`]
  if (node.type === 'Input') return [`${node.props?.label ?? ''}${node.props?.value || node.props?.placeholder || ''}`]
  const props = node.props ?? {}
  if (props.height === 0) return []
  const w = props.width ?? width
  const kids = (node.children ?? []).filter((c: any) => c !== null && c !== false && c !== undefined)
  if (props.flexDirection === 'row') {
    const parts = kids.map((c: any) => screenLines(c, w)[0] ?? '').map((t: string, i: number) => {
      const kw = typeof kids[i] === 'object' ? kids[i]?.props?.width : undefined
      return kw !== undefined ? t + ' '.repeat(Math.max(0, kw - cells(t))) : t
    })
    if (props.justifyContent === 'space-between' && parts.length >= 2) {
      const rest = parts.slice(1).join('')
      return [`${parts[0]}${' '.repeat(Math.max(0, w - cells(parts[0]) - cells(rest)))}${rest}`]
    }
    return [parts.join('')]
  }
  return [...Array(props.marginTop ?? 0).fill(''), ...kids.flatMap((c: any) => screenLines(c, w))]
}
const reviewFrame = async (ui: any, cols: number) => screenLines(await ui.drawn(), cols).map(l => l.replace(/\s+$/, ''))

async function openSheet($: any, on: On, cols = 70, rows = 200, edit: (w: World) => void = () => {}) {
  const w = reviewWorld()
  edit(w)
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(cols, rows), surface: 'terminal' })
  await ui.press({ key: `name:${keyOf('ask-aide')}` })
  await clock.settle()
  return { w, clock, ui }
}

test('審核單：review > 0 的卡片按 Enter（點代號）開審核單畫面、跑 review data --json，不切換橫條；數字鍵也一樣', async ($, on) => {
  const { w, ui, clock } = await openSheet($, on)
  expect(reviewCalls(w)).toEqual([['data', ...REVIEW_PATH, '--json']])
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  const frame = await reviewFrame(ui, 70)
  expect(frame[0]).toBe('審核單：ask-aide')
  expect(await ui.find({ key: 'tab:pending' })).toBeUndefined()
  expect(w.shown).toEqual([])
  await ui.unmount()
  const away = await $.ui.mount({ ...pane(70), props: { ...pane(70).props, isFocused: false }, surface: 'terminal' })
  await away.unmount()
  const back = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await back.find({ key: 'tab:pending' })).toBeDefined()
  await back.press({ key: `num:${keyOf('ask-aide')}` })
  await clock.settle()
  expect((await reviewFrame(back, 70))[0]).toBe('審核單：ask-aide')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await back.unmount()
})

test('審核單畫面（70 欄）：沒有說明句和警告；標題、branch · PR 與靠右的 repo、先看：沒有前例每件四行、照你過去的回答每件兩行（出處括號）、底下按鍵說明', async ($, on) => {
  const { ui } = await openSheet($, on)
  const frame = await reviewFrame(ui, 70)
  expect(frame).toEqual([
    '審核單：ask-aide',
    `feat/focus-card-progress · PR #52${' '.repeat(70 - cells('feat/focus-card-progress · PR #52') - cells('worktree-console'))}worktree-console`,
    '',
    '先看：沒有前例',
    ` ${MARK_STILL} 1. 卡片進度條在 46 欄時，要先讓出什麼？`,
    '      當前方案  先縮短進度條，狀態字只留符號。',
    '      依據      沒有前例；你說 repo 和 branch 不能讓位。',
    '      影響範圍  焦點面板的卡片第一行。',
    '',
    '   2. 沒有驗收清單的卡片，執行段怎麼畫？',
    '      當前方案  畫淡綠虛線，不顯示數字。',
    '      依據      沒有前例；評審建議不要只靠變暗。',
    '      影響範圍  焦點面板的進度條。',
    '',
    '照你過去的回答',
    '   3. 測試要補到哪一層？',
    '      當前方案  補在元件層（出處：11/10 你的回答）',
    '',
    '   4. commit 要拆幾個？',
    '      當前方案  功能和升版分開（出處：AGENTS.md）',
    '',
    '↑↓ 選 · Enter 通過 · e 改 · x 問 · c 討論 · Esc 返回',
  ])
  expect(frame.join('\n')).not.toMatch(/缺影響範圍|警告|請審核/)
  for (const line of frame) expect(cells(line)).toBeLessThanOrEqual(70)
  await ui.unmount()
})

test('審核單畫面（46 欄）：每行都不超出面板；題目以 … 截短，方案、依據換行時對齊內容欄；按鍵說明在按鍵之間換行', async ($, on) => {
  const long = '沒有驗收清單、也沒有進度數字的卡片，執行段要怎麼畫才不會被看成停住？'
  const { ui } = await openSheet($, on, 46, 200, w => void (w.sheet.fresh[1].question = long))
  const frame = await reviewFrame(ui, 46)
  const cut = frame.find(l => l.startsWith('   2. '))!
  // A two-column character that would end past the row leaves its column blank.
  expect([cut.endsWith('…'), long.startsWith(cut.slice(6, -1)), cells(cut) >= 45 && cells(cut) <= 46]).toEqual([true, true, true])
  for (const line of frame) expect(cells(line)).toBeLessThanOrEqual(46)
  expect(frame[1]).toBe('feat/focus-card-progress · …  worktree-console')
  expect(frame[4]).toBe(` ${MARK_STILL} 1. 卡片進度條在 46 欄時，要先讓出什麼？`)
  const basis = frame.findIndex(l => l.startsWith('      依據      沒有前例；你說'))
  expect(frame[basis + 1]!.startsWith(' '.repeat(16))).toBe(true)
  expect(frame[basis + 1]!.trim()).not.toBe('')
  const fields = frame.filter(l => /^ {6}(當前方案|依據|影響範圍| {10})/.test(l))
  expect(fields.length).toBeGreaterThan(6)
  for (const l of fields) expect([l, cells(/^ {6}(當前方案|依據|影響範圍)? +/.exec(l)![0])]).toEqual([l, 16])
  const keys = frame.slice(frame.lastIndexOf('') + 1)
  expect(keys.length).toBeGreaterThan(1)
  expect(keys.join(' · ')).toBe('↑↓ 選 · Enter 通過 · e 改 · x 問 · c 討論 · Esc 返回')
  await ui.unmount()
})

for (const name of ['neutral', 'dracula'] as const) {
  test(`審核單欄位標籤（${name}）：當前方案、依據、影響範圍用主題最淡的灰（dim 色再加 dimColor），比一般淡色字（branch 那行）更淡；內容用前景色；待審那件的題目用粗體、強調色混 60% 進前景色（neutral 的終端機色名不混、維持前景色）`, async ($, on) => {
    const w = reviewWorld()
    appearanceConfig.set(w, { theme: name, motion: false })
    const clock = await start($, on, w)
    await openPane($)
    const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
    await ui.press({ key: `name:${keyOf('ask-aide')}` })
    await clock.settle()
    const theme = THEMES[name]
    const textsNow = await ui.findAll({ type: 'Text' })
    for (const label of ['當前方案', '依據', '影響範圍']) {
      const t = textsNow.filter((x: any) => x.text.trim() === label)
      expect(t.length).toBeGreaterThan(0)
      for (const x of t) expect([x.props.color, x.props.dimColor]).toEqual([theme.dim, true])
    }
    const meta = textsNow.find((x: any) => x.text.startsWith('feat/focus-card-progress'))
    expect([meta.props.color, meta.props.dimColor]).toEqual([theme.dim, undefined])
    const value = textsNow.find((x: any) => x.text === '先縮短進度條，狀態字只留符號。')
    expect([value.props.color, value.props.dimColor]).toEqual([theme.fg, undefined])
    for (const title of ['1. 卡片進度條在 46 欄時，要先讓出什麼？', '3. 測試要補到哪一層？']) {
      const t = textsNow.find((x: any) => x.text === title)
      expect([t.props.color, t.props.bold, t.props.dimColor]).toEqual([name === 'dracula' ? '#b7eff9' : theme.fg, true, undefined])
    }
    await ui.unmount()
  })
}

test('審核單 Enter：通過選中的那件（review pass），那件收成一行「✓ N. 題目」，選取跳到下一件待審的', async ($, on) => {
  const { w, ui } = await openSheet($, on)
  await ui.press({ key: 'item:1' })
  expect(reviewCalls(w).slice(1, 2)).toEqual([['pass', ...REVIEW_PATH, '--n', '1']])
  const frame = await reviewFrame(ui, 70)
  expect(frame.slice(3, 7)).toEqual(['先看：沒有前例', ' ✓ 1. 卡片進度條在 46 欄時，要先讓出什麼？', '', ` ${MARK_STILL} 2. 沒有驗收清單的卡片，執行段怎麼畫？`])
  expect(frame.join('\n')).not.toContain('先縮短進度條')
  expect(paintOf(await ui.drawn(), ' ✓ ')?.color).toBe(THEMES.neutral.busy)
  await ui.unmount()
})

test('審核單 ↑↓：一次移一件，停在第一件與最後一件；Enter 作用在選中的那件', async ($, on) => {
  const { w, ui } = await openSheet($, on)
  const marked = async () => (await reviewFrame(ui, 70)).filter(l => l.startsWith(` ${MARK_STILL} `)).map(l => l.slice(3, 5))
  const buttons = async () => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key) as string[]
  const step = async (dir: 1 | -1) => {
    const keys = await buttons()
    const at = keys.indexOf(w.focused.at(-1)!)
    const n = keys.length
    await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: keys[(at + dir + n) % n], origin: { kind: 'person' } } as any)
  }
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: 'item:1', origin: { kind: 'plugin', name: PLUGIN } } as any)
  expect(await marked()).toEqual(['1.'])
  await step(-1)
  expect(await marked()).toEqual(['1.'])
  await step(1)
  expect(await marked()).toEqual(['2.'])
  await step(1)
  await step(1)
  expect(await marked()).toEqual(['4.'])
  await step(1)
  expect(await marked()).toEqual(['4.'])
  expect(w.focused.at(-1)).toBe('item:4')
  await ui.press({ key: 'item:4' })
  expect(reviewCalls(w).at(-2)).toEqual(['pass', ...REVIEW_PATH, '--n', '4'])
  await ui.unmount()
})

test('審核單 e：那件底下開「改成」輸入框，Enter 送 review edit --to，那件標「已改」並顯示新方案；Esc 只收起輸入框，不改、不離開審核單', async ($, on) => {
  const { w, ui, clock } = await openSheet($, on)
  await ui.press({ key: 'review-edit' })
  const input = await ui.find({ key: 'review-input' })
  expect(input?.type).toBe('Input')
  expect(input?.props.label).toBe('改成 ')
  let frame = await reviewFrame(ui, 70)
  expect(frame[frame.indexOf('      影響範圍  焦點面板的卡片第一行。') + 1]).toBe('      改成')
  expect(frame.at(-1)).toBe('Enter 送出 · Esc 取消')
  await ui.unmount()
  const away = await $.ui.mount({ ...pane(70), props: { ...pane(70).props, isFocused: false }, surface: 'terminal' })
  expect(await away.find({ key: 'review-input' })).toBeUndefined()
  expect((await reviewFrame(away, 70))[0]).toBe('審核單：ask-aide')
  await away.unmount()
  expect(reviewCalls(w).filter(c => c[0] === 'edit')).toEqual([])
  const back = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  await back.press({ key: 'review-edit' })
  await back.input({ key: 'review-input', text: '進度條改成 4 格' })
  await clock.settle()
  expect(reviewCalls(w).filter(c => c[0] === 'edit')).toEqual([['edit', ...REVIEW_PATH, '--n', '1', '--to', '進度條改成 4 格']])
  frame = await reviewFrame(back, 70)
  const head = frame.find(l => l.includes('1. 卡片進度條'))!
  expect(head).toMatch(/^ ✓ 1\. 卡片進度條在 46 欄時，要先讓出什麼？ +已改$/)
  expect(cells(head)).toBe(70)
  expect(frame[frame.indexOf(head) + 1]).toBe('      改成      進度條改成 4 格')
  expect(frame.join('\n')).not.toContain('先縮短進度條')
  await back.unmount()
})

test('審核單 x：開「問」輸入框（提示「空白直接按 Enter＝要一個實際範例」）；空白送出要範例（review ask 不帶 --q），有字就帶 --q；答案插在那件底下，問答在背景跑、跑完才重畫', async ($, on) => {
  const { w, ui, clock } = await openSheet($, on)
  let release = () => {}
  w.askGate = new Promise<void>(r => (release = r))
  await ui.press({ key: 'review-ask' })
  const input = await ui.find({ key: 'review-input' })
  expect([input?.props.label, input?.props.placeholder]).toEqual(['問 ', '空白直接按 Enter＝要一個實際範例'])
  await ui.input({ key: 'review-input', text: '' })
  let frame = await reviewFrame(ui, 70)
  expect(frame).toContain('      範例      產生中…')
  release()
  await clock.settle()
  expect(reviewCalls(w).filter(c => c[0] === 'ask')).toEqual([['ask', ...REVIEW_PATH, '--n', '1']])
  frame = await reviewFrame(ui, 70)
  const impact = frame.indexOf('      影響範圍  焦點面板的卡片第一行。')
  expect(frame[impact + 1]).toBe('      範例      如果卡片只有 46 欄，進度條縮成 6 格，狀態字只剩 ◆。')
  w.askGate = undefined
  await ui.press({ key: 'review-ask' })
  await ui.input({ key: 'review-input', text: '狀態字只剩符號會不會看不懂？' })
  await clock.settle()
  expect(reviewCalls(w).filter(c => c[0] === 'ask').at(-1)).toEqual(['ask', ...REVIEW_PATH, '--n', '1', '--q', '狀態字只剩符號會不會看不懂？'])
  frame = await reviewFrame(ui, 70)
  expect(frame.slice(impact + 1, impact + 4)).toEqual([
    '      前面 1 輪問答（h 展開）',
    '      問        狀態字只剩符號會不會看不懂？',
    '      答        答覆：狀態字只剩符號會不會看不懂？，先照方案做。',
  ])
  expect(frame.at(-1)!.includes('h 展開問答') || frame.slice(-2).join(' · ').includes('h 展開問答')).toBe(true)
  await ui.press({ key: 'review-asks' })
  frame = await reviewFrame(ui, 70)
  expect(frame.slice(impact + 1, impact + 5)).toEqual([
    '      前面 1 輪問答（h 收起）',
    '      範例      如果卡片只有 46 欄，進度條縮成 6 格，狀態字只剩 ◆。',
    '      問        狀態字只剩符號會不會看不懂？',
    '      答        答覆：狀態字只剩符號會不會看不懂？，先照方案做。',
  ])
  await ui.press({ key: 'review-asks' })
  expect((await reviewFrame(ui, 70))[impact + 1]).toBe('      前面 1 輪問答（h 展開）')
  await ui.unmount()
})

test('審核單 o：那件有範例檔時按鍵說明才有「o 開範例」，按 o 用 open 開範例檔；沒有範例時 o 什麼都不做', async ($, on) => {
  const { w, ui, clock } = await openSheet($, on)
  expect((await reviewFrame(ui, 70)).join('\n')).not.toContain('o 開範例')
  await ui.press({ key: 'review-open' })
  expect(w.opens ?? []).toEqual([])
  await ui.press({ key: 'review-ask' })
  await ui.input({ key: 'review-input', text: '' })
  await clock.settle()
  expect((await reviewFrame(ui, 70)).at(-1)).toBe('↑↓ 選 · Enter 通過 · e 改 · x 問 · o 開範例 · c 討論 · Esc 返回')
  await ui.press({ key: 'review-open' })
  expect(w.opens).toEqual(['/tmp/examples/1-1.md'])
  await ui.unmount()
})

test('審核單 c：把選中那件的題目、當前方案、依據、影響範圍送進中控台對話討論；畫面不變', async ($, on) => {
  const { w, ui, clock } = await openSheet($, on)
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: 'item:2', origin: { kind: 'plugin', name: PLUGIN } } as any)
  await ui.press({ key: 'review-talk' })
  await clock.settle()
  expect(w.submits).toEqual([['討論審核單 ask-aide 第 2 件：', '題目：沒有驗收清單的卡片，執行段怎麼畫？', '當前方案：畫淡綠虛線，不顯示數字。', '依據：沒有前例；評審建議不要只靠變暗。', '影響範圍：焦點面板的進度條。'].join('\n')])
  expect((await reviewFrame(ui, 70))[0]).toBe('審核單：ask-aide')
  await ui.unmount()
})

test('審核單 a：選取在「先看：沒有前例」時按鍵說明沒有 a、按 a 不做事；移到「照你過去的回答」才有「a 全部通過」，按下跑 review pass-all，只通過那一段', async ($, on) => {
  const { w, ui, clock } = await openSheet($, on)
  for (const n of [1, 2]) {
    await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: `item:${n}`, origin: { kind: 'plugin', name: PLUGIN } } as any)
    expect((await reviewFrame(ui, 70)).join('\n')).not.toContain('a 全部通過')
    await ui.press({ key: 'review-all' })
    await clock.settle()
    expect(reviewCalls(w).filter(c => c[0] === 'pass-all')).toEqual([])
  }
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: 'item:3', origin: { kind: 'plugin', name: PLUGIN } } as any)
  expect((await reviewFrame(ui, 70)).at(-1)).toBe('↑↓ 選 · Enter 通過 · e 改 · x 問 · a 全部通過 · c 討論 · Esc 返回')
  await ui.press({ key: 'review-all' })
  await clock.settle()
  expect(reviewCalls(w).filter(c => c[0] === 'pass-all')).toEqual([['pass-all', ...REVIEW_PATH]])
  const frame = await reviewFrame(ui, 70)
  expect(frame).toContain(' ✓ 3. 測試要補到哪一層？')
  expect(frame).toContain(' ✓ 4. commit 要拆幾個？')
  expect(frame).toContain('      當前方案  先縮短進度條，狀態字只留符號。')
  expect(frame.filter(l => l.startsWith(` ${MARK_STILL} `))).toEqual([` ${MARK_STILL} 1. 卡片進度條在 46 欄時，要先讓出什麼？`])
  expect(reviewCalls(w).filter(c => c[0] === 'done')).toEqual([])
  await ui.unmount()
})

test('審核單收尾：每件都通過或改過後停在「全部審完，按 Enter 送出審核結果」（還能按 u 退回），按 Enter 才跑 review done，跳出它印的結果，回到卡片並重新輪詢；卡片不再是待審核', async ($, on) => {
  const { w, ui, clock } = await openSheet($, on)
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: 'item:3', origin: { kind: 'plugin', name: PLUGIN } } as any)
  await ui.press({ key: 'review-all' })
  await ui.press({ key: 'item:1' })
  await ui.press({ key: 'review-edit' })
  await ui.input({ key: 'review-input', text: '畫灰色虛線' })
  await clock.settle()
  expect(reviewCalls(w).map(c => c[0])).toEqual(['data', 'pass-all', 'data', 'pass', 'data', 'edit', 'data'])
  const frame = await reviewFrame(ui, 70)
  expect(frame).toContain(` ${MARK_STILL} 全部審完，按 Enter 送出審核結果`)
  expect(frame.at(-1)).toBe('Enter 送出審核結果 · u 退回上一件 · Esc 返回')
  await ui.press({ key: 'review-finish' })
  await clock.settle()
  expect(reviewCalls(w).map(c => c[0]).at(-1)).toBe('done')
  expect(w.toasts).toContain('[ask-aide] 審核單已審完 · 已送回 ask-aide')
  expect(await ui.find({ key: 'tab:pending' })).toBeDefined()
  expect(textOf(findKey(await ui.drawn(), `status:${keyOf('ask-aide')}`))).not.toContain('待審核')
  await ui.unmount()
})

test('審核單 Esc：沒開輸入框時回到卡片；進度存在磁碟上，再開同一張審核單時已通過的那件仍是 ✓', async ($, on) => {
  const { w, ui, clock } = await openSheet($, on)
  await ui.press({ key: 'item:1' })
  await ui.unmount()
  const away = await $.ui.mount({ ...pane(70), props: { ...pane(70).props, isFocused: false }, surface: 'terminal' })
  await away.unmount()
  const back = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await back.find({ key: 'tab:pending' })).toBeDefined()
  await back.press({ key: `name:${keyOf('ask-aide')}` })
  await clock.settle()
  const frame = await reviewFrame(back, 70)
  expect(frame).toContain(' ✓ 1. 卡片進度條在 46 欄時，要先讓出什麼？')
  expect(frame.find(l => l.startsWith(` ${MARK_STILL} `))).toBe(` ${MARK_STILL} 2. 沒有驗收清單的卡片，執行段怎麼畫？`)
  expect(reviewCalls(w).filter(c => c[0] === 'data')).toHaveLength(3)
  await back.unmount()
})

test('審核單捲動：面板放不下時只畫看得到的列，選中的那件整件露出，按鍵說明留在最下面', async ($, on) => {
  const { ui } = await openSheet($, on, 70, 12)
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: 'item:4', origin: { kind: 'plugin', name: PLUGIN } } as any)
  const frame = await reviewFrame(ui, 70)
  expect(frame.length).toBeLessThanOrEqual(12)
  expect(frame).toContain(` ${MARK_STILL} 4. commit 要拆幾個？`)
  expect(frame).toContain('      當前方案  功能和升版分開（出處：AGENTS.md）')
  expect(frame.at(-1)).toContain('Esc 返回')
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('item:')).map((b: any) => b.key)).toEqual(['item:1', 'item:2', 'item:3', 'item:4'])
  await ui.unmount()
})

for (const cols of [70, 46]) {
  test(`審核單畫面範例（${cols} 欄）：一開始的畫面，與通過第 1 件、在第 2 件問一題之後的畫面；每行都不超出面板`, async ($, on) => {
    const { ui, clock } = await openSheet($, on, cols)
    const first = await reviewFrame(ui, cols)
    await ui.press({ key: 'item:1' })
    await ui.press({ key: 'review-ask' })
    await ui.input({ key: 'review-input', text: '虛線在淺色主題看得到嗎？' })
    await clock.settle()
    const second = await reviewFrame(ui, cols)
    for (const line of [...first, ...second]) expect(cells(line)).toBeLessThanOrEqual(cols)
    expect(second).toContain(' ✓ 1. 卡片進度條在 46 欄時，要先讓出什麼？')
    expect(second.find(l => l.startsWith(` ${MARK_STILL} `))).toBe(` ${MARK_STILL} 2. 沒有驗收清單的卡片，執行段怎麼畫？`)
    expect(second.some(l => l.startsWith('      問        虛線在淺色主題'))).toBe(true)
    console.log([`=== review-sheet-${cols} ===`, `── 一開始（${cols} 欄） ──`, ...first, '', `── 通過第 1 件、在第 2 件問一題之後（${cols} 欄） ──`, ...second, `=== end ===`].join('\n'))
    await ui.unmount()
  })
}

test('審核單 u：退回這次最近通過或改的那件（review undo），那件回到待審並被選中；連按逐件往回退；沒有可退的時按鍵說明沒有 u、按 u 不做事', async ($, on) => {
  const { w, ui, clock } = await openSheet($, on)
  expect((await reviewFrame(ui, 70)).join('\n')).not.toContain('u 退回')
  await ui.press({ key: 'review-undo' })
  expect(reviewCalls(w).filter(c => c[0] === 'undo')).toEqual([])
  await ui.press({ key: 'item:1' })
  await ui.press({ key: 'review-edit' })
  await ui.input({ key: 'review-input', text: '畫灰色虛線' })
  await clock.settle()
  expect((await reviewFrame(ui, 70)).slice(-2).join(' · ')).toContain('u 退回')
  await ui.press({ key: 'review-undo' })
  await clock.settle()
  let frame = await reviewFrame(ui, 70)
  expect(frame).toContain(` ${MARK_STILL} 2. 沒有驗收清單的卡片，執行段怎麼畫？`)
  expect(frame).toContain('      當前方案  畫淡綠虛線，不顯示數字。')
  await ui.press({ key: 'review-undo' })
  await clock.settle()
  frame = await reviewFrame(ui, 70)
  expect(frame).toContain(` ${MARK_STILL} 1. 卡片進度條在 46 欄時，要先讓出什麼？`)
  expect(frame.join('\n')).not.toContain('u 退回')
  expect(reviewCalls(w).filter(c => c[0] === 'undo')).toEqual([['undo', ...REVIEW_PATH, '--n', '2'], ['undo', ...REVIEW_PATH, '--n', '1']])
  await ui.unmount()
})

test('審核單 e／x：輸入框自動拿到焦點（autoFocus），打的字照寬度換行、輸入框跟著長高，下面的件往下推、不蓋字', async ($, on) => {
  const { ui } = await openSheet($, on, 46)
  await ui.press({ key: 'review-edit' })
  const input = await ui.find({ key: 'review-input' })
  expect(input?.props.autoFocus).toBe(true)
  expect(input?.props.rows).toBe(1)
  const long = '進度條改成 4 格，狀態字保留中文，repo 名稱過長時從中間截短並保留最後一段'
  await ui.input({ key: 'review-input', text: long, kind: 'change' })
  const grown = await ui.find({ key: 'review-input' })
  expect(grown?.props.rows).toBeGreaterThan(1)
  expect(grown?.props.value).toBe(long)
  const rows = grown!.props.rows
  expect(findKey(await ui.drawn(), 'row:input:1')?.props.height).toBe(rows)
  expect(findKey(await ui.drawn(), 'review-input-box')?.props.height).toBe(rows)
  const frame = await reviewFrame(ui, 46)
  const at = frame.findIndex(l => l.startsWith('      改成'))
  expect(frame.slice(at + 1, at + 3)).toEqual(['', '   2. 沒有驗收清單的卡片，執行段怎麼畫？'])
  await ui.unmount()
})

test('審核單 x 問的答案：Markdown 粗體標記 ** 與 __ 不原樣顯示，只留文字', async ($, on) => {
  const { ui } = await openSheet($, on, 70, 200, w => { w.sheet.fresh[0].asks = [{ q: '為什麼？', a: '因為 **46 欄** 時放不下，__狀態字__ 會被擠掉。' }] })
  const frame = await reviewFrame(ui, 70)
  expect(frame).toContain('      答        因為 46 欄 時放不下，狀態字 會被擠掉。')
  expect(frame.join('\n')).not.toMatch(/\*\*|__/)
  await ui.unmount()
})
