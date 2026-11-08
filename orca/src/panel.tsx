// Centrála in Orca: the questions your Claude windows wait on, with their own buttons. A press writes
// your answer for the window's Okna plugin, which puts it in as yours (or closes its dialog).
import {
  atom,
  Badge,
  Box,
  Button,
  Image,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  update,
  type PanelContext,
} from 'orca'

import type { Group, Row as WindowRow, Waiting } from './fronta'

const waiting = atom<Waiting[] | null>(null)
const windows = atom<WindowRow[]>([])
// The overview of all windows can be folded away; the panel remembers it.
const showWindows = atom<boolean>('showWindows', true, { persist: 'plugin' })
const note = atom('')
const message = atom('')
// Questions you set aside here ("Později"), by window and question; they come back when the window asks anew.
const later = atom<string[]>('later', [], { persist: 'plugin' })
// A question with parts: what you picked per part so far, by window.
const partPicks = atom<Record<string, ({ text: string; typed: boolean } | undefined)[]>>({})
const typedText = atom<Record<string, string>>({})

const keyOf = (w: Waiting) => `${w.id}|${w.askId}`

function apply(payload: { waiting: Waiting[]; windows: WindowRow[]; note: string }) {
  set(waiting, payload.waiting)
  set(windows, payload.windows ?? [])
  set(note, payload.note)
  // A question that is gone needs no "Později" any more.
  const live = new Set(payload.waiting.map(keyOf))
  update(later, keys => keys.filter(k => live.has(k)))
}

async function send(w: Waiting, picks: { text: string; typed: boolean }[]) {
  const out = await plugin.request('fronta.answer', { id: w.id, askId: w.askId, picks })
  set(message, out.ok ? `„${w.title}“ ← ${picks.map(p => p.text).join(' / ')}` : `„${w.title}“: ${out.reason ?? 'neodesláno'}`)
  update(partPicks, m => ({ ...m, [w.id]: [] }))
  update(typedText, m => ({ ...m, [w.id]: '' }))
}

const open = (w: { workspaceId: string }) => void plugin.request('fronta.open', { workspaceId: w.workspaceId })

// Each group has its colour (assets/<group>.png), as in the Okna panel of the Claude app: a square
// at its heading and its share of the stripe above the list.
const GROUPS: { group: Group; title: string }[] = [
  { group: 'blocked', title: 'Čeká v okně' },
  { group: 'cache', title: 'Končí cache' },
  { group: 'working', title: 'Pracuje' },
  { group: 'done', title: 'Hotovo' },
  { group: 'older', title: 'Dřív' },
]

function Stripe({ rows }: { rows: WindowRow[] }) {
  return (
    <Box direction="row" height={6} radius="full" gap="none">
      {GROUPS.map(g => {
        const n = rows.filter(r => r.group === g.group).length
        return n ? (
          <Box width={`${Math.max(1, Math.round((100 * n) / rows.length))}%`} height={6}>
            <Image src={`assets/${g.group}.png`} alt="" size="full" fit="cover" />
          </Box>
        ) : null
      })}
    </Box>
  )
}

function Heading({ group, title, n }: { group: Group; title: string; n: number }) {
  return (
    <Row justify="between">
      <Row gap="xs">
        <Box width={10} height={10}>
          <Image src={`assets/${group}.png`} alt="" size="full" fit="cover" />
        </Box>
        <Text size="sm" weight="medium">
          {title}
        </Text>
      </Row>
      <Text size="sm" muted>
        {String(n)}
      </Text>
    </Row>
  )
}

function Items({ rows }: { rows: WindowRow[] }) {
  return (
    <List>
      {rows.map(r => (
        <ListItem title={r.title} description={r.label} onPress={r.workspaceId ? () => open(r) : undefined} />
      ))}
    </List>
  )
}

// All windows at a glance, grouped by what they need; older ones folded.
function Windows() {
  const rows = read(windows)
  if (!rows.length) return null
  const count = (g: Group) => rows.filter(r => r.group === g).length
  const summary = GROUPS.filter(g => g.group !== 'older' && count(g.group))
    .map(g => `${g.title.toLowerCase()} ${count(g.group)}`)
    .join(' · ')
  const older = rows.filter(r => r.group === 'older')
  return (
    <Stack gap="xs">
      <Stripe rows={rows} />
    <Collapsible title={`Okna (${rows.length})`} description={summary || undefined} open={read(showWindows)} onChange={v => set(showWindows, v)}>
      <Stack gap="sm">
        {GROUPS.filter(g => g.group !== 'older').map(g => {
          const these = rows.filter(r => r.group === g.group)
          return these.length ? (
            <Stack gap="xs">
              <Heading group={g.group} title={g.title} n={these.length} />
              <Items rows={these} />
            </Stack>
          ) : null
        })}
        {older.length > 0 && (
          <Collapsible title={`Dřív (${older.length})`}>
            <Items rows={older} />
          </Collapsible>
        )}
      </Stack>
    </Collapsible>
    </Stack>
  )
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('fronta.changed', apply))
  void plugin.request('fronta.get').then(apply)
}

function Own({ w, label }: { w: Waiting; label: string }) {
  const text = read(typedText)[w.id] ?? ''
  return (
    <Input
      label={label}
      labelHidden
      placeholder={label}
      value={text}
      onChange={v => update(typedText, m => ({ ...m, [w.id]: v }))}
      onSubmit={v => v.trim() && void send(w, [{ text: v, typed: true }])}
    />
  )
}

function Question({ w }: { w: Waiting }) {
  const context = w.context && w.context.trim() !== w.text.trim() ? w.context : ''
  const actions = (
    <Row gap="xs" wrap>
      <Button variant="ghost" size="sm" onPress={() => update(later, keys => [...keys, keyOf(w)])}>
        Později
      </Button>
      <Button variant="ghost" size="sm" icon="open-external" onPress={() => open(w)}>
        Otevřít okno
      </Button>
    </Row>
  )
  if (w.kind === 'approval') {
    return (
      <Card title={w.title}>
        <Stack gap="xs">
          <Text>Čeká na schválení nástroje (jen v okně): {w.text}</Text>
          {actions}
        </Stack>
      </Card>
    )
  }
  const picked = read(partPicks)[w.id] ?? []
  return (
    <Card title={w.title}>
      <Stack gap="sm">
        {w.parts?.length ? (
          <Stack gap="sm">
            {w.parts.map((p, i) => (
              <Stack gap="xs">
                <Text weight="medium">
                  {i + 1}/{w.parts!.length}: {p.text}
                </Text>
                <Row gap="xs" wrap>
                  {p.options.map(o => (
                    <Button
                      size="sm"
                      variant={picked[i]?.text === o ? 'solid' : 'outline'}
                      onPress={() =>
                        update(partPicks, m => {
                          const next = [...(m[w.id] ?? [])]
                          next[i] = { text: o, typed: false }
                          return { ...m, [w.id]: next }
                        })
                      }
                    >
                      {o}
                    </Button>
                  ))}
                </Row>
              </Stack>
            ))}
            <Button
              tone="accent"
              disabled={w.parts.some((_, i) => !picked[i])}
              onPress={() => void send(w, w.parts!.map((_, i) => picked[i]!))}
            >
              Odeslat
            </Button>
          </Stack>
        ) : (
          <Stack gap="xs">
            <Text weight="medium">{w.text}</Text>
            {w.options.length > 0 && (
              <Row gap="xs" wrap>
                {w.options.map((o, i) => (
                  <Button size="sm" tone={i === 0 ? 'accent' : 'neutral'} tooltip={w.descriptions?.[i] || undefined} onPress={() => void send(w, [{ text: o, typed: false }])}>
                    {o}
                  </Button>
                ))}
              </Row>
            )}
            {!w.parts?.length && <Own w={w} label={w.options.length ? 'Jiná odpověď…' : 'Tvoje odpověď…'} />}
          </Stack>
        )}
        {context && (
          <Collapsible title="Kontext">
            <Text size="sm" muted>
              {context}
            </Text>
          </Collapsible>
        )}
        {actions}
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const all = read(waiting)
  const hidden = new Set(read(later))
  const shown = (all ?? []).filter(w => !hidden.has(keyOf(w)))
  const msg = read(message)
  const n = read(note)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Text weight="semibold">Čeká na tebe</Text>
        <Badge tone={shown.length ? 'warning' : 'neutral'}>{all === null ? '-' : String(shown.length)}</Badge>
      </Row>
      {n && <Callout tone="warning">{n}</Callout>}
      {msg && (
        <Text size="sm" muted>
          {msg}
        </Text>
      )}
      {all !== null && shown.length === 0 && (
        <EmptyState title="Nic nečeká" description={hidden.size ? `Odloženo: ${hidden.size}` : undefined} icon="check" />
      )}
      {shown.map(w => (
        <Question w={w} />
      ))}
      {hidden.size > 0 && shown.length > 0 && (
        <Button variant="ghost" size="sm" onPress={() => set(later, [])}>
          Vrátit odložené ({hidden.size})
        </Button>
      )}
      <Windows />
    </Stack>
  )
}
