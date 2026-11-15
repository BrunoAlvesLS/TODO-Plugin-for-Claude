import type { Dismissed, Inbox, InboxItem, Source, Task } from '../../types'
import { nextId } from './tasks'

export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_KEEP_RESOLVED_DAYS = 3

export const inboxItems = (inbox: Inbox): InboxItem[] =>
  Array.isArray(inbox.items) ? inbox.items : []

export const sourceOf = (sources: Source[], key: string): Source | undefined =>
  sources.find(s => s.owns.test(key))

/**
 * Turns one source's current list into task changes: add, reopen, auto-close, prune.
 * Auto-close touches only tasks the source owns; a key nobody owns is never closed.
 */
export const reconcile = (
  list: Task[],
  inbox: Inbox,
  source: Source,
  now: number,
  keepMs: number = DEFAULT_KEEP_RESOLVED_DAYS * DAY_MS,
  dismissed: Dismissed = {},
): Task[] => {
  const items = inboxItems(inbox)
  const present = new Set(items.map(i => i.key))
  let next = list.map(t => ({ ...t }))
  let id = nextId(next)

  for (const it of items) {
    if (it.baseline) continue
    const task = next.find(t => t.key === it.key)
    // Removed by hand: stay gone until the source has new activity (its rev changes).
    if (!task && it.key in dismissed && dismissed[it.key] === (it.rev ?? '')) continue
    if (!task) {
      next.unshift({
        id: id++,
        text: it.title,
        isDone: false,
        key: it.key,
        rev: it.rev,
        url: it.url,
        createdAt: now,
      })
    } else if (task.rev !== it.rev) {
      task.text = it.title
      task.rev = it.rev
      task.url = it.url
      if (task.isDone) {
        task.isDone = false
        task.inProgress = false
        delete task.closedBy
        delete task.closedAt
      }
    } else if (task.isDone && task.closedBy === 'auto') {
      task.isDone = false
      delete task.closedBy
      delete task.closedAt
    }
    if (task && task.url !== it.url) task.url = it.url
  }

  if (inbox.complete) {
    for (const t of next) {
      if (t.key && source.owns.test(t.key) && !t.isDone && !present.has(t.key)) {
        t.isDone = true
        t.inProgress = false
        t.closedBy = 'auto'
        t.closedAt = now
      }
    }
  }

  next = next.filter(
    t =>
      !(
        t.closedBy !== undefined &&
        t.closedAt !== undefined &&
        now - t.closedAt > keepMs
      ),
  )
  return next
}

/**
 * Tasks a reconcile step brought to the user's attention: keys absent from `before`, and closed
 * tasks it reopened because the source has new activity (a changed rev). A reopen with the same
 * rev (an auto-closed item that came back) does not count.
 */
export const newlyCreated = (before: Task[], after: Task[]): Task[] => {
  const old = new Map(before.filter(t => t.key).map(t => [t.key as string, t]))
  return after.filter(t => {
    if (!t.key) return false
    const was = old.get(t.key)
    if (!was) return true
    return was.isDone && !t.isDone && was.rev !== t.rev
  })
}

/**
 * Drops this source's dismissals whose item is gone, so a reused key isn't hidden forever.
 * Dismissals of other sources are kept.
 */
export const pruneDismissedKeys = (inbox: Inbox, source: Source, dismissed: Dismissed): Dismissed => {
  const present = new Set(inboxItems(inbox).map(i => i.key))
  const kept: Dismissed = {}
  for (const [k, rev] of Object.entries(dismissed)) {
    if (present.has(k) || !source.owns.test(k)) kept[k] = rev
  }
  return kept
}

/**
 * Tasks the user ticked that expired and were removed. They are remembered like a removal so a
 * source that is still active does not bring them back as new tasks, except the owner's
 * `keepOnUserExpire` keys.
 */
export const expiredUserTasks = (current: Task[], next: Task[], sources: Source[]): Task[] =>
  current.filter(
    t =>
      t.closedBy === 'user' &&
      t.key &&
      !sourceOf(sources, t.key)?.keepOnUserExpire?.test(t.key) &&
      !next.some(n => n.id === t.id),
  )
