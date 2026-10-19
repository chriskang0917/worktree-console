import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'tool-dots'

type Use = { id: string; tool: string; done?: boolean; error?: boolean }
const use = ({ id, tool, done = true, error }: Use) => ({ tool_use_id: id, tool, input: {}, ...(done ? { text: error ? 'boom' : 'ok', ...(error ? { isError: true as const } : {}) } : {}) })
const reply = (text: string, uses: Use[] = []) => ({ role: 'assistant' as const, text, toolUses: uses.map(use) })
const results = (uses: Use[], text = '') => ({ role: 'user' as const, text, toolUses: [], toolResults: uses.map(u => ({ tool_use_id: u.id, text: 'ok', ...(u.error ? { isError: true } : {}) })) })
const prompt = (text: string) => ({ role: 'user' as const, text, toolUses: [] })
const calls = (tool: string, n: number, from = 0, extra: Partial<Use> = {}): Use[] => Array.from({ length: n }, (_, i) => ({ id: `${tool}-${from + i}`, tool, ...extra }))

function world(on: On, messages: () => unknown[]) {
  on('session.messages', async () => ({ value: messages() as any }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

const toolRow = (u: Use, extra: object = {}) => ({
  plugin: PLUGIN,
  component: 'ToolUse' as const,
  requestId: u.id,
  props: { tool_use_id: u.id, tool: u.tool, input: {}, isRunning: u.done === false, isErrored: !!u.error, isInterrupted: false, ...extra },
})

const userRow = (isExpanded: boolean) => ({ plugin: PLUGIN, component: 'UserMessage' as const, props: { text: 'hi', origin: { kind: 'user' }, isExpanded } as any })

// What a row draws: the line's text, each mark's colour and glyph, or nothing (a zero-height box) for a row the line already covers.
async function draw($: any, target: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ ...target, surface })
  const root: any = await ui.drawn()
  await ui.unmount()
  const text = (n: any): string => (typeof n === 'string' ? n : (n?.children ?? []).map(text).join(''))
  const colours: string[] = []
  const marks: string[] = []
  const walk = (n: any) => {
    if (typeof n !== 'object' || !n) return
    if (n.type === 'Text' && n.props?.color) for (const c of text(n)) if (c === '●' || c === '✕') colours.push(n.props.color), marks.push(c)
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)
  const hidden = root.type === 'Box' && root.props?.height === 0 && !(root.children ?? []).length
  return { text: text(root), colours, marks, hidden, root }
}

// `claude plugin test` from the worktree-console root finds this file too; there tool-dots is not loaded and the test stands down.
async function loaded($: any) {
  const ui = await $.ui.mount({ ...toolRow({ id: 'probe', tool: 'Bash' }), surface: 'terminal' }).catch(() => null)
  if (!ui) return false
  const drawn: any = await ui.drawn()
  await ui.unmount()
  return JSON.stringify(drawn).includes('tool_call')
}

test('a run of calls with no reply text between them is one line: a dot per call and each tool counted in first-seen order', async ($, on) => {
  const run = [...calls('Bash', 2), ...calls('Read', 2), ...calls('Bash', 1, 2)]
  world(on, () => [prompt('go'), reply('', run.slice(0, 2)), results(run.slice(0, 2)), reply('', run.slice(2)), results(run.slice(2))])
  if (!(await loaded($))) return
  for (const surface of ['terminal', 'desktop'] as const) {
    const first = await draw($, toolRow(run[0]!), surface)
    expect(first.text).toBe('  ●●●●●  tool_call: Bash ×3 · Read ×2')
    expect(first.colours).toEqual(Array(5).fill('green'))
    for (const u of run.slice(1)) expect((await draw($, toolRow(u), surface)).hidden).toBe(true)
  }
})

test('running dots are yellow, finished green, failed a red ✕ after them on terminal and desktop; failures add - 1 error / - 2 errors, none adds nothing', async ($, on) => {
  const run: Use[] = [{ id: 'a', tool: 'Bash' }, { id: 'b', tool: 'Bash', error: true }, { id: 'c', tool: 'Read', done: false }]
  let messages: unknown[] = []
  world(on, () => messages)
  if (!(await loaded($))) return
  messages = [reply('', run)]
  for (const surface of ['terminal', 'desktop'] as const) {
    const line = await draw($, toolRow(run[0]!), surface)
    expect(line.colours).toEqual(['green', 'yellow', 'red'])
    expect(line.marks).toEqual(['●', '●', '✕'])
    expect(line.text).toBe('  ●●✕  tool_call: Bash ×2 · Read ×1 - 1 error')
  }
  messages = [reply('', [run[0]!, run[1]!, { id: 'c', tool: 'Read', error: true }])]
  let line = await draw($, toolRow(run[0]!))
  expect(line.colours).toEqual(['green', 'red', 'red'])
  expect(line.text).toBe('  ●✕✕  tool_call: Bash ×2 · Read ×1 - 2 errors')
  messages = [reply('', [{ id: 'a', tool: 'Bash' }, { id: 'b', tool: 'Bash', error: true }, { id: 'c', tool: 'Read', done: false }, { id: 'd', tool: 'Read', error: true }, { id: 'e', tool: 'Bash' }])]
  line = await draw($, toolRow(run[0]!))
  expect(line.colours).toEqual(['green', 'yellow', 'green', 'red', 'red'])
  expect(line.text).toBe('  ●●●✕✕  tool_call: Bash ×3 · Read ×2 - 2 errors')
  messages = [reply('', [{ id: 'a', tool: 'Bash' }])]
  expect((await draw($, toolRow(run[0]!))).text).toBe('  ●  tool_call: Bash ×1')
})

test('reply text or a person\'s message between calls splits them into two lines; reminders riding on a tool result do not', async ($, on) => {
  const [a, b, c, d] = calls('Bash', 4)
  world(on, () => [
    reply('', [a!]), results([a!], '<system-reminder>\nThe date changed.\n</system-reminder>'),
    reply('', [b!]), results([b!]),
    reply('我先看一下結果。', [c!]), results([c!]),
    prompt('再跑一次'), reply('', [d!]), results([d!]),
  ])
  if (!(await loaded($))) return
  expect((await draw($, toolRow(a!))).text).toBe('  ●●  tool_call: Bash ×2')
  expect((await draw($, toolRow(b!))).hidden).toBe(true)
  expect((await draw($, toolRow(c!))).text).toBe('  ●  tool_call: Bash ×1')
  expect((await draw($, toolRow(d!))).text).toBe('  ●  tool_call: Bash ×1')
})

test('past 24 calls only 24 dots are drawn, then a dim +N', async ($, on) => {
  const run = calls('Bash', 30)
  world(on, () => [reply('', run)])
  if (!(await loaded($))) return
  const line = await draw($, toolRow(run[0]!))
  expect(line.colours).toHaveLength(24)
  expect(line.text).toBe(`  ${'●'.repeat(24)}+6  tool_call: Bash ×30`)
  const plus = (function find(n: any): any {
    if (typeof n !== 'object' || !n) return undefined
    if (n.type === 'Text' && (n.children ?? []).join('') === '+6') return n
    for (const c of n.children ?? []) { const hit = find(c); if (hit) return hit }
  })(line.root)
  expect(plus?.props.dimColor).toBe(true)
})

test('the line is indented two cells under the reply text, two cells sit between the dots and tool_call whatever the dot count, and the tool_call text is dim while the dots keep their colours', async ($, on) => {
  // ✕ (U+2715) is one cell wide: a single code point that is not an emoji, unlike ❌, which takes two.
  expect([...'✕']).toHaveLength(1)
  expect(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test('✕')).toBe(false)
  let messages: unknown[] = []
  world(on, () => messages)
  if (!(await loaded($))) return
  const findDim = (n: any): any => {
    if (typeof n !== 'object' || !n) return undefined
    if (n.type === 'Text' && (n.children ?? []).join('').includes('tool_call')) return n
    for (const c of n.children ?? []) { const hit = findDim(c); if (hit) return hit }
  }
  for (const n of [1, 9, 24, 30]) {
    const run: Use[] = calls('Bash', n).map((u, i) => (i === 0 ? { ...u, error: true } : i === 1 ? { ...u, done: false } : u))
    messages = [reply('', run)]
    const line = await draw($, toolRow(run[0]!))
    expect(line.text).toMatch(/^ {2}●*✕(\+\d+)? {2}tool_call: /)
    expect(line.text.indexOf('tool_call')).toBe(2 + Math.min(n, 24) + (n > 24 ? `+${n - 24}`.length : 0) + 2)
    expect(line.colours.at(-1)).toBe('red')
    if (n > 1) expect(line.colours[0]).toBe('yellow')
    if (n > 2) expect(line.colours.at(-2)).toBe('green')
    const text = findDim(line.root)
    expect(text.props.dimColor).toBe(true)
    expect(text.props.color).toBeUndefined()
    expect((text.children ?? []).join('')).toContain(' - 1 error')
  }
})

test('an MCP tool shows as server:tool', async ($, on) => {
  const run: Use[] = [{ id: 'm1', tool: 'mcp__linear-server__get_issue' }, { id: 'm2', tool: 'mcp__claude_ai_Gmail__authenticate' }, { id: 'm3', tool: 'mcp__linear-server__get_issue' }]
  world(on, () => [reply('', run)])
  if (!(await loaded($))) return
  expect((await draw($, toolRow(run[0]!))).text).toBe('  ●●●  tool_call: linear-server:get_issue ×2 · claude_ai_Gmail:authenticate ×1')
})

test('folded, a result block draws nothing; with ctrl+o (or --verbose) every call and its result draw as the engine has them', async ($, on) => {
  const run = calls('Bash', 2)
  world(on, () => [reply('', run)])
  if (!(await loaded($))) return
  const result = { plugin: PLUGIN, component: 'ToolResult' as const, requestId: run[0]!.id, props: { tool_use_id: run[0]!.id, tool: 'Bash', output: { stdout: 'x' }, isErrored: false } as any }
  expect((await draw($, result)).hidden).toBe(true)
  await draw($, userRow(true))
  for (const u of run) expect((await draw($, toolRow(u))).text).toBe('engine')
  expect((await draw($, result)).text).toBe('engine')
  await draw($, userRow(false))
  expect((await draw($, result)).hidden).toBe(true)
  expect((await draw($, toolRow(run[0]!))).text).toBe('  ●●  tool_call: Bash ×2')
})

test('a group the engine folds (reads, searches) joins the run: the group holding the first call draws the line, any other draws nothing; expanded it is the engine\'s', async ($, on) => {
  const run = [...calls('Bash', 1), ...calls('Read', 2), ...calls('Grep', 1)]
  world(on, () => [reply('', run)])
  if (!(await loaded($))) return
  const group = (members: Use[], isExpanded = false) => ({
    plugin: PLUGIN, component: 'ToolGroup' as const,
    props: { calls: members.map(u => ({ tool_use_id: u.id, tool: u.tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false })), isActive: false, isExpanded },
  })
  expect((await draw($, group(run.slice(1)))).hidden).toBe(true)
  expect((await draw($, group(run.slice(0, 3)))).text).toBe('  ●●●●  tool_call: Bash ×1 · Read ×2 · Grep ×1')
  expect((await draw($, group(run.slice(1), true))).text).toBe('engine')
  await draw($, userRow(false))
})

test('a call the transcript does not hold yet joins the open run at once, so its row never draws expanded first', async ($, on) => {
  const [a, b] = calls('Bash', 2)
  world(on, () => [reply('', [a!]), results([a!])])
  if (!(await loaded($))) return
  expect((await draw($, toolRow({ ...b!, done: false }))).hidden).toBe(true)
  const fresh = await draw($, toolRow({ id: 'new', tool: 'Bash', done: false }))
  expect(fresh.hidden).toBe(true)
})

test('the line follows its calls live: a call that is running shows yellow, then green once it answers', async ($, on) => {
  const ids: string[] = []
  let release: () => void = () => {}
  on('tool.call', async (_$, e) => {
    ids.push(e.tool_use_id)
    await new Promise<void>(resolve => (release = resolve))
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as any
  })
  let messages: unknown[] = []
  world(on, () => messages)
  if (!(await loaded($))) return
  const running = $.tool.call({ tool: 'Bash', command: 'true' } as any)
  while (!ids.length) await new Promise(resolve => setTimeout(resolve, 1))
  const [id] = ids
  messages = [reply('', [{ id: id!, tool: 'Bash', done: false }])]
  const ui = await $.ui.mount({ ...toolRow({ id: id!, tool: 'Bash' }, { isRunning: false }), surface: 'terminal' })
  const colour = async () => JSON.stringify(await ui.drawn()).match(/"color":"(\w+)"/)?.[1]
  expect(await colour()).toBe('yellow')
  release()
  await running
  messages = [reply('', [{ id: id!, tool: 'Bash' }])]
  expect(await colour()).toBe('green')
  await ui.unmount()
})
