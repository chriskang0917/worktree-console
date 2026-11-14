import { columns, truncateColumns, wrapColumns as wrapWords } from './status-view.ts'
import { DECIDE_MARK, digestLayers } from './digest.mjs'

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

export type DigestLayer = { key: string; label: string; lines: string[] }
// `decide`: the ▶ 要你決定 row, drawn bold in the accent colour.
export type DigestPart = { role: 'label' | 'text'; text: string; decide: boolean }

// The label column: ▶ 要你決定 is 10 columns, then a 2-column gap.
export const DIGEST_LABEL_COLS = 12

export const parseDigest = (text: string | null | undefined): DigestLayer[] | null => digestLayers(text ?? null)

const labelCell = (text: string) => `${text}${' '.repeat(Math.max(0, DIGEST_LABEL_COLS - columns(text)))}`
const layerLabel = (layer: DigestLayer) => (layer.key === 'decide' ? `${DECIDE_MARK}${layer.label}` : layer.label)

// The popover's rows: each label in a fixed left column, wrapped text under the text column, a blank row before ▶ 要你決定.
export function digestRows(layers: DigestLayer[], width: number): DigestPart[][] {
  const room = Math.max(1, width - DIGEST_LABEL_COLS)
  const rows: DigestPart[][] = []
  for (const layer of layers) {
    const decide = layer.key === 'decide'
    if (decide && rows.length) rows.push([])
    let first = true
    for (const line of layer.lines) {
      for (const piece of wrapWords(line, room)) {
        rows.push([{ role: 'label', text: labelCell(first ? layerLabel(layer) : ''), decide }, { role: 'text', text: piece, decide }])
        first = false
      }
    }
  }
  return rows
}

const KEEP_WHOLE = new Set(['decide', 'next'])
// Rows that give way when the band is short, in this order.
const DROP_ORDER = ['done', 'doing', 'stuck']

// The child tab's band: one row per layer, its two lines joined. A layer too wide is cut with …, but 要你決定 and 下一步 wrap
// instead; past `maxRows` rows 做了什麼 gives way first, then 在做什麼, then 卡在哪.
export function bandDigestRows(layers: DigestLayer[], width: number, maxRows = SUMMARY_MAX_LINES): DigestPart[][] {
  const room = Math.max(1, width - DIGEST_LABEL_COLS)
  let blocks = layers.map(layer => {
    const decide = layer.key === 'decide'
    const text = layer.lines.join(' · ')
    const pieces = KEEP_WHOLE.has(layer.key) ? wrapWords(text, room) : [truncateColumns(text, room)]
    return { key: layer.key, rows: pieces.map((piece, i): DigestPart[] => [{ role: 'label', text: labelCell(i === 0 ? layerLabel(layer) : ''), decide }, { role: 'text', text: piece, decide }]) }
  })
  const total = () => blocks.reduce((n, b) => n + b.rows.length, 0)
  for (const key of DROP_ORDER) {
    if (total() <= maxRows) break
    blocks = blocks.filter(b => b.key !== key)
  }
  return blocks.flatMap(b => b.rows).slice(0, Math.max(1, maxRows))
}
