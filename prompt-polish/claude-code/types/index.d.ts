export type Busy = boolean

declare module 'claude-code' {
  interface PluginState {
    'prompt-polish': { isBusy: Busy; frame: number }
  }
}
