import type { On, SessionMessage } from 'claude-code'
import { KEEPALIVE_REPLY, KEEPALIVE_TEXT } from './keepalive-text.mjs'

// Set by a person's prompt row: whether the view draws everything (ctrl+o, --verbose).
let expanded = false

const squash = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+/g, ' ').trim()
const isKeepalive = (text: string) => squash(text) === KEEPALIVE_TEXT
const isBareReply = (text: string) => squash(text).replace(/[\s。.!！]/g, '') === KEEPALIVE_REPLY

// Whether every bare 收到 reply in the conversation answers a keepalive, and at least one does.
function repliesAreKeepalive(messages: SessionMessage[]) {
  let afterKeepalive = false
  let kept = 0
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.toolResults?.length || !squash(m.text)) continue
      afterKeepalive = isKeepalive(m.text)
      continue
    }
    if (!m.text.trim() && !m.toolUses.length) continue
    if (isBareReply(m.text) && !m.toolUses.length) {
      if (!afterKeepalive) return false
      kept += 1
    }
    afterKeepalive = false
  }
  return kept > 0
}

// The console's keepalive message and the bare 收到 it asks for draw nothing; ctrl+o shows them as they are.
export function registerKeepaliveView(on: On) {
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.from || e.props.task) return next(e)
    expanded = e.props.isExpanded
    if (expanded || !isKeepalive(e.props.text)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box height={0} />
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (expanded || e.props.isSummary || !isBareReply(e.props.text)) return next(e)
    if (!repliesAreKeepalive(await $.session.messages())) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box height={0} />
  })
}
