export type ConsoleTheme = Record<'fg' | 'muted' | 'dim' | 'border' | 'accent' | 'busy' | 'waiting' | 'blocked' | 'error', string | undefined>
export const THEMES = {
  neutral: { fg: undefined, muted: undefined, dim: 'gray', border: 'gray', accent: 'cyan', busy: 'green', waiting: 'yellow', blocked: 'red', error: 'red' },
} satisfies Record<string, ConsoleTheme>
export type Appearance = { appearance: 'refined' | 'classic'; theme: keyof typeof THEMES; motion: boolean }
export function loadAppearance(text: string, warnings: string[]): Appearance {
  const result: Appearance = { appearance: 'refined', theme: 'neutral', motion: true }
  let config: unknown
  try { config = JSON.parse(text) } catch { return result }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return result
  const values = config as Record<string, unknown>
  for (const key of ['appearance', 'theme', 'motion'] as const) {
    const value = values[key]
    if (value === undefined) continue
    const valid = key === 'appearance' ? value === 'refined' || value === 'classic' : key === 'theme' ? typeof value === 'string' && Object.hasOwn(THEMES, value) : typeof value === 'boolean'
    if (valid) {
      if (key === 'appearance') result.appearance = value as Appearance['appearance']
      else if (key === 'theme') result.theme = value as Appearance['theme']
      else result.motion = value as boolean
    } else {
      const message = `config.json 的 ${key} 不認得：${String(value)}，改用 ${String(result[key])}`
      warnings.push(message)
    }
  }
  return result
}
