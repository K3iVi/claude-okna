import { expect, mock, test } from 'claude-code/testing'

import { acceptsAnswer, askOfBox, askOfDialog, dialogResult, isTrusted, parseState } from '../hooks/stav'
import type { WindowState } from '../hooks/stav'

// 0.9: each window writes its own state file; the panel and Centrála read it, and Centrála's
// plugin answers through it. The engine here: files in memory, the app's records among them.
const NOW = Date.parse('2026-11-05T12:00:00Z')
const at = (min: number) => NOW - min * 60_000
const HOME = 'C:/U'
const STATE = (id: string) => `${HOME}/.claude/okna-stav/${id}.json`
const ANSWER = (id: string) => `${HOME}/.claude/okna-stav/odpovedi/${id}.json`
const RECORD = (id: string) => `C:/L/Claude-Data/claude_x/claude-code-sessions/acc/org/${id}.json`

const state = (id: string, extra: Partial<WindowState>): WindowState => ({
  v: 1,
  plugin: '0.9.0',
  id,
  turn: 't',
  since: at(5),
  beat: NOW - 10_000,
  phase: 'done',
  ...extra,
})
const ask = (id: string, text = 'Nasadit?', options = ['Ano', 'Ráno']) => ({ id, text, context: '', options })

type On = Parameters<Parameters<typeof test>[1]>[1]
type Session = { sessionId: string; title: string; isArchived: boolean; isRunning: boolean; lastActivityAt: string; link: string }
const session = (id: string, title: string, isRunning = false): Session => ({
  sessionId: id,
  title,
  isArchived: false,
  isRunning,
  lastActivityAt: new Date(at(5)).toISOString(),
  link: `claude://claude.ai/epitaxy/${id}`,
})

function mockEnv(on: On, clock: { now: () => number }, opts: { self: string; sessions: Session[]; files: Map<string, { text: string; mtime: number }>; pane?: boolean }) {
  const { files } = opts
  const store = new Map<string, unknown>()
  const norm = (p: string) => p.replace(/\\/g, '/')
  const toasts: string[] = []

  const prompts: { text: string; asUser?: boolean }[] = []
  const text = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })
  on('command.register', () => ({ value: { command: 'okna' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: opts.pane ? [{ id: 'okna', title: 'Okna', isShown: true, isFocused: false }] : [] }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const cmd = e.argv.join(' ')
    const out = cmd.includes('USERPROFILE') ? HOME : cmd.includes('LOCALAPPDATA') ? 'C:/L' : cmd.includes('COMPUTERNAME') ? 'PC' : ''
    return { value: { exitCode: 0, stdout: `${out}\r\n`, stderr: '' } }
  })
  const children = (dir: string) => {
    const names = new Map<string, 'dir' | 'file'>()
    for (const path of files.keys()) {
      if (!path.startsWith(`${dir}/`)) continue
      const rest = path.slice(dir.length + 1).split('/')
      names.set(rest[0]!, rest.length > 1 ? 'dir' : 'file')
    }
    return names
  }
  const isDir = (p: string) => children(p).size > 0
  on('fs.exists', (_, e) => ({ value: files.has(norm(e.path)) || isDir(norm(e.path)) }))
  on('fs.read', (_, e) => {
    const f = files.get(norm(e.path))
    if (!f) throw new Error(`missing ${e.path}`)
    return { value: f.text }
  })
  on('fs.write', (_, e) => {
    files.set(norm(e.path), { text: e.text, mtime: clock.now() + files.size })
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const f = files.get(norm(e.path))
    if (!f) throw new Error(`missing ${e.path}`)
    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtime, isLink: false } }
  })
  on('fs.list', (_, e) => ({
    value: [...children(norm(e.path))].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push({ text: e.text, asUser: (e as { origin?: { asUser?: boolean }; asUser?: boolean }).asUser ?? (e as { origin?: { asUser?: boolean } }).origin?.asUser })
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('mcp.call', (_, e) => {
    const id = (e.args as { session_id?: string }).session_id
    if (e.tool === 'list_sessions') return text(opts.sessions)
    if (e.tool === 'get_session') return text(id === 'self' ? session('self', opts.self, true) : opts.sessions.find(s => s.sessionId === id))
    return { value: { content: [{ type: 'text', text: '' }], isError: false } }
  })
  return { store, toasts, prompts }
}

const put = (files: Map<string, { text: string; mtime: number }>, path: string, value: unknown, mtime = NOW) =>
  files.set(path, { text: JSON.stringify(value), mtime })
const readJson = <T,>(files: Map<string, { text: string; mtime: number }>, path: string) => JSON.parse(files.get(path)?.text ?? 'null') as T

test('the state file rules: what is believed, which answer is taken, how questions read', () => {
  const s = state('w', { phase: 'asks', ask: ask('b:t:1') })
  expect(parseState(JSON.stringify(s), 'w')?.phase).toBe('asks')
  // Another window's file, an older schema, a question without its ask: none counts.
  expect(parseState(JSON.stringify(s), 'x')).toBeUndefined()
  expect(parseState(JSON.stringify({ ...s, v: 0 }), 'w')).toBeUndefined()
  expect(parseState(JSON.stringify({ ...s, ask: undefined }), 'w')).toBeUndefined()
  // Fresh and in step with the app; a stale beat or a turn's end the file missed is not believed.
  expect(isTrusted(s, NOW, at(5))).toBe(true)
  expect(isTrusted({ ...s, beat: at(3) }, NOW, at(5))).toBe(false)
  expect(isTrusted(s, NOW, at(2))).toBe(false)
  // An answer is taken for the question asked now: a button, or what you typed yourself.
  expect(acceptsAnswer(s, { askId: 'b:t:1', text: 'Ano', typed: false, at: NOW })).toBe(true)
  expect(acceptsAnswer(s, { askId: 'b:t:1', text: 'Až zítra', typed: true, at: NOW })).toBe(true)
  expect(acceptsAnswer(s, { askId: 'b:t:1', text: 'Smaž to', typed: false, at: NOW })).toBe(false)
  expect(acceptsAnswer(s, { askId: 'b:t:0', text: 'Ano', typed: false, at: NOW })).toBe(false)
  expect(acceptsAnswer({ ...s, phase: 'working' }, { askId: 'b:t:1', text: 'Ano', typed: false, at: NOW })).toBe(false)
  // A box: its question and plain buttons (an app action is no reply); a dialog of one or several.
  expect(askOfBox('b', { recap: 'Hotovo.' })).toBeNull()
  expect(askOfBox('b', { ask: 'Nasadit?', recap: 'Hotovo.', actions: [{ label: 'Ano' }, { action: 'commit' }] })).toEqual({
    id: 'b',
    text: 'Nasadit?',
    context: 'Hotovo.',
    options: ['Ano'],
  })
  const one = { questions: [{ question: 'Která?', header: 'X', options: [{ label: 'A' }, { label: 'B' }] }] }
  expect(askOfDialog('d', one)).toEqual({ id: 'd', text: 'Která?', context: '', options: ['A', 'B'] })
  expect(dialogResult(one, { text: 'B' }).answers).toEqual({ 'Která?': 'B' })
  // Several questions: each keeps its own buttons, answered part by part.
  const two = { questions: [{ question: 'První?', options: [{ label: 'A' }, { label: 'B' }] }, { question: 'Druhá?', options: [{ label: 'X' }] }] }
  const asked2 = askOfDialog('d', two)
  expect(asked2).toEqual({
    id: 'd',
    text: '1) První? 2) Druhá?',
    context: '',
    options: [],
    parts: [{ text: 'První?', options: ['A', 'B'] }, { text: 'Druhá?', options: ['X'] }],
  })
  const parts = [{ text: 'B', typed: false }, { text: 'jinak', typed: true }]
  expect(dialogResult(two, { text: '1) B 2) jinak', parts }).answers).toEqual({ 'První?': 'B', 'Druhá?': 'jinak' })
  // An answer in words only (from a Centrála that knew no parts) goes as words.
  expect(dialogResult(two, { text: 'obě ano' })).toEqual({ questions: two.questions, answers: {}, response: 'obě ano' })
  const s2 = state('w', { phase: 'dialog', ask: asked2 })
  expect(parseState(JSON.stringify(s2), 'w')?.ask?.parts?.length).toBe(2)
  expect(acceptsAnswer(s2, { askId: 'd', text: '1) B 2) jinak', typed: true, at: NOW, parts })).toBe(true)
  // Every part, each with its own buttons: one missing, or a button of another part, is not taken.
  expect(acceptsAnswer(s2, { askId: 'd', text: '1) B', typed: false, at: NOW, parts: [parts[0]!] })).toBe(false)
  expect(acceptsAnswer(s2, { askId: 'd', text: '1) X 2) X', typed: false, at: NOW, parts: [{ text: 'X', typed: false }, { text: 'X', typed: false }] })).toBe(false)
  expect(acceptsAnswer(s2, { askId: 'd', text: 'obě', typed: true, at: NOW })).toBe(false)
  expect(acceptsAnswer(s, { askId: 'b:t:1', text: '1) Ano', typed: false, at: NOW, parts: [{ text: 'Ano', typed: false }] })).toBe(false)
})

test('Centrála asks a dialog of several questions part by part and hands all answers back at once', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, { text: string; mtime: number }>()
  const sessions = [session('w9', 'FW na žádost — vygenerovaný pro jednu BMS', true)]
  put(files, RECORD('w9'), { lastAssistantUuid: 'u-9', lastTurnEdgeAt: at(5), lastFocusedAt: at(10) })
  const parts = [
    { text: 'Schvaluješ schéma?', options: ['Schvaluji', 'Jen FW'] },
    { text: 'Ze kterého FW?', options: ['soc1', 'p1'] },
  ]
  put(files, STATE('w9'), state('w9', { phase: 'dialog', since: at(1), ask: { id: 'd:t:9', text: '1) … 2) …', context: '', options: [], parts } }))
  const env = mockEnv(on, clock, { self: 'Centrála', sessions, files })
  let answers: Record<string, string> = {}
  on('tool.call', async (_, e) => {
    if (e.tool === 'AskUserQuestion') return { result: { questions: [], answers }, text: 'odpovězeno' }
    return { result: {}, text: 'odesláno' }
  })
  on('turn.abort', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10_000)
  const queue = () => readJson<{ waiting: { id: string; options: string[]; parts?: { question: string; options: string[] }[] }[] }>(files, `${HOME}/.claude/centrala.json`)
  expect(queue().waiting.find(w => w.id === 'w9')).toMatchObject({
    options: [],
    parts: [{ question: 'Schvaluješ schéma?', options: ['Schvaluji', 'Jen FW'] }, { question: 'Ze kterého FW?', options: ['soc1', 'p1'] }],
  })
  await $.turn.start({ text: env.prompts[0]?.text ?? '', turnId: 'c1' })
  const q = (i: number) => ({
    question: `„FW na žádost“ (${i + 1}/2): ${parts[i]!.text}`,
    header: `FW na ž ${i + 1}/2`,
    options: [...parts[i]!.options, 'Později'].map(label => ({ label, description: '' })),
    multiSelect: false,
  })
  // The model shortens a long title („FW na žádost“): taken while no other window's title fits it.
  const questions = [q(0), q(1)]
  // „Později“ on one part: nothing goes, the whole question keeps waiting.
  answers = { [questions[0]!.question]: 'Schvaluji', [questions[1]!.question]: 'Později' }
  await $.tool.call({ tool: 'AskUserQuestion', questions } as never)
  expect(files.has(ANSWER('w9'))).toBe(false)
  // One part asked alone: which answer counts is not guessed.
  answers = { [questions[0]!.question]: 'Schvaluji' }
  await $.tool.call({ tool: 'AskUserQuestion', questions: [questions[0]] } as never)
  expect(files.has(ANSWER('w9'))).toBe(false)
  // Both answered (one in your own words): handed over together, in the parts' order.
  answers = { [questions[1]!.question]: 'p1', [questions[0]!.question]: 'Jen FW, CRM potom' }
  const out = (await $.tool.call({ tool: 'AskUserQuestion', questions } as never)) as { context?: string[] }
  expect(out.context?.at(-1)).toMatch(/předal odpověď oknům „FW na žádost — vygenerovaný pro jednu BMS“/)
  expect(readJson(files, ANSWER('w9'))).toMatchObject({
    askId: 'd:t:9',
    text: '1) Jen FW, CRM potom 2) p1',
    parts: [{ text: 'Jen FW, CRM potom', typed: true }, { text: 'p1', typed: false }],
  })
  // Another window whose title begins alike: the short name fits both, nothing goes.
  files.delete(ANSWER('w9'))
  sessions.push(session('w10', 'FW na žádost — druhé', true))
  put(files, RECORD('w10'), { lastAssistantUuid: 'u-10', lastTurnEdgeAt: at(5), lastFocusedAt: at(10) })
  put(files, STATE('w10'), state('w10', { phase: 'dialog', since: at(1), beat: clock.now(), ask: { id: 'd:t:10', text: 'Jo?', context: '', options: ['Jo'] } }))
  put(files, STATE('w9'), state('w9', { phase: 'dialog', since: at(1), beat: clock.now(), ask: { id: 'd:t:9', text: '1) … 2) …', context: '', options: [], parts } }))
  // (w9 is back in the queue once its handed answer has gone untaken 20 s.)
  await clock.advance(40_000)
  expect(queue().waiting.map(w => w.id).sort()).toEqual(['w10', 'w9'])
  await $.tool.call({ tool: 'AskUserQuestion', questions } as never)
  expect(files.has(ANSWER('w9'))).toBe(false)
})

test('a window closes its dialog of several questions with the answers picked in Centrála', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, { text: string; mtime: number }>()
  mockEnv(on, clock, { self: 'Okno A', sessions: [], files })
  on('tool.call', async (_, e) => {
    if (e.tool === 'AskUserQuestion') await new Promise(() => undefined)
    return { result: {}, text: 'ok' }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const own = () => readJson<WindowState>(files, STATE('self'))
  await $.turn.start({ text: 'dál', turnId: 't1' })
  const opt = (label: string) => ({ label, description: '' })
  const questions = [
    { question: 'Schéma?', header: 'S', options: [opt('Ano'), opt('Ne')], multiSelect: false },
    { question: 'Základ?', header: 'Z', options: [opt('soc1'), opt('p1')], multiSelect: false },
  ]
  const dialog = $.tool.call({ tool: 'AskUserQuestion', questions, tool_use_id: 'tu1' } as never) as Promise<{ result?: { answers?: Record<string, string> } }>
  for (let i = 0; i < 100 && own().phase !== 'dialog'; i++) await clock.advance(10)
  expect(own().ask?.parts).toEqual([{ text: 'Schéma?', options: ['Ano', 'Ne'] }, { text: 'Základ?', options: ['soc1', 'p1'] }])
  put(files, ANSWER('self'), { askId: own().ask!.id, text: '1) Ano 2) p1', typed: false, at: NOW, parts: [{ text: 'Ano', typed: false }, { text: 'p1', typed: false }] }, NOW + 1)
  await clock.advance(3_000)
  const out = await dialog
  expect(out.result?.answers).toEqual({ 'Schéma?': 'Ano', 'Základ?': 'p1' })
  expect(own().phase).toBe('working')
})

test('a window writes its own state: working, the box it asks, done, a dialog Centrála answers, approvals', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, { text: string; mtime: number }>()
  const env = mockEnv(on, clock, { self: 'Okno A', sessions: [], files })
  // The dialog stays open until it is answered (here: never by a click); tools answer at once.
  let clicked: unknown
  on('tool.call', async (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      clicked = await new Promise(() => undefined)
    }
    return { result: {}, text: 'ok' }
  })
  on('tool.check', (_, e) => ({ decision: e.tool === 'Bash' ? 'ask' : 'allow' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const own = () => readJson<WindowState>(files, STATE('self'))

  await $.turn.start({ text: 'udělej to', turnId: 't1' })
  expect(own().phase).toBe('working')
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Hotovo.', ask: 'Nasadit?', actions: [{ label: 'Ano' }, { label: 'Ráno' }], tool_use_id: 'tu1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'Hotovo.', durationMs: 1000, isAborted: false })
  expect(own().phase).toBe('asks')
  expect(own().ask?.options).toEqual(['Ano', 'Ráno'])
  const asked = own().ask!.id
  expect(asked).toMatch(/^b:t1:/)

  // An answer for another question is dropped; one not among its buttons, not typed by you, too.
  put(files, ANSWER('self'), { askId: 'b:t0:x', text: 'Ano', typed: false, at: NOW })
  await clock.advance(3_000)
  put(files, ANSWER('self'), { askId: asked, text: 'Smaž všechno', typed: false, at: NOW }, NOW + 1)
  await clock.advance(3_000)
  expect(env.toasts.length).toBe(2)
  expect(env.prompts).toEqual([])
  expect(own().phase).toBe('asks')
  // Your pick from Centrála: put into the window as your words, taken once.
  put(files, ANSWER('self'), { askId: asked, text: 'Ráno', typed: false, at: NOW }, NOW + 2)
  await clock.advance(3_000)
  expect(env.prompts).toEqual([{ text: 'Ráno', asUser: true }])
  expect(files.get(ANSWER('self'))?.text).toBe('{}')
  await clock.advance(3_000)
  expect(env.prompts.length).toBe(1)

  // The next turn: no box, broken off — done, nothing asked.
  await $.turn.start({ text: 'Ráno', turnId: 't2' })
  expect(own().ask).toBeUndefined()
  await $.turn.complete({ turnId: 't2', reason: 'aborted', answer: 'Pracuju…', durationMs: 1000, isAborted: true })
  expect(own()).toMatchObject({ phase: 'done', boxed: false, aborted: true })

  // A dialog mid-turn: Centrála sees it, and your pick there closes it with a real answer.
  await $.turn.start({ text: 'dál', turnId: 't3' })
  const questions = [{ question: 'Která varianta?', header: 'Var', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }]
  const dialog = $.tool.call({ tool: 'AskUserQuestion', questions, tool_use_id: 'tu3' } as never) as Promise<{ result?: { answers?: Record<string, string> }; context?: string[] }>
  // The hook writes the file a few engine calls in: wait for it, not for the clock alone.
  for (let i = 0; i < 100 && own().phase !== 'dialog'; i++) await clock.advance(10)
  expect(clicked).toBeUndefined()
  expect(await Promise.race([dialog.then(v => JSON.stringify(v), err => `ERR ${String(err)}`), Promise.resolve().then(() => 'pending')])).toBe('pending')
  expect(own().phase).toBe('dialog')
  expect(own().ask?.options).toEqual(['A', 'B'])
  put(files, ANSWER('self'), { askId: own().ask!.id, text: 'B', typed: false, at: NOW }, NOW + 3)
  await clock.advance(3_000)
  const out = await dialog
  expect(out.result?.answers).toEqual({ 'Která varianta?': 'B' })
  expect(out.context?.[0]).toMatch(/Centrála/)
  expect(own().phase).toBe('working')

  // A permission prompt: shown, cleared once the call is through.
  await $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 'tu4' } as never)
  expect(own()).toMatchObject({ phase: 'approval', approval: { tool: 'Bash', summary: 'git push' } })
  await $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 'tu4' } as never)
  expect(own().phase).toBe('working')
  await $.turn.complete({ turnId: 't3', reason: 'answer', answer: 'Hotovo, nasazeno.', durationMs: 1000, isAborted: false })
  expect(own()).toMatchObject({ phase: 'done', prose: 'Hotovo, nasazeno.' })

  // A box that asks, then /clear: the conversation it belonged to is gone, so is the question.
  await $.turn.start({ text: 'další', turnId: 't4' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Hotovo.', ask: 'Smazat?', actions: [{ label: 'Ano' }], tool_use_id: 'tu5' } as never)
  await $.turn.complete({ turnId: 't4', reason: 'answer', answer: 'Hotovo.', durationMs: 1000, isAborted: false })
  expect(own().phase).toBe('asks')
  // A background agent's permission check after the turn ended hides nothing.
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu6' } as never)
  expect(own().phase).toBe('asks')
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)
  expect(own()).toMatchObject({ phase: 'done', aborted: true })
  expect(own().ask).toBeUndefined()
})

test('the panel believes a fresh state file over the app and the transcript, and only then', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, { text: string; mtime: number }>()
  const sessions = [
    session('w1', 'Ptá se rámečkem'),
    session('w2', 'Dialog uprostřed', true),
    session('w3', 'Starý soubor'),
    session('w4', 'Pracuje podle sebe'),
    session('w5', 'Soubor nestačil'),
    session('w6', 'Schválení'),
    session('w7', 'Aplikace vidí práci', true),
  ]
  for (const s of sessions) put(files, RECORD(s.sessionId), { lastAssistantUuid: `u-${s.sessionId}`, lastTurnEdgeAt: at(5), lastFocusedAt: at(10) })
  put(files, STATE('w1'), state('w1', { phase: 'asks', ask: ask('b:t:1') }))
  put(files, STATE('w2'), state('w2', { phase: 'dialog', since: at(1), ask: ask('d:t:2', 'Která?', ['A', 'B']) }))
  put(files, STATE('w3'), state('w3', { phase: 'asks', beat: at(3), ask: ask('b:t:3') }))
  put(files, STATE('w4'), state('w4', { phase: 'working', since: at(1) }))
  // The app saw a turn end 8 min after the file's question: something the file missed.
  put(files, STATE('w5'), state('w5', { phase: 'asks', since: at(13), ask: ask('b:t:5') }))
  put(files, STATE('w6'), state('w6', { phase: 'approval', since: at(1), approval: { tool: 'Bash', summary: 'git push' } }))
  put(files, STATE('w7'), state('w7', { phase: 'asks', ask: ask('b:t:7') }))
  const env = mockEnv(on, clock, { self: 'Toto okno', sessions, files, pane: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const rows = (env.store.get('snapshot') as { rows: { id: string; waiting: boolean; isRunning: boolean; askId?: string; approval?: string; question?: { text: string; options: string[] } }[] }).rows
  const by = (id: string) => rows.find(r => r.id === id)!
  expect(by('w1')).toMatchObject({ waiting: true, isRunning: false, askId: 'b:t:1', question: { text: 'Nasadit?', options: ['Ano', 'Ráno'] } })
  // The app counts it as working: the window says it waits in a dialog.
  expect(by('w2')).toMatchObject({ waiting: true, isRunning: false, askId: 'd:t:2', question: { text: 'Která?' } })
  // Not believed: the transcript decides (here it shows nothing), never the file's question.
  expect(by('w3').waiting).toBe(false)
  expect(by('w5').waiting).toBe(false)
  // The app says idle, the window says it works.
  expect(by('w4')).toMatchObject({ isRunning: true, waiting: false })
  expect(by('w6')).toMatchObject({ waiting: true, approval: 'Bash: git push' })
  expect(by('w6').question).toBeUndefined()
  // A question in the file while the app sees work: not shown.
  expect(by('w7')).toMatchObject({ waiting: false, isRunning: true })
})

test('Centrála: waits 10 s, answers a reporting window through its plugin, never by message', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, { text: string; mtime: number }>()
  const sessions = [session('w1', 'Okno jedna'), session('w8', 'Okno osm'), session('d1', 'Dvojče'), session('d2', 'Dvojče')]
  put(files, RECORD('w1'), { lastAssistantUuid: 'u-1', lastTurnEdgeAt: at(5), lastFocusedAt: at(10) })
  put(files, STATE('w1'), state('w1', { phase: 'asks', ask: ask('b:t:1') }))
  for (const id of ['d1', 'd2']) {
    put(files, RECORD(id), { lastAssistantUuid: `u-${id}`, lastTurnEdgeAt: at(5), lastFocusedAt: at(10) })
    put(files, STATE(id), state(id, { phase: 'asks', ask: ask(`b:t:${id}`) }))
  }
  const env = mockEnv(on, clock, { self: 'Centrála', sessions, files })
  let answers: Record<string, string> = {}
  const sent: string[] = []
  let during: (() => Promise<void>) | undefined
  on('tool.call', async (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      await during?.()
      return { result: { questions: [], answers }, text: 'odpovězeno' }
    }
    sent.push(String((e as unknown as { session_id?: string }).session_id))
    return { result: {}, text: 'odesláno' }
  })
  on('turn.abort', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10_000)
  expect(env.prompts.length).toBe(1)
  expect(env.prompts[0]?.text).toMatch(/„Okno jedna“/)
  const queue = () => readJson<{ waiting: { id: string; delivery: string }[] }>(files, `${HOME}/.claude/centrala.json`)
  expect(queue().waiting.find(w => w.id === 'w1')).toMatchObject({ delivery: 'plugin' })

  await $.turn.start({ text: env.prompts[0]?.text ?? '', turnId: 'c1' })
  // A question that has just come up is put to you only once it has stood 10 s.
  await clock.advance(9_000)
  put(files, RECORD('w8'), { lastAssistantUuid: 'u-8', lastTurnEdgeAt: clock.now(), lastFocusedAt: at(10) })
  put(files, STATE('w8'), state('w8', { phase: 'asks', since: clock.now(), beat: clock.now(), ask: ask('b:t:8', 'Smazat větev?', ['Ano', 'Ne']) }))
  await clock.advance(1_000)
  expect(env.prompts.length).toBe(1)
  await clock.advance(10_000)
  expect(env.prompts.length).toBe(2)
  // Its own turns since a /clear go with the queue: the skill clears it past `clearAt`.
  expect(readJson<{ turns: number; clearAt: number }>(files, `${HOME}/.claude/centrala.json`)).toMatchObject({ turns: 1, clearAt: 20 })
  expect(env.prompts[1]?.text).toMatch(/„Okno osm“/)

  // The dialog as the skill builds it: each window's own buttons plus „Později“.
  const q = (title: string, text: string, labels: string[]) => ({
    question: `„${title}“: ${text}`,
    header: title.slice(0, 12),
    options: [...labels, 'Později'].map(label => ({ label, description: '' })),
    multiSelect: false,
  })
  // A short name is never a cut inside a word („Okno je“ for „Okno jedna“).
  answers = { '„Okno je“: Nasadit?': 'Ano' }
  await $.tool.call({ tool: 'AskUserQuestion', questions: [q('Okno je', 'Nasadit?', ['Ano', 'Ráno'])] } as never)
  expect(files.has(ANSWER('w1'))).toBe(false)
  const questions = [q('Okno jedna', 'Nasadit?', ['Ano', 'Ráno']), q('Okno osm', 'Smazat větev?', ['Ano', 'Ne']), q('Dvojče', 'Nasadit?', ['Ano', 'Ráno'])]
  // While the dialog is open, "Okno jedna" is answered in its window and asks something new.
  let open = () => {}
  during = () => new Promise<void>(resolve => (open = resolve))

  // „Později“ answers nothing; two windows named alike get nothing; the answer goes to the question
  // the dialog showed, not to the one asked meanwhile (that window then drops it).
  answers = { [questions[0]!.question]: 'Ano', [questions[1]!.question]: 'Později', [questions[2]!.question]: 'Ano' }
  const dialog = $.tool.call({ tool: 'AskUserQuestion', questions } as never) as Promise<{ context?: string[] }>
  await clock.advance(100)
  put(files, STATE('w1'), state('w1', { phase: 'asks', since: clock.now(), beat: clock.now(), ask: ask('b:t:1b', 'A teď?', ['Ano']) }))
  put(files, RECORD('w1'), { lastAssistantUuid: 'u-1b', lastTurnEdgeAt: clock.now(), lastFocusedAt: at(10) })
  // A tick passes (the queue now holds the new question), then you click.
  await clock.advance(9_000)
  open()
  const out = await dialog
  expect(out.context?.at(-1)).toMatch(/předal odpověď oknům „Okno jedna“ /)
  expect(readJson(files, ANSWER('w1'))).toMatchObject({ askId: 'b:t:1', text: 'Ano', typed: false })
  expect(files.has(ANSWER('w8'))).toBe(false)
  expect(files.has(ANSWER('d1'))).toBe(false)
  expect(files.has(ANSWER('d2'))).toBe(false)
  // What you typed yourself goes, marked as typed.
  during = undefined
  answers = { [questions[1]!.question]: 'Až po review' }
  await $.tool.call({ tool: 'AskUserQuestion', questions: [questions[1]] } as never)
  expect(readJson(files, ANSWER('w8'))).toMatchObject({ askId: 'b:t:8', text: 'Až po review', typed: true })
  const send = async (session_id: string, message: string) =>
    (await $.tool.call({ tool: 'mcp__ccd_session_mgmt__send_message', session_id, message } as never)) as { deny?: string }
  expect((await send('w8', 'Až po review')).deny).toMatch(/už doručil plugin/)
  await clock.advance(10_000)
  expect(queue().waiting.find(w => w.id === 'w8')).toBeUndefined()
  expect(sent).toEqual([])
  await $.turn.complete({ turnId: 'c1', reason: 'answer', answer: 'Předáno.', durationMs: 1000, isAborted: false })

  // The prompt queued meanwhile runs its turn after this one.
  await $.turn.start({ text: env.prompts.at(-1)?.text ?? '', turnId: 'c2' })
  await $.turn.complete({ turnId: 'c2', reason: 'answer', answer: 'Nic nového.', durationMs: 1000, isAborted: false })
  // "Okno osm" never takes it (its plugin is gone) and still asks the same: put to you again.
  const before = env.prompts.length
  await clock.advance(30_000)
  // (One prompt wakes Centrála; its turn reads the whole queue.)
  expect(env.prompts.length).toBe(before + 1)
  expect(queue().waiting.find(w => w.id === 'w8')).toMatchObject({ delivery: 'plugin' })
})

test('Centrála asks only the window that wants it, not the one it was forked from repeating it', { timeoutMs: 30_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, { text: string; mtime: number }>()
  const sessions = [session('p', 'Rodič'), session('c', 'Fork')]
  put(files, RECORD('p'), { lastAssistantUuid: 'u-p', lastTurnEdgeAt: at(5), lastFocusedAt: at(10) })
  put(files, RECORD('c'), { lastAssistantUuid: 'u-c', lastTurnEdgeAt: at(5), lastFocusedAt: at(10), forkedFromSessionId: 'p' })
  put(files, STATE('p'), state('p', { phase: 'asks', ask: ask('b:t:p', 'Fork čeká: nasadit?', ['Ano']) }))
  put(files, STATE('c'), state('c', { phase: 'asks', ask: ask('b:t:c', 'Nasadit?', ['Ano', 'Ne']) }))
  mockEnv(on, clock, { self: 'Centrála', sessions, files })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.abort', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10_000)
  const queue = () => readJson<{ waiting: { id: string }[] }>(files, `${HOME}/.claude/centrala.json`).waiting.map(w => w.id)
  expect(queue()).toEqual(['c'])
  // The fork got its answer and works on: the parent's question is still about it.
  put(files, STATE('c'), state('c', { phase: 'working', since: clock.now(), beat: clock.now() }))
  await clock.advance(10_000)
  expect(queue()).toEqual([])
  // The fork is done and asks nothing: the parent's own question is yours again.
  put(files, STATE('c'), state('c', { phase: 'done', since: clock.now(), beat: clock.now(), boxed: true, prose: 'Hotovo.' }))
  await clock.advance(10_000)
  expect(queue()).toEqual(['p'])
})

test('Centrála gets what it needs to decide: the context, the buttons\' descriptions, and tasks marked', { timeoutMs: 30_000 }, async ($, on) => {
  const dlg = { questions: [{ question: 'Která?', options: [{ label: 'A', description: 'Rychlejší' }, { label: 'B' }] }] }
  expect(askOfDialog('d', dlg).descriptions).toEqual(['Rychlejší', ''])
  expect(askOfDialog('d', { questions: [{ question: 'Která?', options: [{ label: 'A' }] }] }).descriptions).toBeUndefined()
  const long = 'x'.repeat(1000)
  expect(askOfBox('b', { ask: 'Nasadit?', recap: long, actions: [{ label: 'Ano' }] })?.context).toBe(long)

  const clock = mock.clock(on, { now: NOW })
  const files = new Map<string, { text: string; mtime: number }>()
  const sessions = [session('a', 'Ptá se'), session('t', 'Úkol')]
  put(files, RECORD('a'), { lastAssistantUuid: 'u-a', lastTurnEdgeAt: at(5), lastFocusedAt: at(10) })
  put(files, RECORD('t'), {
    lastAssistantUuid: 'u-t',
    lastTurnEdgeAt: at(5),
    lastFocusedAt: at(10),
    postTurnSummary: { status_category: 'blocked', needs_action: 'zkušební import zipů', summarizes_uuid: 'u-t' },
  })
  put(files, STATE('a'), state('a', { phase: 'dialog', since: at(1), ask: { id: 'd:t:a', text: 'Která?', context: '', options: ['A', 'B'], descriptions: ['Rychlejší', ''] } }))
  put(files, STATE('t'), state('t', { phase: 'done', boxed: false, prose: 'Čekám na tvůj zkušební import obou zipů.' }))
  mockEnv(on, clock, { self: 'Centrála', sessions, files })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.abort', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(10_000)
  type W = { id: string; context: string; descriptions?: string[]; task?: boolean }
  const queue = readJson<{ waiting: W[] }>(files, `${HOME}/.claude/centrala.json`).waiting
  expect(queue.find(w => w.id === 'a')).toMatchObject({ descriptions: ['Rychlejší', ''] })
  expect(queue.find(w => w.id === 'a')?.task).toBeUndefined()
  expect(queue.find(w => w.id === 't')).toMatchObject({ task: true, context: 'Čekám na tvůj zkušební import obou zipů.' })
})
