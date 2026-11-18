import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Alerts, Dismissed, Inbox, Source, Task } from '../types'
import { canonical, nextId } from './core/tasks'
import {
  DAY_MS,
  DEFAULT_KEEP_RESOLVED_DAYS,
  expiredUserTasks,
  newlyCreated,
  pruneDismissedKeys,
  reconcile,
} from './core/reconcile'
import { ado } from './integrations/ado'
import { SOURCES } from './integrations'

// The host's `$` surface is wide and loosely typed across hook events.
type Ctx = any

const PANE = 'todo'
const PANE_TITLE = 'TODO'

const SYNC_MS = 60_000
const DEFAULT_INTERVAL_MINUTES = 10

const WATCH_TIMEOUT_MS = 180_000
const LOOKUP_TIMEOUT_MS = 60_000
const PROMPT_TIMEOUT_MS = 45_000

const BUTTON_BG = '#3c3c3c'
const PRIMARY_BG = '#2a6fb0'
const GO_BG = '#2f8f46'
const DANGER_BG = '#b03a3a'

const SESSION_ID = /^[0-9a-f-]{36}$/i
const APP_SESSION_ID = /^local_[0-9a-f-]{36}$/i
const OPENABLE_URL = /^(https:\/\/|claude:\/\/claude\.ai\/epitaxy\/local_[0-9a-f-]{36}$)/i

const BASE_INSTRUCTIONS = `You write the first message for a new Claude Code session. The user gives you one to-do item. Choose the matching case from the rules below and write the single best opening prompt to start working on it.

Output rules:
- Output only the prompt text, ready to send. No preface, no quotes, no markdown fences.
- Write it in the user's voice, addressed to Claude.
- If the personal playbook has wording and examples for the case, copy that style closely: same sentence shape, same level of detail, filled with the ids and names from the item. Do not add steps, safety rules or house rules the playbook does not show.
- Use only facts present in the item. Drop any optional part of the wording that the item does not support.
- Without a playbook match, use the matching case's steps from the rules, kept short (under 60 words).`

const fallbackPrompt = (task: string) =>
  `Work on this task: ${task}\n\nFirst look for related notes or earlier work and tell me what you find. Then propose a short plan and wait for my go-ahead before changing anything.`

/* ---------------------------------------------------------------- files */

const dataDir = async ($: Ctx): Promise<string> =>
  `${(await $.env.get('USERPROFILE')) ?? ''}\\.claude\\todo-pane`

const dataFile = async ($: Ctx, name: string) => `${await dataDir($)}\\${name}`

const readText = async ($: Ctx, path: string): Promise<string> => {
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

/** Parsed JSON, or undefined when the file is missing or invalid. PowerShell writes a BOM. */
const readJson = async ($: Ctx, path: string): Promise<any> => {
  try {
    return JSON.parse((await readText($, path)).replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

const psArgs = (args: string[]) => [
  'powershell.exe',
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  ...args,
]

/* ---------------------------------------------------------------- state */

const tasks = atom({ plugin: 'todo-pane', key: 'tasks' } as const, [], {
  shape: 'tasks-1',
})

const alerts = atom(
  { plugin: 'todo-pane', key: 'alerts' } as const,
  { state: 'unknown' } as Alerts,
  { shape: 'alerts-1' },
)

const readDismissed = async ($: Ctx): Promise<Dismissed> =>
  ((await $.store.get('dismissed')) as Dismissed | undefined) ?? {}

const setAlerts = ($: Ctx, change: (a: Alerts) => Alerts): Promise<unknown> =>
  update($, alerts, change)

const setAlertsDismissed = ($: Ctx, dismissed: boolean) => {
  void $.store.set('alertsDismissed', dismissed)
  void setAlerts($, a => ({ ...a, dismissed }))
}

const TASKS_FILE = 'tasks.json'
const REJECTED_FILE = 'tasks.rejected.json'

/** Child process that prints "changed" (tasks.json) or "alerts-changed" (alerts.json) 150 ms after that file stops changing. */
const WATCH_JS =
  "const fs=require('fs');const d=process.argv[1];const t={};const m={'tasks.json':'changed','alerts.json':'alerts-changed'};fs.watch(d,(e,f)=>{if(m[f]){clearTimeout(t[f]);t[f]=setTimeout(()=>console.log(m[f]),150)}});console.log('watching')"

/** What this plugin last wrote to tasks.json: a change event for exactly this text is its own save. */
let lastWritten = ''
/** The last invalid text a warning was shown for, so one bad save warns once. */
let lastRejected = ''


/** Validates and cleans a hand-edited list. Rejects the whole file on the first problem, so nothing is dropped silently. */
const parseTasks = (text: string, now: number): { list: Task[] } | { error: string } => {
  let raw: any
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch (err) {
    return { error: `not valid JSON (${String(err).slice(0, 80)})` }
  }
  if (!Array.isArray(raw)) return { error: 'the top level must be a list of tasks' }
  let max = 0
  for (const r of raw) if (r && Number.isInteger(r.id)) max = Math.max(max, r.id)
  const seen = new Set<number>()
  const list: Task[] = []
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    const at = `task ${i + 1}`
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: `${at} is not an object` }
    if (typeof r.text !== 'string' || !r.text.trim()) return { error: `${at} needs a "text"` }
    if (r.id !== undefined && !(Number.isInteger(r.id) && r.id > 0)) {
      return { error: `${at} has an invalid "id"` }
    }
    if (r.isDone !== undefined && typeof r.isDone !== 'boolean') {
      return { error: `${at} needs "isDone" to be true or false` }
    }
    const isNew = r.id === undefined
    const id: number = isNew ? ++max : r.id
    if (seen.has(id)) return { error: `${at} repeats id ${id}` }
    seen.add(id)
    const t: Task = { ...r, id, text: r.text.trim(), isDone: r.isDone === true }
    if (isNew && t.createdAt === undefined) t.createdAt = now
    if (t.isDone) {
      t.inProgress = false
      if (t.closedBy !== 'auto') t.closedBy = 'user'
      if (typeof t.closedAt !== 'number') t.closedAt = now
    } else {
      delete t.closedBy
      delete t.closedAt
    }
    list.push(t)
  }
  return { list }
}

/** Second and third copies of the list (plugin store, backup file), so a damaged tasks.json can't reset it. */
const writeBackup = async ($: Ctx, list: Task[]) => {
  try {
    await $.fs.write(await dataFile($, 'tasks-backup.json'), JSON.stringify(list))
  } catch {}
}

const readBackup = async ($: Ctx): Promise<Task[] | undefined> => {
  const parsed = await readJson($, await dataFile($, 'tasks-backup.json'))
  return Array.isArray(parsed) ? parsed : undefined
}

const mirrorList = async ($: Ctx, list: Task[]) => {
  try {
    await $.store.set('tasks', list)
  } catch {}
  await writeBackup($, list)
}

/** tasks.json is the source of truth: it is written first, and the panel only shows what was saved. */
const writeTasksFile = async ($: Ctx, list: Task[]) => {
  const text = canonical(list)
  lastWritten = text
  try {
    await $.fs.write(await dataFile($, TASKS_FILE), text)
  } catch (err) {
    lastWritten = ''
    $.ui.toast(`Could not save the task list: ${String(err)}`.slice(0, 160))
    throw err
  }
}

/** Keeps a bad hand edit next to tasks.json before the plugin saves over it. */
const keepRejected = async ($: Ctx, text: string, error: string) => {
  if (text === lastRejected) return
  lastRejected = text
  try {
    await $.fs.write(await dataFile($, REJECTED_FILE), text)
  } catch {}
  $.ui.toast(`tasks.json was not loaded: ${error}. Your text is in ${REJECTED_FILE}.`.slice(0, 200))
}

/** Reads tasks.json into the panel's list; a missing or invalid file falls back to the store. */
const refreshFromDisk = async ($: Ctx) => {
  const text = await readText($, await dataFile($, TASKS_FILE))
  if (text) {
    const parsed = parseTasks(text, await $.clock.now())
    if ('list' in parsed) {
      await update($, tasks, () => parsed.list)
      return
    }
    await keepRejected($, text, parsed.error)
  }
  const saved = (await $.store.get('tasks')) as Task[] | undefined
  if (Array.isArray(saved)) await update($, tasks, () => saved)
}

// Mutations run one at a time, each on the latest saved list, so a session
// with an old copy can't overwrite a change made from another session or by hand.
let mutating: Promise<void> = Promise.resolve()

const mutate = ($: Ctx, change: (list: Task[]) => Task[]): Promise<void> => {
  const run = mutating.then(async () => {
    await refreshFromDisk($)
    const next = change(await read($, tasks))
    await writeTasksFile($, next)
    await update($, tasks, () => next)
    await mirrorList($, next)
  })
  mutating = run.catch(() => {})
  return run
}

const patchTask = ($: Ctx, id: number, change: (t: Task) => Task) =>
  mutate($, list => list.map(t => (t.id === id ? change(t) : t)))

const findTask = async ($: Ctx, id: number) =>
  (await read($, tasks)).find(t => t.id === id)

/** The file changed outside this session's own saves (a hand edit, Claude, another session): load it into the panel. */
const reloadFromFile = ($: Ctx): Promise<void> => {
  const run = mutating.then(async () => {
    const text = await readText($, await dataFile($, TASKS_FILE))
    if (!text || text === lastWritten) return
    const parsed = parseTasks(text, await $.clock.now())
    if (!('list' in parsed)) return keepRejected($, text, parsed.error)
    const before = await read($, tasks)
    // A removed alert task stays gone until its source has new activity, like the ✕ button.
    const removed = before.filter(t => t.key && !parsed.list.some(n => n.id === t.id))
    if (removed.length) {
      const dismissed = await readDismissed($)
      for (const t of removed) dismissed[t.key as string] = t.rev ?? ''
      await $.store.set('dismissed', dismissed)
    }
    await update($, tasks, () => parsed.list)
    // Written back in the standard layout (ids, closing info filled in); other sessions then read identical text.
    if (canonical(parsed.list) !== text) await writeTasksFile($, parsed.list)
    else lastWritten = text
    await mirrorList($, parsed.list)
  })
  mutating = run.catch(() => {})
  return run
}

/** At session start: tasks.json first, then the store, then the backup; the first one found is saved to tasks.json. */
const restoreTasks = async ($: Ctx) => {
  const text = await readText($, await dataFile($, TASKS_FILE))
  if (text) {
    const parsed = parseTasks(text, await $.clock.now())
    if ('list' in parsed) {
      await update($, tasks, () => parsed.list)
      return
    }
    await keepRejected($, text, parsed.error)
  }
  let saved = (await $.store.get('tasks')) as Task[] | undefined
  if (saved === undefined) {
    saved = await readBackup($)
    if (saved) await $.store.set('tasks', saved)
  }
  if (saved) {
    const list = saved
    await update($, tasks, () => list)
    await writeTasksFile($, list).catch(() => {})
  }
}

/* ----------------------------------------------------------- list rules */


const moveTo = (list: Task[], id: number, to: number): Task[] => {
  const from = list.findIndex(t => t.id === id)
  if (from < 0 || to < 0 || to >= list.length) return list
  const copy = [...list]
  const [one] = copy.splice(from, 1)
  if (one) copy.splice(to, 0, one)
  return copy
}

const closeByUser = (t: Task, now: number): Task => ({
  ...t,
  isDone: true,
  inProgress: false,
  closedBy: 'user',
  closedAt: now,
})

const toggleDone = (t: Task, now: number): Task => {
  if (!t.isDone) return closeByUser(t, now)
  const { closedBy, closedAt, ...rest } = t
  return { ...rest, isDone: false }
}

/** "todo" forgets both timestamps so the task loses its New tag; "new" restarts that tag. */
const applyStatus = (t: Task, status: string | undefined, now: number): Task => {
  const { closedBy, closedAt, ...open } = t
  switch (status) {
    case 'done':
      return closeByUser(t, now)
    case 'progress':
      return { ...open, isDone: false, inProgress: true, startedAt: t.startedAt ?? now }
    case 'todo': {
      const { startedAt, createdAt, ...rest } = open
      return { ...rest, isDone: false, inProgress: false }
    }
    case 'new': {
      const { startedAt, ...rest } = open
      return { ...rest, isDone: false, inProgress: false, createdAt: now }
    }
    default:
      return t
  }
}

/* ---------------------------------------------------------- inbox sync */

/** Days a closed task stays listed. A list rule that still lives in the Azure DevOps settings file. */
const readKeepResolvedMs = async ($: Ctx): Promise<number> => {
  const cfg = await readJson($, await dataFile($, ado.settingsFile))
  const days = Number(cfg?.keepResolvedDays)
  return (Number.isFinite(days) && days >= 0 ? days : DEFAULT_KEEP_RESOLVED_DAYS) * DAY_MS
}

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_NEW_TASK_HOURS = 24

/** Hours a task keeps its New tag (newTaskHours in the settings file); 0 turns the tag off. */
const readNewWindowMs = async ($: Ctx): Promise<number> => {
  const cfg = await readJson($, await dataFile($, ado.settingsFile))
  const hours = Number(cfg?.newTaskHours)
  return (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_NEW_TASK_HOURS) * HOUR_MS
}

const pruneDismissed = async (
  $: Ctx,
  inbox: Inbox,
  source: Source,
  dismissed: Dismissed,
): Promise<Dismissed> => {
  const kept = pruneDismissedKeys(inbox, source, dismissed)
  if (Object.keys(kept).length !== Object.keys(dismissed).length) {
    await $.store.set('dismissed', kept)
  }
  return kept
}

/** True inside alerts.json's quietHours ("22:00-07:00", may wrap midnight); same rule as ado-watch.ps1. */
const isQuietNow = (quietHours: unknown, now: number): boolean => {
  const m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(String(quietHours ?? ''))
  if (!m) return false
  const d = new Date(now)
  const at = d.getHours() * 60 + d.getMinutes()
  const from = Number(m[1]) * 60 + Number(m[2])
  const to = Number(m[3]) * 60 + Number(m[4])
  return from <= to ? at >= from && at < to : at >= from || at < to
}

const ALERT_MS = 10_000
const ALERT_TITLE = 'New on your list'
const HEARTBEAT_FILE = 'heartbeat.txt'

/** alert.log (last 200 lines kept): time, session id, and why a banner could not be raised. */
const logAlert = async ($: Ctx, line: string) => {
  try {
    const path = await dataFile($, 'alert.log')
    let session = '?'
    try {
      session = String(await $.session.id())
    } catch {}
    const old = (await readText($, path)).split('\n').filter(Boolean).slice(-199)
    await $.fs.write(path, `${[...old, `${new Date().toISOString()} session=${session} ${line}`].join('\n')}\n`)
  } catch {}
}

/**
 * A Windows banner headed "Claude" plus the same line in the session. The text reaches the
 * script only through environment variables, which it XML-escapes. Fire and forget.
 */
const raiseAlert = ($: Ctx, title: string, body: string) => {
  $.process
    .run(psArgs(['-File', `${$.plugin.root}/scripts/claude-toast.ps1`]), {
      env: { TODO_TOAST_TITLE: title.slice(0, 200), TODO_TOAST_BODY: body.slice(0, 400) },
    })
    .then((r: { exitCode: number; stderr: string }) => {
      if (r.exitCode) return logAlert($, `toast script exit=${r.exitCode} ${String(r.stderr).slice(0, 300)}`)
    })
    .catch((err: unknown) => logAlert($, `toast script failed to run: ${String(err)}`))
  $.ui.toast(`${title}: ${body}`.slice(0, 200), { timeoutMs: ALERT_MS })
}

/** One alert for the tasks a sync created, outside alerts.json's quietHours. */
const alertNewTasks = async ($: Ctx, created: Task[]) => {
  if (!created.length) return
  try {
    const cfg = await readJson($, await dataFile($, ado.settingsFile))
    if (isQuietNow(cfg?.quietHours, await $.clock.now())) return
    const first = created[0]?.text ?? ''
    const more = created.length > 1 ? ` (+${created.length - 1} more)` : ''
    raiseAlert($, ALERT_TITLE, `${first}${more}`)
  } catch (err) {
    await logAlert($, `alert threw: ${String(err)}`)
  }
}

/** Tells scripts/ado-watch.ps1 that a session is syncing and will alert, so the job skips its own toast. */
const writeHeartbeat = async ($: Ctx) => {
  try {
    await $.fs.write(await dataFile($, HEARTBEAT_FILE), String(await $.clock.now()))
  } catch {}
}

/** Returns the tasks this session's own write added (see newlyCreated); none when nothing was written. */
const syncSource = async ($: Ctx, source: Source): Promise<Task[]> => {
  const inbox = (await readJson($, await dataFile($, source.inboxFile))) as Inbox | undefined
  if (!inbox || typeof inbox !== 'object') return []
  const now = await $.clock.now()
  const keepMs = await readKeepResolvedMs($)
  const current = await read($, tasks)
  let dismissed = await readDismissed($)
  if (inbox.complete) dismissed = await pruneDismissed($, inbox, source, dismissed)
  const next = reconcile(current, inbox, source, now, keepMs, dismissed)
  // Expired tasks the user ticked: remember them like a ✕ removal so a source that is still
  // active does not bring them back as new tasks (each source can exempt keys, e.g. failing builds).
  const gone = expiredUserTasks(current, next, SOURCES)
  if (gone.length) {
    for (const t of gone) dismissed[t.key as string] = t.rev ?? ''
    await $.store.set('dismissed', dismissed)
  }
  // Skip the write (and its backup) on the usual no-change tick.
  if (JSON.stringify(next) === JSON.stringify(current)) return []
  // Diffed against the fresh list the write starts from: a task another session already
  // added is not new here, so only the session that wrote it alerts.
  let created: Task[] = []
  await mutate($, l => {
    const result = reconcile(l, inbox, source, now, keepMs, dismissed)
    created = newlyCreated(l, result)
    return result
  })
  return created
}

let syncing: Promise<void> = Promise.resolve()
/** The first sync after session start imports the backlog the scheduled job already announced. */
let firstSyncDone = false

/**
 * Imports every source's inbox. Runs one at a time. Only the scheduled tick passes
 * `alert`, and never on the first sync of the session.
 */
const syncInbox = ($: Ctx, options: { alert?: boolean } = {}): Promise<void> => {
  const run = syncing.then(async () => {
    const mayAlert = Boolean(options.alert) && firstSyncDone
    try {
      if (options.alert) await writeHeartbeat($)
      // Also the fallback for the file watcher: picks up an outside edit of tasks.json within a minute.
      await reloadFromFile($)
      const created: Task[] = []
      for (const source of SOURCES) created.push(...(await syncSource($, source)))
      if (mayAlert) await alertNewTasks($, created)
    } finally {
      firstSyncDone = true
    }
  })
  syncing = run.catch(() => {})
  return run
}

/* ----------------------------------------------------- links, sessions */

const openExternal = async ($: Ctx, url: string): Promise<boolean> => {
  if (!OPENABLE_URL.test(url)) return false
  try {
    await $.process.run(['rundll32', 'url.dll,FileProtocolHandler', url])
    return true
  } catch {
    return false
  }
}

/** Maps a CLI session id to the desktop app's `local_...` id, or '' when not found. */
const findAppSession = async ($: Ctx, cliId: string): Promise<string> => {
  if (!SESSION_ID.test(cliId)) return ''
  try {
    const r = await $.process.run(
      psArgs(['-File', `${$.plugin.root}/scripts/find-session.ps1`, '-Cli', cliId]),
      { timeoutMs: LOOKUP_TIMEOUT_MS },
    )
    const id = String(r.stdout).trim().split(/\r?\n/).pop() ?? ''
    return APP_SESSION_ID.test(id) ? id : ''
  } catch {
    return ''
  }
}

const rememberAppSession = ($: Ctx, id: number, appSessionId: string) =>
  patchTask($, id, t => ({ ...t, appSessionId }))

/* ------------------------------------------------------ opening prompt */

const buildSystemPrompt = async ($: Ctx, playbookPath: string): Promise<string> => {
  const generic = await readText($, `${$.plugin.root}/rules/generic.md`)
  const playbook = playbookPath ? await readText($, playbookPath) : ''
  return [
    BASE_INSTRUCTIONS,
    generic ? `# Rules\n${generic}` : '',
    playbook ? `# Personal playbook\n${playbook}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const writeOpeningPrompt = async ($: Ctx, task: Task, playbookPath: string): Promise<string> => {
  const fallback = () => {
    $.ui.toast('Could not write a prompt, used the default one.')
    return fallbackPrompt(task.text)
  }
  try {
    const reply = await $.model.complete({
      model: 'sonnet',
      system: await buildSystemPrompt($, playbookPath),
      prompt: `Task: ${task.text}${task.url ? `\nLink: ${task.url}` : ''}`,
      maxTokens: 700,
      effort: 'low',
      timeoutMs: PROMPT_TIMEOUT_MS,
    })
    const text = reply.isAnswered ? String(reply.text ?? '').trim() : ''
    return text || fallback()
  } catch {
    return fallback()
  }
}

/** Read by scripts/title-hook.js to name the session after the task on its first prompt. */
const writePendingTitle = async ($: Ctx, task: Task, sessionId: string, at: number) => {
  try {
    await $.fs.write(
      await dataFile($, 'pending-title.json'),
      JSON.stringify({
        title: task.text.replace(/\s+/g, ' ').trim().slice(0, 100),
        sessionId,
        at,
      }),
    )
  } catch {}
}

/* ------------------------------------------- Azure DevOps integration (Auto-sync) */

const defaultSettings = (organization: string, project: string) => ({
  organization,
  project,
  repository: '',
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  windowDays: 30,
  newTaskHours: DEFAULT_NEW_TASK_HOURS,
  testerState: 'Resolved',
  testerField: 'Custom.Tester',
  doneStates: ['Closed', 'Done', 'Removed', 'Resolved', 'Completed'],
  events: {
    assigned: true,
    prReplies: true,
    reviewer: true,
    failedBuild: true,
    mergeConflict: true,
    mention: true,
    childItems: true,
    tester: true,
  },
  ignoreIds: [],
  quietHours: null,
})

const adoJobExists = async ($: Ctx): Promise<boolean> => {
  try {
    return (await $.process.run(['schtasks', '/Query', '/TN', ado.jobName])).exitCode === 0
  } catch {
    return false
  }
}

/** organization/project pairs guessed from the open folder's git remote and the az account. */
const detectSuggestions = async ($: Ctx): Promise<string[]> => {
  let cwd = ''
  try {
    cwd = String(await $.session.cwd())
  } catch {}
  const found = await $.process.run(
    psArgs(['-File', `${$.plugin.root}/scripts/${ado.scriptFile}`, '-Detect', '-Cwd', cwd]),
    { timeoutMs: LOOKUP_TIMEOUT_MS },
  )
  const line = String(found.stdout)
    .split(/\r?\n/)
    .reverse()
    .find(l => l.trim().startsWith('{'))
  const parsed = line ? JSON.parse(line) : {}
  return Array.isArray(parsed.suggestions) ? parsed.suggestions : []
}

const adoRefresh = async ($: Ctx) => {
  const settingsPath = await dataFile($, ado.settingsFile)
  const hasSettings = await $.fs.exists(settingsPath).catch(() => false)
  const state: Alerts['state'] = (await adoJobExists($)) ? 'on' : 'off'
  await setAlerts($, a => ({ ...a, state, hasSettings, busy: false }))

  if (state !== 'on' && !hasSettings) {
    try {
      const suggestions = await detectSuggestions($)
      await setAlerts($, a => ({ ...a, suggestions }))
    } catch {}
  }
}

/** The job runs a copy in the data folder, so the plugin can update without re-creating the job. */
const adoCopyScript = async ($: Ctx): Promise<string> => {
  const dst = await dataFile($, ado.scriptFile)
  const src = await readText($, `${$.plugin.root}/scripts/${ado.scriptFile}`)
  if (!src) throw new Error(`${ado.scriptFile} is missing from the plugin`)
  if ((await readText($, dst)) !== src) await $.fs.write(dst, src)
  return dst
}

const runWatch = ($: Ctx, script: string, ...flags: string[]) =>
  $.process.run(psArgs(['-File', script, ...flags]), { timeoutMs: WATCH_TIMEOUT_MS })

const adoCheckNow = async ($: Ctx) => {
  await setAlerts($, a => ({ ...a, checking: true }))
  try {
    const script = await adoCopyScript($)
    const before = (await read($, tasks)).length
    await runWatch($, script)
    await syncInbox($)
    const added = (await read($, tasks)).length - before
    $.ui.toast(added > 0 ? `Checked: ${added} new task(s) added.` : 'Checked: nothing new.')
  } catch (err) {
    $.ui.toast(`Check failed: ${String(err)}`.slice(0, 160))
  }
  await setAlerts($, a => ({ ...a, checking: false }))
}

const explainDryRunFailure = (out: string, target: string): string => {
  if (/Azure CLI \(az\) not found/i.test(out)) {
    return 'Azure CLI is not installed. Install it from https://aka.ms/installazurecliwindows, run "az login", then press Set up again.'
  }
  if (/No Azure DevOps token/i.test(out)) {
    return 'Not signed in to Azure. Run "az login" in a terminal with the account that can see this project, then press Set up again.'
  }
  const reason = out.trim().split(/\r?\n/).pop() ?? ''
  return `Could not reach Azure DevOps${reason ? `: ${reason}` : ''}. Check that "az login" uses an account with access to ${target || 'this project'}.`.slice(0, 220)
}

const readIntervalMinutes = async ($: Ctx, settingsPath: string): Promise<number> => {
  const minutes = Math.floor(Number((await readJson($, settingsPath))?.intervalMinutes))
  return minutes >= 1 ? minutes : DEFAULT_INTERVAL_MINUTES
}

const createJob = ($: Ctx, script: string, everyMinutes: number) =>
  $.process.run([
    'schtasks',
    '/Create',
    '/TN',
    ado.jobName,
    '/SC',
    'MINUTE',
    '/MO',
    String(everyMinutes),
    '/TR',
    // conhost --headless keeps a console window from flashing on every run.
    `conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}"`,
    '/F',
  ])

/** The job's repeat interval in minutes (from its XML, e.g. PT10M), or undefined when it cannot be read. */
const readJobIntervalMinutes = async ($: Ctx): Promise<number | undefined> => {
  try {
    const out = await $.process.run(['schtasks', '/Query', '/TN', ado.jobName, '/XML'])
    const m = /<Interval>P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?<\/Interval>/.exec(String(out.stdout))
    if (!m) return undefined
    return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  } catch {
    return undefined
  }
}

/** Keeps the scheduled job's interval equal to intervalMinutes in alerts.json; only acts while Auto-sync is on. */
let syncingInterval = false
const adoSyncInterval = async ($: Ctx) => {
  if (syncingInterval) return
  syncingInterval = true
  try {
    if (!(await adoJobExists($))) return
    const settings = await readJson($, await dataFile($, ado.settingsFile))
    if (!settings) return
    const raw = settings.intervalMinutes
    const wanted = raw === undefined ? DEFAULT_INTERVAL_MINUTES : Math.floor(Number(raw))
    if (!(wanted >= 1 && wanted <= 1439)) {
      $.ui.toast('intervalMinutes in alerts.json must be a whole number from 1 to 1439; the job was left unchanged.')
      return
    }
    if ((await readJobIntervalMinutes($)) === wanted) return
    const made = await createJob($, await adoCopyScript($), wanted)
    $.ui.toast(
      made.exitCode === 0
        ? `Auto-sync now runs every ${wanted} minute(s).`
        : `Could not change the Auto-sync interval: ${made.stderr || made.stdout}`.slice(0, 160),
    )
  } catch {
  } finally {
    syncingInterval = false
  }
}

/**
 * alerts.json was saved: apply every setting now instead of at the next scheduled run.
 * The job interval is re-synced, the watcher runs once so events/ignoreIds/windowDays/repository/quietHours
 * take effect, and the inbox is re-imported so keepResolvedDays does too. Setup and refresh do this themselves.
 */
let applyingSettings = false
const adoApplySettings = async ($: Ctx) => {
  if (applyingSettings || (await read($, alerts)).busy) return
  applyingSettings = true
  try {
    // Skips when the file is exactly what was last applied, so opening the pane costs nothing unless it changed
    // (including edits made while the plugin was not running).
    const text = await readText($, await dataFile($, ado.settingsFile))
    if (text === ((await $.store.get('alertsApplied')) as string | undefined)) return
    await adoRefresh($)
    if ((await read($, alerts)).state === 'on') {
      await adoSyncInterval($)
      await runWatch($, await adoCopyScript($))
    }
    await syncInbox($)
    await $.store.set('alertsApplied', text)
  } catch {
  } finally {
    applyingSettings = false
  }
}

/** `target` is "organization/project"; ignored when alerts.json already exists. */
const adoSetup = async ($: Ctx, target: string) => {
  const note = (text: string) => setAlerts($, a => ({ ...a, busy: false, note: text }))
  await setAlerts($, a => ({ ...a, busy: true, note: 'Setting up...' }))
  try {
    const settingsPath = await dataFile($, ado.settingsFile)
    if (!(await $.fs.exists(settingsPath))) {
      const [org, project] = target.split('/').map(s => s.trim())
      if (!org || !project) {
        return note('Type the organization and project as organization/project.')
      }
      await $.fs.write(settingsPath, JSON.stringify(defaultSettings(org, project), null, 2))
    }
    const script = await adoCopyScript($)

    const check = await runWatch($, script, '-DryRun')
    if (check.exitCode !== 0) {
      return note(explainDryRunFailure(`${check.stdout ?? ''}\n${check.stderr ?? ''}`, target))
    }

    const made = await createJob($, script, await readIntervalMinutes($, settingsPath))
    if (made.exitCode !== 0) {
      return note(`Could not create the scheduled job: ${made.stderr || made.stdout}`.slice(0, 200))
    }

    // First run records the baseline, so existing items don't flood the list.
    await runWatch($, script)
    await $.process.run(psArgs(['-File', script, '-TestToast']))
    await adoRefresh($)
    await setAlerts($, a => ({ ...a, note: undefined, dismissed: undefined }) as Alerts)
    await syncInbox($)
    $.ui.toast('Auto-sync is on. A test notification was sent.')
  } catch (err) {
    await note(`Setup failed: ${String(err)}`.slice(0, 200))
  }
}

const adoTurnOff = async ($: Ctx) => {
  await setAlerts($, a => ({ ...a, busy: true, note: 'Turning off...' }))
  try {
    await $.process.run(['schtasks', '/Delete', '/TN', ado.jobName, '/F'])
  } catch {}
  await adoRefresh($)
  await setAlerts($, a => ({ ...a, note: undefined }))
  $.ui.toast('Auto-sync is off.')
}

/* ---------------------------------------------------- list.tsx messages */

/** What hooks/list.tsx posts; every op carries the task id. */
type ListMessage = {
  op?: string
  id: number
  to?: number
  text?: string
  status?: string
}

type OpHandler = ($: Ctx, msg: ListMessage, options: Record<string, unknown>) => Promise<void>

const PENDING_START_KEY = 'pendingStart'
/** A Start whose prompt was never submitted is forgotten after this long. */
const PENDING_START_MAX_MS = 30 * 60 * 1000
type PendingStart = { id: number; sessionId: string; at: number }

/** Marks the task from the last Start as in progress, once its prompt has been submitted. */
const confirmStart = async ($: Ctx) => {
  const pending = (await $.store.get(PENDING_START_KEY)) as PendingStart | undefined
  if (!pending) return
  const now = await $.clock.now()
  let sessionId = ''
  try {
    sessionId = String(await $.session.id())
  } catch {}
  if (now - pending.at > PENDING_START_MAX_MS) {
    await $.store.delete(PENDING_START_KEY)
    return
  }
  if (pending.sessionId && sessionId && pending.sessionId !== sessionId) return
  await $.store.delete(PENDING_START_KEY)
  const id = pending.id
  await patchTask($, id, t => ({
    ...t,
    isDone: false,
    inProgress: true,
    startedAt: pending.at,
    sessionId: pending.sessionId || undefined,
  }))
  if (pending.sessionId) {
    // The app id can take a while to appear; Resume looks it up again if this misses.
    const app = await findAppSession($, pending.sessionId)
    if (app) await rememberAppSession($, id, app)
  }
}

const startTask: OpHandler = async ($, { id }, options) => {
  const task = await findTask($, id)
  if (!task) return
  const startedAt = await $.clock.now()
  let sessionId: string | undefined
  try {
    sessionId = String(await $.session.id())
  } catch {}
  // The task only becomes "in progress" once the generated prompt is actually submitted.
  await $.store.set(PENDING_START_KEY, { id, sessionId: sessionId ?? '', at: startedAt } satisfies PendingStart)
  await writePendingTitle($, task, sessionId ?? '', startedAt)
  $.ui.toast('Thinking of a prompt for this task...')
  const playbookPath = String(options?.playbookPath ?? '').trim()
  const text = await writeOpeningPrompt($, task, playbookPath)
  await $.prompt.fill({ mode: 'replace', text })
}

const resumeTask: OpHandler = async ($, { id }) => {
  const task = await findTask($, id)
  let app = task?.appSessionId ?? ''
  if (!app && task?.sessionId) {
    app = await findAppSession($, task.sessionId)
    if (app) await rememberAppSession($, id, app)
  }
  if (!app) {
    $.ui.toast(
      task?.sessionId
        ? 'Could not find that session. It may have been deleted.'
        : 'No session is linked to this task. Set it to To do to use Start again.',
    )
  } else if (!(await openExternal($, `claude://claude.ai/epitaxy/${app}`))) {
    $.ui.toast('Could not open the session.')
  }
}

const removeTask: OpHandler = async ($, { id }) => {
  const gone = await findTask($, id)
  if (gone?.key) {
    const dismissed = await readDismissed($)
    dismissed[gone.key] = gone.rev ?? ''
    await $.store.set('dismissed', dismissed)
  }
  await mutate($, l => l.filter(t => t.id !== id))
}

const moveTask: OpHandler = async ($, { id, to }) => {
  if (typeof to === 'number') await mutate($, l => moveTo(l, id, to))
}

const toggleTask: OpHandler = async ($, { id }) => {
  const now = await $.clock.now()
  await patchTask($, id, t => toggleDone(t, now))
}

const statusTask: OpHandler = async ($, { id, status }) => {
  const now = await $.clock.now()
  await patchTask($, id, t => applyStatus(t, status, now))
}

const openTask: OpHandler = async ($, { id }) => {
  const task = await findTask($, id)
  if (!(await openExternal($, task?.url ?? ''))) $.ui.toast('Could not open the link.')
}

const editTask: OpHandler = async ($, { id, text }) => {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed) await patchTask($, id, t => ({ ...t, text: trimmed }))
}

/** The mod runtime only lets `$` reach functions declared at the top of the file, so ops are dispatched by name here. */
const runOp = async ($: Ctx, msg: ListMessage, options: Record<string, unknown>) => {
  switch (msg.op) {
    case 'move':
      return moveTask($, msg, options)
    case 'toggle':
      return toggleTask($, msg, options)
    case 'status':
      return statusTask($, msg, options)
    case 'start':
      return startTask($, msg, options)
    case 'open':
      return openTask($, msg, options)
    case 'resume':
      return resumeTask($, msg, options)
    case 'remove':
      return removeTask($, msg, options)
    case 'edit':
      return editTask($, msg, options)  }
}

/* ------------------------------------------------------------ register */

const openPane = async ($: Ctx) => {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  void adoApplySettings($).catch(() => {})
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'todo',
      description: 'Open the TODO pane',
    })
    await restoreTasks($)
    const dismissed = Boolean(await $.store.get('alertsDismissed'))
    await setAlerts($, a => ({ ...a, dismissed }) as Alerts)

    void (async () => {
      try {
        await adoRefresh($)
        if ((await read($, alerts)).state === 'on') await adoCopyScript($)
        await adoApplySettings($)
        await syncInbox($)
      } catch {}
    })()
    $.clock.every(SYNC_MS, () => {
      void syncInbox($, { alert: true }).catch(() => {})
    })

    // Push updates: a small child process reports edits of tasks.json, so the panel refreshes at once.
    void (async () => {
      try {
        const dir = await dataDir($)
        for await (const piece of $.process.spawn({ argv: ['node', '-e', WATCH_JS, dir] })) {
          if (piece.stream !== 'stdout') continue
          if (piece.text.includes('alerts-changed')) void adoApplySettings($).catch(() => {})
          if (/(^|\s)changed/.test(piece.text)) void reloadFromFile($).catch(() => {})
        }
      } catch {}
    })()

    return next(e)
  })

  on('command.run', { command: 'todo' }, async $ => {
    await openPane($)
    return { text: 'TODO pane opened.' }
  })

  // The same command as a plugin command file (commands/todo.md), which the menu lists before the plugin has started.
  on('command.run', { command: 'todo-pane:todo' }, async $ => {
    await openPane($)
    return { text: 'TODO pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta) {
      try {
        await confirmStart($)
      } catch {}
    }
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (e.element !== 'todo-list') return next(e)
    const msg = e.data as Partial<ListMessage> | undefined
    if (typeof msg?.id !== 'number') return {}
    await runOp($, msg as ListMessage, (options ?? {}) as Record<string, unknown>)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button, Client } = $.ui.resolve(e) as any
    const list = await read($, tasks)
    const a = await read($, alerts)
    const open = list.filter(t => !t.isDone).length
    const settingsPath = await dataFile($, ado.settingsFile)
    const suggestions = a.suggestions ?? []
    const newWindowMs = await readNewWindowMs($)
    // Lets the list mark the task that belongs to this chat; empty when the host gives no id.
    let currentSessionId = ''
    try {
      currentSessionId = String(await $.session.id())
    } catch {}

    const greyButton = (key: string, label: string, hoverBg: string, onPress: () => void) => {
      const hover = { scope: key, backgroundColor: hoverBg, color: 'white' }
      return (
        <Button key={key} onPress={onPress} hover={hover}>
          <Text backgroundColor={BUTTON_BG} color="white" hover={hover}>
            {label}
          </Text>
        </Button>
      )
    }

    const settingsButton = () =>
      greyButton('alerts-file', ' ⚙ Settings ', PRIMARY_BG, () => {
        void $.process
          .run(['rundll32', 'shell32.dll,OpenAs_RunDLL', settingsPath])
          .catch(() => $.ui.toast('Could not open the settings file.'))
      })

    const banner = () => {
      if (a.state === 'unknown') return null
      if (a.state === 'on') {
        return (
          <Box key="alerts-on">
            <Text color="green">● </Text>
            <Text dimColor>Auto-sync </Text>
            {settingsButton()}
            <Text> </Text>
            {greyButton('alerts-off', a.busy ? ' Working... ' : ' ⏻ Turn off ', DANGER_BG, () => {
              if (!a.busy) void adoTurnOff($)
            })}
            {a.note ? <Text color="yellow"> {a.note}</Text> : null}
          </Box>
        )
      }
      if (a.dismissed || a.hasSettings) {
        return (
          <Box key="alerts-idle">
            <Text color="gray">● </Text>
            <Text dimColor>Auto-sync </Text>
            {a.hasSettings ? settingsButton() : null}
            {a.hasSettings ? <Text> </Text> : null}
            {greyButton('alerts-on', a.busy ? ' Working... ' : ' ⏻ Turn on ', GO_BG, () => {
              if (a.busy) return
              if (a.hasSettings) void adoSetup($, '')
              else void setAlertsDismissed($, false)
            })}
            {a.note ? <Text color="yellow"> {a.note}</Text> : null}
          </Box>
        )
      }
      return (
        <Box
          key="alerts-banner"
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
        >
          <Text bold>Get alerts from Azure DevOps?</Text>
          <Text dimColor>
            Every few minutes this checks your tickets and PRs (read only) and
            adds what needs you to this list. A Windows notification appears when
            something new comes up.
          </Text>
          <Text dimColor>
            Needs the Azure CLI signed in ("az login"). Nothing is stored.
          </Text>
          {!a.hasSettings && suggestions.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>
                {suggestions.length === 1 ? 'Found your project:' : 'Pick your project:'}
              </Text>
              {suggestions.map((s: string) => (
                <Button
                  key={`pick-${s}`}
                  onPress={() => void adoSetup($, s)}
                  hover={{ scope: `pick-${s}`, backgroundColor: GO_BG, color: 'white' }}
                >
                  <Text backgroundColor={PRIMARY_BG} color="white">{` ${s} `}</Text>
                </Button>
              ))}
            </Box>
          )}
          {!a.hasSettings && (
            <Input
              key="alerts-target"
              label={suggestions.length > 0 ? 'Or type organization/project' : 'Organization/project'}
              placeholder="for example contoso/MyProject, then press Enter"
              submitLabel="set up"
              onSubmit={(value: string) => void adoSetup($, value)}
            />
          )}
          <Box>
            {a.hasSettings && (
              <Button
                key="alerts-setup"
                onPress={() => void adoSetup($, '')}
                hover={{ scope: 'alerts-setup', backgroundColor: GO_BG, color: 'white' }}
              >
                <Text backgroundColor={PRIMARY_BG} color="white">
                  {a.busy ? ' Working... ' : ' Set up '}
                </Text>
              </Button>
            )}
            <Text> </Text>
            <Button
              key="alerts-later"
              onPress={() => setAlertsDismissed($, true)}
              hover={{ scope: 'alerts-later', color: 'white' }}
            >
              <Text dimColor> Not now </Text>
            </Button>
          </Box>
          {a.note ? <Text color="yellow">{a.note}</Text> : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>TODO ({open} open)</Text>
          {a.state === 'on' && (
            <Box>
              <Text> </Text>
              <Button
                key="refresh"
                onPress={() => {
                  if (!a.checking) void adoCheckNow($)
                }}
                hover={{ scope: 'refresh', backgroundColor: PRIMARY_BG, color: 'white' }}
              >
                <Text color="cyan">{a.checking ? ' checking... ' : ' ↻ refresh '}</Text>
              </Button>
            </Box>
          )}
        </Box>
        {banner()}
        <Input
          key="todo-add"
          label="+ New task"
          placeholder="Type a task and press Enter"
          submitLabel="add"
          onSubmit={(value: string) => {
            const text = value.trim()
            if (text) {
              void mutate($, l => [
                { id: nextId(l), text, isDone: false, createdAt: Date.now() },
                ...l,
              ])
            }
          }}
        />
        <Text> </Text>
        {list.length === 0 ? (
          <Text dimColor>No tasks yet.</Text>
        ) : (
          <Client
            key="todo-list"
            module="./list.tsx"
            width="100%"
            props={{ tasks: list, now: Date.now(), newWindowMs, currentSessionId }}
          />
        )}
      </Box>
    )
  })
}
