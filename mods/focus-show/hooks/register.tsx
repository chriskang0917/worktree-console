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
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.props.text} />
  })
}
