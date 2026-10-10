export type ConsoleTheme = Record<'fg' | 'muted' | 'dim' | 'border' | 'accent' | 'busy' | 'waiting' | 'blocked' | 'answered' | 'error', string | undefined> & { bg?: string }
const palette = (fg: string, muted: string, dim: string, border: string, accent: string, busy: string, waiting: string, blocked: string, answered: string, error: string, bg: string): ConsoleTheme => ({ fg, muted, dim, border, accent, busy, waiting, blocked, answered, error, bg })
export const THEMES = {
  neutral: { fg: undefined, muted: undefined, dim: 'gray', border: 'gray', accent: 'cyan', busy: 'green', waiting: 'yellow', blocked: 'magentaBright', answered: 'cyanBright', error: 'redBright' },
  'neutral-light': palette('#2e3138', '#454a52', '#5f646d', '#868a92', '#0f7c8c', '#2f7d32', '#8a6400', '#a3267a', '#2a5db0', '#b3262d', '#f7f7f5'),
  dracula: palette('#f8f8f2', '#c3c8de', '#9aa1c2', '#9aa1c2', '#8be9fd', '#50fa7b', '#ff79c6', '#ffb86c', '#bd93f9', '#ff7b7b', '#282a36'),
  gruvbox: palette('#ebdbb2', '#d5c4a1', '#bdae93', '#928374', '#fbf1c7', '#b8bb26', '#d3869b', '#fe8019', '#83a598', '#ff5c4d', '#282828'),
  light: palette('#394c52', '#4d6267', '#586e75', '#7f8f90', '#1f7a73', '#397900', '#a82b73', '#a34f00', '#1f5fa8', '#b62e32', '#fdf6e3'),
} satisfies Record<string, ConsoleTheme>
export type Appearance = { appearance: 'refined' | 'classic'; theme: keyof typeof THEMES; motion: boolean }
export function loadAppearance(text: string, warnings: string[]): Appearance {
  const result: Appearance = { appearance: 'refined', theme: 'neutral', motion: true }
  let config: unknown
  try { config = JSON.parse(text) } catch {
    warnings.push('config.json 不是有效的 JSON，外觀改用預設')
    return result
  }
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
