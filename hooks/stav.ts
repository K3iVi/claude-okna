// Each window reports its own state (0.9): its plugin writes ~/.claude/okna-stav/<window>.json from
// the window's own hooks, so the others read what the window knows instead of guessing from its
// transcript. One writer per file (the shared $.store is one file for every window). Pure functions
// here; the hooks and file access are in register.tsx.

export const STATE_DIR = '.claude/okna-stav'
export const ANSWER_DIR = '.claude/okna-stav/odpovedi'
export const STATE_VERSION = 1
// A file whose window has not touched it this long is not believed: its plugin is gone or stuck.
export const BEAT_MS = 30_000
export const STALE_MS = 120_000
// The app saw a turn end this much after the file's last change: a hook missed it, not believed.
export const EDGE_SLACK_MS = 30_000
// A permission prompt is shown only once it has stood this long (the auto mode settles its own fast).
export const APPROVAL_SHOW_MS = 15_000

export type Phase = 'working' | 'asks' | 'dialog' | 'approval' | 'done'

// A question the window waits on: `id` names it exactly (its turn and the call that asked), so an
// answer to an older one is never taken for this one.
// A dialog of several questions keeps each with its own buttons in `parts` (`text` then joins them,
// `options` stays empty for readers that know no parts).
// `descriptions`: the window's own words under each button (a dialog has them, a box not).
export type AskPart = { text: string; options: string[]; descriptions?: string[] }
export type Ask = { id: string; text: string; context: string; options: string[]; descriptions?: string[]; parts?: AskPart[] }
// How much of a box's recap (or a reply's closing prose) goes with a question: enough to decide.
export const CONTEXT_MAX = 1200

export type WindowState = {
  v: number
  plugin: string
  id: string
  turn: string
  // When the phase began, and when the window last wrote the file (it writes each BEAT_MS).
  since: number
  beat: number
  phase: Phase
  ask?: Ask
  approval?: { tool: string; summary: string }
  // 'done': whether the turn closed on a box, and its closing prose (the panel's guess).
  boxed?: boolean
  prose?: string
  aborted?: boolean
  // 'done': the turn began from another window's message (or a note about one), not from you.
  peer?: boolean
}

// What Centrála's plugin leaves for a window: your pick in its dialog, for the question `askId`.
// `typed`: written under "Other", not one of the window's buttons. For a question with parts, one
// answer per part in their order (`text` then joins them).
export type PartAnswer = { text: string; typed: boolean }
export type Answer = { askId: string; text: string; typed: boolean; at: number; parts?: PartAnswer[] }

export function parseState(text: string, id: string): WindowState | undefined {
  try {
    const s = JSON.parse(text) as Partial<WindowState>
    if (s.v !== STATE_VERSION || s.id !== id || typeof s.phase !== 'string') return undefined
    if (typeof s.since !== 'number' || typeof s.beat !== 'number' || typeof s.turn !== 'string') return undefined
    if ((s.phase === 'asks' || s.phase === 'dialog') && !isAsk(s.ask)) return undefined
    return s as WindowState
  } catch {
    return undefined
  }
}

const isAsk = (a: unknown): a is Ask =>
  !!a &&
  typeof (a as Ask).id === 'string' &&
  typeof (a as Ask).text === 'string' &&
  Array.isArray((a as Ask).options) &&
  ((a as Ask).parts === undefined ||
    (Array.isArray((a as Ask).parts) &&
      (a as Ask).parts!.every(p => !!p && typeof p.text === 'string' && Array.isArray(p.options))))

// Whether the file is what the window is doing now: written lately, and the app has seen no turn
// end since (a hook that failed leaves the file behind; the transcript then decides).
export function isTrusted(state: WindowState, now: number, lastTurnEdgeAt?: number): boolean {
  if (now - state.beat > STALE_MS) return false
  if (lastTurnEdgeAt && lastTurnEdgeAt > state.since + EDGE_SLACK_MS) return false
  return true
}

export function parseAnswer(text: string): Answer | undefined {
  try {
    const a = JSON.parse(text) as Partial<Answer>
    if (typeof a.askId !== 'string' || typeof a.text !== 'string' || !a.text.trim()) return undefined
    const answer: Answer = { askId: a.askId, text: a.text.trim(), typed: a.typed === true, at: typeof a.at === 'number' ? a.at : 0 }
    if (a.parts !== undefined) {
      if (!Array.isArray(a.parts)) return undefined
      const parts = a.parts.map(p => ({ text: typeof p?.text === 'string' ? p.text.trim() : '', typed: p?.typed === true }))
      if (!parts.length || parts.some(p => !p.text)) return undefined
      answer.parts = parts
    }
    return answer
  } catch {
    return undefined
  }
}

// Whether the window takes the answer: for the question it asks now, one of its buttons or what you
// typed yourself in Centrála's dialog.
export function acceptsAnswer(state: WindowState | undefined, answer: Answer): boolean {
  if (!state || (state.phase !== 'asks' && state.phase !== 'dialog') || !state.ask) return false
  if (state.ask.id !== answer.askId) return false
  const parts = state.ask.parts
  if (parts?.length) {
    // Every part answered, each by one of its buttons or in your own words.
    if (!answer.parts || answer.parts.length !== parts.length) return false
    return answer.parts.every((a, i) => a.typed || parts[i]!.options.length === 0 || parts[i]!.options.includes(a.text))
  }
  if (answer.parts) return false
  return answer.typed || state.ask.options.length === 0 || state.ask.options.includes(answer.text)
}

// The answer to a question with parts as one text: "1) … 2) …".
export const joinParts = (texts: readonly string[]) => texts.map((t, i) => `${i + 1}) ${t}`).join(' ')

type DialogOption = { label?: string; description?: string }
const kept = (q: { options?: readonly DialogOption[] }) => (q.options ?? []).filter(o => String(o.label ?? '').trim()).slice(0, 4)
const optionsOf = (q: { options?: readonly DialogOption[] }) => kept(q).map(o => String(o.label).trim())
// The buttons' descriptions, when any has one.
const descriptionsOf = (q: { options?: readonly DialogOption[] }) => {
  const d = kept(q).map(o => String(o.description ?? '').trim().slice(0, 300))
  return d.some(Boolean) ? { descriptions: d } : {}
}

type DialogInput = {
  questions?: readonly { question?: string; header?: string; options?: readonly { label?: string; description?: string }[] }[]
}

// A dialog's question as Centrála shows it: one question with its options; several as parts, each
// with its own options (Centrála asks them one by one).
export function askOfDialog(id: string, input: DialogInput): Ask {
  const qs = (input.questions ?? []).filter(q => typeof q.question === 'string' && q.question.trim())
  if (qs.length === 1) {
    const q = qs[0]!
    return { id, text: q.question!.trim().slice(0, 400), context: '', options: optionsOf(q), ...descriptionsOf(q) }
  }
  if (!qs.length) return { id, text: 'Okno se ptá v dialogu.', context: '', options: [] }
  const parts = qs.map(q => ({ text: q.question!.trim().slice(0, 400), options: optionsOf(q), ...descriptionsOf(q) }))
  return { id, text: joinParts(parts.map(p => p.text)).slice(0, 400), context: '', options: [], parts }
}

// The dialog's result for an answer from Centrála: the pick for each of its questions; one answer
// for several questions (from a window that knew no parts) as words.
export function dialogResult(
  input: DialogInput,
  answer: Pick<Answer, 'text' | 'parts'>,
): { questions: unknown; answers: Record<string, string>; response?: string } {
  const qs = (input.questions ?? []).filter(q => typeof q.question === 'string' && q.question.trim())
  if (qs.length === 1) return { questions: input.questions, answers: { [qs[0]!.question!]: answer.text } }
  if (answer.parts && answer.parts.length === qs.length) {
    return { questions: input.questions, answers: Object.fromEntries(qs.map((q, i) => [q.question!, answer.parts![i]!.text])) }
  }
  return { questions: input.questions, answers: {}, response: answer.text }
}

type BoxInput = { ask?: unknown; actions?: unknown; recap?: unknown }

// The question of the window's wrap_up box, as the transcript reader takes it; null when it asks none.
export function askOfBox(id: string, input: BoxInput): Ask | null {
  const ask = typeof input.ask === 'string' ? input.ask.trim() : ''
  if (!ask) return null
  const options = (Array.isArray(input.actions) ? input.actions : [])
    .filter(a => a && typeof a === 'object' && !(a as { action?: unknown }).action)
    .map(a => String((a as { label?: unknown }).label ?? '').trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 4)
  return { id, text: ask.slice(0, 400), context: typeof input.recap === 'string' ? input.recap.slice(0, CONTEXT_MAX) : '', options }
}

// The end of the reply's prose (what Centrála shows of a task, the panel's guess).
export const proseTail = (text: string) => (text.length > CONTEXT_MAX ? text.slice(-CONTEXT_MAX) : text)
