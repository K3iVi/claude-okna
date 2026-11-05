import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

const row = (id: string, title: string, extra: Record<string, unknown>) => ({
  id,
  title,
  link: '',
  isRunning: false,
  lastActivityAt: ago(300),
  waiting: false,
  snippet: '',
  unread: false,
  rc: false,
  rcLink: '',
  turn: `turn-${id}`,
  deferred: false,
  ...extra,
})

const ROWS = [
  row('a', 'Nabídka pro zákazníka', { waiting: true, snippet: 'Mám to nasadit?', lastActivityAt: ago(120) }),
  row('b', 'Testy aplikace', { isRunning: true, lastActivityAt: ago(1) }),
  row('c', 'Rozbor dat', { lastActivityAt: ago(52) }),
  row('d', 'Návod k webu', { unread: true, lastActivityAt: ago(70) }),
  row('e', 'Starší okno', { lastActivityAt: ago(600) }),
  row('f', 'Odložené okno', { deferred: true, waiting: true, snippet: 'Počká?' }),
]

const PANE = {
  plugin: 'okna',
  component: 'Pane',
  requestId: 'okna',
  props: {
    title: 'Okna',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// The engine's answers: the clock, and the pane's values as a refresh left them.
function seed(on: Parameters<Parameters<typeof test>[1]>[1], bar: boolean) {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e) => ({
    value: { value: e.key === 'rows' ? ROWS : e.key === 'bar' ? bar : undefined, version: 1 },
  }))
}

test('groups, counts and ages as in the Context pane', async ($, on) => {
  seed(on, false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /^6 oken$/ }))?.text).toBe('6 oken')
  for (const label of ['Čeká na tebe', 'Pracuje', 'Končí cache', 'Nepřečtené']) {
    expect((await ui.find({ type: 'Text', text: new RegExp(label) }))?.text).toBe(`■ ${label}`)
  }
  expect((await ui.find({ type: 'Text', text: /za 8 min/ }))?.text).toBe('za 8 min')
  expect((await ui.find({ type: 'Text', text: /Mám to nasadit/ }))?.text).toBe('Mám to nasadit?')
  // Folded: "Dřív" and "Odloženo" show their names, not their windows.
  expect((await ui.find({ type: 'Text', text: /Dřív/ }))?.text).toBe('› Dřív')
  expect((await ui.find({ type: 'Text', text: /Odloženo/ }))?.text).toBe('› Odloženo')
  expect(await ui.find({ type: 'Text', text: /Odložené okno/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Starší okno/ })).toBeUndefined()
  // No bar unless switched on.
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('the bar, when switched on: an SVG on desktop, blocks on the terminal', async ($, on) => {
  seed(on, true)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /█/ }))?.text).toMatch(/^█+$/)
  await terminal.unmount()
})

test('a narrow pane cuts titles with an ellipsis and keeps the ages whole', async ($, on) => {
  seed(on, false)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 20 } })
    expect((await ui.find({ type: 'Text', text: /^Nabídka pro zákazníka$/ }))?.props.wrap).toBe('truncate-end')
    expect((await ui.find({ type: 'Text', text: /Mám to nasadit/ }))?.props.wrap).toBe('wrap')
    // The age sits in a Box that never shrinks.
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('{"flexShrink":0},"children":[{"type":"Text","props":{"color":"#E24B4A"},"children":["za "')
    await ui.unmount()
  }
})

// A poll over records as the app writes them: times its housekeeping moved, a compact,
// questions old and new, and the polling window itself, which list_sessions leaves out.
// The engine hands paths over with Windows separators; a record is known by its file name.
const recordOf = (path: string) => /[\\/]acc[\\/]org[\\/](\w+)\.json$/.exec(path)?.[1] ?? ''
const at = (min: number) => NOW - min * 60_000
const session = (id: string, title: string, lastMin: number, isRunning = false) => ({
  sessionId: id,
  title,
  isArchived: false,
  isRunning,
  lastActivityAt: new Date(at(lastMin)).toISOString(),
  link: `claude://claude.ai/epitaxy/${id}`,
})
const blocked = (uuid: string) => ({ status_category: 'blocked', needs_action: 'Mám to nasadit?', summarizes_uuid: uuid })
const done = (uuid: string) => ({ status_category: 'completed', summarizes_uuid: uuid })
const RECORDS: Record<string, object> = {
  // Last reply 5 h ago; the app's housekeeping wrote 50 min ago.
  bumped: { lastAssistantUuid: 'u-a', lastTurnEdgeAt: at(300), lastActivityAt: at(50), lastFocusedAt: at(240), postTurnSummary: done('u-a') },
  // A question seen and left for more than a day.
  old: { lastAssistantUuid: 'u-b', lastTurnEdgeAt: at(1800), lastFocusedAt: at(1740), postTurnSummary: blocked('u-b') },
  fresh: { lastAssistantUuid: 'u-c', lastTurnEdgeAt: at(120), lastFocusedAt: at(60), postTurnSummary: blocked('u-c') },
  // Compacted 50 min ago, after its last reply 3 h ago that was read.
  compacted: { lastAssistantUuid: 'u-d', lastTurnEdgeAt: at(50), lastFocusedAt: at(120), postTurnSummary: done('u-d') },
  unread: { lastAssistantUuid: 'u-e', lastTurnEdgeAt: at(120), lastFocusedAt: at(180), postTurnSummary: done('u-e') },
  // Its turn ended 10 min ago; a subagent it left running wrote half a minute ago.
  busy: { lastAssistantUuid: 'u-f', lastTurnEdgeAt: at(10), lastFocusedAt: at(20), postTurnSummary: done('u-f'), cliSessionId: 'cli-f', cwd: 'C:\\w' },
}
const LISTED = [
  session('bumped', 'Posunuté', 50),
  session('old', 'Stará otázka', 1800),
  session('fresh', 'Nová otázka', 120),
  session('compacted', 'Po compactu', 50),
  session('unread', 'Nepřečtené okno', 120),
  session('busy', 'Subagenti na pozadí', 10),
]

test('a poll goes by replies, drops seen old questions and keeps the polling window for the others', async ($, on) => {
  const store = new Map<string, unknown>([['replies', { compacted: { turn: 'u-d', at: at(180) } }]])
  let paneOpen = false
  const text = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'okna' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: paneOpen ? [{ id: 'okna', title: 'Okna', isShown: true, isFocused: false }] : [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'C:/L\r\n', stderr: '' } }))
  const subagents = /[\\/]C--w[\\/]cli-f[\\/]subagents$/
  on('fs.list', (_, e) => ({
    value: subagents.test(e.path)
      ? [{ name: 'agent-1.jsonl', kind: 'file', size: 1, mtimeMs: at(0.5), isLink: false }]
      : e.path.endsWith('Claude-Data')
      ? [{ name: 'claude_x', kind: 'dir' }]
      : e.path.endsWith('claude-code-sessions')
        ? [{ name: 'acc', kind: 'dir' }]
        : [{ name: 'org', kind: 'dir' }],
  }))
  on('fs.exists', (_, e) => ({
    value: e.path.endsWith('claude-code-sessions') || subagents.test(e.path) || recordOf(e.path) in RECORDS,
  }))
  on('fs.read', (_, e) => ({ value: JSON.stringify(RECORDS[recordOf(e.path)]) }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('mcp.call', (_, e) =>
    e.tool === 'list_sessions'
      ? text(LISTED)
      : e.tool === 'get_session'
        ? text(session('self', 'Toto okno', 0, true))
        : { value: { content: [{ type: 'text', text: '' }], isError: false } },
  )

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  paneOpen = true
  const result = await $.command.run({ command: 'okna' })
  const lines = (result.text ?? '').split('\n')

  expect(lines).toContain('ČEKÁ · Nová otázka · 2 h — Mám to nasadit?')
  expect(lines).toContain('NOVÉ · Nepřečtené okno · 2 h')
  // Subagents at work after the turn: working, not unread.
  expect(lines.find(line => line.includes('Subagenti na pozadí'))).toMatch(/^PRACUJE · /)
  // Housekeeping and a compact are no work: no cache warning, the reply's age, no dot.
  expect(lines).toContain('- Posunuté · 5 h')
  expect(lines).toContain('- Po compactu · 3 h')
  expect(lines).toContain('- Stará otázka · 30 h')
  expect(lines.some(line => line.includes('Toto okno'))).toBe(false)
  // The other windows get the polling window from the shared list.
  const shared = store.get('snapshot') as { rows: { id: string }[] }
  expect(shared.rows.map(r => r.id)).toContain('self')
})

test('an opened "Dřív" is kept for the other windows', async ($, on) => {
  const stored = new Map<string, unknown>()
  const state = new Map<string, { value: unknown; version: number }>([['rows', { value: ROWS, version: 1 }]])
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_, e) => ({ value: state.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const version = (state.get(e.key)?.version ?? 0) + 1
    state.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'f-local-earlier' })
  expect(stored.get('open')).toEqual({ 'local-earlier': true })
  await ui.unmount()
})

test('every surface draws the pane', async ($, on) => {
  seed(on, true)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Čeká na tebe/ }))?.text).toBe('■ Čeká na tebe')
    await ui.unmount()
  }
})
