// What Orca's Centrála shows: the questions windows wait on, from the state files the Okna plugin
// (0.9.9+) writes in each Claude window under ~/.claude/okna-stav/orca-<id>.json, joined with
// Orca's own list of agents. Pure functions; files and Orca are in worker.ts.

export const STATE_VERSION = 1
// A file its window has not touched this long is not believed (the window writes it every 30 s).
export const STALE_MS = 120_000
// A permission prompt is shown once it has stood this long (auto mode settles its own fast).
export const APPROVAL_SHOW_MS = 15_000
// An answer the panel wrote and the window has not taken yet: the row waits this long, then shows again.
export const PENDING_MS = 20_000

export type AskPart = { text: string; options: string[]; descriptions?: string[] }
export type Ask = { id: string; text: string; context: string; options: string[]; descriptions?: string[]; parts?: AskPart[] }
export type WindowState = {
  v: number
  id: string
  turn: string
  since: number
  beat: number
  phase: 'working' | 'asks' | 'dialog' | 'approval' | 'done'
  ask?: Ask
  approval?: { tool: string; summary: string }
  prose?: string
  aborted?: boolean
  peer?: boolean
}

// One Orca agent session, as `orca worktree ps --json` lists it: a chat (its session id) or an agent
// in a terminal (its pane key); since = when it entered its state.
export type Agent = { sessionId: string; title: string; workspaceId: string; state: string; since: number; chat: boolean }

export type Kind = 'dialog' | 'reply' | 'approval'
export type Waiting = {
  id: string
  title: string
  workspaceId: string
  kind: Kind
  askId: string
  text: string
  context: string
  options: string[]
  descriptions?: string[]
  parts?: AskPart[]
  since: number
}

export type PartAnswer = { text: string; typed: boolean }
export type Answer = { askId: string; text: string; typed: boolean; at: number; parts?: PartAnswer[] }

export function parseState(text: string, id: string): WindowState | undefined {
  try {
    const s = JSON.parse(text) as Partial<WindowState>
    if (s.v !== STATE_VERSION || s.id !== id || typeof s.phase !== 'string') return undefined
    if (typeof s.since !== 'number' || typeof s.beat !== 'number' || typeof s.turn !== 'string') return undefined
    if ((s.phase === 'asks' || s.phase === 'dialog') && (!s.ask || typeof s.ask.id !== 'string' || !Array.isArray(s.ask.options))) return undefined
    return s as WindowState
  } catch {
    return undefined
  }
}

// The Orca session id in a pane key: "structured-agent-session-claude_<uuid>:<leaf>".
export function sessionOfPane(paneKey: string): string | undefined {
  return /^structured-agent-session-([\w-]+):/.exec(paneKey)?.[1]
}

type PsAgent = {
  paneKey?: unknown
  state?: unknown
  conversationName?: unknown
  displayName?: unknown
  taskTitle?: unknown
  stateStartedAt?: unknown
  updatedAt?: unknown
}
type PsWorktree = { worktreeId?: unknown; displayName?: unknown; repo?: unknown; agents?: unknown }

export function agentsOfPs(json: unknown): Agent[] {
  const result = (json as { result?: unknown })?.result ?? json
  const worktrees = ((result as { worktrees?: unknown })?.worktrees ?? []) as PsWorktree[]
  const agents: Agent[] = []
  for (const w of Array.isArray(worktrees) ? worktrees : []) {
    for (const a of (Array.isArray(w.agents) ? w.agents : []) as PsAgent[]) {
      const paneKey = String(a.paneKey ?? '')
      if (!paneKey) continue
      const sessionId = sessionOfPane(paneKey)
      const title = [a.conversationName, a.displayName, a.taskTitle, w.displayName, w.repo].find(t => typeof t === 'string' && t.trim()) as string | undefined
      const since = [a.stateStartedAt, a.updatedAt].find(t => typeof t === 'number') as number | undefined
      agents.push({
        sessionId: sessionId ?? paneKey,
        title: title?.trim() ?? sessionId ?? paneKey,
        workspaceId: String(w.worktreeId ?? ''),
        state: String(a.state ?? ''),
        since: since ?? 0,
        chat: !!sessionId,
      })
    }
  }
  return agents
}

// The text that closes a turn asks you something when its last lines hold a question.
const ASKS_RE =
  /\?|(?<!\p{L})(schválíš|schválit|tvoje ok|tvé ok|čekám na tebe|potřebuju od tebe|potřebuji od tebe|rozhodni|vyber si|mám to udělat|mám pokračovat)(?!\p{L})/iu

// The question a turn's closing prose ends on: its last sentence with "?" (or its last line).
export function questionOfProse(prose: string): string | undefined {
  const tail = prose.trim().split(/\n\s*\n/).slice(-2).join('\n')
  if (!ASKS_RE.test(tail)) return undefined
  const sentences = tail.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
  const q = [...sentences].reverse().find(s => s.includes('?')) ?? sentences.at(-1) ?? tail
  return q.trim().slice(0, 400)
}

export const replyId = (s: Pick<WindowState, 'turn' | 'since'>) => `t:${s.turn}:${s.since}`

// The windows waiting on you, oldest first. A window counts only while Orca lists its agent and its
// file is fresh; an answer you gave it (pending, by window → askId and when) hides it a while.
export function waitingOf(
  states: WindowState[],
  agents: Agent[],
  now: number,
  pending: Record<string, { askId: string; at: number }> = {},
): Waiting[] {
  const byId = new Map(agents.map(a => [`orca-${a.sessionId}`, a]))
  const out: Waiting[] = []
  for (const s of states) {
    const agent = byId.get(s.id)
    if (!agent || now - s.beat > STALE_MS) continue
    const base = { id: s.id, title: agent.title, workspaceId: agent.workspaceId, since: s.since }
    let row: Waiting | undefined
    if ((s.phase === 'asks' || s.phase === 'dialog') && s.ask) {
      row = { ...base, kind: 'dialog', askId: s.ask.id, text: s.ask.text, context: s.ask.context, options: s.ask.options, descriptions: s.ask.descriptions, parts: s.ask.parts }
    } else if (s.phase === 'done' && !s.peer && !s.aborted && s.prose) {
      const q = questionOfProse(s.prose)
      if (q) row = { ...base, kind: 'reply', askId: replyId(s), text: q, context: s.prose, options: [] }
    } else if (s.phase === 'approval' && s.approval && now - s.since >= APPROVAL_SHOW_MS) {
      row = { ...base, kind: 'approval', askId: '', text: `${s.approval.tool}: ${s.approval.summary}`, context: '', options: [] }
    }
    if (!row) continue
    const p = pending[s.id]
    if (p && p.askId === row.askId && now - p.at < PENDING_MS) continue
    out.push(row)
  }
  return out.sort((a, b) => a.since - b.since)
}

// What goes into the window's answer file. A button keeps its label; your own words are typed.
// A reply to prose is always your words; a question with parts needs one answer per part.
export function answerFor(w: Waiting, picks: { text: string; typed: boolean }[], at: number): Answer | undefined {
  if (w.kind === 'approval') return undefined
  const clean = picks.map(p => ({ text: p.text.trim(), typed: p.typed || w.kind === 'reply' }))
  if (!clean.length || clean.some(p => !p.text)) return undefined
  if (w.parts?.length) {
    if (clean.length !== w.parts.length) return undefined
    return { askId: w.askId, text: clean.map((p, i) => `${i + 1}) ${p.text}`).join(' '), typed: clean.some(p => p.typed), at, parts: clean }
  }
  if (clean.length !== 1) return undefined
  return { askId: w.askId, text: clean[0]!.text, typed: clean[0]!.typed, at }
}

// The overview of all windows under the questions: what works, what waits in its window, whose cache
// runs out soon (a turn ended 45–60 min ago: writing now is still cheap) and the rest.
export const CACHE_FROM_MS = 45 * 60_000
export const CACHE_MS = 60 * 60_000
export const RECENT_MS = CACHE_FROM_MS

export type Group = 'working' | 'blocked' | 'cache' | 'done' | 'older'
export type Row = { id: string; title: string; workspaceId: string; group: Group; label: string }

const minutes = (ms: number) => Math.max(0, Math.floor(ms / 60_000))
const ago = (ms: number) => {
  const m = minutes(ms)
  if (m < 1) return 'teď'
  if (m < 60) return `před ${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `před ${h} h` : `před ${Math.floor(h / 24)} d`
}

// Windows with a question in the cards above are left out; the rest sorted newest first in each group.
export function overviewOf(agents: Agent[], waitingIds: string[], now: number): Row[] {
  const asked = new Set(waitingIds)
  const rows: (Row & { at: number })[] = []
  for (const a of agents) {
    if (asked.has(`orca-${a.sessionId}`)) continue
    const age = a.since ? now - a.since : Infinity
    const base = { id: a.sessionId, title: a.title, workspaceId: a.workspaceId, at: a.since }
    if (a.state === 'working') rows.push({ ...base, group: 'working', label: a.since ? `pracuje ${minutes(age)} min` : 'pracuje' })
    else if (a.state === 'blocked' || a.state === 'waiting') rows.push({ ...base, group: 'blocked', label: `čeká v okně, ${ago(age)}` })
    else if (age >= CACHE_FROM_MS && age < CACHE_MS) rows.push({ ...base, group: 'cache', label: `cache končí za ${Math.max(1, Math.ceil((CACHE_MS - age) / 60_000))} min` })
    else if (age < RECENT_MS) rows.push({ ...base, group: 'done', label: `hotovo ${ago(age)}` })
    else rows.push({ ...base, group: 'older', label: Number.isFinite(age) ? ago(age) : '' })
  }
  const order: Group[] = ['blocked', 'cache', 'working', 'done', 'older']
  return rows
    .sort((x, y) => order.indexOf(x.group) - order.indexOf(y.group) || y.at - x.at)
    .map(({ at: _at, ...r }) => r)
}
