import { expect, test } from 'claude-code/testing'

import { compactTime, parseCompact } from '../hooks/compact'

const NOW = Date.parse('2026-11-10T20:00:00Z')
const line = (at: string, rest = ',"idleMin":50,"before":151000,"after":52000') =>
  `{"sessionId":"s1","at":"${at}"${rest}}\n`

test('a compact file under a day old gives a mark', () => {
  const c = parseCompact(line('2026-11-10T19:46:17.240Z'), NOW)
  expect(c).toEqual({ at: '2026-11-10T19:46:17.240Z', idleMin: 50, before: 151000, after: 52000 })
  expect(compactTime(c!)).toMatch(/^\d{1,2}:\d{2}$/)
})

test('after may be null', () => {
  expect(parseCompact(line('2026-11-10T19:46:17.240Z', ',"before":151000,"after":null'), NOW)?.after).toBeNull()
})

test('a compact older than 24 h, a damaged or an empty file gives none', () => {
  expect(parseCompact(line('2026-11-09T19:00:00Z'), NOW)).toBeUndefined()
  expect(parseCompact('{"at":"not a date"}', NOW)).toBeUndefined()
  expect(parseCompact('{broken', NOW)).toBeUndefined()
  expect(parseCompact('', NOW)).toBeUndefined()
  expect(parseCompact('[]', NOW)).toBeUndefined()
})

const PANE = {
  plugin: 'okna',
  component: 'Pane',
  requestId: 'okna',
  props: { title: 'Okna', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  surface: 'desktop',
} as const

const row = (id: string, title: string, extra: Record<string, unknown>) => ({
  id,
  title,
  link: '',
  isRunning: false,
  lastActivityAt: new Date(NOW - 30 * 60_000).toISOString(),
  waiting: false,
  snippet: '',
  unread: true,
  rc: false,
  rcLink: '',
  turn: `turn-${id}`,
  deferred: false,
  ...extra,
})

test('the row shows the mark only for a window with a compact', { timeoutMs: 20_000 }, async ($, on) => {
  const compact = parseCompact(line('2026-11-10T19:46:17.240Z'), NOW)
  const rows = [row('a', 'Zkompaktované', { compact }), row('b', 'Bez compactu', {})]
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e) => ({ value: { value: e.key === 'rows' ? rows : undefined, version: 1 } }))
  const ui = await $.ui.mount(PANE)
  const marks = JSON.stringify(await ui.drawn()).match(/🗜 [\d:]+/g) ?? []
  expect(marks).toEqual([`🗜 ${compactTime(compact!)}`])
  await ui.unmount()
})
