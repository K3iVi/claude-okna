// Centrála's worker: reads the windows' state files and Orca's agents, keeps the list of questions
// for the panel, and writes your answer into the window's answer file. The Okna plugin inside the
// window takes it within seconds, and only while the window still asks that question.
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'

import { STALE_MS, agentsOfPs, answerFor, overviewOf, parseState, waitingOf } from './fronta'
import type { Agent, Waiting, WindowState } from './fronta'

const STATE_DIR = join(homedir(), '.claude', 'okna-stav')
const ANSWER_DIR = join(STATE_DIR, 'odpovedi')
const STATES_MS = 3_000
const AGENTS_MS = 10_000

// Orca takes only plain JSON from a worker: a field left undefined (a question without parts) is refused.
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

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
      // The CLI ships beside the app the worker runs in (resources/bin); "orca" on PATH may be the app itself.
      const beside = join(dirname(process.execPath), 'resources', 'bin', process.platform === 'win32' ? 'orca.exe' : 'orca')
      const orca = process.env.ORCA_CLI_COMMAND || (existsSync(beside) ? beside : 'orca')
      // The worker runs in Orca's own Node with a bare environment: without ELECTRON_*/NODE_* (they
      // would make the CLI load the wrong script) and with the folders the CLI finds Orca by.
      const home = homedir()
      const env: Record<string, string> = {
        ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && !/^(ELECTRON_|NODE_)/i.test(e[0]))),
      }
      env.USERPROFILE ??= home
      env.APPDATA ??= join(home, 'AppData', 'Roaming')
      env.LOCALAPPDATA ??= join(home, 'AppData', 'Local')
      env.SystemRoot ??= 'C:\\Windows'
      execFile(orca, ['worktree', 'ps', '--json'], { env, timeout: 8_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        // The CLI answers its own failures as JSON on stdout.
        let why = err?.message ?? ''
        try {
          why = (JSON.parse(stdout) as { error?: { message?: string } }).error?.message ?? why
        } catch {
          // not JSON: the process message stands
        }
        if (err) reject(new Error(why.trim().slice(0, 300)))
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
  let agentsAt = -Infinity
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
      agentsAt = io.now()
      note = ''
    } catch (error) {
      note = `Seznam oken z Orcy se nepodařilo načíst: ${String((error as Error)?.message ?? error).slice(0, 160)}`
    }
  }

  // The overview's times are in whole minutes, so it changes (and is posted) at most once a minute.
  const windows = (waiting: Waiting[]) => overviewOf(agents, waiting.map(w => w.id), io.now())

  function publish() {
    const waiting = list()
    const all = windows(waiting)
    const key = JSON.stringify([waiting, all, note])
    if (key === last) return
    last = key
    orca.panels.post('fronta.changed', plain({ waiting, windows: all, note }))
  }

  // Orca may pause the worker's timers while no panel is open, so a request reads anew whatever is
  // old: a window started meanwhile is missing from the agents read before.
  async function refresh() {
    await readStates().catch(() => undefined)
    const unknown = states.some(st => io.now() - st.beat <= STALE_MS && !agents.some(a => `orca-${a.sessionId}` === st.id))
    if (unknown && io.now() - agentsAt >= AGENTS_MS / 5) await readAgents()
    else if (io.now() - agentsAt >= AGENTS_MS) await readAgents()
  }

  async function answer(input: { id: string; askId: string; picks: { text: string; typed: boolean }[] }) {
    await refresh()
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
    refresh,
    get: () => {
      const waiting = list()
      return plain({ waiting, windows: windows(waiting), note })
    },
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
    await c.refresh()
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
    await c.refresh()
    return c.get()
  })
  orca.panels.handle('fronta.answer', async input => c.answer(input))
  orca.panels.handle('fronta.open', async ({ workspaceId }) => {
    if (!workspaceId) return { ok: false }
    await orca.workspace.open({ workspaceId })
    return { ok: true }
  })
}
