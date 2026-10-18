import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { KEEPALIVE_REPLY, KEEPALIVE_TEXT } from './keepalive-text.mjs'

const PLUGIN = 'worktree-console'

const prompt = (text: string) => ({ role: 'user' as const, text, toolUses: [] })
const reply = (text: string, tools: string[] = []) => ({ role: 'assistant' as const, text, toolUses: tools.map(id => ({ tool_use_id: id, tool: 'Bash', input: {}, text: 'ok' })) })
const results = (id: string) => ({ role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'ok' }] })

function world(on: On, messages: () => unknown[]) {
  on('session.messages', async () => ({ value: messages() as any }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

const userRow = (text: string, isExpanded = false, extra: object = {}) => ({ plugin: PLUGIN, component: 'UserMessage' as const, props: { text, origin: { kind: 'user' }, isExpanded, ...extra } as any })
const replyRow = (text: string) => ({ plugin: PLUGIN, component: 'AssistantMessage' as const, props: { text, isFirstOfReply: true } as any })

async function hidden($: any, target: any) {
  const ui = await $.ui.mount({ ...target, surface: 'terminal' })
  const root: any = await ui.drawn()
  await ui.unmount()
  return root.type === 'Box' && root.props?.height === 0 && !(root.children ?? []).length
}

const KEPT = [prompt('改登入頁'), reply('改好了，要不要也改註冊頁？'), prompt(KEEPALIVE_TEXT), reply(KEEPALIVE_REPLY)]

test('續命訊息與緊接的「收到」不畫；ctrl+o（或 --verbose）時兩則照原樣出現', async ($, on) => {
  world(on, () => KEPT)
  expect(await hidden($, userRow(KEEPALIVE_TEXT))).toBe(true)
  expect(await hidden($, replyRow(KEEPALIVE_REPLY))).toBe(true)
  expect(await hidden($, replyRow(`${KEEPALIVE_REPLY}。`))).toBe(true)
  expect(await hidden($, userRow(KEEPALIVE_TEXT, true))).toBe(false)
  expect(await hidden($, replyRow(KEEPALIVE_REPLY))).toBe(false)
  expect(await hidden($, userRow('改登入頁', false))).toBe(false)
  expect(await hidden($, replyRow(KEEPALIVE_REPLY))).toBe(true)
})

test('使用者自己打的訊息、和續命訊息不完全相同的訊息照常顯示；其他回覆照常顯示', async ($, on) => {
  world(on, () => KEPT)
  for (const text of ['改登入頁', `${KEEPALIVE_TEXT}再多一句`, KEEPALIVE_TEXT.slice(1), '收到']) expect(await hidden($, userRow(text))).toBe(false)
  expect(await hidden($, replyRow('改好了，要不要也改註冊頁？'))).toBe(false)
  expect(await hidden($, userRow(KEEPALIVE_TEXT, false, { from: { kind: 'session' } }))).toBe(false)
})

test('續命後的回覆不是單純「收到」（多講話或呼叫工具）時照常顯示', async ($, on) => {
  let messages: unknown[] = []
  world(on, () => messages)
  for (const tail of [[reply('收到，我順便看了一下測試。')], [reply(KEEPALIVE_REPLY, ['t1']), results('t1')]]) {
    messages = [...KEPT.slice(0, 3), ...tail]
    expect(await hidden($, userRow(KEEPALIVE_TEXT))).toBe(true)
    for (const m of tail) if (m.role === 'assistant') expect(await hidden($, replyRow(m.text))).toBe(false)
  }
})

test('使用者自己要的「收到」（前面不是續命訊息）照常顯示', async ($, on) => {
  world(on, () => [prompt('看到請回收到'), reply(KEEPALIVE_REPLY)])
  expect(await hidden($, replyRow(KEEPALIVE_REPLY))).toBe(false)
})
