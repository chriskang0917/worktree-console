import { columns, truncateColumns, TASK_STATUS_VIEW, type TaskStatus } from './status-view.ts'

type TaskItem = { id: string; parentId?: string; order: number; kind: 'group' | 'leaf'; status: TaskStatus; title: string; blockedBy: string[] }
type TaskEvent = { revision: number; occurredAt: number; command: string; resultId?: string; resultStatus?: string }
export type TaskState = { title: string; items: TaskItem[]; reports: { id: string; itemId: string; ack: boolean }[]; events: TaskEvent[] }
export type TaskView = { completed: boolean; timelineLimit: number }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isTaskStatus = (value: unknown): value is TaskStatus => typeof value === 'string' && Object.hasOwn(TASK_STATUS_VIEW, value)
const oneLine = (text: string) => text.replace(/[\p{Cc}\s]+/gu, ' ').trim()

// The task-list CLI validates task-state.json on every write; this guards only what the panel draws, so a hand-edited
// file shows the unreadable notice instead of a broken tree.
export function parseTaskState(text: string): TaskState {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || typeof value.title !== 'string' || !Array.isArray(value.items) || !Array.isArray(value.reports) || !Array.isArray(value.events)) throw new Error('task-state.json')
  const items = value.items.map((item: unknown): TaskItem => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || (item.kind !== 'group' && item.kind !== 'leaf') || !isTaskStatus(item.status) || typeof item.order !== 'number') throw new Error('task-state.json items')
    const blockedBy = Array.isArray(item.blockedBy) ? item.blockedBy.filter((id: unknown): id is string => typeof id === 'string') : []
    return { id: item.id, order: item.order, kind: item.kind, status: item.status, title: oneLine(item.title), blockedBy, ...(typeof item.parentId === 'string' ? { parentId: item.parentId } : {}) }
  })
  const reports = value.reports.map((report: unknown) => {
    if (!isRecord(report) || typeof report.id !== 'string' || typeof report.itemId !== 'string') throw new Error('task-state.json reports')
    return { id: report.id, itemId: report.itemId, ack: !!report.ack }
  })
  const events = value.events.map((event: unknown): TaskEvent => {
    const occurredAt = isRecord(event) && typeof event.occurredAt === 'string' ? Date.parse(event.occurredAt) : NaN
    if (!isRecord(event) || typeof event.revision !== 'number' || !Number.isFinite(occurredAt)) throw new Error('task-state.json events')
    const result = isRecord(event.result) ? event.result : {}
    return {
      revision: event.revision,
      occurredAt,
      command: typeof event.command === 'string' ? event.command : '',
      ...(typeof result.id === 'string' ? { resultId: result.id } : {}),
      ...(typeof result.status === 'string' ? { resultStatus: result.status } : {}),
    }
  })
  return { title: oneLine(value.title), items, reports, events }
}

export function parseTaskMode(text: string): string | null {
  const mode: unknown = JSON.parse(text)
  return isRecord(mode) && typeof mode.task === 'string' ? mode.task : null
}

// Defaults and limits as the task-list CLI reads `.console/config.json`; anything it would refuse falls back here.
export function parseTaskView(text: string | null): TaskView {
  let view: unknown
  try { view = text === null ? undefined : (JSON.parse(text) as { view?: unknown })?.view } catch {}
  const values = isRecord(view) ? view : {}
  const limit = values.timelineLimit
  return { completed: values.completed === 'expanded', timelineLimit: Number.isSafeInteger(limit) && (limit as number) > 0 ? (limit as number) : 20 }
}

const TASK_URGENCY = ['waiting', 'blocked', 'review', 'doing', 'queued', 'parked'] as const satisfies readonly TaskStatus[]
const URGENT: readonly TaskStatus[] = ['waiting', 'blocked', 'review']
const isSettled = (item: TaskItem) => item.status === 'done' || item.status === 'cancelled'
const byOrder = (a: TaskItem, b: TaskItem) => a.order - b.order

export const liveRootCount = (state: TaskState | null) => state?.items.filter(item => item.parentId === undefined && !isSettled(item)).length ?? 0
export const isSettledItem = (state: TaskState | null, id: string) => !!state?.items.some(item => item.id === id && isSettled(item))

// Panel-only: a group wears its most urgent open child, which the CLI's stored group status does not say.
function groupTone(item: TaskItem, children: TaskItem[]): TaskStatus {
  if (!children.length) return item.status
  const open = TASK_URGENCY.find(status => children.some(child => child.status === status))
  if (open) return open
  return children.some(child => child.status === 'done') ? 'done' : item.status
}

const TASK_ACTIONS: Record<string, string> = {
  'item add': '新增', 'item update': '更新', 'item move': '移動', 'item reopen': '重開', 'item cancel': '取消',
  'report accept': '驗收通過', 'report reject': '驗收退回', 'report ack': '已核對',
  建立任務: '建立任務', compact: '整理歷史', 'history restore': '還原歷史', migrate: '升級格式', close: '結案', archive: '結案',
}
function taskAction(event: TaskEvent): string {
  if (event.command === 'report submit') return event.resultStatus === 'review' ? '送驗收' : event.resultStatus === 'blocked' ? '交付未過' : '交付'
  return TASK_ACTIONS[event.command] ?? '更新'
}

export const clockText = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
function sinceText(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return '剛剛'
  if (minutes < 60) return `${minutes} 分鐘前`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小時前`
  const date = new Date(at)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export type TodoRow =
  | { kind: 'note'; text: string }
  | { kind: 'blank' }
  | { kind: 'summary'; parts: { status: TaskStatus; count: number; label: string }[]; stars: number; starLabel: string }
  | { kind: 'gap' }
  | { kind: 'root'; id: string; key?: string; last: boolean; tone: TaskStatus; title: string; open: boolean; star: string; pad: number; cluster: string; dim: boolean }
  | { kind: 'meta'; last: boolean; text: string }
  | { kind: 'child'; last: boolean; lastChild: boolean; rail: TaskStatus | null; status: TaskStatus; title: string; star: string; dependency: string; dim: boolean }
  | { kind: 'dependency'; last: boolean; lastChild: boolean; text: string }
  | { kind: 'more'; key: string; last: boolean; groupId: string; text: string }
  | { kind: 'completed'; key: string; text: string }
  | { kind: 'timeline'; key: string; text: string }

export const todoKeyOf = (row: TodoRow) => (row.kind === 'root' || row.kind === 'more' || row.kind === 'completed' || row.kind === 'timeline' ? row.key : undefined)

const TIME_SLOT = 9
const TITLE_MAX = 36
// Rail `├─ `, glyph and space, then ` ▾` after the title.
const ROOT_CHROME = 7
// `│  ` under the group, then the child's rail, glyph and space.
const CHILD_CHROME = 8
const MIN_DEPENDENCY = 8
const CHILDREN_SHOWN = 4
const CHILDREN_KEPT = 3

export type TodoLayout = {
  state: TaskState | null
  cols: number
  now: number
  // HH:MM of the last good read once a later read failed; '' when the file was never readable.
  staleSince: string | null
  collapsed: ReadonlySet<string>
  showAllChildren: ReadonlySet<string>
  completedOpen: boolean
  timelineOpen: boolean
  timelineLimit: number
}

// One row per terminal line, in screen order: nothing wraps, so scrolling and selection count rows.
export function todoRows({ state, cols, now, staleSince, collapsed, showAllChildren, completedOpen, timelineOpen, timelineLimit }: TodoLayout): TodoRow[] {
  const rows: TodoRow[] = []
  if (staleSince !== null) rows.push({ kind: 'note', text: truncateColumns(state ? `讀不到任務清單，顯示 ${staleSince} 的資料` : '讀不到任務清單，請執行 task-todos 檢查', cols) })
  if (!state) return rows
  const byId = new Map(state.items.map(item => [item.id, item]))
  const childrenOf = (id: string) => state.items.filter(item => item.parentId === id).sort(byOrder)
  const hasChildren = new Set(state.items.flatMap(item => (item.parentId === undefined ? [] : [item.parentId])))
  const endpoints = state.items.filter(item => !hasChildren.has(item.id))
  const starred = new Set(state.reports.filter(report => !report.ack).map(report => report.itemId))
  const reportItem = new Map(state.reports.map(report => [report.id, report.itemId]))
  const eventItem = (event: TaskEvent) => byId.get(reportItem.get(event.resultId ?? '') ?? event.resultId ?? '')

  if (!state.items.length) rows.push({ kind: 'note', text: '尚無待辦' }, { kind: 'blank' })
  else {
    const stars = state.reports.filter(report => !report.ack).length
    const counts = TASK_URGENCY.flatMap(status => {
      const count = endpoints.filter(item => item.status === status).length
      return count ? [{ status, count }] : []
    })
    const summary = (shown: typeof counts, labelled: (status: TaskStatus) => boolean) => {
      const parts = shown.map(part => ({ ...part, label: labelled(part.status) ? TASK_STATUS_VIEW[part.status].label : '' }))
      const starLabel = labelled('waiting') ? '未核對' : ''
      const texts = [...parts.map(part => `${TASK_STATUS_VIEW[part.status].glyph} ${part.count}${part.label ? ` ${part.label}` : ''}`), ...(stars ? [`★ ${stars}${starLabel ? ` ${starLabel}` : ''}`] : [])]
      return { row: { kind: 'summary' as const, parts, stars, starLabel }, width: texts.reduce((n, text, i) => n + columns(text) + (i ? 3 : 0), 0) }
    }
    // Every status at once can outgrow the pane, and the row never wraps: labels go first (calm ones before urgent
    // ones), then the least urgent counts (停泊, 待辦, 進行), so the ★ count is never the part cut off.
    let fitted = summary(counts, status => cols >= 80 || (cols >= 46 && URGENT.includes(status)))
    if (fitted.width > cols && cols >= 46) fitted = summary(counts, status => URGENT.includes(status))
    if (fitted.width > cols) fitted = summary(counts, () => false)
    for (let kept = counts.length; fitted.width > cols && kept > 0 && !URGENT.includes(counts[kept - 1]!.status); kept--) fitted = summary(counts.slice(0, kept - 1), () => false)
    rows.push(fitted.row, { kind: 'blank' })
  }

  const pushRoots = (roots: TaskItem[], settled: boolean) => roots.forEach((item, index) => {
    if (index) rows.push({ kind: 'gap' })
    const last = index === roots.length - 1
    const children = childrenOf(item.id)
    const isGroup = item.kind === 'group'
    const open = isGroup && !collapsed.has(item.id)
    const childStars = children.filter(child => starred.has(child.id)).length
    const star = `${starred.has(item.id) ? ' ★' : ''}${isGroup && !open && childStars ? ` ★${childStars}` : ''}`
    const members = new Set([item.id, ...children.map(child => child.id)])
    const latest = state.events.reduce<TaskEvent | null>((found, event) => {
      const target = eventItem(event)
      return target && members.has(target.id) && (!found || event.revision > found.revision) ? event : found
    }, null)
    const time = latest ? sinceText(latest.occurredAt, now) : ''
    const counted = children.filter(child => child.status !== 'cancelled')
    const progress = isGroup ? `完成 ${counted.filter(child => child.status === 'done').length}/${counted.length} 項` : ''
    const wide = cols >= 46
    const title = truncateColumns(item.title, Math.max(1, wide ? Math.min(TITLE_MAX, cols - ROOT_CHROME - columns(progress) - 2 - TIME_SLOT - columns(star) - 2) : cols - ROOT_CHROME - columns(star)))
    const cluster = wide && (progress || time) ? `${progress ? `${progress}  ` : ''}${' '.repeat(Math.max(0, TIME_SLOT - columns(time)))}${time}` : ''
    const drawn = 5 + columns(title) + (isGroup ? 2 : 0) + columns(star)
    rows.push({ kind: 'root', id: item.id, ...(isGroup ? { key: `todo:${item.id}` } : {}), last, tone: groupTone(item, children), title, open, star, pad: wide ? Math.max(0, cols - drawn - columns(cluster)) : 0, cluster, dim: settled || (!isGroup && item.status === 'parked') })
    const meta = [progress, time].filter(Boolean).join(' · ')
    if (!wide && meta) rows.push({ kind: 'meta', last, text: meta })
    if (!open) return
    const visible = children.filter(child => completedOpen || !isSettled(child) || starred.has(child.id))
    let shown = visible
    if (visible.length > CHILDREN_SHOWN && !showAllChildren.has(item.id)) {
      const kept = new Set(visible.filter(child => URGENT.includes(child.status) || starred.has(child.id)).map(child => child.id))
      for (const child of visible) {
        if (kept.size >= CHILDREN_KEPT) break
        kept.add(child.id)
      }
      shown = visible.filter(child => kept.has(child.id))
    }
    const remaining = visible.length - shown.length
    const tone = groupTone(item, children)
    shown.forEach((child, childIndex) => {
      const childStar = starred.has(child.id) ? ' ★' : ''
      const childTitle = truncateColumns(child.title, Math.max(1, cols - CHILD_CHROME - columns(childStar)))
      const blockers = child.blockedBy.flatMap(id => {
        const blocker = byId.get(id)
        if (!blocker || isSettled(blocker)) return []
        const home = blocker.parentId !== undefined && blocker.parentId !== item.id ? byId.get(blocker.parentId) : undefined
        return [`${home ? `${home.title}/` : ''}${blocker.title}`]
      })
      const dependency = blockers.length ? `前置 ${blockers.join(' · ')}` : ''
      const room = cols - CHILD_CHROME - columns(childTitle) - columns(childStar) - 2
      rows.push({
        kind: 'child', last, lastChild: childIndex === shown.length - 1 && !remaining,
        rail: tone === 'waiting' || tone === 'blocked' ? tone : null,
        status: child.status, title: childTitle, star: childStar,
        dependency: cols > 36 && dependency && room >= MIN_DEPENDENCY ? truncateColumns(dependency, room) : '',
        dim: settled || isSettled(child) || child.status === 'parked' || item.status === 'parked',
      })
      if (cols <= 36 && dependency) rows.push({ kind: 'dependency', last, lastChild: childIndex === shown.length - 1 && !remaining, text: truncateColumns(dependency, Math.max(1, cols - CHILD_CHROME)) })
    })
    if (remaining) rows.push({ kind: 'more', key: `todo:more:${item.id}`, last, groupId: item.id, text: `還有 ${remaining} 項` })
  })

  const roots = state.items.filter(item => item.parentId === undefined).sort(byOrder)
  pushRoots(roots.filter(item => !isSettled(item)), false)
  const done = endpoints.filter(item => item.status === 'done').length
  if (done) {
    rows.push({ kind: 'completed', key: 'todo:completed', text: `已完成 ${done} 項 ${completedOpen ? '▾' : '▸'}` })
    if (completedOpen) pushRoots(roots.filter(isSettled), true)
  }

  if (state.events.length) {
    rows.push({ kind: 'timeline', key: 'todo:timeline', text: `時間線 · ${state.events.length} ${timelineOpen ? '▾' : '▸'}` })
    if (timelineOpen) {
      const events = [...state.events].sort((a, b) => a.revision - b.revision)
      const today = new Date(now).toDateString()
      if (events.length > timelineLimit) rows.push({ kind: 'note', text: `較早 ${events.length - timelineLimit} 筆未顯示` })
      for (const event of events.slice(-timelineLimit)) {
        const date = new Date(event.occurredAt)
        const time = `${date.toDateString() === today ? '' : `${date.getMonth() + 1}/${date.getDate()} `}${clockText(date)}`
        const action = taskAction(event)
        const title = truncateColumns(eventItem(event)?.title ?? state.title, Math.max(1, cols - columns(time) - 4 - columns(action)))
        rows.push({ kind: 'note', text: `${time} ${title} · ${action}` })
      }
    }
  }
  return rows
}
