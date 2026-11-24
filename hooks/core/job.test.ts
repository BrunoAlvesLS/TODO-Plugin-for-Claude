import { expect, test } from 'claude-code/testing'

import { buildJobXml } from './job'

const xml = (every: number, script = 'C:\\Users\\a b\\.claude\\todo-pane\\ado-watch.ps1') =>
  buildJobXml(script, every, '2026-01-31T09:00:00')

test('the job may start and keep running on battery', () => {
  const out = xml(10)
  expect(out).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
  expect(out).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
})

test('a missed run starts after sleep or shutdown', () => {
  expect(xml(10)).toContain('<StartWhenAvailable>true</StartWhenAvailable>')
})

test('the repeat interval is written so readJobIntervalMinutes can read it back', () => {
  expect(xml(1)).toContain('<Interval>PT1M</Interval>')
  expect(xml(10)).toContain('<Interval>PT10M</Interval>')
  expect(xml(60)).toContain('<Interval>PT1H</Interval>')
  expect(xml(90)).toContain('<Interval>PT1H30M</Interval>')
})

test('no XML declaration, because schtasks rejects a declared encoding that differs from the file', () => {
  expect(xml(10).startsWith('<Task')).toBe(true)
})

test('the script path is quoted and XML-escaped in the action', () => {
  const out = xml(10, 'C:\\Users\\a&b\\ado-watch.ps1')
  expect(out).toContain('-File &quot;C:\\Users\\a&amp;b\\ado-watch.ps1&quot;')
})
