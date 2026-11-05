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
  return itemsOf(lines).some(item => item.start)
}

// The window's own lines of a tail, in order: what starts a turn, and its replies.
type Item = { start: true } | { start: false; uuid?: string; huge?: boolean; content: Block[] }

function itemsOf(lines: string[]): Item[] {
  const items: Item[] = []
  // A local command (/compact, /model…) runs no turn: its output and its name are skipped.
  // Read backwards: the output comes after the name.
  let inLocalCommand = false
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: Entry
    try {
      entry = JSON.parse(lines[i] ?? '') as Entry
    } catch {
      continue
    }
    if (entry.isSidechain) continue
    const content = entry.message?.content
    if (entry.type === 'assistant') {
      if (Array.isArray(content)) items.push({ start: false, uuid: entry.uuid, huge: entry.huge, content: content as Block[] })
      continue
    }
    if (entry.type !== 'user' || entry.isCompactSummary) continue
    const kind = entry.origin?.kind
    if (kind !== undefined) {
      if (STARTS_TURN.has(kind)) items.push({ start: true })
      continue
    }
    // Context the engine adds (a skill's text, a caveat): no turn of its own.
    if (entry.isMeta) continue
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
    items.push({ start: true })
  }
  return items.reverse()
}

// How the window's last turn ended. `lastReply` is the uuid of the window's last reply as the app
// records it (lastAssistantUuid): the turn counts only when the tail holds it, so a cut or stale
// tail reads as 'unknown', never as an older turn. Whatever starts a turn after that reply —
// even with replies of its own the app has not recorded yet — means the window moved on.
export function turnEnding(lines: string[], lastReply?: string): TurnEnding {
  const items = itemsOf(lines)
  let k = items.length - 1
  while (k >= 0 && (items[k]!.start || (lastReply !== undefined && (items[k] as { uuid?: string }).uuid !== lastReply))) k--
  if (k < 0) return { state: 'unknown' }
  if (items.slice(k + 1).some(item => item.start)) return { state: 'answered' }
  // The turn's replies, from what started it (or the tail's start: a turn longer than the tail,
  // whose end still says how it closed) to the end.
  let s = k
  while (s >= 0 && !items[s]!.start) s--
  const replies = items.slice(s + 1).filter((item): item is Extract<Item, { start: false }> => !item.start)
  // A reply too long to read whole (cut by the tail reader): how the turn closed is unknown.
  if (replies.some(r => r.huge)) return { state: 'unknown' }
  let box: { ask: BoxQuestion | null } | null = null
  let prose = ''
  // Read from the end: the last box and the last prose of the turn count.
  for (const reply of replies.reverse()) {
    for (const b of reply.content.slice().reverse()) {
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
  return { state: 'replied', box, prose }
}
