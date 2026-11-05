// How a window's last turn ended, read from its transcript's closing lines
// (~/.claude/projects/<folder>/<cliSessionId>.jsonl).

// The question of a wrap-up box: its ask, the recap above it and the replies its buttons send.
export type BoxQuestion = { text: string; context: string; options: string[] }

export type TurnEnding =
  // The window's last reply is in the tail: how that turn closed.
  | {
      state: 'replied'
      // The last wrap-up box of the turn: null when it closed without one; `ask` null when the
      // box asked nothing (the window said nothing waits on you).
      box: { ask: BoxQuestion | null } | null
      // The turn's closing prose, '' when none.
      prose: string
    }
  // Something the window answers came after its last reply (you, another session, a plugin,
  // a background task): it is on its next turn, nothing it asked still waits.
  | { state: 'answered' }
  // The tail does not show the window's last reply (cut off, not yet written, another file).
  | { state: 'unknown' }

type Block = { type?: string; name?: string; text?: string; input?: Record<string, unknown> }
type Entry = {
  type?: string
  uuid?: string
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  huge?: boolean
  origin?: { kind?: string }
  message?: { content?: unknown }
}

// Who starts a turn of the window: you, another session, a plugin's prompt, a background task.
const STARTS_TURN = new Set(['human', 'peer', 'plugin', 'task-notification'])
const MAX_TEXT = 400

const cut = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .filter(b => b?.type === 'text')
    .map(b => b.text ?? '')
    .join('\n')
}

// Whether the lines hold anything that starts a turn (you, another session, a plugin, a task):
// in a window's new CLI session after /clear, that you have moved on from its last reply.
export function startsAnyTurn(lines: string[]): boolean {
  return lines.some(line => {
    try {
      const entry = JSON.parse(line) as Entry
      if (entry.type !== 'user' || entry.isSidechain || entry.isCompactSummary) return false
      if (entry.origin?.kind !== undefined) return STARTS_TURN.has(entry.origin.kind)
      return !entry.isMeta && /\S/.test(textOf(entry.message?.content)) && !/^\s*<(local-command-|command-name>)/.test(textOf(entry.message?.content))
    } catch {
      return false
    }
  })
}

// Reads back from the end to what started the window's last turn. `lastReply` is the uuid of the
// window's last reply as the app records it (lastAssistantUuid): the turn counts only when the
// tail holds it, so a cut or stale tail reads as 'unknown', never as an older turn.
export function turnEnding(lines: string[], lastReply?: string): TurnEnding {
  let box: { ask: BoxQuestion | null } | null = null
  let prose = ''
  let seen = false
  let hasLastReply = !lastReply
  // A local command (/compact, /model…) runs no turn: its output and its name are skipped.
  let inLocalCommand = false
  // A turn's start came after every reply in the tail: answered, once the reply before it is the last one.
  let startAfter = false
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: Entry
    try {
      entry = JSON.parse(lines[i] ?? '') as Entry
    } catch {
      continue
    }
    if (entry.isSidechain) continue
    const content = entry.message?.content
    if (entry.type === 'user') {
      if (entry.isCompactSummary) continue
      const kind = entry.origin?.kind
      let startsTurn: boolean
      if (kind !== undefined) {
        startsTurn = STARTS_TURN.has(kind)
      } else if (entry.isMeta) {
        // Context the engine adds (a skill's text, a caveat): no turn of its own.
        startsTurn = false
      } else {
        const text = textOf(content)
        // A tool's result, not a prompt.
        if (!text) continue
        if (/^\s*<local-command-(stdout|stderr)>/.test(text)) {
          inLocalCommand = true
          continue
        }
        if (inLocalCommand && /^\s*<command-name>/.test(text)) {
          inLocalCommand = false
          continue
        }
        // Older transcripts name no origin: a text of its own starts a turn.
        startsTurn = true
      }
      if (!startsTurn) continue
      if (!seen) {
        startAfter = true
        continue
      }
      return hasLastReply ? { state: 'replied', box, prose } : { state: 'unknown' }
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue
    // The reply right before what came after it: the window's last one, or the tail is behind the app.
    if (startAfter) return !lastReply || entry.uuid === lastReply ? { state: 'answered' } : { state: 'unknown' }
    // A reply too long to read whole (cut by the tail reader): how it closed is unknown.
    if (entry.huge) return { state: 'unknown' }
    seen = true
    if (entry.uuid && entry.uuid === lastReply) hasLastReply = true
    // Read from the end: the last box and the last prose of the turn count.
    for (const b of (content as Block[]).slice().reverse()) {
      if (!prose && b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) prose = b.text.trim()
      if (box === null && b?.type === 'tool_use' && b.name === 'mcp__ccd_turn__wrap_up' && b.input) {
        const ask = typeof b.input.ask === 'string' ? b.input.ask.trim() : ''
        const actions = Array.isArray(b.input.actions) ? (b.input.actions as { label?: unknown; action?: unknown }[]) : []
        box = {
          ask: ask
            ? {
                text: cut(ask),
                context: cut(typeof b.input.recap === 'string' ? b.input.recap : ''),
                // An app action (commit, PR…) is no reply the window could be sent.
                options: actions
                  .filter(a => !a?.action && typeof a?.label === 'string' && a.label)
                  .map(a => cut(a.label as string, 120))
                  .slice(0, 4),
              }
            : null,
        }
      }
    }
  }
  // No start in the tail: the turn is longer than the tail. Its end still says how it closed.
  if (startAfter) return lastReply ? { state: 'unknown' } : { state: 'answered' }
  return seen && hasLastReply ? { state: 'replied', box, prose } : { state: 'unknown' }
}
