import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ELSEWHERE = 'focus-show is not the plugin under test'

const stopId = (key: string) => [...key].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36)

const REPORT = '### 💬 PROJ-6668 等你回應\n\n> 你要 A、A＋另開後端票做 B，還是其他做法？\n\n- a. 這張票只在卡片上顯示「缺多少」（建議）\n- b. 卡片直接顯示狀態標籤'

async function start($: any, on: On, files: Record<string, string>, env: Record<string, string>) {
  mock.env(on, env)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('fs.read', async (_$, e) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: files[e.path] }
  })
  on('command.run', async () => ({ text: ELSEWHERE }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  // `claude plugin test` from the worktree-console root also finds this file; there /focus-show reaches the bottom and the test stands down.
  return (await $.command.run({ command: 'focus-show', args: 'x' })).text !== ELSEWHERE
}

test('/focus-show <代號> prints the report the focus band saved, as markdown in the command output', async ($, on) => {
  if (!(await start($, on, { '/tmp/wtc/show/PROJ-6668.md': REPORT, '/tmp/wtc/show/upgrade%232.md': '### ⏸ upgrade#2 回覆完畢' }, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  expect((await $.command.run({ command: 'focus-show', args: 'PROJ-6668' })).text).toBe(REPORT)
  expect((await $.command.run({ command: 'focus-show', args: 'upgrade#2' })).text).toBe('### ⏸ upgrade#2 回覆完畢')
  expect((await $.command.run({ command: 'focus-show', args: 'nope' })).text).toBe('[nope] 沒有可印的題目')
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'focus-show', surface, component: 'CommandOutput', props: { command: 'focus-show', args: 'PROJ-6668', text: REPORT, isErrored: false } })
    expect((await row.find({ type: 'Markdown' }))?.props.text).toBe(REPORT)
    await row.unmount()
  }
})

test('without WORKTREE_CONSOLE_HOME it reads the console home under ~/.config', async ($, on) => {
  if (!(await start($, on, { '/Users/me/.config/worktree-console/show/focusui.md': '### 💬 focusui 等你回應' }, { HOME: '/Users/me' }))) return
  expect((await $.command.run({ command: 'focus-show', args: 'focusui' })).text).toBe('### 💬 focusui 等你回應')
  expect((await $.command.run({ command: 'focus-show', args: '' })).text).toBe('用法：/focus-show <代號>')
})

test('a print the band queued carries the stop id: it prints that stop\'s own report only while that stop is still on the band', async ($, on) => {
  const [old, now] = ['pane-a@100', 'pane-a@200']
  const files = {
    '/tmp/wtc/focus.json': JSON.stringify({ current: now, seen: { [now]: 1 } }),
    '/tmp/wtc/show/PROJ-6668.md': '### ⏸ PROJ-6668 新題',
    [`/tmp/wtc/show/PROJ-6668@${stopId(old)}.md`]: '### 💬 PROJ-6668 舊題',
    [`/tmp/wtc/show/PROJ-6668@${stopId(now)}.md`]: '### ⏸ PROJ-6668 新題',
  }
  if (!(await start($, on, files, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  expect((await $.command.run({ command: 'focus-show', args: `PROJ-6668 ${stopId(old)}` })).text).toBe('[PROJ-6668] 這題已回覆或已交棒，略過')
  expect((await $.command.run({ command: 'focus-show', args: `PROJ-6668 ${stopId(now)}` })).text).toBe('### ⏸ PROJ-6668 新題')
  expect((await $.command.run({ command: 'focus-show', args: 'PROJ-6668' })).text).toBe('### ⏸ PROJ-6668 新題')
})

test('a queued print whose stop went back to the queue says it prints when its turn comes', async ($, on) => {
  const [queued, now] = ['pane-a@100', 'pane-b@200']
  const files = { '/tmp/wtc/focus.json': JSON.stringify({ current: now, seen: { [queued]: 1, [now]: 2 } }), [`/tmp/wtc/show/request@${stopId(queued)}.md`]: '### 💬 request 等你回應' }
  if (!(await start($, on, files, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  expect((await $.command.run({ command: 'focus-show', args: `request ${stopId(queued)}` })).text).toBe('[request] 這題已退回排隊，輪到時再印')
})

test('a queued print is skipped when the band has no question, or focus.json cannot be read', async ($, on) => {
  const id = stopId('pane-a@100')
  const files = { '/tmp/wtc/focus.json': JSON.stringify({ current: null }), [`/tmp/wtc/show/ticket@${id}.md`]: '### ⏸ ticket 定稿完成' }
  if (!(await start($, on, files, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  expect((await $.command.run({ command: 'focus-show', args: `ticket ${id}` })).text).toBe('[ticket] 這題已回覆或已交棒，略過')
  delete (files as any)['/tmp/wtc/focus.json']
  expect((await $.command.run({ command: 'focus-show', args: `ticket ${id}` })).text).toBe('[ticket] 這題已不在橫條上，略過')
})
