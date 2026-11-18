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

/** Source task key -> rev at the time the task was removed by hand. */
export type Dismissed = Record<string, string>

export type InboxItem = {
  key: string
  title: string
  url: string
  rev: string
  /** Existed when the source was set up: tracked by the watcher, never added as a task. */
  baseline?: boolean
}

/** What an external source writes to its inbox file. `complete` means `items` is the full current set. */
export type Inbox = { complete?: boolean; items?: InboxItem[] }

/**
 * An integration is an external, read-only process that writes `inboxFile` in the data folder.
 * The core only polls that file; it never calls the source's API.
 */
export type Source = {
  id: string
  /** Name shown to the user. */
  label: string
  /** Inbox file the source writes, in the data folder. */
  inboxFile: string
  /** The source's own settings file, in the data folder. */
  settingsFile: string
  /** Script in `scripts/` that produces the inbox. */
  scriptFile: string
  /** Name of the scheduled job that runs the script. */
  jobName: string
  /** Task keys this source owns. Auto-close and dismissal clean-up touch only these. */
  owns: RegExp
  /** Owned keys that must come back while still active, even after the user ticked them and they expired. */
  keepOnUserExpire?: RegExp
  /**
   * Keys that are one item seen in a different role: two keys matching this with an equal group 1 are
   * the same item, and a task moves from one to the other instead of a second task being created.
   * No `g` flag.
   */
  sameItem?: RegExp
}

declare module 'claude-code' {
  interface PluginState {
    'todo-pane': { tasks: Shaped<Task[]>; alerts: Shaped<Alerts> }
  }
}
