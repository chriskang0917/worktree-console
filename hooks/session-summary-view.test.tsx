import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { THEMES } from './console-theme.ts'
import { columns } from './status-view.ts'
import { summaryLines } from './session-summary-view.tsx'

const PLUGIN = 'worktree-console'
const PANE = 'worktree-console-summary'
const HOME = '/tmp/wtc-child-home'
const HANDLE = 'term_child'
const SESSION = 'sid-child'
const SUMMARY = `${HOME}/summaries/${HANDLE}.json`
const PENDING = `${HOME}/summaries/${HANDLE}.pending.json`

type World = { files: Record<string, string>; opened: any[]; sessionId: string }

const LONG = '登入頁的表單驗證改好了，單元測試全部通過。註冊頁還沒動，因為它共用同一個驗證元件，改了會影響另外兩個頁面。我先停下來，等你決定要不要一起改註冊頁，或是另外開一張票處理，這樣比較好追蹤。另外 lint 有兩個舊警告，跟這次改動無關，我沒有處理。'

const run = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

async function start($: any, on: On, world: World, env: Record<string, string> = { ORCA_TERMINAL_HANDLE: HANDLE }) {
  mock.env(on, { ...env, WORKTREE_CONSOLE_HOME: HOME })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('fs.read', async (_$, e) => {
    if (!(e.path in world.files)) throw new Error('ENOENT')
    return { value: world.files[e.path]! }
  })
  on('process.run', async () => run(JSON.stringify({ active: false })))
  on('session.id', async () => ({ value: world.sessionId }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', async (_$, e) => {
    world.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

const band = (cols = 80, isWorking = false) => ({
  plugin: PLUGIN,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking, maxRows: 20, bodyColumns: cols, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  viewport: { columns: cols, rows: 40, isFullscreen: true },
})

const pane = () => ({
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: PANE,
  props: { title: '摘要', isFocused: true, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as any,
})

const saved = (text: string, extra: object = {}) => JSON.stringify({ text, at: 999_000, since: 998_000, sessionId: SESSION, handle: HANDLE, model: 'sonnet', ...extra })
const world = (files: Record<string, string> = {}): World => ({ files, opened: [], sessionId: SESSION })
const textOf = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))
const findKey = (node: any, key: string): any => (node?.props?.key === key ? node : (node?.children ?? []).map((c: any) => (typeof c === 'object' ? findKey(c, key) : null)).find(Boolean))
const rows = (root: any) => (root.children ?? []).filter((c: any) => typeof c === 'object' && String(c.props?.key ?? '').startsWith('summary:'))

test('子 session 分頁：停下後輸入框上方是「摘要」前綴（強調色）加摘要，續行對齊在文字下；最多 4 行，超過時最後一行以 … 結尾；沒有分隔線', async ($, on) => {
  const w = world({ [SUMMARY]: saved(LONG) })
  await start($, on, w)
  for (const cols of [40, 60]) {
    const ui = await $.ui.mount({ ...band(cols), surface: 'terminal' })
    const root = await ui.drawn()
    const lines = rows(root)
    expect(lines.length).toBe(4)
    expect(textOf(findKey(root, 'summary-label:0'))).toBe('摘要')
    expect(findKey(root, 'summary-label:0').children[0].props).toMatchObject({ color: THEMES.neutral.accent, bold: true })
    expect(textOf(findKey(root, 'summary-label:1')).trim()).toBe('')
    expect(findKey(root, 'summary-label:1').props.width).toBe(findKey(root, 'summary-label:0').props.width)
    const last = textOf(lines[3]).trim()
    expect(last.endsWith('…')).toBe(true)
    for (const line of lines) expect(columns(textOf(line))).toBeLessThanOrEqual(cols)
    expect(textOf(root)).not.toMatch(/[─━]{3}/)
    expect(textOf(root).replace(/\s|…|摘要|0: 完整摘要|完整摘要/g, '')).not.toBe(LONG.replace(/\s/g, ''))
    await ui.unmount()
  }
})

test('Herdr app 分頁：依 HC_TERMINAL_ID 找這個分頁的摘要，停下後一樣畫在輸入框上方', async ($, on) => {
  const text = '登入頁改好了，測試都過。'
  await start($, on, world({ [SUMMARY]: saved(text) }), { HC_TERMINAL_ID: HANDLE })
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(rows(await ui.drawn()).map((r: any) => textOf(r).replace(/^摘要\s*/, ''))).toEqual([text])
  await ui.unmount()
})

test('舊 herdr 跑在 Herdr app 終端機裡（HERDR_ENV=1 也有 HC_TERMINAL_ID）：照舊用 HERDR_PANE_ID 找摘要', async ($, on) => {
  await start($, on, world({ [SUMMARY]: saved('Herdr app 位址的摘要。') }), { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2', HC_TERMINAL_ID: HANDLE })
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(textOf(await ui.drawn())).toBe('engine')
  await ui.unmount()
})

test('子 session 分頁：短摘要整段照畫、不加 …，下面一行是 0: 完整摘要', async ($, on) => {
  const text = '登入頁改好了，測試都過。'
  await start($, on, world({ [SUMMARY]: saved(text) }))
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  const root = await ui.drawn()
  expect(rows(root).map((r: any) => textOf(r).replace(/^摘要\s*/, ''))).toEqual([text])
  expect((await ui.find({ key: 'summary-full' }))?.props).toMatchObject({ hotkey: '0', label: '完整摘要' })
  await ui.unmount()
})

test('子 session 分頁：摘要產生中只寫「產生中…」，沒有 0 鍵；產生好了下一次輪詢換成摘要', async ($, on) => {
  const w = world({ [SUMMARY]: saved('上一輪的舊摘要。'), [PENDING]: JSON.stringify({ since: 999_500, sessionId: SESSION, timeoutMs: 120_000 }) })
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(rows(await ui.drawn()).map((r: any) => textOf(r))).toEqual(['摘要產生中…'])
  expect(await ui.find({ key: 'summary-full' })).toBeUndefined()
  await ui.unmount()
  delete w.files[PENDING]
  w.files[SUMMARY] = saved('這一輪的新摘要。')
  await clock.advance(3_000)
  const fresh = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(textOf(await fresh.drawn())).toContain('這一輪的新摘要。')
  await fresh.unmount()
})

test('子 session 分頁：還在跑、沒有摘要、或摘要屬於這個分頁之前的 session（/clear 之後）時不畫，交給引擎', async ($, on) => {
  const w = world({ [SUMMARY]: saved(LONG) })
  const clock = await start($, on, w)
  const working = await $.ui.mount({ ...band(80, true), surface: 'terminal' })
  expect(textOf(await working.drawn())).toBe('engine')
  await working.unmount()
  w.sessionId = 'sid-after-clear'
  await clock.advance(3_000)
  const cleared = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(textOf(await cleared.drawn())).toBe('engine')
  await cleared.unmount()
  delete w.files[SUMMARY]
  w.sessionId = SESSION
  await clock.advance(3_000)
  const none = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(textOf(await none.drawn())).toBe('engine')
  await none.unmount()
})

test('子 session 分頁：輸入框空白時按 0 開側邊面板，面板顯示完整摘要不截短；沒有摘要時寫「還沒有摘要」', async ($, on) => {
  const w = world({ [SUMMARY]: saved(LONG) })
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  await ui.press({ key: 'summary-full' })
  expect(w.opened.at(-1)).toMatchObject({ id: PANE, title: '摘要', focus: true, closeOnEscape: true })
  await ui.unmount()
  const side = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(textOf(findKey(await side.drawn(), 'summary-text'))).toBe(LONG)
  expect((await side.find({ type: 'Text', text: '登入頁' }))?.props.wrap).toBe('wrap')
  await side.unmount()
  delete w.files[SUMMARY]
  await clock.advance(3_000)
  const empty = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect(textOf(await empty.drawn())).toBe('還沒有摘要')
  await empty.unmount()
})

test('摘要截行：照顯示欄寬折行，保留原本的換行，超過上限時最後一行以 … 結尾且不超寬', () => {
  expect(summaryLines('一二三四五六七八九十', 8)).toEqual(['一二三四', '五六七八', '九十'])
  expect(summaryLines('第一段\n第二段', 20)).toEqual(['第一段', '第二段'])
  const cut = summaryLines('一二三四五六七八九十一二', 4, 2)
  expect(cut).toEqual(['一二', '三…'])
  for (const line of cut) expect(columns(line)).toBeLessThanOrEqual(4)
  expect(summaryLines('abcdefghij', 3, 2)).toEqual(['abc', 'de…'])
})
