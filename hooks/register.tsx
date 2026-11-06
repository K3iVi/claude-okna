import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, SvgProps } from 'claude-code'

import type { RemotePc, Row } from '../types'
import { startsAnyTurn, turnEnding } from './transcript'
import type { BoxQuestion, TurnEnding } from './transcript'
import {
  ANSWER_DIR,
  APPROVAL_SHOW_MS,
  BEAT_MS,
  STATE_DIR,
  STATE_VERSION,
  acceptsAnswer,
  askOfBox,
  askOfDialog,
  dialogResult,
  isTrusted,
  joinParts,
  parseAnswer,
  parseState,
  proseTail,
} from './stav'
import type { Answer, Ask, PartAnswer, Phase, WindowState } from './stav'

// Written into this window's state file: the readers know which rules wrote it.
const PLUGIN_VERSION = '0.9.3'
// Centrála puts a question to you once it has stood this long: one you answer in its window
// right away never shows up there.
const CENTRAL_DELAY_MS = 10_000
const ANSWER_CHECK_MS = 3_000

const PANE = 'okna'
const TITLE = 'Okna'
const POLL_MS = 10_000
const MAX_AGE_DAYS = 7
const SESSIONS = 'ccd_session_mgmt'
const EARLIER_MAX_ROWS = 15
const CACHE_TTL_MS = 3_600_000
const CACHE_WARN_MIN = 15
// A question you have seen and left for a day stops counting as waiting.
const WAIT_EXPIRE_MS = 24 * 3_600_000
// Optional settings in ~/.claude/okna.json (see README): your own server for the other PCs,
// its key, and window titles never to list. Without the file the panel shows this PC alone.
const CONFIG_FILE = '.claude/okna.json'
const LEGACY_SYNC_FILE = '.claude/okna-sync.json'
type Config = { sync?: { url?: string; key?: string }; hideTitles?: string[]; central?: string }

// The central window ("Centrála"): the window you answer the others' questions from. Its own
// copy of the plugin tells it of each new question; it reads them, with the asking window's own
// buttons, from QUEUE_FILE. Its title is matched by this pattern, or by okna.json "central".
const CENTRAL_TITLE = '^centr[áa]la'
const QUEUE_FILE = '.claude/centrala.json'
// Night mode, switched on from the central window: {"od": ISO, "do": ISO}. Until "do" the central
// window is not woken by questions; once it passes, it is woken once for the morning summary.
const NIGHT_FILE = '.claude/noc.json'
const RC_LINK = /^claude:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}$/

const rowsAtom = atom({ plugin: 'okna', key: 'rows' } as const, [] as Row[])
const infoAtom = atom({ plugin: 'okna', key: 'info' } as const, '')
const remoteAtom = atom({ plugin: 'okna', key: 'remote' } as const, [] as RemotePc[])
const syncAtom = atom({ plugin: 'okna', key: 'sync' } as const, '')
const openAtom = atom({ plugin: 'okna', key: 'open' } as const, {} as Record<string, boolean>)
const barAtom = atom({ plugin: 'okna', key: 'bar' } as const, false)

// Deferred windows, by the reply they had then: this PC's by turn, another PC's by activity.
type Deferred = Record<string, string>
const deferMark = (row: Row) => row.turn || row.lastActivityAt

type Session = {
  sessionId: string
  title: string
  link?: string
  isArchived: boolean
  isRunning: boolean
  lastActivityAt: string
  remoteControlActive?: boolean
}

// How a window's last turn ended, by its last reply (`key`, lastAssistantUuid): 'replied' with its
// box's question (`ask`), whether it closed on a box at all and the prose guess; 'answered' when
// something came after it; 'unknown' (read at `at`) when the transcript did not show it yet.
type Ending = {
  key: string
  state: 'replied' | 'answered' | 'unknown'
  ask: BoxQuestion | null
  boxed: boolean
  guess: { waiting: boolean; snippet: string }
  at?: number
  // The sizes of the transcripts it was read from: one that grew is read again.
  mark?: string
}
const UNKNOWN_RETRY_MS = 60_000
// The prose guess for a window without a record, by reply time.
type Verdict = { at: string; waiting: boolean; snippet: string }

// One poll serves every window: the window that polls leaves the result in the
// plugin's store, and the others draw it while it is fresh. list_sessions leaves out
// the window that asks, so the poll adds that window itself, and each window drops its own row.
type Snapshot = { at: number; rows: Row[]; info: string; remote?: RemotePc[]; sync?: string }

// When each window last replied, by its reply: a compact or the app's housekeeping
// moves the window's times but not its reply, so neither counts as work.
type Replies = Record<string, { turn: string; at: number }>

let inFlight: { force: boolean; done: Promise<Row[] | undefined> } | undefined

// This window's own id and title; '' until known.
let selfId = ''
let selfTitle = ''

async function findSelf($: EngineInterface): Promise<Session | undefined> {
  const res = await $.mcp.call(SESSIONS, 'get_session', { session_id: 'self' })
  if (res.isError) return undefined
  const self = JSON.parse(textOf(res)) as Session
  selfId = self.sessionId
  selfTitle = self.title ?? ''
  return self
}

async function centralTitle($: EngineInterface): Promise<RegExp> {
  try {
    return new RegExp((await readConfig($)).central || CENTRAL_TITLE, 'i')
  } catch {
    return new RegExp(CENTRAL_TITLE, 'i')
  }
}

const isCentral = async ($: EngineInterface) => selfTitle !== '' && (await centralTitle($)).test(selfTitle)

const notSelf = (rows: Row[]) => rows.filter(r => r.id !== selfId)

const WAIT_RE =
  /(?<!\p{L})(nasaď|schválíš|schválit|tvoje ok|tvé ok|čekám na tebe|čeká na tebe|potřebuju od tebe|potřebuji od tebe|rozhodni|vyber si|mám to udělat|mám pokračovat)(?!\p{L})/iu

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
}

// Last assistant prose of the transcript tail list_events renders, or '' when the
// tail holds only tool calls.
function lastAssistantText(transcript: string): string {
  const parts = transcript.split(/\n(?=\[(?:assistant|user|result)\])/)
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = (parts[i] ?? '').trim()
    if (part.startsWith('[user]')) return ''
    if (part.startsWith('[assistant]') && !part.startsWith('[assistant] (called')) {
      return part.slice('[assistant]'.length).trim()
    }
  }
  return ''
}

function classify(text: string): { waiting: boolean; snippet: string } {
  if (!text) return { waiting: false, snippet: '' }
  const lines = text
    .split('\n')
    .map(line => line.replace(/^[-*>#\s]+/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    // The closing commit/push status lines say nothing about what is asked.
    // (Not \b: it is ASCII-only and finds no edge after the "é" of these words.)
    .filter(line => !/^(necommitnuté|nepushnuté|uncommitted|unpushed)(?!\p{L})/iu.test(line))
  // Only the closing lines count: a question quoted mid-reply is not one for you.
  const closing = lines.slice(-3)
  const waiting = closing.some(line => /\?$/.test(line) || WAIT_RE.test(line))
  const pick = closing.slice().reverse().find(line => line.includes('?')) ?? closing[closing.length - 1] ?? ''
  return { waiting, snippet: pick.length > 160 ? `${pick.slice(0, 157)}…` : pick }
}

function age(iso: string, now: number): string {
  if (Number.isNaN(Date.parse(iso))) return ''
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (min < 60) return `${min} min`
  const hours = Math.round(min / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} d`
}

// The app keeps a record per window, Claude-Data/claude_*/claude-code-sessions/<account>/<org>/local_<id>.json,
// holding the app's own verdict on the last turn (postTurnSummary, 'blocked' when it wants
// you) and lastFocusedAt (the sidebar's unread dot). Its turnWrapUp holds only the recap,
// never the question. Not a published interface: read defensively, fall back when absent.
type AppRecord = {
  postTurnSummary?: { status_category?: string; status_detail?: string; needs_action?: string; summarizes_uuid?: string } | null
  lastAssistantUuid?: string
  lastFocusedAt?: number
  // When the window's last turn ended (a compact's too). The app's lastActivityAt also moves
  // on its own housekeeping writes, hours after the last turn, so it says nothing of your work.
  lastTurnEdgeAt?: number
  // Remote Control sessions of the window, the current one last.
  bridgeSessionIds?: string[]
  // The CLI session behind the window and the folders it ran in: they name its transcript folder.
  cliSessionId?: string
  // The CLI session of the last reply: after /clear or a resume the transcript goes on in a new file.
  lastAssistantCliSessionId?: string
  cwd?: string
  originCwd?: string
  // The window it was forked or started from: told by the app when this one waits on you.
  spawnedFrom?: { sessionId?: string } | null
  forkedFromSessionId?: string
}

// A window whose turn has ended can still be working: subagents it left running in the
// background write their transcripts, ~/.claude/projects/<folder>/<cliSessionId>/subagents/*.jsonl,
// while the app already counts the window as idle. A write within this long counts as work.
const BACKGROUND_MS = 90_000

let projectsDir: string | undefined

// The window's CLI sessions, the current one first, each with the project folders it may sit in.
// The CLI names a project's folder after its path, every character but letters and digits a dash.
function cliFiles(record: AppRecord): { folder: string; cli: string }[] {
  const clis = [...new Set([record.lastAssistantCliSessionId, record.cliSessionId])].filter((c): c is string => !!c && UUID.test(c))
  const folders = [...new Set([record.cwd, record.originCwd].filter((c): c is string => !!c))].map(c => c.replace(/[^A-Za-z0-9]/g, '-'))
  return clis.flatMap(cli => folders.map(folder => ({ folder, cli })))
}

async function worksInBackground($: EngineInterface, record: AppRecord | undefined, now: number): Promise<boolean> {
  if (!record) return false
  try {
    projectsDir ??= `${await envVar($, 'USERPROFILE')}/.claude/projects`
    for (const { folder, cli } of cliFiles(record)) {
      const dir = `${projectsDir}/${folder}/${cli}/subagents`
      if (!(await $.fs.exists(dir))) continue
      if ((await $.fs.list(dir)).some(f => f.name.endsWith('.jsonl') && now - f.mtimeMs < BACKGROUND_MS)) return true
    }
  } catch {
    // Unreadable: the app's own state stands.
  }
  return false
}

let recordDirs: string[] | undefined

async function findRecordDirs($: EngineInterface): Promise<string[]> {
  if (recordDirs) return recordDirs
  const dirs: string[] = []
  try {
    const { stdout } = await $.process.run(['cmd', '/c', 'echo %LOCALAPPDATA%'])
    const base = `${stdout.trim()}/Claude-Data`
    for (const profile of await $.fs.list(base)) {
      if (profile.kind !== 'dir' || !profile.name.startsWith('claude_')) continue
      const root = `${base}/${profile.name}/claude-code-sessions`
      if (!(await $.fs.exists(root))) continue
      for (const account of await $.fs.list(root)) {
        if (account.kind !== 'dir') continue
        for (const org of await $.fs.list(`${root}/${account.name}`)) {
          if (org.kind === 'dir') dirs.push(`${root}/${account.name}/${org.name}`)
        }
      }
    }
  } catch {
    // No records found: every window falls back to the transcript.
  }
  // Kept only when found, so a failed look is tried again at the next poll.
  if (dirs.length) recordDirs = dirs
  return dirs
}

async function readRecord($: EngineInterface, dirs: string[], id: string): Promise<AppRecord | undefined> {
  for (const dir of dirs) {
    const path = `${dir}/${id}.json`
    if (!(await $.fs.exists(path))) continue
    try {
      return JSON.parse((await $.fs.read(path)) as string) as AppRecord
    } catch {
      return undefined
    }
  }
  return undefined
}

async function envVar($: EngineInterface, name: string): Promise<string> {
  const { stdout } = await $.process.run(['cmd', '/c', `echo %${name}%`])
  return stdout.trim()
}

// The settings file, read once per load; {} while it is missing or unreadable.
let config: Config | undefined

async function readConfig($: EngineInterface): Promise<Config> {
  if (config) return config
  try {
    const home = await envVar($, 'USERPROFILE')
    const path = `${home}/${CONFIG_FILE}`
    config = (await $.fs.exists(path)) ? (JSON.parse((await $.fs.read(path)) as string) as Config) : {}
    // Up to 0.5 the server sat alone in okna-sync.json ({url, key}); still read when okna.json has none.
    const legacy = `${home}/${LEGACY_SYNC_FILE}`
    if (!config.sync && (await $.fs.exists(legacy))) {
      config = { ...config, sync: JSON.parse((await $.fs.read(legacy)) as string) as Config['sync'] }
    }
  } catch {
    config = {}
  }
  return config
}

// Titles never listed (regular expressions, case-insensitive), e.g. a scheduled task's windows.
async function hiddenTitles($: EngineInterface): Promise<RegExp[]> {
  const out: RegExp[] = []
  for (const source of (await readConfig($)).hideTitles ?? []) {
    try {
      out.push(new RegExp(source, 'i'))
    } catch {
      // A broken pattern hides nothing.
    }
  }
  return out
}

// This PC's name, the server and its key; null (no syncing) without both in the settings.
let syncSetup: { pc: string; url: string; key: string } | null | undefined

async function findSync($: EngineInterface): Promise<{ pc: string; url: string; key: string } | null> {
  if (syncSetup !== undefined) return syncSetup
  try {
    const { url = '', key = '' } = (await readConfig($)).sync ?? {}
    syncSetup = /^https:\/\//.test(url) && key ? { pc: await envVar($, 'COMPUTERNAME'), url: url.replace(/\/+$/, ''), key } : null
  } catch {
    syncSetup = null
  }
  return syncSetup
}

type SentRow = Pick<Row, 'title' | 'isRunning' | 'waiting' | 'unread' | 'snippet' | 'lastActivityAt' | 'rcLink'>

// Sends this PC's windows and answers the other PCs' as the server has them. A window
// you opened from here counts as read here, whatever its own PC last saw.
async function exchange($: EngineInterface, rows: Row[]): Promise<RemotePc[]> {
  const setup = await findSync($)
  if (!setup) return []
  const sent: SentRow[] = rows.slice(0, 80).map(r => ({
    title: r.title.slice(0, 300),
    isRunning: r.isRunning,
    waiting: r.waiting,
    unread: r.unread,
    snippet: r.snippet.slice(0, 400),
    lastActivityAt: r.lastActivityAt,
    rcLink: r.rcLink,
  }))
  const res = await $.http.fetch(`${setup.url}/${encodeURIComponent(setup.pc)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${setup.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: sent }),
  })
  if (!res.ok) throw new Error(`server odpověděl ${res.status}`)
  const pcs = (JSON.parse(res.text) as { pcs: { pc: string; at: number; rows: SentRow[] }[] }).pcs
  const seen = ((await $.store.get('remote-seen')) as Record<string, string> | undefined) ?? {}
  const hidden = ((await $.store.get('hidden')) as Record<string, string> | undefined) ?? {}
  const deferred = ((await $.store.get('deferred')) as Deferred | undefined) ?? {}
  return pcs
    .filter(p => p.rows.length)
    .map(p => ({
      pc: p.pc,
      at: p.at,
      rows: p.rows
        .map(r => {
          const id = `${p.pc}|${r.title}`
          const rcLink = RC_LINK.test(r.rcLink) ? r.rcLink : ''
          return {
            ...r,
            id,
            link: rcLink,
            rcLink,
            rc: rcLink !== '',
            unread: r.unread && seen[id] !== r.lastActivityAt,
            turn: '',
            deferred: !r.isRunning && deferred[id] === r.lastActivityAt,
          }
        })
        .filter(r => hidden[r.id] !== r.lastActivityAt),
    }))
}

// One poll at a time: two at once would read every transcript twice. A poll asked for while one
// runs gets that one's rows; a forced one (by this version's rules, not the shared snapshot)
// runs again after an ordinary one.
async function refresh($: EngineInterface, force = false): Promise<Row[] | undefined> {
  while (inFlight) {
    const running = inFlight
    const rows = await running.done
    if (running.force || !force) return rows
  }
  const done: Promise<Row[] | undefined> = poll($, force).finally(() => {
    if (inFlight?.done === done) inFlight = undefined
  })
  inFlight = { force, done }
  return done
}

async function poll($: EngineInterface, force: boolean): Promise<Row[] | undefined> {
    try {
      // The central window polls with its pane closed too: it is told of each new question.
      if (!(await $.ui.panes()).some(pane => pane.id === PANE) && !(await isCentral($))) return
      // The folded sections as last opened or closed in any window.
      const open = (await $.store.get('open')) as Record<string, boolean> | undefined
      if (open) await update($, openAtom, () => open)
      const snapshot = (await $.store.get('snapshot')) as Snapshot | undefined
      // Fresh, or another window is polling right now: draw what the store has.
      const polling = ((await $.store.get('polling')) as number | undefined) ?? 0
      const nowAtStart = await $.clock.now()
      const isFresh = snapshot && nowAtStart - snapshot.at < POLL_MS - 2_000
      if (!force && snapshot && (isFresh || nowAtStart - polling < POLL_MS - 2_000)) {
        if (!selfId) await findSelf($)
        await update($, rowsAtom, () => notSelf(snapshot.rows))
        await update($, infoAtom, () => snapshot.info)
        await update($, remoteAtom, () => snapshot.remote ?? [])
        await update($, syncAtom, () => snapshot.sync ?? '')
        return
      }
      // A lock, not a result: a failed poll leaves the snapshot stale, so the next window polls again.
      await $.store.set('polling', nowAtStart)
      tailReads = 0
      const listed = await $.mcp.call(SESSIONS, 'list_sessions', { limit: 40 })
      if (listed.isError) {
        await update($, infoAtom, () => `Seznam oken nejde načíst: ${textOf(listed).slice(0, 200)}`)
        return
      }
      const self = await findSelf($)
      const now = await $.clock.now()
      const hiddenTitle = [...(await hiddenTitles($)), await centralTitle($)]
      const sessions = [...(JSON.parse(textOf(listed)) as Session[]), ...(self ? [self] : [])].filter(
        s => !s.isArchived && !hiddenTitle.some(re => re.test(s.title)),
      )

      const dirs = await findRecordDirs($)
      const verdicts = ((await $.store.get('verdicts-v3')) as Record<string, Verdict> | undefined) ?? {}
      const endings = ((await $.store.get('endings-v5')) as Record<string, Ending> | undefined) ?? {}
      // Windows you hid, by the activity they had then: new activity brings them back.
      const hidden = ((await $.store.get('hidden')) as Record<string, string> | undefined) ?? {}
      const deferred = ((await $.store.get('deferred')) as Deferred | undefined) ?? {}
      const replies = ((await $.store.get('replies')) as Replies | undefined) ?? {}
      // Each window's activity as the rows show it: now while running, else its last reply.
      const activity: Record<string, string> = {}
      const rows: Row[] = []
      for (const s of sessions) {
        // What the window wrote of itself (0.9): believed while fresh and in step with the app; else
        // (an older plugin there, a hook that failed) the transcript decides, as before.
        const stated = await readState($, s.sessionId)
        const record = s.isRunning && !stated ? undefined : await readRecord($, dirs, s.sessionId)
        const st = stated && isTrusted(stated, now, record?.lastTurnEdgeAt) ? stated : undefined
        // A permission prompt up a while: shown as waiting (only in the window can you answer it).
        const approving = st?.phase === 'approval' && now - st.since >= APPROVAL_SHOW_MS
        // The window's own word on whether it works (the app's "running" is not always right); a
        // question the file holds while the app sees work is not believed (a turn's start was missed).
        const running = st
          ? (st.phase === 'working' || (st.phase === 'approval' && !approving) || (s.isRunning && st.phase !== 'dialog' && !approving))
          : s.isRunning
        const turn = record?.lastAssistantUuid ?? ''
        if (!running) {
          const edge = record?.lastTurnEdgeAt || Date.parse(s.lastActivityAt)
          if (!turn || replies[s.sessionId]?.turn !== turn) replies[s.sessionId] = { turn, at: edge }
        }
        const repliedAt =
          st && (st.phase === 'dialog' || approving)
            ? st.since
            : running
              ? Math.max(st?.since ?? 0, Date.parse(s.lastActivityAt) || 0)
              : (replies[s.sessionId]?.at ?? 0)
        const act = new Date(repliedAt).toISOString()
        activity[s.sessionId] = act
        if (now - repliedAt > MAX_AGE_DAYS * 86_400_000) continue
        if (hidden[s.sessionId] === act) continue
        let waiting = false
        let snippet = ''
        let question: BoxQuestion | undefined
        let askId: string | undefined
        let approval: string | undefined
        if (!running) {
          // How the last turn closed: from the window's own file, else from its transcript (read once
          // per reply); and the app's verdict on it (the one its sidebar goes by; often never written).
          // A row with a `question` is one Centrála may show.
          const summary = record?.postTurnSummary
          const fits = !!summary?.status_category && summary.summarizes_uuid === record?.lastAssistantUuid
          const blocked = fits && summary?.status_category === 'blocked'
          const fallback = 'Okno čeká na tvou odpověď.'
          const ending = st ? undefined : await endingOf($, record, turn, endings, s.sessionId)
          if (approving && st?.approval) {
            waiting = true
            approval = `${st.approval.tool}${st.approval.summary ? `: ${st.approval.summary}` : ''}`
            snippet = `Možná čeká na schválení — ${approval}`
          } else if (st && (st.phase === 'asks' || st.phase === 'dialog') && st.ask) {
            // The window says what it asks, and that nothing has come since.
            waiting = true
            question = {
              text: st.ask.text,
              context: st.ask.context,
              options: st.ask.options,
              ...(st.ask.parts?.length ? { parts: st.ask.parts } : {}),
            }
            askId = st.ask.id
          } else if (st) {
            // Its turn ended without a question in a box (or was broken off).
            if (st.aborted) {
              // You broke it off: nothing asked waits.
            } else if (blocked) {
              waiting = true
              question = { text: summary?.needs_action || summary?.status_detail || fallback, context: '', options: [] }
            } else if (!fits && !st.boxed) {
              const guess = classify(st.prose ?? '')
              waiting = guess.waiting
              if (waiting) question = { text: guess.snippet || fallback, context: '', options: [] }
            }
          } else if (ending?.state === 'answered') {
            // Something came after its last reply: on its way, nothing it asked waits.
          } else if (ending?.state === 'replied' && ending.ask) {
            waiting = true
            question = ending.ask
          } else if (blocked) {
            waiting = true
            // Centrála gets it only once the transcript shows nothing came after that reply: the
            // app's verdict does not say so, nor is its "running" always right.
            if (ending?.state === 'replied') {
              question = { text: summary?.needs_action || summary?.status_detail || fallback, context: '', options: [] }
            } else {
              snippet = summary?.needs_action || summary?.status_detail || fallback
            }
          } else if (fits || (ending?.state === 'replied' && ending.boxed)) {
            // The app or the window's own box says nothing waits.
          } else if (ending?.state === 'replied') {
            // Neither says: guess from the window's closing words.
            waiting = ending.guess.waiting
            if (waiting) question = { text: ending.guess.snippet || fallback, context: '', options: [] }
          } else {
            // No transcript to read: guess from the closing lines the app renders.
            if (verdicts[s.sessionId]?.at !== act) {
              const events = await $.mcp.call(SESSIONS, 'list_events', { session_id: s.sessionId, limit: 8 })
              const transcript = events.isError ? '' : textOf(events)
              const endsInBox = /\[assistant\] \(called mcp__ccd_turn__wrap_up\)\s*(\n\[result\][^\n]*\s*)?$/.test(transcript)
              const verdict = endsInBox
                ? { waiting: true, snippet: 'Otázka je v rámečku „Další krok“ v okně' }
                : classify(lastAssistantText(transcript))
              verdicts[s.sessionId] = { at: act, ...verdict }
            }
            waiting = verdicts[s.sessionId]?.waiting ?? false
            snippet = verdicts[s.sessionId]?.snippet ?? ''
          }
          if (question) snippet = question.text
        }
        // Seen since the reply and left a day: you have decided it can wait.
        const seen = record?.lastFocusedAt !== undefined && record.lastFocusedAt > repliedAt
        if (waiting && seen && now - repliedAt > WAIT_EXPIRE_MS) {
          waiting = false
          snippet = ''
          question = undefined
        }
        // Unread: a reply since you last had the window in front (a compact is not one).
        const unread = !running && record?.lastFocusedAt !== undefined && !seen
        const bridge = s.remoteControlActive
          ? (record ?? (await readRecord($, dirs, s.sessionId)))?.bridgeSessionIds
          : undefined
        const rcLink = bridge?.length ? `claude://claude.ai/code/${bridge[bridge.length - 1]}` : ''
        // Its turn over but subagents still at work: working, unless it asked you something.
        const background = !running && !waiting && (await worksInBackground($, record, now))
        const parent = record?.spawnedFrom?.sessionId || record?.forkedFromSessionId
        rows.push({
          ...(typeof parent === 'string' && parent ? { parent } : {}),
          turn,
          deferred: !running && deferred[s.sessionId] === (turn || act),
          id: s.sessionId,
          title: s.title,
          link: s.link ?? '',
          isRunning: running || background,
          lastActivityAt: act,
          waiting: !running && waiting,
          snippet,
          ...(question && waiting && !running ? { question } : {}),
          ...(askId && question && waiting && !running ? { askId } : {}),
          ...(approval && waiting ? { approval } : {}),
          unread: unread && !background,
          rc: s.remoteControlActive ?? false,
          rcLink: RC_LINK.test(rcLink) ? rcLink : '',
        })
      }
      const live = new Set(sessions.map(s => s.sessionId))
      await $.store.set('verdicts-v3', Object.fromEntries(Object.entries(verdicts).filter(([id]) => live.has(id))))
      await $.store.set('endings-v5', Object.fromEntries(Object.entries(endings).filter(([id]) => live.has(id))))
      await $.store.set('replies', Object.fromEntries(Object.entries(replies).filter(([id]) => live.has(id))))
      // Read again: a click to hide or defer while this poll ran must not be lost.
      const hiddenNow = ((await $.store.get('hidden')) as Record<string, string> | undefined) ?? {}
      const deferredNow = ((await $.store.get('deferred')) as Deferred | undefined) ?? {}
      await $.store.set('hidden', {
        // Another PC's windows ('PC|title') stay hidden until that window moves; this PC's until gone.
        ...Object.fromEntries(Object.entries(hiddenNow).filter(([id]) => id.includes('|')).slice(-200)),
        ...Object.fromEntries(
          sessions
            .filter(s => hiddenNow[s.sessionId] === activity[s.sessionId])
            .map(s => [s.sessionId, activity[s.sessionId]]),
        ),
      })
      for (const r of rows) r.deferred = !r.isRunning && deferredNow[r.id] === deferMark(r)
      await $.store.set('deferred', {
        // Another PC's windows stay deferred by title; this PC's until you write into them. A running
        // window may be only compacting, so it keeps its mark until the turn shows whether it replied.
        ...Object.fromEntries(Object.entries(deferredNow).filter(([id]) => id.includes('|')).slice(-200)),
        ...Object.fromEntries(
          rows.filter(r => deferredNow[r.id] !== undefined && (r.isRunning || r.deferred)).map(r => [r.id, deferredNow[r.id]]),
        ),
      })
      rows.splice(0, rows.length, ...rows.filter(r => hiddenNow[r.id] !== r.lastActivityAt))
      let remote = snapshot?.remote ?? []
      let sync = ''
      try {
        remote = await exchange($, rows)
      } catch (error) {
        sync = `Druhé PC: ${String(error).slice(0, 120)}`
      }
      await update($, rowsAtom, () => notSelf(rows))
      await update($, infoAtom, () => '')
      await update($, remoteAtom, () => remote)
      await update($, syncAtom, () => sync)
      await $.store.set('snapshot', { at: await $.clock.now(), rows, info: '', remote, sync })
      return rows
    } catch (error) {
      await update($, infoAtom, () => `Chyba: ${String(error).slice(0, 200)}`)
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Reads the last 80 lines of a transcript. A line over 200 kB (a screenshot, a pasted image) is
// cut to what the reading needs: a prompt's origin and whether it is a tool's result; a reply's uuid.
const TAIL_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Get-Content -LiteralPath $Path -Tail 80 -Encoding UTF8 | ForEach-Object {',
  '  if ($_.Length -le 200000) { return $_ }',
  '  $h = $_.Substring(0, 600)',
  '  $t = $_.Substring($_.Length - 3000)',
  `  if ($h.Contains('"type":"user","message"')) {`,
  `    $o = [regex]::Match($t, '"origin":\\{"kind":"([a-z-]+)"').Groups[1].Value`,
  `    $m = if ($t.Contains('"isMeta":true')) { 'true' } else { 'false' }`,
  `    $c = if ($h.Contains('"tool_use_id"')) { '[{"type":"tool_result"}]' } else { '[{"type":"text","text":"[...]"}]' }`,
  `    $g = if ($o) { ',"origin":{"kind":"' + $o + '"}' } else { '' }`,
  `    return '{"type":"user","isMeta":' + $m + $g + ',"message":{"content":' + $c + '}}'`,
  '  }',
  `  if ($t.Contains('"type":"assistant"')) {`,
  `    $u = [regex]::Match($t, '"uuid":"([0-9a-f-]{36})"').Groups[1].Value`,
  `    return '{"type":"assistant","huge":true,"uuid":"' + $u + '","message":{"content":[]}}'`,
  '  }',
  '}',
].join('\n')

// PowerShell's -EncodedCommand: the script as UTF-16LE in base64, so no quoting can break it.
function encodedCommand(script: string): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bytes.push(c & 0xff, c >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + (i + 1 < bytes.length ? abc[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? abc[n & 63]! : '=')
  }
  return out
}

// The last lines of one of the window's transcripts (~/.claude/projects/<folder>/<cli>.jsonl).
// Transcripts run to 500+ MB, so PowerShell reads only the tail.
// Undefined when there is none or the output was cut: nothing to go by.
async function transcriptTail($: EngineInterface, record: AppRecord, cli: string): Promise<string[] | undefined> {
  const path = await transcriptPath($, record, cli)
  if (path) {
    tailReads++
    const script = `$Path = '${path.replace(/'/g, "''")}'\n${TAIL_SCRIPT}`
    const run = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(script)])
    if (run.exitCode !== 0 || run.isStdoutTruncated) return undefined
    return run.stdout.split(/\r?\n/)
  }
  return undefined
}

async function transcriptPath($: EngineInterface, record: AppRecord, cli: string): Promise<string | undefined> {
  projectsDir ??= `${await envVar($, 'USERPROFILE')}/.claude/projects`
  for (const file of cliFiles(record).filter(f => f.cli === cli)) {
    const path = `${projectsDir}/${file.folder}/${file.cli}.jsonl`
    if (await $.fs.exists(path)) return path
  }
  return undefined
}

// The sizes of the window's transcripts, cheap to take: a reading of them holds while they stay.
async function transcriptMark($: EngineInterface, record: AppRecord): Promise<string> {
  const sizes: string[] = []
  for (const cli of new Set([record.lastAssistantCliSessionId || record.cliSessionId, record.cliSessionId])) {
    const path = cli ? await transcriptPath($, record, cli) : undefined
    sizes.push(path ? String((await $.fs.stat(path).catch(() => undefined))?.size ?? '?') : '-')
  }
  return sizes.join(':')
}

// How the window's turn of its last reply `turn` ended. After /clear the window goes on in a new
// CLI session: anything that starts a turn there means you have moved on from that reply.
async function readTurn($: EngineInterface, record: AppRecord, turn: string): Promise<TurnEnding> {
  const last = record.lastAssistantCliSessionId || record.cliSessionId
  try {
    if (record.cliSessionId && last && record.cliSessionId !== last) {
      const newer = await transcriptTail($, record, record.cliSessionId)
      if (newer && startsAnyTurn(newer)) return { state: 'answered' }
    }
    const tail = last ? await transcriptTail($, record, last) : undefined
    return tail ? turnEnding(tail, turn) : { state: 'unknown' }
  } catch {
    return { state: 'unknown' }
  }
}

// Transcripts read per poll: the first poll after a load has every window to read, ~1 s each.
const TAIL_READS_PER_POLL = 6
let tailReads = 0

// How the window's last turn ended (see turnEnding), kept per window for its last reply.
// Undefined while unknown: nothing in the transcript to go by yet.
async function endingOf(
  $: EngineInterface,
  record: AppRecord | undefined,
  turn: string,
  endings: Record<string, Ending>,
  id: string,
): Promise<Ending | undefined> {
  if (!record || !turn) return undefined
  const now = await $.clock.now()
  const cached = endings[id]
  // An idle window can move on without a new reply (a prompt you broke off, a message that did
  // not run): a reply read as asking holds only while its transcripts stay as they were read.
  const known = cached?.key === turn && cached.state === 'replied' ? cached : undefined
  const mark = known ? await transcriptMark($, record) : undefined
  if (cached?.key === turn) {
    if (cached.state === 'answered' || (known && known.mark === mark)) return cached
    if (cached.state === 'unknown' && now - (cached.at ?? 0) < UNKNOWN_RETRY_MS) return undefined
  }
  // Out of reads this poll: a grown transcript's old reading no longer holds, nothing to go by
  // until the next one (a question it asked is not shown meanwhile).
  if (tailReads >= TAIL_READS_PER_POLL) return undefined
  const before = mark ?? (await transcriptMark($, record))
  const read = await readTurn($, record, turn)
  if (read.state === 'unknown') {
    endings[id] = { key: turn, state: 'unknown', ask: null, boxed: false, guess: { waiting: false, snippet: '' }, at: now }
    return undefined
  }
  const ending: Ending =
    read.state === 'answered'
      ? { key: turn, state: 'answered', ask: null, boxed: false, guess: { waiting: false, snippet: '' } }
      : { key: turn, state: 'replied', ask: read.box?.ask ?? null, boxed: read.box !== null, guess: classify(read.prose), mark: before }
  endings[id] = ending
  return ending
}

// A question as the central window shows it: the window's own question and the replies its
// buttons send (none when it asked in prose).
type Question = {
  id: string
  title: string
  link: string
  turn: string
  question: string
  context: string
  options: string[]
  // A dialog of several questions: each asked on its own („<title>“ (i/n): …) with its own buttons.
  parts?: { question: string; options: string[] }[]
  since: string
  // Reported by the window itself: answered through its plugin ('plugin'), else by a message.
  askId?: string
  delivery: 'plugin' | 'message'
}
type Brief = { id: string; title: string; link: string; since: string }
type Night = { od: string; do: string }

let home: string | undefined
const homeDir = async ($: EngineInterface) => (home ??= await envVar($, 'USERPROFILE'))

async function readNight($: EngineInterface): Promise<Night | undefined> {
  try {
    const path = `${await homeDir($)}/${NIGHT_FILE}`
    if (!(await $.fs.exists(path))) return undefined
    const night = JSON.parse((await $.fs.read(path)) as string) as { od?: unknown; do?: unknown }
    return typeof night.od === 'string' && typeof night.do === 'string' && !Number.isNaN(Date.parse(night.do))
      ? { od: night.od, do: night.do }
      : undefined
  } catch {
    return undefined
  }
}

// --- This window's own state (0.9) ---------------------------------------------------------------

// What this window last wrote of itself; undefined until its first turn (or a file it may adopt).
let own: WindowState | undefined
let ownTurn = ''
// This turn's wrap_up box: undefined without one, its question (null: none) with.
let box: Ask | null | undefined
// The call whose permission prompt is up, and the open dialog an answer from Centrála may close.
let approvalCall: string | undefined
let dialogWaiter: { askId: string; resolve: (answer: Answer) => void } | undefined
let answerMtime = -1

const statePath = async ($: EngineInterface, id: string) => `${await homeDir($)}/${STATE_DIR}/${id}.json`
const answerPath = async ($: EngineInterface, id: string) => `${await homeDir($)}/${ANSWER_DIR}/${id}.json`

async function saveOwn($: EngineInterface) {
  if (!own) return
  await $.fs.write(await statePath($, own.id), JSON.stringify(own)).catch(() => undefined)
}

async function setOwn($: EngineInterface, phase: Phase, extra: Partial<WindowState> = {}) {
  if (!selfId) await findSelf($).catch(() => undefined)
  if (!selfId) return
  const now = await $.clock.now()
  own = { v: STATE_VERSION, plugin: PLUGIN_VERSION, id: selfId, turn: ownTurn, since: now, beat: now, phase, ...extra }
  await saveOwn($)
}

// After a load (a reload, the app's restart): a question the window asked before still stands, so
// its file is taken over; one left mid-turn is not (its hooks are gone) and goes stale instead.
async function adoptOwn($: EngineInterface) {
  if (!selfId) await findSelf($).catch(() => undefined)
  if (!selfId || own) return
  try {
    const path = await statePath($, selfId)
    if (!(await $.fs.exists(path))) return
    const state = parseState((await $.fs.read(path)) as string, selfId)
    // A turn may have begun while the file was read: that one is newer.
    if (own) return
    if (state && (state.phase === 'asks' || state.phase === 'done')) {
      own = { ...state, plugin: PLUGIN_VERSION, beat: await $.clock.now() }
      ownTurn = state.turn
      await saveOwn($)
    }
  } catch {
    // Nothing to adopt: the next turn writes the file.
  }
}

async function beatOwn($: EngineInterface) {
  if (!own) return
  const now = await $.clock.now()
  if (now - own.beat < BEAT_MS) return
  own = { ...own, beat: now }
  await saveOwn($)
}

async function readState($: EngineInterface, id: string): Promise<WindowState | undefined> {
  try {
    const path = await statePath($, id)
    if (!(await $.fs.exists(path))) return undefined
    return parseState((await $.fs.read(path)) as string, id)
  } catch {
    return undefined
  }
}

// An answer Centrála's plugin left for this window: taken when it is for the question asked now,
// else dropped. The file is emptied either way, so it is taken once.
let isChecking = false

async function checkAnswer($: EngineInterface) {
  if (isChecking) return
  isChecking = true
  try {
    await takeAnswer($)
  } finally {
    isChecking = false
  }
}

async function takeAnswer($: EngineInterface) {
  if (!selfId || !own) return
  // The question as it stood before the file was read: it must still stand when the answer goes in.
  const asked = own
  const path = await answerPath($, selfId)
  if (!(await $.fs.exists(path).catch(() => false))) return
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.mtimeMs === answerMtime) return
  const answer = parseAnswer((await $.fs.read(path).catch(() => '')) as string)
  if (!answer) {
    answerMtime = stat.mtimeMs
    return
  }
  await $.fs.write(path, '{}')
  answerMtime = (await $.fs.stat(path).catch(() => undefined))?.mtimeMs ?? stat.mtimeMs
  if (!acceptsAnswer(own, answer)) {
    $.ui.toast('Odpověď z Centrály zahozena: otázka v tomto okně už neplatí.')
    return
  }
  if (own.phase === 'dialog') {
    if (dialogWaiter?.askId === answer.askId) dialogWaiter.resolve(answer)
    return
  }
  // You wrote in the window meanwhile: that is the answer, not this one.
  if (!own || own.phase !== asked.phase || own.since !== asked.since || own.ask?.id !== answer.askId) return
  await setOwn($, 'working')
  const wrote = own
  const sent = await $.prompt.submit({ text: answer.text, asUser: true }).catch(() => ({ drop: 'error' }))
  if ((sent as { drop?: unknown }).drop !== undefined && own?.phase === wrote?.phase && own?.since === wrote?.since) {
    // Not taken, and nothing else began meanwhile: the question stands as it was.
    own = { ...asked, beat: await $.clock.now() }
    await saveOwn($)
    $.ui.toast('Odpověď z Centrály se do okna nepodařilo vložit — odpověz v něm.')
  }
}

const describeCall = (input: Record<string, unknown>) =>
  String(input.description ?? input.command ?? input.file_path ?? input.url ?? '').replace(/\s+/g, ' ').slice(0, 120)

let isCentralTicking = false
// When a prompt to the central window went out whose turn has not begun yet; 0 when none.
// One is enough: the turn reads the whole queue. One that never starts a turn is sent again.
let promptedAt = 0
const PROMPT_RETRY_MS = 10 * 60_000
// The questions waiting now.
let current: Question[] = []
// The central turn a prompt of this plugin (or /centrala) began; the questions it began with, by
// window and turn (a window drops out once its reply is sent); whether its dialog is open.
let centralTurn: string | undefined
let shown = new Map<string, string>()
let inDialog = false
// What you chose or typed in this turn's dialogs, by the window each question named; whether the
// turn opened a dialog at all. A reply to a waiting window must be one of them.
let picks = new Map<string, Set<string>>()
let askedThisTurn = false
// Windows this turn's dialogs answered through their own plugin: nothing more is sent to them.
let delivered = new Set<string>()

// A short name Centrála's model may use for a long title („MCP Gateway“ for „MCP Gateway pro …“):
// the title's beginning, cut where a word ends, at least this long.
const MIN_SHORT_NAME = 6

// The name a dialog question begins with, and the rest after it; the whole title first (it may
// hold quotes itself), else the text in the first „…“.
function nameOf(question: string, titles: readonly string[]): { name: string; rest: string } | undefined {
  const text = question.trimStart()
  const whole = titles.filter(t => text.startsWith(`„${t}“`)).sort((a, b) => b.length - a.length)[0]
  if (whole !== undefined) return { name: whole, rest: text.slice(whole.length + 2) }
  const m = /^„([^“]+)“/.exec(text)
  return m ? { name: m[1]!.trim(), rest: text.slice(m[0].length) } : undefined
}

const isShortFor = (name: string, title: string) =>
  name.length >= MIN_SHORT_NAME && title.startsWith(name) && (title.length === name.length || /[\s—–\-:,(]/.test(title[name.length]!))

// The one window a dialog question names („<title>“ first, or a beginning of the title no other
// waiting window shares); none when two windows fit.
function windowOf(question: string): Question | undefined {
  const named = nameOf(question, current.map(q => q.title))
  if (!named) return undefined
  const exact = current.filter(q => q.title === named.name)
  if (exact.length) return exact.length === 1 ? exact[0] : undefined
  const short = current.filter(q => isShortFor(named.name, q.title))
  return short.length === 1 ? short[0] : undefined
}

// Your answers in a dialog of Centrála, by the window each question names. "You sent a message
// instead" answers nothing.
function notePicks(out: unknown) {
  const answers = (out as { result?: { answers?: Record<string, unknown> } } | undefined)?.result?.answers ?? {}
  for (const [question, answer] of Object.entries(answers)) {
    if (typeof answer !== 'string' || !answer.trim() || /^\s*\[User did not answer/i.test(answer)) continue
    const q = windowOf(question)
    if (!q) continue
    const set = picks.get(q.id) ?? new Set<string>()
    set.add(answer.trim())
    picks.set(q.id, set)
  }
}

// A dialog question of Centrála and the window it names; `part` (1-based) when it asks one part
// of that window's question („<title>“ (i/n): …).
type OpenedItem = { question: string; labels: string[]; part?: number }
type Opened = { window: Question; items: OpenedItem[] }

const partOf = (question: string, title: string): number | undefined => {
  const rest = nameOf(question, [title])?.rest ?? ''
  const m = /^\s*\((\d+)\s*\/\s*(\d+)\)/.exec(rest)
  return m ? Number(m[1]) : undefined
}

function openedDialog(input: { questions?: readonly { question?: string; options?: readonly { label?: string }[] }[] }): Opened[] {
  const byWindow = new Map<string, Opened>()
  for (const q of input.questions ?? []) {
    const window = typeof q.question === 'string' ? windowOf(q.question) : undefined
    if (!window) continue
    const item: OpenedItem = {
      question: q.question!,
      labels: (q.options ?? []).map(o => String(o.label ?? '').trim()),
      ...(window.parts?.length ? { part: partOf(q.question!, window.title) } : {}),
    }
    const opened = byWindow.get(window.id) ?? { window, items: [] }
    opened.items.push(item)
    byWindow.set(window.id, opened)
  }
  // Which answer counts is never guessed: a window is asked once, or each of its parts exactly once.
  return [...byWindow.values()].filter(({ window, items }) => {
    const n = window.parts?.length ?? 0
    if (!n) return items.length === 1
    const seen = new Set(items.map(i => i.part))
    return items.length === n && seen.size === n && [...seen].every(p => p !== undefined && p >= 1 && p <= n)
  })
}

// Answers the plugin handed to windows, waiting to be taken: by window, the question and when.
let handed = new Map<string, { askId: string; at: number }>()
const HANDED_WAIT_MS = 20_000

// Windows that reported their question themselves get your pick from this plugin, not from the
// model: it writes the answer for the window's plugin, which takes it only for the question the
// dialog showed. Only one of the window's buttons or what you typed yourself goes: the dialog's
// own extra buttons („Později“, „Odpovím v okně“) answer nothing, nor does a dialog that closed
// itself while you were away.
async function deliverPicks($: EngineInterface, opened: Opened[], out: unknown): Promise<string[]> {
  const result = (out as { result?: { answers?: Record<string, unknown>; afkTimeoutMs?: unknown; followUp?: unknown } } | undefined)?.result
  if (!result || result.afkTimeoutMs !== undefined || result.followUp) return []
  const sent: string[] = []
  // One item's pick: a button of the window (or of its part), or your own words; null for none.
  const pickOf = (item: OpenedItem, buttons: string[]) => {
    const raw = result.answers?.[item.question]
    if (typeof raw !== 'string') return null
    const text = raw.trim()
    if (!text || /^\[User did not answer/i.test(text)) return null
    const isButton = buttons.includes(text)
    if (!isButton && item.labels.includes(text)) return null
    return { text, typed: !isButton }
  }
  for (const { window, items } of opened) {
    if (!window.askId) continue
    let answer: Answer
    if (window.parts?.length) {
      // All parts or nothing: „Později“ on one leaves the whole question waiting.
      const ordered = [...items].sort((a, b) => (a.part ?? 0) - (b.part ?? 0))
      const picks = ordered.map(item => pickOf(item, window.parts![(item.part ?? 1) - 1]?.options ?? []))
      if (picks.some(p => p === null)) continue
      const parts = picks as PartAnswer[]
      answer = { askId: window.askId, text: joinParts(parts.map(p => p.text)), typed: parts.some(p => p.typed), at: await $.clock.now(), parts }
    } else {
      const pick = pickOf(items[0]!, window.options)
      if (!pick) continue
      answer = { askId: window.askId, text: pick.text, typed: pick.typed, at: await $.clock.now() }
    }
    try {
      await $.fs.write(await answerPath($, window.id), JSON.stringify(answer))
      delivered.add(window.id)
      shown.delete(window.id)
      handed.set(window.id, { askId: window.askId, at: answer.at })
      sent.push(window.title)
    } catch {
      // Not written: the model's send_message path stays open for it.
    }
  }
  return sent
}
// The questions put to you, by window: the turn whose question it was. Kept while the window
// is on that turn or working (a compact is no answer), dropped once it replies anew or is gone.
const ANNOUNCED = 'central-announced-v2'

const toQuestion = (r: Row): Question => ({
  id: r.id,
  title: r.title,
  link: r.link,
  // The key the question is announced and checked by: its own id when the window reported it.
  turn: r.askId || r.turn,
  question: r.question?.text || r.snippet,
  context: r.question?.context ?? '',
  options: r.question?.options ?? [],
  ...(r.askId && r.question?.parts?.length
    ? { parts: r.question.parts.map(p => ({ question: p.text, options: p.options })) }
    : {}),
  since: r.lastActivityAt,
  ...(r.askId ? { askId: r.askId } : {}),
  delivery: r.askId ? 'plugin' : 'message',
})
const questionKey = (r: Row) => r.askId || r.turn
const relays = (r: Row, rows: readonly Row[]) =>
  rows.some(
    c => c.parent === r.id && c.id !== r.id && (c.waiting || (c.isRunning && Date.parse(c.lastActivityAt) > Date.parse(r.lastActivityAt))),
  )
const brief = (r: Row): Brief => ({ id: r.id, title: r.title, link: r.link, since: r.lastActivityAt })

// Whether the window still waits on the question of its reply `turn`, asked of the window itself:
// 'no' once it replied anew or something came after that reply (you answered it there, another
// session did), 'unknown' while working with no transcript to tell (a compact or an answer).
async function stillAsks($: EngineInterface, id: string, turn: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    // A question the window reported itself: its file says, while it is believed.
    if (/^[bd]:/.test(turn)) {
      const state = await readState($, id)
      if (!state) return 'unknown'
      const record = await readRecord($, await findRecordDirs($), id)
      if (!isTrusted(state, await $.clock.now(), record?.lastTurnEdgeAt)) return 'unknown'
      return (state.phase === 'asks' || state.phase === 'dialog') && state.ask?.id === turn ? 'yes' : 'no'
    }
    const res = await $.mcp.call(SESSIONS, 'get_session', { session_id: id })
    if (res.isError) return 'unknown'
    const session = JSON.parse(textOf(res)) as Session
    if (session.isArchived) return 'no'
    const record = await readRecord($, await findRecordDirs($), id)
    if (!record) return 'unknown'
    if (record.lastAssistantUuid !== turn) return 'no'
    const read = await readTurn($, record, turn)
    if (read.state === 'answered') return 'no'
    if (read.state === 'replied') return 'yes'
    return session.isRunning ? 'unknown' : 'yes'
  } catch {
    return 'unknown'
  }
}

// Before Centrála sends a window that waits its reply: in a turn the plugin began or one that put
// a dialog to you, the reply must be what you chose or typed there for that window, and the window
// must still ask (else the reply would land in a window that has moved on). The night message
// and a reply you dictate in a turn of your own pass. Undefined: send; else why not.
async function refuseSend($: EngineInterface, to: string, text: string): Promise<string | undefined> {
  if (!(await isCentral($))) return undefined
  if (/^\s*\[noc\]/.test(text)) return undefined
  if (delivered.has(to)) {
    return 'Nic neodesláno: odpověď tomuto oknu už doručil plugin (okno ji dostalo jako uživatelovu volbu). Napiš uživateli, že odešla, a nic dalšího mu neposílej.'
  }
  const turn = shown.get(to) ?? current.find(q => q.id === to)?.turn
  if (!turn) return undefined
  if ((centralTurn || askedThisTurn) && !picks.get(to)?.has(text.trim())) {
    return 'Nic neodesláno: tuto odpověď uživatel v dialogu u otázky tohoto okna nevybral ani nenapsal (otázka v dialogu musí začínat „<název okna>“). Napiš mu, že oknu nic neodešlo. Odpověď nedomýšlej; chce-li ji poslat, vybere ji v dialogu nebo ji napíše sám v novém tahu.'
  }
  const verdict = await stillAsks($, to, turn)
  shown.delete(to)
  if (verdict === 'yes') return undefined
  return 'Nic neodesláno: okno mezitím dostalo odpověď jinde nebo už pracuje dál. Napiš uživateli „už vyřízeno v okně“ a nic dalšího mu neposílej.'
}

function promptCentral($: EngineInterface, now: number, text: string) {
  promptedAt = now
  void $.prompt.submit({ text }).then(
    r => {
      if (r.drop !== undefined) promptedAt = 0
    },
    () => {
      promptedAt = 0
    },
  )
}

// In the central window: polls (by this version's rules, whatever plugin the other windows still
// run), keeps QUEUE_FILE up to date and, when a window asks something new, starts a turn here.
// Only questions the window's box, the app or the window's own last words ask are put to you.
async function centralTick($: EngineInterface) {
  if (isCentralTicking) return
  isCentralTicking = true
  try {
    const polled = await refresh($, true)
    if (!polled) return
    const rows = notSelf(polled)
    const byId = new Map(rows.map(r => [r.id, r]))
    const now = await $.clock.now()
    // Only questions that have stood a while: one you answer in its window at once never comes here
    // (nor into the queue the model reads).
    const waiting = rows
      .filter(r => r.waiting && !r.deferred && questionKey(r) && r.question)
      // An answer handed to it is on its way: not asked again unless the window leaves it.
      .filter(r => handed.get(r.id)?.askId !== questionKey(r))
      // A window whose fork (or a window it started) waits on you, or was answered and works on
      // since it asked, mostly asks you the same: you answer in the window that wants it.
      .filter(r => !relays(r, rows))
      .map(toQuestion)
      .filter(q => now - Date.parse(q.since) >= CENTRAL_DELAY_MS)
      .sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
    current = waiting
    const night = (await readNight($)) ?? null
    // Written each tick: `at` says the queue is live.
    await $.fs.write(
      `${await homeDir($)}/${QUEUE_FILE}`,
      JSON.stringify(
        {
          at: new Date(now).toISOString(),
          night,
          waiting,
          working: rows.filter(r => r.isRunning).map(brief),
          // Permission prompts standing a while: answered only in their window.
          approvals: rows.filter(r => r.approval).map(r => ({ ...brief(r), approval: r.approval })),
          unread: rows.filter(r => r.unread && !r.waiting && !r.deferred).map(brief),
          deferred: rows.filter(r => r.deferred).map(brief),
        },
        null,
        1,
      ),
    )
    const stored = ((await $.store.get(ANNOUNCED)) as Record<string, string> | undefined) ?? {}
    const announced: Record<string, string> = {}
    for (const [id, turn] of Object.entries(stored)) {
      const r = byId.get(id)
      if (r && (r.isRunning || questionKey(r) === turn)) announced[id] = turn
    }
    // A question shown in the open dialog that its window no longer asks (you answered it there):
    // the dialog is dropped — only while it is open, never mid-send — and the rest asked again.
    if (centralTurn && inDialog && shown.size) {
      let stale = false
      for (const [id, turn] of shown) {
        const r = byId.get(id)
        if (r && !r.isRunning && questionKey(r) === turn && r.waiting) continue
        if ((await stillAsks($, id, turn)) === 'no') {
          stale = true
          break
        }
      }
      if (stale && centralTurn && inDialog) {
        const turnId = centralTurn
        for (const id of shown.keys()) delete announced[id]
        centralTurn = undefined
        shown = new Map()
        inDialog = false
        promptedAt = 0
        await $.turn.abort({ turnId }).catch(() => undefined)
      }
    }
    // Answers handed to windows: one the window has not taken while it still asks the same is put
    // to you again (its plugin is gone or reloaded); one it took or moved on from is done with.
    for (const [id, h] of handed) {
      const r = byId.get(id)
      if (!r || !r.waiting || questionKey(r) !== h.askId) handed.delete(id)
      else if (now - h.at > HANDED_WAIT_MS) {
        handed.delete(id)
        delete announced[id]
      }
    }
    await $.store.set(ANNOUNCED, announced)
    if (night && now >= Date.parse(night.do)) {
      // Once the night is over: one morning turn (marked when it begins), then it is day again.
      if ((await $.store.get('morning')) !== night.od) {
        if (!promptedAt || now - promptedAt > PROMPT_RETRY_MS) {
          promptCentral($, now, `[okna] Ráno: noc skončila. Postupuj podle skillu centrala, část „ráno“ (fronta ~/${QUEUE_FILE}).`)
        }
        return
      }
    } else if (night) {
      // The night: questions wait for the morning.
      return
    }
    const fresh = waiting.filter(q => announced[q.id] !== q.turn)
    if (fresh.length && (!promptedAt || now - promptedAt > PROMPT_RETRY_MS)) {
      const names = fresh.map(q => `„${q.title}“`).join(', ')
      promptCentral(
        $,
        now,
        `[okna] ${fresh.length === 1 ? 'Nová otázka' : 'Nové otázky'} z ${names}. Ukaž mi rozhodnutí podle skillu centrala (fronta ~/${QUEUE_FILE}).`,
      )
    }
  } catch (error) {
    await update($, infoAtom, () => `Centrála: ${String(error).slice(0, 200)}`)
  } finally {
    isCentralTicking = false
  }
}

// The prompt cache lives an hour after the last activity; resuming later re-caches
// the whole context. Minutes left in the last stretch before that, else null.
function cacheLeftMin(row: Row, now: number): number | null {
  if (row.isRunning) return null
  const left = Math.ceil((Date.parse(row.lastActivityAt) + CACHE_TTL_MS - now) / 60_000)
  return left > 0 && left <= CACHE_WARN_MIN ? left : null
}

const byActivity =(a: Row, b: Row) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)

const short = (text: string) => (text.length > 90 ? `${text.slice(0, 89)}…` : text)

// A row with a dot wants a look: waiting, working, unread or its cache ending.
// A deferred window wants nothing until you write into it.
const marked = (row: Row, now: number) =>
  !row.deferred && (row.waiting || row.isRunning || row.unread || cacheLeftMin(row, now) !== null)

// Top: waiting, then running, then the other marked ones. Below: the seen and
// done windows of the last week, newest first. Deferred ones apart.
function ordered(rows: Row[], now: number): { top: Row[]; earlier: Row[]; deferred: Row[] } {
  const deferred = rows.filter(r => r.deferred).sort(byActivity)
  const live = rows.filter(r => !r.deferred)
  const waiting = live.filter(r => r.waiting).sort(byActivity)
  const running = live.filter(r => r.isRunning).sort(byActivity)
  const other = live.filter(r => !r.waiting && !r.isRunning && marked(r, now)).sort(byActivity)
  const earlier = live.filter(r => !marked(r, now)).sort(byActivity).slice(0, EARLIER_MAX_ROWS)
  return { top: [...waiting, ...running, ...other], earlier, deferred }
}

// The list as plain text, for a surface without the pane (Remote Control, phone).
function asText(rows: Row[], remote: RemotePc[], now: number): string {
  const block = (list: Row[]) => {
    const { top, earlier, deferred } = ordered(list, now)
    const lines = top.map(r => {
      const state = r.waiting ? 'ČEKÁ' : r.isRunning ? 'PRACUJE' : r.unread ? 'NOVÉ' : 'CACHE'
      const ask = r.waiting && r.snippet ? ` — ${short(r.snippet)}` : ''
      return `${state} · ${r.title} · ${age(r.lastActivityAt, now)}${ask}`
    })
    if (earlier.length) {
      lines.push('', 'Dřív:', ...earlier.map(r => `- ${r.title} · ${age(r.lastActivityAt, now)}`))
    }
    if (deferred.length) {
      lines.push('', `Odloženo (${deferred.length}):`, ...deferred.map(r => `- ${r.title} · ${age(r.lastActivityAt, now)}`))
    }
    return lines
  }
  const lines = block(rows)
  for (const p of remote) lines.push('', `== ${p.pc} ==`, ...block(p.rows))
  return lines.length ? lines.join('\n') : 'Žádná okna.'
}

const isRemote = (row: Row) => row.id.includes('|')

// The square colors, as the app's sidebar: blue wants you, orange works, red is about to lose its cache.
const COLORS = { waiting: '#378ADD', running: '#EF9F27', cache: '#E24B4A', unread: '#85B7EB', rest: '#B4B2A9' }

type Group = { key: string; label: string; color: string; rows: Row[] }

// The windows that want a look, each in the first group it belongs to.
function groups(rows: Row[], now: number): Group[] {
  const live = rows.filter(r => !r.deferred).sort(byActivity)
  const cache = (r: Row) => cacheLeftMin(r, now) !== null
  return [
    { key: 'waiting', label: 'Čeká na tebe', color: COLORS.waiting, rows: live.filter(r => r.waiting) },
    { key: 'running', label: 'Pracuje', color: COLORS.running, rows: live.filter(r => !r.waiting && r.isRunning) },
    { key: 'cache', label: 'Končí cache', color: COLORS.cache, rows: live.filter(r => !r.waiting && !r.isRunning && cache(r)) },
    {
      key: 'unread',
      label: 'Nepřečtené',
      color: COLORS.unread,
      rows: live.filter(r => !r.waiting && !r.isRunning && !cache(r) && r.unread),
    },
  ].filter(g => g.rows.length > 0)
}

// The bar as one thin SVG, stretched to the pane's width.
function barSvg(parts: { n: number; color: string }[]): string {
  const total = parts.reduce((sum, p) => sum + p.n, 0) || 1
  let x = 0
  const rects = parts
    .filter(p => p.n > 0)
    .map(p => {
      const w = (p.n / total) * 100
      const rect = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="6" fill="${p.color}"/>`
      x += w
      return rect
    })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 6" preserveAspectRatio="none" width="100%" height="6">${rects.join('')}</svg>`
}

const windowsCount = (n: number) => `${n} ${n === 1 ? 'okno' : n >= 2 && n <= 4 ? 'okna' : 'oken'}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'okna', description: 'Přehled oken: otevře panel a vypíše seznam do chatu' })
    // The title is read again each minute: a window renamed "Centrála" becomes the central one.
    let ticks = 0
    $.clock.every(POLL_MS, async () => {
      if (ticks++ % 6 === 0) await findSelf($).catch(() => undefined)
      // The central window polls itself; the others share one poll through the store.
      if (await isCentral($)) await centralTick($)
      else await refresh($)
    })
    // An answer from Centrála is taken within seconds (a stat of one small file).
    $.clock.every(ANSWER_CHECK_MS, async () => {
      // The beat here, not behind a poll that may take long.
      await beatOwn($).catch(() => undefined)
      await checkAnswer($).catch(() => undefined)
    })
    void adoptOwn($)
    await update($, barAtom, () => false)
    if ((await $.store.get('bar')) === true) await update($, barAtom, () => true)
    await $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })
    void refresh($)
    return next(e)
  })

  // The central window's turn has begun: it reads the queue as it is now.
  // In the central window: a turn a prompt of this plugin (or /centrala) began reads the queue
  // as it is now, so what it holds counts as put to you.
  on('turn.start', async ($, e, next) => {
    // Whatever begins a turn here (you, Centrála, a notification) answers what the window asked.
    if (e.agentId === undefined) {
      ownTurn = e.turnId
      box = undefined
      approvalCall = undefined
      await setOwn($, 'working')
    }
    if (e.agentId === undefined && (await isCentral($))) {
      picks = new Map()
      delivered = new Set()
      askedThisTurn = false
      if (/\[okna\]|centrala/i.test(e.text)) {
        promptedAt = 0
        centralTurn = e.turnId
        shown = new Map(current.map(q => [q.id, q.turn]))
        const announced = ((await $.store.get(ANNOUNCED)) as Record<string, string> | undefined) ?? {}
        await $.store.set(ANNOUNCED, { ...announced, ...Object.fromEntries(shown) })
        if (/\[okna\] Ráno/.test(e.text)) {
          const night = await readNight($)
          if (night) await $.store.set('morning', night.od)
        }
      } else {
        centralTurn = undefined
        shown = new Map()
      }
    }
    return next(e)
  })

  // Centrála's dialog: open while it waits on you (a stale one is dropped); what you answer in it
  // is what its replies to the windows may say.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // Not before this load has seen the turn begin (a reload mid-turn): its end would go unseen.
    if (!(await isCentral($)) && !ownTurn) return next(e)
    if (!(await isCentral($))) {
      // A window's own dialog: Centrála sees it, and an answer you pick there closes it.
      const askId = `d:${ownTurn}:${e.tool_use_id ?? String(await $.clock.now())}`
      await setOwn($, 'dialog', { ask: askOfDialog(askId, e as never) })
      const answered = new Promise<Answer>(resolve => {
        dialogWaiter = { askId, resolve }
      })
      try {
        const call = next(e)
        const won = await Promise.race([call.then(out => ({ out })), answered.then(answer => ({ answer }))])
        if ('out' in won) return won.out
        call.catch(() => undefined)
        const at = new Date(won.answer.at || (await $.clock.now())).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
        return {
          result: dialogResult(e as never, won.answer) as never,
          context: [`Odpověď na tento dialog vybral uživatel v okně Centrála (${at}); plugin okna ji sem doručil a dialog zavřel.`],
        }
      } finally {
        dialogWaiter = undefined
        if (own?.phase === 'dialog' && own.ask?.id === askId) await setOwn($, 'working')
      }
    }
    askedThisTurn = true
    inDialog = centralTurn !== undefined
    // Each question of this dialog with the window it names, as the queue was when it opened: an
    // answer goes to that question, never to one the window asked meanwhile.
    const opened = openedDialog(e as never)
    try {
      const out = await next(e)
      notePicks(out)
      const sent = out.deny === undefined ? await deliverPicks($, opened, out) : []
      return sent.length && out.deny === undefined
        ? {
            ...out,
            context: [
              ...((out as { context?: readonly string[] }).context ?? []),
              `Plugin předal odpověď oknům ${sent.map(t => `„${t}“`).join(', ')} (jako uživatelovu volbu); okno ji převezme do pár sekund, jen pokud se pořád ptá na totéž (jinak se Centrála zeptá znovu). Těm oknům nic neposílej, jen uživateli napiš, že odpověď předal plugin.`,
            ],
          }
        : out
    } finally {
      inDialog = false
    }
  })

  // This turn's box: its question is what the window waits on once the turn ends.
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    if (e.agentId === undefined) box = askOfBox(`b:${ownTurn}:${e.tool_use_id ?? ''}`, e as never)
    return next(e)
  })

  // A permission prompt: shown in the panel (after a while), never answered from elsewhere.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // Only inside the window's running turn: a background agent's check after the turn ended (or a
    // plugin's query) must not hide the question the turn closed on.
    if (verdict.decision === 'ask' && e.tool_use_id && e.tool !== 'AskUserQuestion' && ownTurn && own?.phase === 'working') {
      approvalCall = e.tool_use_id
      await setOwn($, 'approval', { approval: { tool: e.tool, summary: describeCall((e.input ?? {}) as Record<string, unknown>) } })
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (approvalCall !== undefined && e.tool_use_id === approvalCall) {
        approvalCall = undefined
        if (own?.phase === 'approval') await setOwn($, 'working')
      }
    }
  })

  // /clear ends the conversation the question belonged to: the window no longer asks it.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && own) {
      approvalCall = undefined
      box = undefined
      await setOwn($, 'done', { boxed: false, prose: '', aborted: true }).catch(() => undefined)
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const out = await next(e)
    // The app counts a compact as a turn's end: the file says it saw it.
    if (e.agentId === undefined && own) {
      own = { ...own, since: await $.clock.now(), beat: await $.clock.now() }
      await saveOwn($)
    }
    return out
  })

  // Centrála's replies to the windows, by either tool: refused when the window has moved on.
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__send_message' }, async ($, e, next) => {
    const args = e as unknown as { session_id?: unknown; message?: unknown }
    const reason = await refuseSend($, String(args.session_id ?? ''), String(args.message ?? ''))
    return reason ? { deny: reason } : next(e)
  })

  on('session.send', async ($, e, next) => {
    const reason = await refuseSend($, e.to, e.text)
    return reason ? { isDelivered: false, reason } : next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      picks = new Map()
      delivered = new Set()
      askedThisTurn = false
      if (e.turnId === ownTurn) {
        approvalCall = undefined
        if (e.reason === 'answer' && box) await setOwn($, 'asks', { ask: box })
        else {
          await setOwn($, 'done', {
            boxed: box !== undefined,
            prose: proseTail(e.answer ?? ''),
            ...(e.reason === 'answer' ? {} : { aborted: true }),
          })
        }
        box = undefined
      }
    }
    if (e.turnId === centralTurn) {
      // The turn died before you saw its questions: they are put to you again.
      if (e.reason === 'error' || e.reason === 'refusal') {
        const announced = ((await $.store.get(ANNOUNCED)) as Record<string, string> | undefined) ?? {}
        for (const id of shown.keys()) delete announced[id]
        await $.store.set(ANNOUNCED, announced)
      }
      centralTurn = undefined
      shown = new Map()
      inDialog = false
    }
    return next(e)
  })

  on('command.run', { command: 'okna' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })
    await refresh($, true)
    const info = [await read($, infoAtom), await read($, syncAtom)].filter(Boolean).join('\n')
    const text = asText(await read($, rowsAtom), await read($, remoteAtom), await $.clock.now())
    return { text: info ? `${info}\n${text}` : text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Only the graphical surfaces have Svg; the terminal draws the bar in blocks.
    const Svg = e.surface === 'terminal' ? undefined : (ui as { Svg?: ElementConstructor<SvgProps> }).Svg
    const rows = await read($, rowsAtom)
    const info = await read($, infoAtom)
    const remote = await read($, remoteAtom)
    const sync = await read($, syncAtom)
    const open = await read($, openAtom)
    const bar = await read($, barAtom)
    const now = await $.clock.now()

    // Applies `fn` to the row's list, this PC's or the other PC's it came from.
    async function editList(row: Row, fn: (list: Row[]) => Row[]) {
      if (isRemote(row)) await update($, remoteAtom, pcs => pcs.map(p => ({ ...p, rows: fn(p.rows) })))
      else await update($, rowsAtom, fn)
      // Stale, so the next poll runs; its rows stay for the windows drawing it meanwhile.
      const snapshot = (await $.store.get('snapshot')) as Snapshot | undefined
      await $.store.set('snapshot', {
        ...(snapshot ?? { rows: [], info: '' }),
        at: 0,
        rows: isRemote(row) ? (snapshot?.rows ?? []) : fn(snapshot?.rows ?? []),
        remote: (snapshot?.remote ?? []).map(p => ({ ...p, rows: isRemote(row) ? fn(p.rows) : p.rows })),
      })
    }

    // Another PC's window opens through its Remote Control link, and only a link of that shape.
    async function openRow(row: Row) {
      if (isRemote(row)) {
        const seen = ((await $.store.get('remote-seen')) as Record<string, string> | undefined) ?? {}
        await $.store.set('remote-seen', Object.fromEntries([...Object.entries(seen).slice(-200), [row.id, row.lastActivityAt]]))
      }
      await editList(row, list => list.map(r => (r.id === row.id ? { ...r, unread: false } : r)))
      if (row.link && (!isRemote(row) || RC_LINK.test(row.link))) await $.process.run(['explorer.exe', row.link])
    }

    // Out of the list until the window does something again.
    async function hideRow(row: Row) {
      const hidden = ((await $.store.get('hidden')) as Record<string, string> | undefined) ?? {}
      await $.store.set('hidden', { ...hidden, [row.id]: row.lastActivityAt })
      await editList(row, list => list.filter(r => r.id !== row.id))
    }

    // Down to "Odloženo" until you write into the window, or put it back yourself.
    async function deferRow(row: Row, defer: boolean) {
      const deferred = ((await $.store.get('deferred')) as Deferred | undefined) ?? {}
      const { [row.id]: _, ...rest } = deferred
      await $.store.set('deferred', defer ? { ...rest, [row.id]: deferMark(row) } : rest)
      await editList(row, list => list.map(r => (r.id === row.id ? { ...r, deferred: defer } : r)))
    }

    // Folded sections ("Dřív", "Odloženo", another PC) open and close by their key.
    // Kept across windows and sessions: each poll takes the store's.
    async function toggle(key: string) {
      const next = { ...open, [key]: !open[key] }
      await $.store.set('open', next)
      await update($, openAtom, () => next)
    }

    // The bar's own switch: the window count in the header; kept across sessions.
    async function toggleBar() {
      await $.store.set('bar', !bar)
      await update($, barAtom, () => !bar)
    }

    // Row buttons show under the pointer where there is one, always where there is not.
    const hoverable = e.surface === 'desktop' || e.surface === 'vscode'
    const smallButton = (key: string, label: string, onPress: () => Promise<void>) => (
      <Button key={key} plain dimColor onPress={onPress}>
        <Text size="caption" dimColor>
          {label}
        </Text>
      </Button>
    )
    // No key of their own: the row's keyed Box is the hover scope that reveals them.
    const actions = (row: Row, kinds: ('defer' | 'hide' | 'back')[]) =>
      kinds.length === 0 ? null : (
        <Box
          flexDirection="row"
          gap={1}
          marginLeft={1}
          display={hoverable ? 'none' : 'flex'}
          hover={hoverable ? { display: 'flex' } : undefined}
        >
          {kinds.map(kind =>
            kind === 'defer'
              ? smallButton(`defer-${row.id}`, 'odložit', () => deferRow(row, true))
              : kind === 'hide'
                ? smallButton(`hide-${row.id}`, 'skrýt', () => hideRow(row))
                : smallButton(`back-${row.id}`, 'vrátit', () => deferRow(row, false)),
          )}
        </Box>
      )

    // A narrow pane: the left side shrinks and cuts its text with "…"; what is on the right never shrinks.
    const shrinking = { flexShrink: 1, flexGrow: 1, minWidth: 0, overflow: 'hidden' } as const

    // One window: title on the left (bold while unread), its age on the right, the
    // buttons beside the title under the pointer; a waiting window adds its question.
    const windowRow = (row: Row, dim: boolean, kinds: ('defer' | 'hide' | 'back')[]) => {
      const left = cacheLeftMin(row, now)
      return (
        <Box key={row.id} flexDirection="column" paddingLeft={3} minWidth={0}>
          <Box key={`row-${row.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexDirection="row" {...shrinking}>
              <Button key={row.id} plain onPress={() => openRow(row)}>
                <Text dimColor={dim} weight={row.unread ? 'semibold' : 'regular'} wrap="truncate-end">
                  {row.title}
                </Text>
              </Button>
              {actions(row, kinds)}
            </Box>
            <Box flexShrink={0}>
              {left !== null && !dim ? (
                <Text color={COLORS.cache}>za {left} min</Text>
              ) : (
                <Text dimColor>{age(row.lastActivityAt, now)}</Text>
              )}
            </Box>
          </Box>
          {row.waiting && row.snippet && !dim ? (
            <Box paddingLeft={2} minWidth={0}>
              <Text size="footnote" dimColor wrap="wrap">
                {short(row.snippet)}
              </Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    // A group as in the Context pane: color square, name, count on the right.
    const groupHeading = (key: string, group: Group) => (
      <Box key={`g-${key}`} flexDirection="row" justifyContent="space-between" gap={1} marginTop={1}>
        <Box {...shrinking}>
          <Text wrap="truncate-end">
            <Text color={group.color}>■ </Text>
            <Text weight="medium">{group.label}</Text>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{group.rows.length}</Text>
        </Box>
      </Box>
    )

    // A folded section: "› Dřív" on the left, its count on the right.
    const foldHeading = (key: string, label: string, count: number) => (
      <Box key={`f-${key}`} flexDirection="row" justifyContent="space-between" gap={1} marginTop={1}>
        <Box {...shrinking}>
          <Button key={`f-${key}`} plain dimColor onPress={() => toggle(key)}>
            <Text dimColor wrap="truncate-end">
              {open[key] ? '⌄' : '›'} {label}
            </Text>
          </Button>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{count}</Text>
        </Box>
      </Box>
    )

    // One PC's windows: the groups, then the folded "Dřív" and "Odloženo".
    const block = (key: string, list: Row[]) => {
      const { earlier, deferred } = ordered(list, now)
      return [
        ...groups(list, now).flatMap(g => [
          groupHeading(`${key}-${g.key}`, g),
          ...g.rows.map(r => windowRow(r, false, r.isRunning ? [] : ['defer', 'hide'])),
        ]),
        ...(earlier.length ? [foldHeading(`${key}-earlier`, 'Dřív', earlier.length)] : []),
        ...(earlier.length && open[`${key}-earlier`] ? earlier.map(r => windowRow(r, true, ['hide'])) : []),
        ...(deferred.length ? [foldHeading(`${key}-deferred`, 'Odloženo', deferred.length)] : []),
        ...(deferred.length && open[`${key}-deferred`] ? deferred.map(r => windowRow(r, true, ['back'])) : []),
      ]
    }

    // The optional bar: the windows by state, as the Context pane's usage bar.
    const barParts = [...groups(rows, now).map(g => ({ n: g.rows.length, color: g.color }))]
    barParts.push({ n: rows.length - barParts.reduce((sum, p) => sum + p.n, 0), color: COLORS.rest })
    const barView = !bar || rows.length === 0 ? null : Svg ? (
      <Box key="bar" marginBottom={1}>
        <Svg source={barSvg(barParts)} alt={`Okna podle stavu: ${barParts.map(p => p.n).join(', ')}`} height={6} />
      </Box>
    ) : (
      <Box key="bar" flexDirection="row" marginBottom={1}>
        {barParts
          .filter(p => p.n > 0)
          .map((p, i) => (
            <Text key={`bar-${i}`} color={p.color}>
              {'█'.repeat(Math.max(1, Math.round((p.n / rows.length) * 30)))}
            </Text>
          ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text weight="semibold">Okna</Text>
          <Button key="bar-switch" plain dimColor onPress={toggleBar}>
            <Text size="footnote" dimColor>
              {windowsCount(rows.length)}
            </Text>
          </Button>
        </Box>
        {barView}
        {info ? <Text color="red">{info}</Text> : null}
        {block('local', rows)}
        {remote.flatMap(p => [
          foldHeading(`pc-${p.pc}`, p.pc, p.rows.length),
          ...(open[`pc-${p.pc}`] ? block(p.pc, p.rows) : []),
        ])}
        {sync ? (
          <Box marginTop={1}>
            <Text size="caption" dimColor>
              {sync}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
