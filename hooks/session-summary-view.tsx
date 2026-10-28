import { columns, truncateColumns } from './status-view.ts'

export const SUMMARY_MAX_LINES = 4

// Wraps by display columns, keeping the reply's own line breaks.
export function wrapColumns(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let line = ''
    let used = 0
    for (const c of para) {
      const size = columns(c)
      if (used + size > width && line) {
        out.push(line)
        line = ''
        used = 0
      }
      line += c
      used += size
    }
    if (line.trim()) out.push(line)
  }
  return out
}

// At most `max` lines; a cut ends its last line with …
export function summaryLines(text: string, width: number, max = SUMMARY_MAX_LINES): string[] {
  const lines = wrapColumns(text, Math.max(1, width))
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  const last = kept[max - 1]!.trimEnd()
  kept[max - 1] = columns(last) < width ? `${last}…` : truncateColumns(`${last}…`, width)
  return kept
}
