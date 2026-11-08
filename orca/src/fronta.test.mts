import { assert, mockHost, mountWorker, test } from 'orca/testing'

import { agentsOfPs, answerFor, overviewOf, questionOfProse, waitingOf } from './fronta.ts'
import type { WindowState } from './fronta.ts'
import * as main from './worker.ts'
import { createCentrala } from './worker.ts'

const NOW = 1_800_000_000_000
const st = (id: string, extra: Partial<WindowState>): WindowState => ({ v: 1, id, turn: 't1', since: NOW - 60_000, beat: NOW - 5_000, phase: 'done', ...extra })
const PS = {
  result: {
    worktrees: [
      {
        worktreeId: 'r::C:/kod/x',
        repo: 'x',
        agents: [
          { paneKey: 'structured-agent-session-claude_a1:leaf', state: 'waiting', conversationName: 'Nasazení webu', stateStartedAt: NOW - 30_000 },
          { paneKey: 'structured-agent-session-claude_b2:leaf', state: 'done', conversationName: 'Rozbor', updatedAt: NOW - 50 * 60_000 },
          { paneKey: 'term-123', state: 'working' },
        ],
      },
    ],
  },
}

test('agents from orca worktree ps: chats and terminals, titled, with their workspace and since', () => {
  assert.deepEqual(agentsOfPs(PS), [
    { sessionId: 'claude_a1', title: 'Nasazení webu', workspaceId: 'r::C:/kod/x', state: 'waiting', since: NOW - 30_000, chat: true },
    { sessionId: 'claude_b2', title: 'Rozbor', workspaceId: 'r::C:/kod/x', state: 'done', since: NOW - 50 * 60_000, chat: true },
    { sessionId: 'term-123', title: 'x', workspaceId: 'r::C:/kod/x', state: 'working', since: 0, chat: false },
  ])
})

test('the overview: questions above are left out; waiting, cache, working, done and older in that order', () => {
  const a = (id: string, state: string, ago: number) => ({ sessionId: id, title: id, workspaceId: 'w', state, since: NOW - ago, chat: true })
  const rows = overviewOf(
    [a('hotovo', 'done', 5 * 60_000), a('stare', 'done', 3 * 3_600_000), a('prace', 'working', 2 * 60_000), a('cache', 'done', 52 * 60_000), a('blok', 'blocked', 60_000), a('otazka', 'waiting', 1_000)],
    ['orca-otazka'],
    NOW,
  )
  assert.deepEqual(
    rows.map(r => [r.id, r.group, r.label]),
    [
      ['blok', 'blocked', '1 min'],
      ['cache', 'cache', 'za 8 min'],
      ['prace', 'working', '2 min'],
      ['hotovo', 'done', '5 min'],
      ['stare', 'older', '3 h'],
    ],
  )
})

test('a question in closing prose; a plain report asks nothing', () => {
  assert.equal(questionOfProse('Hotovo, testy prošly.\n\nMám to nasadit?'), 'Mám to nasadit?')
  assert.equal(questionOfProse('Commit abc je pushnutý. Hotovo.'), undefined)
  assert.equal(questionOfProse('Dlouhý rozbor.\n\nRozhodni, kterou variantu.'), 'Rozhodni, kterou variantu.')
})

test('what waits: dialogs, prose questions, approvals that stood; stale, unknown, peer and pending ones not', () => {
  const agents = agentsOfPs(PS)
  const ask = { id: 'd:t1:x', text: 'Nasadit?', context: 'Testy prošly.', options: ['Ano', 'Ne'] }
  const states = [
    st('orca-claude_a1', { phase: 'dialog', ask, since: NOW - 30_000 }),
    st('orca-claude_b2', { prose: 'Hotovo.\n\nMám pokračovat?', since: NOW - 90_000 }),
    st('orca-claude_zz', { phase: 'dialog', ask }),
  ]
  const w = waitingOf(states, agents, NOW)
  assert.deepEqual(w.map(x => [x.id, x.kind, x.askId]), [
    ['orca-claude_b2', 'reply', `t:t1:${NOW - 90_000}`],
    ['orca-claude_a1', 'dialog', 'd:t1:x'],
  ])
  assert.equal(waitingOf([{ ...states[0]!, beat: NOW - 200_000 }], agents, NOW).length, 0)
  assert.equal(waitingOf([{ ...states[1]!, peer: true }], agents, NOW).length, 0)
  assert.equal(waitingOf([states[0]!], agents, NOW, { 'orca-claude_a1': { askId: 'd:t1:x', at: NOW - 5_000 } }).length, 0)
  assert.equal(waitingOf([states[0]!], agents, NOW, { 'orca-claude_a1': { askId: 'd:t1:x', at: NOW - 30_000 } }).length, 1)
  const approval = st('orca-claude_a1', { phase: 'approval', approval: { tool: 'Bash', summary: 'deploy' }, since: NOW - 20_000 })
  assert.equal(waitingOf([approval], agents, NOW)[0]?.kind, 'approval')
  assert.equal(waitingOf([{ ...approval, since: NOW - 5_000 }], agents, NOW).length, 0)
})

test('answers: a button, your own words, all parts or nothing; a prose reply is always typed', () => {
  const agents = agentsOfPs(PS)
  const parts = [{ text: 'A?', options: ['1', '2'] }, { text: 'B?', options: ['x'] }]
  const [dialog] = waitingOf([st('orca-claude_a1', { phase: 'dialog', ask: { id: 'd:1', text: '', context: '', options: [], parts } })], agents, NOW)
  assert.deepEqual(answerFor(dialog!, [{ text: '1', typed: false }, { text: 'jinak', typed: true }], NOW), {
    askId: 'd:1',
    text: '1) 1 2) jinak',
    typed: true,
    at: NOW,
    parts: [{ text: '1', typed: false }, { text: 'jinak', typed: true }],
  })
  assert.equal(answerFor(dialog!, [{ text: '1', typed: false }], NOW), undefined)
  const [reply] = waitingOf([st('orca-claude_b2', { prose: 'Mám pokračovat?' })], agents, NOW)
  assert.deepEqual(answerFor(reply!, [{ text: 'Ano', typed: false }], NOW), { askId: reply!.askId, text: 'Ano', typed: true, at: NOW })
  assert.equal(answerFor(reply!, [{ text: '  ', typed: true }], NOW), undefined)
})

test('the worker writes the answer only for the question asked now, then hides it a while', async () => {
  let now = NOW
  const written: Record<string, string> = {}
  let files = [{ id: 'orca-claude_a1', text: JSON.stringify(st('orca-claude_a1', { phase: 'dialog', ask: { id: 'd:t1:x', text: 'Nasadit?', context: '', options: ['Ano'] } })) }]
  const posts: unknown[] = []
  const orca = { panels: { post: (_: string, p: unknown) => posts.push(p) } } as never
  const c = createCentrala(orca, {
    now: () => now,
    listStates: async () => files,
    writeAnswer: async (id, text) => void (written[id] = text),
    ps: async () => PS,
  })
  await c.readAgents()
  await c.readStates()
  assert.equal(c.get().waiting.length, 1)
  assert.deepEqual(await c.answer({ id: 'orca-claude_a1', askId: 'd:old', picks: [{ text: 'Ano', typed: false }] }), {
    ok: false,
    reason: 'Okno se mezitím posunulo dál, otázka už neplatí.',
  })
  assert.deepEqual(written, {})
  assert.deepEqual(await c.answer({ id: 'orca-claude_a1', askId: 'd:t1:x', picks: [{ text: 'Ano', typed: false }] }), { ok: true })
  assert.deepEqual(JSON.parse(written['orca-claude_a1']!), { askId: 'd:t1:x', text: 'Ano', typed: false, at: NOW })
  assert.equal(c.get().waiting.length, 0)
  now += 25_000
  assert.equal(c.get().waiting.length, 1)
  files = []
  await c.readStates()
  assert.equal(c.get().waiting.length, 0)
})

test('the worker starts and answers the panel', async () => {
  const host = mockHost({})
  const worker = await mountWorker(main, { host })
  const got = (await worker.request('fronta.get')) as { waiting: unknown[] }
  assert.ok(Array.isArray(got.waiting))
  await worker.deactivate()
})
