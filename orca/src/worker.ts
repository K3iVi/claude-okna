// Centrála's worker: reads the windows' state files and Orca's agents, keeps the list of questions
// for the panel, and writes your answer into the window's answer file. The Okna plugin inside the
// window takes it within seconds, and only while the window still asks that question.
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'

import { agentsOfPs, answerFor, parseState, waitingOf } from './fronta'
import type { Agent, Waiting, WindowState } from './fronta'

const STATE_DIR = join(homedir(), '.claude', 'okna-stav')
const ANSWER_DIR = join(STATE_DIR, 'odpovedi')
const STATES_MS = 3_000
const AGENTS_MS = 10_000

export type Io = {
  now: () => number
  listStates: () => Promise<{ id: string; text: string }[]>
  writeAnswer: (id: string, text: string) => Promise<void>
  ps: () => Promise<unknown>
}

const nodeIo: Io = {
  now: () => Date.now(),
  async listStates() {
    const names = await readdir(STATE_DIR).catch(() => [] as string[])
    const files = names.filter(n => /^orca-[\w-]+\.json$/.test(n))
    return Promise.all(files.map(async n => ({ id: n.slice(0, -5), text: await readFile(join(STATE_DIR, n), 'utf8').catch(() => '') })))
  },
  async writeAnswer(id, text) {
    await mkdir(ANSWER_DIR, { recursive: true })
    // Written whole, then moved into place: the window never reads half a file.
    const tmp = join(ANSWER_DIR, `${id}.json.tmp`)
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, join(ANSWER_DIR, `${id}.json`))
  },
  ps: () =>
    new Promise((resolve, reject) => {
      const orca = process.env.ORCA_CLI_COMMAND || 'orca'
      execFile(orca, ['worktree', 'ps', '--json'], { timeout: 8_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err)
        else {
          try {
            resolve(JSON.parse(stdout))
          } catch (e) {
            reject(e)
          }
        }
      })
    }),
}

export function createCentrala(orca: OrcaWorkerApi, io: Io = nodeIo) {
  let agents: Agent[] = []
  let states: WindowState[] = []
  let note = ''
  let last = ''
  const pending: Record<string, { askId: string; at: number }> = {}

  const list = (): Waiting[] => waitingOf(states, agents, io.now(), pending)
  // The same without the answers just given: a second press soon after is checked against the question itself.
  const listAll = (): Waiting[] => waitingOf(states, agents, io.now())

  async function readStates() {
    const files = await io.listStates()
    states = files.map(f => parseState(f.text, f.id)).filter((s): s is WindowState => !!s)
  }

  async function readAgents() {
    try {
      agents = agentsOfPs(await io.ps())
      note = ''
    } catch (error) {
      note = `Seznam oken z Orcy se nepodařilo načíst: ${String((error as Error)?.message ?? error).slice(0, 160)}`
    }
  }

  function publish() {
    const waiting = list()
    const key = JSON.stringify([waiting, note])
    if (key === last) return
    last = key
    orca.panels.post('fronta.changed', { waiting, note })
  }

  async function answer(input: { id: string; askId: string; picks: { text: string; typed: boolean }[] }) {
    await readStates()
    const w = listAll().find(x => x.id === input.id)
    // The window moved on since the panel drew it: its question is no longer this one.
    if (!w || w.askId !== input.askId) return { ok: false, reason: 'Okno se mezitím posunulo dál, otázka už neplatí.' }
    const a = answerFor(w, input.picks, io.now())
    if (!a) return { ok: false, reason: 'Tahle odpověď k otázce nesedí.' }
    await io.writeAnswer(w.id, JSON.stringify(a))
    pending[w.id] = { askId: w.askId, at: io.now() }
    publish()
    return { ok: true }
  }

  return {
    readStates,
    readAgents,
    publish,
    answer,
    get: () => ({ waiting: list(), note }),
  }
}

let timers: ReturnType<typeof setInterval>[] = []

export function deactivate(): void {
  for (const t of timers) clearInterval(t)
  timers = []
}

export default function activate(orca: OrcaWorkerApi): void {
  const c = createCentrala(orca)
  const tickStates = async () => {
    await c.readStates().catch(() => undefined)
    c.publish()
  }
  const tickAgents = async () => {
    await c.readAgents()
    await tickStates()
  }
  void tickAgents()
  deactivate()
  timers = [setInterval(() => void tickStates(), STATES_MS), setInterval(() => void tickAgents(), AGENTS_MS)]

  orca.panels.handle('fronta.get', async () => {
    await c.readStates().catch(() => undefined)
    return c.get()
  })
  orca.panels.handle('fronta.answer', async input => c.answer(input))
  orca.panels.handle('fronta.open', async ({ workspaceId }) => {
    if (!workspaceId) return { ok: false }
    await orca.workspace.open({ workspaceId })
    return { ok: true }
  })
}
