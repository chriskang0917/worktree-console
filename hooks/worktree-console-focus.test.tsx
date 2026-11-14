import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { columns, statusCell, wrapColumns } from './status-view.ts'
import { focusBandRows, MARK_SPIN, MARK_STILL } from './worktree-console-focus.tsx'
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

type World = { focus: any; decideFails?: string[]; closes?: string[]; notes?: string[][]; afterAuto?: any; answer?: string; skips?: string[]; submits?: string[]; sticky?: boolean; showFails?: boolean; lost?: number; dropped?: string[]; calls: string[][]; toasts: string[]; shown: string[]; writes: Record<string, string>; opened: any[]; hints: object[]; focused: string[] }
type AppearanceConfig = { appearance?: string; theme?: string; motion?: unknown }
const appearanceConfig = new WeakMap<World, AppearanceConfig | string>()

const focusOf = (current: string, queue: string[], extra: object = {}) => ({
  active: true,
  home: HOME,
  current: keyOf(current),
  announce: null,
  waiting: null,
  queue: queue.map(t => ({ key: keyOf(t), isNew: false })),
  stats: STATS,
  sessions: SESSIONS,
  ...extra,
})

const pending = () => focusOf('perm', ['focusui', 'logging', 'PROJ-6668', 'upgrade#2'])

// Answers `node console.mjs <sub>` from the world: focus-pick puts that key on the band, focus-later sends the current one to the back, unarchive clears that tag's archived flag.
function fakeConsole(on: On, world: World) {
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'herdr') {
      world.notes = [...(world.notes ?? []), [...e.argv]]
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const args = e.argv.slice(2)
    world.calls.push([...args])
    const f = world.focus
    if (args[0] === 'focus-pick' && f.active) {
      const keys = [f.current, ...f.queue.map((q: any) => q.key)]
      world.focus = { ...f, current: args[1], queue: keys.filter(k => k !== args[1]).map(key => ({ key, isNew: false })), announce: f.sessions.find((s: Card) => s.key === args[1]).tag }
    } else if (args[0] === 'focus-later' && f.active) {
      const [next, ...rest] = f.queue
      world.focus = { ...f, current: next.key, queue: [...rest, { key: f.current, isNew: false }], announce: f.sessions.find((s: Card) => s.key === next.key).tag }
    } else if (args[0] === 'focus-auto' && f.active) {
      world.focus = world.afterAuto ?? f
    } else if (args[0] === 'focus-cancel' && f.active) {
      world.focus = { ...f, sessions: f.sessions.map((s: any) => (s.key === args[1] && s.advice ? { ...s, advice: { ...s.advice, auto: undefined } } : s)) }
    } else if (args[0] === 'decide' && args[2] === 'manual' && f.active) {
      const d = f.decisions.find((x: any) => x.id === args[1])
      world.focus = { ...f, decisions: f.decisions.filter((x: any) => x.id !== args[1]) }
      return { value: { exitCode: 0, stdout: `[${d.tag}] 改成自己回，已放上橫條\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    } else if (args[0] === 'decide' && f.active) {
      const ids = args[1] === '--all' ? f.decisions.map((d: any) => d.id) : [args[1]]
      const fails = world.decideFails ?? []
      const lines = f.decisions.filter((d: any) => ids.includes(d.id)).map((d: any) => (fails.includes(d.id) ? `[${d.tag}] 送出失敗，留在待決` : `[${d.tag}] 已核可並送出：${d.answer}`))
      world.focus = { ...f, decisions: f.decisions.flatMap((d: any) => (!ids.includes(d.id) ? [d] : fails.includes(d.id) ? [{ ...d, failed: true }] : [])) }
      return { value: { exitCode: fails.length ? 1 : 0, stdout: `${lines.join('\n')}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    } else if (args[0] === 'unarchive') {
      world.focus = { ...f, sessions: f.sessions.map((s: Card) => (s.tag === args[1] ? { ...s, archived: false } : s)) }
      return { value: { exitCode: 0, stdout: `[${args[1]}] 已取消封存\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout = JSON.stringify(world.focus)
    if (args[0] === 'focus' && !world.sticky) world.focus = { ...world.focus, announce: null }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
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

const headRow = async (ui: any) => {
  const root = await ui.drawn()
  return findKey(root, 'band-head')
}

test('band header: status icon, status word and 代號 on the left, 8 延後處理 · 9 顯示問題 on the right in the dim colour; the whole question; 0 面板 and queue 1–5 below', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(), surface })
    const head = await headRow(ui)
    expect(head.props.width).toBe(160 - 4)
    expect(head.props.justifyContent).toBe('space-between')
    const [left, right] = head.children
    expect(textOf(left)).toBe('◆ 待授權  perm')
    expect(right.props.key).toBe('band-actions')
    expect(drawnText(right)).toBe('8: 延後處理 · 9: 顯示問題')
    expect((await ui.find({ key: 'show' }))?.props).toMatchObject({ hotkey: '9', label: '顯示問題' })
    expect((await ui.find({ key: 'later' }))?.props).toMatchObject({ hotkey: '8', label: '延後處理' })
    expect(paintOf(await ui.drawn(), '顯示問題')?.color).toBe(THEMES.neutral.dim)
    expect(paintOf(await ui.drawn(), '延後處理')?.color).toBe(THEMES.neutral.dim)
    expect((await ui.find({ key: 'question' }))?.text).toBe('Bash rm -rf build')
    expect(await labels(ui)).toEqual(['8: 延後處理', '9: 顯示問題', '1: focusui', '2: logging', '3: PROJ-6668', '4: upgrade#2', '0: 面板'])
    expect((await ui.find({ key: 'queue:0' }))?.props.dimColor).toBe(true)
    await ui.unmount()
  }
})

test('band header: an empty queue leaves only 9 顯示問題, still on the right; the old row of buttons is gone and its row goes to the question', async ($, on) => {
  const w = world(focusOf('perm', []))
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(80, 20), surface: 'terminal' })
  const head = await headRow(ui)
  expect(drawnText(head.children[1])).toBe('9: 顯示問題')
  expect(await ui.find({ key: 'later' })).toBeUndefined()
  const root = await ui.drawn()
  expect(root.children.filter((c: any) => typeof c !== 'string').map((c: any) => c.props.key ?? null)).toEqual([null, null, null, 'keys', null])
  expect(focusBandRows({ cols: 80, maxRows: 20, question: 'q', queue: [], hiddenCount: 0 }).actions).toBe(0)
  expect(focusBandRows({ cols: 80, maxRows: 20, question: 'q', queue: [{ tag: 'a', isNew: false }], hiddenCount: 0 }).actions).toBe(0)
  await ui.unmount()
})

test('band header at 40 columns: a long 代號 is cut with …, both buttons stay whole, and the header is one row', async ($, on) => {
  const long = 'feat/backend-api-request-comment'
  const w = world({ ...focusOf(long, ['focusui']), sessions: [card(long), ...SESSIONS] })
  await start($, on, w)
  for (const cols of [40, 46, 60]) {
    const ui = await $.ui.mount({ ...band(cols, 20), surface: 'terminal' })
    const head = await headRow(ui)
    const name = (await ui.find({ key: 'band-name' }))!.text
    expect(name.endsWith('…')).toBe(true)
    expect(long.startsWith(name.slice(0, -1))).toBe(true)
    expect(drawnText(head.children[1])).toBe('8: 延後處理 · 9: 顯示問題')
    const used = cardWidth(textOf(head.children[0])) + cardWidth(drawnText(head.children[1]))
    expect(used).toBeLessThanOrEqual(cols - 4)
    expect(cardLines(head, cols - 4).filter(line => line.trim())).toHaveLength(1)
    await ui.unmount()
  }
})

test('band: the queue shows at most 5 (1–5) and a new one is marked ✨; nothing sits on 6 or 7; 8 延後處理 only while the queue has one', async ($, on) => {
  const many = Array.from({ length: 9 }, (_, i) => card(`t${i}`))
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  w.focus.queue[1].isNew = true
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await labels(ui)).toEqual(['8: 延後處理', '9: 顯示問題', '1: t0', '2: t1 ✨', '3: t2', '4: t3', '5: t4', '0: 面板'])
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => ['6', '7'].includes(b.props.hotkey))).toEqual([])
  await ui.unmount()
  w.focus = focusOf('perm', [])
  await clock.advance(5_000)
  const alone = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await labels(alone)).toEqual(['9: 顯示問題', '0: 面板'])
  await alone.unmount()
})

test('band: the question takes one line, cut with … past the line; the header and key rows keep their rows and places', async ($, on) => {
  const long = '這是一題很長的問題，'.repeat(30)
  const shortQ = '要刪掉 build 嗎？'
  const withQuestion = (question: string) => ({ ...pending(), sessions: SESSIONS.map(s => (s.tag === 'perm' ? { ...s, question } : s)) })
  const w = world(withQuestion(long))
  const clock = await start($, on, w)
  const shape = (n: any): any => (typeof n === 'string' ? 's' : { type: n.type, height: n.props?.height, key: n.props?.key, children: (n.children ?? []).map(shape) })
  const layout = async (ui: any) => shape(await ui.drawn()).children.map((row: any) => ({ ...row, children: row.key === undefined && row.height === 1 ? row.children.length : row.children }))
  for (const cols of [160, 40]) {
    w.focus = withQuestion(long)
    await clock.advance(5_000)
    const ui = await $.ui.mount({ ...band(cols, 20), surface: 'terminal' })
    const cut = (await ui.find({ key: 'question' }))!.text
    expect(cut.endsWith('…')).toBe(true)
    expect(long.startsWith(cut.slice(0, -1))).toBe(true)
    expect(columns(cut)).toBeLessThanOrEqual(cols - 6)
    expect((await ui.find({ type: 'Text', text: '這是一題' }))?.props.wrap).toBe('truncate-end')
    const before = await layout(ui)
    await ui.unmount()
    w.focus = withQuestion(shortQ)
    await clock.advance(5_000)
    const short = await $.ui.mount({ ...band(cols, 20), surface: 'terminal' })
    expect((await short.find({ key: 'question' }))?.text).toBe(shortQ)
    expect(await layout(short)).toEqual(before)
    await short.unmount()
  }
})

const withAdvice = (advice: any, tag = 'focusui') => ({ ...focusOf(tag, ['logging']), sessions: SESSIONS.map(s => (s.tag === tag ? { ...s, advice } : s)) })
const READY = { state: 'ready', text: '建議：b，兩邊都改才一致', answer: 'b', reason: '兩邊都改才一致', principle: null }
const rowKeys = async (ui: any) => (await ui.drawn()).children.filter((c: any) => typeof c !== 'string').map((c: any) => (c.children ?? []).map((x: any) => x?.props?.key).find((k: any) => k === 'question' || k === 'advice') ?? c.props?.key ?? null)

test('band advice: 建議產生中… under the question while the advisor runs, then 建議：<答案>，<理由> on the next poll; the keys row stays below', async ($, on) => {
  const w = world(withAdvice({ state: 'pending', text: '建議產生中…' }))
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(textOf(await ui.find({ key: 'advice' }))).toBe('建議產生中…')
  expect(paintOf(await ui.drawn(), '建議產生中…')?.color).toBe(THEMES.neutral.dim)
  expect(await rowKeys(ui)).toEqual([null, null, 'question', 'advice', 'keys', null])
  await ui.unmount()
  w.focus = withAdvice(READY)
  await clock.advance(5_000)
  const ready = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(textOf(await ready.find({ key: 'advice' }))).toBe('建議：b 橫條也改清單，兩邊都改才一致')
  const root = await ready.drawn()
  expect(paintOf(root, '建議：')?.color).toBe(THEMES.neutral.accent)
  expect(paintOf(root, 'b')).toMatchObject({ bold: true })
  expect(paintOf(root, ' 橫條也改清單')?.bold).toBeFalsy()
  await ready.unmount()
})

test('band advice: no row when the prediction failed, for 🔐 or when nothing was predicted; the band keeps its old shape', async ($, on) => {
  const w = world(withAdvice(null))
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await ui.find({ key: 'advice' })).toBeUndefined()
  expect(await rowKeys(ui)).toEqual([null, null, 'question', 'keys', null])
  await ui.unmount()
  w.focus = withAdvice(READY, 'perm')
  w.focus.sessions = w.focus.sessions.map((s: any) => (s.tag === 'perm' ? { ...s, advice: null } : s))
  w.focus.current = keyOf('perm')
  await clock.advance(5_000)
  const perm = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await perm.find({ key: 'advice' })).toBeUndefined()
  await perm.unmount()
})

test('band advice: a principle question says its class in the waiting colour; a long reason is cut first with … and the answer, its option and the class stay', async ($, on) => {
  const w = world(withAdvice({ ...READY, text: '建議：b，兩邊都改才一致（原則性：產品行為與 UX）', principle: '產品行為與 UX' }))
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(textOf(await ui.find({ key: 'advice' }))).toBe('建議：b 橫條也改清單，兩邊都改才一致（原則性：產品行為與 UX）')
  expect(paintOf(await ui.drawn(), '（原則性：產品行為與 UX）')?.color).toBe(THEMES.neutral.waiting)
  await ui.unmount()
  const reason = '這個理由寫得非常非常長，'.repeat(10)
  w.focus = withAdvice({ ...READY, text: `建議：b，${reason}`, reason, principle: '不可逆或對外動作' })
  await clock.advance(5_000)
  for (const cols of [120, 60]) {
    const cut = await $.ui.mount({ ...band(cols, 20), surface: 'terminal' })
    const text = textOf(await cut.find({ key: 'advice' }))
    expect(text.slice(0, 13)).toBe('建議：b 橫條也改清單，這')
    expect(text.slice(-15)).toBe('…（原則性：不可逆或對外動作）')
    expect(columns(text)).toBeLessThanOrEqual(cols - 6)
    await cut.unmount()
  }
  const narrow = await $.ui.mount({ ...band(40, 20), surface: 'terminal' })
  const tight = textOf(await narrow.find({ key: 'advice' }))
  expect(tight.slice(0, 4)).toBe('建議：b')
  expect(columns(tight)).toBeLessThanOrEqual(34)
  await narrow.unmount()
  expect(focusBandRows({ cols: 80, maxRows: 4, question: 'q', queue: [], hiddenCount: 0, advice: READY as any }).advice).toBe(0)
  const exact = focusBandRows({ cols: 29, maxRows: 20, question: 'q', queue: [], hiddenCount: 0, advice: { ...READY, answer: 'b', reason: '一二三四五六七' } as any })
  expect(exact.adviceParts.map(p => p.text).join('')).toBe('建議：b，一二三四五六七')
  const longOption = '兩個通知下拉選單底部都加「通知設定」'
  const roomy = focusBandRows({ cols: 110, maxRows: 20, question: 'q', queue: [], hiddenCount: 0, options: [longOption, '開關'], advice: { ...READY, answer: 'a', reason: '一鍵到設定頁最順手' } as any })
  expect(roomy.adviceParts.map(p => p.text).join('')).toBe(`建議：a ${longOption}，一鍵到設定頁最順手`)
  const bare = focusBandRows({ cols: 80, maxRows: 20, question: 'q', queue: [], hiddenCount: 0, advice: { ...READY, answer: '先跑測試', reason: '' } as any })
  expect(bare.adviceParts.map(p => p.text).join('')).toBe('建議：先跑測試')
})

test('band keys: 1–5 switch to that question and print it, 8 (延後處理) sends it behind the queue and prints the next, 9 (顯示問題) prints the one on screen, 0 opens the pane with the keyboard', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  await ui.press({ key: 'queue:2' })
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('PROJ-6668')])
  expect(w.shown).toEqual(['PROJ-6668'])
  expect(w.writes[`${HOME}/show/PROJ-6668.md`]).toContain('### 💬 PROJ-6668 等你回應')
  expect(await labels(ui)).toEqual(['8: 延後處理', '9: 顯示問題', '1: perm', '2: focusui', '3: logging', '4: upgrade#2', '0: 面板'])
  await ui.press({ key: 'later' })
  expect(w.calls.at(-1)).toEqual(['focus-later'])
  expect(w.shown.at(-1)).toBe('perm')
  expect(await labels(ui)).toEqual(['8: 延後處理', '9: 顯示問題', '1: focusui', '2: logging', '3: upgrade#2', '4: PROJ-6668', '0: 面板'])
  await ui.press({ key: 'queue:3' })
  expect((await ui.find({ key: 'band-name' }))?.text).toBe('PROJ-6668')
  expect((await ui.find({ key: 'show' }))?.props).toMatchObject({ hotkey: '9', label: '顯示問題' })
  expect(await labels(ui)).not.toContain('9: 題目')
  await ui.press({ key: 'show' })
  await ui.press({ key: 'show' })
  expect(w.shown.slice(-2)).toEqual(Array(2).fill(`PROJ-6668 ${idOf(keyOf('PROJ-6668'))}`))
  expect(w.writes[`${HOME}/show/PROJ-6668.md`]).toBe(SESSIONS.find(s => s.tag === 'PROJ-6668')!.report)
  await ui.press({ key: 'pane' })
  expect(w.opened.at(-1)).toMatchObject({ id: PANE, focus: true })
  await ui.unmount()
})

test('a new question elsewhere: the band keeps its question, the queue grows with ✨, a toast says so and nothing reaches the conversation', async ($, on) => {
  const w = world(focusOf('perm', ['focusui']))
  const clock = await start($, on, w)
  expect(w.toasts).toEqual([])
  w.focus = { ...focusOf('perm', ['focusui', 'logging']), stats: STATS.replace('等待回應 3', '等待回應 4') }
  w.focus.queue[1].isNew = true
  await clock.advance(5_000)
  expect(w.toasts).toEqual(['logging 進排隊：照建議在真實中控台驗過了嗎？'])
  expect(w.shown).toEqual([])
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect((await ui.find({ key: 'band-name' }))?.text).toBe('perm')
  expect(await labels(ui)).toContain('2: logging ✨')
  await ui.unmount()
  await clock.advance(5_000)
  expect(w.toasts).toHaveLength(1)
})

test('the question on screen changing by itself is printed once through /focus-show, never through the model', async ($, on) => {
  const w = world({ ...focusOf('perm', ['focusui']), announce: 'perm' })
  const clock = await start($, on, w)
  expect(w.shown).toEqual(['perm'])
  await clock.advance(5_000)
  expect(w.shown).toEqual(['perm'])
  w.focus = { ...focusOf('focusui', []), announce: 'focusui' }
  await clock.advance(5_000)
  expect(w.shown).toEqual(['perm', 'focusui'])
  expect(w.writes[`${HOME}/show/focusui.md`]).toContain('### 💬 focusui 等你回應')
})

test('an announce is printed once though polls repeat it, then reported with focus-shown; the poll carries the session id', async ($, on) => {
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true }
  const clock = await start($, on, w)
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
  const [first, ...rest] = w.calls.filter(c => c[0] === 'focus')
  expect(first!.slice(1)).toEqual(['--session', 'console-session', '--owner', 'console-session@1000', '--claim'])
  expect(rest[0]!.slice(1)).toEqual(['--session', 'console-session', '--owner', 'console-session@1000'])
})

test('a stop that left the band and came back is announced again, so a print skipped while it was away is not lost', async ($, on) => {
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true }
  const clock = await start($, on, w)
  w.focus = { ...focusOf('focusui', ['perm']), announce: 'focusui', announceKey: keyOf('focusui') }
  await clock.advance(5_000)
  w.focus = { ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }
  await clock.advance(5_000)
  await clock.advance(5_000)
  const id = idOf(keyOf('perm'))
  expect(w.shown).toEqual([`perm ${id}`, `focusui ${idOf(keyOf('focusui'))}`, `perm ${id}`])
})

test('an announced stop is printed with its id from a file of its own, and the plain 代號 file stays fresh for a hand-typed /focus-show', async ($, on) => {
  const w = world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') })
  await start($, on, w)
  const id = idOf(keyOf('perm'))
  expect(w.shown).toEqual([`perm ${id}`])
  expect(w.writes[`${HOME}/show/perm@${id}.md`]).toBe(SESSIONS.find(s => s.tag === 'perm')!.report)
  expect(w.writes[`${HOME}/show/perm.md`]).toBe(SESSIONS.find(s => s.tag === 'perm')!.report)
})

test('漏印重送: a /focus-show the console drops (it answers without the report) is not reported as shown and goes again on the next poll; printed once, then focus-shown once', async ($, on) => {
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, lost: 1 }
  const clock = await start($, on, w)
  const id = idOf(keyOf('perm'))
  expect(w.dropped).toEqual([`perm ${id}`])
  expect(w.shown).toEqual([])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([])
  await clock.advance(5_000)
  expect(w.shown).toEqual([`perm ${id}`])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(w.shown).toEqual([`perm ${id}`])
  expect(w.toasts).toEqual([])
})

test('漏印重送: three misses in a row toast 「[perm] 題目沒印出，按 9 印」 once; it keeps trying and prints once the console takes it', async ($, on) => {
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, lost: 4 }
  const clock = await start($, on, w)
  const id = idOf(keyOf('perm'))
  await clock.advance(5_000)
  expect(w.toasts).toEqual([])
  await clock.advance(5_000)
  expect(w.toasts).toEqual(['[perm] 題目沒印出，按 9 印'])
  await clock.advance(5_000)
  expect(w.toasts).toEqual(['[perm] 題目沒印出，按 9 印'])
  expect(w.shown).toEqual([])
  await clock.advance(5_000)
  expect(w.dropped).toEqual(Array(4).fill(`perm ${id}`))
  expect(w.shown).toEqual([`perm ${id}`])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
  await clock.advance(5_000)
  expect(w.shown).toEqual([`perm ${id}`])
})

test('漏印重送: after the toast, d on the card and 印出完整回報 print the question and reports it shown, so the next poll does not print it again', async ($, on) => {
  const lone = { ...world({ ...focusOf('perm', []), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, lost: 3 }
  const clock = await start($, on, lone)
  const id = idOf(keyOf('perm'))
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(lone.toasts).toEqual(['[perm] 題目沒印出，按 9 印'])
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await printFromBrief($, ui, keyOf('perm'))
  expect(lone.shown).toEqual([`perm ${id}`])
  expect(lone.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
  await ui.unmount()
  lone.focus = { ...lone.focus, announce: null, announceKey: null }
  await clock.advance(5_000)
  expect(lone.shown).toEqual([`perm ${id}`])
})

test('漏印重送: a rejected /focus-show is never reported as shown; it is tried every poll and after 3 tries the toast says focus-show is missing', async ($, on) => {
  const w = { ...world({ ...focusOf('perm', []), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, showFails: true }
  const clock = await start($, on, w)
  await clock.advance(5_000)
  expect(w.toasts).toEqual([])
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(w.toasts).toEqual(['印不出題目：需要另外安裝 focus-show'])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([])
})

for (const skip of ['[perm] 這題已不在橫條上，略過', '[perm] 這題已回覆或已交棒，略過']) {
  test(`漏印重送（回略過不重送）: a /focus-show answering 「${skip}」 is not reported as shown and goes again on the next poll; printed once, then focus-shown once`, async ($, on) => {
    const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, skips: [skip] }
    const clock = await start($, on, w)
    const id = idOf(keyOf('perm'))
    expect(w.shown).toEqual([`perm ${id}`])
    expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([])
    expect(JSON.parse(w.writes[`${HOME}/focus-show-debug.jsonl`]!.trim().split('\n').at(-1)!)).toMatchObject({ key: keyOf('perm'), id, turning: false, answer: skip })
    await clock.advance(5_000)
    expect(w.shown).toEqual([`perm ${id}`, `perm ${id}`])
    expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
    await clock.advance(5_000)
    await clock.advance(5_000)
    expect(w.shown).toHaveLength(2)
    expect(w.toasts).toEqual([])
  })
}

test('漏印重送: three 略過 answers in a row toast 「[perm] 題目沒印出，按 9 印」 once and stop sending it by itself; 9 still prints it and reports it shown', async ($, on) => {
  const skip = '[perm] 這題已不在橫條上，略過'
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, skips: [skip, skip, skip] }
  const clock = await start($, on, w)
  const id = idOf(keyOf('perm'))
  await clock.advance(5_000)
  expect(w.toasts).toEqual([])
  await clock.advance(5_000)
  expect(w.toasts).toEqual(['[perm] 題目沒印出，按 9 印'])
  for (let i = 0; i < 3; i++) await clock.advance(5_000)
  expect(w.shown).toEqual(Array(3).fill(`perm ${id}`))
  expect(w.toasts).toEqual(['[perm] 題目沒印出，按 9 印'])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([])
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  await ui.press({ key: 'show' })
  await ui.unmount()
  expect(w.shown).toEqual(Array(4).fill(`perm ${id}`))
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
})

test('漏印重送: the report coming back between 略過 answers resets the count, so two more misses after it do not toast', async ($, on) => {
  const skip = '[perm] 這題已不在橫條上，略過'
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, skips: [skip, skip] }
  const clock = await start($, on, w)
  const id = idOf(keyOf('perm'))
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(w.shown).toEqual(Array(3).fill(`perm ${id}`))
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
  w.skips = [skip, skip]
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  await ui.press({ key: 'show' })
  await ui.press({ key: 'show' })
  await ui.unmount()
  expect(w.shown).toEqual(Array(5).fill(`perm ${id}`))
  expect(w.toasts).toEqual([])
})

test('a /focus-show that cannot read focus.json\'s format answers one line: polls never send it again, and it is not reported as shown', async ($, on) => {
  const answer = '[perm] 印不出題目：focus-show 太舊，不認得這個檔案格式，請更新 focus-show'
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, answer }
  const clock = await start($, on, w)
  for (let i = 0; i < 4; i++) await clock.advance(5_000)
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([])
  expect(w.toasts).toEqual([])
})

test('漏印重送: 回完答案後 60 秒內同一 session 又出題 while the console is still on its turn; /focus-show <代號> <編號> of the new stop is sent again and printed once', async ($, on) => {
  const first = focusOf('perm', ['focusui'])
  const w = { ...world({ ...first, announce: 'perm', announceKey: keyOf('perm') }), sticky: true }
  const clock = await start($, on, w)
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  w.focus = { ...first, current: null, waiting: { tag: 'perm', seconds: 60 }, announce: null, announceKey: null }
  await clock.advance(5_000)
  const next = 'perm@2'
  const report = '### 🔐 perm 等你授權\n\n> Bash rm -rf dist'
  const sessions = SESSIONS.map(s => (s.tag === 'perm' ? { ...s, key: next, id: idOf(next), question: 'Bash rm -rf dist', report } : s))
  w.focus = { ...first, current: next, sessions, waiting: null, announce: 'perm', announceKey: next }
  w.lost = 1
  await clock.advance(5_000)
  expect(w.dropped).toEqual([`perm ${idOf(next)}`])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`, `perm ${idOf(next)}`])
  expect(w.writes[`${HOME}/show/perm@${idOf(next)}.md`]).toBe(report)
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')], ['focus-shown', next]])
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

test('cards: number (none on the question on screen) and nickname button, status icon and word, the repo on the right and no stage on any tab; the question in grey, no options; summary, never 建議; no frame and no rail: the status colour sits on the status icon, the chosen card leads with an accent ✻ mark and its name in the accent', async ($, on) => {
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
    expect(first?.text).toContain('展示 mod 的樣式要套在哪裡？')
    expect(first?.text).not.toMatch(/a\. |只套面板|橫條也改清單/)
    expect(first?.text).not.toContain('建議：')
    expect(first?.text).toContain('feat/focusui')
    expect(first?.text).toContain('◆ 待回答')
    expect(first?.text).toContain('agent-skills')
    expect(first?.text).not.toContain('規劃中')
    expect(first?.text).not.toMatch(/💬|🔐|⏸/)
    expect((await ui.find({ type: 'Text', text: '展示 mod' }))?.props).toMatchObject({ color: THEMES.neutral.dim, wrap: 'truncate-end' })
    expect((await ui.find({ type: 'Text', text: '展示 mod' }))?.props.bold).toBeFalsy()
    expect(await ui.find({ key: `num:${keyOf('focusui')}` })).toBeUndefined()
    expect((await ui.find({ key: `num:${keyOf('perm')}` }))?.props).toMatchObject({ hotkey: '1', label: '', plain: true })
    expect((await ui.find({ key: `name:${keyOf('focusui')}` }))?.props).toMatchObject({ label: 'focusui', plain: true })
    expect((await ui.find({ key: `name:${keyOf('focusui')}` }))?.props.hotkey).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: 'Bash rm' }))?.props).toMatchObject({ color: THEMES.neutral.dim })
    expect((await ui.find({ type: 'Text', text: 'Bash rm' }))?.props.bold).toBeFalsy()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.press({ key: 'tab:all' })
    const permCell = statusCell('等待授權', 0)
    const icon = findKey(await ui.drawn(), `status:${keyOf('perm')}`).children[0]
    expect([textOf(icon), icon.props.color]).toEqual([permCell.glyph, THEMES.neutral[permCell.glyphColor]])
    expect((await ui.find({ key: `card-head:${keyOf('focusui')}` }))?.text).toContain('agent-skills')
    expect((await ui.find({ key: `card:${keyOf('focusui')}` }))?.text).not.toContain('規劃中')
    await ui.press({ key: 'tab:pending' })
    await ui.unmount()
  }
})

const findKey = (node: any, key: string): any => (node?.props?.key === key ? node : (node?.children ?? []).map((c: any) => (typeof c === 'object' ? findKey(c, key) : null)).find(Boolean))
const textOf = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))

test('cards on 待回覆, 全部 (idle ones too) and 封存: no frame, a header row and one grey question row with the summary on its right, a blank row above; a long or multi-line question is cut with … and never wraps; options never show', async ($, on) => {
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
      const q = findKey(box, `question:${keyOf(tag)}`).children[1]
      expect(q.type).toBe('Text')
      expect(q.props).toMatchObject({ color: THEMES.neutral.dim, wrap: 'truncate-end' })
      expect(q.props.bold).toBeFalsy()
      const line = textOf(q)
      expect(line.startsWith('這是一個非常長的題目')).toBe(true)
      expect(line.endsWith('…')).toBe(true)
      expect(line).not.toContain('\n')
      // The rail, the number column, the summary and the 2 cells before it share the row.
      const room = cols - 4 - 3 - cells(`feat/${tag}`) - 2
      expect(cells(line)).toBeLessThanOrEqual(room)
      expect(cells(line)).toBeGreaterThan(room - 2)
      expect(textOf(findKey(box, `summary:${keyOf(tag)}`))).toBe(`feat/${tag}`)
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
// The header row as a terminal lays it out: the mark, the left part, the space-between gap, the right part.
const headerOf = async (ui: any, key: string) => {
  const root = await ui.drawn()
  const top = findKey(root, `card-top:${key}`)
  const [left, right] = top.children
  const repo = right ? findKey(right, `card-repo:${key}`) : undefined
  return { top, left, right, repo, gap: top.props.width - widthOf(left) - (right ? widthOf(right) : 0), repoText: repo ? textOf(repo) : '' }
}

for (const name of ['neutral', 'dracula'] as const) {
  test(`卡片 repo（${name}）：待回覆、全部、封存的卡片第一行右端都有 repo，主題淡色加 dimColor，文字右端貼齊標題列右端、短 repo 左邊補空白；不顯示階段；待決卡片不放 repo`, async ($, on) => {
    const w = world({ ...withDecisions(), current: keyOf('focusui'), queue: ['perm', 'logging', 'PROJ-6668', 'upgrade#2'].map(t => ({ key: keyOf(t), isNew: false })), sessions: SESSIONS })
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
          const h = await headerOf(ui, r.key)
          expect(h.top.props).toMatchObject({ width: cols - 4, justifyContent: 'space-between' })
          expect(h.right.children.at(-1).props.key).toBe(`card-repo:${r.key}`)
          expect(cells(h.repoText)).toBe(h.repo.props.width)
          if (cells(r.repo) < h.repo.props.width) expect(h.repoText).toBe(`${' '.repeat(h.repo.props.width - cells(r.repo))}${r.repo}`)
          expect(r.repo.startsWith(h.repoText.trimStart().replace(/…$/, ''))).toBe(true)
          const repo = h.repo.children[0]
          expect([repo.type, repo.props.color, repo.props.dimColor, repo.props.bold]).toEqual(['Text', theme.dim, true, undefined])
        }
      }
      await ui.press({ key: 'tab:decisions' })
      const root = await ui.drawn()
      expect(textOf(root)).not.toMatch(/實作中|規劃中|已推送/)
      for (const d of DECISIONS) {
        expect(textOf(findKey(root, `decision-head:${d.id}`))).not.toContain(d.repo)
        expect(findKey(root, `card-repo:${d.key}`)).toBeUndefined()
      }
      await ui.press({ key: 'tab:pending' })
      await ui.unmount()
    }
  })
}

test('卡片 repo 寬度＝標題列寬 − 代號前面各欄 − 代號 − 2 格間距 − ✓ 建議；面板越寬 repo 顯示越長，不按這一頁最長的 repo 留寬，也沒有 14／8 格上限', async ($, on) => {
  const repos = { perm: { repo: 'proj-agents-configuration' }, focusui: { repo: 'ab' }, logging: { repo: 'sara-v2-frontend', advice: { state: 'ready', text: '', answer: 'a', reason: '' } }, 'PROJ-6668': { repo: 'sara-v2-frontend' }, 'upgrade#2': { repo: '中控台中控台中控台中控台' } }
  const w = world(withRepos(repos))
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const shown = w.focus.sessions.filter((x: Card) => x.pending && x.key !== keyOf('chart'))
  const seen: Record<string, number[]> = {}
  for (const cols of [36, 40, 46, 60, 80, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    for (const r of shown) {
      const h = await headerOf(ui, r.key)
      const tag = (await ui.find({ key: `name:${r.key}` }))!.props.label as string
      const hint = (r as any).advice ? (cols >= 46 ? 7 : 2) : 0
      expect(h.repo.props.width).toBe(cols - 4 - 13 - cells(tag) - 2 - hint)
      expect(h.gap).toBe(2)
      ;(seen[r.tag] ??= []).push(h.repo.props.width)
      const text = h.repoText.trimStart()
      if (cells(r.repo) <= h.repo.props.width) expect(text).toBe(r.repo)
      else expect([text.endsWith('…'), r.repo.startsWith(text.slice(0, -1)), cells(text) <= h.repo.props.width]).toEqual([true, true, true])
    }
    // 'ab' and the 25-cell repo sit behind 代號 of one width, so they get one width: the tab's longest repo sets nothing.
    expect((await headerOf(ui, keyOf('perm'))).repo.props.width).toBe((await headerOf(ui, keyOf('focusui'))).repo.props.width + cells('focusui') - cells('perm'))
    await ui.unmount()
  }
  for (const list of Object.values(seen)) for (let i = 1; i < list.length; i++) expect(list[i]!).toBeGreaterThan(list[i - 1]!)
  expect(seen['perm']!.at(-1)).toBeGreaterThan(14)
})

test('卡片 repo：46 欄以上、代號 9 格（PROJ-6668）、沒有 ✓ 建議時 sara-v2-frontend（16 格）完整顯示；36 欄時 repo 至少 8 格', async ($, on) => {
  const w = world(withRepos({ 'PROJ-6668': { repo: 'sara-v2-frontend' } }))
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  for (const cols of [46, 50, 70]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    expect((await ui.find({ key: `name:${keyOf('PROJ-6668')}` }))!.props.label).toBe('PROJ-6668')
    const h = await headerOf(ui, keyOf('PROJ-6668'))
    expect(h.repoText.trimStart()).toBe('sara-v2-frontend')
    expect(h.repoText).not.toContain('…')
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...pane(36), surface: 'terminal' })
  const h = await headerOf(ui, keyOf('PROJ-6668'))
  expect(h.repo.props.width).toBeGreaterThanOrEqual(8)
  expect(h.repoText.trimStart()).toBe('sara-v2…')
  await ui.unmount()
})

for (const tabKey of ['tab:pending', 'tab:all', 'tab:hidden'] as const) {
  test(`卡片 repo（${tabKey.slice(4)}）：代號太長時 repo 仍留 8 格、代號以 … 截短，代號與 repo 之間固定 2 格；標題列永遠一行、不超出面板`, async ($, on) => {
    const huge = 'x'.repeat(60)
    const hidden = tabKey === 'tab:hidden'
    const sessions = [
      card(huge, { repo: 'proj-agents-configuration', archived: hidden, pending: !hidden, advice: { state: 'ready', text: '', answer: 'a', reason: '' } } as any),
      card('PROJ-6668-very-long-name', { repo: 'sara-v2-frontend', archived: hidden, pending: !hidden }),
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
        // 取消封存 can leave 封存 no room for 8 cells of repo and 4 of 代號: the 代號 keeps 4, the repo still shows in the rest.
        const hint = (r as any).advice ? (cols >= 46 ? 7 : 2) : 0
        const room = cols - 4 - 23 - 2 - hint
        expect(h.gap).toBe(2)
        expect(h.repo).toBeDefined()
        if (hidden && room - 8 < 4) {
          expect(cells(tagText)).toBe(4)
          expect(h.repo.props.width).toBe(room - 4)
          expect(r.repo.startsWith(h.repoText.trimStart().replace(/…$/, ''))).toBe(true)
          continue
        }
        expect(widthOf(h.left) + 2 + widthOf(h.right)).toBe(cols - 4)
        if (r.tag === huge || cols < 60) {
          expect(h.repo.props.width).toBe(8)
          expect(tagText.endsWith('…')).toBe(true)
          expect(r.tag.startsWith(tagText.slice(0, -1))).toBe(true)
        }
        expect(cells(h.repoText)).toBe(h.repo.props.width)
        expect(r.repo.startsWith(h.repoText.trimStart().replace(/…$/, ''))).toBe(true)
      }
      await ui.unmount()
    }
  })
}

test('待回覆卡片深淺：文字中只有代號是前景色粗體（選中時強調色粗體），狀態照原狀態色；repo、題目、右側標題都是淡色，右側標題開頭的數字也淡；不顯示階段；✓ 建議照舊強調色', async ($, on) => {
  const extra = { perm: { summary: '12 未核對項目', advice: { state: 'ready', text: '', answer: 'a', reason: '照前例' } } }
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
    walk(findKey(root, `card-question:${r.key}`))
    expect(runs.every(x => x.color === theme.dim && !x.bold)).toBe(true)
  }
  for (const r of rows) expect(findKey(root, `stage:${r.key}`)).toBeUndefined()
  expect(textOf(root)).not.toMatch(/實作中|規劃中|已推送/)
  expect(textOf(findKey(root, `summary:${keyOf('perm')}`))).toBe('12 未核對項目')
  expect(paintOf(root, '12 未核對項目')?.color).toBe(theme.dim)
  expect((await ui.find({ type: 'Text', text: '✓' }))?.props.color).toBe(theme.accent)
  expect((await ui.find({ type: 'Text', text: ' 建議' }))?.props.color).toBe(theme.dim)
  await ui.unmount()
})

test('卡片左邊留白：選中標記前多一格，沒選中的卡與第二行一起往右 1 欄；待回覆、全部、封存、待決都一樣，repo 與待決分組標題線不動', async ($, on) => {
  const w = world({ ...withDecisions(), sessions: SESSIONS })
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
  for (const [tabKey, prefix, rule] of [['tab:pending', 'card:', null], ['tab:all', 'card:', 'repo:'], ['tab:hidden', 'card:', 'repo:'], ['tab:decisions', 'decision:', 'decide-group:']] as const) {
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

for (const decide of [false, true]) {
  test(`分頁列平均分散（${decide ? '四' : '三'}個分頁）：justifyContent space-between 排滿整行，第一個貼左、最後一個貼右；粗線落在所選分頁正下方、寬度等於標籤；不足 46 欄時沒選的只留按鍵與數字、仍是一列`, async ($, on) => {
    const w = world(decide ? withDecisions() : pending())
    appearanceConfig.set(w, { motion: false })
    await start($, on, w)
    await openPane($)
    for (const cols of [36, 45, 46, 80, 101]) {
      const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
      const row = await ui.find({ key: 'tabs' })
      expect([row?.props.justifyContent, row?.props.columnGap, row?.props.height, row?.props.flexWrap]).toEqual(['space-between', undefined, 1, undefined])
      const tabs = (await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('tab:'))
      expect(tabs).toHaveLength(decide ? 4 : 3)
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

test('more than 10 cards on 待回覆: all drawn, the question on screen unnumbered, the queue 1–9 and 0, none after; arrows reach the 11th and 印出完整回報 switches to it and prints it', async ($, on) => {
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
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('t10')])
  expect(w.shown.at(-1)).toBe('t10')
  await ui.unmount()
})

test('on 待回覆 a number switches the band to that card and the pane reorders with it; the card then has no number; d, then 印出完整回報, prints it again', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  expect((await ui.find({ key: `card:${keyOf('perm')}` }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  expect((await ui.find({ key: `num:${keyOf('PROJ-6668')}` }))?.props.hotkey).toBe('3')
  await ui.press({ key: `num:${keyOf('PROJ-6668')}` })
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('PROJ-6668')])
  expect(w.shown).toEqual(['PROJ-6668'])
  expect(await cardTags(ui)).toEqual(['PROJ-6668', 'perm', 'focusui', 'logging', 'upgrade#2'])
  expect(await ui.find({ key: `num:${keyOf('PROJ-6668')}` })).toBeUndefined()
  expect((await ui.find({ key: `num:${keyOf('perm')}` }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: `card:${keyOf('PROJ-6668')}` }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toHaveLength(1)
  await printFromBrief($, ui, keyOf('PROJ-6668'))
  expect(w.shown).toEqual(['PROJ-6668', `PROJ-6668 ${idOf(keyOf('PROJ-6668'))}`])
  await ui.unmount()
})

test('the pane follows the band while it is open: a switch, a defer or a new question on the band reorders 待回覆 at once', async ($, on) => {
  const w = world(pending())
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const b = await $.ui.mount({ ...band(), surface: 'terminal' })
  await b.press({ key: 'queue:1' })
  expect(await cardTags(ui)).toEqual(['logging', 'perm', 'focusui', 'PROJ-6668', 'upgrade#2'])
  await b.press({ key: 'later' })
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'PROJ-6668', 'upgrade#2', 'logging'])
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

test('on the other tabs a number only chooses the card, d then 印出完整回報 prints it; a card that also waits on you switches the band', async ($, on) => {
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
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('logging')])
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
  expect(w.calls.at(-1)).toEqual(['focus', '--session', 'console-session', '--owner', 'console-session@1000'])
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
const nothing = () => ({ active: true, home: HOME, current: null, announce: null, waiting: { tag: 'perm', seconds: 3 }, queue: [], stats: STATS, sessions: [] })
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

test('card summary on 待回覆: the summary sits right of the question in the theme dim colour, never the repo or 建議; the repo sits on the header row', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(paintOf(await ui.drawn(), 'feat/perm')?.color).toBe(THEMES.neutral.dim)
  for (const r of pending().sessions.filter(x => x.pending)) {
    const text = (await ui.find({ key: `card-question:${r.key}` }))?.text ?? ''
    expect(text).toContain((await ui.find({ key: `summary:${r.key}` }))!.text)
    expect(text).not.toContain(r.repo)
    expect(text).not.toContain('建議：')
  }
  await ui.unmount()
})

const cardWidth = (t: string) => [...t].reduce((n, c) => n + (c.codePointAt(0)! > 0x2e80 ? 2 : 1), 0)
const summaryOf = async (ui: any, tag: string) => (await ui.find({ key: `summary:${keyOf(tag)}` }))?.text

test('卡片寬度: the bottom right is cut at 20 columns ending in …; 專案檢視介面調整建議 (exactly 20) is shown whole', async ($, on) => {
  const w = world(withRepos({ perm: { summary: '專案檢視介面調整建議' }, focusui: { summary: '專案檢視介面調整建議與後續' }, logging: { summary: 'feat/backend-api-request-comment' } }))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await summaryOf(ui, 'perm')).toBe('專案檢視介面調整建議')
  expect(await summaryOf(ui, 'focusui')).toBe('專案檢視介面調整建…')
  expect(await summaryOf(ui, 'logging')).toBe('feat/backend-api-re…')
  expect(await summaryOf(ui, 'PROJ-6668')).toBe('[FE] 專案檢視介面調…')
  for (const tag of ['focusui', 'logging', 'PROJ-6668']) expect(cardWidth((await summaryOf(ui, tag))!)).toBeLessThanOrEqual(20)
  await ui.unmount()
})

test('卡片寬度: the question row holds the question, 2 cells, then the summary inside the pane at every width; a narrow pane cuts the summary to 15', async ($, on) => {
  const w = world(withRepos({ perm: { repo: 'proj-agents-configuration', summary: '專案檢視介面調整建議' }, 'upgrade#2': { repo: 'abcdefghijklmnopqrst' }, logging: { repo: '中控台中控台中控台中控台' } }))
  await start($, on, w)
  await openPane($)
  let ui = await $.ui.mount({ ...pane(36), surface: 'terminal' })
  expect(await summaryOf(ui, 'perm')).toBe('專案檢視介面調…')
  await ui.unmount()
  for (const cols of [36, 40, 45, 46, 52, 70, 120]) {
    ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    for (const r of w.focus.sessions.filter((x: Card) => x.pending)) {
      const question = textOf(findKey(await ui.drawn(), `question:${r.key}`)).trim()
      const right = (await summaryOf(ui, r.tag))!
      expect(cardWidth(right)).toBeLessThanOrEqual(Math.min(20, cols - 6))
      expect(3 + cardWidth(question) + 2 + cardWidth(right)).toBeLessThanOrEqual(cols - 4)
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
      // The rail and the right margin, the number and status columns, the stage on the right from 46 columns.
      const room = cols - 3 - 13 - (cols >= 46 ? 7 : 0)
      if (r.tag === long) expect(cardWidth(long) <= room ? label === long : label.endsWith('…') && long.startsWith(label.slice(0, -1))).toBe(true)
      expect(cardWidth(label)).toBeLessThanOrEqual(room)
    }
    await ui.unmount()
  }
})

test('cards on 全部 and 封存 show their repo on the header row and never the stage (規劃中, 實作中, 已推送) or 建議：, at any width', async ($, on) => {
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
    // 取消封存 takes 10 cells: below 46 columns the row cannot hold 8 cells of repo and 4 of 代號, so the 代號 keeps 4 and the repo the rest.
    expect((await ui.find({ key: `card-repo:${keyOf('PROJ-6650')}` }))?.text.trimStart()).toMatch(cols >= 46 ? /^proj-v2/ : /^pr…$/)
    if (cols < 46) expect((await ui.find({ key: `card-head:${keyOf('PROJ-6650')}` }))?.text).toContain('PRO…')
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

for (const tabKey of ['tab:pending', 'tab:all', 'tab:hidden'] as const) for (const batch of [false, true]) {
  test(`按鍵說明（${tabKey.slice(4)}${batch ? '，待決打開' : ''}）：補滿整行、文字置中，前後用 ─ 夾住、兩邊至少各 2 個；太窄時先截說明文字；待決底下的說明不變`, async ($, on) => {
    {
      const w = world(batch ? withDecisions() : pending())
      appearanceConfig.set(w, { motion: false })
      await start($, on, w)
      await openPane($)
      const keys = batch ? 'qwer 切分頁 · 1-9,0/↑↓ 選卡片' : 'qwe 切分頁 · 1-9,0/↑↓ 選卡片'
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
      if (batch) {
        const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
        await ui.press({ key: 'tab:decisions' })
        expect((await ui.find({ key: 'decide-footer' }))?.text).toBe('Enter 詳情 · y 核可 · m 自己回 · a 全部核可 · qwer 切分頁')
        expect((await ui.find({ key: 'decide-footer' }))?.text).not.toContain('─')
        expect((await ui.find({ key: 'decide-footer' }))?.props.paddingLeft).toBe(1)
        await ui.unmount()
      }
    }
  })
}

test('待回覆 numbers: the question on screen has none; the queue is 1, 2, … in order, the first 5 the same session as the band, and the same number picks the same session in the pane and on the band', async ($, on) => {
  const many = queued(7)
  const start0 = { ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] }
  const w = world(start0)
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const b = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ key: `num:${keyOf('perm')}` })).toBeUndefined()
  const paneNums = (await ui.findAll({ type: 'Button' })).filter((x: any) => x.key.startsWith('num:')).map((x: any) => [x.props.hotkey, x.key.slice(4)])
  expect(paneNums).toEqual(many.map((c, i) => [String(i + 1), c.key]))
  const bandNums = (await b.findAll({ type: 'Button' })).filter((x: any) => x.key.startsWith('queue:')).map((x: any) => [x.props.hotkey, keyOf(x.props.label)])
  expect(bandNums).toEqual(paneNums.slice(0, 5))
  for (const n of [1, 3, 5]) {
    const paneKey = paneNums[n - 1]![1]
    await ui.press({ key: `num:${paneKey}` })
    const fromPane = w.calls.at(-1)
    w.focus = start0
    await clock.advance(5_000)
    await b.press({ key: `queue:${n - 1}` })
    const fromBand = w.calls.at(-1)
    expect(fromPane).toEqual(['focus-pick', paneKey])
    expect(fromBand).toEqual(fromPane)
    w.focus = start0
    await clock.advance(5_000)
  }
  await b.unmount()
  await ui.unmount()
})

test('band: with 6 or more queued it lists 1–5 only; 6 and 7 are no band key, so in an empty prompt they type as usual and switch nothing', async ($, on) => {
  const many = queued(7)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  const hotkeys = (await ui.findAll({ type: 'Button' })).map((x: any) => x.props.hotkey).filter(Boolean)
  expect(hotkeys).toEqual(['8', '9', '1', '2', '3', '4', '5', '0'])
  expect((await ui.findAll({ type: 'Button' })).filter((x: any) => x.key.startsWith('queue:')).map((x: any) => x.props.label)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4'])
  for (const text of ['6', '7']) {
    const res = await $.prompt.submit({ text, wait: false, origin: { kind: 'user' } } as any)
    expect(res.text).toBe(text)
  }
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
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
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('q6')])
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
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('q6')])
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

test('階段字（規劃中、實作中、已推送、未開工）在待回覆、全部、封存的卡片上都不畫，任何寬度都一樣；全部的卡片第一行改放 repo', async ($, on) => {
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
    expect((await ui.find({ key: `card-repo:${cards[0]!.key}` }))!.text.trimStart().replace(/…$/, '')).toBe(cols >= 38 ? 'claude-personal' : 'claude-personal'.slice(0, cols - 4 - 13 - 4 - 2 - 1))
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

test('refined neutral：底列摘要與 repo、問題同為 dim 灰；全部的卡片不畫階段，repo 是 dim 灰加 dimColor、不加粗', async ($, on) => {
  const c = card('甲', { repo: 'frontend', summary: '現場報工端埋' })
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
  test(`refined：${cols} 欄題目列：題目與長摘要只佔一行，摘要以 … 截短，不放 repo 與階段`, async ($, on) => {
    const c = card('甲', { repo: 'frontend', summary: '現場報工端埋-posthog-完整摘要', question: '要怎麼做？' })
    const w = world({ ...focusOf('甲', []), sessions: [c] })
    appearanceConfig.set(w, { motion: false })
    await start($, on, w)
    await openPane($)
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const [drawn] = await mountedCards(ui)
    const line = textOf(drawn!.children!.at(-1)!)
    expect(line).not.toContain('\n')
    expect(line).toContain('要怎麼做？')
    expect(line).toContain('現場報工端埋')
    expect(line).toContain('…')
    expect(line).not.toMatch(/frontend|實作中/)
    expect(cardWidth(line)).toBeLessThanOrEqual(cols - 1)
    await ui.unmount()
  })

  for (const options of [[], ['繼續', '停止']]) {
    test(`refined：${cols} 欄${options.length ? '有選項' : '無選項'}未選卡與選中卡等高（上方空行＋兩行）、問題緊接標頭只佔一行、不顯示選項、編號後留一格`, async ($, on) => {
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
      // The blank row above, the header, the question.
      expect(a).toHaveLength(3)
      expect(a[0]).toBe('')
      expect(a[1]!.startsWith(` ${MARK_STILL}`)).toBe(true)
      expect(b[1]!.startsWith('   ')).toBe(true)
      expect(a[2]!.trimStart().startsWith('要繼續嗎？')).toBe(true)
      expect(a[2]!.indexOf('要繼續嗎？')).toBe(b[2]!.indexOf('要繼續嗎？'))
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

test('refined：每張卡的暱稱加粗（選中的用強調色），選中的標記加粗；摘要只有開頭的數字提亮，字中數字與狀態字都不加粗', async ($, on) => {
  const cards = [card('甲', { repo: 'frontend', summary: '1 未核對', status: '等待授權' }), card('乙', { repo: 'frontend', summary: '面板 v2 改版', status: '回覆完畢' }), card('丙', { summary: '123456789012345678901234 項', archived: true, pending: false })]
  const w = world({ ...focusOf('甲', ['乙']), sessions: cards })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const bold = async () => (await ui.findAll({ type: 'Text' })).filter((x: any) => x.props.bold).map((x: any) => x.text)
  expect(await bold()).toEqual([` ${MARK_STILL} `, '甲', '乙'])
  // 待回覆 keeps the whole summary dim, its leading count too.
  expect((await ui.findAll({ type: 'Text' })).some((x: any) => x.text === '1')).toBe(false)
  expect(paintOf(await ui.drawn(), '1 未核對')?.color).toBe('gray')
  await ui.press({ key: 'tab:all' })
  const all = await ui.findAll({ type: 'Text' })
  const root = await ui.drawn()
  expect(all.some((x: any) => x.text === '1')).toBe(true)
  const lead = paintOf(root, '1')
  expect(lead).toBeDefined()
  expect(lead!.color).toBeUndefined()
  expect(lead!.bold).toBeFalsy()
  expect(paintOf(root, ' 未核對')?.color).toBe('gray')
  expect(all.some((x: any) => x.text === '2')).toBe(false)
  expect(paintOf(await ui.drawn(), '面板 v2 改版')?.color).toBe('gray')
  expect((await bold()).filter((t: string) => t !== ` ${MARK_STILL} `)).toEqual(['甲', '乙'])
  expect(paintOf(await ui.drawn(), 'frontend')?.color).toBeUndefined()
  await ui.press({ key: 'tab:hidden' })
  expect((await bold()).filter((t: string) => t !== ` ${MARK_STILL} `)).toEqual(['丙'])
  await ui.unmount()
  const narrow = await $.ui.mount({ ...pane(36), surface: 'terminal' })
  const cut = (await narrow.find({ key: `summary:${cards[2]!.key}` }))!.text
  expect(cut).toMatch(/^\d+…$/)
  expect(paintOf(await narrow.drawn(), cut)?.color).toBe('gray')
  await narrow.unmount()
  const focusBand = await $.ui.mount({ ...band(80), surface: 'terminal' })
  const bandTexts = await focusBand.findAll({ type: 'Text' })
  expect(bandTexts.filter((x: any) => x.props.bold).map((x: any) => x.text)).toEqual(['甲'])
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
      expect((await focusBand.find({ type: 'Text', text: '◆' }))?.props.color).toBe(glyphColor)
      expect((await focusBand.find({ type: 'Text', text: ' 待授權' }))?.props.color).toBe(blocked)
    }
    expect((await focusBand.find({ type: 'Text', text: '── 待回覆 1/2 ' }))?.props.color).toBe(dim)
    expect((await focusBand.find({ type: 'Text', text: '─'.repeat(66) }))?.props.color).toBe(border)
    if (name === 'neutral') {
      expect((await texts(focusBand)).join('')).toContain(`── 待回覆 1/2 ${'─'.repeat(66)}`)
    }
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
  expect((await focusBand.find({ type: 'Text', text: '◆' }))?.props.color).toBe('gray')
  expect((await focusBand.find({ type: 'Text', text: ' 待授權' }))?.props.color).toBe('magentaBright')
  expect((await focusBand.find({ type: 'Text', text: '│ ' }))?.props.color).toBe('magentaBright')
  expect((await ui.find({ type: 'Text', text: ' 待授權' }))?.props.color).toBe('magentaBright')
  await clock.advance(600)
  expect(invalidations).toBe(before + 2)
  expect((await focusBand.find({ type: 'Text', text: '◆' }))?.props.color).toBe('magentaBright')
  config.motion = false
  await openPane($)
  await ui.press({ key: 'tab:all' })
  const stopped = invalidations
  await clock.advance(900)
  expect(invalidations).toBe(stopped)
  expect((await ui.find({ key: 'status:perm@1' }))?.text).toContain('◆ 待授權')
  expect((await focusBand.find({ type: 'Text', text: '◆' }))?.props.color).toBe('magentaBright')
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

test('refined：焦點框待回覆分隔線、授權色左線、不重複階段，單題沒有延後', async ($, on) => {
  const w = world(focusOf('perm', ['focusui']))
  appearanceConfig.set(w, { motion: false })
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(46), surface: 'terminal' })
  expect((await texts(ui)).some((t: string) => t.includes('待回覆 1/2'))).toBe(true)
  expect((await ui.find({ type: 'Text', text: '│ ' }))?.props.color).toBe('magentaBright')
  expect((await texts(ui)).some((t: string) => t.includes('實作中'))).toBe(false)
  expect((await labels(ui)).some((t: string) => t.includes('1: focusui'))).toBe(true)
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

test('refined：編號與焦點框一致，選排隊卡後目前題不編號', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ key: 'num:perm@1' })).toBeUndefined()
  expect((await ui.find({ key: 'num:focusui@1' }))?.props.hotkey).toBe('1')
  await ui.press({ key: 'num:focusui@1' })
  expect(w.calls.some(c => c[0] === 'focus-pick' && c[1] === keyOf('focusui'))).toBe(true)
  expect(await ui.find({ key: 'num:focusui@1' })).toBeUndefined()
  expect((await ui.find({ key: 'num:perm@1' }))?.props.hotkey).toBe('1')
  await ui.unmount()
})

test('refined：上下選卡不切換問題；Enter 或點暱稱等於按那張卡的數字鍵，在等回答的卡換上橫條並印出，沒在等回答的卡只選中；d 才開摘要小視窗', async ($, on) => {
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
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([['focus-pick', 'focusui@1']])
  expect(w.shown).toEqual(['focusui'])
  expect(findKey(await ui.drawn(), 'popover')).toBeUndefined()
  await ui.press({ key: 'tab:all' })
  await ui.press({ key: `name:${keyOf('tune')}` })
  expect(await chosenTag(ui)).toBe('tune')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toHaveLength(1)
  expect(w.shown).toEqual(['focusui'])
  await ui.press({ key: `name:${keyOf('logging')}` })
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('logging')])
  expect(w.shown.at(-1)).toBe('logging')
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

test('refined：超過五筆排隊仍顯示完整隱藏數', async ($, on) => {
  const many = queued(10)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  for (const cols of [80, 46]) {
    const ui = await $.ui.mount({ ...band(cols), surface: 'terminal' })
    expect((await texts(ui)).some((t: string) => t.includes(`＋${cols === 80 ? 5 : 9} · `))).toBe(true)
    expect((await labels(ui)).filter((t: string) => /^[1-5]:/.test(t))).toHaveLength(5)
    await ui.unmount()
  }
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

const longBandQuestion = `第一行\n\n${'問'.repeat(500)}\n最後一行`
const longBandQueue = Array.from({ length: 5 }, (_, i) => ({ tag: `排隊名稱${i}abcdefghijk`, isNew: true }))

test('寬度：✨ 算 2 欄，排隊名稱後的 ✨ 照 2 欄預留', () => {
  expect(columns('✨')).toBe(2)
  expect(columns('a ✨')).toBe(4)
  const rows = focusBandRows({ cols: 80, maxRows: 20, question: '問題', queue: [{ tag: 'abc', isNew: true }], hiddenCount: 0 })
  expect(rows.queueLabels).toEqual(['abc ✨'])
  expect(rows.keyLines.flat().find(item => item.index === 2)?.width).toBe(columns('abc') + 3 + 7)
})

test('refined：80 與 46 欄操作在標題列不佔行，題目最多一行，超過一行寬時截斷以 … 結尾，其他列行數不變', () => {
  for (const cols of [80, 46]) {
    const inner = cols - 6
    const rows = focusBandRows({ cols, maxRows: 10, question: longBandQuestion, queue: longBandQueue, hiddenCount: 2 })
    expect(rows.actions).toBe(0)
    expect(rows.keys).toBe(cols === 80 ? 3 : 2)
    expect(rows.question).toBe(1)
    expect(rows.questionText.startsWith('第一行 問')).toBe(true)
    expect(rows.questionText.endsWith('…')).toBe(true)
    expect(rows.questionText.includes('\n')).toBe(false)
    expect(columns(rows.questionText)).toBeLessThanOrEqual(inner)
    const short = focusBandRows({ cols, maxRows: 10, question: '要怎麼做？', queue: longBandQueue, hiddenCount: 2 })
    expect(short.question).toBe(1)
    expect(short.questionText).toBe('要怎麼做？')
    const exact = focusBandRows({ cols, maxRows: 10, question: '問'.repeat(inner / 2), queue: longBandQueue, hiddenCount: 2 })
    expect(exact.questionText).toBe('問'.repeat(inner / 2))
    const over = focusBandRows({ cols, maxRows: 10, question: '問'.repeat(inner / 2 + 1), queue: longBandQueue, hiddenCount: 2 })
    expect(over.question).toBe(1)
    expect(over.questionText.endsWith('…')).toBe(true)
    expect(columns(over.questionText)).toBeLessThanOrEqual(inner)
    for (const other of [short, exact, over]) {
      expect([other.margin, other.separator, other.header, other.actions, other.keys]).toEqual([rows.margin, rows.separator, rows.header, rows.actions, rows.keys])
      expect(other.keyLines).toEqual(rows.keyLines)
    }
  }
})

test('refined：長多行問題與五個長排隊名稱仍畫出操作與 0 面板', async ($, on) => {
  const many = [...longBandQueue.map(q => card(q.tag)), card('隱藏一'), card('隱藏二')]
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [card('perm', { question: longBandQuestion }), ...many] })
  w.focus.queue = many.map(c => ({ key: c.key, isNew: true }))
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  for (const cols of [80, 46]) {
    const ui = await $.ui.mount({ ...band(cols, 10), surface: 'terminal' })
    const drawn = await ui.drawn()
    const buttons: string[] = []
    type Drawn = { type: string; props: { hotkey?: string; label?: string }; children?: (Drawn | string)[] }
    const visit = (node: Drawn | string) => {
      if (typeof node === 'string') return
      if (node.type === 'Button') buttons.push(`${node.props.hotkey ?? ''}: ${node.props.label}`)
      for (const child of node.children ?? []) visit(child)
    }
    visit(drawn)
    expect(buttons).toContain('9: 顯示問題')
    expect(buttons).toContain('8: 延後處理')
    expect(buttons).toContain('0: 面板')
    expect(buttons).toContain(`1: ${longBandQueue[0]!.tag} ✨`)
    expect((await texts(ui)).includes(`＋${cols === 80 ? 2 : 6} · `)).toBe(true)
    expect((await texts(ui)).find((text: string) => text.startsWith('第一行'))?.endsWith('…')).toBe(true)
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

test('中控台自己那一輪還在跑：橫條照樣換題但不送 /focus-show；這一輪結束後只印橫條上當下那一題，中間被換掉的不補送', async ($, on) => {
  const w = { ...world({ ...focusOf('perm', ['focusui', 'logging']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true }
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const clock = await start($, on, w)
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  await $.turn.start({ text: '回 perm 允許', turnId: 'console-turn' })
  w.focus = { ...focusOf('focusui', ['logging']), announce: 'focusui', announceKey: keyOf('focusui') }
  await clock.advance(5_000)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect((await ui.find({ key: 'band-name' }))?.text).toBe('focusui')
  w.focus = { ...focusOf('logging', []), announce: 'logging', announceKey: keyOf('logging') }
  await clock.advance(5_000)
  expect((await ui.find({ key: 'band-name' }))?.text).toBe('logging')
  await ui.unmount()
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  await $.turn.start({ text: '', turnId: 'sub-turn', agentId: 'sub' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub-turn', agentId: 'sub', reason: 'answer' })
  await clock.settle()
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  await $.turn.complete({ answer: '好', durationMs: 1, isAborted: false, turnId: 'console-turn', reason: 'answer' })
  await clock.settle()
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`, `logging ${idOf(keyOf('logging'))}`])
  await clock.advance(5_000)
  expect(w.shown).toHaveLength(2)
})

// --- 代回倒數 ---

const AUTO = { ...READY, auto: { answer: 'b', meaning: '橫條也改清單', seconds: 15 } }
const countdownText = async (ui: any) => {
  const row = findKey(await ui.drawn(), 'countdown')
  return row ? `${drawnText(findKey(row, 'countdown-left'))} | ${drawnText(findKey(row, 'countdown-keys'))}` : null
}
const autoCalls = (w: World) => w.calls.filter(c => c[0] === 'focus-auto' || c[0] === 'focus-cancel').map(c => c.slice(0, 2))
const sendArgs = (w: World) => w.calls.filter(c => c[0] === 'focus-auto').map(c => c.slice(2))

test('Herdr app tab (HC_TERMINAL_ID only): the band polls console.mjs focus like in Orca and herdr, and a countdown posts no herdr notification', async ($, on) => {
  const w = world(withAdvice(AUTO))
  await start($, on, w, { HC_TERMINAL_ID: 't1' })
  expect(w.calls.some(c => c[0] === 'focus')).toBe(true)
  const ui = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await countdownText(ui)).toBe('代回倒數 15 秒：b 橫條也改清單 | 6: 立即送出 · 7: 取消')
  await ui.unmount()
  expect(w.notes ?? []).toEqual([])
})

test('no Orca, herdr or Herdr app: the band never polls console.mjs focus', async ($, on) => {
  const w = world(withAdvice(AUTO))
  await start($, on, w, {})
  expect(w.calls.filter(c => c[0] === 'focus')).toEqual([])
})

test('band countdown: an open question on the band gets a herdr notification (request sound, 代號 and answer in the title) and the row 代回倒數 N 秒：b 橫條也改清單 with 6: 立即送出 · 7: 取消 on the right, one second down per second; at 0 the band sends it with focus-auto', async ($, on) => {
  const w = world(withAdvice(AUTO))
  w.afterAuto = { ...focusOf('logging', []), notice: '[focusui] 已自動回覆：b' }
  const clock = await start($, on, w, { HERDR_ENV: '1' })
  expect(w.notes).toEqual([['herdr', 'notification', 'show', '[focusui] 15 秒後代回 b', '--body', '橫條也改清單 · 6: 立即送出 · 7: 取消', '--sound', 'request']])
  const ui = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await countdownText(ui)).toBe('代回倒數 15 秒：b 橫條也改清單 | 6: 立即送出 · 7: 取消')
  expect(await ui.find({ key: 'advice' })).toBeUndefined()
  expect((await ui.find({ key: 'auto-now' }))?.props).toMatchObject({ hotkey: '6', label: '立即送出' })
  expect((await ui.find({ key: 'auto-cancel' }))?.props).toMatchObject({ hotkey: '7', label: '取消' })
  await ui.unmount()
  await clock.advance(1_000)
  const later = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await countdownText(later)).toBe('代回倒數 14 秒：b 橫條也改清單 | 6: 立即送出 · 7: 取消')
  await later.unmount()
  await clock.advance(13_000)
  expect(autoCalls(w)).toEqual([])
  await clock.advance(1_000)
  expect(autoCalls(w)).toEqual([['focus-auto', keyOf('focusui')]])
  expect(sendArgs(w)).toEqual([['--owner', 'console-session@1000', '--reason', 'tick', '--clock', '16000']])
  expect(w.toasts).toContain('[focusui] 已自動回覆：b')
  const after = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await countdownText(after)).toBeNull()
  await after.unmount()
  expect(w.notes?.length).toBe(1)
})

test('band countdown: the keys sit flush right like the header buttons; a long answer is cut with … and both keys stay whole', async ($, on) => {
  const long = { ...READY, auto: { answer: '先把整個橫條改成清單再補測試與文件，最後重截兩張主題截圖', meaning: '橫條也改清單', seconds: 15 } }
  const w = world(withAdvice(long))
  await start($, on, w)
  for (const cols of [50, 60, 80]) {
    const ui = await $.ui.mount({ ...band(cols, 20), surface: 'terminal' })
    const row = findKey(await ui.drawn(), 'countdown')
    expect(row.props.justifyContent).toBe('space-between')
    const [left, right] = row.children
    expect(right.props.key).toBe('countdown-keys')
    expect(right.props.justifyContent).toBe('flex-end')
    expect(drawnText(right)).toBe('6: 立即送出 · 7: 取消')
    const shown = drawnText(left)
    expect(shown.startsWith('代回倒數 15 秒：')).toBe(true)
    expect(shown.endsWith('…')).toBe(true)
    expect(row.props.width).toBe(cols - 4)
    expect(row.props.width).toBe((await headRow(ui)).props.width)
    expect(cardWidth(shown) + cardWidth(drawnText(right))).toBeLessThanOrEqual(cols - 4)
    expect(cardLines(row, cols - 4).filter(line => line.trim())).toHaveLength(1)
    await ui.unmount()
  }
})

test('band countdown: 6 sends at once, and the countdown does not send it a second time', async ($, on) => {
  const w = world(withAdvice(AUTO))
  w.afterAuto = focusOf('logging', [])
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  await ui.press({ key: 'auto-now' })
  await ui.unmount()
  expect(autoCalls(w)).toEqual([['focus-auto', keyOf('focusui')]])
  expect(sendArgs(w)).toEqual([['--owner', 'console-session@1000', '--reason', 'key', '--clock', '1000']])
  await clock.advance(20_000)
  expect(autoCalls(w)).toEqual([['focus-auto', keyOf('focusui')]])
})

test('band countdown: a draft in the console prompt holds the countdown where it is; once the box is sent or cleared it counts on from there and sends at 0', async ($, on) => {
  const w = world(withAdvice(AUTO))
  w.afterAuto = focusOf('logging', [])
  let draft = ''
  on('prompt.read', async () => ({ value: { text: draft, cursor: draft.length } }))
  const clock = await start($, on, w)
  await clock.advance(5_000)
  draft = 'focusui 先'
  await clock.advance(30_000)
  expect(autoCalls(w)).toEqual([])
  const held = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await countdownText(held)).toBe('代回倒數 10 秒：b 橫條也改清單 | 6: 立即送出 · 7: 取消')
  await held.unmount()
  draft = ''
  await clock.advance(10_000)
  expect(autoCalls(w)).toEqual([])
  await clock.advance(1_000)
  expect(autoCalls(w)).toEqual([['focus-auto', keyOf('focusui')]])
})

test('band countdown: 7 cancels — focus-cancel, the row goes back to 建議, and nothing is sent when the time would have run out', async ($, on) => {
  const w = world(withAdvice(AUTO))
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  await ui.press({ key: 'auto-cancel' })
  await ui.unmount()
  expect(autoCalls(w)).toEqual([['focus-cancel', keyOf('focusui')]])
  const after = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await countdownText(after)).toBeNull()
  expect(textOf(await after.find({ key: 'advice' }))).toBe('建議：b 橫條也改清單，兩邊都改才一致')
  await after.unmount()
  await clock.advance(20_000)
  expect(autoCalls(w)).toEqual([['focus-cancel', keyOf('focusui')]])
})

test('band countdown: outside herdr there is no notification, only the countdown; only the band question counts down, a queued open one waits its turn', async ($, on) => {
  const both = { ...withAdvice(AUTO), sessions: SESSIONS.map(s => (s.tag === 'focusui' || s.tag === 'logging' ? { ...s, advice: AUTO } : s)) }
  const w = world(both)
  w.afterAuto = { ...focusOf('logging', []), sessions: both.sessions }
  const clock = await start($, on, w)
  expect(w.notes ?? []).toEqual([])
  const ui = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await countdownText(ui)).toMatch(/^代回倒數 15 秒/)
  await ui.unmount()
  await clock.advance(15_000)
  expect(autoCalls(w)).toEqual([['focus-auto', keyOf('focusui')]])
  const next = await $.ui.mount({ ...band(120, 20), surface: 'terminal' })
  expect(await countdownText(next)).toMatch(/^代回倒數 15 秒/)
  await next.unmount()
  await clock.advance(15_000)
  expect(autoCalls(w)).toEqual([['focus-auto', keyOf('focusui')], ['focus-auto', keyOf('logging')]])
})

test('band countdown: at 0 while the console\'s own turn runs it waits; the user answered that question meanwhile, so it left the band and nothing is sent', async ($, on) => {
  const w = world(withAdvice(AUTO))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const clock = await start($, on, w)
  await $.turn.start({ text: 'focusui a', turnId: 'console-turn' })
  await clock.advance(16_000)
  expect(autoCalls(w)).toEqual([])
  w.focus = focusOf('logging', [])
  await $.turn.complete({ answer: '[focusui] 已送出', durationMs: 1, isAborted: false, turnId: 'console-turn', reason: 'answer' })
  await clock.advance(5_000)
  expect(autoCalls(w)).toEqual([])
})

const withCards = (extra: Record<string, Partial<Card> & { advice?: any; brief?: any }>, current = 'focusui', queue = ['logging', 'PROJ-6668', 'perm']) => ({
  ...focusOf(current, queue),
  sessions: SESSIONS.map(s => (extra[s.tag] ? { ...s, ...extra[s.tag] } : s)),
})

test('卡片 ✓ 建議: a card whose suggestion is ready reads ✓ (accent) 建議 (dim) on its header right, before the repo, on 待回覆 and 全部 alike; below 46 columns only ✓; the header stays one row', async ($, on) => {
  const w = world(withCards({ focusui: { advice: READY }, logging: { advice: { state: 'pending', text: '建議產生中… 3 秒' } }, 'PROJ-6668': { advice: null } }))
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
      expect(right).toMatch(/^✓ 建議 +agent-skills$/)
      expect(right).not.toContain('規劃中')
    }
    await ui.press({ key: 'tab:pending' })
    const header = findKey(await ui.drawn(), `card:${keyOf('focusui')}`).children[0]
    expect(cells(textOf(header))).toBeLessThanOrEqual(cols - 1)
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(textOf(await narrow.find({ key: `hint:${keyOf('focusui')}` }))).toBe('✓')
  const header = findKey(await narrow.drawn(), `card:${keyOf('focusui')}`).children[0]
  // The mark and the header row, less the 2 cells space-between puts before the right part.
  expect(cells(textOf(header))).toBeLessThanOrEqual(40 - 1 - 2)
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
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([['focus-pick', keyOf('logging')]])
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

// --- 待決 (automation.json batch on) ---

const decision = (id: string, extra: object) => ({ id, key: `${id}@1`, tag: 'PROJ-7882', repo: 'proj-v2-frontend', group: 'PROJ-7882', verb: 'delete-remote-branch', action: '刪遠端 branch', question: '舊 branch 已合併，要刪掉遠端的嗎？', options: ['刪掉', '先留著'], answer: 'a', reason: '已合併進 dev，留著沒用', failed: false, ...extra })
const DECISIONS = [
  decision('p1', {}),
  decision('p2', { tag: 'PROJ-7882#2', verb: 'linear-mention', action: 'Linear @ 同事', question: '要在票上 @ 後端請他補 API 嗎？', options: ['@ andrew', '先不要'], answer: 'a', reason: 'API 格式已定' }),
  decision('p3', { tag: 'weekly', group: 'weekly', repo: 'agent-skills', verb: 'weekly-assign-write', action: '寫入每週分票', question: '草案確認了，要寫進 Linear 嗎？', options: [], answer: '照草案寫入', reason: '草案你已看過' }),
]
const withDecisions = (list: object[] = DECISIONS) => ({ ...pending(), decisions: list })
const tabButtons = async (ui: any) => (await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('tab:')).map((b: any) => [b.key, b.props.hotkey, b.props.label])

test('待決：batch 沒打開（payload 沒有 decisions）時分頁、按鍵、說明列都和原本一樣；打開才多一個 r: 待決 N，說明列換成 qwer', async ($, on) => {
  const off = world(pending())
  const clock = await start($, on, off)
  await openPane($)
  let ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await tabButtons(ui)).toEqual([['tab:pending', 'q', '待回覆 5'], ['tab:all', 'w', '全部 7'], ['tab:hidden', 'e', '封存 1']])
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => ['r', 'a'].includes(b.props.hotkey))).toEqual([])
  expect(await footerLines(ui)).toEqual(['qwe 切分頁 · 1-9,0/↑↓ 選卡片'])
  await ui.unmount()
  off.focus = withDecisions()
  await clock.advance(5_000)
  ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await tabButtons(ui)).toEqual([['tab:decisions', 'r', '待決 3'], ['tab:pending', 'q', '待回覆 5'], ['tab:all', 'w', '全部 7'], ['tab:hidden', 'e', '封存 1']])
  expect(await footerLines(ui)).toEqual(['qwer 切分頁 · 1-9,0/↑↓ 選卡片'])
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  await ui.unmount()
})

test('待決：依票分組，每組一條 `── 票 · repo ── N 題`；每張卡是動作、題目、建議三行，右上角 ✓ 核可；上方 N 題等你核可與 a: 全部核可', async ($, on) => {
  const w = world(withDecisions())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  expect((await ui.find({ key: 'tab:decisions' }))?.props.dimColor).toBe(false)
  const all = await ui.find({ key: 'decide-all' })
  expect([all?.props.hotkey, all?.props.label]).toEqual(['a', '全部核可'])
  expect((await ui.find({ key: 'decide-count' }))?.text).toBe('3 題等你核可 · 核可後照建議送出')
  const rules = (await texts(ui)).filter((t: string) => t.startsWith('── ') && t.endsWith(' 題'))
  expect(rules.map((t: string) => [t.split(' ')[1], t.split(' ')[3], t.split(' ').slice(-2).join(' ')])).toEqual([['PROJ-7882', 'proj-v2-frontend', '2 題'], ['weekly', 'agent-skills', '1 題']])
  const first = (await ui.find({ key: 'decision:p1' }))!.text
  expect(first).toContain('刪遠端 branch')
  expect(first).toContain('舊 branch 已合併，要刪掉遠端的嗎？')
  expect(first).toContain('建議：a 刪掉，已合併進 dev，留著沒用')
  expect((await ui.find({ key: 'decision:p2' }))!.text).toContain('PROJ-7882#2 · 要在票上 @ 後端')
  expect((await ui.find({ key: 'decision:p3' }))!.text).toContain('建議：照草案寫入，草案你已看過')
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => /^(approve|manual):/.test(b.key)).map((b: any) => [b.key, b.props.label])).toEqual([['approve:p1', 'y ✓ 核可'], ['manual:p1', 'm 自己回'], ['approve:p2', '✓ 核可'], ['manual:p2', '自己回'], ['approve:p3', '✓ 核可'], ['manual:p3', '自己回']])
  expect((await ui.find({ key: 'decision-right:p1' }))?.text).toBe('y ✓ 核可 · m 自己回')
  expect((await ui.find({ key: 'decision-right:p2' }))?.text).toBe('✓ 核可 · 自己回')
  expect(await cardTags(ui)).toEqual([])
  expect((await ui.find({ key: 'decide-footer' }))?.text).toBe('Enter 詳情 · y 核可 · m 自己回 · a 全部核可 · qwer 切分頁')
  await ui.unmount()
})

test('待決：卡片的 ✓ 核可直接跑 console.mjs decide <id> approve 再輪詢，不經對話；那張卡離開、分頁數字減一、跳一則送出結果', async ($, on) => {
  const w = world(withDecisions())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'approve:p2' })
  expect(w.calls.at(-2)).toEqual(['decide', 'p2', 'approve'])
  expect(w.calls.at(-1)).toEqual(['focus', '--session', 'console-session', '--owner', 'console-session@1000'])
  expect(w.toasts).toContain('[PROJ-7882#2] 已核可並送出：a')
  expect(w.shown).toEqual([])
  expect(await ui.find({ key: 'decision:p2' })).toBeFalsy()
  expect((await ui.find({ key: 'tab:decisions' }))?.props.label).toBe('待決 2')
  await ui.unmount()
})

test('待決：a 全部核可跑 decide --all approve；送出失敗的題留在清單標錯誤色的「送出失敗」，浮動通知寫成功與失敗各幾題', async ($, on) => {
  const w = world(withDecisions())
  w.decideFails = ['p3']
  appearanceConfig.set(w, { theme: 'dracula', motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'decide-all' })
  expect(w.calls.at(-2)).toEqual(['decide', '--all', 'approve'])
  expect(w.toasts).toContain('已核可 2 題，1 題送出失敗')
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('approve:')).map((b: any) => b.key)).toEqual(['approve:p3'])
  const failed = await ui.find({ key: 'decision:p3' })
  expect(failed!.text).toContain('送出失敗')
  expect((await ui.findAll({ type: 'Text' })).some((t: any) => t.text === '送出失敗' && t.props.color === THEMES.dracula.error)).toBe(true)
  expect((await ui.find({ key: 'tab:decisions' }))?.props.label).toBe('待決 1')
  await ui.unmount()
})

test('待決：空清單是置中的圓角框，寫「沒有等你核可的動作」與一行灰字說明，沒有全部核可', async ($, on) => {
  const w = world(withDecisions([]))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ key: 'tab:decisions' }))?.props.label).toBe('待決 0')
  await ui.press({ key: 'tab:decisions' })
  const box = await ui.find({ key: 'decide-empty' })
  expect(box?.props.borderStyle).toBe('round')
  expect(box!.text).toContain('沒有等你核可的動作')
  expect(box!.text).toContain('刪遠端 branch、@ 同事這類題會排到這裡')
  expect(await ui.find({ key: 'decide-all' })).toBeFalsy()
  await ui.unmount()
})

test('待決：batch 關掉時停在待決分頁的面板回到待回覆，分頁只剩 q/w/e', async ($, on) => {
  const w = world(withDecisions())
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  w.focus = pending()
  await clock.advance(5_000)
  expect(await tabButtons(ui)).toEqual([['tab:pending', 'q', '待回覆 5'], ['tab:all', 'w', '全部 7'], ['tab:hidden', 'e', '封存 1']])
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  await ui.unmount()
})

const LONG_REPLY = '舊的 feat/proj-7882-old 已經合併進 dev，CI 也綠了。\n\n我想把遠端的 branch 刪掉，免得之後有人誤推。\n\n- **A**：刪掉\n- **B**：先留著\n\n要刪掉遠端的嗎？'
const detailed = () => withDecisions(DECISIONS.map(d => (d.id === 'p1' ? { ...d, stage: '實作中', context: LONG_REPLY, precedent: { question: '要刪掉 feat/proj-7001 的遠端 branch 嗎？', answer: 'a' } } : d)))
const decideCalls = (w: World) => w.calls.filter(c => c[0] === 'decide')

test('待決浮層：Enter（選中卡片的題目）或點題目在卡片正下方開浮層，不另開面板；再按一次收起；同時只有一個浮層；Enter 不核可，什麼都不送也不進對話', async ($, on) => {
  const w = world(detailed())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  const opened = w.opened.length
  const first = await ui.find({ key: 'detail:p1' })
  expect(first?.props.autoFocus).toBe(true)
  await ui.press({ key: 'detail:p1' })
  expect(w.opened.length).toBe(opened)
  const root = await ui.drawn()
  const box = findKey(root, 'popover')
  // The tab rows, the count row, the group's blank row and rule, the blank row under it: p1's three rows are 6..8.
  expect(box.props).toMatchObject({ position: 'absolute', top: 9, left: 0 })
  expect(root.children.at(-1)).toBe(box)
  expect((await popRows(ui))![0]).toContain('刪遠端 branch')
  expect(decideCalls(w)).toEqual([])
  expect(w.shown).toEqual([])
  await ui.press({ key: 'detail:p3' })
  expect((await ui.findAll({ type: 'Box' })).filter((b: any) => b.key === 'popover')).toHaveLength(1)
  expect((await popRows(ui))![0]).toContain('寫入每週分票')
  expect((await ui.find({ key: 'decision:p3' }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  await ui.press({ key: 'detail:p3' })
  expect(await popRows(ui)).toBeNull()
  expect(w.opened.length).toBe(opened)
  expect(decideCalls(w)).toEqual([])
  await ui.unmount()
})

for (const name of ['neutral', 'dracula'] as const) {
  test(`待決浮層內容（${name}）：完整題目（前景色粗體）開頭，接著子 session 的回覆、選項、advisor 建議、參考的前例，各段空一行；不畫代號、repo、階段；標題強調色粗體、正文前景色、前例次要色；都靠左不縮排；長內容照寬度換行不截斷`, async ($, on) => {
    const long = `${'這題要先確認遠端 branch 已合併，'.repeat(4)}要刪掉嗎？`
    const w = world(withDecisions(detailed().decisions.map((d: any) => (d.id === 'p1' ? { ...d, question: long } : d))))
    appearanceConfig.set(w, { theme: name, motion: false })
    await start($, on, w)
    await openPane($)
    const theme = THEMES[name]
    for (const cols of [40, 60]) {
      const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
      await ui.press({ key: 'tab:decisions' })
      await ui.press({ key: 'detail:p1' })
      const rows = (await popRows(ui))!
      expect(rows[0]).toContain('刪遠端 branch')
      expect(rows[0]).toContain('y ✓ 核可 · m 自己回')
      expect(rows.at(-1)).not.toContain('j/k')
      for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(cols)
      expect(rows.join('')).not.toMatch(/實作中|proj-v2-frontend|PROJ-7882 ·/)
      const body = rows.slice(1, -1).map(r => r.replace(/^┃ /, '').trimEnd())
      for (const line of body) expect(line.startsWith(' ')).toBe(false)
      const labels = ['子 session 的回覆', '選項', 'advisor 建議', '參考的前例']
      const at = labels.map(l => body.indexOf(l))
      expect(at.every((n, i) => n > 0 && (i === 0 || n > at[i - 1]!))).toBe(true)
      for (const n of at) expect(body[n - 1]).toBe('')
      expect(body.slice(0, at[0]! - 1).join('').replace(/\s/g, '')).toBe(long.replace(/\s/g, ''))
      const after = (label: string) => body.slice(body.indexOf(label) + 1)
      expect(after('子 session 的回覆').join('').replace(/\s/g, '').startsWith(LONG_REPLY.replace(/\s/g, ''))).toBe(true)
      expect(after('選項').slice(0, 2)).toEqual(['a. 刪掉 ✓ 建議', 'b. 先留著'])
      expect(after('advisor 建議')[0]).toBe('建議：a 刪掉，已合併進 dev，留著沒用')
      expect(after('參考的前例').join('').replace(/\s/g, '')).toContain('題目：要刪掉feat/proj-7001的遠端branch嗎？')
      expect(after('參考的前例').join('')).toContain('你當時回：a')
      const box = findKey(await ui.drawn(), 'popover')
      const runs: { text: string; color?: string; bold?: boolean }[] = []
      const walk = (node: any) => {
        if (typeof node !== 'object' || !node) return
        if (node.type === 'Text' && (node.children ?? []).every((c: any) => typeof c === 'string')) runs.push({ text: textOf(node), color: node.props?.color, bold: node.props?.bold })
        for (const c of node.children ?? []) walk(c)
      }
      walk(box)
      const paint = (text: string) => runs.filter(r => r.text.trim() && text.includes(r.text.trim())).map(r => [r.color, !!r.bold])
      const quiet = theme.muted ?? theme.dim
      const lineRuns = (n: number) => findKey(box, `popover-line:${n}`).children.slice(1, -1).map((t: any) => [t.props?.color, !!t.props?.bold])
      for (let n = 0; n < at[0]! - 1; n++) expect(lineRuns(n)).toEqual([[theme.fg, true]])
      for (const l of labels) expect(paint(l)).toContainEqual([theme.accent, true])
      for (let n = at[0]! + 1; n < at[1]! - 1; n++) if (body[n]) expect(lineRuns(n)).toEqual([[theme.fg, false]])
      const runOf = (text: string) => runs.find(r => r.text === text)
      expect([runOf('a.')?.color, runOf('a.')?.bold, runOf('b.')?.color, runOf('b.')?.bold]).toEqual([theme.accent, true, theme.accent, true])
      expect([runOf(' 刪掉')?.color, runOf(' 刪掉')?.bold, runOf(' 先留著')?.color, !!runOf(' 先留著')?.bold]).toEqual([theme.fg, true, theme.fg, false])
      expect([runOf(' ✓ 建議')?.color, runOf(' ✓ 建議')?.bold]).toEqual([theme.accent, true])
      expect([runOf('建議：')?.color, runOf('a')?.color, runOf('a')?.bold, runOf('，已合併進 dev，留著沒用')?.color]).toEqual([theme.accent, theme.fg, true, quiet])
      const precedent = runs.filter(r => r.text.includes('你當時回') || r.text.includes('題目：') || r.text.includes('feat/proj-7001'))
      expect(precedent.length).toBeGreaterThan(0)
      for (const r of precedent) expect([r.color, !!r.bold]).toEqual([quiet, false])
      await ui.unmount()
    }
  })
}

test('待決浮層內容：沒有前例時不畫前例；送出失敗的題寫上次沒送進子 session；沒有選項時不畫選項', async ($, on) => {
  const w = world(withDecisions(DECISIONS.map(d => (d.id === 'p3' ? { ...d, failed: true } : d))))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'detail:p3' })
  const text = (await popRows(ui))!.join('\n')
  expect(text).not.toContain('參考的前例')
  expect(text).not.toContain('選項')
  expect(text).toContain('上次核可沒送進子 session')
  expect(text).toContain('草案確認了，要寫進 Linear 嗎？')
  await ui.unmount()
})

test('待決浮層摘要：「子 session 的回覆」照舊，最下面多一段「摘要」與四層，▶ 要你決定前空一行、強調色加粗；沒有這次停下的摘要時不畫', async ($, on) => {
  const w = world(withDecisions(DECISIONS.map(d => (d.id === 'p1' ? { ...d, context: '舊 branch 已合併進 dev。', digest: DIGEST } : d))))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(70, 60), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'detail:p1' })
  const body = popText((await popRows(ui))!)
  expect(body).toContain('舊 branch 已合併進 dev。')
  const at = body.indexOf('摘要')
  expect(at).toBeGreaterThan(body.indexOf('舊 branch 已合併進 dev。'))
  expect(body.slice(at - 1)).toEqual(['', '摘要', '在做什麼    改登入頁的表單驗證', '卡在哪      註冊頁共用同一個驗證元件', '做了什麼    改好登入頁，單元測試全過', '            順手清掉兩個舊的 lint 警告', '', '▶ 要你決定  要不要一起改註冊頁，建議：另開一張票'])
  expect(paintOf(findKey(await ui.drawn(), 'popover'), '▶ 要你決定  ')).toEqual({ color: THEMES.neutral.accent, bold: true })
  await ui.press({ key: 'detail:p1' })
  await ui.press({ key: 'detail:p2' })
  expect(popText((await popRows(ui))!)).not.toContain('摘要')
  await ui.unmount()
})

test('待決自己回：卡片上的「自己回」跑 decide <id> manual 再輪詢，卡片離開待決並跳通知；不核可、不送', async ($, on) => {
  const w = world(detailed())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'manual:p2' })
  expect(decideCalls(w)).toEqual([['decide', 'p2', 'manual']])
  expect(w.calls.at(-1)).toEqual(['focus', '--session', 'console-session', '--owner', 'console-session@1000'])
  expect(w.toasts).toContain('[PROJ-7882#2] 改成自己回，已放上橫條')
  expect(await ui.find({ key: 'decision:p2' })).toBeFalsy()
  await ui.unmount()
})

test('待決浮層開著時 y 核可、m 自己回照舊作用在那張卡，送出流程與紀錄不變；卡片離開後浮層跟著收起', async ($, on) => {
  const w = world(detailed())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'detail:p1' })
  expect(await popRows(ui)).not.toBeNull()
  await ui.press({ key: 'decide-manual' })
  expect(await popRows(ui)).toBeNull()
  await ui.press({ key: 'detail:p3' })
  expect(await popRows(ui)).not.toBeNull()
  await ui.press({ key: 'decide-yes' })
  expect(await popRows(ui)).toBeNull()
  expect(decideCalls(w)).toEqual([['decide', 'p1', 'manual'], ['decide', 'p3', 'approve']])
  expect(w.toasts).toContain('[weekly] 已核可並送出：照草案寫入')
  await ui.unmount()
})

test('待決按鍵：y 核可、m 自己回作用在選中的卡片（預設第一張，↑↓ 換張）；a 仍是全部核可', async ($, on) => {
  const w = world(detailed())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  const hot = (await ui.findAll({ type: 'Button' })).filter((b: any) => b.props.hotkey).map((b: any) => [b.key, b.props.hotkey])
  expect(hot.filter(([, k]: string[]) => ['y', 'm', 'a'].includes(k))).toEqual([['decide-all', 'a'], ['decide-yes', 'y'], ['decide-manual', 'm']])
  await ui.press({ key: 'decide-manual' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p1', 'manual'])
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: 'detail:p3', origin: { kind: 'person' } } as any)
  expect((await ui.find({ key: 'decision:p3' }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  expect((await ui.find({ key: 'decision-right:p3' }))?.text).toBe('y ✓ 核可 · m 自己回')
  expect((await ui.find({ key: 'decision-right:p2' }))?.text).toBe('✓ 核可 · 自己回')
  await ui.press({ key: 'decide-yes' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p3', 'approve'])
  await ui.unmount()
})

const focusPane = ($: any, element: string, kind: 'person' | 'plugin' = 'person', requestId = PANE) =>
  $.ui.focus({ component: 'Pane', requestId, plugin: PLUGIN, element, origin: kind === 'person' ? { kind } : { kind, name: PLUGIN } } as any)

// The test kit has no `$.ui.focus` for a mod, so the move the mod asks on the switch is checked by hand; these check where a stale place lands.
test('待決焦點：待回覆選了第一張卡後按 r 切到待決，引擎留在舊位置（落在全部核可或第一題的 ✓ 核可）時落點改成題目；直接按 Enter 只開浮層，不核可', async ($, on) => {
  const w = world(detailed())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const buttons = async () => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key) as string[]
  await ui.press({ key: 'tab:pending' })
  await focusPane($, `name:${keyOf('perm')}`, 'plugin')
  const at = (await buttons()).indexOf(w.focused.at(-1)!)
  await ui.press({ key: 'tab:decisions' })
  const keys = await buttons()
  expect(keys.slice(at, at + 2)).toEqual(['decide-all', 'approve:p1'])
  for (const stale of keys.slice(at, at + 2)) {
    await focusPane($, stale, 'plugin')
    expect(w.focused.at(-1)).toBe('detail:p1')
    await ui.press({ key: w.focused.at(-1)! })
    expect((await popRows(ui))![0]).toContain('刪遠端 branch')
    await ui.press({ key: w.focused.at(-1)! })
    expect(await popRows(ui)).toBeNull()
  }
  expect(decideCalls(w)).toEqual([])
  await ui.unmount()
})

test('待決焦點：核可或自己回讓選中的卡片離開後，選中的換成下一題（不是回到第一題），y、m 跟著作用在它', async ($, on) => {
  const w = world(withDecisions([...detailed().decisions, decision('p4', { tag: 'weekly#2', group: 'weekly', repo: 'agent-skills' })]))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await focusPane($, 'detail:p2', 'plugin')
  await ui.press({ key: 'decide-yes' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p2', 'approve'])
  expect((await ui.find({ key: 'decision:p3' }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  await ui.press({ key: 'decide-manual' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p3', 'manual'])
  expect((await ui.find({ key: 'decision:p4' }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  await ui.press({ key: 'decide-yes' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p4', 'approve'])
  expect((await ui.find({ key: 'decision:p1' }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  await ui.unmount()
})

test('待決焦點：焦點指向全部核可、藏起來的 y／m、卡片的核可或自己回時，落點改成題目', async ($, on) => {
  const w = world(detailed())
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await clock.advance(1_000)
  for (const kind of ['plugin', 'person'] as const) {
    for (const element of ['decide-all', 'decide-yes', 'decide-manual']) {
      await focusPane($, 'tab:pending', 'plugin')
      expect((await focusPane($, element, kind)).deny).toBeUndefined()
      expect(w.focused.at(-1)).toBe('detail:p1')
    }
    for (const id of ['p2', 'p3', 'p1']) {
      for (const verb of ['approve', 'manual']) {
        await focusPane($, 'tab:pending', 'plugin')
        await focusPane($, `${verb}:${id}`, kind)
        expect(w.focused.at(-1)).toBe(`detail:${id}`)
      }
    }
  }
  expect(decideCalls(w)).toEqual([])
  await ui.unmount()
})

test('待決焦點：從分頁標籤按 ↓ 選中的是第一題，不跳到第二題', async ($, on) => {
  const w = world(detailed())
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await clock.advance(1_000)
  await focusPane($, 'tab:decisions', 'person')
  expect(w.focused.at(-1)).toBe('tab:decisions')
  await focusPane($, 'decide-all', 'person')
  expect(w.focused.at(-1)).toBe('detail:p1')
  expect((await ui.find({ key: 'decision:p1' }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  await focusPane($, 'approve:p2', 'person')
  expect(w.focused.at(-1)).toBe('detail:p2')
  await ui.unmount()
})

test('待決浮層：↑↓ 換到別張卡或 Esc 把鍵盤交回輸入框就收起；開著時滾輪與翻頁鍵只捲浮層、不捲卡片；a 全部核可照舊', async ($, on) => {
  const w = world(withDecisions(DECISIONS.map(d => (d.id === 'p1' ? { ...d, context: Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行`).join('\n') } : d))))
  let engineScrolled = 0
  on('ui.scroll', async () => {
    engineScrolled += 1
    return {}
  })
  const clock = await start($, on, w)
  await openPane($)
  const view = 24
  const ui = await $.ui.mount({ ...pane(60, view), surface: 'terminal' })
  const scroll = (by: number, pointer?: object) => $.ui.scroll({ component: 'Pane', requestId: PANE, offset: 0, by, bodyRows: view, contentRows: 60, origin: { kind: 'person' }, ...(pointer && { pointer }) } as any)
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'detail:p1' })
  const box = findKey(await ui.drawn(), 'popover')
  expect(box.props.top + box.props.height).toBeLessThanOrEqual(view)
  const bottom = async () => (await popRows(ui))!.at(-1)!
  const body = box.props.height - 2
  expect(await bottom()).toMatch(new RegExp(`j/k 捲動 · 第 1–${body} 行／共 \\d+ 行`))
  expect(await scroll(1, { column: 3, row: 10 })).toEqual({})
  expect(await bottom()).toContain(`第 2–${body + 1} 行`)
  await scroll(view)
  expect(await bottom()).toContain(`第 ${2 + body}–${1 + 2 * body} 行`)
  await ui.press({ key: 'popover-up' })
  expect(await bottom()).toContain(`第 ${1 + body}–${2 * body} 行`)
  expect(engineScrolled).toBe(0)
  await focusPane($, 'detail:p2', 'person')
  expect((await ui.find({ key: 'decision:p2' }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  expect(await popRows(ui)).toBeNull()
  await scroll(1, { column: 3, row: 10 })
  expect(engineScrolled).toBe(1)
  await ui.press({ key: 'detail:p2' })
  expect(await popRows(ui)).not.toBeNull()
  await ui.press({ key: 'decide-all' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', '--all', 'approve'])
  await ui.unmount()
  w.focus = withDecisions()
  await clock.advance(5_000)
  const again = await $.ui.mount({ ...pane(60, view), surface: 'terminal' })
  await again.press({ key: 'tab:decisions' })
  await again.press({ key: 'detail:p1' })
  expect(await popRows(again)).not.toBeNull()
  await again.unmount()
  const away = await $.ui.mount({ ...pane(60, view), props: { ...pane(60, view).props, isFocused: false }, surface: 'terminal' })
  expect(findKey(await away.drawn(), 'popover')).toBeUndefined()
  await away.unmount()
})

test('待決分頁位置：有題時排第一 `r: 待決 N  q: 待回覆 N  w: 全部 N  e: 封存 N`，0 題時排最後；按鍵不跟著位置變', async ($, on) => {
  const w = world(withDecisions())
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await tabButtons(ui)).toEqual([['tab:decisions', 'r', '待決 3'], ['tab:pending', 'q', '待回覆 5'], ['tab:all', 'w', '全部 7'], ['tab:hidden', 'e', '封存 1']])
  w.focus = withDecisions([])
  await clock.advance(5_000)
  expect(await tabButtons(ui)).toEqual([['tab:pending', 'q', '待回覆 5'], ['tab:all', 'w', '全部 7'], ['tab:hidden', 'e', '封存 1'], ['tab:decisions', 'r', '待決 0']])
  await ui.unmount()
})

test('待決 0 開面板：有題時停在待決、選第一張卡；0 題時照舊停在待回覆', async ($, on) => {
  const w = world(withDecisions())
  const clock = await start($, on, w)
  await openPane($)
  let ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ key: 'tab:decisions' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'decision:p1' }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  expect((await ui.find({ key: 'detail:p1' }))?.props.autoFocus).toBe(true)
  expect(await cardTags(ui)).toEqual([])
  await ui.unmount()
  w.focus = withDecisions([])
  await clock.advance(5_000)
  await openPane($)
  ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ key: 'tab:pending' }))?.props.dimColor).toBe(false)
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  await ui.unmount()
})

test('待決清空：核可完最後一題停在待決的空白框、不自動跳分頁，分頁列已把待決移到最後；按 q 回待回覆', async ($, on) => {
  const w = world(withDecisions([DECISIONS[0]]))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'approve:p1' })
  expect(decideCalls(w)).toEqual([['decide', 'p1', 'approve']])
  expect(await ui.find({ key: 'decide-empty' })).toBeTruthy()
  expect((await ui.find({ key: 'tab:decisions' }))?.props.dimColor).toBe(false)
  expect(await tabButtons(ui)).toEqual([['tab:pending', 'q', '待回覆 5'], ['tab:all', 'w', '全部 7'], ['tab:hidden', 'e', '封存 1'], ['tab:decisions', 'r', '待決 0']])
  await ui.press({ key: 'tab:pending' })
  expect(await ui.find({ key: 'decide-empty' })).toBeFalsy()
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  await ui.unmount()
})

const LONG_Q = '舊的 feat/proj-7882-old 已經合併進 dev，CI 也綠了，遠端那條 branch 留著只會讓人誤推，要不要現在就把遠端的 branch 刪掉，本機的先留著？'
const LONG_REASON = '已合併進 dev 而且 CI 綠了，遠端留著沒有用處，之前同類題你都選刪掉'
const longDecisions = () => withDecisions([decision('p1', { question: LONG_Q, options: ['現在刪掉遠端與本機的 branch，一次清乾淨', '先留著'], reason: LONG_REASON }), DECISIONS[2]])

for (const cols of [40, 80]) {
  test(`待決卡片排版（${cols} 欄）：不畫外框、最多 3 行：動作與右上按鈕一行、題目一行（超寬以 … 截短）、建議一行；選項不在卡片上；每行都不超出面板`, async ($, on) => {
    const w = world(longDecisions())
    appearanceConfig.set(w, { theme: 'dracula', motion: false })
    await start($, on, w)
    await openPane($)
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const root = await ui.drawn()
    expect(textOf(root)).not.toMatch(/[╭╮╰╯║═╔╗╚╝]/)
    const box = findKey(root, 'decision:p1')
    expect(box.props.borderStyle).toBeUndefined()
    expect(box.children).toHaveLength(3)
    for (const row of box.children) expect(row.props.height).toBe(1)
    const lines = box.children.map(textOf)
    for (const line of lines) expect(columns(line)).toBeLessThanOrEqual(cols - 1)
    expect(lines[0]).toBe(` ${MARK_STILL} 刪遠端 branchy ✓ 核可 · m 自己回`)
    expect(lines.slice(1).every((l: string) => l.startsWith('   ') && !l.startsWith('    '))).toBe(true)
    expect(lines[1].endsWith('…')).toBe(true)
    expect(LONG_Q.startsWith(lines[1].slice(3, -1))).toBe(true)
    expect(lines[2].startsWith('   建議：a')).toBe(true)
    expect(lines.join('')).not.toContain('先留著')
    expect(await ui.find({ key: 'decision-option:p1:0' })).toBeFalsy()
    expect(findKey(root, 'decision:p3').props.marginTop).toBe(1)
    expect(textOf(findKey(root, 'decision:p3'))).toContain('建議：照草案寫入，草案你已看過')
    const theme = THEMES.dracula
    const other = findKey(root, 'decision:p3').children[0]
    expect([textOf(other.children[0]), other.children[1].children[0].props.color]).toEqual(['   ', theme.waiting])
    expect([textOf(box.children[0].children[0]), box.children[0].children[0].props.color]).toEqual([` ${MARK_STILL} `, theme.accent])
    await ui.unmount()
  })
}

test('待決卡片：↑↓ 一次移一張卡，y、m、a 照舊，Enter 開浮層', async ($, on) => {
  const w = world(longDecisions())
  const clock = await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  await focusPane($, 'detail:p1', 'plugin')
  await focusPane($, 'approve:p3', 'person')
  expect(w.focused.at(-1)).toBe('detail:p3')
  expect((await ui.find({ key: 'decision:p3' }))?.text.startsWith(` ${MARK_STILL}`)).toBe(true)
  await focusPane($, 'detail:p1', 'person')
  expect(w.focused.at(-1)).toBe('detail:p1')
  await ui.press({ key: 'detail:p1' })
  expect((await popRows(ui))![0]).toContain('刪遠端 branch')
  await ui.press({ key: 'decide-manual' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p1', 'manual'])
  await ui.press({ key: 'decide-yes' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p3', 'approve'])
  w.focus = longDecisions()
  await clock.advance(5_000)
  await ui.press({ key: 'decide-all' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', '--all', 'approve'])
  await ui.unmount()
})

test('全部分頁：正排在待決的 session 卡片狀態字寫「待決」；按它的數字只選卡片、不搬上橫條', async ($, on) => {
  const w = world({ ...withCards({ logging: { decide: true } as any }, 'perm', ['focusui', 'PROJ-6668', 'upgrade#2']), decisions: DECISIONS })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  expect((await ui.find({ key: `status:${keyOf('logging')}` }))?.text).toContain('待決')
  expect((await ui.find({ key: `status:${keyOf('logging')}` }))?.text).not.toContain('待回答')
  expect((await ui.find({ key: `status:${keyOf('focusui')}` }))?.text).toContain('待回答')
  await ui.press({ key: `num:${keyOf('logging')}` })
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await ui.press({ key: 'tab:pending' })
  expect(await cardTags(ui)).not.toContain('logging')
  await ui.unmount()
})

test('待決卡片換行：英文字整個移到下一行、不從中間切開；全形標點不落在行首；比一行還長的字才逐字切；每行不超過寬度', () => {
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
