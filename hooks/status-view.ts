export const ANIMATION_FRAMES = { attention: ['◆', '◇'] } as const
export const PULSE = { on: 8, period: 12 } as const
type StatusColor = 'busy' | 'waiting' | 'blocked' | 'answered' | 'dim' | 'error'
export type StatusCell = { glyph: string; label: string; color: StatusColor; glyphColor: StatusColor }
const STATUS_VIEW: Record<string, Omit<StatusCell, 'glyphColor'>> = {
  執行中: { glyph: '✳', label: '工作中', color: 'busy' },
  等待回應: { glyph: '◆', label: '待回答', color: 'waiting' },
  等待授權: { glyph: '◆', label: '待授權', color: 'blocked' },
  回覆完畢: { glyph: '↩', label: '已回覆', color: 'answered' },
  閒置: { glyph: '-', label: '閒置', color: 'dim' },
  'session 異常，需手動排程': { glyph: '!', label: '異常', color: 'error' },
}
export function statusCell(status: string, tick: number, { primary = false, animated = true }: { primary?: boolean; animated?: boolean } = {}): StatusCell {
  const cell = Object.hasOwn(STATUS_VIEW, status) ? STATUS_VIEW[status]! : { glyph: '?', label: truncateColumns(status, 6), color: 'dim' as const }
  const result = { ...cell, glyphColor: cell.color }
  if (!animated) return result
  if (status === '等待授權') return { ...result, glyphColor: Math.max(0, tick) % PULSE.period < PULSE.on ? 'blocked' : 'dim' }
  if (primary && status === '等待回應') return { ...result, glyph: ANIMATION_FRAMES.attention[Math.floor(Math.max(0, tick) / 6) % 2]! }
  return result
}
export const columns = (text: string) => [...text].reduce((n, c) => n + (c.codePointAt(0)! > 0x2e80 || /\p{Emoji_Presentation}/u.test(c) ? 2 : 1), 0)
export function truncateColumns(text: string, max: number): string {
  if (columns(text) <= max) return text
  let result = ''
  let used = 0
  for (const c of text) {
    const size = columns(c)
    if (used + size > max - 1) break
    result += c
    used += size
  }
  return `${result}…`
}
