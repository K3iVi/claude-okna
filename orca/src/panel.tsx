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
  EmptyState,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  settings,
  Stack,
  Text,
  update,
  type PanelContext,
} from 'orca'

import type { Group, Row as WindowRow, Waiting } from './fronta'

// What the person set in Orca's Settings for this plugin (orca-plugin.json `contributes.settings`).
type Cfg = { textSize: 'xs' | 'sm'; overview: boolean; older: boolean; stripe: boolean; context: boolean; descriptions: boolean }
const DEFAULTS: Cfg = { textSize: 'xs', overview: true, older: true, stripe: true, context: true, descriptions: true }
const cfg = atom<Cfg>(DEFAULTS)
const sz = () => read(cfg).textSize

async function loadCfg() {
  const got = (await settings.get().catch(() => ({}))) as Partial<Record<keyof Cfg, unknown>>
  const next: Cfg = { ...DEFAULTS }
  if (got.textSize === 'xs' || got.textSize === 'sm') next.textSize = got.textSize
  for (const k of ['overview', 'older', 'stripe', 'context', 'descriptions'] as const) if (typeof got[k] === 'boolean') next[k] = got[k] as boolean
  set(cfg, next)
}

const waiting = atom<Waiting[] | null>(null)
const windows = atom<WindowRow[]>([])
// The overview of all windows can be folded away; the panel remembers it.
const showWindows = atom<boolean>('showWindows', true, { persist: 'plugin' })
const showOlder = atom<boolean>('showOlder', false, { persist: 'plugin' })
// Questions whose context you opened.
const contextOpen = atom<Record<string, boolean>>({})
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

// A small header that opens and closes what is under it, in the chosen text size.
function Fold({ title, note, open, onToggle }: { title: string; note?: string; open: boolean; onToggle: () => void }) {
  return (
    <Box direction="row" align="center" gap="xs">
      <Button variant="ghost" size={sz()} icon={open ? 'collapse' : 'expand'} onPress={onToggle}>
        {title}
      </Button>
      {note && (
        <Text size={sz()} muted truncate>
          {note}
        </Text>
      )}
    </Box>
  )
}

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
        <Text size={sz()} weight="medium">
          {title}
        </Text>
      </Row>
      <Text size={sz()} muted>
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
              <Text size={sz()} truncate>
                {r.title}
              </Text>
            </Box>
            <Box shrink={false}>
              <Text size={sz()} muted={r.group !== 'cache'} tone={r.group === 'cache' ? 'danger' : undefined}>
                {r.label.replace(/ /g, ' ')}
              </Text>
            </Box>
          </Box>
        </ListItem>
      ))}
    </List>
  )
}

// All windows at a glance, grouped by what they need; older ones folded. Settings can hide all of it,
// the older ones or the stripe.
function Windows() {
  const c = read(cfg)
  const all = read(windows)
  if (!c.overview) return null
  const rows = c.older ? all : all.filter(r => r.group !== 'older')
  if (!rows.length) return null
  const count = (g: Group) => rows.filter(r => r.group === g).length
  const summary = GROUPS.filter(g => g.group !== 'older' && count(g.group))
    .map(g => `${g.title.toLowerCase()} ${count(g.group)}`)
    .join(' · ')
  const older = rows.filter(r => r.group === 'older')
  const open = read(showWindows)
  return (
    <Stack gap="xs">
      {c.stripe && <Stripe rows={rows} />}
      <Fold title={`Okna (${rows.length})`} note={summary || undefined} open={open} onToggle={() => set(showWindows, !open)} />
      {open && (
        <Stack gap="xs">
          {GROUPS.filter(g => g.group !== 'older').map(g => {
            const these = rows.filter(r => r.group === g.group)
            return these.length ? (
              <Stack gap="none">
                <Heading group={g.group} title={g.title} n={these.length} />
                <Items rows={these} />
              </Stack>
            ) : null
          })}
          {older.length > 0 && (
            <Stack gap="none">
              <Fold title={`Dřív (${older.length})`} open={read(showOlder)} onToggle={() => set(showOlder, !read(showOlder))} />
              {read(showOlder) && <Items rows={older} />}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  )
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('fronta.changed', apply))
  ctx.subscriptions.push(settings.onDidChange(() => void loadCfg()))
  void loadCfg()
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
        <Text size={sz()} muted truncate>
          {w.title}
        </Text>
      </Box>
      <Box direction="row" shrink={false} gap="none">
        {w.kind !== 'approval' && w.options.length > 0 && !w.parts?.length && (
          <IconButton icon="edit" label="Jiná odpověď" variant="ghost" size={sz()} onPress={() => update(ownOpen, m => ({ ...m, [w.id]: !m[w.id] }))} />
        )}
        <IconButton icon="pause" label="Později" variant="ghost" size={sz()} onPress={() => update(later, keys => [...keys, keyOf(w)])} />
        <IconButton icon="open-external" label="Otevřít okno" variant="ghost" size={sz()} onPress={() => open(w)} />
      </Box>
    </Box>
  )
  if (w.kind === 'approval') {
    return (
      <Box border radius="md" padding="sm" gap="xs">
        {head}
        <Text size={sz()}>Čeká na schválení nástroje (jen v okně): {w.text}</Text>
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
              <Text size={sz()} weight="medium">
                {i + 1}/{w.parts!.length}: {p.text}
              </Text>
              <Row gap="xs" wrap>
                {p.options.map(o => (
                  <Button
                    size={sz()}
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
          <Button size={sz()} tone="accent" disabled={w.parts.some((_, i) => !picked[i])} onPress={() => void send(w, w.parts!.map((_, i) => picked[i]!))}>
            Odeslat
          </Button>
        </Stack>
      ) : (
        <Stack gap="xs">
          <Text size={sz()} weight="medium">
            {w.text}
          </Text>
          {w.options.length > 0 && (
            <Row gap="xs" wrap>
              {w.options.map((o, i) => (
                <Button size={sz()} tone={i === 0 ? 'accent' : 'neutral'} tooltip={(read(cfg).descriptions && w.descriptions?.[i]) || undefined} onPress={() => void send(w, [{ text: o, typed: false }])}>
                  {o}
                </Button>
              ))}
            </Row>
          )}
          {writing && <Own w={w} label={w.options.length ? 'Jiná odpověď…' : 'Tvoje odpověď…'} />}
        </Stack>
      )}
      {context && read(cfg).context && (
        <Stack gap="none">
          <Fold title="Kontext" open={!!read(contextOpen)[w.id]} onToggle={() => update(contextOpen, m => ({ ...m, [w.id]: !m[w.id] }))} />
          {read(contextOpen)[w.id] && (
            <Text size={sz()} muted>
              {context}
            </Text>
          )}
        </Stack>
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
        <Text size={sz()} weight="semibold">
          Čeká na tebe
        </Text>
        <Badge tone={shown.length ? 'warning' : 'neutral'}>{all === null ? '-' : String(shown.length)}</Badge>
      </Row>
      {n && <Callout tone="warning">{n}</Callout>}
      {msg && (
        <Text size={sz()} muted>
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
        <Button variant="ghost" size={sz()} onPress={() => set(later, [])}>
          Vrátit odložené ({hidden.size})
        </Button>
      )}
      <Windows />
    </Stack>
  )
}
