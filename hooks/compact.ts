// A window compacted by the hlidac-compact plugin: after each compact it leaves
// ~/.claude/hlidac-compact/compacty/<sessionId>.json, one JSON line. Read defensively:
// a missing or damaged file means no mark.

export const COMPACT_DIR = '.claude/hlidac-compact/compacty'
export const COMPACT_MAX_AGE_MS = 24 * 3_600_000

export type Compact = { at: string; idleMin?: number; before?: number; after?: number | null }

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

// The compact the file tells of, or undefined when it is damaged, from the future or older than a day.
export function parseCompact(text: string, now: number): Compact | undefined {
  try {
    const line = text.split('\n').find(l => l.trim())
    const data = JSON.parse(line ?? '') as Record<string, unknown>
    const at = typeof data.at === 'string' ? Date.parse(data.at) : NaN
    if (!Number.isFinite(at) || now - at > COMPACT_MAX_AGE_MS || at - now > 3_600_000) return undefined
    const idleMin = count(data.idleMin)
    const before = count(data.before)
    const after = data.after === null ? null : count(data.after)
    return {
      at: new Date(at).toISOString(),
      ...(idleMin !== undefined ? { idleMin } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    }
  } catch {
    return undefined
  }
}

// "HH:MM" local time of the compact.
export const compactTime = (c: Compact) =>
  new Date(c.at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
