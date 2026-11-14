import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { THEMES } from './console-theme.ts'
import { columns } from './status-view.ts'
import { bandDigestRows, digestRows, parseDigest, summaryLines } from './session-summary-view.tsx'

const PLUGIN = 'worktree-console'
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
  on('ui.render', { plugin: PLUGIN }, async ($, e) => {
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


const saved = (text: string, extra: object = {}) => JSON.stringify({ text, at: 999_000, since: 998_000, sessionId: SESSION, handle: HANDLE, model: 'sonnet', ...extra })
const world = (files: Record<string, string> = {}): World => ({ files, opened: [], sessionId: SESSION })
const textOf = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))
const findKey = (node: any, key: string): any => (node?.props?.key === key ? node : (node?.children ?? []).map((c: any) => (typeof c === 'object' ? findKey(c, key) : null)).find(Boolean))
const rows = (root: any) => (root.children ?? []).filter((c: any) => typeof c === 'object' && String(c.props?.key ?? '').startsWith('summary:'))

const LAYERED = ['在做什麼：改登入頁的表單驗證', '卡在哪：註冊頁共用同一個驗證元件', '做了什麼：改好登入頁，單元測試全過', '順手清掉兩個舊的 lint 警告', '要你決定：要不要一起改註冊頁，建議：另開一張票'].join('\n')
const OLD_LABELS = ['前提：改登入頁的表單驗證', '問題：註冊頁共用同一個驗證元件', '解法：改好登入頁，單元測試全過', '建議：要你決定：要不要一起改註冊頁'].join('\n')
const cellsOf = (row: any) => (row.children ?? []).filter((c: any) => typeof c === 'object')
const ruleText = (root: any) => textOf(findKey(root, 'summary-rule'))
// A band row past its 12-column label column.
const content = (line: string) => {
  let i = 0
  while (i < line.length && columns(line.slice(0, i)) < 12) i += 1
  return line.slice(i)
}

test('子 session 分頁：第一行是「── 摘要 ──」分隔線，下面一層一行：標籤在固定左欄、內容從同一欄開始；▶ 要你決定整行強調色加粗，其他標籤淡色、內容前景色；每行不超寬', async ($, on) => {
  await start($, on, world({ [SUMMARY]: saved(LAYERED) }))
  for (const cols of [60, 100]) {
    const ui = await $.ui.mount({ ...band(cols), surface: 'terminal' })
    const root = await ui.drawn()
    expect(ruleText(root)).toMatch(/^── 摘要 ─+$/)
    expect(columns(ruleText(root))).toBe(cols)
    const lines = rows(root).map(textOf)
    expect(lines.map(l => l.slice(0, l.indexOf(' ') < 0 ? l.length : l.indexOf(' ')).trim())).toEqual(['在做什麼', '卡在哪', '做了什麼', '▶'])
    expect(lines[0]).toBe('在做什麼    改登入頁的表單驗證')
    expect(lines[3]).toBe('▶ 要你決定  要不要一起改註冊頁，建議：另開一張票')
    expect(lines.map(content)).toEqual(['改登入頁的表單驗證', '註冊頁共用同一個驗證元件', expect.any(String), '要不要一起改註冊頁，建議：另開一張票'])
    if (cols === 100) expect(content(lines[2]!)).toBe('改好登入頁，單元測試全過 · 順手清掉兩個舊的 lint 警告')
    else expect(content(lines[2]!).endsWith('…')).toBe(true)
    const [label, text] = cellsOf(rows(root)[0])
    expect([label.props.color, label.props.bold]).toEqual([THEMES.neutral.dim, undefined])
    expect(text.props.color).toBe(THEMES.neutral.fg)
    for (const c of cellsOf(rows(root)[3])) expect([c.props.color, c.props.bold]).toEqual([THEMES.neutral.accent, true])
    for (const l of lines) expect(columns(l)).toBeLessThanOrEqual(cols)
    expect(await ui.find({ key: 'summary-full' })).toBeUndefined()
    await ui.unmount()
  }
})

test('子 session 分頁：放不下時先截短「做了什麼」（以 … 結尾），「要你決定」與「下一步」不截短、折到下一行並對齊內容欄；行數超過 4 行時先拿掉「做了什麼」', async ($, on) => {
  const long = ['在做什麼：改登入頁的表單驗證', '做了什麼：改好登入頁的表單驗證並補上全部欄位的單元測試', '要你決定：註冊頁也共用驗證元件，要不要一起改，建議：一起改'].join('\n')
  await start($, on, world({ [SUMMARY]: saved(long) }))
  const ui = await $.ui.mount({ ...band(40), surface: 'terminal' })
  const lines = rows(await ui.drawn()).map(textOf)
  expect(lines[1]!.startsWith('做了什麼')).toBe(true)
  expect(lines[1]!.endsWith('…')).toBe(true)
  const decide = lines.slice(2)
  expect(decide.length).toBeGreaterThan(1)
  expect(decide.map(content).join('')).toBe('註冊頁也共用驗證元件，要不要一起改，建議：一起改')
  for (const l of decide.slice(1)) expect(l.slice(0, 12)).toBe(' '.repeat(12))
  expect(columns(lines[2]!.slice(0, lines[2]!.length - content(lines[2]!).length))).toBe(12)
  for (const l of lines) expect(columns(l)).toBeLessThanOrEqual(40)
  await ui.unmount()
  const layers = parseDigest(['在做什麼：改登入頁', '卡在哪：註冊頁共用元件', '做了什麼：改好了', '要你決定：一二三四五六七八九十一二三四五六七八九十'].join('\n'))!
  const kept = bandDigestRows(layers, 32, 4).map(r => r.map(p => p.text).join(''))
  expect(kept.length).toBe(4)
  expect(kept.some(r => r.startsWith('做了什麼'))).toBe(false)
  expect(kept[0]!.startsWith('在做什麼')).toBe(true)
  const next = bandDigestRows(parseDigest('在做什麼：改登入頁\n下一步：接著改註冊頁的表單驗證與錯誤訊息')!, 30, 4).map(r => r.map(p => p.text).join(''))
  expect(next[1]!.startsWith('下一步')).toBe(true)
  expect(next.slice(1).map(content).join('')).toBe('接著改註冊頁的表單驗證與錯誤訊息')
})

test('子 session 分頁：舊摘要檔的舊標籤（前提、問題、解法、建議）畫成同一種排版；沒有標籤的摘要照自己的行畫在分隔線下，最多 4 行、截斷以 … 結尾', async ($, on) => {
  const w = world({ [SUMMARY]: saved(OLD_LABELS) })
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(80), surface: 'terminal' })
  expect(rows(await ui.drawn()).map(textOf)).toEqual(['在做什麼    改登入頁的表單驗證', '卡在哪      註冊頁共用同一個驗證元件', '做了什麼    改好登入頁，單元測試全過', '▶ 要你決定  要不要一起改註冊頁'])
  await ui.unmount()
  w.files[SUMMARY] = saved(LONG)
  await clock.advance(3_000)
  const plain = await $.ui.mount({ ...band(40), surface: 'terminal' })
  const root = await plain.drawn()
  expect(ruleText(root)).toMatch(/^── 摘要 ─+$/)
  const lines = rows(root).map(textOf)
  expect(lines.length).toBe(4)
  expect(lines[3]!.endsWith('…')).toBe(true)
  for (const l of lines) expect(columns(l)).toBeLessThanOrEqual(40)
  await plain.unmount()
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

test('子 session 分頁：摘要產生中在分隔線下只寫「產生中…」，沒有 0 鍵；產生好了下一次輪詢換成摘要', async ($, on) => {
  const w = world({ [SUMMARY]: saved('上一輪的舊摘要。'), [PENDING]: JSON.stringify({ since: 999_500, sessionId: SESSION, timeoutMs: 120_000 }) })
  const clock = await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(ruleText(await ui.drawn())).toMatch(/^── 摘要 ─+$/)
  expect(rows(await ui.drawn()).map((r: any) => textOf(r))).toEqual(['產生中…'])
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

test('子 session 分頁：完整摘要的側邊面板與 0 鍵都拿掉了，按 0 不開任何面板', async ($, on) => {
  const w = world({ [SUMMARY]: saved(LAYERED) })
  await start($, on, w)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ key: 'summary-full' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => b.props.hotkey === '0')).toEqual([])
  expect(textOf(await ui.drawn())).not.toContain('完整摘要')
  expect(w.opened).toEqual([])
  await ui.unmount()
})

test('摘要分層：新標籤照順序分層、第 2 行接在同一層；「卡在哪：無」整層省略；另起一行的「建議：」接回「要你決定」同一行；每層最多 2 行', () => {
  expect(parseDigest('在做什麼：甲\n卡在哪：無\n做了什麼：乙\n丙\n丁\n要你決定：要不要改？\n建議：改')).toEqual([
    { key: 'doing', label: '在做什麼', lines: ['甲'] },
    { key: 'done', label: '做了什麼', lines: ['乙', '丙'] },
    { key: 'decide', label: '要你決定', lines: ['要不要改？建議：改'] },
  ])
  expect(parseDigest('前提：甲\n解法：乙\n建議：先改登入頁')!.at(-1)).toEqual({ key: 'decide', label: '要你決定', lines: ['建議：先改登入頁'] })
  expect(parseDigest('沒有標籤的一段話')).toBeNull()
  const rows = digestRows(parseDigest('在做什麼：甲\n下一步：乙')!, 40).map(r => r.map(p => p.text).join(''))
  expect(rows).toEqual(['在做什麼    甲', '下一步      乙'])
})

test('摘要截行：照顯示欄寬折行，保留原本的換行，超過上限時最後一行以 … 結尾且不超寬', () => {
  expect(summaryLines('一二三四五六七八九十', 8)).toEqual(['一二三四', '五六七八', '九十'])
  expect(summaryLines('第一段\n第二段', 20)).toEqual(['第一段', '第二段'])
  const cut = summaryLines('一二三四五六七八九十一二', 4, 2)
  expect(cut).toEqual(['一二', '三…'])
  for (const line of cut) expect(columns(line)).toBeLessThanOrEqual(4)
  expect(summaryLines('abcdefghij', 3, 2)).toEqual(['abc', 'de…'])
})
