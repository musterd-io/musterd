# The "joined the team" moment (Welcome Wagon) Implementation Plan

> **For agentic workers:** execute in your own seat with superpowers:executing-plans (ADR 150 / AGENTS.md
> hard rule 8 — no writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Member's creation and first connect play as a two-act welcome in the `/live` office —
the dog pulls a welcome wagon to their desk, the receptionist tosses them a lanyard, teammates wave —
with a crowd mode for demo guests.

**Architecture:** The server broadcasts the existing `presence: offline` frame on every Member
creation so `/live` refetches its roster. Inside the office scene, a pure roster diff
(`arrivals.ts`) turns consecutive rosters into `created` / `firstOnline` arrivals; a pure beat
sequencer (`welcomeWagon.ts`) groups them into waves and emits timed beats; `index.ts` dispatches
each beat to the residents that already exist (receptionist, dog, actors, caption rail, sound) and to
new painters in `render.ts`.

**Tech Stack:** TypeScript, vitest, canvas 2D (the office's `box()` iso primitives), WebAudio
(synthesized, `soundEngine.ts`), Node HTTP/WS server (`@musterd/server`).

**Spec:** `docs/superpowers/specs/2026-09-26-live-member-joined-moment-design.md`

## Global Constraints

- No `@musterd/protocol` schema change (hard rule 1). The signal reuses `{ type: 'presence', member, status: 'offline' }`.
- No new runtime dependency (hard rule 6).
- Plays once per Member: `created` = name absent from the previous roster; `firstOnline` = previous entry offline with `offline_reason: 'unknown'`. The first roster the scene sees never produces an arrival.
- `kind: 'service'` Members and observers never produce an arrival.
- Wave window **2 s**; crowd = a wave with **≥ 3** online arrivals; conveyor toss every **0.6 s**; backlog cap **6** queued arrivals before everything pending merges into one wave.
- Confetti: **24** pieces per burst, **one** burst per wave.
- New-arrivals corner: Members created in the last **24 h** who hold no desk, at most **3**, newest first — derived from the roster, never stored.
- Reduced motion: no walk, wagon, toss, wave, zoomies or confetti; captions and end states only.
- `/broadcast` plays the moment; still mode (`STILL`) starts nothing transient.
- An idle office stays at rAF 0/s (ADR 086); the sequencer requests frames only while a sequence plays.
- Copy (verbatim, sloane reviews before merge): `oh! someone new: {name}` · `welcome, {name}!` · `welcome!` · `hello, {name}` · `{name} was added to the team · by {sponsor}` · `{name} was added to the team` · `{name} joined the team — welcome` · `{n} guests joined — welcome` (all-human crowd) · `{n} teammates joined — welcome` (mixed crowd) · `{n} members were added to the team` (several created offline in one wave) · counter label `guests`.
- **Spec amendment (recorded in Task 10):** the spec's crowd "queue" is dropped. The reception design (`layout.ts` `CHECK_IN_MARKS`, 2026-07-30) rejects ceremony that queues; guests past the three marks walk straight in and receive their lanyard toss as they pass the counter.

## Review Focus

1. **A roster refetch that fails or arrives out of order** — `useLiveStream` keeps the last good roster; a later successful refetch must not replay arrivals already played (diff against what the scene last saw, not what the server last sent). Pinned in Task 2 (`diffArrivals` is fed the scene's own previous map).
2. **A Member created and removed before the wave starts** — the sequence must skip beats for a name no longer in the roster rather than tossing a lanyard to nobody. Pinned in Task 3 (`present` dep).
3. **The viewer tab hidden mid-sequence** — the loop parks while hidden; on return the sequencer must not fire a burst of stale beats. Pinned in Task 3 (elapsed clamps; a sequence older than 20 s is dropped whole).
4. **The office collapsed (`setSuspended(true)`) while arrivals land** — arrivals still enqueue, nothing plays until resume, and the backlog cap still holds. Pinned in Task 3 (backlog test) and Task 6 (dispatcher gate).
5. **A name that also collides with `receptionist`, or a very long name** — bubbles and captions go through the existing speech/caption shaping; the label/polaroid painters must clip, not overflow. Pinned in Task 7 (painter clips to 10 characters + `…`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/server/src/transport/memberAdded.ts` (create) | `broadcastMemberAdded` + `broadcastReconciled` — the one place creation becomes a frame |
| `packages/server/src/transport/memberAdded.test.ts` (create) | unit tests with a fake hub |
| `packages/server/src/transport/http.ts` (modify) | call the helper in both branches of `POST /members` |
| `packages/server/src/transport/sponsoredAgentMint.ts` (modify) | call the helper after a sponsored agent is minted |
| `packages/server/src/index.ts` (modify) | call `broadcastReconciled` after watcher / reload reconciles |
| `packages/server/src/transport/integration.test.ts` (modify) | a live watcher sees the frame on `POST /members` |
| `packages/web/src/live/office-scene/types.ts` (modify) | `OfficeNode.created_at`, `OfficeNode.sponsored_by`, `CarryKind` `'movingBox'` |
| `packages/web/src/live/OfficeScene.tsx` (modify) | project `created_at` / `sponsored_by` into nodes |
| `packages/web/src/live/office-scene/arrivals.ts` (create) | pure roster diff + new-arrivals corner |
| `packages/web/src/live/office-scene/welcomeWagon.ts` (create) | pure wave grouping + beat scripts + stepping |
| `packages/web/src/live/office-scene/pet.ts` (modify) | `petWagon`, `petCarryToWall`, `petZoomies` export |
| `packages/web/src/live/office-scene/receptionist.ts` (modify) | `receptionistCue` + `ring`/`label`/`toss` modes |
| `packages/web/src/live/office-scene/skeleton.ts` (modify) | `GESTURE.wave` (not scheduler-pickable) |
| `packages/web/src/live/office-scene/actors.ts` (modify) | `expectFirstArrival`, `welcomeWave`, `isSeated` |
| `packages/web/src/live/office-scene/render.ts` (modify) | painters: wagon, moving box, lanyard, label strip, polaroids, flip counter, hello screen, boot blink, hued confetti |
| `packages/web/src/live/office-scene/index.ts` (modify) | wire diff → sequencer → dispatch; door hue |
| `packages/web/src/live/soundLife.ts` + `soundEngine.ts` (modify) | moments `ring`, `ratchet`, `rattle`, `doorbell`, `pop` |
| `packages/web/src/routes/office-preview.tsx` (modify) | dev buttons: welcome human / agent / crowd |
| `docs/architecture/03-server.md`, `docs/architecture/08-web.md`, the spec (modify) | file tree + module map + spec amendment |

---

### Task 1: Server — every Member creation broadcasts a presence frame

**Files:**
- Create: `packages/server/src/transport/memberAdded.ts`
- Create: `packages/server/src/transport/memberAdded.test.ts`
- Modify: `packages/server/src/transport/http.ts` (the `POST /members` route — the file-backed branch that returns `sendJson(res, 201, …)` after `reconcileTeam`, and the legacy branch after `addMember`)
- Modify: `packages/server/src/transport/sponsoredAgentMint.ts` (end of `mintSponsoredAgent`)
- Modify: `packages/server/src/index.ts` (`startWatching` callback and `reload()`)
- Modify: `packages/server/src/transport/integration.test.ts` (beside `'ambient presence: a live watcher sees the offline→online transition event (ADR 057)'`)
- Modify: `docs/architecture/03-server.md` (file tree under `transport/`)

**Interfaces:**
- Produces: `broadcastMemberAdded(hub: Pick<Hub, 'broadcastTeam'>, teamId: string, name: string): void`
- Produces: `broadcastReconciled(ctx: Pick<Ctx, 'db' | 'hub'>, results: readonly Pick<ReconcileResult, 'slug' | 'added' | 'revived'>[]): void`

- [ ] **Step 1: Write the failing unit test**

```ts
// packages/server/src/transport/memberAdded.test.ts
import { describe, expect, it } from 'vitest';
import type { WSServerFrame } from '@musterd/protocol';
import { openDb } from '../db/open.js';
import { createTeam } from '../store/teams.js';
import { broadcastMemberAdded, broadcastReconciled } from './memberAdded.js';

function fakeHub() {
  const sent: { teamId: string; frame: WSServerFrame }[] = [];
  return { sent, broadcastTeam: (teamId: string, frame: WSServerFrame) => void sent.push({ teamId, frame }) };
}

describe('broadcastMemberAdded (lane 01M3F81DD9)', () => {
  it('sends presence offline for the new name to the whole team', () => {
    const hub = fakeHub();
    broadcastMemberAdded(hub, 't1', 'ada');
    expect(hub.sent).toEqual([{ teamId: 't1', frame: { type: 'presence', member: 'ada', status: 'offline' } }]);
  });
});

describe('broadcastReconciled', () => {
  it('announces added and revived seats, per team, and nothing else', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'dawn', name: 'dawn' });
    const hub = fakeHub();
    broadcastReconciled({ db, hub: hub as never }, [
      { slug: 'dawn', added: ['ada'], revived: ['lin'] },
      { slug: 'nope', added: ['ghost'], revived: [] }, // an unknown slug is skipped, not thrown
    ]);
    expect(hub.sent.map((s) => [s.teamId, (s.frame as { member: string }).member])).toEqual([
      [team.id, 'ada'],
      [team.id, 'lin'],
    ]);
  });
});
```

Check `createTeam`'s input shape in `packages/server/src/store/teams.ts:55` before running; adjust the literal to its required fields if it needs more than `slug`/`name`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @musterd/server exec vitest run src/transport/memberAdded.test.ts`
Expected: FAIL — `Cannot find module './memberAdded.js'`.

- [ ] **Step 3: Implement the helper**

```ts
// packages/server/src/transport/memberAdded.ts
import type { Ctx } from '../context.js';
import type { ReconcileResult } from '../projection/reconcile.js';
import { getTeamBySlug } from '../store/teams.js';
import type { Hub } from './hub.js';

/**
 * A Member was just created: tell every live connection on the team (lane 01M3F81DD9).
 *
 * The frame is the existing `presence` frame with `status: 'offline'` — true of a Member who has never
 * connected, and it is exactly what makes `/live` refetch its roster (useLiveStream refetches on any
 * presence frame). A dedicated `member_added` frame would be a protocol schema change (hard rule 1)
 * that no consumer needs: `/live` tells a new name from a known one by diffing rosters.
 * Removal already broadcasts `offline`; this closes the asymmetry.
 */
export function broadcastMemberAdded(hub: Pick<Hub, 'broadcastTeam'>, teamId: string, name: string): void {
  hub.broadcastTeam(teamId, { type: 'presence', member: name, status: 'offline' });
}

/** The seat-file projection's version: every seat a reconcile pass added or revived is announced. */
export function broadcastReconciled(
  ctx: Pick<Ctx, 'db' | 'hub'>,
  results: readonly Pick<ReconcileResult, 'slug' | 'added' | 'revived'>[],
): void {
  for (const r of results) {
    const names = [...r.added, ...r.revived];
    if (names.length === 0) continue;
    const team = getTeamBySlug(ctx.db, r.slug);
    if (!team) continue;
    for (const name of names) broadcastMemberAdded(ctx.hub, team.id, name);
  }
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm --filter @musterd/server exec vitest run src/transport/memberAdded.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing integration test**

Add inside the same `describe` as the ADR 057 watcher test in `integration.test.ts`:

```ts
  it('a live watcher hears a new member the moment it is added (lane 01M3F81DD9)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const watcher = new TestWs();
    await watcher.open();
    await watcher.claim('dawn', nickTok, 'nick');
    watcher.send({ type: 'subscribe', scope: 'team' });

    await post('/teams/dawn/members', { name: 'Ada', kind: 'agent' }, nickTok);
    await pollUntil(() =>
      watcher.frames.some(
        (f) => f.type === 'presence' && (f as any).member === 'Ada' && (f as any).status === 'offline',
      ),
    );
    watcher.ws.close();
  });

  it('an observer seat is not announced (lane 01M3F81DD9)', async () => {
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    const nickTok = team.json.human_credential;
    const watcher = new TestWs();
    await watcher.open();
    await watcher.claim('dawn', nickTok, 'nick');
    watcher.send({ type: 'subscribe', scope: 'team' });

    await post('/teams/dawn/members', { name: 'eye', kind: 'agent', observer: true }, nickTok);
    await new Promise((r) => setTimeout(r, 150));
    expect(watcher.frames.some((f) => f.type === 'presence' && (f as any).member === 'eye')).toBe(false);
    watcher.ws.close();
  });
```

- [ ] **Step 6: Run it to verify the first test fails**

Run: `pnpm --filter @musterd/server exec vitest run src/transport/integration.test.ts -t "lane 01M3F81DD9"`
Expected: the first FAILS on `pollUntil` timeout; the observer test passes already.

- [ ] **Step 7: Wire the helper into every creation path**

In `http.ts`, import `broadcastMemberAdded` from `./memberAdded.js`. In the file-backed branch, just before its `return sendJson(res, 201, {`:

```ts
          // A fresh or revived seat is news to the room; a re-mint of an existing one is not.
          if (result.added.includes(body.name) || result.revived.includes(body.name))
            broadcastMemberAdded(ctx.hub, team.id, body.name);
```

In the legacy branch, just before its `return sendJson(res, 201, {`:

```ts
        // Observers (ADR 063) are runtime watchers, not teammates — the room does not welcome them.
        if (!body.observer) broadcastMemberAdded(ctx.hub, team.id, row.name);
```

In `sponsoredAgentMint.ts`, import `broadcastMemberAdded` from `./memberAdded.js` and add after the `appendAudit(...)` call:

```ts
  broadcastMemberAdded(ctx.hub, team.id, member.name);
```

In `index.ts`, import `broadcastReconciled` from `./transport/memberAdded.js` and change the watcher callback and `reload()`:

```ts
      stopWatcher = startRosterWatcher(ctx.rosterRoots, RECONCILE_DEBOUNCE_MS, () => {
        broadcastReconciled(ctx, reconcileAll(db, ctx.rosterRoots));
      });
```

```ts
      const summary = reconcileAll(db, ctx.rosterRoots);
      broadcastReconciled(ctx, summary);
```

The boot reconcile stays silent: nobody is connected before `listen()`.

- [ ] **Step 8: Run the server suite**

Run: `pnpm --filter @musterd/server exec vitest run src/transport/memberAdded.test.ts src/transport/integration.test.ts src/transport/sponsored-agents-http.test.ts`
Expected: PASS.

- [ ] **Step 9: Update the server file tree**

In `docs/architecture/03-server.md`, under `transport/`, after the `hub.ts` line add:

```
    memberAdded.ts    // a Member was created → `presence: offline` to the team (the /live roster refetch trigger; lane 01M3F81DD9): broadcastMemberAdded (routes, sponsored mint) + broadcastReconciled (watcher/reload added+revived seats)
```

Run: `pnpm arch-trees:check`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/transport/memberAdded.ts packages/server/src/transport/memberAdded.test.ts \
  packages/server/src/transport/http.ts packages/server/src/transport/sponsoredAgentMint.ts \
  packages/server/src/index.ts packages/server/src/transport/integration.test.ts docs/architecture/03-server.md
git commit -m "feat(server): announce a new Member with a presence frame so /live sees it arrive

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
```

---

### Task 2: Web — the roster diff (`arrivals.ts`)

**Files:**
- Modify: `packages/web/src/live/office-scene/types.ts` (`OfficeNode`)
- Modify: `packages/web/src/live/OfficeScene.tsx` (the `nodes: roster.map(...)` projection)
- Create: `packages/web/src/live/office-scene/arrivals.ts`
- Create: `packages/web/src/live/office-scene/arrivals.test.ts`

**Interfaces:**
- Produces: `OfficeNode.created_at: number | null`, `OfficeNode.sponsored_by: string | null`
- Produces: `type ArrivalSubject = Pick<OfficeNode, 'name' | 'kind' | 'service' | 'presence' | 'offline_reason' | 'hue' | 'created_at' | 'sponsored_by'>`
- Produces: `interface Arrival { kind: 'created' | 'firstOnline'; name: string; memberKind: 'agent' | 'human'; hue: number | null; sponsor: string | null; online: boolean }`
- Produces: `diffArrivals(prev: ReadonlyMap<string, ArrivalSubject> | null, next: readonly ArrivalSubject[]): Arrival[]`
- Produces: `newArrivalsCorner(nodes: readonly ArrivalSubject[], deskHolders: ReadonlySet<string>, now: number): { name: string; hue: number | null }[]`

- [ ] **Step 1: Add the two node fields**

In `types.ts`, inside `OfficeNode`, after `last_seen_at`:

```ts
  /** When the Member was created (wire `created_at`) — the arrivals corner's 24 h window reads it. */
  created_at: number | null;
  /** Who sponsored this Member (ADR 449), for the "added by" caption; null for everyone else. */
  sponsored_by: string | null;
```

In `OfficeScene.tsx`, in the node projection after `last_seen_at: …,`:

```ts
        created_at: m.created_at ?? null,
        sponsored_by: m.sponsored_by ?? null,
```

Run: `pnpm --filter @musterd/web typecheck`
Expected: errors only at other places that construct an `OfficeNode` literal (e.g. `render.ts` preview node near its `last_seen_at: null`, `routes/office-preview.tsx`, tests). Add `created_at: null, sponsored_by: null` to each until typecheck passes.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/web/src/live/office-scene/arrivals.test.ts
import { describe, expect, it } from 'vitest';
import { diffArrivals, newArrivalsCorner, type ArrivalSubject } from './arrivals';

const m = (name: string, over: Partial<ArrivalSubject> = {}): ArrivalSubject => ({
  name,
  kind: 'human',
  service: false,
  presence: 'offline',
  offline_reason: 'unknown',
  hue: 40,
  created_at: 1_000,
  sponsored_by: null,
  ...over,
});
const map = (xs: ArrivalSubject[]) => new Map(xs.map((x) => [x.name, x]));

describe('diffArrivals', () => {
  it('the first roster the scene sees is never an arrival', () => {
    expect(diffArrivals(null, [m('nick'), m('ada')])).toEqual([]);
  });

  it('a name that was not there before is created — offline', () => {
    expect(diffArrivals(map([m('nick')]), [m('nick'), m('ada', { sponsored_by: 'nick' })])).toEqual([
      { kind: 'created', name: 'ada', memberKind: 'human', hue: 40, sponsor: 'nick', online: false },
    ]);
  });

  it('created and already online folds into one arrival with online: true', () => {
    const out = diffArrivals(map([m('nick')]), [m('nick'), m('guest1', { presence: 'online', offline_reason: null })]);
    expect(out).toEqual([{ kind: 'created', name: 'guest1', memberKind: 'human', hue: 40, sponsor: null, online: true }]);
  });

  it('never-connected going online is firstOnline', () => {
    const out = diffArrivals(map([m('ada')]), [m('ada', { presence: 'online', offline_reason: null })]);
    expect(out).toEqual([{ kind: 'firstOnline', name: 'ada', memberKind: 'human', hue: 40, sponsor: null, online: true }]);
  });

  it('a reconnect (previously disconnected) is not an arrival', () => {
    const out = diffArrivals(map([m('ada', { offline_reason: 'disconnected' })]), [
      m('ada', { presence: 'online', offline_reason: null }),
    ]);
    expect(out).toEqual([]);
  });

  it('away → online is not an arrival', () => {
    const out = diffArrivals(map([m('ada', { presence: 'away', offline_reason: null })]), [
      m('ada', { presence: 'online', offline_reason: null }),
    ]);
    expect(out).toEqual([]);
  });

  it('services never arrive', () => {
    expect(diffArrivals(map([]), [m('sweep', { kind: 'agent', service: true })])).toEqual([]);
  });

  it('agents carry memberKind agent', () => {
    expect(diffArrivals(map([]), [m('bot', { kind: 'agent' })])[0]?.memberKind).toBe('agent');
  });
});

describe('newArrivalsCorner', () => {
  const now = 100 * 3_600_000;
  it('lists deskless Members created in the last 24 h, newest first, at most 3', () => {
    const nodes = [
      m('a', { created_at: now - 1_000 }),
      m('b', { created_at: now - 2_000 }),
      m('c', { created_at: now - 3_000 }),
      m('d', { created_at: now - 4_000 }),
      m('old', { created_at: now - 25 * 3_600_000 }),
      m('seated', { created_at: now - 500 }),
      m('svc', { created_at: now - 100, service: true }),
      m('gone', { created_at: now - 100, offline_reason: 'left_team' }),
    ];
    expect(newArrivalsCorner(nodes, new Set(['seated']), now).map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/arrivals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// packages/web/src/live/office-scene/arrivals.ts
import type { OfficeNode } from './types';

/**
 * Who is NEW in the room (lane 01M3F81DD9, spec §4.2) — a pure diff of two consecutive rosters.
 *
 * `created`: a name the previous roster did not have. `firstOnline`: a Member going online whose
 * previous entry was offline with `offline_reason: 'unknown'` — the server's never-connected value
 * (offline.wire.ts). Nothing is remembered anywhere: a live viewer sees the moment, a reload does not
 * replay it, and the first roster the scene sees (`prev === null`) is never an arrival — the same
 * no-stampede rule `actors.setHomes` keeps for walk-ins.
 *
 * Fed the SCENE's previous map, not the network's last response: a failed refetch followed by a good
 * one must not replay what already played.
 */
export type ArrivalSubject = Pick<
  OfficeNode,
  'name' | 'kind' | 'service' | 'presence' | 'offline_reason' | 'hue' | 'created_at' | 'sponsored_by'
>;

export interface Arrival {
  kind: 'created' | 'firstOnline';
  name: string;
  memberKind: 'agent' | 'human';
  hue: number | null;
  sponsor: string | null;
  /** Online right now — a `created` arrival that is already online plays Act 1 folded into Act 2. */
  online: boolean;
}

function arrival(kind: Arrival['kind'], n: ArrivalSubject): Arrival {
  return {
    kind,
    name: n.name,
    memberKind: n.kind,
    hue: n.hue ?? null,
    sponsor: n.sponsored_by ?? null,
    online: n.presence === 'online',
  };
}

export function diffArrivals(
  prev: ReadonlyMap<string, ArrivalSubject> | null,
  next: readonly ArrivalSubject[],
): Arrival[] {
  if (prev === null) return [];
  const out: Arrival[] = [];
  for (const n of next) {
    if (n.service) continue; // ledger seats are not arrivals
    const before = prev.get(n.name);
    if (!before) {
      out.push(arrival('created', n));
    } else if (
      before.presence === 'offline' &&
      before.offline_reason === 'unknown' &&
      n.presence === 'online'
    ) {
      out.push(arrival('firstOnline', n));
    }
  }
  return out;
}

/** The corner holds this many polaroids — more is a noticeboard, not a welcome. */
export const CORNER_MAX = 3;
/** How long a deskless newcomer stays pinned. */
export const CORNER_WINDOW_MS = 24 * 3_600_000;

/**
 * The wallboard's *new arrivals* corner (spec §3.1): Members created in the last 24 h who hold no desk.
 * Derived from the roster every bake, never stored — so it survives a reload as a still.
 */
export function newArrivalsCorner(
  nodes: readonly ArrivalSubject[],
  deskHolders: ReadonlySet<string>,
  now: number,
): { name: string; hue: number | null }[] {
  return nodes
    .filter(
      (n) =>
        !n.service &&
        n.offline_reason !== 'left_team' &&
        !deskHolders.has(n.name) &&
        n.created_at !== null &&
        now - n.created_at < CORNER_WINDOW_MS,
    )
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, CORNER_MAX)
    .map((n) => ({ name: n.name, hue: n.hue ?? null }));
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/arrivals.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/office-scene/arrivals.ts packages/web/src/live/office-scene/arrivals.test.ts \
  packages/web/src/live/office-scene/types.ts packages/web/src/live/OfficeScene.tsx packages/web/src
git commit -m "feat(web): arrivals — a pure roster diff that knows who is new in the office

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
```

---

### Task 3: Web — the beat sequencer (`welcomeWagon.ts`)

**Files:**
- Create: `packages/web/src/live/office-scene/welcomeWagon.ts`
- Create: `packages/web/src/live/office-scene/welcomeWagon.test.ts`

**Interfaces:**
- Consumes: `Arrival` from Task 2.
- Produces:

```ts
export type WelcomeBeat =
  | { type: 'ring' }
  | { type: 'say'; text: string }
  | { type: 'label'; name: string; hue: number | null }
  | { type: 'wagon'; name: string }
  | { type: 'polaroid'; name: string }
  | { type: 'doorbell'; hue: number | null }
  | { type: 'toss'; name: string; hue: number | null }
  | { type: 'wave'; name: string }
  | { type: 'confetti'; name: string; hue: number | null }
  | { type: 'hello'; name: string }
  | { type: 'zoomies' }
  | { type: 'counter'; value: number }
  | { type: 'caption'; text: string; who: string };
export interface WagonDeps {
  busy: boolean;            // real choreography playing → a sequence may not START
  reduced: boolean;         // prefers-reduced-motion
  present(name: string): boolean;
  hasDesk(name: string): boolean;
  seated(name: string): boolean;
  atMark(name: string): boolean;
}
export interface WelcomeWagonState { /* opaque to callers */ }
export function createWelcomeWagon(): WelcomeWagonState;
export function enqueueArrivals(s: WelcomeWagonState, arrivals: readonly Arrival[], now: number): void;
export function stepWelcomeWagon(s: WelcomeWagonState, now: number, deps: WagonDeps): WelcomeBeat[];
export function welcomePlaying(s: WelcomeWagonState): boolean;
export const WAVE_MS = 2_000, CROWD_MIN = 3, TOSS_GAP_S = 0.6, BACKLOG_MAX = 6, GATE_TIMEOUT_S = 12, STALE_S = 20;
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/web/src/live/office-scene/welcomeWagon.test.ts
import { describe, expect, it } from 'vitest';
import type { Arrival } from './arrivals';
import {
  BACKLOG_MAX,
  createWelcomeWagon,
  enqueueArrivals,
  stepWelcomeWagon,
  welcomePlaying,
  WAVE_MS,
  type WagonDeps,
  type WelcomeBeat,
} from './welcomeWagon';

const a = (name: string, over: Partial<Arrival> = {}): Arrival => ({
  kind: 'created', name, memberKind: 'human', hue: 40, sponsor: null, online: false, ...over,
});
const deps = (over: Partial<WagonDeps> = {}): WagonDeps => ({
  busy: false, reduced: false, present: () => true, hasDesk: () => true, seated: () => true, atMark: () => true, ...over,
});
/** Step from t0 to t1 (ms) in 50 ms frames, collecting every beat with the time it fired. */
function run(s: ReturnType<typeof createWelcomeWagon>, t0: number, t1: number, d: WagonDeps = deps()) {
  const out: { at: number; beat: WelcomeBeat }[] = [];
  for (let t = t0; t <= t1; t += 50) for (const beat of stepWelcomeWagon(s, t, d)) out.push({ at: t - t0, beat });
  return out;
}
const types = (xs: { beat: WelcomeBeat }[]) => xs.map((x) => x.beat.type);

describe('welcomeWagon — Act 1 (created, offline)', () => {
  it('waits for the wave window, then rings, labels, sends the wagon and captions', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { sponsor: 'nick' })], 0);
    expect(stepWelcomeWagon(s, WAVE_MS - 1, deps())).toEqual([]); // the wave is still forming
    const beats = run(s, WAVE_MS, WAVE_MS + 5_000);
    expect(types(beats)).toEqual(['ring', 'say', 'label', 'wagon', 'caption']);
    expect(beats.find((b) => b.beat.type === 'say')!.beat).toEqual({ type: 'say', text: 'oh! someone new: ada' });
    expect(beats.find((b) => b.beat.type === 'caption')!.beat).toEqual({
      type: 'caption', text: 'ada was added to the team · by nick', who: 'ada',
    });
    expect(welcomePlaying(s)).toBe(false);
  });

  it('with no free desk the dog takes a polaroid to the wall instead', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada')], 0);
    const beats = run(s, WAVE_MS, WAVE_MS + 5_000, deps({ hasDesk: () => false }));
    expect(types(beats)).toContain('polaroid');
    expect(types(beats)).not.toContain('wagon');
  });
});

describe('welcomeWagon — Act 2 (first time online)', () => {
  it('doorbell, toss at the mark, waves, confetti once seated, hello, caption', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    const beats = run(s, WAVE_MS, WAVE_MS + 8_000);
    expect(types(beats)).toEqual(['doorbell', 'toss', 'say', 'wave', 'confetti', 'hello', 'caption']);
    expect(beats.find((b) => b.beat.type === 'caption')!.beat).toMatchObject({ text: 'ada joined the team — welcome' });
  });

  it('confetti waits for the seat, and gives up after the gate timeout', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    const beats = run(s, WAVE_MS, WAVE_MS + 20_000, deps({ seated: () => false }));
    expect(types(beats)).not.toContain('confetti');
    expect(types(beats)).toContain('caption'); // the line is still written
    expect(welcomePlaying(s)).toBe(false);
  });

  it('created-and-online folds Act 1 in: label and wagon ride along, one caption', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('guest', { online: true })], 0);
    const t = types(run(s, WAVE_MS, WAVE_MS + 8_000));
    expect(t).toContain('label');
    expect(t).toContain('wagon');
    expect(t.filter((x) => x === 'caption')).toHaveLength(1);
    expect(t).not.toContain('ring'); // the doorbell is the one sound that opens the fold
  });

  it('skips beats for a Member who left before they fired', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    const t = types(run(s, WAVE_MS, WAVE_MS + 8_000, deps({ present: () => false })));
    expect(t).toEqual([]);
  });
});

describe('welcomeWagon — the crowd', () => {
  const crowd = (n: number) => Array.from({ length: n }, (_, i) => a(`g${i}`, { online: true }));

  it('one doorbell, one zoomies, a toss + counter per guest, one confetti, one caption', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, crowd(5), 0);
    const t = types(run(s, WAVE_MS, WAVE_MS + 10_000));
    expect(t.filter((x) => x === 'doorbell')).toHaveLength(1);
    expect(t.filter((x) => x === 'zoomies')).toHaveLength(1);
    expect(t.filter((x) => x === 'toss')).toHaveLength(5);
    expect(t.filter((x) => x === 'counter')).toHaveLength(5);
    expect(t.filter((x) => x === 'confetti')).toHaveLength(1);
    expect(t.filter((x) => x === 'caption')).toHaveLength(1);
  });

  it('tosses are 0.6 s apart and the counter counts up across waves', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, crowd(3), 0);
    const first = run(s, WAVE_MS, WAVE_MS + 6_000);
    const tossAt = first.filter((b) => b.beat.type === 'toss').map((b) => b.at);
    expect(tossAt[1]! - tossAt[0]!).toBe(600);
    enqueueArrivals(s, [a('x', { online: true }), a('y', { online: true }), a('z', { online: true })], 10_000);
    const second = run(s, 10_000 + WAVE_MS, 10_000 + WAVE_MS + 6_000);
    expect(second.filter((b) => b.beat.type === 'counter').map((b) => (b.beat as { value: number }).value)).toEqual([4, 5, 6]);
  });

  it('an all-human crowd says guests; a mixed one says teammates', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, crowd(3), 0);
    const cap = run(s, WAVE_MS, WAVE_MS + 6_000).find((b) => b.beat.type === 'caption')!.beat;
    expect(cap).toMatchObject({ text: '3 guests joined — welcome' });
    const s2 = createWelcomeWagon();
    enqueueArrivals(s2, [...crowd(2), a('bot', { online: true, memberKind: 'agent' })], 0);
    const cap2 = run(s2, WAVE_MS, WAVE_MS + 6_000).find((b) => b.beat.type === 'caption')!.beat;
    expect(cap2).toMatchObject({ text: '3 teammates joined — welcome' });
  });

  it('past the backlog cap, everything pending merges into one wave', () => {
    const s = createWelcomeWagon();
    // Arrivals 3 s apart would normally be separate waves…
    for (let i = 0; i <= BACKLOG_MAX; i++) enqueueArrivals(s, [a(`s${i}`, { online: true })], i * 3_000);
    const t = types(run(s, BACKLOG_MAX * 3_000 + WAVE_MS, BACKLOG_MAX * 3_000 + WAVE_MS + 12_000));
    expect(t.filter((x) => x === 'doorbell')).toHaveLength(1); // …but the backlog plays as one crowd
    expect(t.filter((x) => x === 'toss')).toHaveLength(BACKLOG_MAX + 1);
  });
});

describe('welcomeWagon — guards', () => {
  it('does not START while real choreography plays', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada')], 0);
    expect(run(s, WAVE_MS, WAVE_MS + 3_000, deps({ busy: true }))).toEqual([]);
    expect(types(run(s, WAVE_MS + 3_050, WAVE_MS + 8_000))[0]).toBe('ring');
  });

  it('once started, busy does not stop it', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada')], 0);
    run(s, WAVE_MS, WAVE_MS + 100);
    expect(types(run(s, WAVE_MS + 150, WAVE_MS + 5_000, deps({ busy: true })))).toContain('caption');
  });

  it('reduced motion: end states and caption only', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { online: true })], 0);
    const t = types(run(s, WAVE_MS, WAVE_MS + 8_000, deps({ reduced: true })));
    expect(t).toEqual(['label', 'caption']);
  });

  it('a sequence left unstepped past STALE_S (hidden tab) is dropped whole, not burst', () => {
    const s = createWelcomeWagon();
    enqueueArrivals(s, [a('ada', { kind: 'firstOnline', online: true })], 0);
    stepWelcomeWagon(s, WAVE_MS, deps()); // starts
    expect(stepWelcomeWagon(s, WAVE_MS + 60_000, deps())).toEqual([]);
    expect(welcomePlaying(s)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/welcomeWagon.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/web/src/live/office-scene/welcomeWagon.ts
import type { Arrival } from './arrivals';

/**
 * The Welcome Wagon (lane 01M3F81DD9, spec §3) — WHEN each welcome beat happens, and nothing about how
 * it looks. A plain state object stepped by the scene loop, the shape pet.ts / receptionist.ts use:
 * arrivals are enqueued as the roster diff finds them, grouped into 2 s waves, turned into a timed
 * script, and stepped. The scene (index.ts) dispatches each returned beat to the resident that plays
 * it. Pure and clock-injected, so every rule below is a unit test, not a thing to eyeball.
 */

export type WelcomeBeat =
  | { type: 'ring' }
  | { type: 'say'; text: string }
  | { type: 'label'; name: string; hue: number | null }
  | { type: 'wagon'; name: string }
  | { type: 'polaroid'; name: string }
  | { type: 'doorbell'; hue: number | null }
  | { type: 'toss'; name: string; hue: number | null }
  | { type: 'wave'; name: string }
  | { type: 'confetti'; name: string; hue: number | null }
  | { type: 'hello'; name: string }
  | { type: 'zoomies' }
  | { type: 'counter'; value: number }
  | { type: 'caption'; text: string; who: string };

export interface WagonDeps {
  busy: boolean;
  reduced: boolean;
  present(name: string): boolean;
  hasDesk(name: string): boolean;
  seated(name: string): boolean;
  atMark(name: string): boolean;
}

/** Arrivals this close together are one wave. */
export const WAVE_MS = 2_000;
/** A wave with this many online arrivals is a crowd. */
export const CROWD_MIN = 3;
/** The receptionist's conveyor cadence in a crowd. */
export const TOSS_GAP_S = 0.6;
/** Past this many queued arrivals, everything pending plays as one wave. */
export const BACKLOG_MAX = 6;
/** A gated beat (toss at the mark, confetti at the seat) gives up after this long. */
export const GATE_TIMEOUT_S = 12;
/** A sequence unstepped for this long (a hidden tab) is dropped, never burst. */
export const STALE_S = 20;

type Gate = { kind: 'seated' | 'mark'; name: string };
interface Cue {
  t: number;
  beat: WelcomeBeat;
  /** The Member the beat is about — skipped if they are no longer in the room. */
  who?: string;
  gate?: Gate;
}
interface Sequence {
  startedAt: number;
  lastStepAt: number;
  cues: Cue[];
}
interface Pending extends Arrival {
  at: number;
}
export interface WelcomeWagonState {
  pending: Pending[];
  playing: Sequence | null;
  /** Guests counted so far this crowd session — the flip counter's value. */
  guests: number;
}

export function createWelcomeWagon(): WelcomeWagonState {
  return { pending: [], playing: null, guests: 0 };
}

export function enqueueArrivals(s: WelcomeWagonState, arrivals: readonly Arrival[], now: number): void {
  for (const a of arrivals) s.pending.push({ ...a, at: now });
}

export function welcomePlaying(s: WelcomeWagonState): boolean {
  return s.playing !== null;
}

function addedLine(a: Arrival): string {
  return a.sponsor ? `${a.name} was added to the team · by ${a.sponsor}` : `${a.name} was added to the team`;
}

/** Act 1 alone: the room makes space (spec §3.1). */
function actOne(a: Arrival, d: WagonDeps): Cue[] {
  if (d.reduced) return [{ t: 0, beat: { type: 'label', name: a.name, hue: a.hue } }, { t: 0, beat: { type: 'caption', text: addedLine(a), who: a.name } }];
  return [
    { t: 0, beat: { type: 'ring' } },
    { t: 0, beat: { type: 'say', text: `oh! someone new: ${a.name}` } },
    { t: 0.9, beat: { type: 'label', name: a.name, hue: a.hue }, who: a.name },
    { t: 1.4, beat: d.hasDesk(a.name) ? { type: 'wagon', name: a.name } : { type: 'polaroid', name: a.name }, who: a.name },
    { t: 4.0, beat: { type: 'caption', text: addedLine(a), who: a.name } },
  ];
}

/** Act 2 (with Act 1 folded in when the Member was also just created): the welcome (spec §3.2–3.3). */
function actTwo(a: Arrival, d: WagonDeps): Cue[] {
  const caption: Cue = { t: 6.2, beat: { type: 'caption', text: `${a.name} joined the team — welcome`, who: a.name }, who: a.name };
  if (d.reduced) {
    const end: Cue[] = a.kind === 'created' ? [{ t: 0, beat: { type: 'label', name: a.name, hue: a.hue } }] : [];
    return [...end, { ...caption, t: 0 }];
  }
  const fold: Cue[] =
    a.kind === 'created'
      ? [
          { t: 0.1, beat: { type: 'label', name: a.name, hue: a.hue }, who: a.name },
          { t: 0.4, beat: d.hasDesk(a.name) ? { type: 'wagon', name: a.name } : { type: 'polaroid', name: a.name }, who: a.name },
        ]
      : [];
  return [
    { t: 0, beat: { type: 'doorbell', hue: a.hue }, who: a.name },
    ...fold,
    { t: 1.6, beat: { type: 'toss', name: a.name, hue: a.hue }, who: a.name, gate: { kind: 'mark', name: a.name } },
    { t: 1.6, beat: { type: 'say', text: `welcome, ${a.name}!` }, who: a.name, gate: { kind: 'mark', name: a.name } },
    { t: 2.6, beat: { type: 'wave', name: a.name }, who: a.name },
    { t: 5.2, beat: { type: 'confetti', name: a.name, hue: a.hue }, who: a.name, gate: { kind: 'seated', name: a.name } },
    { t: 6.0, beat: { type: 'hello', name: a.name }, who: a.name, gate: { kind: 'seated', name: a.name } },
    caption,
  ];
}

/** A crowd: one doorbell, one lap of zoomies, conveyor tosses, one confetti, one caption (spec §3.4). */
function crowd(online: Arrival[], s: WelcomeWagonState, d: WagonDeps): Cue[] {
  const n = online.length;
  const noun = online.every((a) => a.memberKind === 'human') ? 'guests' : 'teammates';
  const caption: Cue = { t: 1.2 + n * TOSS_GAP_S, beat: { type: 'caption', text: `${n} ${noun} joined — welcome`, who: online[0]!.name } };
  if (d.reduced) {
    s.guests += n;
    return [{ ...caption, t: 0 }];
  }
  const cues: Cue[] = [
    { t: 0, beat: { type: 'doorbell', hue: null } },
    { t: 0.2, beat: { type: 'zoomies' } },
  ];
  online.forEach((a, i) => {
    const t = 1.2 + i * TOSS_GAP_S;
    s.guests += 1;
    cues.push({ t, beat: { type: 'toss', name: a.name, hue: a.hue }, who: a.name });
    cues.push({ t, beat: { type: 'counter', value: s.guests } });
    if (i === 0) cues.push({ t, beat: { type: 'say', text: 'welcome!' } });
  });
  cues.push({ t: 1.2 + n * TOSS_GAP_S, beat: { type: 'confetti', name: online[0]!.name, hue: null } });
  cues.push(caption);
  return cues;
}

/** Several Members created offline in one wave: one ring, their labels, one caption. */
function createdGroup(created: Arrival[], d: WagonDeps): Cue[] {
  if (created.length === 1) return actOne(created[0]!, d);
  const caption: Cue = { t: 4.0, beat: { type: 'caption', text: `${created.length} members were added to the team`, who: created[0]!.name } };
  if (d.reduced) return [...created.map((a) => ({ t: 0, beat: { type: 'label', name: a.name, hue: a.hue } as WelcomeBeat })), { ...caption, t: 0 }];
  const withDesk = created.find((a) => d.hasDesk(a.name));
  return [
    { t: 0, beat: { type: 'ring' } },
    ...created.map((a, i): Cue => ({ t: 0.9 + i * 0.3, beat: { type: 'label', name: a.name, hue: a.hue }, who: a.name })),
    ...(withDesk ? [{ t: 1.4, beat: { type: 'wagon', name: withDesk.name }, who: withDesk.name } as Cue] : []),
    caption,
  ];
}

function scriptFor(wave: Pending[], s: WelcomeWagonState, d: WagonDeps): Cue[] {
  const online = wave.filter((a) => a.online);
  const offlineCreated = wave.filter((a) => !a.online && a.kind === 'created');
  const cues: Cue[] = [];
  if (online.length >= CROWD_MIN) cues.push(...crowd(online, s, d));
  else if (online.length > 0) {
    // One or two online arrivals: the full welcome each, the second offset so they do not collide.
    online.forEach((a, i) => cues.push(...actTwo(a, d).map((c) => ({ ...c, t: c.t + i * 1.0 }))));
  }
  if (offlineCreated.length > 0) {
    const offset = cues.length > 0 ? 7 : 0; // after the welcome, never over it
    cues.push(...createdGroup(offlineCreated, d).map((c) => ({ ...c, t: c.t + offset })));
  }
  return cues.sort((x, y) => x.t - y.t);
}

function takeWave(s: WelcomeWagonState): Pending[] {
  if (s.pending.length > BACKLOG_MAX) {
    const all = s.pending;
    s.pending = [];
    return all;
  }
  const first = s.pending[0]!.at;
  const wave = s.pending.filter((p) => p.at - first <= WAVE_MS);
  s.pending = s.pending.filter((p) => p.at - first > WAVE_MS);
  return wave;
}

export function stepWelcomeWagon(s: WelcomeWagonState, now: number, d: WagonDeps): WelcomeBeat[] {
  if (s.playing && (now - s.playing.lastStepAt) / 1000 > STALE_S) s.playing = null; // hidden tab: drop, never burst
  if (!s.playing) {
    if (s.pending.length === 0 || d.busy) return [];
    const ready = s.pending.length > BACKLOG_MAX || now - s.pending[0]!.at >= WAVE_MS;
    if (!ready) return [];
    s.playing = { startedAt: now, lastStepAt: now, cues: scriptFor(takeWave(s), s, d) };
  }
  const seq = s.playing;
  seq.lastStepAt = now;
  const elapsed = (now - seq.startedAt) / 1000;
  const out: WelcomeBeat[] = [];
  seq.cues = seq.cues.filter((c) => {
    if (c.t > elapsed) return true;
    if (c.who && !d.present(c.who)) return false; // they left before their beat
    if (c.gate) {
      const open = c.gate.kind === 'seated' ? d.seated(c.gate.name) : d.atMark(c.gate.name);
      if (!open) return elapsed - c.t < GATE_TIMEOUT_S; // keep waiting, or give up quietly
    }
    out.push(c.beat);
    return false;
  });
  if (seq.cues.length === 0) s.playing = null;
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/welcomeWagon.test.ts`
Expected: PASS. If `'doorbell, toss at the mark…'` shows `say` before `toss`, keep the cue order stable: `Array.prototype.sort` is stable, so the script's authored order within one `t` is preserved — fix by authoring `toss` before `say` (already so above).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/office-scene/welcomeWagon.ts packages/web/src/live/office-scene/welcomeWagon.test.ts
git commit -m "feat(web): welcomeWagon — the pure beat sequencer for the joined-the-team moment

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
```

---

### Task 4: Residents — the dog's wagon, the receptionist's cues

**Files:**
- Modify: `packages/web/src/live/office-scene/pet.ts`
- Modify: `packages/web/src/live/office-scene/pet.test.ts`
- Modify: `packages/web/src/live/office-scene/receptionist.ts`
- Modify: `packages/web/src/live/office-scene/receptionist.test.ts`

**Interfaces:**
- Produces (pet): `PetState.cargo: 'none' | 'wagon' | 'polaroid'`, `PetState.errand: null | { stage: 'fetch' | 'deliver'; drop: P }`, `petWagon(pet: PetState, pickup: P, drop: P): boolean`, `petCarryToWall(pet: PetState, pickup: P, wall: P): boolean`, `petZoomies(pet: PetState, rng?: () => number): boolean`
- Produces (receptionist): `ReceptionistMode` gains `'ringing' | 'label' | 'toss'`; `receptionistCue(r: ReceptionistState, cue: 'ring' | 'label' | 'toss'): void`; `RECEPTION_CUE_S: Record<'ringing' | 'label' | 'toss', number>`

- [ ] **Step 1: Write the failing pet tests**

Append to `pet.test.ts`:

```ts
import { createPet, petCarryToWall, petWagon, petZoomies, stepPet } from './pet';
import { RECEPTION, DESK_SLOTS } from './layout';

describe('the welcome wagon (lane 01M3F81DD9)', () => {
  const pickup = { lx: RECEPTION.plant.lx - 60, ly: RECEPTION.plant.ly - 70 };
  const drop = { lx: DESK_SLOTS[0]!.lx, ly: DESK_SLOTS[0]!.ly + 40 };
  const runUntil = (pet: ReturnType<typeof createPet>, pred: () => boolean, max = 60) => {
    for (let t = 0; t < max && !pred(); t += 0.05) stepPet(pet, 0.05);
  };

  it('fetches with nothing, pulls the wagon to the drop, then sits beside it and lets it go', () => {
    const pet = createPet(() => 0.5);
    expect(petWagon(pet, pickup, drop)).toBe(true);
    expect(pet.cargo).toBe('none');
    runUntil(pet, () => pet.errand?.stage === 'deliver');
    expect(pet.cargo).toBe('wagon');
    runUntil(pet, () => pet.mode === 'sit');
    expect(Math.hypot(pet.lx - drop.lx, pet.ly - drop.ly)).toBeLessThan(40);
    expect(pet.cargo).toBe('none');
    expect(pet.errand).toBeNull();
  });

  it('carries a polaroid in its mouth to the wall', () => {
    const pet = createPet(() => 0.5);
    expect(petCarryToWall(pet, pickup, { lx: 520, ly: 40 })).toBe(true);
    runUntil(pet, () => pet.errand?.stage === 'deliver');
    expect(pet.cargo).toBe('polaroid');
  });

  it('zoomies is callable from the scene', () => {
    const pet = createPet(() => 0.5);
    expect(petZoomies(pet, () => 0.3)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/pet.test.ts -t "welcome wagon"`
Expected: FAIL — `petWagon` is not exported.

- [ ] **Step 3: Implement the pet errands**

In `PetState` add:

```ts
  /** What the dog is hauling this frame — the painter draws it. `none` outside a welcome errand. */
  cargo: 'none' | 'wagon' | 'polaroid';
  /** A two-stage welcome errand (lane 01M3F81DD9): fetch at reception, then deliver to `drop`. */
  errand: null | { stage: 'fetch' | 'deliver'; drop: P; load: 'wagon' | 'polaroid' };
```

In `createPet`'s returned object add `cargo: 'none', errand: null,`.

Add after `petFollow`:

```ts
/**
 * The welcome wagon (spec §3.1): trot to the reception pickup, take the handle, pull the wagon to the
 * new Member's desk, flop down beside it. Two ordinary trips on the nav grid — the second is started by
 * `stepPet` when the first arrives — so every rule the dog already walks by (no-skate gait, braking,
 * eased turns) holds for free. Outranks a nap, like the door greeting.
 */
export function petWagon(pet: PetState, pickup: P, drop: P): boolean {
  return startErrand(pet, pickup, drop, 'wagon');
}

/** No free desk: the printed nameplate goes to the wallboard's new-arrivals corner in the dog's mouth. */
export function petCarryToWall(pet: PetState, pickup: P, wall: P): boolean {
  return startErrand(pet, pickup, wall, 'polaroid');
}

/** The crowd's one lap (spec §3.4) — the existing zoomies, reachable from the scene. */
export function petZoomies(pet: PetState, rng: () => number = Math.random): boolean {
  if (pet.mode === 'stretch' || pet.mode === 'curl') return false;
  return zoomies(pet, rng);
}

function startErrand(pet: PetState, pickup: P, drop: P, load: 'wagon' | 'polaroid'): boolean {
  if (pet.errand) return false; // one welcome trip at a time (spec §3.4)
  pet.sitFor = 4;
  // MIN_TRIP 0: the dog may already be lying by reception, and the errand must still run.
  if (!setOff(pet, pickup, 'sit-then-nap', 0)) return false;
  pet.errand = { stage: 'fetch', drop, load };
  pet.cargo = 'none';
  return true;
}
```

`setOff` returns false when `target` is `null` or closer than `minTrip`; with `minTrip` 0 it only fails on `null`.

In `stepPet`, in the `case 'walk'` arrival block (where `pet.seg >= pet.path.length - 1`), replace the first line with:

```ts
      if (pet.seg >= pet.path.length - 1) {
        if (pet.errand?.stage === 'fetch') {
          // Picked it up: the second leg leaves from here, hauling. A short beat, then off again.
          const { drop, load } = pet.errand;
          pet.errand = { stage: 'deliver', drop, load };
          pet.cargo = load;
          pet.path = findPath({ lx: pet.lx, ly: pet.ly }, drop);
          pet.seg = 0;
          pet.vel = 0;
          return true;
        }
        if (pet.errand?.stage === 'deliver') {
          pet.errand = null;
          pet.cargo = 'none'; // the wagon stays parked at the desk only for the painter's fade (render.ts)
        }
        pet.mode = pet.plan === 'sit-then-nap' ? 'sit' : 'curl';
```

(keep the rest of that block as it was).

- [ ] **Step 4: Run the pet tests**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/pet.test.ts`
Expected: PASS, including every pre-existing pet test.

- [ ] **Step 5: Write the failing receptionist tests**

Append to `receptionist.test.ts`:

```ts
import { createReceptionist, receptionistCue, RECEPTION_CUE_S, stepReceptionist } from './receptionist';

describe('welcome cues (lane 01M3F81DD9)', () => {
  const seed = { team: 'dawn', nowMs: 0 };
  it('a cue wakes her if asleep and plays for its length, then she is idle', () => {
    const r = createReceptionist();
    receptionistCue(r, 'ring');
    expect(r.mode).toBe('ringing');
    let t = 0;
    while (t < RECEPTION_CUE_S.ringing + 0.1) {
      stepReceptionist(r, 0.05, true, false, seed);
      t += 0.05;
    }
    expect(r.mode).toBe('idle');
  });

  it('a cue outranks a work beat, and a check-in greeting does not cut a toss short', () => {
    const r = createReceptionist();
    r.mode = 'typing';
    receptionistCue(r, 'toss');
    stepReceptionist(r, 0.05, true, true, seed);
    expect(r.mode).toBe('toss');
  });

  it('cues hold the dynamic frame', () => {
    const r = createReceptionist();
    receptionistCue(r, 'label');
    expect(stepReceptionist(r, 0.05, true, false, seed)).toBe(true);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/receptionist.test.ts -t "welcome cues"`
Expected: FAIL — `receptionistCue` not exported.

- [ ] **Step 7: Implement the cues**

In `receptionist.ts`:

```ts
export type ReceptionistMode = 'asleep' | 'waking' | 'idle' | 'greeting' | 'typing' | 'call' | 'ringing' | 'label' | 'toss';

/**
 * The welcome's front-desk beats (lane 01M3F81DD9): the phone ringing and picked up, the label maker,
 * the lanyard toss. She still never leaves the desk — the toss is how she reaches an arrival.
 */
export const RECEPTION_CUE_S: Record<'ringing' | 'label' | 'toss', number> = { ringing: 1.1, label: 0.8, toss: 0.7 };

export function receptionistCue(r: ReceptionistState, cue: 'ring' | 'label' | 'toss'): void {
  r.mode = cue === 'ring' ? 'ringing' : cue;
  r.modeT = 0;
  r.aloneT = 0;
}
```

In `stepReceptionist`'s `switch`, add before `case 'greeting':`:

```ts
    case 'ringing':
    case 'label':
    case 'toss':
      // A welcome cue plays to its end — a greeting waiting on it just starts a beat later.
      if (r.modeT >= RECEPTION_CUE_S[r.mode]) {
        r.mode = greeting ? 'greeting' : 'idle';
        r.modeT = 0;
        r.lastSlot = slot;
      }
      break;
```

Change the final `return` to include the cues:

```ts
  return (
    r.mode !== before ||
    r.mode === 'waking' ||
    r.mode === 'greeting' ||
    r.mode === 'ringing' ||
    r.mode === 'label' ||
    r.mode === 'toss' ||
    receptionistBusy(r)
  );
```

`drawReceptionist` in `render.ts` switches on mode; until Task 7 paints the new poses, map them to the nearest existing pose so typecheck passes: `ringing` → the `call` pose, `label` → `typing`, `toss` → `greeting`. Find the pose switch with `grep -n "r.mode" packages/web/src/live/office-scene/render.ts`.

- [ ] **Step 8: Run the receptionist tests and typecheck**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/receptionist.test.ts src/live/office-scene/pet.test.ts && pnpm --filter @musterd/web typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/live/office-scene/pet.ts packages/web/src/live/office-scene/pet.test.ts \
  packages/web/src/live/office-scene/receptionist.ts packages/web/src/live/office-scene/receptionist.test.ts \
  packages/web/src/live/office-scene/render.ts
git commit -m "feat(web): the dog pulls the welcome wagon; the receptionist rings, labels and tosses

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
```

---

### Task 5: Actors — the first-arrival walk and the teammates' wave

**Files:**
- Modify: `packages/web/src/live/office-scene/types.ts` (`CarryKind`)
- Modify: `packages/web/src/live/office-scene/skeleton.ts` (`GESTURE.wave`, its pose, its exclusion from the scheduler)
- Modify: `packages/web/src/live/office-scene/actors.ts`
- Modify: `packages/web/src/live/office-scene/actors.test.ts`, `packages/web/src/live/office-scene/skeleton.test.ts`

**Interfaces:**
- Produces: `CarryKind` gains `'movingBox'`
- Produces: `GESTURE.wave = 19` (not in `IDLE_GESTURES`)
- Produces (on `Actors`): `expectFirstArrival(name: string, carry: CarryKind | null): void`, `welcomeWave(name: string): boolean`, `isSeated(name: string): boolean`
- Produces: `FIRST_ARRIVAL_HOLD_S = 2.4` (exported from actors.ts)

- [ ] **Step 1: Write the failing tests**

Append to `skeleton.test.ts`:

```ts
import { GESTURE, IDLE_GESTURES } from './skeleton';

it('the welcome wave is a gesture the scheduler can never pick (lane 01M3F81DD9)', () => {
  expect(GESTURE.wave).toBe(19);
  expect(IDLE_GESTURES).not.toContain(GESTURE.wave);
});
```

Append to `actors.test.ts` (reuse the file's existing helpers for building placements and `OfficeNode`s — find them with `grep -n "function node\|function place" packages/web/src/live/office-scene/actors.test.ts` and use those names):

```ts
describe('first arrival (lane 01M3F81DD9)', () => {
  it('a flagged arrival carries the moving box and holds longer at the mark', () => {
    const a = createActors();
    const before = new Map([['nick', { kind: 'desk', slot: 0 } as const]]);
    a.setHomes(before, nodesFor(['nick']), true); // first call snaps
    a.expectFirstArrival('ada', 'movingBox');
    a.setHomes(new Map([...before, ['ada', { kind: 'desk', slot: 3 } as const]]), nodesFor(['nick', 'ada']), true);
    expect(a.pendingCheckIns()).toContain('ada');
    let sawBox = false;
    let heldFor = 0;
    for (let t = 0; t < 12; t += 0.05) {
      a.step(0.05);
      const p = a.poses().get('ada');
      if (p?.carry === 'movingBox') sawBox = true;
      if (a.checkInMark('ada') !== null && p && !p.moving) heldFor += 0.05;
    }
    expect(sawBox).toBe(true);
    expect(heldFor).toBeGreaterThan(FIRST_ARRIVAL_HOLD_S - 0.2);
    expect(a.isSeated('ada')).toBe(true);
  });

  it('an unflagged arrival is the ordinary check-in', () => {
    const a = createActors();
    a.setHomes(new Map(), nodesFor([]), true);
    a.setHomes(new Map([['lin', { kind: 'desk', slot: 2 } as const]]), nodesFor(['lin']), true);
    for (let t = 0; t < 1; t += 0.05) a.step(0.05);
    expect(a.poses().get('lin')?.carry ?? null).toBeNull();
  });

  it('welcomeWave plays on a seated, free desk member and is refused mid-walk', () => {
    const a = createActors();
    a.setHomes(new Map([['nick', { kind: 'desk', slot: 0 } as const]]), nodesFor(['nick']), true);
    expect(a.welcomeWave('nick')).toBe(true);
    expect(a.poses().get('nick')?.gesture).toBe(GESTURE.wave);
  });
});
```

`nodesFor(names)` must build `OfficeNode`s with `presence: 'online'`; if the file has no such helper, add one next to its existing node builder.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/actors.test.ts src/live/office-scene/skeleton.test.ts -t "01M3F81DD9"`
Expected: FAIL — `GESTURE.wave` undefined / `expectFirstArrival` not a function.

- [ ] **Step 3: Implement the carry kind and the gesture**

`types.ts`:

```ts
export type CarryKind = 'box' | 'plate' | 'bottle' | 'mug' | 'phone' | 'laptop' | 'movingBox';
```

`skeleton.ts`, in `GESTURE` after `call: 13,`:

```ts
  /** The welcome wave (lane 01M3F81DD9): a hand up by the shoulder, the forearm rocking. Played only
   * by the Welcome Wagon on the three teammates nearest an arrival — never by the scheduler. */
  wave: 19,
```

and add `'wave'` to `ERRAND_GESTURES` (the list whose job is exactly "not scheduler-pickable"):

```ts
const ERRAND_GESTURES = ['browse', 'fill', 'eat', 'pour', 'call', 'wave'] as const;
```

In the pose `if/else` chain (next to `GESTURE.glance`), add:

```ts
  } else if (inp.gesture === GESTURE.wave) {
    // Hand up beside the head, palm out, the forearm rocking about the elbow — two and a half rocks.
    const a = arcEnv(inp.gestureT);
    const rock = Math.sin(inp.gestureT * Math.PI * 5) * 3 * a;
    const up = v(C.shoulderW + 3 + rock, s.shoulder[1].y + C.upperArm + 2, s.shoulder[1].z + 4);
    s.wrist[1] = lerp3(s.wrist[1], up, a);
    s.elbow[1] = ik2(s.shoulder[1], s.wrist[1], C.upperArm, C.foreArm, v(1, -0.6, 0.2));
    s.head = v(s.head.x + a * 1.5, s.head.y, s.head.z); // a glance toward the door with it
```

- [ ] **Step 4: Implement the actor hooks**

In `actors.ts`:

```ts
/** How long a first arrival stands at the mark — long enough to catch a lanyard (spec §3.2). */
export const FIRST_ARRIVAL_HOLD_S = 2.4;
/** The welcome wave's window, seconds. */
const WAVE_S = 1.6;
```

Inside `createActors`, next to the other state maps:

```ts
  /** Names whose NEXT arrival is their first ever (set by the Welcome Wagon before `setHomes`). */
  const firstArrivals = new Map<string, CarryKind | null>();
```

Change `checkInWalk` to take the extras:

```ts
  function checkInWalk(who: string, dest: Pose, mark: number, first?: { carry: CarryKind | null }): Walk {
    const speed = 78;
    const at = CHECK_IN_MARKS[mark]!;
    const from = entrancePose(dest);
    const carry = first?.carry ?? null;
    const toMark = legsAlong(findPath({ lx: from.lx, ly: from.ly }, { lx: at.lx, ly: at.ly }, othersAt(who)), speed, 1.2, 4, carry);
    const stand = endOf(toMark);
    const onward = legsAlong(findPath(stand, { lx: dest.lx, ly: dest.ly }, othersAt(who)), speed, 1.2, 5, carry);
    return {
      legs: [...toMark, hold(stand, 'N', first ? FIRST_ARRIVAL_HOLD_S : CHECK_IN_S, carry ? { carry } : {}), ...onward],
      i: 0,
      t: 0,
      small: dest.small,
      fade: 'in',
      checkIn: { mark, holdLeg: toMark.length },
    };
  }
```

Confirm `hold(...)`'s fourth parameter accepts `{ carry }` (it is the `extra` object with `carry?`, `overlay?`, `door?` shown at `actors.ts` `extra: { carry?: CarryKind; overlay?: number; door?: boolean }`).

In `setHomes`' arrival loop, replace the check-in branch:

```ts
          const first = firstArrivals.has(name) ? { carry: firstArrivals.get(name) ?? null } : undefined;
          firstArrivals.delete(name);
          if (!dest.small && marksDealt < CHECK_IN_MARKS.length) {
            walks.set(name, checkInWalk(name, dest, marksDealt++, first));
          } else {
            walks.set(name, straightWalk(name, entrancePose(dest), dest, false, 'in'));
          }
```

Add to the returned object (and to the `Actors` interface, each with a doc comment):

```ts
    /** The next arrival of `name` is their first ever: carry `carry`, and stand longer at the mark. */
    expectFirstArrival(name: string, carry: CarryKind | null) {
      firstArrivals.set(name, carry);
    },
    /** One welcome wave from a seated, free desk member (lane 01M3F81DD9). */
    welcomeWave(name: string) {
      if (!isFreeSeatedDeskMember(name)) return false;
      gestures.set(name, { kind: GESTURE.wave as never, t: 0, dur: WAVE_S });
      return true;
    },
    /** Home, not walking, and fully sat down. */
    isSeated(name: string) {
      const home = homes.get(name);
      return !!home && !walks.has(name) && (anim.get(name)?.sit ?? 0) > 0.9;
    },
```

`isFreeSeatedDeskMember` is the eligibility `gestureBeat` already applies — extract it from `gestureBeat` into a local function and call it from both, rather than duplicating the conditions. Check the `anim` entry's sit field name with `grep -n "sit" packages/web/src/live/office-scene/actors.ts | head` and use it.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/actors.test.ts src/live/office-scene/skeleton.test.ts`
Expected: PASS, pre-existing tests included.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/office-scene/types.ts packages/web/src/live/office-scene/skeleton.ts \
  packages/web/src/live/office-scene/actors.ts packages/web/src/live/office-scene/actors.test.ts \
  packages/web/src/live/office-scene/skeleton.test.ts
git commit -m "feat(web): first arrivals carry a box and linger at check-in; teammates can wave

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
```

---

### Task 6: Scene wiring — diff, sequence, dispatch

**Files:**
- Modify: `packages/web/src/live/office-scene/index.ts`
- Modify: `packages/web/src/live/soundLife.ts`, `packages/web/src/live/soundEngine.ts`
- Test: `packages/web/src/live/office-scene/scene-loop.test.ts`, `packages/web/src/live/sound.test.ts`

**Interfaces:**
- Consumes: `diffArrivals`, `newArrivalsCorner`, `ArrivalSubject` (Task 2); `createWelcomeWagon`, `enqueueArrivals`, `stepWelcomeWagon`, `welcomePlaying`, `WelcomeBeat` (Task 3); `petWagon`, `petCarryToWall`, `petZoomies` (Task 4); `receptionistCue` (Task 4); `actors.expectFirstArrival`, `actors.welcomeWave`, `actors.isSeated`, `actors.checkInMark` (Task 5).
- Produces: `Moment` gains `'ring' | 'ratchet' | 'rattle' | 'doorbell' | 'pop'`.
- Produces (scene-local state read by Task 7 painters via `RenderOpts.welcome`):

```ts
interface WelcomePaint {
  lanyards: Map<string, string>;          // name → hue colour, until seated
  hello: Map<string, number>;             // name → clock when the hello screen started
  bootBlink: Map<string, number>;         // agent name → clock when the blink started
  labels: { color: string; t0: number }[];// label strips curling off the counter
  polaroids: { name: string; color: string }[]; // the corner, derived each bake
  counter: { value: number; flippedAt: number; until: number } | null;
  wagonAt: { lx: number; ly: number; t0: number } | null; // the parked wagon while it fades
}
```

- [ ] **Step 1: Add the sound moments (test first)**

Append to `sound.test.ts` a test that every `Moment` has an engine voice — if the file already has a "moment voices" table test, extend its list with the five new names; otherwise:

```ts
import type { Moment } from './soundLife';
it('the welcome moments are Moments (lane 01M3F81DD9)', () => {
  const names: Moment[] = ['ring', 'ratchet', 'rattle', 'doorbell', 'pop'];
  expect(names).toHaveLength(5);
});
```

Extend the union in `soundLife.ts`:

```ts
export type Moment =
  | 'fanfare' | 'door' | 'askbell' | 'plateOpen' | 'plateClose' | 'boardOpen' | 'boardClose' | 'whoosh'
  // The Welcome Wagon (lane 01M3F81DD9): the desk phone, the label maker, the wagon's wheels, the
  // front-door chime, and the confetti pop. All synthesized — no audio files (ADR 151 bytes).
  | 'ring' | 'ratchet' | 'rattle' | 'doorbell' | 'pop';
```

In `soundEngine.ts` `moment()` switch add the cases, and the voices below `whoosh` (they reuse the file's `click` and `noiseBuffer` helpers):

```ts
      case 'ring': return this.ring(ctx, out);
      case 'ratchet': return this.ratchet(ctx, out);
      case 'rattle': return this.rattle(ctx, out);
      case 'doorbell': return this.doorbell(ctx, out);
      case 'pop': return this.pop(ctx, out);
```

```ts
  /** The front-desk phone: a two-tone trill, twice. Quiet — it is across the room. */
  private ring(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 6; i++) {
        const t = t0 + r * 0.42 + i * 0.045;
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(i % 2 ? 1180 : 940, t);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.018, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 0.05);
      }
    }
  }

  /** The label maker: three ratchet clicks, the last one lower — ka-chunk. */
  private ratchet(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.01;
    [1400, 1320, 760].forEach((f, i) => this.click(ctx, out, t0 + i * 0.07, f, 0.03, 0.04));
  }

  /** Small wheels on a wooden floor: a short run of soft, uneven ticks. */
  private rattle(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.01;
    for (let i = 0; i < 9; i++) this.click(ctx, out, t0 + i * (0.09 + Math.random() * 0.03), 300 + Math.random() * 120, 0.012, 0.03);
  }

  /** The front door's chime: ding-dong, a falling major third with a soft tail. */
  private doorbell(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.02;
    [[659.25, 0], [523.25, 0.32]].forEach(([f, dt]) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f!, t0 + dt!);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + dt!);
      g.gain.exponentialRampToValueAtTime(0.04, t0 + dt! + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt! + 0.9);
      o.connect(g).connect(out);
      o.start(t0 + dt!);
      o.stop(t0 + dt! + 0.95);
    });
  }

  /** The confetti pop: one bright click with a sparkle of three high ticks after it. */
  private pop(ctx: AudioContext, out: AudioNode): void {
    const t0 = ctx.currentTime + 0.01;
    this.click(ctx, out, t0, 900, 0.05, 0.05);
    for (let i = 0; i < 3; i++) this.click(ctx, out, t0 + 0.08 + i * 0.05, 2600 + i * 400, 0.01, 0.02);
  }
```

Check `click`'s parameter order with `grep -n "private click" packages/web/src/live/soundEngine.ts` (`click(ctx, out, when, freq, gain, dur)` is assumed above) and adjust the calls to match.

Run: `pnpm --filter @musterd/web exec vitest run src/live/sound.test.ts && pnpm --filter @musterd/web typecheck`
Expected: PASS.

- [ ] **Step 2: Write the failing scene-loop test**

Read `scene-loop.test.ts` first for how it mounts a scene with fake data and a fake clock (it already asserts rAF-at-rest). Add, using its helpers:

```ts
describe('the Welcome Wagon in the loop (lane 01M3F81DD9)', () => {
  it('the first update never enqueues a welcome; a later new name does, and the room parks after', async () => {
    const scene = mountScene(dataWith(['nick']));        // the file's mount helper
    expect(scene.handle.stats().welcomes ?? 0).toBe(0);
    scene.handle.update(dataWith(['nick', 'ada']));
    advance(12_000);                                      // the file's fake-clock helper
    expect(scene.handle.stats().welcomes).toBe(1);
    expect(scene.rafPending()).toBe(false);               // parked again at rest
  });
});
```

Add `welcomes: number` to `OfficeStats` in `types.ts` (count of sequences started) so the test has a public probe; the perf harness reads `stats()` already, so this costs one integer.

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/scene-loop.test.ts -t "Welcome Wagon"`
Expected: FAIL — `welcomes` undefined.

- [ ] **Step 3: Wire the diff into `update()`**

In `index.ts`, import the Task 2–5 names. Next to `const recep = createReceptionist();`:

```ts
  /** The Welcome Wagon (lane 01M3F81DD9): who is new, and the beats that welcome them. */
  const wagon = createWelcomeWagon();
  let prevSubjects: Map<string, ArrivalSubject> | null = null;
  let welcomesStarted = 0;
  const welcomePaint: WelcomePaint = {
    lanyards: new Map(), hello: new Map(), bootBlink: new Map(), labels: [], polaroids: [], counter: null, wagonAt: null,
  };
```

At the top of `update(next)`, before `actors.setHomes(...)`:

```ts
    // Who is new (spec §4.2). Diffed against what THIS scene last saw — a failed refetch followed by a
    // good one cannot replay a welcome — and never on the first update (prevSubjects starts null).
    const arrivals = STILL ? [] : diffArrivals(prevSubjects, next.nodes);
    prevSubjects = new Map(next.nodes.map((n) => [n.name, n]));
    for (const a of arrivals)
      if (a.online) actors.expectFirstArrival(a.name, a.memberKind === 'human' ? 'movingBox' : null);
    enqueueArrivals(wagon, arrivals, Date.now());
```

After `placements = assignSeats(...)`, derive the corner:

```ts
    const deskHolders = new Set([...placements].filter(([, p]) => p.kind === 'desk').map(([n]) => n));
    welcomePaint.polaroids = newArrivalsCorner(next.nodes, deskHolders, Date.now()).map((p) => ({
      name: p.name,
      color: memberColor(p.name, 'human', p.hue),
    }));
```

(`memberColor` comes from `../format`; the corner's colour uses the Member's hue, and `kind` only matters when `hue` is null.)

At the end of `update`, change the loop start to include pending welcomes:

```ts
    if (actors.active() || cues.length || wagon.pending.length || welcomePlaying(wagon)) ensureLoop();
```

- [ ] **Step 4: Step the sequencer and dispatch its beats**

In `tick`, after `const recepActive = stepReceptionist(...)`:

```ts
    const beats = stepWelcomeWagon(wagon, Date.now(), {
      busy: actors.active() && !actors.ambientOnly() && !welcomePlaying(wagon),
      reduced,
      present: (n) => actors.nodes().has(n),
      hasDesk: (n) => placements.get(n)?.kind === 'desk',
      seated: (n) => actors.isSeated(n),
      atMark: (n) => actors.checkInMark(n) !== null && !actors.poses().get(n)?.moving,
    });
    for (const b of beats) playWelcomeBeat(b);
    for (const [n] of welcomePaint.lanyards) if (actors.isSeated(n)) welcomePaint.lanyards.delete(n);
    const welcomeActive = welcomePlaying(wagon) || wagon.pending.length > 0;
```

and add `welcomeActive` to the three `walking || alive || petActive || recepActive` conditions (draw dynamic, `wasActive`, and the rAF keep-alive).

Because a parked loop never ticks, also add a coarse timer beside `welcomeTimer` so a wave that becomes ready while the room rests still starts:

```ts
  const wagonTimer = setInterval(() => {
    if (STILL || suspended || (!broadcast && !VISIBLE())) return;
    if (wagon.pending.length > 0 && !raf) ensureLoop();
  }, 500);
```

Clear it in `dispose()` beside `clearInterval(welcomeTimer)`.

The dispatcher, next to `pushDoorCue`:

```ts
  /** One Welcome Wagon beat → the resident that plays it (spec §3). */
  function playWelcomeBeat(b: WelcomeBeat) {
    const pan = (lx: number, ly: number) => screenPan(project(lx, ly, fit).x, width);
    const hueColor = (name: string, hue: number | null) =>
      memberColor(name, actors.nodes().get(name)?.kind ?? 'human', hue);
    switch (b.type) {
      case 'ring':
        receptionistCue(recep, 'ring');
        roomTone.moment('ring', pan(RECEPTIONIST.lx, RECEPTIONIST.ly));
        break;
      case 'say':
        showSpeech(RECEPTIONIST_SPEAKER, b.text, 'info');
        break;
      case 'label':
        receptionistCue(recep, 'label');
        welcomePaint.labels.push({ color: hueColor(b.name, b.hue), t0: clock });
        roomTone.moment('ratchet', pan(RECEPTIONIST.lx, RECEPTIONIST.ly));
        break;
      case 'wagon': {
        const slot = placements.get(b.name);
        const desk = slot?.kind === 'desk' ? DESK_SLOTS[slot.slot] : undefined;
        if (desk && petWagon(pet, WAGON_PICKUP, { lx: desk.lx + 30, ly: desk.ly + 30 })) {
          roomTone.moment('rattle', pan(WAGON_PICKUP.lx, WAGON_PICKUP.ly));
        }
        break;
      }
      case 'polaroid':
        petCarryToWall(pet, WAGON_PICKUP, WALL_DROP);
        break;
      case 'doorbell':
        roomTone.moment('doorbell', pan(ENTRANCE.lx, ENTRANCE.ly));
        pushDoorCue(b.hue === null ? undefined : `hsl(${b.hue} 70% 72%)`);
        break;
      case 'toss':
        receptionistCue(recep, 'toss');
        welcomePaint.lanyards.set(b.name, hueColor(b.name, b.hue));
        roomTone.moment('whoosh', pan(RECEPTIONIST.lx, RECEPTIONIST.ly));
        if (actors.nodes().get(b.name)?.kind === 'agent') welcomePaint.bootBlink.set(b.name, clock);
        break;
      case 'wave':
        for (const n of nearestNeighbors(b.name, 3)) actors.welcomeWave(n);
        { const [first] = nearestNeighbors(b.name, 1); if (first) showSpeech(first, '👋', 'info'); }
        petFollow(pet, homes(b.name));
        break;
      case 'confetti':
        pushConfetti(b.name, b.hue === null ? undefined : hueColor(b.name, b.hue));
        roomTone.moment('pop', pan(...lxly(b.name)));
        break;
      case 'hello':
        welcomePaint.hello.set(b.name, clock);
        break;
      case 'zoomies':
        petZoomies(pet);
        break;
      case 'counter':
        welcomePaint.counter = { value: b.value, flippedAt: clock, until: Date.now() + 60_000 };
        break;
      case 'caption':
        pushRail({ text: b.text, who: b.who, tone: 'presence' });
        break;
    }
    if (b.type === 'ring' || b.type === 'doorbell') welcomesStarted++;
  }
```

Supporting edits in the same file:
- `pushDoorCue(color = '#cfe7ee')` — take the colour as a parameter instead of the literal.
- `pushConfetti(name, color = '#5cd49a')` — same.
- `WAGON_PICKUP` / `WALL_DROP` constants in `layout.ts`: `export const WAGON_PICKUP = { lx: FRONT_DESK.lx + 60, ly: FRONT_DESK.ly + 20 };` (east end of the counter, on the arrivals side) and `export const WALL_DROP = { lx: 470, ly: 70 };` — then verify both are walkable by adding them to the `nav.test.ts` walkable-points list (the file already holds the check-in marks there).
- `homes(name)` / `lxly(name)`: read the member's current pose from `actors.poses().get(name)` and fall back to `ENTRANCE`.
- `stats()` returns `welcomes: welcomesStarted`.
- The existing `captionForPresence` line in `update()` ("{n} just walked in") must stay quiet for a Member the wagon is welcoming, or the rail says it twice. Skip it when `arrivals.some((a) => a.online && a.name === line.who)`.
- In the `polaroid` case, also `roomTone.moment('rattle', …)` is NOT played — a dog with a polaroid in its mouth is silent.
- The counter clears itself: in `bake()`/the dynamic draw, `if (welcomePaint.counter && Date.now() > welcomePaint.counter.until) welcomePaint.counter = null;`.

- [ ] **Step 5: Run the loop test and the whole office suite**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene`
Expected: PASS, including the new `Welcome Wagon` loop test.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/office-scene/index.ts packages/web/src/live/office-scene/layout.ts \
  packages/web/src/live/office-scene/nav.test.ts packages/web/src/live/office-scene/scene-loop.test.ts \
  packages/web/src/live/office-scene/types.ts packages/web/src/live/soundLife.ts \
  packages/web/src/live/soundEngine.ts packages/web/src/live/sound.test.ts
git commit -m "feat(web): wire the Welcome Wagon into the office — diff, sequence, dispatch, sound

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
```

---

### Task 7: Painters — the look

**Files:**
- Modify: `packages/web/src/live/office-scene/render.ts`
- Modify: `packages/web/src/live/office-scene/index.ts` (pass `welcome: welcomePaint` in `RenderOpts`)
- Test: `packages/web/src/live/office-scene/render.test.ts`

**Interfaces:**
- Consumes: `WelcomePaint` (Task 6), `PetState.cargo` (Task 4), `ReceptionistMode` cues (Task 4), `CarryKind 'movingBox'` (Task 5).
- Produces: `RenderOpts.welcome?: WelcomePaint`; exported pure helper `plateText(name: string): string` (≤ 10 characters, `…` when clipped).

This task is judged by eye on the harness (Task 8), so its tests pin the pure parts (text clipping, counter digit layout) and a smoke test that every painter runs on a mocked context without throwing.

- [ ] **Step 1: Write the failing tests**

```ts
// in render.test.ts
import { counterDigits, plateText } from './render';

describe('welcome painters (lane 01M3F81DD9)', () => {
  it('plate text clips long names with an ellipsis', () => {
    expect(plateText('ada')).toBe('ada');
    expect(plateText('a-very-long-seat-name')).toBe('a-very-lo…');
  });
  it('the flip counter shows at least two digits and caps at 99+', () => {
    expect(counterDigits(4)).toBe('04');
    expect(counterDigits(37)).toBe('37');
    expect(counterDigits(140)).toBe('99+');
  });
  it('renderScene draws a full welcome state without throwing', () => {
    const ctx = mockCtx(); // the file's existing canvas mock
    expect(() =>
      renderScene(ctx, fitFor(800, 500), baseOpts({
        welcome: {
          lanyards: new Map([['ada', 'hsl(40 70% 60%)']]),
          hello: new Map([['ada', 0]]),
          bootBlink: new Map([['bot', 0]]),
          labels: [{ color: 'hsl(40 70% 60%)', t0: 0 }],
          polaroids: [{ name: 'ada', color: 'hsl(40 70% 60%)' }],
          counter: { value: 12, flippedAt: 0, until: Infinity },
          wagonAt: null,
        },
      })),
    ).not.toThrow();
  });
});
```

Use the helper names `render.test.ts` already has for the context mock and base options (`grep -n "function mock\|function base\|function fitFor" packages/web/src/live/office-scene/render.test.ts`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/render.test.ts -t "welcome painters"`
Expected: FAIL — `plateText` not exported.

- [ ] **Step 3: Implement the pure helpers and the painters**

```ts
/** Name text on a nameplate strip or polaroid: 10 characters, then an ellipsis (lane 01M3F81DD9). */
export function plateText(name: string): string {
  return name.length <= 10 ? name : `${name.slice(0, 9)}…`;
}

/** The wallboard flip counter's digits: two at least, `99+` past what two flaps can show. */
export function counterDigits(n: number): string {
  return n > 99 ? '99+' : String(n).padStart(2, '0');
}
```

Painters, each built only from the existing primitives (`box`, `project`, `dim`) so they bake and sprite-cache like the rest of the room:

```ts
/** The welcome wagon: a small red cart with four dark wheels and its load (nameplate, box, plant). */
function wagonPaint(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, loaded: boolean): void {
  for (const [dx, dy] of [[-9, -6], [9, -6], [-9, 6], [9, 6]] as const) box(ctx, fit, lx + dx, ly + dy, 4, 4, 4, '#2b2622');
  box(ctx, fit, lx, ly, 24, 16, 6, '#c8412f', 3); // the bed
  box(ctx, fit, lx, ly, 24, 16, 1.5, dim('#c8412f', 0.75), 9); // the rim
  box(ctx, fit, lx - 16, ly, 10, 1.6, 1.6, '#3a332d', 7); // the handle, toward the dog
  if (!loaded) return;
  box(ctx, fit, lx + 4, ly, 12, 10, 9, '#c9a26b', 9); // the monitor box
  box(ctx, fit, lx - 6, ly + 2, 6, 6, 5, '#8a5a3b', 9); // the pot…
  box(ctx, fit, lx - 6, ly + 2, 7, 7, 7, '#4f8a4b', 14); // …and its plant
}

/** The moving box a first-day human carries, with the plant poking out of it. */
function movingBoxPaint(ctx: CanvasRenderingContext2D, fit: Fit, lx: number, ly: number, up: number): void {
  box(ctx, fit, lx, ly, 14, 10, 10, '#c9a26b', up);
  box(ctx, fit, lx, ly, 14, 10, 1, dim('#c9a26b', 0.8), up + 10);
  box(ctx, fit, lx + 3, ly - 1, 5, 5, 7, '#4f8a4b', up + 9);
}

/** A lanyard: a thin loop in the Member's colour from the neck, and a white card at the chest. */
function lanyardPaint(ctx: CanvasRenderingContext2D, neck: Pt, color: string, s: number): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, 1.4 * s);
  ctx.beginPath();
  ctx.moveTo(neck.x - 3 * s, neck.y);
  ctx.quadraticCurveTo(neck.x, neck.y + 9 * s, neck.x + 3 * s, neck.y);
  ctx.stroke();
  ctx.fillStyle = '#f7f3ea';
  ctx.fillRect(neck.x - 2.2 * s, neck.y + 7 * s, 4.4 * s, 5.2 * s);
  ctx.fillStyle = color;
  ctx.fillRect(neck.x - 2.2 * s, neck.y + 7 * s, 4.4 * s, 1.4 * s);
  ctx.restore();
}
```

Also add, following the same primitives-only rule:
- **label strip:** at `FRONT_DESK`, a 14×3 strip in the Member's colour rising `min(1, (clock - t0) / 0.6) * 6` units off the counter and fading over 2 s; drop entries older than 2 s.
- **polaroids:** at the wallboard's right edge (`boardAnchor` gives the board's screen anchor), up to three 16×18 white cards with a colour square and `plateText(name)` in 7px `Inter` below it, each tilted by a name-hashed ±4°.
- **flip counter:** below the board, two or three dark flaps with `counterDigits(value)` in white `JetBrains Mono`; for 0.25 s after `flippedAt` the top half of each flap squashes vertically (`scaleY = 1 - (t / 0.25)`), which reads as a flip at office scale.
- **hello screen:** for 1.0 s after `hello.get(name)`, the member's monitor face fills with the page background colour and `hello, {plateText(name)}` in 6px text; then the normal glow.
- **boot blink:** for 1.2 s after `bootBlink.get(name)`, a 3px dot above the head in the Member's colour, on for 0.15 s / off for 0.15 s, twice.
- **hued confetti:** where the `confetti` cue kind is drawn, use `cue.color` for half the 24 pieces and mustard `#E1AD01` for the rest, so the burst is theirs and the brand's.
- **receptionist poses:** replace Task 4's temporary mapping: `ringing` = the `call` pose with a 2 Hz ±1px shake on the receiver; `label` = hands at the counter (`typing`) with the label strip emerging; `toss` = the right arm through an arc from the counter to shoulder height over the cue's 0.7 s.
- **dog cargo:** in `drawDogFacing`'s call site, when `pet.cargo === 'wagon'`, draw `wagonPaint` 22 units behind the dog along its heading (use `-face` for the screen-side offset, so the wagon trails whichever way the dog faces), loaded; when `'polaroid'`, draw a 5×6 white card at the muzzle.
- **moving box:** where the actor painter handles `carry`, add `'movingBox'` → `movingBoxPaint` at the hands' height (the same anchor the handoff `'box'` uses).
- **lanyard:** after an actor's body is painted, if `opts.welcome?.lanyards.has(name)`, `lanyardPaint` at the neck joint.

In `index.ts`, pass `welcome: welcomePaint` wherever `RenderOpts` is built for the dynamic draw and the bake.

Keep all per-frame work allocation-free: no `new Map`/array literals inside the painters; iterate the maps in place.

- [ ] **Step 4: Run tests, typecheck, and the perf/byte gates**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene && pnpm --filter @musterd/web typecheck && pnpm --filter @musterd/web build && pnpm perf:check`
Expected: PASS. If `perf:check` fails on the **total** JS budget, read its message before touching anything (packages/web/AGENTS.md: the two budgets have different remedies).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/office-scene/render.ts packages/web/src/live/office-scene/render.test.ts \
  packages/web/src/live/office-scene/index.ts
git commit -m "feat(web): paint the welcome — wagon, moving box, lanyard, polaroids, flip counter, hello

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
```

---

### Task 8: The dev harness — watch it before it ships

**Files:**
- Modify: `packages/web/src/routes/office-preview.tsx`

**Interfaces:**
- Consumes: the scene's public `update(data)` only — the harness drives the real path (roster diff → sequencer → dispatch), not a shortcut.

- [ ] **Step 1: Add three buttons beside the existing 🙆👀 gesture buttons**

Read how `office-preview.tsx` holds its `OfficeData` (find its `useState`/`data` and the node builder it uses for fake members). Then add:

```tsx
  /** Welcome Wagon harness (lane 01M3F81DD9): add Members the way the server would, then connect them. */
  function welcome(kind: 'human' | 'agent' | 'crowd') {
    const stamp = Date.now().toString(36).slice(-3);
    const names = kind === 'crowd' ? Array.from({ length: 14 }, (_, i) => `guest-${stamp}${i}`) : [`${kind}-${stamp}`];
    const fresh = names.map((name) =>
      previewNode(name, {
        kind: kind === 'agent' ? 'agent' : 'human',
        presence: 'offline',
        posture: 'offline',
        offline_reason: 'unknown',
        created_at: Date.now(),
        hue: Math.floor(Math.random() * 360),
      }),
    );
    // A crowd arrives created-and-online in one roster; a solo Member is created first, then connects.
    if (kind === 'crowd') {
      setData((d) => ({ ...d, nodes: [...d.nodes, ...fresh.map(online)] }));
      return;
    }
    setData((d) => ({ ...d, nodes: [...d.nodes, ...fresh] }));
    setTimeout(() => setData((d) => ({ ...d, nodes: d.nodes.map((n) => (names.includes(n.name) ? online(n) : n)) })), 7_000);
  }
  const online = (n: OfficeNode): OfficeNode => ({ ...n, presence: 'online', posture: 'working', activity: 'working', offline_reason: null });
```

```tsx
        <button type="button" onClick={() => welcome('human')}>welcome: human</button>
        <button type="button" onClick={() => welcome('agent')}>welcome: agent</button>
        <button type="button" onClick={() => welcome('crowd')}>welcome: crowd</button>
```

`previewNode` stands for whatever builder the file already uses for its fake roster; use that function by its real name.

- [ ] **Step 2: Run it and judge it**

Run: `pnpm --filter @musterd/web dev` then open `http://localhost:5174/office-preview`.
Check, each by eye, with sound on:
1. **welcome: human** — Act 1 plays within ~2 s (ring, label, wagon to the desk, nameplate glow, caption); 7 s later Act 2 (doorbell, door glow in their colour, box-and-plant walk-in, lanyard toss at the mark, three waves + 👋, dog alongside, confetti on sitting, hello screen, caption). Nothing reads as a bug: no skating, no wagon through furniture, no bubble collisions.
2. **welcome: agent** — same, no box, the status light blinks twice.
3. **welcome: crowd** — one doorbell, zoomies, conveyor tosses 0.6 s apart, the counter flipping up, one confetti, one caption, guests past 12 desks in the gallery.
4. Toggle the OS reduced-motion setting and repeat 1: only end states and the caption.

Record a short screen capture of 1 and 3 for the PR.

- [ ] **Step 3: Fix what the eye finds**

Timing and look adjustments go in `welcomeWagon.ts` (times), the painters (`render.ts`) or the residents; each change re-runs `pnpm --filter @musterd/web exec vitest run src/live/office-scene` before continuing. A timing change updates the spec §3 table in the same commit (hard rule 3).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/routes/office-preview.tsx packages/web/src/live/office-scene docs/superpowers/specs/2026-09-26-live-member-joined-moment-design.md
git commit -m "feat(web): office-preview welcome harness (human / agent / crowd)

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
```

---

### Task 9: Perf and the end-to-end check

**Files:**
- Modify: `docs/perf/web-live-baseline.md` (append numbers)

- [ ] **Step 1: Run the live baseline with a crowd**

Follow the method at the top of `docs/perf/web-live-baseline.md` (temp daemon + `scripts/perf/live-baseline.mjs`). Run it once at rest and once while `/office-preview`'s **welcome: crowd** plays. Append both rows to the baseline doc with today's date and the build SHA.
Expected: at rest rAF 0/s (unchanged); during the crowd, frame times inside the ADR 151 budget stated in that doc.

- [ ] **Step 2: End to end on a throwaway daemon**

```bash
export MUSTERD_DB=$(mktemp -d)/e2e.db MUSTERD_PORT=4899 MUSTERD_CONFIG=$(mktemp -d)/config.json
node packages/server/dist/bin.js &                 # the daemon entry; confirm the path with `ls packages/server/dist`
node packages/cli/dist/bin.js team create e2e --as nick
# open http://localhost:4899/live?team=e2e in the browser, then:
node packages/cli/dist/bin.js member add ada --kind agent
node packages/cli/dist/bin.js claim ada            # from a second shell, as ada
```

Expected: Act 1 within 2 s of `member add` with no reload (falsifier 1); Act 2 on ada's first claim, the ordinary walk-in on her second (falsifier 2); reloading `/live` plays nothing (falsifier 3). Check the exact CLI verbs with `node packages/cli/dist/bin.js help` before running.

- [ ] **Step 3: Commit**

```bash
git add docs/perf/web-live-baseline.md
git commit -m "docs(perf): Welcome Wagon crowd baseline

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
```

---

### Task 10: Docs, copy review, land

**Files:**
- Modify: `docs/architecture/08-web.md` (module map under `office-scene/`)
- Modify: `docs/superpowers/specs/2026-09-26-live-member-joined-moment-design.md` (§3.4 amendment)

- [ ] **Step 1: Module map**

Under `office-scene/` in `08-web.md`'s module map, add:

```
    arrivals.ts                 // who is new: pure roster diff (created / firstOnline) + the wallboard's new-arrivals corner (lane 01M3F81DD9)
    welcomeWagon.ts             // the Welcome Wagon beat sequencer: 2 s waves, Act 1 / Act 2 / crowd scripts, gates, backlog cap — pure
```

- [ ] **Step 2: Spec amendment**

In the spec §3.4, replace the **Queue** bullet with:

```
- **No queue.** Guests check in at the three marks in parallel; anyone past the last mark walks straight
  in (the reception design's rule, `layout.ts` `CHECK_IN_MARKS`: ceremony that queues is the gate it
  rejected). The receptionist's conveyor toss reaches them as they pass the counter.
```

- [ ] **Step 3: Copy review**

`team_send {act:'request_help', to:'sloane', body:'Brand-voice read of the Welcome Wagon copy (lane 01M3F81DD9): <paste the Global Constraints copy list>. Public surface (/live, /broadcast).'}` — fold any change into `welcomeWagon.ts` and its tests before opening the PR.

- [ ] **Step 4: Fast gates**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: PASS (`format:check` includes `arch-trees:check` and `vocab:check`).

- [ ] **Step 5: Commit, push, PR, auto-merge**

```bash
git add docs/architecture/08-web.md docs/superpowers/specs/2026-09-26-live-member-joined-moment-design.md
git commit -m "docs: Welcome Wagon module map + spec amendment (no crowd queue)

Refs lane 01M3F81DD9

Co-authored-by: miley <miley@revive.musterd>"
git fetch origin main && git rebase origin/main
git push -u origin feat/live-member-joined-moment
gh pr create --title "/live: the joined-the-team moment (Welcome Wagon)" --body-file <(printf '%s\n' \
  'Lane 01M3F81DD9. Spec: docs/superpowers/specs/2026-09-26-live-member-joined-moment-design.md' \
  '' 'Captures: <attach the human + crowd recordings from Task 8>' '' \
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)')
gh pr merge --squash --auto --delete-branch
```

- [ ] **Step 6: After merge — submit for acceptance**

`lane_submit {lane: '01M3F81DD9', pr: <n>, sha: <merge sha>, authorized_by: 'nick'}` and follow its reply (ADR 235). Then clear the local branch:
`git fetch origin main --prune && git switch --detach origin/main && git branch -D feat/live-member-joined-moment`.
