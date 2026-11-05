import { expect, mock, test } from 'claude-code/testing'

import { startsAnyTurn, turnEnding } from '../hooks/transcript'
import type { TurnEnding } from '../hooks/transcript'

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

test('groups, counts and ages as in the Context pane', { timeoutMs: 20_000 }, async ($, on) => {
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

test('the bar, when switched on: an SVG on desktop, blocks on the terminal', { timeoutMs: 20_000 }, async ($, on) => {
  seed(on, true)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /█/ }))?.text).toMatch(/^█+$/)
  await terminal.unmount()
})

test('a narrow pane cuts titles with an ellipsis and keeps the ages whole', { timeoutMs: 20_000 }, async ($, on) => {
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
  fresh: { lastAssistantUuid: 'u-c', lastTurnEdgeAt: at(120), lastFocusedAt: at(60), postTurnSummary: blocked('u-c'), cliSessionId: '77777777-7777-7777-7777-777777777777', cwd: 'C:\\w' },
  // Compacted 50 min ago, after its last reply 3 h ago that was read.
  compacted: { lastAssistantUuid: 'u-d', lastTurnEdgeAt: at(50), lastFocusedAt: at(120), postTurnSummary: done('u-d') },
  unread: { lastAssistantUuid: 'u-e', lastTurnEdgeAt: at(120), lastFocusedAt: at(180), postTurnSummary: done('u-e') },
  // Its turn ended 10 min ago; a subagent it left running wrote half a minute ago.
  busy: { lastAssistantUuid: 'u-f', lastTurnEdgeAt: at(10), lastFocusedAt: at(20), postTurnSummary: done('u-f'), cliSessionId: '0c61d93d-a258-4ecc-bb2b-458646df0cd0', cwd: 'C:\\w' },
  // No verdict of the app: the transcript says. After a /clear the reply sits in another CLI
  // session's file; the new one holds only the /clear.
  boxed: { lastAssistantUuid: 'u-g', lastTurnEdgeAt: at(30), lastFocusedAt: at(40), cliSessionId: '11111111-1111-1111-1111-111111111111', lastAssistantCliSessionId: '22222222-2222-2222-2222-222222222222', cwd: 'C:\\w' },
  quiet: { lastAssistantUuid: 'u-h', lastTurnEdgeAt: at(30), lastFocusedAt: at(20), cliSessionId: '33333333-3333-3333-3333-333333333333', cwd: 'C:\\w' },
  // Its box asked, then you cleared it and wrote in the new session: nothing of it waits.
  moved: { lastAssistantUuid: 'u-i', lastTurnEdgeAt: at(30), lastFocusedAt: at(20), cliSessionId: '44444444-4444-4444-4444-444444444444', lastAssistantCliSessionId: '55555555-5555-5555-5555-555555555555', cwd: 'C:\\w' },
  // Its box asked and you answered it there: your prompt came after the reply.
  answered: { lastAssistantUuid: 'u-j', lastTurnEdgeAt: at(30), lastFocusedAt: at(20), cliSessionId: '66666666-6666-6666-6666-666666666666', cwd: 'C:\\w' },
}
const line = (o: object) => JSON.stringify(o)
const turnLines = (box: object, prose: string, uuid: string) => [
  line({ type: 'user', origin: { kind: 'human' }, message: { content: 'udělej to' } }),
  line({ type: 'assistant', uuid: `${uuid}-0`, message: { content: [{ type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input: box }] } }),
  line({ type: 'assistant', uuid, message: { content: [{ type: 'text', text: prose }] } }),
]
const ASKS = { recap: 'Hotovo.', ask: 'Nasadit teď?', actions: [{ label: 'Ano' }, { label: 'Ráno' }] }
const CLEARED = [
  line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
  line({ type: 'user', message: { content: '<local-command-stdout></local-command-stdout>' } }),
]
const TRANSCRIPTS: Record<string, string> = {
  '11111111-1111-1111-1111-111111111111': CLEARED.join('\r\n'),
  '22222222-2222-2222-2222-222222222222': turnLines(ASKS, 'Nasadit teď?', 'u-g').join('\r\n'),
  '33333333-3333-3333-3333-333333333333': turnLines({ recap: 'Hotovo.' }, 'Chceš ještě něco?', 'u-h').join('\r\n'),
  '44444444-4444-4444-4444-444444444444': [...CLEARED, line({ type: 'user', origin: { kind: 'human' }, message: { content: 'nová práce' } })].join('\r\n'),
  '55555555-5555-5555-5555-555555555555': turnLines(ASKS, 'Nasadit teď?', 'u-i').join('\r\n'),
  // No box: the app's verdict says what it asks.
  '77777777-7777-7777-7777-777777777777': [
    line({ type: 'user', origin: { kind: 'human' }, message: { content: 'udělej to' } }),
    line({ type: 'assistant', uuid: 'u-c', message: { content: [{ type: 'text', text: 'Mám to nasadit?' }] } }),
  ].join('\r\n'),
  '66666666-6666-6666-6666-666666666666': [...turnLines(ASKS, 'Nasadit teď?', 'u-j'), line({ type: 'user', origin: { kind: 'human' }, message: { content: 'Ano' } })].join('\r\n'),
}
// The script a tail read hands PowerShell: -EncodedCommand is UTF-16LE in base64.
function scriptOf(argv: readonly string[]): string {
  const i = argv.indexOf('-EncodedCommand')
  if (i < 0) return argv.join(' ')
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  const b64 = argv[i + 1] ?? ''
  for (let k = 0; k < b64.length; k += 4) {
    const n = [0, 1, 2, 3].reduce((acc, j) => (acc << 6) | Math.max(0, abc.indexOf(b64[k + j] ?? '=')), 0)
    bytes.push((n >> 16) & 255)
    if (b64[k + 2] !== '=') bytes.push((n >> 8) & 255)
    if (b64[k + 3] !== '=') bytes.push(n & 255)
  }
  let out = ''
  for (let k = 0; k + 1 < bytes.length; k += 2) out += String.fromCharCode(bytes[k]! | (bytes[k + 1]! << 8))
  return out
}
const LISTED = [
  session('bumped', 'Posunuté', 50),
  session('old', 'Stará otázka', 1800),
  session('fresh', 'Nová otázka', 120),
  session('compacted', 'Po compactu', 50),
  session('unread', 'Nepřečtené okno', 120),
  session('busy', 'Subagenti na pozadí', 10),
  session('boxed', 'Rámeček s otázkou', 30),
  session('quiet', 'Rámeček bez otázky', 30),
  session('moved', 'Po clear dál', 30),
  session('answered', 'Odpověděno v okně', 30),
]

// The engine as a poll meets it: the app's records, the transcripts (read by PowerShell, sized by
// stat), the stores. `transcripts` and `now` may change between polls.
type On = Parameters<Parameters<typeof test>[1]>[1]
// `now` undefined: the test runs mock.clock. `self` is the title of the window the plugin runs in.
function mockPoll(on: On, transcripts: Record<string, string>, now: (() => number) | undefined, store: Map<string, unknown>, self = 'Toto okno') {
  let paneOpen = false
  let reads = 0
  const text = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })
  if (now) {
    on('clock.now', () => ({ value: now() }))
    on('clock.every', () => ({ value: undefined }))
  }
  on('command.register', () => ({ value: { command: 'okna' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: paneOpen ? [{ id: 'okna', title: 'Okna', isShown: true, isFocused: false }] : [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const cliOf = (path: string) => Object.keys(transcripts).find(cli => new RegExp(`[\\\\/]C--w[\\\\/]${cli}\\.jsonl$`).test(path))
  on('process.run', (_, e) => {
    const cli = Object.keys(transcripts).find(c => scriptOf(e.argv).includes(`${c}.jsonl`))
    if (cli) reads++
    return { value: { exitCode: 0, stdout: cli ? (transcripts[cli] ?? '') : 'C:/L\r\n', stderr: '' } }
  })
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: (transcripts[cliOf(e.path) ?? ''] ?? '').length, mtimeMs: at(30), isLink: false } }))
  const subagents = /[\\/]C--w[\\/]0c61d93d-a258-4ecc-bb2b-458646df0cd0[\\/]subagents$/
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
    value: e.path.endsWith('claude-code-sessions') || subagents.test(e.path) || recordOf(e.path) in RECORDS || cliOf(e.path) !== undefined,
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
        ? text((e.args as { session_id?: string }).session_id === 'self' ? session('self', self, 0, true) : LISTED.find(l => l.sessionId === (e.args as { session_id?: string }).session_id))
        : { value: { content: [{ type: 'text', text: '' }], isError: false } },
  )
  return {
    open: () => {
      paneOpen = true
    },
    // Transcripts read so far.
    reads: () => reads,
  }
}

test('a poll goes by replies, drops seen old questions and keeps the polling window for the others', { timeoutMs: 20_000 }, async ($, on) => {
  const store = new Map<string, unknown>([['replies', { compacted: { turn: 'u-d', at: at(180) } }]])
  const pane = mockPoll(on, TRANSCRIPTS, () => NOW, store)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  pane.open()
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
  // The window's own box: a question with its buttons, or, asking nothing, nothing waits.
  expect(lines).toContain('ČEKÁ · Rámeček s otázkou · 30 min — Nasadit teď?')
  expect(lines.find(line => line.includes('Rámeček bez otázky'))).not.toMatch(/^ČEKÁ/)
  // Answered in the window, or cleared and gone on: its question waits no more.
  expect(lines.find(line => line.includes('Po clear dál'))).not.toMatch(/^ČEKÁ/)
  expect(lines.find(line => line.includes('Odpověděno v okně'))).not.toMatch(/^ČEKÁ/)
  // The other windows get the polling window from the shared list.
  const shared = store.get('snapshot') as { rows: { id: string; question?: object }[] }
  expect(shared.rows.map(r => r.id)).toContain('self')
  expect(shared.rows.find(r => r.id === 'boxed')?.question).toEqual({ text: 'Nasadit teď?', context: 'Hotovo.', options: ['Ano', 'Ráno'] })
})

test('a question you settle in its window without a new reply drops out at the next poll', { timeoutMs: 20_000 }, async ($, on) => {
  // You wrote into the window and broke the turn off before it replied: its last reply stays.
  const cli = '66666666-6666-6666-6666-666666666666'
  const transcripts = { ...TRANSCRIPTS, [cli]: turnLines(ASKS, 'Nasadit teď?', 'u-j').join('\r\n') }
  let now = NOW
  const pane = mockPoll(on, transcripts, () => now, new Map())
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  pane.open()
  const before = ((await $.command.run({ command: 'okna' })).text ?? '').split('\n')
  expect(before).toContain('ČEKÁ · Odpověděno v okně · 30 min — Nasadit teď?')
  transcripts[cli] += `\r\n${line({ type: 'user', origin: { kind: 'human' }, message: { content: 'Ráno' } })}`
  transcripts[cli] += `\r\n${line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })}`
  now += 60_000
  const read = pane.reads()
  const after = ((await $.command.run({ command: 'okna' })).text ?? '').split('\n')
  expect(after.find(l => l.includes('Odpověděno v okně'))).not.toMatch(/^ČEKÁ/)
  // The others, unchanged, were not read again and still ask.
  expect(pane.reads() - read).toBe(1)
  expect(after).toContain('ČEKÁ · Rámeček s otázkou · 31 min — Nasadit teď?')
})

test('an opened "Dřív" is kept for the other windows', { timeoutMs: 20_000 }, async ($, on) => {
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

test('how a turn ended comes from the transcript: a box that asks, one that does not, prose', () => {
  const line = (o: object) => JSON.stringify(o)
  const box = (input: object) => ({ type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input })
  // The window's last reply is 'r2', as the app records it.
  const turn = (b: object, prose: string) => [
    line({ type: 'user', origin: { kind: 'human' }, message: { content: 'udělej to' } }),
    line({ type: 'assistant', uuid: 'r1', message: { content: [{ type: 'text', text: 'Dřívější text?' }, b] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    line({ type: 'assistant', uuid: 'r2', message: { content: [{ type: 'text', text: prose }] } }),
    'není json',
  ]
  const askOf = (e: TurnEnding) => (e.state === 'replied' ? e.box?.ask?.text : undefined)
  const asking = box({ recap: 'Hotovo.', ask: 'Mám to nasadit?', actions: [{ label: 'Ano, nasaď' }, { action: 'commit' }, { label: 'Ne' }] })
  expect(turnEnding(turn(asking, 'Hotovo, mám nasadit?'), 'r2')).toEqual({
    state: 'replied',
    box: { ask: { text: 'Mám to nasadit?', context: 'Hotovo.', options: ['Ano, nasaď', 'Ne'] } },
    prose: 'Hotovo, mám nasadit?',
  })
  // A box without a question: nothing waits, whatever the prose says.
  expect(turnEnding(turn(box({ recap: 'Hotovo.' }), 'Chceš ještě něco?'), 'r2')).toMatchObject({ state: 'replied', box: { ask: null } })
  // No box: only the prose is left to guess from.
  expect(turnEnding(turn({ type: 'text', text: 'x' }, 'Kterou variantu?'), 'r2')).toEqual({ state: 'replied', box: null, prose: 'Kterou variantu?' })
  // The tail does not hold the app's last reply (cut off, behind the app): nothing to go by.
  expect(turnEnding(turn(asking, 'x'), 'r9')).toEqual({ state: 'unknown' })
  expect(turnEnding([], 'r2')).toEqual({ state: 'unknown' })
  // Your prompt after it: the window is on its next turn.
  const answered = (...after: object[]) => turnEnding([...turn(asking, 'x'), ...after.map(line)], 'r2')
  expect(answered({ type: 'user', origin: { kind: 'human' }, message: { content: 'ano' } })).toEqual({ state: 'answered' })
  // So is an older transcript's prompt without an origin, or an image alone.
  expect(answered({ type: 'user', message: { content: 'ano' } })).toEqual({ state: 'answered' })
  expect(answered({ type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'image' }] } })).toEqual({ state: 'answered' })
  // Another session's message (Centrála's reply), a plugin's prompt, a background task's notice.
  expect(answered({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { content: 'Ano' } })).toEqual({ state: 'answered' })
  expect(answered({ type: 'user', isMeta: true, origin: { kind: 'plugin' }, message: { content: 'x' } })).toEqual({ state: 'answered' })
  expect(answered({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'x' } })).toEqual({ state: 'answered' })
  // ...but only once the reply before it is the last one the app knows: else the tail is behind.
  expect(turnEnding([...turn(asking, 'x'), line({ type: 'user', origin: { kind: 'human' }, message: { content: 'ano' } })], 'r9')).toEqual({ state: 'unknown' })
  // Another session's reply came and the window works on, its new replies not yet recorded by the
  // app (nor, at times, its running): it moved on.
  const working = [
    line({ type: 'user', origin: { kind: 'peer' }, message: { content: '<cross-session-message>Ano</cross-session-message>' } }),
    line({ type: 'assistant', uuid: 'r5', message: { content: [{ type: 'text', text: 'Pracuji na tom.' }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    line({ type: 'assistant', uuid: 'r6', message: { content: [box({ ask: 'Další otázka?' })] } }),
  ]
  expect(turnEnding([...turn(asking, 'x'), ...working], 'r2')).toEqual({ state: 'answered' })
  // So with an older transcript's prompt, which names no origin.
  expect(turnEnding([...turn(asking, 'x'), line({ type: 'user', message: { content: 'dál' } }), ...working.slice(1)], 'r2')).toEqual({ state: 'answered' })
  // A reply too long to read whole: how its turn closed is unknown.
  expect(turnEnding([...turn(asking, 'x'), line({ type: 'assistant', huge: true, uuid: 'r3', message: { content: [] } })], 'r3')).toEqual({ state: 'unknown' })
  // A subagent's lines are not the window's.
  const side = line({ type: 'assistant', isSidechain: true, message: { content: [box({ ask: 'Jiná?' })] } })
  expect(askOf(turnEnding([...turn(asking, 'x'), side], 'r2'))).toBe('Mám to nasadit?')
  // A compact after it runs no turn: the question still waits.
  const compacted = [
    ...turn(asking, 'x'),
    line({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued…' } }),
    line({ type: 'user', isMeta: true, message: { content: '<local-command-caveat>…' } }),
    line({ type: 'user', message: { content: '<command-name>/compact</command-name>' } }),
    line({ type: 'user', message: { content: '<local-command-stdout>Compacted </local-command-stdout>' } }),
    line({ type: 'custom-title' }),
  ]
  expect(askOf(turnEnding(compacted, 'r2'))).toBe('Mám to nasadit?')
  // A skill's slash command does run a turn: it is a prompt.
  expect(answered({ type: 'user', message: { content: '<command-name>/dozor</command-name>' } })).toEqual({ state: 'answered' })
  // After /clear: the new session's file holds the /clear alone, or what you wrote since.
  const cleared = [line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }), line({ type: 'user', message: { content: '<local-command-stdout></local-command-stdout>' } })]
  expect(startsAnyTurn(cleared)).toBe(false)
  expect(startsAnyTurn([...cleared, line({ type: 'user', origin: { kind: 'human' }, message: { content: 'dál' } })])).toBe(true)
  expect(startsAnyTurn([...cleared, line({ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { content: 'Ano' } })])).toBe(true)
})

test('every surface draws the pane', { timeoutMs: 20_000 }, async ($, on) => {
  seed(on, true)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Čeká na tebe/ }))?.text).toBe('■ Čeká na tebe')
    await ui.unmount()
  }
})

// Last: the plugin keeps its window's title in memory, and here that window is Centrála.
test('Centrála: a new question starts its turn, a reply to a window that has moved on is refused', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const transcripts = { ...TRANSCRIPTS }
  const store = new Map<string, unknown>()
  mockPoll(on, transcripts, undefined, store, 'Centrála')
  const prompts: string[] = []
  const aborted: string[] = []
  const sent: string[] = []
  const written: Record<string, string> = {}
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  // The dialog answers with `answers` as they were when it opened; `hold` keeps it open until the
  // clock passes a minute.
  let answers: Record<string, string> = {}
  let hold = false
  on('tool.call', async (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const given = answers
      if (hold) await clock.sleep(60_000)
      return { result: { questions: [], answers: given }, text: 'odpovězeno' }
    }
    const args = e as unknown as { session_id?: string }
    sent.push(String(args.session_id))
    return { result: {}, text: 'odesláno' }
  })
  const send = async (session_id: string, message: string) =>
    (await $.tool.call({ tool: 'mcp__ccd_session_mgmt__send_message', session_id, message } as never)) as { deny?: string }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10_000)

  // One turn for every new question; the queue holds each with its own buttons.
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toMatch(/^\[okna\] Nové otázky z .*„Rámeček s otázkou“/)
  const queue = JSON.parse(Object.entries(written).find(([path]) => /centrala\.json$/.test(path))?.[1] ?? '{}') as {
    waiting: { id: string; question: string; options: string[] }[]
  }
  expect(queue.waiting.map(q => q.id).sort()).toEqual(['boxed', 'fresh'])
  expect(queue.waiting.find(q => q.id === 'boxed')?.options).toEqual(['Ano', 'Ráno'])

  // Its turn shows them; nothing new, no new turn.
  await $.turn.start({ text: prompts[0] ?? '', turnId: 't1' })
  await clock.advance(10_000)
  expect(prompts.length).toBe(1)
  // In its dialog you pick "Ano" for one window and write your own reply for the other.
  answers = { '„Rámeček s otázkou“: Nasadit teď?': 'Ano', '„Nová otázka“: Mám to nasadit?': 'Ano, ale až večer' }
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  // A reply you did not give that window is refused, even one another window got.
  expect((await send('fresh', 'Ano')).deny).toMatch(/^Nic neodesláno: tuto odpověď uživatel/)
  // You answer "Rámeček s otázkou" in the window itself meanwhile: its reply is refused.
  transcripts['22222222-2222-2222-2222-222222222222'] += `\r\n${line({ type: 'user', origin: { kind: 'human' }, message: { content: 'Ráno' } })}`
  expect((await send('boxed', 'Ano')).deny).toMatch(/^Nic neodesláno: okno mezitím/)
  expect(sent).toEqual([])
  // The window that still asks gets what you wrote for it; the night message always goes.
  expect((await send('fresh', 'Ano, ale až večer')).deny).toBeUndefined()
  expect((await send('boxed', '[noc] Uživatel zapnul noční režim.')).deny).toBeUndefined()
  expect(sent).toEqual(['fresh', 'boxed'])
  expect(aborted).toEqual([])
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Hotovo.', durationMs: 1000, isAborted: false })

  // "Rámeček bez otázky" asks after all (its box rewritten): a new turn, for it alone.
  transcripts['33333333-3333-3333-3333-333333333333'] = turnLines(ASKS, 'Nasadit teď?', 'u-h').join('\r\n')
  await clock.advance(10_000)
  expect(prompts.length).toBe(2)
  expect(prompts[1]).toMatch(/^\[okna\] Nová otázka z „Rámeček bez otázky“/)
  await $.turn.start({ text: prompts[1] ?? '', turnId: 't2' })
  // Its dialog is open when you answer that window in the window itself: the dialog is dropped
  // and what still waits ("Nová otázka", put to you before) is asked again.
  hold = true
  answers = {}
  const dialog = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.settle()
  transcripts['33333333-3333-3333-3333-333333333333'] += `\r\n${line({ type: 'user', origin: { kind: 'human' }, message: { content: 'Ano' } })}`
  await clock.advance(10_000)
  expect(aborted).toEqual(['t2'])
  expect(prompts.length).toBe(3)
  expect(prompts[2]).toMatch(/^\[okna\] Nová otázka z „Nová otázka“\./)
  await clock.advance(60_000)
  await dialog
  await $.turn.complete({ turnId: 't2', reason: 'aborted', answer: '', durationMs: 1000, isAborted: true })

  // Its next dialog you leave by writing to Centrála instead: that answers no window, and a reply
  // Centrála guesses from it is refused.
  hold = false
  await $.turn.start({ text: prompts[2] ?? '', turnId: 't3' })
  answers = { '„Nová otázka“: Mám to nasadit?': '[User did not answer this question — they sent a message instead.]' }
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect((await send('fresh', 'Ano, nasaď')).deny).toMatch(/^Nic neodesláno: tuto odpověď uživatel/)
  await $.turn.complete({ turnId: 't3', reason: 'answer', answer: 'Nic neodešlo.', durationMs: 1000, isAborted: false })
  // A reply you dictate in a turn of your own goes, while the window still asks.
  await $.turn.start({ text: 'Pošli „Nová otázka“: Ano, nasaď', turnId: 't4' })
  expect((await send('fresh', 'Ano, nasaď')).deny).toBeUndefined()
  expect(sent).toEqual(['fresh', 'boxed', 'fresh'])
})
