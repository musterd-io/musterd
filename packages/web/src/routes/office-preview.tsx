import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { MusterdWord } from '../brand/MusterdWord';
import { memberColor } from '../live/format';
import { CaptionPill } from '../live/CaptionPill';
import { isStill } from '../live/stillMode';
import type { Caption } from '../live/captions';
import type { Envelope, MemberSummary } from '@musterd/protocol';
import { buildEnvelope } from '@musterd/protocol/wire';
import { deriveAsks } from '../live/asks';
import type { sendAct } from '../live/client';
import type { OfficeData, OfficeEvent, OfficeHandle, OfficeNode } from '../live/office-scene';
import { spritesFromUrl } from './broadcast';
import { projectWallBoard } from '../live/office-scene/wallboard';
import type { DeskWaiting } from '../live/office-scene/deskWaiting';

// `?promptbar`: the /live composer on the preview floor, so it can be looked at without a signed-in
// admin seat (on /live it mounts only for one). There is no daemon here, so its sends go to a fake that
// answers on a script: one seat replies on the thread, one by `in_reply_to` only (ghost's shape in
// rehearsal 1), one asks nick something, and wanderer stays asleep, so every thread state shows.
const PREVIEW_ROSTER = (
  [
    ['nick', 'human', 'online'],
    ['dolly', 'agent', 'online'],
    ['big-body', 'agent', 'online'],
    ['ghost', 'agent', 'offline'],
    ['wanderer', 'agent', 'offline'],
    ['miley', 'agent', 'online'],
    ['stanley', 'agent', 'offline'],
  ] as const
).map(([name, kind, presence], i) => ({ name, kind, presence, hue: (i * 47) % 360 })) as unknown as MemberSummary[];
const LazyPromptBar = lazy(() =>
  import('../live/PromptBar').then((m) => ({ default: m.PromptBar })),
);
type SendInput = Parameters<typeof sendAct>[1];
const PREVIEW_SCRIPT: { after: number; from: string; act: Envelope['act']; body: string; how: 'thread' | 'reply_to'; meta?: Record<string, unknown> }[] = [
  { after: 2500, from: 'dolly', act: 'message', how: 'thread', body: 'On it: install, then the tour. Draft copy in an hour.', meta: { model: 'claude-opus-5-5' } },
  { after: 5200, from: 'ghost', act: 'message', how: 'reply_to', body: 'Woke up for this. Install still asks for a port on a fresh laptop. Fix that first.', meta: { model: 'gpt-6' } },
  { after: 7800, from: 'big-body', act: 'ask', how: 'thread', body: 'Can I ship the port fix today? It touches daemon config.', meta: { model: 'claude-sonnet-5-5', species: 'approve', tier: 'standard' } },
];
/** The fake wire, in `pnpm dev` only: production builds drop it (`import.meta.env.DEV` is a constant),
 *  so the shipped preview carries none of it and its sends fail into the error state, as before. */
function scriptedSend(add: (e: Envelope) => void) {
  return async (_cfg: unknown, input: SendInput): Promise<Envelope> => {
    const env = { ...buildEnvelope({ id: crypto.randomUUID(), team: 'preview', from: 'nick', body: input.body ?? '', thread: input.thread ?? null, meta: input.meta ?? null, to: input.to, act: input.act }), ts: Date.now() } as Envelope;
    if (env.meta?.['huddle']) {
      for (const line of PREVIEW_SCRIPT) {
        window.setTimeout(() => {
          const reply = buildEnvelope({
            id: crypto.randomUUID(),
            team: 'preview',
            from: line.from,
            to: { kind: 'member', name: 'nick' },
            act: line.act,
            body: line.body,
            thread: line.how === 'thread' ? env.id : null,
            meta: line.how === 'reply_to' ? { ...line.meta, in_reply_to: env.id } : (line.meta ?? null),
          });
          add({ ...reply, ts: Date.now() } as Envelope);
        }, line.after);
      }
    }
    return env;
  };
}
const fakeSend = import.meta.env.DEV ? scriptedSend : null;
function PreviewPromptBar() {
  const [on, setOn] = useState(false);
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  useEffect(() => setOn(new URLSearchParams(window.location.search).has('promptbar')), []);
  const add = useCallback((e: Envelope) => setEnvelopes((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e])), []);
  const send = useMemo(() => fakeSend?.(add), [add]);
  const asks = useMemo(() => deriveAsks(envelopes), [envelopes]);
  if (!on) return null;
  return (
    <Suspense fallback={null}>
      <LazyPromptBar
        cfg={{ team: 'preview', as: 'nick', token: 'preview' }}
        roster={PREVIEW_ROSTER}
        viewer="nick"
        envelopes={envelopes}
        asks={asks}
        onSent={add}
        {...(send ? { send: send as typeof sendAct } : {})}
      />
    </Suspense>
  );
}

export const Route = createFileRoute('/office-preview')({
  head: () => ({
    meta: [{ title: 'musterd — office preview' }],
    links: [
      { rel: 'stylesheet', href: liveCss },
      { rel: 'stylesheet', href: brandCss },
    ],
  }),
  component: OfficePreviewPage,
});

/* Synthetic fixture — no live daemon. Mounts the office scene directly and drives it with a looping
   act script so the walk/handoff/megaphone choreography plays on its own, plus roster controls (join /
   leave / away) that exercise the presence transitions — arrivals walk in, departures walk out, away
   drifts to the nook. Design fixture; also how the motion is verified in a real browser. */

type Kind = 'agent' | 'human';
type Mock = {
  name: string;
  kind: Kind;
  /** A `kind: 'service'` ledger seat (ADR 232) — drawn as an agent, nameplated as a service. */
  service?: true;
  activity: OfficeData['nodes'][number]['activity'];
  state: string | null;
};

const POOL: Mock[] = [
  { name: 'Ada', kind: 'human', activity: 'working', state: 'reviewing the isometric office' },
  { name: 'Bo', kind: 'agent', activity: 'working', state: 'porting the floor renderer' },
  { name: 'Cy', kind: 'human', activity: 'working', state: 'wiring the firehose subscribe' },
  { name: 'Dev', kind: 'agent', activity: 'active', state: null },
  { name: 'Eli', kind: 'human', activity: 'working', state: 'writing the seating tests' },
  { name: 'Fen', kind: 'agent', activity: 'working', state: 'watching the deploy' },
  { name: 'Gus', kind: 'human', activity: 'active', state: null },
  { name: 'Hana', kind: 'agent', activity: 'working', state: 'profiling the render loop' },
  { name: 'Ivy', kind: 'human', activity: 'working', state: 'designing the character rig' },
  // The service seat — the nameplate's "service" tag can only be eyeballed (and contrast-measured)
  // here if the fixture actually seats one (same argument as the varied FIXTURE_IDENTITY above).
  { name: 'Jib', kind: 'agent', service: true, activity: 'active', state: null },
];

/**
 * More colleagues for `?n` past the hand-written roster (ADR 617): the density bar is about a room of
 * twelve SEATED members, and the ten above only seat six (three are active-but-idle, one is away).
 * All working agents, so each takes a desk.
 */
const EXTRA: Mock[] = ['Kai', 'Lux', 'Mo', 'Nia', 'Oz', 'Pip', 'Quin', 'Rue'].map((name) => ({
  name,
  kind: 'agent',
  activity: 'working',
  state: 'tidying a lane',
}));
const ROSTER: Mock[] = [...POOL, ...EXTRA];

/**
 * The seat a wake put in the room (ADR 131), for the same reason Jib is a service seat: a state the
 * fixture cannot reach is a state reviewed for the first time in production.
 *
 * A woken seat is the hardest one to catch by waiting, not the easiest — the measured window on a
 * real codex wake was ELEVEN SECONDS (claim 14:19:04 → ws_close 14:19:15), which is why the lane
 * exists at all. `Dev` is deliberately an `active` agent rather than a `working` one: the point is
 * that provenance is orthogonal to posture, and pinning it to a busy seat would let the two read as
 * the same fact.
 */
const WOKEN: ReadonlySet<string> = new Set(['Dev']);

/**
 * Harness + model per fixture member. Deliberately varied, including a long id and a `null` model:
 * the nameplate's provider icon + expand detail have to survive both the widest label it will ever
 * see and the seat that has nothing to report. Roles are real role-library ids, so the plate's role
 * (`occupation.ts`) shows on some plates and not on others, as it does on the real floor.
 */
const FIXTURE_IDENTITY: Record<string, { surface: string; model: string | null; role?: string }> = {
  Ada: { surface: 'claude-code', model: 'claude-opus-5', role: 'security' },
  Bo: { surface: 'codex', model: 'gpt-6-luna', role: 'engineer' },
  Cy: { surface: 'codex', model: 'gpt-5.6-terra-medium', role: 'comms' },
  Dev: { surface: 'cli', model: null },
  Eli: { surface: 'claude-code', model: 'gemini-3.2-pro', role: 'researcher' },
  Fen: { surface: 'web', model: 'grok-4.5', role: 'founder' },
  Gus: { surface: 'opencode', model: 'beam-free' },
  Hana: { surface: 'opencode', model: 'moonshotai/kimi-k3', role: 'engineer' },
  Ivy: { surface: 'opencode', model: 'longcat-2.5-preview-free', role: 'designer' },
  // The service seat: no model BY KIND (pure code, nothing to attest) — distinct from Dev's
  // null-model agent, which is a seat that merely has nothing to report.
  Jib: { surface: 'cli', model: null, role: 'platform' },
  // The `?n` extras, with roles, so a crowded room (lane 01M5G7A9H1) wears the plates a real one does.
  Kai: { surface: 'claude-code', model: 'claude-opus-5-5', role: 'engineer' },
  Lux: { surface: 'codex', model: 'gpt-6-luna', role: 'engineer' },
  Mo: { surface: 'claude-code', model: 'claude-opus-5-5', role: 'researcher' },
  Nia: { surface: 'cli', model: 'claude-sonnet-5-5', role: 'platform' },
  Oz: { surface: 'opencode', model: 'beam-free', role: 'engineer' },
  Pip: { surface: 'claude-code', model: 'claude-opus-5-5', role: 'comms' },
  Quin: { surface: 'grok', model: 'grok-4.7', role: 'engineer' },
  Rue: { surface: 'claude-code', model: 'claude-opus-5-5', role: 'security' },
};

// A looping choreography script (ms offset → event), so the room is always alive on the preview.
const SCRIPT: { at: number; ev: OfficeEvent }[] = [
  { at: 200, ev: { kind: 'walk-help', from: 'Ada', to: ['Bo'], tier: 'needs-attn' } },
  {
    at: 300,
    ev: {
      kind: 'speech',
      who: 'Cy',
      text: 'anyone seen the flaky seating test? it fails ~1 in 5 for me',
      tone: 'accent',
      // An addressed bubble early in the loop, so the chip is visible when someone is WATCHING the
      // room. It is not the one the gate measures: Cy speaks again at 6700, and one bubble per member
      // means this one is superseded long before the sweep's shutter — Bo's at 7500 is the survivor.
      // An ADR 254 eligible set, deliberately: this is the shape /live carries most (28 of the 35
      // in the live corpus are review routing), and the design tool must be able to draw the state
      // the room actually receives — a chip naming the set, and a trace to each desk.
      addressee: { names: ['Hana', 'Bo'], label: 'Hana or Bo', tether: true },
    },
  },
  { at: 500, ev: { kind: 'walk-handoff', from: 'Eli', to: 'Hana', label: 'floor.ts' } },
  // Cy's bubble at 200ms names an eligible set ("Hana or Bo"), and the walk it describes visits
  // BOTH desks in turn — the design tool draws the multi-stop trip /live actually receives. Both
  // names are members who are ON the floor by default: `Fen` is in the default `offline` set above,
  // so a leg to Fen never plays and the tool would show a one-stop trip while claiming two.
  { at: 1100, ev: { kind: 'walk-help', from: 'Cy', to: ['Hana', 'Bo'], tier: 'urgent' } },
  { at: 1800, ev: { kind: 'megaphone', from: 'Ivy' } },
  {
    at: 2000,
    ev: {
      kind: 'speech',
      who: 'Ivy',
      text: 'shipping the character rig — hair variety is in review',
      tone: 'status',
    },
  },
  { at: 2400, ev: { kind: 'screen-pulse', who: 'Hana', tone: 'status' } },
  {
    at: 2500,
    ev: { kind: 'speech', who: 'Hana', text: 'profiling the render loop', tone: 'status' },
  },
  { at: 3000, ev: { kind: 'walk-handoff', from: 'Bo', to: 'Ivy', label: 'render.ts' } },
  // The acceptance celebration (liveliness inc 1): Eli's work accepted by Ada — confetti over Eli,
  // a green thread from Ada, the desk neighbors glancing over. Directed, so `of` carries the celebrant.
  { at: 3400, ev: { kind: 'accept', who: 'Ada', of: 'Eli' } },
  { at: 3600, ev: { kind: 'resolve', who: 'Fen' } },
  {
    at: 3700,
    ev: {
      kind: 'speech',
      who: 'Fen',
      text: 'fixed — resolving the thread',
      tone: 'success',
      marking: { mark: 'done', holds: false }, // DONE — badge only (✓)
    },
  },
  // `decline` and `wait` complete the set: every other kind `actToEvent` can produce from a real
  // envelope was already scripted here, but these two were not — so two states a viewer of /live can
  // genuinely hit had never been drawn on the one route the office is reviewed and contrast-swept on
  // (miley, 2026-08-20). Declining and pausing are ordinary things for a seat to do.
  { at: 7400, ev: { kind: 'decline', who: 'Bo' } },
  {
    at: 7500,
    ev: {
      kind: 'speech',
      who: 'Bo',
      text: "not taking this one — it needs the seating fix first, and that's not mine",
      // The tones mirror what actTone() would really return for these acts on /live: decline is
      // `danger`, wait is `info`. A fixture that invents its own tone teaches the wrong room.
      tone: 'danger',
      // THE MEASURED CHIP. Bo speaks exactly once in the script, so this bubble is still standing at
      // the sweep's shutter — verified 2026-08-20, the sweep emits an `lc-speech__to` row keyed
      // `rgb(90,78,63)` over its own 9% tone wash, and /office-preview stays 0 below AA. A declined
      // handoff is also the honest place for a recipient chip: "not taking this one" needs a "from
      // whom" or it is unreadable.
      addressee: { names: ['Eli'], label: 'Eli', tether: true },
    },
  },
  /* THE TOP OF THE MARK AXIS, and it had no fixture at all until now: a `blocking` to-human ask
     (ADR 147). Every other act family in this script was reachable here and this one — the single
     loudest thing the room can show, and the only bubble that pulses — could only be seen by
     waiting for a real seat to raise one on /live. Same argument that put `decline` and `wait` in
     this script on 2026-08-20: a state the design tool cannot reach is a state nobody has looked at.
     `holds: true` is what `askTierHolds('blocking')` returns — the seat has stopped until a person
     answers, which is what earns the pulse over the heavy ring an ordinary ask gets. */
  { at: 8400, ev: { kind: 'walk-help', from: 'Hana', to: ['Ada'], tier: 'urgent' } },
  {
    at: 8500,
    ev: {
      kind: 'speech',
      who: 'Hana',
      text: 'this drops the production index — I am holding until a human says go',
      tone: 'accent',
      marking: { mark: 'needs-human', holds: true },
      addressee: { names: ['Ada'], label: 'Ada', tether: true },
    },
  },
  /* And its quiet sibling, so the two are comparable side by side rather than one at a time: an
     acceptance request is also an ask, also needs a person, and does NOT hold anyone — `approve`
     species, so it reads as REVIEW (a badge, no heavy ring). Getting these two the same volume is
     the mistake the tier split exists to prevent. */
  {
    at: 8900,
    ev: {
      kind: 'speech',
      who: 'Eli',
      text: 'lane 01M1J4XV6D is ready — judge the landed outcome when you get a minute',
      tone: 'accent',
      marking: { mark: 'review', holds: false },
      addressee: { names: ['Cy', 'Dev'], label: 'Cy or Dev', tether: true },
    },
  },
  { at: 8000, ev: { kind: 'wait', who: 'Ivy' } },
  {
    at: 8100,
    ev: {
      kind: 'speech',
      who: 'Ivy',
      text: 'holding until the rig review lands',
      tone: 'info',
    },
  },
  { at: 4200, ev: { kind: 'note', from: 'Ada', to: ['Cy'], tone: 'info' } },
  // Steering trio (ADR 103): a challenge questions a direction, an interrupt-class steer redirects it,
  // and a defer pushes a Goal later — a board-wide pulse.
  { at: 4700, ev: { kind: 'challenge', from: 'Dev', to: ['Bo'], urgent: false } },
  {
    at: 4800,
    ev: {
      kind: 'speech',
      who: 'Dev',
      text: 'why render.ts before the seating fix? can you justify the order?',
      tone: 'challenge',
      marking: { mark: 'interrupt', holds: false }, // INTERRUPT — heavy ring + ↪
    },
  },
  { at: 5600, ev: { kind: 'steer', from: 'Ada', to: 'Hana', urgent: true } },
  {
    at: 5700,
    ev: {
      kind: 'speech',
      who: 'Ada',
      text: 'change of plan — drop the profiling, the deploy is what matters now',
      tone: 'steer',
      // INTERRUPT — heavy ring + ↪. The fixture has to carry the marks or nobody ever looks at
      // them: this route is the design loop AND the surface the contrast sweep measures, and a
      // state it cannot reach is a state that gets reviewed for the first time in production. The
      // markings here are what `speechMark` really returns for these acts — a fixture that invents
      // its own teaches the wrong room, the same rule the `tone` values above already follow.
      marking: { mark: 'interrupt', holds: false },
    },
  },
  { at: 6600, ev: { kind: 'defer', who: 'Cy' } },
  {
    at: 6700,
    ev: {
      kind: 'speech',
      who: 'Cy',
      text: 'deferring the firehose Goal to next wave',
      tone: 'lane',
    },
  },
];
/** A fixture member's kind, for the caption dot's colour — the pool is the roster here. */
const kindOfMock = (name: string): Kind => ROSTER.find((m) => m.name === name)?.kind ?? 'agent';

const LOOP = 5600;

/**
 * One narrated moment per act family — the fixture for the caption pill's five tones. Real captions
 * are composed from real envelopes (`captionFor`), which this route never has: it fires scene events
 * directly. Written out here so the pill's colours are reachable in the design loop instead of only
 * when the matching act happens to occur on `/live`.
 */
const CAPTIONS: Caption[] = [
  { text: 'Ada is handing work to Bo', who: 'Ada', tone: 'handoff' },
  { text: "Cy accepted Dev's work — it's done", who: 'Cy', tone: 'accept' },
  { text: 'Eli is asking Fen to approve something', who: 'Eli', tone: 'ask' },
  { text: 'Hana is redirecting the team', who: 'Hana', tone: 'steer' },
  { text: 'Ivy just walked in', who: 'Ivy', tone: 'presence' },
];

// This dev-fixture page reads its scenario from `?n=/?idle=/?stale=` query params, but its
// useState initializers run during SSR prerender too — where `window` is undefined. On the
// server there are no params anyway, so resolve to an empty query there.
const previewSearch = () =>
  new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);

/**
 * `?board` — a board as full as a busy team's (ADR 751): six goals, about eighty lanes across every
 * column, so the wall's goal rows, tabs and piles can be eyeballed. Deterministic, so a reload looks
 * the same. Without the flag the board hangs empty, as it always has here.
 */
const BOARD_GOALS = ['security', 'live-delight', 'office-realism', 'cloud', 'launch', 'demo'];
/** What the preview's board buttons have done to the fixture (ADR 751): lanes thrown away, and lanes
 *  moved — each a new column and place, put there by a present member, so the room walks it. */
interface BoardEdits {
  tossed: number[];
  moved: Record<number, { state: 'claimed' | 'active' | 'done'; x: number; y: number; at: number }>;
}
const NO_EDITS: BoardEdits = { tossed: [], moved: {} };

function fixtureBoard(edits: BoardEdits = NO_EDITS): NonNullable<OfficeData['wallBoard']> {
  const states = ['open', 'claimed', 'active', 'blocked', 'awaiting_acceptance', 'done'] as const;
  const lanes = Array.from({ length: 80 }, (_, i) => {
    const goal = i % 9 === 8 ? null : BOARD_GOALS[(i * 7) % BOARD_GOALS.length]!;
    const state = states[(i * 5 + (i >> 2)) % states.length]!;
    const id = `01FIXTURE${String(i).padStart(4, '0')}`;
    if (edits.tossed.includes(i))
      return { id, state: 'abandoned', goal_id: goal, owner_seat: 'Cy', created_by: 'Cy', updated_at: Date.now() };
    const moved = edits.moved[i];
    if (moved)
      return { id, state: moved.state, goal_id: goal, updated_at: moved.at, card: { x: moved.x, y: moved.y, by: 'Bo', at: moved.at } };
    return { id, state, goal_id: goal, updated_at: 1_700_000_000_000 + i * 60_000 };
  });
  return projectWallBoard(
    { lanes, warnings: [] } as unknown as Parameters<typeof projectWallBoard>[0],
    new Set(),
    Date.now(),
    ['due', 'waiting', 'overdue', 'read'],
    BOARD_GOALS,
  )!;
}

function OfficePreviewPage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OfficeHandle | null>(null);

  // `?n=<count>` starts with only the first N of the pool present — the sparse-roster case the floor plan
  // has to survive (a real team is ~5 against 12 desks, and that is when empty desks read loudest).
  const [present, setPresent] = useState<Set<string>>(() => {
    const n = Number(previewSearch().get('n'));
    const pool = Number.isFinite(n) && n > 0 ? ROSTER.slice(0, n) : POOL;
    return new Set(pool.map((m) => m.name));
  });
  const [away, setAway] = useState<Set<string>>(() => new Set(['Gus']));
  // The scene hands the narrated moment out; the chrome renders it (the /live wiring, mirrored here).
  const [caption, setCaption] = useState<Caption | null>(null);

  // `?idle=all` (or a comma list of names) forces members idle on load — the case the leisure furniture
  // exists for, and the one that's tedious to reach by clicking. `?idle=all` empties every desk.
  const [idle, setIdle] = useState<Set<string>>(() => {
    const raw = previewSearch().get('idle');
    if (!raw) return new Set();
    if (raw === 'all') return new Set(ROSTER.map((m) => m.name));
    return new Set(raw.split(',').map((s) => s.trim()));
  });

  // `?stale=<names>` reproduces a *stale* seat (ADR 135): posture projected to `active` while its last-known
  // `activity` still reads `working`. That split is the only case where the typing animation and placement
  // could disagree, so it's the one worth being able to summon — the live floor reaches it on its own.
  const [stale] = useState<Set<string>>(() => {
    const raw = previewSearch().get('stale');
    return raw ? new Set(raw.split(',').map((s) => s.trim())) : new Set();
  });

  // `?waiting=<name>:blocked,<name>:handoff,<name>:review2` puts a desk prop on those desks (lane 01M5XS6ARW),
  // so the note, the folder and the tray can be looked at without a timeline that produces them.
  const [waitingSet] = useState<Map<string, DeskWaiting>>(() => {
    const out = new Map<string, DeskWaiting>();
    for (const part of (previewSearch().get('waiting') ?? '').split(',')) {
      const [name, what = ''] = part.split(':').map((s) => s.trim());
      if (!name) continue;
      if (what === 'blocked') out.set(name, { kind: 'blocked' });
      else if (what === 'handoff') out.set(name, { kind: 'handoff', from: 'nick' });
      else if (what.startsWith('review')) out.set(name, { kind: 'review', count: Number(what.slice(6)) || 1 });
    }
    return out;
  });

  // `?offline=<names>` marks members offline (owned desks, presence-honesty §4) — `off=<name>:disconnected`
  // shape is not supported; the first name gets `disconnected` so the amber glint is visible in preview.
  const [offlineSet] = useState<Set<string>>(() => {
    const raw = previewSearch().get('offline');
    return raw ? new Set(raw.split(',').map((s) => s.trim())) : new Set(['Fen']);
  });

  // `?dnd=<names>` marks members do-not-disturb (headphones, dnd pill) — default one so the a11y
  // sweep and an eyeball can always reach the state.
  const [dndSet] = useState<Set<string>>(() => {
    const raw = previewSearch().get('dnd');
    return raw ? new Set(raw.split(',').map((s) => s.trim())) : new Set(['Ivy']);
  });

  // `?dream=<names>` marks members dreaming (goal dreaming): lamp low, a thought bubble over the desk.
  // Pair it with `?light=23` to see it the way it happens, at night.
  const [dreamSet] = useState<Set<string>>(() => {
    const raw = previewSearch().get('dream');
    return raw ? new Set(raw.split(',').map((s) => s.trim())) : new Set();
  });

  /* `?team=<slug>` — the ambient seed's key material (E1). The room's idle life is a pure function
     of (team, wall-clock slot), so two tabs on the same team play the SAME beats at the same instants
     and two different teams play independent ones: this param is how that is checked by eye on the
     one route that can render the room without a daemon, and how `scripts/perf/ambient-density.mjs`
     samples several independent rooms at once instead of waiting out one of them. */
  const [teamName] = useState(() => previewSearch().get('team') ?? 'revive');
  /* The Welcome Wagon harness (lane 01M3F81DD9): Members added the way the server would add them —
     offline and never-connected (`offline_reason: 'unknown'`) — then connected, so the real path runs:
     roster diff → sequencer → the room's residents. Nothing here shortcuts the scene. */
  const [newcomers, setNewcomers] = useState<OfficeNode[]>([]);
  /* A role assigned while the room is open (lane 01M5FXZF49): the toolbar's 🪪 gives Dev a job and
     takes it away again, so the plate's job swipe can be judged without a daemon. */
  const [devRole, setDevRole] = useState('');
  // `?board` (ADR 751): the board buttons' edits to the fixture — a move or a toss for the room to walk.
  const [boardEdits, setBoardEdits] = useState<BoardEdits>(NO_EDITS);

  const buildData = useCallback(
    (): OfficeData => ({
      teamName,
      teamWorkingHours: {
        timezone: 'America/Los_Angeles',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '11:00',
        end: '15:00',
      },
      nodes: [
        ...ROSTER.filter((m) => present.has(m.name)).map((m): OfficeNode => {
          const isOffline = offlineSet.has(m.name);
          const isAway = !isOffline && away.has(m.name);
          const isStale = stale.has(m.name);
          // A stale seat keeps `activity: working` but is placed by its projected `active` posture.
          const activity = isOffline
            ? ('offline' as const)
            : isAway || (idle.has(m.name) && !isStale)
              ? ('active' as const)
              : m.activity;
          const posture = isOffline
            ? ('offline' as const)
            : isAway
              ? ('away' as const)
              : isStale || idle.has(m.name)
                ? ('active' as const)
                : activity;
          return {
            name: m.name,
            kind: m.kind,
            service: m.service === true,
            presence: isOffline
              ? ('offline' as const)
              : isAway
                ? ('away' as const)
                : ('online' as const),
            activity,
            // The fixture has no availability axis, so posture composes straight off presence + activity —
            // except a `?stale` seat, which pins posture idle while activity lags at working.
            posture,
            state: m.state,
            color: memberColor(m.name, m.kind),
            role: m.name === 'Dev' && devRole ? devRole : (FIXTURE_IDENTITY[m.name]?.role ?? ''),
            // Varied identity, so the preview actually exercises the nameplate's provider icon and its
            // expand detail. These were `null` while the plate carried harness · model, which meant the
            // one surface for eyeballing a nameplate could never render one.
            surface: FIXTURE_IDENTITY[m.name]?.surface ?? 'claude-code',
            // Read the entry, not `?? default` — an explicit `model: null` IS the case worth showing
            // (a seat with nothing to report), and a nullish fallback makes it unreachable.
            model: m.name in FIXTURE_IDENTITY ? FIXTURE_IDENTITY[m.name]!.model : 'claude-opus-4-5',
            workTitle: null,
            workSource: null,
            laneState: null,
            moreLanes: 0,
            // Why the seat is here at all — a wake, not someone opening a session. Orthogonal to
            // posture on purpose, so the preview shows the two facts side by side.
            woken: WOKEN.has(m.name) && !isOffline,
            dreaming: dreamSet.has(m.name) && !isOffline,
            dnd: dndSet.has(m.name) && !isOffline,
            blocked: waitingSet.get(m.name)?.kind === 'blocked',
            waiting: waitingSet.get(m.name) ?? null,
            // ADR 721: one human with a status line, so the plate's colour footer is on the preview.
            statusLine:
              m.name === 'Ada' ? { text: 'assembling a new dresser for the nursery', expiresAt: Date.now() + 3_600_000 } : null,
            // The first offline fixture wears the amber `disconnected` glint; the rest read released.
            offline_reason: isOffline
              ? [...offlineSet][0] === m.name
                ? 'disconnected'
                : 'seat_released'
              : null,
            last_seen_at: isOffline ? Date.now() - 20 * 60_000 : null,
            created_at: null,
            sponsored_by: null,
          };
        }),
        ...newcomers,
      ],
      ...(previewSearch().has('board') ? { wallBoard: fixtureBoard(boardEdits) } : {}),
    }),
    [teamName, present, away, idle, stale, offlineSet, dndSet, dreamSet, waitingSet, newcomers, devRole, boardEdits],
  );
  const dataRef = useRef(buildData);
  // Synced in an effect, not during render — see OfficeScene: the mount effect subscribes once and
  // reads the latest builder through this ref, and it is declared after this one so it sees it set.
  useEffect(() => {
    dataRef.current = buildData;
  });

  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelRef.current;
    if (!host || !labelHost) return;
    let disposed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let loop: ReturnType<typeof setInterval> | undefined;

    import('../live/office-scene')
      .then(({ mountOffice }) => {
        if (disposed || !host || !labelHost) return;
        const search =
          typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();
        /*
         * `?reduced` — RENDER THE ROOM AS A REDUCED-MOTION VIEWER SEES IT.
         *
         * This route hardcodes `reduced: false` (it is a design tool; a designer with Reduce Motion
         * enabled in their OS would otherwise find it useless, and the a11y gate leans on it moving).
         * The cost of that default is a blind spot: `prefers-reduced-motion` takes the office
         * somewhere quite far from here — the rAF loop never starts, walkers snap between desks
         * instead of walking, ambient life and the pet and the door pulse all stand down, and bubbles
         * appear whole with no typewriter. **No one had ever looked at that room**, because the one
         * tool used to review the office structurally could not render it (miley/nick, 2026-08-20).
         *
         * Presence, not value, like `?still` and `?quiet` beside it — inert unless explicitly asked
         * for, so the route's animated day job is unchanged. Opt-in rather than honouring the media
         * query directly, deliberately: honouring it would make the preview useless to exactly the
         * designer who has the setting turned on.
         */
        const reduced = search.has('reduced');
        const handle = mountOffice(host, labelHost, reduced, {
          /* `?plates=broadcast` — the stream's plates (no expand, model on the face), so a plate
             change can be judged as /broadcast shows it without the stream's seat. */
          interactiveLabels: search.get('plates') !== 'broadcast',
          /* `?sprites=1` — paint the static furniture from the sprite cache (spec 2026-09-17). This
             route is where the pixel gate runs, and `__office.spriteParity()` compares the two
             paths on demand whatever this flag says; the flag is for looking at the cached room.
             Shares `/broadcast`'s parser deliberately: this read `search.has('sprites')` until
             2026-09-18, so `?sprites=0` turned the cache ON here and OFF there — opposite meanings
             for one spelling, on the one route a human eyeballs arms by hand (found by ryder). */
          sprites: spritesFromUrl(search.toString()),
          /* `?dirty` — repaint by damage (smooth-capture spec, lever 2), over the sprite cache. Off
             unless asked for: this route is where `__office.dirtyParity()` runs against the looping
             choreography, which is the moving room the parity gate needs. */
          dirtyRects: search.has('dirty'),
          // The narration is chrome now, so the scene only says what the moment is and the fixture's
          // own overlay renders it — the same wiring `/live` and `/broadcast` use.
          onCaption: (next) => setCaption(next),
        });
        handle.update(dataRef.current());
        handleRef.current = handle;
        (window as unknown as { __office?: OfficeHandle }).__office = handle; // dev-fixture debug handle
        // `?quiet` skips the looping choreography — a still room of seated members, so an on-demand
        // gesture (pokeGesture / the 🙆👀 buttons) is the only motion. Used to verify gestures in isolation.
        const quiet = search.has('quiet');
        /*
         * `?still` — the MEASUREMENT mode: the same script, played ONCE and immediately, with no
         * loop behind it. The room fills and then stops.
         *
         * This exists because the a11y contrast gate was measuring a moving room and losing. The
         * sweep freezes rAF, samples a screenshot and pairs each text row with the pixel beneath it,
         * and every part of that is a race against choreography: bubbles are born on timers, walks
         * reposition them, and `LOOP` restarts the whole script every cycle. Six exclusion guards
         * (moved, born, unsettled, invisible, clipped, covered) were added to contrast-sweep.mjs one
         * incident at a time, and /office-preview still flipped red about 1 run in 3 — always
         * `lc-speech__text`, over whatever scene paint happened to be under a bubble at shutter time.
         *
         * `?quiet` cannot be that mode: it skips the choreography entirely, so there are no bubbles
         * to measure, and the speech rows are exactly where the real failures have been found
         * (wanderer's below-AA report on this route was an lc-speech__text row). A gate that goes
         * green by removing its subject is worse than a flaky one.
         *
         * So: keep the subject, remove the motion. Every event fires at mount, the scene animates to
         * its end state once, and the sweep's settle detector — which already waits for the page to
         * STOP CHANGING rather than for a number of seconds — then has something that actually stops.
         *
         * Same shape as `?light=HH` above: a dev aid, inert unless explicitly present.
         */
        /* Via the shared reader, so this route and the three components that also honour the flag
           (the scene's ambient scheduler, the asks-strip) cannot drift apart on
           what `?still` means — ADR 285. `search` above still serves `?quiet` and `?light`. */
        const still = isStill(window.location.search);
        if (still) {
          /* Every event at mount, as #880 wrote it. TESTED AND KEPT, 2026-08-19: the alternative —
             the script's own 6.7s timeline, played once with no loop — was measured on the theory
             that seven simultaneous walks contend for the floor and take longer to drain. They do
             not. Quiescence was 21.6s bursting and 22.5s staggered, i.e. the room takes ~22s to
             finish its choreography either way and the burst is not what makes it long. Recorded so
             the next person does not re-run the experiment. */
          for (const step of SCRIPT) handleRef.current?.emit(step.ev);
        } else if (!quiet) {
          const run = () => {
            for (const step of SCRIPT)
              timers.push(setTimeout(() => handleRef.current?.emit(step.ev), step.at));
          };
          run();
          loop = setInterval(run, LOOP);
        }
        // `?beat=fridge|water|coffee|phone|look|<gesture number>` fires that beat right after mount (and again every
        // 30s) — the only way to verify a ~25s errand headlessly, where clicking the poke buttons isn't
        // an option and waiting out the ambient scheduler isn't either.
        const beat = search.get('beat');
        if (beat) {
          const poke = () => {
            const h = handleRef.current;
            if (!h) return;
            if (beat === 'fridge' || beat === 'water' || beat === 'coffee' || beat === 'phone')
              h.pokeErrand(beat);
            else if (beat === 'look') h.pokeLook();
            else h.pokeGesture(Number(beat) || 1);
          };
          timers.push(setTimeout(poke, 600));
          loop ??= setInterval(poke, 30000);
        }
        // `?replay=1` hands the scene a replay on open: a claim from 4 min ago and a finish from just
        // now, so the walkers' age tags (lane 01M50TZA8X) can be seen headlessly, without a daemon.
        if (search.get('replay')) {
          const now = Date.now();
          timers.push(
            setTimeout(
              () =>
                handleRef.current?.replay([
                  { kind: 'walk-claim', who: 'Dev', lane: 'preview-a', title: 'Rotate the leaked keys', at: now - 4 * 60_000 },
                  { kind: 'walk-pin', who: 'Ada', lane: 'preview-b', title: 'Ship the tour', state: 'done', at: now - 20_000 },
                ]),
              600,
            ),
          );
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      if (loop) clearInterval(loop);
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  // Push roster changes into the scene → arrivals walk in, departures walk out, away drifts to the nook.
  useEffect(() => {
    handleRef.current?.update(buildData());
  }, [buildData]);

  const fire = (ev: OfficeEvent) => handleRef.current?.emit(ev);

  /** A newcomer as the server creates one: offline, never connected, created just now. */
  const newcomer = (name: string, kind: 'agent' | 'human'): OfficeNode => {
    const hue = Math.floor(Math.random() * 360);
    return {
      name,
      kind,
      service: false,
      presence: 'offline',
      activity: 'offline',
      posture: 'offline',
      state: null,
      color: memberColor(name, kind, hue),
      hue,
      role: '',
      surface: null,
      model: null,
      workTitle: null,
      workSource: null,
      laneState: null,
      moreLanes: 0,
      dnd: false,
      offline_reason: 'unknown',
      last_seen_at: null,
      created_at: Date.now(),
      sponsored_by: kind === 'agent' ? 'nick' : null,
      woken: false,
    };
  };
  const connected = (n: OfficeNode): OfficeNode => ({
    ...n,
    presence: 'online',
    activity: 'working',
    posture: 'working',
    offline_reason: null,
    surface: n.kind === 'agent' ? 'claude-code' : 'web',
    last_seen_at: Date.now(),
  });
  /** Add Members; `connectAfterMs` null leaves them offline (Act 1 only), 0 adds them already online. */
  const welcome = (names: string[], kind: 'agent' | 'human', connectAfterMs: number | null) => {
    const fresh = names.map((n) => newcomer(n, kind));
    setNewcomers((cur) => [...cur, ...(connectAfterMs === 0 ? fresh.map(connected) : fresh)]);
    if (connectAfterMs)
      setTimeout(
        () => setNewcomers((cur) => cur.map((n) => (names.includes(n.name) ? connected(n) : n))),
        connectAfterMs,
      );
  };
  const stamp = () => Date.now().toString(36).slice(-3);
  const captionAt = useRef(0);
  const toggle = (set: Set<string>, name: string): Set<string> => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  };
  const present2 = (n: string) => setPresent((s) => toggle(s, n));
  const away2 = (n: string) => setAway((s) => toggle(s, n));
  const idle2 = (n: string) => setIdle((s) => toggle(s, n));

  return (
    <main className="lc">
      <header className="lc__topbar">
        <MusterdWord />
        <span className="lc__team">/ office preview</span>
        <span className="lc__spacer" />
        <button
          className="lc__pbtn"
          title="request help (walk-over)"
          onClick={() => fire({ kind: 'walk-help', from: 'Ada', to: ['Bo'], tier: 'needs-attn' })}
        >
          ?
        </button>
        <button
          className="lc__pbtn"
          title="urgent help (run)"
          onClick={() => fire({ kind: 'walk-help', from: 'Cy', to: ['Fen'], tier: 'urgent' })}
        >
          !
        </button>
        <button
          className="lc__pbtn"
          title="handoff (carry folder)"
          onClick={() => fire({ kind: 'walk-handoff', from: 'Eli', to: 'Hana', label: 'floor.ts' })}
        >
          ↦
        </button>
        <button
          className="lc__pbtn"
          title="claim a lane (walk to the board, take the card)"
          onClick={() => fire({ kind: 'walk-claim', who: 'Dev', lane: 'preview-lane', title: 'Rotate the leaked keys' })}
        >
          ⇡
        </button>
        {previewSearch().has('board') && (
          <>
            <button
              className="lc__pbtn"
              title="move a card on the wall board (Bo walks over and re-pins it)"
              onClick={() =>
                setBoardEdits((e) => {
                  const i = Object.keys(e.moved).length * 3 + 1;
                  const state = (['claimed', 'active', 'done'] as const)[i % 3]!;
                  return { ...e, moved: { ...e.moved, [i]: { state, x: 0.3 + (i % 5) * 0.12, y: 0.5, at: Date.now() } } };
                })
              }
            >
              ⇄
            </button>
            <button
              className="lc__pbtn"
              title="abandon a lane (Cy crumples its card and throws it in the bin)"
              onClick={() => setBoardEdits((e) => ({ ...e, tossed: [...e.tossed, e.tossed.length * 5 + 2] }))}
            >
              🗑
            </button>
          </>
        )}
        <button
          className="lc__pbtn"
          title="a lane done (Ada pins the card; the shelf chimes ring and swing)"
          onClick={() =>
            fire({ kind: 'walk-pin', who: 'Ada', lane: `preview-done-${Date.now()}`, title: 'Ship the tour', state: 'done' })
          }
        >
          ♪
        </button>
        <button
          className="lc__pbtn"
          title="a goal shipped (the chimes roll the whole scale)"
          onClick={() => fire({ kind: 'goal-done', who: 'Cy', goal: 'preview-goal' })}
        >
          ♫
        </button>
        <button
          className="lc__pbtn"
          title="roll call (the stream's wave across the folded plates)"
          onClick={() => handleRef.current?.rollCall()}
        >
          👋
        </button>
        <button
          className="lc__pbtn"
          title="give Dev a job (a role assigned mid-stream), or take it away"
          onClick={() => setDevRole((r) => (r ? '' : 'designer'))}
        >
          🪪
        </button>
        <button
          className="lc__pbtn"
          title="broadcast (megaphone)"
          onClick={() => fire({ kind: 'megaphone', from: 'Ivy' })}
        >
          📣
        </button>
        <span className="lc__pbtn-sep" />
        <button
          className="lc__pbtn"
          title="steer (interrupt-class redirect)"
          onClick={() => fire({ kind: 'steer', from: 'Ada', to: 'Dev', urgent: true })}
        >
          ↪
        </button>
        <button
          className="lc__pbtn"
          title="challenge (justify?)"
          onClick={() => fire({ kind: 'challenge', from: 'Cy', to: ['Bo'], urgent: false })}
        >
          🤔
        </button>
        <button
          className="lc__pbtn"
          title="defer (plan mutation → board pulse)"
          onClick={() => fire({ kind: 'defer', who: 'Fen' })}
        >
          »
        </button>
        <span className="lc__pbtn-sep" />
        <button
          className="lc__pbtn"
          title="narration: cycle the caption tones"
          onClick={() => {
            // One of each act family, in order, so the pill's five tones are all reachable from the
            // fixture. Without this the caption was only observable by waiting for the right real act
            // to happen on /live, which is not a design loop.
            const next = CAPTIONS[captionAt.current % CAPTIONS.length]!;
            captionAt.current += 1;
            fire({ kind: 'caption', caption: next });
          }}
        >
          💬
        </button>
        <button
          className="lc__pbtn"
          title="Welcome Wagon: a human is added, then connects 7 s later"
          onClick={() => welcome([`ada-${stamp()}`], 'human', 7_000)}
        >
          🎀
        </button>
        <button
          className="lc__pbtn"
          title="Welcome Wagon: an agent is added (sponsored by nick), then connects 7 s later"
          onClick={() => welcome([`bot-${stamp()}`], 'agent', 7_000)}
        >
          🤖
        </button>
        <button
          className="lc__pbtn"
          title="Welcome Wagon: 14 demo guests join at once, already connected"
          onClick={() =>
            welcome(
              Array.from({ length: 14 }, (_, i) => `guest-${stamp()}${i}`),
              'human',
              0,
            )
          }
        >
          🎉
        </button>
        <button
          className="lc__pbtn"
          title="Welcome Wagon: a human is added and never connects (Act 1 only)"
          onClick={() => welcome([`lin-${stamp()}`], 'human', null)}
        >
          🏷️
        </button>
        <button
          className="lc__pbtn"
          title="ambient gesture: stretch"
          onClick={() => handleRef.current?.pokeGesture(1)}
        >
          🙆
        </button>
        <button
          className="lc__pbtn"
          title="ambient gesture: glance"
          onClick={() => handleRef.current?.pokeGesture(2)}
        >
          👀
        </button>
        <button
          className="lc__pbtn"
          title="ambient gesture: sip"
          onClick={() => handleRef.current?.pokeGesture(6)}
        >
          🍵
        </button>
        <button
          className="lc__pbtn"
          title="ambient gesture: swivel"
          onClick={() => handleRef.current?.pokeGesture(7)}
        >
          🪑
        </button>
        <button
          className="lc__pbtn"
          title="errand: fridge meal"
          onClick={() => handleRef.current?.pokeErrand('fridge')}
        >
          🍽
        </button>
        <button
          className="lc__pbtn"
          title="errand: water refill"
          onClick={() => handleRef.current?.pokeErrand('water')}
        >
          💧
        </button>
        <button
          className="lc__pbtn"
          title="errand: coffee run"
          onClick={() => handleRef.current?.pokeErrand('coffee')}
        >
          ☕
        </button>
        <button
          className="lc__pbtn"
          title="errand: phone call (stand, pace, return)"
          onClick={() => handleRef.current?.pokeErrand('phone')}
        >
          📞
        </button>
        <span className="lc__pbtn-sep" />
        <button
          className="lc__pbtn"
          title="Dev join / leave (walk in / out)"
          onClick={() => present2('Dev')}
        >
          D
        </button>
        <button
          className="lc__pbtn"
          title="Hana join / leave (walk in / out)"
          onClick={() => present2('Hana')}
        >
          H
        </button>
        <button
          className="lc__pbtn"
          title="Ivy away / back (drift to nook)"
          onClick={() => away2('Ivy')}
        >
          z
        </button>
        <button
          className="lc__pbtn"
          title="Bo idle / working (walk to the lounge)"
          onClick={() => idle2('Bo')}
        >
          ☕
        </button>
        {/* The narration pill, as the team column's header carries it on /live and /broadcast. */}
        <CaptionPill
          caption={caption}
          color={caption ? memberColor(caption.who, kindOfMock(caption.who)) : undefined}
        />
        <span className="lc__status lc__status--live">design preview</span>
      </header>
      <div className="lc__canvas lc__canvas--companion">
        <section className="lc-office">
          <div className="lc-gl-canvas" ref={hostRef} aria-hidden="true" />
          <div className="lc-gl-labels" ref={labelRef} aria-hidden="true" />
          <p className="lc-office__caption">office choreography preview</p>
        </section>
      </div>
      <PreviewPromptBar />
    </main>
  );
}
