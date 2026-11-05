import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ELSEWHERE = 'focus-show is not the plugin under test'

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
    expect((await row.findAll({ type: 'Markdown' })).map(el => el.props.text).filter(t => !String(t).startsWith('▎'))).toEqual(['### 💬 PROJ-6668 等你回應', '你要 A、A＋另開後端票做 B，還是其他做法？', '- a. 這張票只在卡片上顯示「缺多少」（建議）\n- b. 卡片直接顯示狀態標籤'])
    await row.unmount()
  }
})

test('without WORKTREE_CONSOLE_HOME it reads the console home under ~/.config', async ($, on) => {
  if (!(await start($, on, { '/Users/me/.config/worktree-console/show/focusui.md': '### 💬 focusui 等你回應' }, { HOME: '/Users/me' }))) return
  expect((await $.command.run({ command: 'focus-show', args: 'focusui' })).text).toBe('### 💬 focusui 等你回應')
  expect((await $.command.run({ command: 'focus-show', args: '' })).text).toBe('用法：/focus-show <代號>')
})

test('a print the band queued carries the stop id: it prints that stop\'s own report only while that stop is still on the band', async ($, on) => {
  const [old, now] = ['k1', 'k2']
  const files = {
    '/tmp/wtc/focus.json': JSON.stringify({ version: 1, currentId: now, queuedIds: [] }),
    '/tmp/wtc/show/PROJ-6668.md': '### ⏸ PROJ-6668 新題',
    [`/tmp/wtc/show/PROJ-6668@${old}.md`]: '### 💬 PROJ-6668 舊題',
    [`/tmp/wtc/show/PROJ-6668@${now}.md`]: '### ⏸ PROJ-6668 新題',
  }
  if (!(await start($, on, files, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  expect((await $.command.run({ command: 'focus-show', args: `PROJ-6668 ${old}` })).text).toBe('[PROJ-6668] 這題已回覆或已交棒，略過')
  expect((await $.command.run({ command: 'focus-show', args: `PROJ-6668 ${now}` })).text).toBe('### ⏸ PROJ-6668 新題')
  expect((await $.command.run({ command: 'focus-show', args: 'PROJ-6668' })).text).toBe('### ⏸ PROJ-6668 新題')
})

test('a queued print whose stop went back to the queue says it prints when its turn comes', async ($, on) => {
  const [queued, now] = ['k1', 'k2']
  const files = { '/tmp/wtc/focus.json': JSON.stringify({ version: 1, currentId: now, queuedIds: [queued] }), [`/tmp/wtc/show/request@${queued}.md`]: '### 💬 request 等你回應' }
  if (!(await start($, on, files, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  expect((await $.command.run({ command: 'focus-show', args: `request ${queued}` })).text).toBe('[request] 這題已退回排隊，輪到時再印')
})

test('a queued print is skipped when the band has no question, or focus.json cannot be read', async ($, on) => {
  const id = 'k1'
  const files = { '/tmp/wtc/focus.json': JSON.stringify({ version: 1, currentId: null, queuedIds: [] }), [`/tmp/wtc/show/ticket@${id}.md`]: '### ⏸ ticket 定稿完成' }
  if (!(await start($, on, files, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  expect((await $.command.run({ command: 'focus-show', args: `ticket ${id}` })).text).toBe('[ticket] 這題已回覆或已交棒，略過')
  delete (files as any)['/tmp/wtc/focus.json']
  expect((await $.command.run({ command: 'focus-show', args: `ticket ${id}` })).text).toBe('[ticket] 這題已不在橫條上，略過')
})

test('a focus.json of a newer format than this focus-show knows prints one line saying to update focus-show, never the report', async ($, on) => {
  const files = { '/tmp/wtc/focus.json': JSON.stringify({ version: 2, currentId: 'k1', queuedIds: [] }), '/tmp/wtc/show/perm@k1.md': '### 🔐 perm 等你授權', '/tmp/wtc/show/perm.md': '### 🔐 perm 等你授權' }
  if (!(await start($, on, files, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  for (const args of ['perm k1', 'perm']) expect((await $.command.run({ command: 'focus-show', args })).text).toBe('[perm] 印不出題目：focus-show 太舊，不認得這個檔案格式，請更新 focus-show')
})

test('a focus.json with no version (worktree-console too old) prints one line saying to update worktree-console, never the report', async ($, on) => {
  const files = { '/tmp/wtc/focus.json': JSON.stringify({ current: 'pane-a@100', seen: { 'pane-a@100': 1 } }), '/tmp/wtc/show/perm@k1.md': '### 🔐 perm 等你授權', '/tmp/wtc/show/perm.md': '### 🔐 perm 等你授權' }
  if (!(await start($, on, files, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  for (const args of ['perm k1', 'perm']) expect((await $.command.run({ command: 'focus-show', args })).text).toBe('[perm] 印不出題目：worktree-console 太舊，不認得這個檔案格式，請更新 worktree-console')
})

const SHEET = [
  '### 💬 color 等你回應',
  '',
  '> 進度：正在查 /focus-show 印出的內容從哪裡產生。',
  '>',
  '> **第 1 題：批改單這樣定稿嗎？**',
  '>',
  '> **已決定**',
  '> 1. 灰框是回報文字自己帶的，出處 `lib.mjs:1341`',
  '>    - 每行都被加上引用符號',
  '>',
  '> ────────────────────',
  '>',
  '> **待決定 1：/focus-show 要改到什麼程度？**',
  '>',
  '> - **a.** 只拿掉引用框',
  '> - **b.** 拿掉引用框並把**重點**上色',
  '>',
  '> 建議：b，只有 b 做得到',
  '',
  '| | 選項 |',
  '| --- | --- |',
  '| a | 全照建議並動工（建議） |',
].join('\n')

test('/focus-show draws the sheet without the quote box: questions, options and advice styled, the lead before the first question dim', async ($, on) => {
  if (!(await start($, on, { '/tmp/wtc/show/color.md': SHEET }, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  expect((await $.command.run({ command: 'focus-show', args: 'color' })).text).toBe(SHEET)
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'focus-show', surface, component: 'CommandOutput', props: { command: 'focus-show', args: 'color', text: SHEET, isErrored: false } })
    const shown = [...(await row.findAll({ type: 'Text' })), ...(await row.findAll({ type: 'Markdown' }))]
    expect(shown.filter(el => el.text.split('\n').some(l => l.startsWith('>')))).toEqual([])

    for (const q of ['第 1 題：批改單這樣定稿嗎？', '待決定 1：/focus-show 要改到什麼程度？']) {
      expect((await row.find({ type: 'Text', text: q }))?.props).toMatchObject({ color: 'remember', bold: true })
    }
    const letters = (await row.findAll({ type: 'Text' })).filter(el => /^[a-z]\.$/.test(el.text))
    expect(letters.map(el => [el.text, el.props.color, el.props.bold])).toEqual([['a.', 'remember', true], ['b.', 'remember', true]])
    expect((await row.findAll({ type: 'Text', text: '重點' })).find(el => el.text === '重點')?.props.bold).toBe(true)
    const advice = (await row.findAll({ type: 'Text', text: '建議：b' })).at(0)
    expect(advice?.props.color).toBe('success')

    expect((await row.find({ type: 'Markdown', text: '進度：' }))?.props).toMatchObject({ text: '進度：正在查 /focus-show 印出的內容從哪裡產生。', dimColor: true })
    expect((await row.find({ type: 'Markdown', text: '### 💬' }))?.props.dimColor).toBeFalsy()
    expect((await row.find({ type: 'Text', text: '────' }))?.props.dimColor).toBe(true)
    expect((await row.find({ type: 'Markdown', text: '**已決定**' }))?.props.text).toBe('**已決定**\n1. 灰框是回報文字自己帶的，出處 `lib.mjs:1341`\n   - 每行都被加上引用符號')
    expect((await row.find({ type: 'Markdown', text: '| --- |' }))?.props).toMatchObject({ text: '| | 選項 |\n| --- | --- |\n| a | 全照建議並動工（建議） |' })
    await row.unmount()
  }
})

test('a report with no question line draws as markdown, only without the quote box', async ($, on) => {
  const report = '### ⏸ color 回覆完畢\n\n> 定稿完成（動工）：**color.md**\n>\n> - a. 照做'
  if (!(await start($, on, {}, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  const row = await $.ui.mount({ plugin: 'focus-show', surface: 'terminal', component: 'CommandOutput', props: { command: 'focus-show', args: 'color', text: report, isErrored: false } })
  expect((await row.findAll({ type: 'Markdown' })).map(el => el.props.text).filter(t => !String(t).startsWith('▎'))).toEqual(['### ⏸ color 回覆完畢', '定稿完成（動工）：**color.md**\n\n- a. 照做'])
  await row.unmount()
})

// The quoted part of a report: a Box that leaves two columns on its left, its first child the rail drawn over them.
async function quoted(row: any) {
  const boxes = await row.findAll({ type: 'Box' })
  return boxes.filter((b: any) => b.props.paddingLeft === 2 && b.children[0]?.props?.position === 'absolute' && b.children[0].children[0]?.type === 'Markdown').map((b: any) => {
    const [rail, ...body] = b.children
    const text = (el: any): string => (typeof el === 'string' ? el : [el.props?.text ?? '', ...(el.children ?? []).map(text)].join(''))
    return { box: b, rail, body: body.map(text).join('\n') }
  })
}

const LONG = '這一行故意寫得很長'.repeat(20)

test('/focus-show draws a rail left of every quoted line, blank and wrapped ones included, and the table right after them, none beside the heading', async ($, on) => {
  const sheet = SHEET.replace('> 進度：正在查 /focus-show 印出的內容從哪裡產生。', `> 進度：${LONG}`)
  if (!(await start($, on, {}, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'focus-show', surface, component: 'CommandOutput', props: { command: 'focus-show', args: 'color', text: sheet, isErrored: false } })
    const quotes = await quoted(row)
    expect(quotes).toHaveLength(1)
    const [{ rail, body }] = quotes
    expect(rail.props).toMatchObject({ position: 'absolute', top: 0, bottom: 0, left: 0, overflow: 'hidden' })
    expect(quotes[0].box.props.marginTop ?? 0).toBe(0)
    const bars = rail.children[0]
    expect(bars.props.dimColor).toBe(true)
    expect(bars.type).toBe('Markdown')
    const rows = (bars.props.text as string).split('  \n')
    expect(rows.every((r: string) => r === '▎')).toBe(true)
    expect(rows.length).toBeGreaterThan(sheet.split('\n').filter(l => l.startsWith('>')).join('').length)
    for (const t of [`進度：${LONG}`, '第 1 題：批改單這樣定稿嗎？', '已決定', '────', '待決定 1：/focus-show 要改到什麼程度？', '只拿掉引用框', '建議：', 'b，只有 b 做得到']) expect(body).toContain(t)
    for (const t of ['| --- |', '全照建議並動工']) expect(body).toContain(t)
    expect(body).not.toContain('### 💬 color 等你回應')
    expect((await row.find({ type: 'Markdown', text: '### 💬' }))?.props.text).toBe('### 💬 color 等你回應')
    await row.unmount()
  }
})

test('a report with no question line, a ⏸ reply among them, also draws the rail beside its quoted lines and not its heading', async ($, on) => {
  const report = `### ⏸ color 回覆完畢\n\n> 定稿完成（動工）：${LONG}\n>\n> - a. 照做`
  if (!(await start($, on, {}, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  const row = await $.ui.mount({ plugin: 'focus-show', surface: 'terminal', component: 'CommandOutput', props: { command: 'focus-show', args: 'color', text: report, isErrored: false } })
  const quotes = await quoted(row)
  expect(quotes.map(q => q.body)).toEqual([`定稿完成（動工）：${LONG}\n\n- a. 照做`])
  expect((quotes[0].rail.children[0].props.text as string).split('  \n').length).toBeGreaterThan(LONG.length)
  await row.unmount()
})

const TABLED = [
  '### ⏸ advisor 回覆完畢',
  '',
  '> **問題**：升版 commit 的 CI 停在「等待核准」。',
  '',
  '| PR | 升版 commit 的 CI |',
  '|---|---|',
  '| agent-skills #16 | b39b026 等待核准 |',
  '',
  '> **建議**：核准這兩次 CI 再合併。',
].join('\n')

test('a markdown table between quoted lines joins their rail: one quoted part runs over the text, the table and the text after it', async ($, on) => {
  if (!(await start($, on, {}, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'focus-show', surface, component: 'CommandOutput', props: { command: 'focus-show', args: 'advisor', text: TABLED, isErrored: false } })
    const quotes = await quoted(row)
    expect(quotes).toHaveLength(1)
    expect(quotes[0].body).toBe('**問題**：升版 commit 的 CI 停在「等待核准」。\n\n| PR | 升版 commit 的 CI |\n|---|---|\n| agent-skills #16 | b39b026 等待核准 |\n\n**建議**：核准這兩次 CI 再合併。')
    const outside = (await row.findAll({ type: 'Markdown' })).map(el => String(el.props.text)).filter(t => !t.startsWith('▎') && !quotes[0].body.includes(t))
    expect(outside).toEqual(['### ⏸ advisor 回覆完畢'])
    await row.unmount()
  }
})

const MENU = [
  '### 💬 color 等你選擇',
  '',
  '> 第 1 題 **顏色**　警示用什麼顏色？',
  '',
  '| # | 選項 | 說明 |',
  '| --- | --- | --- |',
  '| a | **深琥珀** | 比紅色暗 |',
  '| b | 其他 | 自行輸入 |',
  '',
  '> 第 2 題 **數字**　兩個數字分開算嗎？',
  '',
  '| # | 選項 | 說明 |',
  '| --- | --- | --- |',
  '| a | 分開 | 不重疊 |',
  '| b | 其他 | 自行輸入 |',
].join('\n')

test('a menu question\'s option tables sit in the same column as its question and on the same rail, the last table included', async ($, on) => {
  if (!(await start($, on, {}, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  const row = await $.ui.mount({ plugin: 'focus-show', surface: 'terminal', component: 'CommandOutput', props: { command: 'focus-show', args: 'color', text: MENU, isErrored: false } })
  const quotes = await quoted(row)
  expect(quotes).toHaveLength(1)
  for (const t of ['警示用什麼顏色？', '| a | **深琥珀** | 比紅色暗 |', '兩個數字分開算嗎？', '| a | 分開 | 不重疊 |']) expect(quotes[0].body).toContain(t)
  expect((quotes[0].rail.children[0].props.text as string).split('  \n').length).toBeGreaterThanOrEqual(MENU.split('\n').length - 2)
  await row.unmount()
})

const PLAIN_MENU = [
  '### 💬 import-v3 等你回應',
  '',
  `> 第 1 題：${LONG}`,
  '> a) 不標',
  '>',
  '> 第 2 題：顯示哪一個？',
  '',
  '第 1 題',
  '- a. 不標需提醒（建議）',
  '- b. 照樣標需提醒',
  '',
  '第 2 題',
  '- a. 顯示「上次上傳失敗」（建議）',
  '- b. 顯示「有異常」',
  '',
  '整體',
  '- a. 全照建議（1 a、2 a）',
].join('\n')

// A part outside the quote: the same two left columns, the absolute column over them blank instead of a rail.
async function unquoted(row: any) {
  const boxes = await row.findAll({ type: 'Box' })
  return boxes.filter((b: any) => b.props.paddingLeft === 2 && b.children[0]?.props?.position === 'absolute' && b.children[0].children[0]?.type === 'Text').map((b: any) => {
    const [cover, ...body] = b.children
    const text = (el: any): string => (typeof el === 'string' ? el : [el.props?.text ?? '', ...(el.children ?? []).map(text)].join(''))
    return { cover, body: body.map(text).join('\n') }
  })
}

test('lines outside the quote start two columns in, in line with the quoted text, over a blank column that covers a rail run past a tall quote', async ($, on) => {
  if (!(await start($, on, {}, { WORKTREE_CONSOLE_HOME: '/tmp/wtc' }))) return
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({ plugin: 'focus-show', surface, component: 'CommandOutput', props: { command: 'focus-show', args: 'import-v3', text: PLAIN_MENU, isErrored: false } })
    const quotes = await quoted(row)
    expect(quotes).toHaveLength(1)
    const outside = await unquoted(row)
    expect(outside.map(o => o.body)).toEqual(['### 💬 import-v3 等你回應', '第 1 題\n- a. 不標需提醒（建議）\n- b. 照樣標需提醒\n\n第 2 題\n- a. 顯示「上次上傳失敗」（建議）\n- b. 顯示「有異常」\n\n整體\n- a. 全照建議（1 a、2 a）'])
    const after = outside[1]
    expect(after.cover.props).toMatchObject({ position: 'absolute', top: 0, bottom: 0, left: 0, overflow: 'hidden' })
    const cover = (after.cover.children[0].children.join('') as string).split('\n')
    expect(cover.every(r => r === '  ')).toBe(true)
    expect(cover.length).toBeGreaterThanOrEqual(after.body.length)
    await row.unmount()
  }
})
