import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { statusCell } from './status-view.ts'
import { focusBandRows } from './worktree-console-focus.tsx'

const PLUGIN = 'worktree-console'
const PANE = 'worktree-console-pending'
const HOME = '/tmp/wtc-home'

type Card = {
  key: string
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
const stopId = (key: string) => [...key].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36)

type World = { focus: any; submits?: string[]; sticky?: boolean; showFails?: boolean; lost?: number; dropped?: string[]; calls: string[][]; toasts: string[]; shown: string[]; writes: Record<string, string>; opened: any[]; hints: (string | undefined)[]; focused: string[] }
type AppearanceConfig = { appearance?: string; theme?: string; motion?: unknown }
const appearanceConfig = new WeakMap<World, AppearanceConfig>()

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
    const args = e.argv.slice(2)
    world.calls.push([...args])
    const f = world.focus
    if (args[0] === 'focus-pick' && f.active) {
      const keys = [f.current, ...f.queue.map((q: any) => q.key)]
      world.focus = { ...f, current: args[1], queue: keys.filter(k => k !== args[1]).map(key => ({ key, isNew: false })), announce: f.sessions.find((s: Card) => s.key === args[1]).tag }
    } else if (args[0] === 'focus-later' && f.active) {
      const [next, ...rest] = f.queue
      world.focus = { ...f, current: next.key, queue: [...rest, { key: f.current, isNew: false }], announce: f.sessions.find((s: Card) => s.key === next.key).tag }
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

const hint = { plugin: PLUGIN, component: 'PromptHint' as const, props: { isDraft: false, isWorking: false, hint: 'auto mode on' } }

async function start($: any, on: On, world: World, env: Record<string, string> = { ORCA_TERMINAL_HANDLE: 'term_self' }) {
  mock.env(on, env)
  const clock = mock.clock(on, { now: 1_000 })
  on('fs.read', async () => ({ value: JSON.stringify(appearanceConfig.get(world) ?? { appearance: 'classic' }) }))
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
  on('ui.close', async () => ({ value: undefined }))
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

test('band: status tag, nickname button and stage; the whole question; 0 面板, queue 1–5, 8 延後處理, 9 題目', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(), surface })
    expect(await texts(ui)).toEqual([' 等待授權 ', ' ', ' ', ' 實作中 ', 'Bash rm -rf build'])
    expect(await labels(ui)).toEqual(['perm', '0: 面板', '1: focusui', '2: logging', '3: PROJ-6668', '4: upgrade#2', '8: 延後處理', '9: 顯示問題'])
    expect((await ui.find({ key: 'queue:0' }))?.props.dimColor).toBe(true)
    expect((await ui.find({ key: 'show-tag' }))?.props.hotkey).toBeUndefined()
    await ui.unmount()
  }
})

test('band: the queue shows at most 5 (1–5) and a new one is marked ✨; nothing sits on 6 or 7; 8 延後處理 only while the queue has one', async ($, on) => {
  const many = Array.from({ length: 9 }, (_, i) => card(`t${i}`))
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  w.focus.queue[1].isNew = true
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect((await labels(ui)).slice(1)).toEqual(['0: 面板', '1: t0', '2: t1 ✨', '3: t2', '4: t3', '5: t4', '8: 延後處理', '9: 顯示問題'])
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => ['6', '7'].includes(b.props.hotkey))).toEqual([])
  await ui.unmount()
  w.focus = focusOf('perm', [])
  await clock.advance(5_000)
  const alone = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await labels(alone)).toEqual(['perm', '0: 面板', '9: 顯示問題'])
  await alone.unmount()
})

test('band: a long question wraps whole and is cut with … only past the room the band has', async ($, on) => {
  const long = '這是一題很長的問題，'.repeat(30)
  const w = world({ ...pending(), sessions: SESSIONS.map(s => (s.tag === 'perm' ? { ...s, question: long } : s)) })
  await start($, on, w)
  const roomy = await $.ui.mount({ ...band(160, 20), surface: 'terminal' })
  expect((await texts(roomy)).at(-1)).toBe(long)
  expect((await roomy.find({ type: 'Text', text: '這是一題' }))?.props.wrap).toBe('wrap')
  await roomy.unmount()
  const tight = await $.ui.mount({ ...band(40, 6), surface: 'terminal' })
  const cut = (await texts(tight)).at(-1)!
  expect(cut.endsWith('…')).toBe(true)
  expect(long.startsWith(cut.slice(0, -1))).toBe(true)
  await tight.unmount()
})

test('band keys: 1–5 switch to that question and print it, 8 (延後處理) sends it behind the queue and prints the next, 9 (顯示問題) and the nickname print the one on screen, 0 opens the pane with the keyboard', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  await ui.press({ key: 'queue:2' })
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('PROJ-6668')])
  expect(w.shown).toEqual(['PROJ-6668'])
  expect(w.writes[`${HOME}/show/PROJ-6668.md`]).toContain('### 💬 PROJ-6668 等你回應')
  expect(await labels(ui)).toEqual(['PROJ-6668', '0: 面板', '1: perm', '2: focusui', '3: logging', '4: upgrade#2', '8: 延後處理', '9: 顯示問題'])
  await ui.press({ key: 'later' })
  expect(w.calls.at(-1)).toEqual(['focus-later'])
  expect(w.shown.at(-1)).toBe('perm')
  expect(await labels(ui)).toEqual(['perm', '0: 面板', '1: focusui', '2: logging', '3: upgrade#2', '4: PROJ-6668', '8: 延後處理', '9: 顯示問題'])
  await ui.press({ key: 'queue:3' })
  expect((await ui.find({ key: 'show-tag' }))?.props.label).toBe('PROJ-6668')
  expect((await ui.find({ key: 'show' }))?.props).toMatchObject({ hotkey: '9', label: '顯示問題' })
  expect(await labels(ui)).not.toContain('9: 題目')
  await ui.press({ key: 'show' })
  await ui.press({ key: 'show-tag' })
  expect(w.shown.slice(-2)).toEqual(Array(2).fill(`PROJ-6668 ${stopId(keyOf('PROJ-6668'))}`))
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
  expect((await ui.find({ key: 'show-tag' }))?.props.label).toBe('perm')
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
  expect(w.shown).toEqual([`perm ${stopId(keyOf('perm'))}`])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
  const poll = w.calls.find(c => c[0] === 'focus')!
  expect(poll.slice(1)).toEqual(['--session', 'console-session'])
})

test('a stop that left the band and came back is announced again, so a print skipped while it was away is not lost', async ($, on) => {
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true }
  const clock = await start($, on, w)
  w.focus = { ...focusOf('focusui', ['perm']), announce: 'focusui', announceKey: keyOf('focusui') }
  await clock.advance(5_000)
  w.focus = { ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }
  await clock.advance(5_000)
  await clock.advance(5_000)
  const id = stopId(keyOf('perm'))
  expect(w.shown).toEqual([`perm ${id}`, `focusui ${stopId(keyOf('focusui'))}`, `perm ${id}`])
})

test('an announced stop is printed with its id from a file of its own, and the plain 代號 file stays fresh for a hand-typed /focus-show', async ($, on) => {
  const w = world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') })
  await start($, on, w)
  const id = stopId(keyOf('perm'))
  expect(w.shown).toEqual([`perm ${id}`])
  expect(w.writes[`${HOME}/show/perm@${id}.md`]).toBe(SESSIONS.find(s => s.tag === 'perm')!.report)
  expect(w.writes[`${HOME}/show/perm.md`]).toBe(SESSIONS.find(s => s.tag === 'perm')!.report)
})

test('漏印重送: a /focus-show the console drops (it answers without the report) is not reported as shown and goes again on the next poll; printed once, then focus-shown once', async ($, on) => {
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, lost: 1 }
  const clock = await start($, on, w)
  const id = stopId(keyOf('perm'))
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

test('漏印重送: three misses in a row toast 「[perm] 題目沒印出，按 Enter 印」 once; it keeps trying and prints once the console takes it', async ($, on) => {
  const w = { ...world({ ...focusOf('perm', ['focusui']), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, lost: 4 }
  const clock = await start($, on, w)
  const id = stopId(keyOf('perm'))
  await clock.advance(5_000)
  expect(w.toasts).toEqual([])
  await clock.advance(5_000)
  expect(w.toasts).toEqual(['[perm] 題目沒印出，按 Enter 印'])
  await clock.advance(5_000)
  expect(w.toasts).toEqual(['[perm] 題目沒印出，按 Enter 印'])
  expect(w.shown).toEqual([])
  await clock.advance(5_000)
  expect(w.dropped).toEqual(Array(4).fill(`perm ${id}`))
  expect(w.shown).toEqual([`perm ${id}`])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
  await clock.advance(5_000)
  expect(w.shown).toEqual([`perm ${id}`])
})

test('漏印重送: after the toast, Enter on the card prints the question and reports it shown, so the next poll does not print it again', async ($, on) => {
  const lone = { ...world({ ...focusOf('perm', []), announce: 'perm', announceKey: keyOf('perm') }), sticky: true, lost: 3 }
  const clock = await start($, on, lone)
  const id = stopId(keyOf('perm'))
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(lone.toasts).toEqual(['[perm] 題目沒印出，按 Enter 印'])
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: `name:${keyOf('perm')}` })
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

test('漏印重送: 回完答案後 60 秒內同一 session 又出題 while the console is still on its turn; /focus-show <代號> <編號> of the new stop is sent again and printed once', async ($, on) => {
  const first = focusOf('perm', ['focusui'])
  const w = { ...world({ ...first, announce: 'perm', announceKey: keyOf('perm') }), sticky: true }
  const clock = await start($, on, w)
  expect(w.shown).toEqual([`perm ${stopId(keyOf('perm'))}`])
  w.focus = { ...first, current: null, waiting: { tag: 'perm', seconds: 60 }, announce: null, announceKey: null }
  await clock.advance(5_000)
  const next = 'perm@2'
  const report = '### 🔐 perm 等你授權\n\n> Bash rm -rf dist'
  const sessions = SESSIONS.map(s => (s.tag === 'perm' ? { ...s, key: next, question: 'Bash rm -rf dist', report } : s))
  w.focus = { ...first, current: next, sessions, waiting: null, announce: 'perm', announceKey: next }
  w.lost = 1
  await clock.advance(5_000)
  expect(w.dropped).toEqual([`perm ${stopId(next)}`])
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')]])
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(w.shown).toEqual([`perm ${stopId(keyOf('perm'))}`, `perm ${stopId(next)}`])
  expect(w.writes[`${HOME}/show/perm@${stopId(next)}.md`]).toBe(report)
  expect(w.calls.filter(c => c[0] === 'focus-shown')).toEqual([['focus-shown', keyOf('perm')], ['focus-shown', next]])
})

test('the console\'s prompt hint ends with 「執行中 N  回覆完畢 M」 after auto mode on: archived not counted, zeros written, kept fresh by the poll', async ($, on) => {
  const w = world(pending())
  const clock = await start($, on, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const h = await $.ui.mount({ ...hint, surface })
    expect(w.hints.at(-1)).toBe('執行中 1  回覆完畢 1')
    await h.unmount()
  }
  w.focus = { ...pending(), sessions: SESSIONS.map(s => (s.tag === 'logging' ? { ...s, status: '執行中', pending: false } : s)) }
  await clock.advance(5_000)
  const h = await $.ui.mount({ ...hint, surface: 'terminal' })
  expect(w.hints.at(-1)).toBe('執行中 2  回覆完畢 1')
  await h.unmount()
  w.focus = nothing()
  await clock.advance(5_000)
  const zero = await $.ui.mount({ ...hint, surface: 'terminal' })
  expect(w.hints.at(-1)).toBe('執行中 0  回覆完畢 0')
  await zero.unmount()
})

test('pane tabs: 待回覆 q, 全部 w, 封存 e, 閒置 r with counts; the open tab is lit, the rest dim; each filters as the design says', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const tabs = await Promise.all(['tab:pending', 'tab:all', 'tab:hidden', 'tab:idle'].map(key => ui.find({ key })))
  expect(tabs.map((t: any) => t?.props)).toMatchObject([
    { hotkey: 'q', label: '待回覆 5', dimColor: false },
    { hotkey: 'w', label: '全部 6', dimColor: true },
    { hotkey: 'e', label: '封存 1', dimColor: true },
    { hotkey: 'r', label: '閒置 1', dimColor: true },
  ])
  expect(await cardTags(ui)).toEqual(['perm', 'focusui', 'logging', 'PROJ-6668', 'upgrade#2'])
  expect((await texts(ui)).some((t: string) => t.startsWith('──'))).toBe(false)
  await ui.press({ key: 'tab:all' })
  expect((await ui.find({ key: 'tab:all' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'tab:pending' }))?.props.dimColor).toBe(true)
  expect(await cardTags(ui)).toEqual(['focusui', 'logging', 'tune', 'PROJ-6668', 'upgrade#2', 'perm'])
  await ui.press({ key: 'tab:hidden' })
  expect((await ui.find({ key: `card:${keyOf('PROJ-6650')}` }))?.text).toContain('PROJ-6650')
  await ui.press({ key: 'tab:idle' })
  expect(await cardTags(ui)).toEqual(['chart'])
  await ui.unmount()
})

test('pane groups by repo outside 待回覆: `── <repo> ── 共 N 個` counts every session of that repo, a blank line only between repos', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(60), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  const rules = (await texts(ui)).filter((t: string) => t.startsWith('──'))
  expect(rules.map((t: string) => [t.split(' ')[1], t.split(' ').slice(-3).join(' ')])).toEqual([
    ['agent-skills', '共 2 個'],
    ['proj-agents-configuration', '共 1 個'],
    ['proj-v2-frontend', '共 3 個'],
    ['hours-dashboard', '共 2 個'],
  ])
  expect((await ui.find({ key: 'repo:agent-skills' }))?.props.marginTop).toBe(0)
  expect((await ui.find({ key: 'repo:proj-v2-frontend' }))?.props.marginTop).toBe(1)
  await ui.unmount()
})

test('cards: number (none on the question on screen) and nickname button, text status tag, stage on the right; the question in grey, no options; summary, never 建議; chosen is a cyan double frame, its question not bold', async ($, on) => {
  const w = world(focusOf('focusui', ['perm', 'logging', 'PROJ-6668', 'upgrade#2']))
  await start($, on, w)
  await openPane($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(), surface })
    const first = await ui.find({ key: `card:${keyOf('focusui')}` })
    expect(first?.props).toMatchObject({ borderStyle: 'double', borderColor: 'cyanBright' })
    expect(first?.text).toContain('展示 mod 的樣式要套在哪裡？')
    expect(first?.text).not.toMatch(/a\. |只套面板|橫條也改清單/)
    expect(first?.text).not.toContain('建議：')
    expect(first?.text).toContain('feat/focusui')
    expect(first?.text).toContain(' 等待回應 ')
    expect(first?.text).toContain(' 規劃中 ')
    expect(first?.text).not.toMatch(/💬|🔐|⏸/)
    expect((await ui.find({ type: 'Text', text: '展示 mod' }))?.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
    expect((await ui.find({ type: 'Text', text: '展示 mod' }))?.props.bold).toBeFalsy()
    expect(await ui.find({ key: `num:${keyOf('focusui')}` })).toBeUndefined()
    expect((await ui.find({ key: `num:${keyOf('perm')}` }))?.props).toMatchObject({ hotkey: '1', label: '', plain: true })
    expect((await ui.find({ key: `name:${keyOf('focusui')}` }))?.props).toMatchObject({ label: 'focusui', plain: true })
    expect((await ui.find({ key: `name:${keyOf('focusui')}` }))?.props.hotkey).toBeUndefined()
    const other = await ui.find({ key: `card:${keyOf('perm')}` })
    expect(other?.props).toMatchObject({ borderStyle: 'round', borderColor: '#7a7a7a' })
    expect((await ui.find({ type: 'Text', text: 'Bash rm' }))?.props).toMatchObject({ dimColor: true })
    expect((await ui.find({ type: 'Text', text: 'Bash rm' }))?.props.bold).toBeFalsy()
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }
})

const findKey = (node: any, key: string): any => (node?.props?.key === key ? node : (node?.children ?? []).map((c: any) => (typeof c === 'object' ? findKey(c, key) : null)).find(Boolean))
const textOf = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))

test('cards on 待回覆, 全部, 封存 and 閒置: header, one grey question row, corner line — 3 rows, no gap; a long or multi-line question is cut with … and never wraps; options never show', async ($, on) => {
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
    for (const [tabKey, tag] of [['tab:pending', 'p1'], ['tab:all', 'a1'], ['tab:hidden', 'h1'], ['tab:idle', 'i1']]) {
      await ui.press({ key: tabKey })
      const box = findKey(await ui.drawn(), `card:${keyOf(tag)}`)
      expect(box.children.length).toBe(3)
      for (const child of box.children) expect(child.props.marginTop ?? 0).toBe(0)
      const q = box.children[1]
      expect(q.type).toBe('Text')
      expect(q.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
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

test('more than 10 cards on 待回覆: all drawn, the question on screen unnumbered, the queue 1–9 and 0, none after; arrows reach the 11th and Enter switches to it and prints it', async ($, on) => {
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
  await ui.press({ key: `name:${keyOf('t10')}` })
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('t10')])
  expect(w.shown.at(-1)).toBe('t10')
  await ui.unmount()
})

test('on 待回覆 a number switches the band to that card and the pane reorders with it; the card then has no number; Enter or the nickname prints', async ($, on) => {
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
  await ui.press({ key: `name:${keyOf('PROJ-6668')}` })
  expect(w.shown).toEqual(['PROJ-6668', `PROJ-6668 ${stopId(keyOf('PROJ-6668'))}`])
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

test('arrow keys land on the nickname, so Enter always prints; the chosen card follows the arrows without switching', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PLUGIN, element: `num:${keyOf('focusui')}`, origin: { kind: 'person' } } as any)
  expect(w.focused.at(-1)).toBe(`name:${keyOf('focusui')}`)
  expect((await ui.find({ key: `card:${keyOf('focusui')}` }))?.props.borderStyle).toBe('double')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await arrowTo($, 'perm')
  await ui.press({ key: `name:${keyOf('perm')}` })
  expect(w.shown).toEqual([`perm ${stopId(keyOf('perm'))}`])
  await ui.unmount()
})

test('on the other tabs a number only chooses the card, Enter or the nickname prints it; a card that also waits on you switches the band', async ($, on) => {
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
  await ui.press({ key: `name:${keyOf('tune')}` })
  expect(w.shown).toEqual(['tune'])
  await ui.press({ key: `num:${keyOf('logging')}` })
  expect(w.calls.at(-1)).toEqual(['focus-pick', keyOf('logging')])
  await ui.unmount()
})

test('「狀態」 typed with mods opens the pane on 全部, never reaches the conversation or reply; 「待回覆」 and looser text pass through', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  const narrow = await $.ui.mount({ ...band(100), surface: 'terminal' })
  await narrow.unmount()
  const opened = await $.prompt.submit({ text: '  狀態 ', wait: false, origin: { kind: 'user' } } as any)
  expect(opened.drop).toBe('狀態已開在側邊面板')
  expect(w.opened.at(-1)).toMatchObject({ id: PANE, focus: true })
  expect(w.calls.some(c => c[0] === 'reply')).toBe(false)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ key: 'tab:all' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'tab:pending' }))?.props.dimColor).toBe(true)
  expect(await cardTags(ui)).toEqual(['focusui', 'logging', 'tune', 'PROJ-6668', 'upgrade#2', 'perm'])
  await ui.unmount()
  const count = w.opened.length
  for (const text of ['待回覆', '看一下狀態', '狀態？']) {
    const res = await $.prompt.submit({ text, wait: false, origin: { kind: 'user' } } as any)
    expect(res.drop).toBeUndefined()
    expect(res.text).toBe(text)
  }
  expect(w.opened).toHaveLength(count)
})

test('「狀態」 opening the pane toasts 「memory.md 有 N 條看不懂」 only when memory.md has such entries; nothing in the pane', async ($, on) => {
  const BAD = 'memory.md 有 1 條看不懂（沒有情境字母或認得的關鍵字），腳本不改不刪'
  const w = world(pending())
  const clock = await start($, on, w)
  await $.prompt.submit({ text: '狀態', wait: false, origin: { kind: 'user' } } as any)
  expect(w.toasts).toEqual([])
  w.focus = { ...pending(), unreadable: BAD }
  await clock.advance(5_000)
  expect(w.toasts).toEqual([])
  const res = await $.prompt.submit({ text: '狀態', wait: false, origin: { kind: 'user' } } as any)
  expect(res.drop).toBe('狀態已開在側邊面板')
  expect(w.toasts).toEqual([BAD])
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await texts(ui)).filter((t: string) => t.includes('看不懂'))).toEqual([])
  await ui.unmount()
  await $.prompt.submit({ text: '待回覆', wait: false, origin: { kind: 'user' } } as any)
  expect(w.toasts).toEqual([BAD])
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
  await ui.press({ key: 'tab:idle' })
  expect(await cardTags(ui)).toEqual(['chart'])
  await ui.press({ key: 'tab:hidden' })
  expect(await cardTags(ui)).toEqual(['取消封存'])
  expect((await ui.find({ key: `card:${keyOf('PROJ-6650')}` }))?.text).toContain('PROJ-6650')
  await ui.press({ key: `name:${keyOf('PROJ-6650')}` })
  expect(w.calls.at(-2)).toEqual(['unarchive', 'PROJ-6650'])
  expect(w.calls.at(-1)).toEqual(['focus', '--session', 'console-session'])
  expect(w.shown).toEqual([])
  expect(await cardTags(ui)).toEqual([])
  expect((await ui.find({ key: 'tab:hidden' }))?.props.label).toBe('封存 0')
  await ui.press({ key: 'tab:all' })
  expect(await cardTags(ui)).toContain('PROJ-6650')
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
const grey = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

test('empty pane: every tab says 目前沒有符合條件的 session, never a bare 目前沒有', async ($, on) => {
  const w = world(nothing())
  await start($, on, w)
  await openPane($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(), surface })
    for (const key of ['tab:pending', 'tab:all', 'tab:hidden', 'tab:idle']) {
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
    expect(text?.props.dimColor).toBe(true)
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

test('empty pane: the frame is a grey darker than a card frame (#7a7a7a), never the chosen card cyan', async ($, on) => {
  const w = world(nothing())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const color = (await ui.find({ key: 'empty' }))!.props.borderColor as string
  expect(color).not.toBe('cyanBright')
  expect(color).not.toBe('#7a7a7a')
  expect(color).toMatch(/^#[0-9a-f]{6}$/i)
  const [r, g, b] = grey(color)
  expect(r === g && g === b).toBe(true)
  expect(r).toBeLessThan(0x7a)
  await ui.unmount()
})

const corner = async (ui: any, tag: string) => (await ui.find({ key: `corner:${keyOf(tag)}` }))?.text
const withRepos = (repos: Record<string, Partial<Card>>) => ({ ...pending(), sessions: SESSIONS.map(s => ({ ...s, ...repos[s.tag] })) })

test('card corner on 待回覆: the repo and the summary in dark grey #6a6a6a, darker than the question; the repo with no prefix on every card, choice questions too, never 建議; the summary on the right stays', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(await corner(ui, 'perm')).toBe('hours-dashboard')
  expect(await corner(ui, 'upgrade#2')).toBe('proj-v2-frontend')
  expect(await corner(ui, 'focusui')).toBe('agent-skills')
  expect(await corner(ui, 'PROJ-6668')).toBe('proj-v2-frontend')
  expect((await ui.find({ type: 'Text', text: 'hours-dashboard' }))?.props.color).toBe('#6a6a6a')
  expect((await ui.find({ type: 'Text', text: 'feat/perm' }))?.props.color).toBe('#6a6a6a')
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
  ui = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await corner(ui, 'perm')).toBe('proj-agents…')
  expect(await corner(ui, 'upgrade#2')).toBe('abcdefghijklmnopq…')
  expect(await corner(ui, 'logging')).toBe('中控台中控台中控台…')
  await ui.unmount()
  ui = await $.ui.mount({ ...pane(32), surface: 'terminal' })
  expect(await corner(ui, 'perm')).toBe('pro…')
  expect(await summaryOf(ui, 'perm')).toBe('專案檢視介面調整建議')
  await ui.unmount()
  ui = await $.ui.mount({ ...pane(31), surface: 'terminal' })
  expect(await corner(ui, 'perm')).toBe(' ')
  await ui.unmount()
  ui = await $.ui.mount({ ...pane(20), surface: 'terminal' })
  expect(await summaryOf(ui, 'perm')).toBe('專案檢視介面…')
  await ui.unmount()
  for (const cols of [12, 20, 26, 31, 32, 34, 40, 52, 70, 120]) {
    ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    for (const r of w.focus.sessions.filter((x: Card) => x.pending)) {
      const left = ((await corner(ui, r.tag)) ?? '').trim()
      const right = (await summaryOf(ui, r.tag))!
      expect(cardWidth(right)).toBeLessThanOrEqual(Math.min(20, cols - 6))
      if (left) expect(cardWidth(left)).toBeGreaterThanOrEqual(4)
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
      const room = cols - 6 - cardWidth(` ${r.status} `) - cardWidth(` ${r.stage} `) - 3
      if (r.tag === long) expect(cardWidth(long) <= room ? label === long : label.endsWith('…') && long.startsWith(label.slice(0, -1))).toBe(true)
      expect(cardWidth(label) + 2 + cardWidth(` ${r.status} `) + 1 + cardWidth(` ${r.stage} `)).toBeLessThanOrEqual(cols - 6)
    }
    await ui.unmount()
  }
})

test('card corner on 全部, 封存 and 閒置 is blank on every card, choice questions too; never the repo or 建議', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'tab:all' })
  expect(await corner(ui, 'focusui')).toBe(' ')
  expect(await corner(ui, 'PROJ-6668')).toBe(' ')
  expect(await corner(ui, 'tune')).toBe(' ')
  expect(await corner(ui, 'perm')).toBe(' ')
  await ui.press({ key: 'tab:hidden' })
  expect(await corner(ui, 'PROJ-6650')).toBe(' ')
  await ui.press({ key: 'tab:idle' })
  expect(await corner(ui, 'chart')).toBe(' ')
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

test('band: 8 only ever defers, even for a card that still carries old habit or prefill data; nothing goes into the prompt box', async ($, on) => {
  const w = world({ ...pending(), sessions: SESSIONS.map(s => (s.tag === 'perm' ? { ...s, habit: { text: 'squash、關閉', basis: '你最近 30 天回過 3 次' }, prefill: 'perm squash merge，關閉' } : s)) })
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

test('cards: no 你通常會回 line on any tab, even for a card that carries habit data; no 要記住 or 看不懂 line anywhere in the pane', async ($, on) => {
  const notes = ['要記住這個習慣嗎？', 'memory.md 有 1 條看不懂（沒有情境字母或認得的關鍵字），腳本不改不刪']
  const w = world({ ...pending(), notes, sessions: SESSIONS.map(s => (s.tag === 'upgrade#2' ? { ...s, habit: { text: 'squash、關閉', basis: '你最近 30 天回過 3 次' } } : s)) })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(100), surface: 'terminal' })
  for (const key of ['tab:pending', 'tab:all', 'tab:hidden', 'tab:idle']) {
    await ui.press({ key })
    const all = await texts(ui)
    expect(all.filter((t: string) => /你通常會回|要記住|看不懂/.test(t))).toEqual([])
    expect(all.at(-1)).toBe(FOOTER_TEXT)
  }
  await ui.unmount()
})

const FOOTER_TEXT = 'qwer 切分頁　1-9,0/↑↓ 選卡片'

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
  expect(hotkeys).toEqual(['0', '1', '2', '3', '4', '5', '8', '9'])
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
  for (const key of ['tab:pending', 'tab:all', 'tab:hidden', 'tab:idle']) {
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

test('tabs switch with q/w/e/r (no ←→: the engine binds no left or right in a pane): 待回覆 chooses the question on screen, the others their first card, and ↓ then moves from there', async ($, on) => {
  const w = world({ ...pending(), sessions: [...SESSIONS, card('idle2', { status: '閒置', pending: false })] })
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
  await ui.press({ key: 'tab:idle' })
  expect(await chosenTag(ui)).toBe('chart')
  await arrow(1)
  expect(await chosenTag(ui)).toBe('idle2')
  await ui.press({ key: 'tab:pending' })
  expect(await chosenTag(ui)).toBe('perm')
  await arrow(1)
  expect(await chosenTag(ui)).toBe('focusui')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => b.key.startsWith('tab:')).map((b: any) => b.props.hotkey)).toEqual(['q', 'w', 'e', 'r'])
  await ui.unmount()
})

test('pane footer keys read only 「qwer 切分頁　1-9,0/↑↓ 選卡片」, no Enter or Esc', async ($, on) => {
  const w = world(pending())
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const lines = (await footerLines(ui))!
  expect(lines).toEqual(['qwer 切分頁　1-9,0/↑↓ 選卡片'])
  expect(lines.join('')).not.toMatch(/Enter|Esc/)
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
      for (const key of ['tab:pending', 'tab:all', 'tab:hidden', 'tab:idle']) {
        await ui.press({ key })
        const root = await ui.drawn()
        expect(root.props.height).toBe(200)
        expect(root.children.map((c: any) => c.props.key)).toEqual(['tabs', 'cards', 'footer'])
        const [, cardsBox, footer] = root.children
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
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
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

test('refined neutral：底列摘要與 repo、問題同為 dim 灰，階段小標也是 dim 且不加粗', async ($, on) => {
  const c = card('甲', { repo: 'frontend', summary: '現場報工端埋' })
  const w = world({ ...focusOf('甲', []), sessions: [c] })
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: '現場報工端埋' }))?.props.color).toBe('gray')
  const stage = await ui.find({ type: 'Text', text: '實作中' })
  expect(stage?.props.color).toBe('gray')
  expect(stage?.props.bold).toBeFalsy()
  await ui.unmount()
})

for (const cols of [36, 46, 70, 80]) {
  test(`refined：${cols} 欄 repo／階段／長摘要底列只佔一行`, async ($, on) => {
    const c = card('甲', { repo: 'frontend', summary: '現場報工端埋-posthog-完整摘要' })
    const w = world({ ...focusOf('甲', []), sessions: [c] })
    appearanceConfig.set(w, { appearance: 'refined', motion: false })
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
      appearanceConfig.set(w, { appearance: 'refined', motion: false })
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
  const cards = [card('甲', { repo: 'frontend', summary: '1 未核對', status: '等待授權' }), card('乙', { repo: 'frontend', summary: '面板 v2 改版', status: '回覆完畢' })]
  const w = world({ ...focusOf('甲', ['乙']), sessions: cards })
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const all = await ui.findAll({ type: 'Text' })
  const lead = all.find((x: any) => x.text === '1')
  expect(lead?.props.color).toBeUndefined()
  expect(lead?.props.bold).toBeFalsy()
  expect(all.some((x: any) => x.text === '2')).toBe(false)
  expect(all.find((x: any) => x.text === '面板 v2 改版')?.props.color).toBe('gray')
  expect(all.filter((x: any) => x.props.bold)).toEqual([])
  await ui.press({ key: 'tab:all' })
  expect((await ui.findAll({ type: 'Text' })).filter((x: any) => x.props.bold)).toEqual([])
  await ui.unmount()
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
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
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

test('refined：neutral 使用終端色，無效設定只提示一次且每次開面板重讀', async ($, on) => {
  const w = world(pending())
  const config: AppearanceConfig = { appearance: 'refined', theme: 'neutral', motion: false }
  appearanceConfig.set(w, config)
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect((await ui.find({ key: `card:${keyOf('perm')}` }))?.props.borderColor).toBe('cyan')
  expect((await ui.find({ key: `card:${keyOf('focusui')}` }))?.props.borderColor).toBe('gray')
  const original = await cardTags(ui)
  config.theme = '不存在'
  await openPane($)
  expect((await ui.find({ key: `card:${keyOf('perm')}` }))?.props.borderColor).toBe('cyan')
  expect(await cardTags(ui)).toEqual(original)
  await openPane($)
  expect(w.toasts).toEqual(['config.json 的 theme 不認得：不存在，改用 neutral'])
  await ui.unmount()
})

test('refined：只有工作中可見時不開動畫計時器', async ($, on) => {
  const cards = [card('a', { status: '執行中', pending: false }), card('b', { status: '執行中', pending: false })]
  const w = world({ ...focusOf('a', []), sessions: cards })
  appearanceConfig.set(w, { appearance: 'refined' })
  let invalidations = 0
  on('ui.invalidate', async (_$, e, next) => { invalidations += 1; return next(e) })
  const clock = await start($, on, w)
  await $.prompt.submit({ text: '狀態', wait: false, origin: { kind: 'user' } })
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const before = invalidations
  await clock.advance(1_800)
  expect(invalidations).toBe(before)
  for (const c of cards) expect((await ui.find({ key: `card:${c.key}` }))?.text).toContain('✳ 工作中')
  await ui.unmount()
})

test('refined：所有可見待授權同拍呼吸，文字不變暗，關閉 motion 停止', async ($, on) => {
  const w = world({ ...focusOf('perm', ['另一授權', 'focusui']), sessions: [...SESSIONS, card('另一授權', { status: '等待授權' })] })
  const config: AppearanceConfig = { appearance: 'refined' }
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
  appearanceConfig.set(w, { appearance: 'refined' })
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

test('refined：主要題目不可見時，可見待授權仍呼吸；classic 不動', async ($, on) => {
  const cards = [card('工作中', { status: '執行中', pending: false }), card('perm', { status: '等待授權', pending: false })]
  const w = world({ ...focusOf('工作中', []), sessions: cards })
  const config: AppearanceConfig = { appearance: 'refined' }
  appearanceConfig.set(w, config)
  const clock = await start($, on, w)
  await $.prompt.submit({ text: '狀態', wait: false, origin: { kind: 'user' } })
  const ui = await $.ui.mount({ ...pane(36), surface: 'terminal' })
  await clock.advance(1_200)
  expect((await ui.find({ type: 'Text', text: '◆' }))?.props.color).toBe('gray')
  expect((await ui.find({ type: 'Text', text: ' 待授權' }))?.props.color).toBe('magentaBright')
  config.appearance = 'classic'
  await $.prompt.submit({ text: '狀態', wait: false, origin: { kind: 'user' } })
  await clock.advance(1_800)
  expect((await ui.find({ type: 'Text', text: ' 等待授權 ' }))?.props.backgroundColor).toBe('#3e2a2a')
  expect(await ui.find({ type: 'Text', text: '◆' })).toBeUndefined()
  await ui.unmount()
})

test('refined：焦點框待回覆分隔線、授權色左線、不重複階段，單題沒有延後', async ($, on) => {
  const w = world(focusOf('perm', ['focusui']))
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
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
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
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
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
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

test('refined：上下選卡不切換問題，Enter 才顯示選中的題目', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const arrow = arrows($, ui, w)
  await arrow(1)
  expect(await chosenTag(ui)).toBe('focusui')
  expect(w.calls.filter(c => c[0] === 'focus-pick')).toEqual([])
  await ui.press({ key: 'name:focusui@1' })
  expect(w.shown.at(-1)).toBe('focusui')
  await ui.unmount()
})

test('refined：四個分頁維持上游篩選與選中第一張卡', async ($, on) => {
  const w = world(pending())
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  for (const [key, tags] of [
    ['tab:all', ['focusui', 'logging', 'tune', 'PROJ-6668', 'upgrade#2', 'perm']],
    ['tab:hidden', ['PROJ-6650']], ['tab:idle', ['chart']],
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
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
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
  appearanceConfig.set(w, { appearance: 'refined' })
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

test('refined：未設定欄位使用預設外觀，無效 appearance 與 motion 各提示一次', async ($, on) => {
  const w = world(pending())
  const config: AppearanceConfig = {}
  appearanceConfig.set(w, config)
  await start($, on, w)
  await openPane($)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect((await ui.find({ key: 'card:perm@1' }))?.text).toContain('◆ 待授權')
  expect(w.toasts).toEqual([])
  config.appearance = '錯誤外觀'
  config.motion = '否'
  await openPane($)
  await openPane($)
  expect(w.toasts).toEqual([
    'config.json 的 appearance 不認得：錯誤外觀，改用 refined',
    'config.json 的 motion 不認得：否，改用 true',
  ])
  expect((await ui.find({ key: 'card:perm@1' }))?.props.borderColor).toBe('cyan')
  await ui.unmount()
})

test('refined：超過五筆排隊仍顯示完整隱藏數', async ($, on) => {
  const many = queued(10)
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [...SESSIONS, ...many] })
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
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
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
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

test('refined：80 與 46 欄先保留換行操作列，長多行問題只取得剩餘行數', () => {
  for (const cols of [80, 46]) {
    const rows = focusBandRows({ cols, maxRows: 10, question: longBandQuestion, queue: longBandQueue, hiddenCount: 2 })
    expect(rows.actions).toBe(1)
    expect(rows.keys).toBe(cols === 80 ? 3 : 2)
    expect(rows.question).toBe(cols === 80 ? 3 : 4)
    expect(rows.margin + rows.separator + rows.header + rows.actions + rows.keys + rows.question).toBeLessThanOrEqual(10)
    expect(rows.questionText.startsWith('第一行\n\n')).toBe(true)
    expect(rows.questionText.endsWith('…')).toBe(true)
    expect(rows.questionText.includes('最後一行')).toBe(false)
    const short = focusBandRows({ cols, maxRows: 10, question: '第一行\n\n最後一行', queue: longBandQueue, hiddenCount: 2 })
    expect(short.question).toBe(3)
    expect(short.questionText).toBe('第一行\n\n最後一行')
    const wrapped = focusBandRows({ cols, maxRows: 10, question: '問'.repeat(40), queue: longBandQueue, hiddenCount: 2 })
    expect(wrapped.question).toBe(2)
    expect(wrapped.questionText).toBe('問'.repeat(40))
  }
})

test('refined：長多行問題與五個長排隊名稱仍畫出操作與 0 面板', async ($, on) => {
  const many = [...longBandQueue.map(q => card(q.tag)), card('隱藏一'), card('隱藏二')]
  const w = world({ ...focusOf('perm', many.map(c => c.tag)), sessions: [card('perm', { question: longBandQuestion }), ...many] })
  w.focus.queue = many.map(c => ({ key: c.key, isNew: true }))
  appearanceConfig.set(w, { appearance: 'refined', motion: false })
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
