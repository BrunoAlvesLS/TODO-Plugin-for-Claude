export type Task = {
  id: number
  text: string
  isDone: boolean
  /** Set when the task came from an alert: one task per source, e.g. "pr-reply:72961". */
  key?: string
  /** Changes when the source has new activity; a done task reopens on a new rev. */
  rev?: string
  /** Where the task came from (ticket, PR, build), opened from the task row. */
  url?: string
  /** When the task was created (ms); drives the "New" tag. Older tasks have none. */
  createdAt?: number
  /** Who last closed it: the person, or the watcher because the source was resolved. */
  closedBy?: 'user' | 'auto'
  closedAt?: number
  inProgress?: boolean
  startedAt?: number
  /** The CLI session that was current when the task was started. */
  sessionId?: string
  /** The desktop app's id for that session (local_...), used to reopen it. */
  appSessionId?: string
}

export type Alerts = {
  state: 'unknown' | 'off' | 'on'
  /** alerts.json exists in the data folder */
  hasSettings?: boolean
  /** the setup banner was put away with "Not now" */
  dismissed?: boolean
  /** organization/project pairs found for the setup screen */
  suggestions?: string[]
  /** a manual check is running */
  checking?: boolean
  /** setup or turn-off is running */
  busy?: boolean
  /** status or error line shown under the setup banner */
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'todo-pane': { tasks: Shaped<Task[]>; alerts: Shaped<Alerts> }
  }
}
