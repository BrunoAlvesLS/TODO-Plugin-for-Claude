import { expect, test } from 'claude-code/testing'

import type { Dismissed, InboxItem, Source, Task } from '../../types'
import { newlyCreated, reconcile } from './reconcile'

const task = (id: number, key: string | undefined, extra: Partial<Task> = {}): Task => ({
  id,
  text: `task ${id}`,
  isDone: false,
  ...(key ? { key, rev: '1' } : {}),
  ...extra,
})

test('a key missing before counts as created', () => {
  const before = [task(1, 'wi:1')]
  const after = [task(2, 'wi:2'), task(1, 'wi:1')]
  expect(newlyCreated(before, after).map(t => t.key)).toEqual(['wi:2'])
})

test('tasks without a key never count', () => {
  expect(newlyCreated([], [task(1, undefined)])).toEqual([])
})

test('an unchanged open task does not count', () => {
  expect(newlyCreated([task(1, 'wi:1')], [task(1, 'wi:1')])).toEqual([])
})

test('a reopen with a changed rev counts', () => {
  const before = [task(1, 'wi:1', { isDone: true, closedBy: 'user', closedAt: 5 })]
  const after = [task(1, 'wi:1', { rev: '2' })]
  expect(newlyCreated(before, after).map(t => t.key)).toEqual(['wi:1'])
})

test('a reopen with the same rev does not count', () => {
  const before = [task(1, 'wi:1', { isDone: true, closedBy: 'auto', closedAt: 5 })]
  const after = [task(1, 'wi:1')]
  expect(newlyCreated(before, after)).toEqual([])
})

test('a rev change on an open task does not count', () => {
  expect(newlyCreated([task(1, 'wi:1')], [task(1, 'wi:1', { rev: '2' })])).toEqual([])
})

const src: Source = {
  id: 'ado',
  label: 'x',
  inboxFile: 'i',
  settingsFile: 's',
  scriptFile: 'f',
  jobName: 'j',
  owns: /^(wi|pr)-[a-z]+:/,
  sameItem: /^wi-(?:assigned|child):(\d+)$/,
}
const NOW = 1000
const item = (key: string, extra: Partial<InboxItem> = {}): InboxItem => ({
  key,
  title: `title ${key}`,
  url: `u/${key}`,
  rev: '',
  ...extra,
})
const run = (list: Task[], keys: string[], opts: { complete?: boolean; source?: Source; dismissed?: Dismissed } = {}) =>
  reconcile(list, { complete: opts.complete ?? true, items: keys.map(k => item(k)) }, opts.source ?? src, NOW, undefined, opts.dismissed ?? {})
const row = (id: number, key: string, extra: Partial<Task> = {}): Task => task(id, key, { rev: '', ...extra })

test('child becomes assigned: the same row moves over, progress kept, no banner', () => {
  const before = [row(7, 'wi-child:9', { inProgress: true, startedAt: 5, createdAt: 2 })]
  const after = run(before, ['wi-assigned:9'])
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: 7, key: 'wi-assigned:9', text: 'title wi-assigned:9', inProgress: true, startedAt: 5, createdAt: 2, isDone: false })
  expect(newlyCreated(before, after)).toEqual([])
})

test('assigned becomes child: the same row moves back', () => {
  const before = [row(7, 'wi-assigned:9', { inProgress: true })]
  const after = run(before, ['wi-child:9'])
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: 7, key: 'wi-child:9', inProgress: true })
})

test('both keys in the inbox: nothing is taken over', () => {
  const before = [row(7, 'wi-child:9')]
  const after = run(before, ['wi-child:9', 'wi-assigned:9'])
  expect(after.map(t => t.key).sort()).toEqual(['wi-assigned:9', 'wi-child:9'])
  expect(after.find(t => t.key === 'wi-child:9')?.id).toBe(7)
})

test('a row the user ticked is not taken over: a new task appears', () => {
  const before = [row(7, 'wi-child:9', { isDone: true, closedBy: 'user', closedAt: 5 })]
  const after = run(before, ['wi-assigned:9'])
  expect(after).toHaveLength(2)
  expect(after.find(t => t.key === 'wi-child:9')?.isDone).toBe(true)
  expect(newlyCreated(before, after).map(t => t.key)).toEqual(['wi-assigned:9'])
})

test('an auto-closed row is taken over and reopened without a banner', () => {
  const before = [row(7, 'wi-child:9', { isDone: true, closedBy: 'auto', closedAt: 5 })]
  const after = run(before, ['wi-assigned:9'])
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: 7, key: 'wi-assigned:9', isDone: false })
  expect(newlyCreated(before, after)).toEqual([])
})

test('tester is not part of the rule', () => {
  const before = [row(7, 'wi-tester:9', { inProgress: true })]
  const after = run(before, ['wi-assigned:9'])
  expect(after.find(t => t.id === 7)?.isDone).toBe(true)
  expect(after.some(t => t.key === 'wi-assigned:9' && t.id !== 7)).toBe(true)
})

test('a mention next to an assignment is never merged', () => {
  const before = [row(7, 'wi-mention:9')]
  const after = run(before, ['wi-mention:9', 'wi-assigned:9'])
  expect(after.map(t => t.key).sort()).toEqual(['wi-assigned:9', 'wi-mention:9'])
})

test('a PR with the same number is never merged with a work item', () => {
  const before = [row(7, 'pr-review:9')]
  const after = run(before, ['wi-assigned:9'])
  expect(after.find(t => t.id === 7)?.isDone).toBe(true)
  expect(after.some(t => t.key === 'wi-assigned:9' && t.id !== 7)).toBe(true)
})

test('a dismissed target key wins: the old row closes, nothing moves', () => {
  const before = [row(7, 'wi-child:9', { inProgress: true })]
  const after = run(before, ['wi-assigned:9'], { dismissed: { 'wi-assigned:9': '' } })
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: 7, key: 'wi-child:9', isDone: true, closedBy: 'auto' })
})

test('a baseline item takes nothing over', () => {
  const before = [row(7, 'wi-child:9')]
  const after = reconcile(before, { complete: true, items: [item('wi-assigned:9', { baseline: true })] }, src, NOW)
  expect(after[0]).toMatchObject({ id: 7, key: 'wi-child:9', isDone: true })
})

test('takeover still happens when the inbox is incomplete', () => {
  const after = run([row(7, 'wi-child:9', { inProgress: true })], ['wi-assigned:9'], { complete: false })
  expect(after).toHaveLength(1)
  expect(after[0]).toMatchObject({ id: 7, key: 'wi-assigned:9', inProgress: true })
})

test('a source without sameItem behaves as before', () => {
  const { sameItem: _unused, ...plain } = src
  const after = run([row(7, 'wi-child:9', { inProgress: true })], ['wi-assigned:9'], { source: plain })
  expect(after).toHaveLength(2)
  expect(after.find(t => t.id === 7)).toMatchObject({ isDone: true, closedBy: 'auto' })
})

test('a renamed key with the same id does not count as created', () => {
  expect(newlyCreated([row(7, 'wi-child:9')], [row(7, 'wi-assigned:9')])).toEqual([])
})
