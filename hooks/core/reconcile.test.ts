import { expect, test } from 'claude-code/testing'

import type { Task } from '../../types'
import { newlyCreated } from './reconcile'

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
