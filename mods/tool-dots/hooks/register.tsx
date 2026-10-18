import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import type { CallState } from '../types'

const DOTS_MAX = 24
const KEPT_MAX = 2000
const calls = atom({ plugin: 'tool-dots', key: 'calls' } as const, {} as Record<string, CallState>)

type Call = { id: string; tool: string } & CallState

// Set by the rows that know: a person's prompt row and a folded group say whether the view draws everything (ctrl+o, --verbose).
let expanded = false

const onlyReminders = (text: string) => !text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

// Runs of calls with nothing between them: a reply's text or a person's message ends a run, a tool result's own text does not.
function runsOf(messages: SessionMessage[]): { runs: Call[][]; open: boolean } {
  const runs: Call[][] = [[]]
  const cut = () => void (runs.at(-1)!.length && runs.push([]))
  let open = false
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.toolResults?.length) open = true
      else if (!onlyReminders(m.text)) (cut(), (open = false))
      continue
    }
    if (m.text.trim()) (cut(), (open = false))
    for (const use of m.toolUses) {
      runs.at(-1)!.push({ id: use.tool_use_id, tool: use.tool, running: use.text === undefined, errored: !!use.isError })
      open = true
    }
  }
  return { runs: runs.filter(r => r.length), open }
}

// The run a row belongs to; a call the transcript does not hold yet joins the last run when nothing came after that run's calls.
async function runOf($: EngineInterface, call: Call) {
  const { runs, open } = runsOf(await $.session.messages())
  const at = runs.findIndex(r => r.some(c => c.id === call.id))
  if (at >= 0) return { run: runs[at]!, last: at === runs.length - 1 }
  if (open && runs.length) return { run: [...runs.at(-1)!, call], last: true }
  return { run: [call], last: true }
}

const nameOf = (tool: string) => /^mcp__(.+?)__(.+)$/.exec(tool)?.slice(1).join(':') ?? tool

function summary(run: Call[]) {
  const counts = new Map<string, number>()
  for (const c of run) counts.set(nameOf(c.tool), (counts.get(nameOf(c.tool)) ?? 0) + 1)
  const errors = run.filter(c => c.errored).length
  return `tool_call: ${[...counts].map(([tool, n]) => `${tool} ×${n}`).join(' · ')}${errors ? ` - ${errors} error${errors > 1 ? 's' : ''}` : ''}`
}

const colorOf = (c: Call) => (c.running ? 'yellow' : c.errored ? 'red' : 'green')

type Element = (props: any) => any

async function drawLine($: EngineInterface, { Box, Text }: { Box: Element; Text: Element }, run: Call[], live: boolean) {
  // Only a run that can still change subscribes to the call states, so a finished history does not redraw on every call.
  const states = live ? await read($, calls) : {}
  const shown = run.map(c => ({ ...c, ...states[c.id] }))
  const dots: { color: string; n: number }[] = []
  for (const c of shown.slice(0, DOTS_MAX)) {
    const color = colorOf(c)
    if (dots.at(-1)?.color === color) dots.at(-1)!.n += 1
    else dots.push({ color, n: 1 })
  }
  const more = shown.length - DOTS_MAX
  return (
    <Box flexDirection="row">
      <Text wrap="truncate-end">
        {'  '}
        {dots.map((d, i) => <Text key={`dots:${i}`} color={d.color}>{'●'.repeat(d.n)}</Text>)}
        {more > 0 && <Text dimColor>{`+${more}`}</Text>}
        <Text dimColor>{`  ${summary(shown)}`}</Text>
      </Text>
    </Box>
  )
}

const nothing = ({ Box }: { Box: Element }) => <Box height={0} />

// tool-dots: a run of tool calls with no reply text between them draws as one line of dots and counts; ctrl+o shows them as they are.
export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    await update($, calls, all => {
      const keys = Object.keys(all)
      const kept = keys.length >= KEPT_MAX ? Object.fromEntries(keys.slice(-KEPT_MAX / 2).map(k => [k, all[k]!])) : all
      return { ...kept, [e.tool_use_id]: { running: true, errored: false } }
    })
    let errored = true
    try {
      const res = await next(e)
      errored = 'deny' in res || !!res.isError
      return res
    } finally {
      await update($, calls, all => ({ ...all, [e.tool_use_id]: { running: false, errored } }))
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!e.props.from && !e.props.task) expanded = e.props.isExpanded
    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (expanded) return next(e)
    const own: Call = { id: e.props.tool_use_id, tool: e.props.tool, running: e.props.isRunning, errored: e.props.isErrored || e.props.isInterrupted }
    const { run, last } = await runOf($, own)
    const ui = $.ui.resolve(e)
    if (run[0]!.id !== own.id) return nothing(ui)
    const lead = run.map(c => (c.id === own.id ? own : c))
    return drawLine($, ui, lead, last || lead.some(c => c.running))
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    expanded = e.props.isExpanded
    const ids = e.props.calls.map(c => c.tool_use_id)
    if (expanded || ids.some(id => !id)) return next(e)
    const first = e.props.calls[0]!
    const { run, last } = await runOf($, { id: first.tool_use_id!, tool: first.tool, running: first.isRunning, errored: first.isErrored || first.isInterrupted })
    const ui = $.ui.resolve(e)
    if (!ids.includes(run[0]!.id)) return nothing(ui)
    const own = new Map(e.props.calls.map(c => [c.tool_use_id!, { running: c.isRunning, errored: c.isErrored || c.isInterrupted }]))
    const lead = run.map(c => ({ ...c, ...own.get(c.id) }))
    return drawLine($, ui, lead, last || e.props.isActive || lead.some(c => c.running))
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (expanded) return next(e)
    return nothing($.ui.resolve(e))
  })
}
