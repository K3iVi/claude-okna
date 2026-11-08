// Centrála in Orca: the questions your Claude windows wait on, with their own buttons. A press writes
// your answer for the window's Okna plugin, which puts it in as yours (or closes its dialog).
import {
  atom,
  Badge,
  Box,
  Button,
  IconButton,
  Image,
  Callout,
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
// Windows whose field for your own words you opened (the pencil).
const ownOpen = atom<Record<string, boolean>>({})

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

const open = (w: { workspaceId: string; title: string }) =>
  void plugin.request('fronta.open', { workspaceId: w.workspaceId }).then(
    out => !out.ok && set(message, `„${w.title}“: okno se nepodařilo otevřít${out.reason ? ` (${out.reason})` : ''}`),
    () => set(message, `„${w.title}“: okno se nepodařilo otevřít`),
  )

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
        <ListItem onPress={r.workspaceId ? () => open(r) : undefined}>
          <Box direction="row" justify="between" gap="sm">
            <Box grow minWidth={0}>
              <Text size="xs" truncate>
                {r.title}
              </Text>
            </Box>
            <Box shrink={false}>
              <Text size="xs" muted={r.group !== 'cache'} tone={r.group === 'cache' ? 'danger' : undefined}>
                {r.label.replace(/ /g, ' ')}
              </Text>
            </Box>
          </Box>
        </ListItem>
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

// One question, compact: the window's name with its actions on one line, the question and its buttons
// in small type; your own words and the context only when you open them.
function Question({ w }: { w: Waiting }) {
  const context = w.context && w.context.trim() !== w.text.trim() ? w.context : ''
  const writing = !!read(ownOpen)[w.id] || (w.kind === 'reply' && !w.options.length)
  const head = (
    <Box direction="row" justify="between" align="center" gap="xs">
      <Box grow minWidth={0}>
        <Text size="xs" muted truncate>
          {w.title}
        </Text>
      </Box>
      <Box direction="row" shrink={false} gap="none">
        {w.kind !== 'approval' && w.options.length > 0 && !w.parts?.length && (
          <IconButton icon="edit" label="Jiná odpověď" variant="ghost" size="xs" onPress={() => update(ownOpen, m => ({ ...m, [w.id]: !m[w.id] }))} />
        )}
        <IconButton icon="pause" label="Později" variant="ghost" size="xs" onPress={() => update(later, keys => [...keys, keyOf(w)])} />
        <IconButton icon="open-external" label="Otevřít okno" variant="ghost" size="xs" onPress={() => open(w)} />
      </Box>
    </Box>
  )
  if (w.kind === 'approval') {
    return (
      <Box border radius="md" padding="sm" gap="xs">
        {head}
        <Text size="xs">Čeká na schválení nástroje (jen v okně): {w.text}</Text>
      </Box>
    )
  }
  const picked = read(partPicks)[w.id] ?? []
  return (
    <Box border radius="md" padding="sm" gap="xs">
      {head}
      {w.parts?.length ? (
        <Stack gap="xs">
          {w.parts.map((p, i) => (
            <Stack gap="xs">
              <Text size="xs" weight="medium">
                {i + 1}/{w.parts!.length}: {p.text}
              </Text>
              <Row gap="xs" wrap>
                {p.options.map(o => (
                  <Button
                    size="xs"
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
          <Button size="xs" tone="accent" disabled={w.parts.some((_, i) => !picked[i])} onPress={() => void send(w, w.parts!.map((_, i) => picked[i]!))}>
            Odeslat
          </Button>
        </Stack>
      ) : (
        <Stack gap="xs">
          <Text size="xs" weight="medium">
            {w.text}
          </Text>
          {w.options.length > 0 && (
            <Row gap="xs" wrap>
              {w.options.map((o, i) => (
                <Button size="xs" tone={i === 0 ? 'accent' : 'neutral'} tooltip={w.descriptions?.[i] || undefined} onPress={() => void send(w, [{ text: o, typed: false }])}>
                  {o}
                </Button>
              ))}
            </Row>
          )}
          {writing && <Own w={w} label={w.options.length ? 'Jiná odpověď…' : 'Tvoje odpověď…'} />}
        </Stack>
      )}
      {context && (
        <Collapsible title="Kontext">
          <Text size="xs" muted>
            {context}
          </Text>
        </Collapsible>
      )}
    </Box>
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
