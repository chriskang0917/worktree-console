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
const WORD = /[\x21-\x7e]/
const CLOSING = /[，。、？！：；）」』〕】…]/

// Where each line starts and ends (code-point indices) when text wraps at `max` columns: an English word moves whole to
// the next line when it fits on one, closing punctuation never starts a line, and a space a break lands on is dropped.
export function wrapRanges(text: string, max: number): { from: number; to: number }[] {
  const chars = [...text]
  const tokens: { from: number; to: number; width: number }[] = []
  for (let i = 0; i < chars.length; ) {
    let j = i + 1
    if (WORD.test(chars[i]!)) while (j < chars.length && WORD.test(chars[j]!)) j++
    const width = chars.slice(i, j).reduce((n, c) => n + columns(c), 0)
    if (j - i > 1 && width > max) for (let k = i; k < j; k++) tokens.push({ from: k, to: k + 1, width: columns(chars[k]!) })
    else tokens.push({ from: i, to: j, width })
    i = j
  }
  const lines: { from: number; to: number }[] = []
  let from = 0
  let used = 0
  let prev: { from: number; width: number } | null = null
  for (const t of tokens) {
    if (used > 0 && used + t.width > max) {
      if (chars[t.from] === ' ') {
        lines.push({ from, to: t.from })
        ;(from = t.to), (used = 0), (prev = null)
        continue
      }
      if (CLOSING.test(chars[t.from]!) && prev && prev.from > from && prev.width + t.width <= max) {
        lines.push({ from, to: prev.from })
        ;(from = prev.from), (used = prev.width)
      } else {
        lines.push({ from, to: t.from })
        ;(from = t.from), (used = 0)
      }
    }
    used += t.width
    prev = { from: t.from, width: t.width }
  }
  lines.push({ from, to: chars.length })
  return lines
}

// Breaks text into lines of at most `max` columns, as wrapRanges lays them out.
export function wrapColumns(text: string, max: number): string[] {
  const chars = [...text]
  return wrapRanges(text, max).map(r => chars.slice(r.from, r.to).join(''))
}
