// A question a window asks you, as the central window shows it: the window's own buttons
// (its wrap-up box or its AskUserQuestion), or none when it asked in prose.
export type Question = {
  id: string
  title: string
  link: string
  turn: string
  question: string
  context: string
  options: string[]
  since: string
}

type Block = { type?: string; name?: string; input?: Record<string, unknown> }

// The question of the window's last turn, from its transcript's closing lines: the last
// wrap-up box with a question, or AskUserQuestion, after your last prompt. Undefined when none.
export function questionFromTail(lines: string[]): Pick<Question, 'question' | 'context' | 'options'> | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; isMeta?: boolean; message?: { content?: unknown } }
    try {
      entry = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    const content = entry.message?.content
    if (entry.type === 'user' && !entry.isMeta) {
      // Your own prompt: whatever was asked before it is answered.
      if (typeof content === 'string') return undefined
      if (Array.isArray(content) && content.some((b: Block) => b?.type === 'text')) return undefined
      continue
    }
    if (entry.type !== 'assistant' || !Array.isArray(content)) continue
    for (const b of content as Block[]) {
      if (b?.type !== 'tool_use' || !b.input) continue
      if (b.name === 'mcp__ccd_turn__wrap_up' && typeof b.input.ask === 'string' && b.input.ask) {
        const actions = Array.isArray(b.input.actions) ? (b.input.actions as { label?: unknown; action?: unknown }[]) : []
        return {
          question: b.input.ask,
          context: typeof b.input.recap === 'string' ? b.input.recap : '',
          // An app action (commit, PR…) is no reply the window could be sent.
          options: actions.filter(a => !a?.action && typeof a?.label === 'string').map(a => a.label as string),
        }
      }
      if (b.name === 'AskUserQuestion' && Array.isArray(b.input.questions) && b.input.questions[0]) {
        const q = b.input.questions[0] as { question?: unknown; options?: { label?: unknown }[] }
        return {
          question: String(q.question ?? ''),
          context: '',
          options: (q.options ?? []).map(o => String(o?.label ?? '')).filter(Boolean),
        }
      }
    }
  }
  return undefined
}
