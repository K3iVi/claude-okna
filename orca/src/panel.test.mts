import { assert, mockHost, mount, test } from 'orca/testing'

import type { Waiting } from './fronta.ts'
import * as panel from './panel.tsx'

const row = (extra: Partial<Waiting>): Waiting => ({
  id: 'orca-claude_a1',
  title: 'Nasazení webu',
  workspaceId: 'r::C:/kod/x',
  kind: 'dialog',
  askId: 'd:1',
  text: 'Nasadit d0e2f81?',
  context: 'Testy prošly.',
  options: ['Ano, nasaď', 'Zatím ne'],
  since: 1,
  ...extra,
})

test('shows the windows waiting and sends the button you press', async () => {
  const sent: unknown[] = []
  const host = mockHost({
    requests: {
      'fronta.get': () => ({ waiting: [row({})], note: '' }),
      'fronta.answer': input => {
        sent.push(input)
        return { ok: true }
      },
      'fronta.open': () => ({ ok: true }),
    },
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Nasadit d0e2f81?' }))
  await view.press({ text: 'Ano, nasaď' })
  assert.deepEqual(sent, [{ id: 'orca-claude_a1', askId: 'd:1', picks: [{ text: 'Ano, nasaď', typed: false }] }])
  await view.post('fronta.changed', { waiting: [], note: '' })
  assert.ok(view.find({ text: 'Nic nečeká' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('"Později" sets a question aside until the window asks anew', async () => {
  const host = mockHost({ requests: { 'fronta.get': () => ({ waiting: [row({})], note: '' }) } })
  const view = await mount(panel, { host })
  await view.press({ label: 'Později' })
  assert.equal(view.find({ text: 'Nasadit d0e2f81?' }), null)
  await view.post('fronta.changed', { waiting: [row({ askId: 'd:2', text: 'Znovu?' })], note: '' })
  assert.ok(view.find({ text: 'Znovu?' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a question with parts sends once every part is picked', async () => {
  const sent: unknown[] = []
  const parts = [{ text: 'Schéma?', options: ['Ano', 'Ne'] }, { text: 'Základ?', options: ['soc1', 'p1'] }]
  const host = mockHost({
    requests: {
      'fronta.get': () => ({ waiting: [row({ options: [], parts, text: '' })], note: '' }),
      'fronta.answer': input => {
        sent.push(input)
        return { ok: true }
      },
    },
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Ano' })
  await view.press({ text: 'p1' })
  await view.press({ text: 'Odeslat' })
  assert.deepEqual(sent, [{ id: 'orca-claude_a1', askId: 'd:1', picks: [{ text: 'Ano', typed: false }, { text: 'p1', typed: false }] }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
