import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { columns, statusCell } from './status-view.ts'
import { focusBandRows } from './worktree-console-focus.tsx'
import { THEMES } from './console-theme.ts'

const PLUGIN = 'worktree-console'
const PANE = 'worktree-console-pending'
const BRIEF = 'worktree-console-brief'
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

type World = { focus: any; decideFails?: string[]; closes?: string[]; notes?: string[][]; afterAuto?: any; answer?: string; submits?: string[]; sticky?: boolean; showFails?: boolean; lost?: number; dropped?: string[]; calls: string[][]; toasts: string[]; shown: string[]; writes: Record<string, string>; opened: any[]; hints: (string | undefined)[]; focused: string[] }
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

const brief = (bodyColumns = 60) => ({
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: BRIEF,
  props: { title: '摘要', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } as any,
})

// Enter on a card opens its recap dialog; 印出完整回報 there prints what Enter used to.
async function printFromBrief($: any, ui: any, key: string) {
  await ui.press({ key: `name:${key}` })
  const dialog = await $.ui.mount({ ...brief(), surface: 'terminal' })
  await dialog.press({ key: 'brief-print' })
  await dialog.unmount()
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
  on('ui.focus', async (_$, e) => {
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
  // Answers /focus-show as the focus-show mod does, with the saved report; `lost` drops that many as a busy console did, answering nothing.
  on('command.run', async (_$, e) => {
    if (world.showFails) throw new Error('no focus-show')
    if (e.command !== 'focus-show') return { text: '' }
    if (world.lost) {
      world.lost -= 1
      world.dropped = [...(world.dropped ?? []), e.args]
      return {}
    }
    world.shown.push(e.args)
    if (world.answer) return { text: world.answer }
    const [tag, id] = e.args.split(' ')
    return { text: world.writes[`${HOME}/show/${encodeURIComponent(tag)}${id ? `@${id}` : ''}.md`] ?? `[${tag}] 沒有可印的題目` }
  })
  on('ui.render', async ($, e) => {
    if (e.component === 'PromptHint') world.hints.push((e.props as any).tail)
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

test('漏印重送: after the toast, Enter on the card and 印出完整回報 print the question and reports it shown, so the next poll does not print it again', async ($, on) => {
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

test('the console\'s prompt hint ends with 「工作中 N · 已回覆 M」 after auto mode on: archived not counted, zeros written, kept fresh by the poll', async ($, on) => {
  const w = world(pending())
  const clock = await start($, on, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const h = await $.ui.mount({ ...hint, surface })
    expect(w.hints.at(-1)).toBe('工作中 1 · 已回覆 1')
    await h.unmount()
  }
  w.focus = { ...pending(), sessions: SESSIONS.map(s => (s.tag === 'logging' ? { ...s, status: '執行中', pending: false } : s)) }
  await clock.advance(5_000)
  const h = await $.ui.mount({ ...hint, surface: 'terminal' })
  expect(w.hints.at(-1)).toBe('工作中 2 · 已回覆 1')
  await h.unmount()
  w.focus = nothing()
  await clock.advance(5_000)
  const zero = await $.ui.mount({ ...hint, surface: 'terminal' })
  expect(w.hints.at(-1)).toBe('工作中 0 · 已回覆 0')
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
  expect((await texts(ui)).some((t: string) => t.startsWith('──'))).toBe(false)
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

test('pane groups by repo outside 待回覆: `── <repo> ── 共 N 個` counts every session of that repo, a blank line only between repos', async ($, on) => {
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
  expect((await ui.find({ key: 'repo:agent-skills' }))?.props.marginTop).toBe(0)
  expect((await ui.find({ key: 'repo:proj-v2-frontend' }))?.props.marginTop).toBe(1)
  await ui.unmount()
})

test('cards: number (none on the question on screen) and nickname button, status icon and word, stage on the right; the question in grey, no options; summary, never 建議; chosen is an accent double frame, its question not bold', async ($, on) => {
  const w = world(focusOf('focusui', ['perm', 'logging', 'PROJ-6668', 'upgrade#2']))
  await start($, on, w)
  await openPane($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(), surface })
    const first = await ui.find({ key: `card:${keyOf('focusui')}` })
    expect(first?.props).toMatchObject({ borderStyle: 'double', borderColor: THEMES.neutral.accent })
    expect(first?.text).toContain('展示 mod 的樣式要套在哪裡？')
    expect(first?.text).not.toMatch(/a\. |只套面板|橫條也改清單/)
    expect(first?.text).not.toContain('建議：')
    expect(first?.text).toContain('feat/focusui')
    expect(first?.text).toContain('◆ 待回答')
    expect(first?.text).toContain('規劃中')
    expect(first?.text).not.toMatch(/💬|🔐|⏸/)
    expect((await ui.find({ type: 'Text', text: '展示 mod' }))?.props).toMatchObject({ color: THEMES.neutral.dim, wrap: 'truncate-end' })
    expect((await ui.find({ type: 'Text', text: '展示 mod' }))?.props.bold).toBeFalsy()
    expect(await ui.find({ key: `num:${keyOf('focusui')}` })).toBeUndefined()
    expect((await ui.find({ key: `num:${keyOf('perm')}` }))?.props).toMatchObject({ hotkey: '1', label: '', plain: true })
    expect((await ui.find({ key: `name:${keyOf('focusui')}` }))?.props).toMatchObject({ label: 'focusui', plain: true })
    expect((await ui.find({ key: `name:${keyOf('focusui')}` }))?.props.hotkey).toBeUndefined()
    const other = await ui.find({ key: `card:${keyOf('perm')}` })
    expect(other?.props).toMatchObject({ borderStyle: 'round', borderColor: THEMES.neutral.border })
    expect((await ui.find({ type: 'Text', text: 'Bash rm' }))?.props).toMatchObject({ color: THEMES.neutral.dim })
    expect((await ui.find({ type: 'Text', text: 'Bash rm' }))?.props.bold).toBeFalsy()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }
})

const findKey = (node: any, key: string): any => (node?.props?.key === key ? node : (node?.children ?? []).map((c: any) => (typeof c === 'object' ? findKey(c, key) : null)).find(Boolean))
const textOf = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))

test('cards on 待回覆, 全部 (idle ones too) and 封存: header, one grey question row, corner line — 3 rows, no gap; a long or multi-line question is cut with … and never wraps; options never show', async ($, on) => {
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
      const box = findKey(await ui.drawn(), `card:${keyOf(tag)}`)
      expect(box.children.length).toBe(3)
      for (const child of box.children) expect(child.props.marginTop ?? 0).toBe(0)
      const q = box.children[1]
      expect(q.type).toBe('Text')
      expect(q.props).toMatchObject({ color: THEMES.neutral.dim, wrap: 'truncate-end' })
      expect(q.props.bold).toBeFalsy()
      const line = textOf(q)
      expect(line.startsWith('這是一個非常長的題目')).toBe(true)
      expect(line.endsWith('…')).toBe(true)
      expect(line).not.toContain('\n')
      expect(cells(line)).toBeLessThanOrEqual(cols - 6)
      expect(cells(line)).toBeGreaterThan(cols - 8)
      expect(textOf(box)).not.toMatch(/a\. |第一個選項|第二個選項/)
    }
    await ui.unmount()
  }
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
  expect((await ui.find({ key: `card:${keyOf('t10')}` }))?.props.borderStyle).toBe('double')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await printFromBrief($, ui, keyOf('t10'))
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('t10')])
  expect(w.shown.at(-1)).toBe('t10')
  await ui.unmount()
})

test('on 待回覆 a number switches the band to that card and the pane reorders with it; the card then has no number; Enter or the nickname, then 印出完整回報, prints', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  expect((await ui.find({ key: `card:${keyOf('perm')}` }))?.props.borderStyle).toBe('double')
  expect((await ui.find({ key: `num:${keyOf('PROJ-6668')}` }))?.props.hotkey).toBe('3')
  await ui.press({ key: `num:${keyOf('PROJ-6668')}` })
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('PROJ-6668')])
  expect(w.shown).toEqual(['PROJ-6668'])
  expect(await cardTags(ui)).toEqual(['PROJ-6668', 'perm', 'focusui', 'logging', 'upgrade#2'])
  expect(await ui.find({ key: `num:${keyOf('PROJ-6668')}` })).toBeUndefined()
  expect((await ui.find({ key: `num:${keyOf('perm')}` }))?.props.hotkey).toBe('1')
  expect((await ui.find({ key: `card:${keyOf('PROJ-6668')}` }))?.props.borderStyle).toBe('double')
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

test('arrow keys land on the nickname, so Enter always opens the recap that prints; the chosen card follows the arrows without switching', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: `num:${keyOf('focusui')}`, origin: { kind: 'person' } } as any)
  expect(w.focused.at(-1)).toBe(`name:${keyOf('focusui')}`)
  expect((await ui.find({ key: `card:${keyOf('focusui')}` }))?.props.borderStyle).toBe('double')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await arrowTo($, 'perm')
  await printFromBrief($, ui, keyOf('perm'))
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  await ui.unmount()
})

test('on the other tabs a number only chooses the card, Enter or the nickname then 印出完整回報 prints it; a card that also waits on you switches the band', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  await ui.press({ key: `num:${keyOf('tune')}` })
  await ui.press({ key: `num:${keyOf('tune')}` })
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect(w.shown).toEqual([])
  expect((await ui.find({ key: `card:${keyOf('tune')}` }))?.props.borderStyle).toBe('double')
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
  expect(w.hints.at(-1)).toBeUndefined()
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

const corner = async (ui: any, tag: string) => (await ui.find({ key: `corner:${keyOf(tag)}` }))?.text
const withRepos = (repos: Record<string, Partial<Card>>) => ({ ...pending(), sessions: SESSIONS.map(s => ({ ...s, ...repos[s.tag] })) })

test('card corner on 待回覆: the repo and the summary in the theme dim colour; the repo with no prefix on every card, choice questions too, never 建議; the summary on the right stays', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await corner(ui, 'perm')).toBe('hours-dashboard')
  expect(await corner(ui, 'upgrade#2')).toBe('proj-v2-frontend')
  expect(await corner(ui, 'focusui')).toBe('agent-skills')
  expect(await corner(ui, 'PROJ-6668')).toBe('proj-v2-frontend')
  expect((await ui.find({ type: 'Text', text: 'hours-dashboard' }))?.props.color).toBe(THEMES.neutral.dim)
  expect(paintOf(await ui.drawn(), 'feat/perm')?.color).toBe(THEMES.neutral.dim)
  expect((await ui.find({ key: `card:${keyOf('perm')}` }))?.text).toContain('feat/perm')
  expect((await ui.find({ key: `card:${keyOf('perm')}` }))?.text).not.toContain('repo：')
  for (const r of pending().sessions) expect((await ui.find({ key: `card:${r.key}` }))?.text ?? '').not.toContain('建議：')
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

test('卡片寬度: on 待回覆 the repo takes what the bottom right leaves, 2 columns apart, cut with …, gone under 4 columns; a narrow pane cuts the bottom right too; the bottom is one row at every width', async ($, on) => {
  const w = world(withRepos({ perm: { repo: 'proj-agents-configuration', summary: '專案檢視介面調整建議' }, 'upgrade#2': { repo: 'abcdefghijklmnopqrst' }, logging: { repo: '中控台中控台中控台中控台' } }))
  await start($, on, w)
  await openPane($)
  let ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await corner(ui, 'perm')).toBe('proj-agents-configuration')
  expect(await corner(ui, 'logging')).toBe('中控台中控台中控台中控台')
  await ui.unmount()
  ui = await $.ui.mount({ ...pane(46), surface: 'terminal' })
  expect(await corner(ui, 'perm')).toBe('proj-agents-confi…')
  expect(await corner(ui, 'upgrade#2')).toBe('abcdefghijklmnopqrst')
  expect(await corner(ui, 'logging')).toBe('中控台中控台中控台中控台')
  await ui.unmount()
  ui = await $.ui.mount({ ...pane(36), surface: 'terminal' })
  expect(await corner(ui, 'perm')).toBe('實作中')
  expect(await summaryOf(ui, 'perm')).toBe('專案檢視介面調…')
  await ui.unmount()
  for (const cols of [36, 40, 45, 46, 52, 70, 120]) {
    ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    for (const r of w.focus.sessions.filter((x: Card) => x.pending)) {
      const left = ((await corner(ui, r.tag)) ?? '').trim()
      const right = (await summaryOf(ui, r.tag))!
      expect(cardWidth(right)).toBeLessThanOrEqual(Math.min(20, cols - 6))
      expect(cardWidth(left) + (left ? 2 : 0) + cardWidth(right)).toBeLessThanOrEqual(cols - 6)
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
      const room = cols - 6 - 13 - (cols >= 46 ? 7 : 0)
      if (r.tag === long) expect(cardWidth(long) <= room ? label === long : label.endsWith('…') && long.startsWith(label.slice(0, -1))).toBe(true)
      expect(cardWidth(label)).toBeLessThanOrEqual(room)
    }
    await ui.unmount()
  }
})

test('card corner on 全部 and 封存 is blank on every card, choice questions too; never the repo or 建議', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  for (const tag of ['focusui', 'PROJ-6668', 'tune', 'perm', 'chart']) expect(await corner(ui, tag)).toBe('')
  await ui.press({ key: 'tab:hidden' })
  expect(await corner(ui, 'PROJ-6650')).toBe('')
  await ui.unmount()
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
const chosenTag = async (ui: any) => (await ui.findAll({ type: 'Box' })).find((b: any) => b.key?.startsWith('card:') && b.props.borderStyle === 'double')?.key.slice(5).replace(/@1$/, '')
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
const footerLines = async (ui: any) => {
  const root = await ui.drawn()
  const footer = root.children.find((c: any) => c.props.key === 'footer')
  return footer ? footer.children.map((t: any) => t.children.join('')) : null
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
  const small = await $.ui.mount({ ...pane(70, 19), surface: 'terminal' })
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
    [19, ['perm', 'q0', 'q1'], ['q7', 'q8', 'q9']],
    [18, ['perm', 'q0', 'q1'], ['q8', 'q9']],
  ] as const) {
    const ui = await $.ui.mount({ ...pane(70, rows), surface: 'terminal' })
    const scroll = (by: number, pointer?: object) => $.ui.scroll({ component: 'Pane', requestId: PANE, offset: 0, by, bodyRows: rows, contentRows: rows, origin: { kind: 'person' }, ...(pointer && { pointer }) } as any)
    const check = async (end: boolean) => {
      const root = await ui.drawn()
      expect(root.props.height).toBe(rows)
      const drawn = (await drawnTags(ui)).length
      const foot = end ? 2 : 0
      expect(await footerLines(ui)).toEqual(end ? [FOOTER_TEXT] : null)
      expect(2 + drawn * 5 + foot).toBeLessThanOrEqual(rows)
      expect(2 + (drawn + 1) * 5 + foot).toBeGreaterThan(rows)
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

test('the same pane height holds more cards than when the counts and keys were pinned under them', async ($, on) => {
  const many = queued(10)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  await start($, on, w)
  await openPane($)
  for (const rows of [17, 22, 27]) {
    const ui = await $.ui.mount({ ...pane(70, rows), surface: 'terminal' })
    expect((await drawnTags(ui)).length).toBe(Math.floor((rows - 2) / 5))
    expect((await drawnTags(ui)).length).toBeGreaterThan(Math.floor((rows - 5) / 5))
    await ui.unmount()
  }
})

test('↑↓ onto a card out of view scrolls the pane until that card shows whole', async ($, on) => {
  const many = queued(10)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(70, 19), surface: 'terminal' })
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

test('refined：46 欄以上階段是標頭右側灰色小標，更窄移到底列最前；未開工與無階段不顯示', async ($, on) => {
  const name = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const cards = [card('短名', { repo: 'claude-personal' }), card(name), card('無進度', { stage: '—' }), card('沒開工', { stage: '未開工' })]
  const w = world({ ...focusOf('短名', [name, '無進度', '沒開工']), sessions: cards })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  for (const cols of [80, 60, 59, 46, 45, 39, 36]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const header = cols >= 46
    const stage = await ui.find({ key: `stage:${cards[0]!.key}` })
    expect(stage?.text).toBe(header ? '實作中' : undefined)
    if (header) expect((await ui.find({ type: 'Text', text: '實作中' }))?.props.color).toBe('gray')
    expect(await ui.find({ key: `stage:${cards[2]!.key}` })).toBeUndefined()
    expect(await ui.find({ key: `stage:${cards[3]!.key}` })).toBeUndefined()
    expect((await ui.find({ key: `card:${cards[3]!.key}` }))!.text).not.toContain('未開工')
    for (const c of cards) {
      expect((await ui.find({ key: `card:${c.key}` }))!.text).not.toContain('階段')
      expect((await ui.find({ key: `summary:${c.key}` }))!.text).not.toContain('實作中')
    }
    const corner = (await ui.find({ key: `corner:${cards[0]!.key}` }))!.text
    if (header) expect(corner).toBe('claude-personal')
    else if (cols === 36) expect(corner).toBe('實作中')
    else expect(corner).toMatch(/^實作中 · claude/)
    expect((await ui.find({ key: `corner:${cards[2]!.key}` }))!.text).not.toContain('·')
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

test('refined neutral：底列摘要與 repo、問題同為 dim 灰，階段小標也是 dim 且不加粗', async ($, on) => {
  const c = card('甲', { repo: 'frontend', summary: '現場報工端埋' })
  const w = world({ ...focusOf('甲', []), sessions: [c] })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(paintOf(await ui.drawn(), '現場報工端埋')?.color).toBe('gray')
  const stage = await ui.find({ type: 'Text', text: '實作中' })
  expect(stage?.props.color).toBe('gray')
  expect(stage?.props.bold).toBeFalsy()
  await ui.unmount()
})

for (const cols of [36, 46, 70, 80]) {
  test(`refined：${cols} 欄 repo／階段／長摘要底列只佔一行`, async ($, on) => {
    const c = card('甲', { repo: 'frontend', summary: '現場報工端埋-posthog-完整摘要' })
    const w = world({ ...focusOf('甲', []), sessions: [c] })
    appearanceConfig.set(w, { motion: false })
    await start($, on, w)
    await openPane($)
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const [drawn] = await mountedCards(ui)
    const lines = cardLines(drawn!.children!.at(-1)!, cols - 6).filter(line => line.trim())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(cols === 36 ? '實作中' : cols < 46 ? '實作中 · frontend' : 'frontend')
    if (cols >= 46) expect(lines[0]).not.toContain('實作中')
    expect(lines[0]).toContain('現場報工端埋')
    expect(lines[0]).toContain('…')
    expect(cardWidth(lines[0]!)).toBeLessThanOrEqual(cols - 6)
    if (cols === 36) expect(lines[0]).not.toContain('frontend')
    await ui.unmount()
  })

  for (const options of [[], ['繼續', '停止']]) {
    test(`refined：${cols} 欄${options.length ? '有選項' : '無選項'}未選卡與選中卡等高、問題緊接標頭只佔一行、不顯示選項、編號後留一格`, async ($, on) => {
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
      expect(a).toHaveLength(5)
      expect(a[2]).toBe('要繼續嗎？')
      expect(b[2]).toBe('要繼續嗎？')
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

test('refined：只有焦點框的名稱加粗；摘要只有開頭的數字提亮，字中數字與狀態字都不加粗', async ($, on) => {
  const cards = [card('甲', { repo: 'frontend', summary: '1 未核對', status: '等待授權' }), card('乙', { repo: 'frontend', summary: '面板 v2 改版', status: '回覆完畢' }), card('丙', { summary: '123456789012345678901234 項', archived: true, pending: false })]
  const w = world({ ...focusOf('甲', ['乙']), sessions: cards })
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
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
  expect(all.filter((x: any) => x.props.bold)).toEqual([])
  await ui.press({ key: 'tab:all' })
  expect((await ui.findAll({ type: 'Text' })).filter((x: any) => x.props.bold)).toEqual([])
  expect(paintOf(await ui.drawn(), 'frontend')?.color).toBeUndefined()
  await ui.press({ key: 'tab:hidden' })
  expect((await ui.findAll({ type: 'Text' })).map((x: any) => x.text)).toContain('丙  ')
  expect((await ui.findAll({ type: 'Text' })).filter((x: any) => x.props.bold)).toEqual([])
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
  for (const [status, text, color] of cases) {
    const row = await ui.find({ key: `status:${cards[cases.findIndex(c => c[0] === status)]!.key}` })
    expect(row?.text).toContain(text)
    expect((await ui.find({ type: 'Text', text: ` ${statusCell(status, 0).label}` }))?.props.color).toBe(color)
  }
  await ui.unmount()
})

test('refined：主題只換顏色，無效設定只提示一次且每次開面板重讀', async ($, on) => {
  const w = world(pending())
  const config: AppearanceConfig = { theme: 'dracula', motion: false }
  appearanceConfig.set(w, config)
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect((await ui.find({ key: `card:${keyOf('perm')}` }))?.props.borderColor).toBe('#8be9fd')
  expect((await ui.find({ key: `card:${keyOf('focusui')}` }))?.props.borderColor).toBe('#9aa1c2')
  const original = await cardTags(ui)
  for (const [name, accent, border] of [
    ['neutral', 'cyan', 'gray'], ['neutral-light', '#0f7c8c', '#868a92'],
    ['dracula', '#8be9fd', '#9aa1c2'], ['gruvbox', '#fbf1c7', '#928374'], ['light', '#1f7a73', '#7f8f90'],
  ]) {
    config.theme = name
    await openPane($)
    expect((await ui.find({ key: 'card:perm@1' }))?.props.borderColor).toBe(accent)
    expect((await ui.find({ key: 'card:focusui@1' }))?.props.borderColor).toBe(border)
    expect(await cardTags(ui)).toEqual(original)
  }
  config.theme = '不存在'
  await openPane($)
  expect((await ui.find({ key: `card:${keyOf('perm')}` }))?.props.borderColor).toBe('cyan')
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
    const focusBand = await $.ui.mount({ ...band(80), surface: 'terminal' })
    for (const [elapsed, glyphColor] of [[0, blocked], [1_200, dim]] as const) {
      await clock.advance(elapsed)
      expect((await ui.find({ type: 'Text', text: '◆' }))?.props.color).toBe(glyphColor)
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
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
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
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const focusBand = await $.ui.mount({ ...band(80), surface: 'terminal' })
  const before = invalidations
  await clock.advance(1_050)
  expect(invalidations).toBe(before)
  await clock.advance(150)
  expect(invalidations).toBe(before + 1)
  for (const tag of ['perm', '另一授權']) expect((await ui.find({ key: `status:${keyOf(tag)}` }))?.text).toContain('◆ 待授權')
  expect((await ui.findAll({ type: 'Text', text: '◆' })).map(t => t.props.color)).toEqual(['gray', 'gray', 'yellow'])
  expect((await focusBand.find({ type: 'Text', text: '◆' }))?.props.color).toBe('gray')
  expect((await focusBand.find({ type: 'Text', text: ' 待授權' }))?.props.color).toBe('magentaBright')
  expect((await focusBand.find({ type: 'Text', text: '│ ' }))?.props.color).toBe('magentaBright')
  expect((await ui.find({ type: 'Text', text: ' 待授權' }))?.props.color).toBe('magentaBright')
  await clock.advance(600)
  expect(invalidations).toBe(before + 2)
  expect((await focusBand.find({ type: 'Text', text: '◆' }))?.props.color).toBe('magentaBright')
  config.motion = false
  await openPane($)
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
  const ui = await $.ui.mount({ ...pane(46), surface: 'terminal' })
  const before = invalidations
  await clock.advance(900)
  expect(invalidations).toBe(before + 1)
  expect((await ui.find({ key: 'status:focusui@1' }))?.text).toContain('◇ 待回答')
  await clock.advance(300)
  expect(invalidations).toBe(before + 2)
  expect((await ui.find({ type: 'Text', text: '◆' }))?.props.color).toBe('gray')
  await clock.advance(600)
  expect(invalidations).toBe(before + 3)
  expect((await ui.find({ key: 'status:focusui@1' }))?.text).toContain('◆ 待回答')
  await ui.unmount()
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

test('refined：計數改用工作中與已回覆，選中問題不加粗', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  const h = await $.ui.mount({ ...hint, surface: 'terminal' })
  expect(w.hints.at(-1)).toBe('工作中 1 · 已回覆 1')
  await h.unmount()
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

test('refined：上下選卡不切換問題，Enter 開摘要小面板、按印出完整回報才顯示選中的題目', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const arrow = arrows($, ui, w)
  await arrow(1)
  expect(await chosenTag(ui)).toBe('focusui')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await printFromBrief($, ui, 'focusui@1')
  expect(w.shown.at(-1)).toBe('focusui')
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
  const ui = await $.ui.mount({ ...pane(80, 26), surface: 'terminal' })
  expect(await drawnTags(ui)).toEqual(['perm', 'q0', 'q1', 'q2'])
  await $.ui.scroll({ component: 'Pane', requestId: PANE, offset: 0, by: 1, bodyRows: 26, contentRows: 26, origin: { kind: 'person' } })
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
  expect((await ui.find({ key: 'card:perm@1' }))?.props.borderColor).toBe('cyan')
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
    expect((await ui.find({ key: 'card:perm@1' }))?.props.borderColor).toBe(THEMES.dracula.accent)
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
  const cards = [card('abcdefghijklmnopqrst'), card('abcdefghijklmnopq'), card('ABCDEFGHIJ', { archived: true, pending: false }), card('ABCDEFG', { archived: true, pending: false })]
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
        const text = node.type === 'Button' ? `${node.props?.hotkey ?? ''}${node.props?.label ?? ''}` : (node.children ?? []).map(rowText).join('')
        const cells = [...text].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/u.test(c) ? 2 : 1), 0)
        return text + ' '.repeat(Math.max(0, (node.props?.width ?? cells) - cells))
      }
      const rendered = rowText(row)
      const name = target.tag
      expect(rendered.includes(name)).toBe(true)
      const cells = [...rendered].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uffef]/u.test(c) ? 2 : 1), 0)
      expect(cells).toBeLessThanOrEqual(cols - 6)
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

test('卡片 ✓ 建議: a card whose suggestion is ready reads ✓ (accent) 建議 (dim) on its header right, before the stage; below 46 columns only ✓; the header stays one row', async ($, on) => {
  const w = world(withCards({ focusui: { advice: READY }, logging: { advice: { state: 'pending', text: '建議產生中… 3 秒' } }, 'PROJ-6668': { advice: null } }))
  await start($, on, w)
  await openPane($)
  for (const cols of [70, 46]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    const hint = await ui.find({ key: `hint:${keyOf('focusui')}` })
    expect(textOf(hint)).toBe('✓ 建議')
    expect(paintOf(hint, '✓')?.color).toBe(THEMES.neutral.accent)
    expect(paintOf(hint, ' 建議')?.color).toBe(THEMES.neutral.dim)
    const right = findKey(await ui.drawn(), `right:${keyOf('focusui')}`)
    expect(textOf(right)).toBe('✓ 建議規劃中')
    const header = findKey(await ui.drawn(), `card:${keyOf('focusui')}`).children[0]
    expect(cells(textOf(header))).toBeLessThanOrEqual(cols - 6)
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(textOf(await narrow.find({ key: `hint:${keyOf('focusui')}` }))).toBe('✓')
  const header = findKey(await narrow.drawn(), `card:${keyOf('focusui')}`).children[0]
  expect(cells(textOf(header))).toBeLessThanOrEqual(40 - 6)
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

test('摘要小面板: Enter on a card (or a click on its nickname) opens that session\'s recap in a dialog with the keyboard that Esc closes; nothing is printed or sent to the conversation', async ($, on) => {
  const text = '登入頁改好了，測試都過。等你決定要不要也改註冊頁。'
  const w = { ...world(withCards({ logging: { brief: { text, pending: false } } })), submits: [] as string[] }
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const before = w.calls.length
  await ui.press({ key: `name:${keyOf('logging')}` })
  expect(w.opened.at(-1)).toMatchObject({ id: BRIEF, title: 'logging 摘要', focus: true, closeOnEscape: true })
  expect(w.shown).toEqual([])
  expect(w.submits).toEqual([])
  expect(w.calls.slice(before).filter(c => c[0] !== 'focus')).toEqual([])
  const dialog = await $.ui.mount({ ...brief(), surface: 'terminal' })
  expect(textOf(await dialog.find({ key: 'brief-text' }))).toBe(text)
  expect((await dialog.find({ key: 'brief-print' }))?.props).toMatchObject({ label: '印出完整回報' })
  await dialog.unmount()
  await ui.unmount()
})

test('摘要小面板: a session with no recap yet says 還沒有摘要; one being written says 摘要產生中…, and a newer one being written under an old recap says so under it', async ($, on) => {
  const w = world(withCards({ logging: { brief: { text: null, pending: true } }, 'PROJ-6668': { brief: { text: '上一份摘要。', pending: true } } }))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const read = async (tag: string) => {
    await ui.press({ key: `name:${keyOf(tag)}` })
    const dialog = await $.ui.mount({ ...brief(), surface: 'terminal' })
    const out = [textOf(await dialog.find({ key: 'brief-text' })), textOf(await dialog.find({ key: 'brief-pending' }))]
    await dialog.unmount()
    return out
  }
  expect(await read('perm')).toEqual(['還沒有摘要', ''])
  expect(await read('logging')).toEqual(['摘要產生中…', ''])
  expect(await read('PROJ-6668')).toEqual(['上一份摘要。', '新的摘要產生中…'])
  await ui.unmount()
})

test('摘要小面板: 印出完整回報 closes the dialog and prints exactly the report Enter used to print, through /focus-show, for the band question and a queued one', async ($, on) => {
  const closes: string[] = []
  const w = { ...world(withCards({}, 'perm', ['focusui', 'logging'])), closes }
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const report = (tag: string) => SESSIONS.find(s => s.tag === tag)!.report
  await printFromBrief($, ui, keyOf('perm'))
  expect(w.shown).toEqual([`perm ${idOf(keyOf('perm'))}`])
  expect(w.writes[`${HOME}/show/perm@${idOf(keyOf('perm'))}.md`]).toBe(report('perm'))
  expect(closes).toContain(BRIEF)
  await printFromBrief($, ui, keyOf('logging'))
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([['focus-pick', keyOf('logging')]])
  expect(w.shown.at(-1)).toBe('logging')
  expect(w.writes[`${HOME}/show/logging.md`]).toBe(report('logging'))
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
  expect(await tabButtons(ui)).toEqual([['tab:pending', 'q', '待回覆 5'], ['tab:all', 'w', '全部 7'], ['tab:hidden', 'e', '封存 1'], ['tab:decisions', 'r', '待決 3']])
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

test('待決：a 全部核可跑 decide --all approve；送出失敗的題留在清單標「送出失敗」，外框換成錯誤色，浮動通知寫成功與失敗各幾題', async ($, on) => {
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

const DETAIL = 'worktree-console-decision'
const detailPane = (bodyColumns = 60) => ({ plugin: PLUGIN, component: 'Pane' as const, requestId: DETAIL, props: { title: '待決', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as any })
const LONG_REPLY = '舊的 feat/proj-7882-old 已經合併進 dev，CI 也綠了。\n\n我想把遠端的 branch 刪掉，免得之後有人誤推。\n\n- **A**：刪掉\n- **B**：先留著\n\n要刪掉遠端的嗎？'
const detailed = () => withDecisions(DECISIONS.map(d => (d.id === 'p1' ? { ...d, stage: '實作中', context: LONG_REPLY, precedent: { question: '要刪掉 feat/proj-7001 的遠端 branch 嗎？', answer: 'a' } } : d)))
const decideCalls = (w: World) => w.calls.filter(c => c[0] === 'decide')

test('待決詳情：Enter（選中卡片的題目）或點題目開詳情小視窗，可按 Esc 關；Enter 不再核可，什麼都不送也不進對話', async ($, on) => {
  const w = world(detailed())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  const first = await ui.find({ key: 'detail:p1' })
  expect(first?.props.autoFocus).toBe(true)
  await ui.press({ key: 'detail:p1' })
  expect(w.opened.at(-1)).toMatchObject({ id: DETAIL, title: 'PROJ-7882 待決', focus: true, closeOnEscape: true })
  expect(decideCalls(w)).toEqual([])
  expect(w.shown).toEqual([])
  await ui.press({ key: 'detail:p3' })
  expect(w.opened.at(-1)).toMatchObject({ id: DETAIL, title: 'weekly 待決' })
  expect((await ui.find({ key: 'decision:p3' }))?.props.borderStyle).toBe('double')
  expect(decideCalls(w)).toEqual([])
  await ui.unmount()
})

test('待決詳情：動作、代號、repo、階段，子 session 那則回覆全文、advisor 建議與理由、參考的前例；長內容換行不截斷', async ($, on) => {
  const w = world(detailed())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'detail:p1' })
  for (const cols of [40, 60]) {
    const dialog = await $.ui.mount({ ...detailPane(cols), surface: 'terminal' })
    expect((await dialog.find({ key: 'detail-head' }))!.text).toContain('刪遠端 branch')
    expect((await dialog.find({ key: 'detail-head' }))!.text).toContain('PROJ-7882 · proj-v2-frontend · 實作中')
    const context = await dialog.find({ key: 'detail-context' })
    expect(context!.text).toContain(LONG_REPLY)
    expect((await dialog.findAll({ type: 'Text' })).find((t: any) => t.text === LONG_REPLY)?.props.wrap).toBe('wrap')
    expect((await dialog.find({ key: 'detail-advice' }))!.text).toContain('建議：a 刪掉，已合併進 dev，留著沒用')
    expect((await dialog.find({ key: 'detail-precedent' }))!.text).toContain('要刪掉 feat/proj-7001 的遠端 branch 嗎？')
    expect((await dialog.findAll({ type: 'Button' })).map((b: any) => [b.key, b.props.hotkey, b.props.label])).toEqual([['detail-approve', 'y', '✓ 核可'], ['detail-manual', 'm', '自己回']])
    await dialog.unmount()
  }
  await ui.unmount()
})

test('待決詳情：沒有前例時不畫前例；送出失敗的題寫上次沒送進子 session', async ($, on) => {
  const w = world(withDecisions(DECISIONS.map(d => (d.id === 'p3' ? { ...d, failed: true } : d))))
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'detail:p3' })
  const dialog = await $.ui.mount({ ...detailPane(), surface: 'terminal' })
  expect(await dialog.find({ key: 'detail-precedent' })).toBeFalsy()
  expect((await dialog.find({ key: 'detail-head' }))!.text).toContain('上次核可沒送進子 session')
  expect((await dialog.find({ key: 'detail-context' }))!.text).toContain('草案確認了，要寫進 Linear 嗎？')
  await dialog.unmount()
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

test('待決詳情：小視窗的「✓ 核可」「自己回」跟卡片上的一樣，按了先關小視窗', async ($, on) => {
  const w = world(detailed())
  w.closes = []
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'detail:p1' })
  let dialog = await $.ui.mount({ ...detailPane(), surface: 'terminal' })
  await dialog.press({ key: 'detail-manual' })
  await dialog.unmount()
  expect(w.closes).toEqual([DETAIL])
  await ui.press({ key: 'detail:p3' })
  dialog = await $.ui.mount({ ...detailPane(), surface: 'terminal' })
  await dialog.press({ key: 'detail-approve' })
  await dialog.unmount()
  expect(w.closes).toEqual([DETAIL, DETAIL])
  expect(decideCalls(w)).toEqual([['decide', 'p1', 'manual'], ['decide', 'p3', 'approve']])
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
  expect((await ui.find({ key: 'decision:p3' }))?.props.borderStyle).toBe('double')
  expect((await ui.find({ key: 'decision-right:p3' }))?.text).toBe('y ✓ 核可 · m 自己回')
  expect((await ui.find({ key: 'decision-right:p2' }))?.text).toBe('✓ 核可 · 自己回')
  await ui.press({ key: 'decide-yes' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p3', 'approve'])
  await ui.unmount()
})

const focusPane = ($: any, element: string, kind: 'person' | 'plugin' = 'person', requestId = PANE) =>
  $.ui.focus({ component: 'Pane', requestId, plugin: PLUGIN, element, origin: kind === 'person' ? { kind } : { kind, name: PLUGIN } } as any)

// The test kit has no `$.ui.focus` for a mod, so the move the mod asks on the switch is checked by hand; these check where a stale place lands.
test('待決焦點：待回覆選了第一張卡後按 r 切到待決，引擎留在舊位置（落在全部核可或第一題的 ✓ 核可）時落點改成題目；直接按 Enter 只開詳情，不核可', async ($, on) => {
  const w = world(detailed())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const buttons = async () => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key) as string[]
  await focusPane($, `name:${keyOf('perm')}`, 'plugin')
  const at = (await buttons()).indexOf(w.focused.at(-1)!)
  await ui.press({ key: 'tab:decisions' })
  const keys = await buttons()
  expect(keys.slice(at, at + 2)).toEqual(['decide-all', 'approve:p1'])
  for (const stale of keys.slice(at, at + 2)) {
    await focusPane($, stale, 'plugin')
    expect(w.focused.at(-1)).toBe('detail:p1')
    await ui.press({ key: w.focused.at(-1)! })
    expect(w.opened.at(-1)).toMatchObject({ id: DETAIL })
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
  expect((await ui.find({ key: 'decision:p3' }))?.props.borderStyle).toBe('double')
  await ui.press({ key: 'decide-manual' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p3', 'manual'])
  expect((await ui.find({ key: 'decision:p4' }))?.props.borderStyle).toBe('double')
  await ui.press({ key: 'decide-yes' })
  expect(decideCalls(w).at(-1)).toEqual(['decide', 'p4', 'approve'])
  expect((await ui.find({ key: 'decision:p1' }))?.props.borderStyle).toBe('double')
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
  expect((await ui.find({ key: 'decision:p1' }))?.props.borderStyle).toBe('double')
  await focusPane($, 'approve:p2', 'person')
  expect(w.focused.at(-1)).toBe('detail:p2')
  await ui.unmount()
})

test('待決詳情焦點：方向鍵或 Tab 走不到「✓ 核可」「自己回」（焦點留在原處），y、m 照舊核可、自己回', async ($, on) => {
  const w = world(detailed())
  w.closes = []
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:decisions' })
  await ui.press({ key: 'detail:p1' })
  let dialog = await $.ui.mount({ ...detailPane(), surface: 'terminal' })
  const before = w.focused.length
  for (const element of ['detail-approve', 'detail-manual']) {
    for (const kind of ['person', 'plugin'] as const) expect((await focusPane($, element, kind, DETAIL)).deny).toBeTruthy()
  }
  expect(w.focused.length).toBe(before)
  await dialog.press({ key: 'detail-manual' })
  await dialog.unmount()
  await ui.press({ key: 'detail:p3' })
  dialog = await $.ui.mount({ ...detailPane(), surface: 'terminal' })
  await dialog.press({ key: 'detail-approve' })
  await dialog.unmount()
  expect(decideCalls(w)).toEqual([['decide', 'p1', 'manual'], ['decide', 'p3', 'approve']])
  await ui.unmount()
})
