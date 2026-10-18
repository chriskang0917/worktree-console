export type CallState = { running: boolean; errored: boolean }

declare module 'claude-code' {
  interface PluginState {
    'tool-dots': { calls: Record<string, CallState> }
  }
}
