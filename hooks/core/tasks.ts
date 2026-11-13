import type { Task } from '../../types'

/** The one on-disk layout of tasks.json. */
export const canonical = (list: Task[]) => `${JSON.stringify(list, null, 2)}\n`

export const nextId = (list: Task[]) => list.reduce((m, t) => Math.max(m, t.id), 0) + 1
