import type { EngineInterface, Register } from 'claude-code'

async function home($: EngineInterface) {
  return (await $.env.get('WORKTREE_CONSOLE_HOME')) || `${await $.env.get('HOME')}/.config/worktree-console`
}

// The only focus.json format this reads; the worktree-console plugin's references/focus-contract.md says when it changes.
const VERSION = 1

async function readFocus($: EngineInterface, dir: string) {
  try {
    return JSON.parse(await $.fs.read(`${dir}/focus.json`))
  } catch {
    return null
  }
}

function versionError(tag: string, version: unknown) {
  if (version === VERSION) return null
  if (typeof version === 'number' && version > VERSION) return `[${tag}] 印不出題目：focus-show 太舊，不認得這個檔案格式，請更新 focus-show`
  return `[${tag}] 印不出題目：worktree-console 太舊，不認得這個檔案格式，請更新 worktree-console`
}

// Where that stop is now: on the band, still waiting in the queue, or gone.
function placeOf(state: any, id: string) {
  if (!state) return 'unknown'
  if (state.currentId === id) return 'band'
  return Array.isArray(state.queuedIds) && state.queuedIds.includes(id) ? 'queue' : 'gone'
}

// `/focus-show <代號>`: the worktree-console focus band saves a question's report under the console home, and this prints it as markdown.
// The band's own prints add the stop's id: one queued while the console was busy prints only if that stop is still on the band when it runs.
// It is its own plugin because a mod's `$.command.run` never reaches that same mod's `command.run` hook.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'focus-show', description: '中控台：把某題的完整回報印到對話', argumentHint: '<代號>' })
    return next(e)
  })

  on('command.run', { command: 'focus-show' }, async ($, e) => {
    const [tag, id] = e.args.trim().split(/\s+/)
    if (!tag) return { text: '用法：/focus-show <代號>' }
    const dir = await home($)
    const state = await readFocus($, dir)
    const error = state && versionError(tag, state.version)
    if (error) return { text: error }
    const place = id ? placeOf(state, id) : 'band'
    if (place === 'queue') return { text: `[${tag}] 這題已退回排隊，輪到時再印` }
    if (place === 'gone') return { text: `[${tag}] 這題已回覆或已交棒，略過` }
    if (place === 'unknown') return { text: `[${tag}] 這題已不在橫條上，略過` }
    try {
      return { text: await $.fs.read(`${dir}/show/${encodeURIComponent(tag)}${id ? `@${id}` : ''}.md`) }
    } catch {
      return { text: `[${tag}] 沒有可印的題目` }
    }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'focus-show' } }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const blocks = layout(e.props.text)
    const bold = (s: string) => s.split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 ? <Text bold>{part}</Text> : part)).filter(part => part !== '')
    const draw = (b: Block) => {
      if (b.kind === 'question') return <Text bold color="remember">{b.text.replace(/\*\*/g, '')}</Text>
      if (b.kind === 'option') return <Text>{'- '}<Text bold color="remember">{b.letter}</Text>{' '}{bold(b.text)}</Text>
      if (b.kind === 'advice') return <Text color="success"><Text bold>建議：</Text>{bold(b.text)}</Text>
      if (b.kind === 'rule') return <Text dimColor>{b.text}</Text>
      return <Markdown text={b.text} dimColor={b.kind === 'lead'} />
    }
    const groups: Block[][] = []
    for (const b of blocks) {
      const last = groups.at(-1)
      if (last && last[0]!.quoted === b.quoted) last.push(b)
      else groups.push([b])
    }
    return (
      <Box flexDirection="column">
        {groups.map(group => {
          const body = group.map((b, i) => <Box marginTop={i > 0 && b.gap ? 1 : 0}>{draw(b)}</Box>)
          // A blank row of its own, not a margin: the Claude Code in a herdr tab drew the rail over the margin above the quote.
          const gap = group[0]!.gap ? <Text> </Text> : null
          if (!group[0]!.quoted) return <Box flexDirection="column">{gap}{body}</Box>
          // One rail row per source character is more rows than the text can wrap to; the overflow is cut at the box's height.
          const rows = group.reduce((n, b) => n + b.rows, 0)
          return (
            <Box flexDirection="column">
              {gap}
              <Box flexDirection="column" paddingLeft={2}>
                <Box position="absolute" top={0} bottom={0} left={0} overflow="hidden"><Markdown dimColor text={Array(rows).fill('▎').join('  \n')} /></Box>
                {body}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}

type Shape =
  | { kind: 'markdown' | 'lead' | 'question' | 'advice' | 'rule'; text: string }
  | { kind: 'option'; letter: string; text: string }
type Block = Shape & { gap: boolean; quoted: boolean; rows: number }

const QUESTION = /^\*\*(第 ?\d+ ?題|待決定 ?\d+)[：:].*\*\*$/
const OPTION = /^- \*\*([a-z])\.\*\* ?(.*)$/
const ADVICE = /^建議[：:]\s*(.*)$/
const RULE = /^─+$/

// The console quotes every line of a child session's report with `>`: those lines draw with a rail on their left instead of the grey quote box.
// Question, option, advice and divider lines become their own blocks and the lines before the first question dim; with no question line, every line stays markdown.
function layout(text: string): Block[] {
  const raw = text.split('\n')
  const quoted = raw.map(l => l.startsWith('>'))
  const lines = raw.map(l => l.replace(/^> ?/, ''))
  const fence = (l: string) => /^\s*(```|~~~)/.test(l)
  let fenced = false
  const inFence = lines.map(l => {
    const was = fenced
    if (fence(l)) fenced = !fenced
    return was || fence(l)
  })
  const first = lines.findIndex((l, i) => !inFence[i] && QUESTION.test(l.trim()))
  const blocks: Block[] = []
  let chunk: { lines: string[]; dim: boolean; gap: boolean; quoted: boolean; rows: number } | null = null
  let gap = false
  let carried = 0
  const flush = () => {
    if (!chunk) return
    while (chunk.lines.at(-1) === '') chunk.lines.pop()
    blocks.push({ kind: chunk.dim ? 'lead' : 'markdown', text: chunk.lines.join('\n'), gap: chunk.gap, quoted: chunk.quoted, rows: chunk.rows })
    chunk = null
  }
  lines.forEach((l, i) => {
    const t = l.trim()
    const size = raw[i]!.length + 1
    const own = first < 0 || inFence[i] ? null : ownBlock(t)
    if (own) {
      flush()
      blocks.push({ ...own, gap: gap && blocks.length > 0, quoted: quoted[i]!, rows: size + carried })
      gap = false
      carried = 0
    } else if (t === '' && !inFence[i]) {
      if (chunk) {
        chunk.lines.push('')
        chunk.rows += size
      } else carried += size
      gap = true
    } else {
      const dim = i < first && !t.startsWith('#')
      if (chunk && (chunk.dim !== dim || chunk.quoted !== quoted[i])) flush()
      if (!chunk) {
        chunk = { lines: [], dim, gap: gap && blocks.length > 0, quoted: quoted[i]!, rows: carried }
        carried = 0
      }
      chunk.lines.push(l)
      chunk.rows += size
      gap = false
    }
  })
  flush()
  return blocks
}

function ownBlock(t: string): Shape | null {
  if (QUESTION.test(t)) return { kind: 'question', text: t }
  const option = t.match(OPTION)
  if (option) return { kind: 'option', letter: `${option[1]}.`, text: option[2] }
  const advice = t.match(ADVICE)
  if (advice) return { kind: 'advice', text: advice[1] }
  return RULE.test(t) ? { kind: 'rule', text: t } : null
}
