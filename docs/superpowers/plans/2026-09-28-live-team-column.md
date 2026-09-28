# /live team column (ADR 464, lane 1) Implementation Plan

> **For agentic workers:** execute this plan in your own seat with superpowers:executing-plans
> (AGENTS.md hard rule 8: no writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/live`'s roster column and the bottom-left "on the floor" box with a team column.
The column shows each present member's provider logo and model, a plain-language state, and their
lane title in large type. It expands to today's operator detail and is linked to the member's
character in the office.

**Architecture:**
- Two pure view-model modules, node-testable like `workingOn.ts`:
  - `teamCards.ts`: order + state + work.
  - `modelBadge.ts`: logo + label + observed/declared/unknown.
- Two thin components, render-tested with `react-dom/server` like `RosterPanel.render.test.ts`:
  - `TeamColumn.tsx`
  - `TeamCard.tsx`
- `RosterPanel`'s per-seat operator block is extracted as `SeatDetail` and reused inside an
  expanded card.
- The office scene gains one handle method, `setLinked(name | null)`, and one mount option,
  `onPlateHover`, for the card↔character link.
- The stream column stays in this lane. Lane 2 moves it into a drawer.

**Tech Stack:** React 19, TanStack Router, vitest (node env, no jsdom), plain CSS in `Live.css`.

**Spec:** `docs/superpowers/specs/2026-09-28-live-audience-first-design.md` (§2, §4). **ADR:** 464.

## Global Constraints

- No protocol, server or schema change. No new runtime dependency (ADR 464 Decision 6).
- The model badge never guesses: `model_source !== 'observed'` → "declared"; no model → "model
  unknown"; humans → "human" (spec §4, falsifier 2).
- Lane titles do not go on nameplates. The plate gains only the short model name (spec §4).
- Budgets hold, with no raise planned: `pnpm --filter @musterd/web perf:check` (ADR 151/183), the
  `Live.css` budget (ADR 441), `a11y:check` contrast, `a11y:targets:check` at 390×844.
- Contrast is measured in the browser (`pnpm a11y:contrast <url>`), never computed from the hex
  (packages/web/AGENTS.md).
- Every `var()` token used must be defined; fallbacks must not contradict (`tokens:check`).
- Retiring a surface on `/live` does not delete a component another route uses. `/broadcast` still
  uses `WorkStack` (`workCues="stack"`), so `WorkStack.tsx` stays.
- The "asking nick" state is added in lane 3, which owns `deriveAsks` on the banner. This lane
  ships the other five states.

## Review Focus

1. **A member with two in-flight lanes.** The card shows the freshest and "+1 more", never two
   titles. Pinned in Task 1.
2. **A human with a model on their presence** (a human driving a Claude Code session). The badge
   still says "human", because a person is not their tool. Pinned in Task 2.
3. **A model id `shortModel` can't parse** (e.g. `foo-bar-baz-1`). The badge shows the provider's
   logo (or "?") and the raw id in the tooltip, never an empty chip. Pinned in Task 2.
4. **Collapsed rail with 25 seats at 1080px tall.** The rail scrolls; avatars never shrink below the
   24px tap floor. Pinned in Task 6 (CSS) and checked by `a11y:targets:check`.
5. **Board not fetched yet (`board === null`).** Cards still render with status lines and "between
   tasks", never blank. Pinned in Task 1.

---

## File structure

| File | Responsibility |
| --- | --- |
| Create `packages/web/src/live/modelBadge.ts` | presence → `{ provider, label, full, source }` |
| Create `packages/web/src/live/modelBadge.test.ts` | its unit tests |
| Create `packages/web/src/live/teamCards.ts` | roster + board + goals → ordered `TeamCard[]` + offline count |
| Create `packages/web/src/live/teamCards.test.ts` | its unit tests |
| Create `packages/web/src/live/TeamCard.tsx` | one card: avatar, name, badge, state, work, expand |
| Create `packages/web/src/live/TeamColumn.tsx` | the column + collapsed rail + narration caption |
| Create `packages/web/src/live/TeamColumn.render.test.ts` | markup assertions |
| Modify `packages/web/src/live/RosterPanel.tsx` | export `SeatDetail` (the extracted operator block) |
| Modify `packages/web/src/live/OfficeScene.tsx` | `onCaption`, `linked`, `onPlateHover` props |
| Modify `packages/web/src/live/office-scene/types.ts` | `setLinked` on `OfficeHandle`; `onPlateHover` on options |
| Modify `packages/web/src/live/office-scene/index.ts` | plate short model; `setLinked`; plate hover callback |
| Modify `packages/web/src/live/office-scene/scene-loop.test.ts` | source-structure assertions for the joints |
| Modify `packages/web/src/routes/live.tsx` | mount `TeamColumn` in the roster track; `workCues` → `'none'` |
| Modify `packages/web/src/live/Live.css` | `.lc-team*` styles, track width, responsive collapse |
| Modify `docs/architecture/08-web.md` | describe + file-tree lines (arch-trees:check) |

---

### Task 1: `teamCards` view-model

**Files:**
- Create: `packages/web/src/live/teamCards.ts`
- Test: `packages/web/src/live/teamCards.test.ts`

**Interfaces:**
- Consumes: `memberColor`, `memberPosture` (`./format`); `MemberSummary`, `LaneBoard`, `Lane`,
  `Goal` (`@musterd/protocol`).
- Produces:
  ```ts
  export type CardState = 'working' | 'review' | 'blocked' | 'between' | 'away';
  export interface TeamCard {
    name: string; kind: 'agent' | 'human'; color: string; member: MemberSummary;
    state: CardState; stateLabel: string;          // "working on" | "waiting for review" | …
    title: string | null; source: 'lane' | 'status' | null;
    goal: string | null; since: number | null;     // goal title; claimed_at of the shown lane
    moreLanes: number;
  }
  export function teamCards(roster: MemberSummary[], board: LaneBoard | null,
    goals: readonly { id: string; title: string }[]): { cards: TeamCard[]; offline: number };
  export function elapsed(since: number | null, now: number): string | null; // "42m" | "3h" | "2d"
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import type { Lane, LaneBoard, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { elapsed, teamCards } from './teamCards';

const m = (name: string, over: Partial<MemberSummary> = {}): MemberSummary =>
  ({ id: `m_${name}`, name, kind: 'agent', presence: 'online', posture: 'working',
     presences: [], capabilities: {}, ...over }) as unknown as MemberSummary;
const lane = (owner: string, over: Partial<Lane> = {}): Lane =>
  ({ id: `l_${owner}_${over.title ?? 'x'}`, title: 'Fix the thing', owner_seat: owner,
     state: 'claimed', claimed_at: 1_000, updated_at: 1_000, goal_id: null, ...over }) as Lane;
const board = (...lanes: Lane[]) => ({ lanes }) as unknown as LaneBoard;

describe('teamCards', () => {
  it('orders working → review → blocked → between → away, humans last within a group', () => {
    const roster = [
      m('zed', { posture: 'away', presence: 'away' }),
      m('nick', { kind: 'human', posture: 'working' }),
      m('amy', { posture: 'active' }),
      m('bob'), m('cat'), m('dan'),
    ];
    const b = board(
      lane('bob'), lane('nick'),
      lane('cat', { state: 'awaiting_acceptance' }),
      lane('dan', { state: 'blocked' }),
    );
    const { cards } = teamCards(roster, b, []);
    expect(cards.map((c) => c.name)).toEqual(['bob', 'nick', 'cat', 'dan', 'amy', 'zed']);
    expect(cards.map((c) => c.state)).toEqual(['working', 'working', 'review', 'blocked', 'between', 'away']);
  });

  it('says what each state means in plain words', () => {
    const { cards } = teamCards(
      [m('a'), m('b'), m('c'), m('d', { posture: 'active' }), m('e', { posture: 'away', presence: 'away' })],
      board(lane('a'), lane('b', { state: 'awaiting_acceptance' }), lane('c', { state: 'blocked' })),
      [],
    );
    expect(cards.map((c) => c.stateLabel)).toEqual([
      'working on', 'waiting for review', 'blocked on', 'between tasks', 'away',
    ]);
  });

  it('shows the freshest in-flight lane and counts the rest (Review Focus 1)', () => {
    const { cards } = teamCards([m('a')], board(
      lane('a', { title: 'old', claimed_at: 1 }), lane('a', { title: 'new', claimed_at: 9 }),
    ), []);
    expect(cards[0]).toMatchObject({ title: 'new', source: 'lane', moreLanes: 1 });
  });

  it('names the goal and keeps claimed_at for elapsed', () => {
    const { cards } = teamCards([m('a')], board(lane('a', { goal_id: 'launch', claimed_at: 5 })),
      [{ id: 'launch', title: 'Launch' }]);
    expect(cards[0]).toMatchObject({ goal: 'Launch', since: 5 });
  });

  it('with no board yet, still renders every present member (Review Focus 5)', () => {
    const { cards } = teamCards([m('a', { state: 'reading the spec', posture: 'active' })], null, []);
    expect(cards[0]).toMatchObject({ title: 'reading the spec', source: 'status', state: 'between' });
  });

  it('folds offline seats into a count', () => {
    const out = teamCards([m('a'), m('b', { presence: 'offline', posture: 'offline' })], null, []);
    expect(out.cards.map((c) => c.name)).toEqual(['a']);
    expect(out.offline).toBe(1);
  });
});

describe('elapsed', () => {
  const MIN = 60_000;
  it.each([
    [null, null], [0, '<1m'], [42 * MIN, '42m'], [3 * 60 * MIN, '3h'], [2 * 24 * 60 * MIN, '2d'],
  ])('%s → %s', (dt, out) => {
    expect(elapsed(dt === null ? null : 1_000, 1_000 + (dt ?? 0))).toBe(out);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/web exec vitest run src/live/teamCards.test.ts`
Expected: FAIL, `Cannot find module './teamCards'`.

- [ ] **Step 3: Implement**

```ts
import type { Lane, LaneBoard, LaneState, MemberSummary } from '@musterd/protocol';
import { memberColor, memberPosture } from './format';

/**
 * The team column's pure view-model (ADR 464, spec §4). One card per PRESENT member, ordered by
 * what a room watching the screen most needs to see first: who is working, then who is waiting on
 * a reviewer, then who is stuck, then who is between tasks, then who stepped away. Humans sit last
 * within their group — the agents are the show; the humans are the audience's way in.
 *
 * Sibling of `workingOn.ts` (the /broadcast reel), not a replacement: that one answers "what is
 * the room doing" as a list of titles; this one answers "who is this person" as a card.
 */
export type CardState = 'working' | 'review' | 'blocked' | 'between' | 'away';

export interface TeamCard {
  name: string;
  kind: 'agent' | 'human';
  color: string;
  member: MemberSummary;
  state: CardState;
  stateLabel: string;
  title: string | null;
  source: 'lane' | 'status' | null;
  goal: string | null;
  since: number | null;
  moreLanes: number;
}

const IN_FLIGHT: readonly LaneState[] = ['claimed', 'active', 'blocked', 'awaiting_acceptance'];
const ORDER: Record<CardState, number> = { working: 0, review: 1, blocked: 2, between: 3, away: 4 };
const LABEL: Record<CardState, string> = {
  working: 'working on',
  review: 'waiting for review',
  blocked: 'blocked on',
  between: 'between tasks',
  away: 'away',
};

const recency = (l: Lane) => l.claimed_at ?? l.updated_at;

function stateOf(m: MemberSummary, lane: Lane | undefined): CardState {
  if (memberPosture(m) === 'away') return 'away';
  if (lane?.state === 'awaiting_acceptance') return 'review';
  if (lane?.state === 'blocked') return 'blocked';
  if (lane) return 'working';
  return 'between';
}

export function teamCards(
  roster: MemberSummary[],
  board: LaneBoard | null,
  goals: readonly { id: string; title: string }[],
): { cards: TeamCard[]; offline: number } {
  const owned = new Map<string, Lane[]>();
  for (const l of board?.lanes ?? []) {
    if (l.owner_seat === null || !IN_FLIGHT.includes(l.state)) continue;
    const list = owned.get(l.owner_seat);
    if (list) list.push(l);
    else owned.set(l.owner_seat, [l]);
  }
  for (const list of owned.values()) list.sort((a, b) => recency(b) - recency(a));
  const goalTitle = new Map(goals.map((g) => [g.id, g.title] as const));

  const present = roster.filter((m) => m.presence !== 'offline');
  const cards = present.map((m): TeamCard => {
    const kind = m.kind === 'human' ? 'human' : 'agent';
    const lanes = owned.get(m.name) ?? [];
    const lane = lanes[0];
    const status = m.state?.trim() ? m.state.trim() : null;
    const state = stateOf(m, lane);
    return {
      name: m.name,
      kind,
      color: memberColor(m.name, kind, m.hue),
      member: m,
      state,
      stateLabel: LABEL[state],
      title: lane ? lane.title : status,
      source: lane ? 'lane' : status ? 'status' : null,
      goal: lane?.goal_id ? (goalTitle.get(lane.goal_id) ?? null) : null,
      since: lane ? recency(lane) : null,
      moreLanes: Math.max(0, lanes.length - 1),
    };
  });

  cards.sort((a, b) => {
    const byState = ORDER[a.state] - ORDER[b.state];
    if (byState !== 0) return byState;
    const byKind = (a.kind === 'human' ? 1 : 0) - (b.kind === 'human' ? 1 : 0);
    if (byKind !== 0) return byKind;
    if (a.since !== null && b.since !== null && a.since !== b.since) return b.since - a.since;
    return a.name.localeCompare(b.name);
  });
  return { cards, offline: roster.length - present.length };
}

/** "42m" / "3h" / "2d" — how long the shown lane has been in hand. */
export function elapsed(since: number | null, now: number): string | null {
  if (since === null) return null;
  const min = Math.floor((now - since) / 60_000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/web exec vitest run src/live/teamCards.test.ts`
Expected: PASS (7 tests + 5 `elapsed` cases).

If the order test fails on `nick`: `bob` and `nick` are both `working`. `bob` is an agent, so it
sorts first. Fix the implementation, not the test.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/teamCards.ts packages/web/src/live/teamCards.test.ts
git commit -m "feat(live): teamCards view-model — who, what, in plain words (ADR 464)"
```

---

### Task 2: `modelBadge` resolution

**Files:**
- Create: `packages/web/src/live/modelBadge.ts`
- Test: `packages/web/src/live/modelBadge.test.ts`

**Interfaces:**
- Consumes: `modelProvider` (`./modelProvider`), `shortModel` (`./presenceLabel`).
- Produces:
  ```ts
  export type BadgeSource = 'observed' | 'declared' | 'unknown' | 'human' | 'service';
  export interface ModelBadge { provider: ModelProvider; label: string; full: string | null; source: BadgeSource; }
  export function livePresence(m: MemberSummary): MemberSummary['presences'][number] | undefined;
  export function modelBadge(m: MemberSummary): ModelBadge;
  export function displayModel(model: string | null | undefined): string; // "Opus 5.5", "GPT 6"
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import type { MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { displayModel, modelBadge } from './modelBadge';

const m = (over: Record<string, unknown> = {}, presence: Record<string, unknown> | null = {}) =>
  ({ id: 'm_a', name: 'a', kind: 'agent', presence: 'online', capabilities: {},
     presences: presence ? [{ status: 'online', surface: 'claude-code', ...presence }] : [],
     ...over }) as unknown as MemberSummary;

describe('displayModel', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['gpt-6-luna', 'GPT 6'],
    ['grok-5', 'Grok 5'],
    [null, ''],
  ])('%s → %s', (id, out) => expect(displayModel(id)).toBe(out));
});

describe('modelBadge', () => {
  it('observed model → provider + readable label', () => {
    const b = modelBadge(m({}, { model: 'claude-opus-5-5', model_source: 'observed' }));
    expect(b).toMatchObject({ label: 'Opus 5.5', full: 'claude-opus-5-5', source: 'observed' });
    expect(b.provider.id).toBe('claude');
  });

  it('a model the agent only declared is marked declared, never passed off as observed', () => {
    expect(modelBadge(m({}, { model: 'gpt-6-luna', model_source: 'binding' })).source).toBe('declared');
    expect(modelBadge(m({}, { model: 'gpt-6-luna', model_source: null })).source).toBe('declared');
  });

  it('no model → "model unknown", never a guess (falsifier 2)', () => {
    expect(modelBadge(m({}, { model: null }))).toMatchObject({ label: 'model unknown', source: 'unknown' });
    expect(modelBadge(m({}, null))).toMatchObject({ label: 'model unknown', source: 'unknown' });
  });

  it('a human is a human, whatever session they drive (Review Focus 2)', () => {
    const b = modelBadge(m({ kind: 'human' }, { model: 'claude-opus-5-5', model_source: 'observed' }));
    expect(b).toMatchObject({ label: 'human', source: 'human' });
  });

  it('an unparseable id keeps its provider and puts the raw id in `full` (Review Focus 3)', () => {
    const b = modelBadge(m({}, { model: 'foo-bar-baz-1', model_source: 'observed' }));
    expect(b.label).not.toBe('');
    expect(b.full).toBe('foo-bar-baz-1');
  });

  it('reads the live attachment, not a stale one', () => {
    const b = modelBadge({
      ...m(),
      presences: [
        { status: 'offline', model: 'grok-5', model_source: 'observed' },
        { status: 'online', model: 'claude-opus-5-5', model_source: 'observed' },
      ],
    } as unknown as MemberSummary);
    expect(b.label).toBe('Opus 5.5');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/web exec vitest run src/live/modelBadge.test.ts`
Expected: FAIL, `Cannot find module './modelBadge'`.

- [ ] **Step 3: Implement**

```ts
import type { MemberSummary } from '@musterd/protocol';
import { modelProvider, type ModelProvider } from './modelProvider';
import { shortModel } from './presenceLabel';

/**
 * The model badge the team column and the plates show (ADR 464, spec §4). The one rule it exists to
 * keep: never claim more than we know. `observed` is the server watching the model on the wire
 * (ADR 301); anything else the seat merely said about itself, and the badge says so.
 */
export type BadgeSource = 'observed' | 'declared' | 'unknown' | 'human' | 'service';

export interface ModelBadge {
  provider: ModelProvider;
  label: string;
  /** The raw model id, for the tooltip — null when there is none. */
  full: string | null;
  source: BadgeSource;
}

/** The attachment the room is looking at: the live one, else the most recent (`OfficeScene` pick). */
export function livePresence(m: MemberSummary) {
  return m.presences?.find((p) => p.status === 'online' || p.status === 'away') ?? m.presences?.[0];
}

const UPPER = new Set(['gpt', 'glm']);

/** `shortModel`'s lower-case "opus 5.5" / "gpt 6", cased for a projector: "Opus 5.5" / "GPT 6". */
export function displayModel(model: string | null | undefined): string {
  const short = shortModel(model);
  if (!short) return '';
  return short
    .split(' ')
    .map((w) => (UPPER.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function modelBadge(m: MemberSummary): ModelBadge {
  const p = livePresence(m);
  const model = p?.model?.trim() || null;
  const provider = modelProvider(model);
  if (m.kind === 'human') return { provider: modelProvider(null), label: 'human', full: null, source: 'human' };
  if (m.kind === 'service') return { provider: modelProvider(null), label: 'service', full: null, source: 'service' };
  if (!model) return { provider, label: 'model unknown', full: null, source: 'unknown' };
  return {
    provider,
    label: displayModel(model) || model,
    full: model,
    source: p?.model_source === 'observed' ? 'observed' : 'declared',
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/web exec vitest run src/live/modelBadge.test.ts`
Expected: PASS.

If `displayModel('foo-bar-baz-1')` returns an empty string, `shortModel`'s fallback returned
empty. The `|| model` fallback in `modelBadge` keeps the label non-empty, and the test asserts
only that. Do not change `shortModel`; the plates depend on it.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/modelBadge.ts packages/web/src/live/modelBadge.test.ts
git commit -m "feat(live): modelBadge — provider logo + readable model, never a guess (ADR 464)"
```

---

### Task 3: Extract `SeatDetail` from `RosterPanel`

**Files:**
- Modify: `packages/web/src/live/RosterPanel.tsx:139-321` (the `SeatRow` function)
- Test: `packages/web/src/live/RosterPanel.render.test.ts` (existing; must stay green unchanged)

**Interfaces:**
- Produces: `export function SeatDetail({ m, daemonBuild, daemonEpoch, trace, cfg }): JSX.Element`,
  the `lc-seat__gov` chip row plus the trace toggle, without the avatar/name line. `SeatRow` renders
  its name line followed by `<SeatDetail …/>`, so its markup is unchanged.

- [ ] **Step 1: Move the block**

In `RosterPanel.tsx`, move these into a new exported `SeatDetail` component taking the same props
as `SeatRow`:
- the computations `woken` … `dotState` that the chips use (`chip`, `accountEx`, `badges`,
  `wakeability`, `wakeable`, `resumable`, `nodeLabel`, `reconnecting`, `enrolled`, `online`);
- the JSX from `<div className="lc-seat__gov">` through `{cfg && <SeatTraceToggle … />}`.

`SeatRow` keeps the dot, avatar and `.lc-seat__line`, and renders `<SeatDetail {...props} />` where
the moved JSX was. `SeatRow` still needs `online`, `reconnecting`, `epochBehind` and `skewTitle`
for its own line, so recompute those in `SeatRow` (they are one-liners) rather than threading them
back.

- [ ] **Step 2: Run the existing render test to prove the markup did not move**

Run: `pnpm --filter @musterd/web exec vitest run src/live/RosterPanel.render.test.ts`
Expected: PASS with no test edits.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/live/RosterPanel.tsx
git commit -m "refactor(live): extract SeatDetail from the roster row, for the team card's expand"
```

---

### Task 4: `TeamCard` + `TeamColumn` components

**Files:**
- Create: `packages/web/src/live/TeamCard.tsx`, `packages/web/src/live/TeamColumn.tsx`
- Test: `packages/web/src/live/TeamColumn.render.test.ts`

**Interfaces:**
- Consumes: `teamCards`, `elapsed`, `TeamCard` (Task 1); `modelBadge` (Task 2); `SeatDetail`
  (Task 3); `providerIconHtml` (`./modelProviderIcon`); `memberAvatar`, `initial` (`./format`);
  `CollapseButton`, `PanelRail` (`./PanelChrome`); `CaptionPill` (`./CaptionPill`); `Caption`
  (`./captions`).
- Produces:
  ```ts
  export function TeamColumn(props: {
    roster: MemberSummary[]; board: LaneBoard | null; goals: readonly { id: string; title: string }[];
    collapsed?: boolean; onCollapse?: () => void;
    linked?: string | null; onLink?: (name: string | null) => void;
    caption?: Caption | null; captionColor?: string | undefined;
    now?: number; cfg?: LiveConfig | null; daemonBuild?: string; daemonEpoch?: number;
  }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing render tests**

```ts
import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TeamColumn } from './TeamColumn';

const m = (name: string, over: Record<string, unknown> = {}) =>
  ({ id: `m_${name}`, name, kind: 'agent', presence: 'online', posture: 'working', capabilities: {},
     presences: [{ status: 'online', surface: 'claude-code', model: 'claude-opus-5-5', model_source: 'observed' }],
     ...over }) as unknown as MemberSummary;
const board = { lanes: [{ id: 'l1', title: 'Trace coverage for every harness', owner_seat: 'ryder',
  state: 'claimed', claimed_at: 0, updated_at: 0, goal_id: 'launch' }] } as unknown as LaneBoard;
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(TeamColumn, { roster: [], board: null, goals: [], now: 42 * 60_000, ...props } as never));

describe('TeamColumn', () => {
  it('a card says who, which model, and what — in words a room can read', () => {
    const html = render({ roster: [m('ryder')], board, goals: [{ id: 'launch', title: 'Launch' }] });
    expect(html).toContain('ryder');
    expect(html).toContain('Opus 5.5');
    expect(html).toContain('working on');
    expect(html).toContain('Trace coverage for every harness');
    expect(html).toContain('for Launch · 42m');
    expect(html).toContain('<svg'); // the provider logo, not just a tint
  });

  it('a declared model says so', () => {
    const html = render({ roster: [m('a', { presences: [{ status: 'online', model: 'gpt-6-luna', model_source: 'binding' }] })] });
    expect(html).toContain('GPT 6');
    expect(html).toMatch(/declared/);
  });

  it('offline seats fold into one line', () => {
    const html = render({ roster: [m('a'), m('b', { presence: 'offline', posture: 'offline' })] });
    expect(html).toContain('+ 1 offline');
    expect(html).not.toContain('>b<');
  });

  it('collapsed: a rail of avatars, each carrying its provider logo and a labelled state', () => {
    const html = render({ roster: [m('ryder')], board, collapsed: true, onCollapse: () => {} });
    expect(html).toContain('lc-team__rail');
    expect(html).toMatch(/aria-label="ryder — Opus 5.5 — working on/);
  });

  it('the linked member is marked, so the office and the card read as one person', () => {
    const html = render({ roster: [m('ryder')], linked: 'ryder' });
    expect(html).toMatch(/lc-team-card[^"]*is-linked/);
  });

  it('never prints a lane id', () => {
    expect(render({ roster: [m('ryder')], board })).not.toContain('l1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/web exec vitest run src/live/TeamColumn.render.test.ts`
Expected: FAIL, `Cannot find module './TeamColumn'`.

- [ ] **Step 3: Implement `TeamCard.tsx`**

```tsx
import { useState } from 'react';
import type { LiveConfig } from './client';
import { initial, memberAvatar } from './format';
import { modelBadge } from './modelBadge';
import { providerIconHtml } from './modelProviderIcon';
import { SeatDetail } from './RosterPanel';
import { elapsed, type TeamCard as Card } from './teamCards';

/** One member, read by a room (ADR 464, spec §4). Click expands to the operator detail. */
export function TeamCard({
  card, now, linked, onLink, cfg = null, daemonBuild, daemonEpoch,
}: {
  card: Card; now: number; linked: boolean; onLink?: ((name: string | null) => void) | undefined;
  cfg?: LiveConfig | null; daemonBuild?: string | undefined; daemonEpoch?: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const badge = modelBadge(card.member);
  const age = elapsed(card.since, now);
  const meta = [card.goal ? `for ${card.goal}` : null, age].filter(Boolean).join(' · ');
  return (
    <li
      className={`lc-team-card lc-team-card--${card.state}${linked ? ' is-linked' : ''}`}
      style={{ ['--member' as string]: card.color }}
      onMouseEnter={() => onLink?.(card.name)}
      onMouseLeave={() => onLink?.(null)}
    >
      <button
        type="button"
        className="lc-team-card__hit"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => onLink?.(card.name)}
        onBlur={() => onLink?.(null)}
      >
        <span className="lc-team-card__avatar" style={{ background: memberAvatar(card.name, card.kind, card.member.hue) }} aria-hidden="true">
          {initial(card.name)}
        </span>
        <span className="lc-team-card__who">
          <span className="lc-team-card__name">{card.name}</span>
          <span className={`lc-team-card__model is-${badge.source}`} title={badge.full ?? undefined}
            style={{ borderColor: badge.provider.border, background: badge.provider.fill, color: badge.provider.ink }}>
            {badge.source !== 'human' && badge.source !== 'service' && (
              <span className="lc-team-card__logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: providerIconHtml(badge.provider) }} />
            )}
            {badge.label}
            {badge.source === 'declared' && <span className="lc-team-card__declared"> · declared</span>}
          </span>
        </span>
        <span className="lc-team-card__state">{card.stateLabel}</span>
        {card.title && (
          <span className={`lc-team-card__work${card.source === 'status' ? ' is-said' : ''}`}>
            {card.source === 'status' ? `“${card.title}”` : card.title}
            {card.moreLanes > 0 && <span className="lc-team-card__more"> +{card.moreLanes} more</span>}
          </span>
        )}
        {meta && <span className="lc-team-card__meta">{meta}</span>}
      </button>
      {open && (
        <div className="lc-team-card__detail">
          <SeatDetail m={card.member} daemonBuild={daemonBuild} daemonEpoch={daemonEpoch} cfg={cfg} />
        </div>
      )}
    </li>
  );
}
```

- [ ] **Step 4: Implement `TeamColumn.tsx`**

```tsx
import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import { CaptionPill } from './CaptionPill';
import type { Caption } from './captions';
import type { LiveConfig } from './client';
import { initial, memberAvatar } from './format';
import { modelBadge } from './modelBadge';
import { providerIconHtml } from './modelProviderIcon';
import { CollapseButton, PanelRail } from './PanelChrome';
import { TeamCard } from './TeamCard';
import { teamCards } from './teamCards';

/**
 * The team column (ADR 464): who is here, which model each agent runs, and what each is doing —
 * readable from the back of a room. Replaces the roster rail on /live; the operator detail it
 * carried is one click down on every card. Collapsed, it is a rail of avatars with provider logos.
 */
export function TeamColumn({
  roster, board, goals, collapsed = false, onCollapse, linked = null, onLink,
  caption = null, captionColor, now = Date.now(), cfg = null, daemonBuild, daemonEpoch,
}: {
  roster: MemberSummary[]; board: LaneBoard | null; goals: readonly { id: string; title: string }[];
  collapsed?: boolean; onCollapse?: () => void; linked?: string | null;
  onLink?: (name: string | null) => void; caption?: Caption | null; captionColor?: string | undefined;
  now?: number; cfg?: LiveConfig | null; daemonBuild?: string | undefined; daemonEpoch?: number | undefined;
}) {
  const { cards, offline } = teamCards(roster, board, goals);
  const working = cards.filter((c) => c.state === 'working').length;
  if (collapsed) {
    return (
      <aside className="lc-team is-collapsed" aria-label="The team">
        {onCollapse && <PanelRail side="mid" label="Team" hint={String(cards.length)} onExpand={onCollapse} />}
        <ul className="lc-team__rail">
          {cards.map((c) => {
            const b = modelBadge(c.member);
            return (
              <li key={c.name} className={`lc-team__pip lc-team__pip--${c.state}${linked === c.name ? ' is-linked' : ''}`}
                aria-label={`${c.name} — ${b.label} — ${c.stateLabel}${c.title ? ` ${c.title}` : ''}`}
                title={`${c.name} · ${b.label} · ${c.stateLabel}${c.title ? ` ${c.title}` : ''}`}
                onMouseEnter={() => onLink?.(c.name)} onMouseLeave={() => onLink?.(null)}>
                <span className="lc-team__pip-avatar" style={{ background: memberAvatar(c.name, c.kind, c.member.hue) }}>{initial(c.name)}</span>
                {b.source !== 'human' && b.source !== 'service' && (
                  <span className="lc-team__pip-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: providerIconHtml(b.provider) }} />
                )}
              </li>
            );
          })}
        </ul>
      </aside>
    );
  }
  return (
    <aside className="lc-team" aria-label="The team">
      <header className="lc-team__head">
        <span className="lc-team__title">The team</span>
        <span className="lc-team__count">{working} working</span>
        <span className="lc-team__spacer" />
        {onCollapse && <CollapseButton side="mid" label="the team" onClick={onCollapse} />}
      </header>
      <CaptionPill caption={caption} color={captionColor} className="lc-team__caption" />
      <ul className="lc-team__cards">
        {cards.map((c) => (
          <TeamCard key={c.name} card={c} now={now} linked={linked === c.name} onLink={onLink}
            cfg={cfg} daemonBuild={daemonBuild} daemonEpoch={daemonEpoch} />
        ))}
      </ul>
      {offline > 0 && <p className="lc-team__offline">+ {offline} offline</p>}
    </aside>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @musterd/web exec vitest run src/live/TeamColumn.render.test.ts`
Expected: PASS. If the `aria-label` assertion fails on escaping (`—` rendered as-is by
`renderToStaticMarkup`), keep the em dashes and fix the regex. Do not switch to hyphens.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/TeamCard.tsx packages/web/src/live/TeamColumn.tsx packages/web/src/live/TeamColumn.render.test.ts
git commit -m "feat(live): TeamColumn + TeamCard — model logo, plain state, work in big type (ADR 464)"
```

---

### Task 5: Office joints — plate model name, `setLinked`, plate hover

**Files:**
- Modify: `packages/web/src/live/office-scene/types.ts` (`OfficeHandle`, `OfficeOptions`)
- Modify: `packages/web/src/live/office-scene/index.ts` (plate build ~`:882`; handle object ~`:2362`)
- Modify: `packages/web/src/live/OfficeScene.tsx`
- Test: `packages/web/src/live/office-scene/scene-loop.test.ts`

**Interfaces:**
- Produces:
  - `OfficeHandle.setLinked: (name: string | null) => void`
  - `OfficeOptions.onPlateHover?: (name: string | null) => void`
  - `OfficeScene` props:
    - `onCaption?: (c: Caption | null) => void`
    - `linked?: string | null`
    - `onPlateHover?: (name: string | null) => void`

- [ ] **Step 1: Write the failing structure tests** (append to `scene-loop.test.ts`)

```ts
describe('the team column is linked to the room (ADR 464, lane 1)', () => {
  it('the handle exposes setLinked, and it only toggles a plate class — no canvas redraw', () => {
    expect(index).toMatch(/setLinked: \(name: string \| null\) =>/);
    const at = index.indexOf('setLinked: (name');
    const fn = index.slice(at, index.indexOf('\n    },', at));
    expect(fn).toContain("classList.toggle('is-linked'");
    expect(fn).not.toMatch(/draw|bake|renderScene/);
  });

  it('a plate reports hover back through options.onPlateHover', () => {
    expect(index).toMatch(/options\.onPlateHover\?\.\(/);
  });

  it('the plate carries the short model name beside the provider logo', () => {
    expect(index).toMatch(/lc-gl-label__model/);
    expect(index).toMatch(/displayModel\(node\.model\)/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/scene-loop.test.ts`
Expected: the 3 new tests FAIL; the existing ones PASS.

- [ ] **Step 3: Implement in `office-scene/index.ts`**

- (a) Import `displayModel` from `../modelBadge`.
- (b) In the plate build's `else` branch, after `plate.appendChild(icon);`, add:

```ts
          const short = displayModel(node.model);
          if (short) {
            const name = document.createElement('span');
            name.className = 'lc-gl-label__model';
            name.textContent = short;
            plate.appendChild(name);
          }
```

- (c) Where each plate element is created and stored in `labels` (the `labels.set(` call near
  `:528`'s map), attach, **only when `interactiveLabels`**:

```ts
          el.addEventListener('mouseenter', () => options.onPlateHover?.(node.name));
          el.addEventListener('mouseleave', () => options.onPlateHover?.(null));
```

- (d) Add to the returned handle, next to `setSuspended`:

```ts
    setLinked: (name: string | null) => {
      for (const [who, el] of labels) el.classList.toggle('is-linked', who === name);
    },
```

In `types.ts`, add `setLinked: (name: string | null) => void;` to `OfficeHandle` and
`onPlateHover?: (name: string | null) => void;` to `OfficeOptions`, each with a one-line doc
comment citing ADR 464.

- [ ] **Step 4: Wire `OfficeScene.tsx`**

- Add the three props, with doc comments.
- Pass `onPlateHover: (n) => onPlateHoverRef.current?.(n)` into `mountOffice` options, using the
  same latest-value-ref pattern as `onActClick`.
- Add `useEffect(() => handleRef.current?.setLinked(linked ?? null), [linked]);`.
- In the existing `onCaption` handler, also call `onCaptionRef.current?.(next)`, again through a
  latest-value ref.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @musterd/web exec vitest run src/live/office-scene/scene-loop.test.ts src/live`
Expected: PASS, and every existing `/live` test still passes.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/office-scene/index.ts packages/web/src/live/office-scene/types.ts packages/web/src/live/office-scene/scene-loop.test.ts packages/web/src/live/OfficeScene.tsx
git commit -m "feat(live): plates name the model; card↔character link via setLinked (ADR 464)"
```

---

### Task 6: Mount on `/live`, styles, responsive

**Files:**
- Modify: `packages/web/src/routes/live.tsx:75, 78-80, 403-420, 501-537`
- Modify: `packages/web/src/live/Live.css` (grid vars `:716-770`; new `.lc-team*` block; the
  `@media (max-width: 1080px)` rule at `:4279`)

- [ ] **Step 1: Route changes in `live.tsx`**

- `WORK_CUES` → `'none'`. Replace the comment with: `/** Work lives in the team column (ADR 464)
  — not on plates, and no longer in the floating stack. */`
- Rename `PanelId` `'roster'` → `'team'`. Update `NO_COLLAPSE`, the restore effect (read
  `saved.team ?? saved.roster` so a stored collapse survives the rename), and the canvas class
  (`is-team-collapsed`).
- Default the team column collapsed below 1280px on first load. In the restore effect, when no
  saved state exists: `setCollapsed({ ...NO_COLLAPSE, team: window.innerWidth < 1280 })`.
- Add state `const [linked, setLinked] = useState<string | null>(null);` and
  `const [caption, setCaption] = useState<Caption | null>(null);`.
- Pass `onCaption={setCaption} linked={linked} onPlateHover={setLinked}` to `<OfficeScene>`.
- Replace the `<RosterPanel … />` element with:

```tsx
            <TeamColumn
              roster={roster}
              board={board}
              goals={report?.goals ?? []}
              collapsed={collapsed.team}
              onCollapse={() => toggleCollapse('team')}
              linked={linked}
              onLink={setLinked}
              caption={caption}
              captionColor={captionColorFor(roster, caption)}
              cfg={cfg}
              daemonBuild={daemonBuild}
              daemonEpoch={daemonEpoch}
            />
```

- Add `captionColorFor` as a small exported helper in `TeamColumn.tsx`. Move the three lines that
  compute `captionColor` in `OfficeScene.tsx` there, and have `OfficeScene` import it, so there
  is one home.
- The roster's `unreadable` / `stale` / acceptance-ladder lines are not dropped. Render them in
  `TeamColumn` below the offline line by passing `unreadable` and `stale` through. Reuse the
  `lc-roster__gap` markup, copied into a `TeamColumnNotes` sub-component in `TeamColumn.tsx`, and
  add one render test that asserts "reload to meet" appears when `unreadable={1}`.
- Drop the `RosterPanel` import from `live.tsx`, but keep the file: it exports `SeatDetail`.

- [ ] **Step 2: CSS in `Live.css`**

- Rename `--col-roster` → `--col-team` and set it to `clamp(300px, 22vw, 400px)`.
- Rename `.lc-roster { grid-column: 2 }` → `.lc-team { grid-column: 2 }`.
- Rename `is-roster-collapsed` → `is-team-collapsed`, with the rail width `56px` for this track
  (`.lc__canvas.is-team-collapsed { --col-team: 56px; }`).
- In the `max-width: 1080px` rule, the team column is not hidden. Delete the `display:none`, and
  add `--col-team: 56px` there as the forced-collapsed width (JS also starts it collapsed).
- Add the `.lc-team*` block after the `.lc-roster` block. Use only defined tokens
  (`--lc-ground-2`, `--lc-border`, `--lc-text`, `--lc-muted`, `--lc-r-md`, `--lc-focus`, spacing
  `--lc-4..6`):

```css
/* ─── team column (ADR 464) — read by a room ─────────────────────────── */
.lc-team {
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--lc-ground-2);
  border-left: 1px solid var(--lc-border);
  overflow: hidden;
}
.lc-team__head {
  display: flex;
  align-items: center;
  gap: var(--lc-4);
  padding: var(--lc-5) var(--lc-6);
}
.lc-team__title {
  font: 600 11px/1 var(--lc-font-mono, 'Space Mono', monospace);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--lc-muted);
}
.lc-team__count {
  font-size: 12px;
  color: var(--lc-muted);
}
.lc-team__spacer {
  flex: 1;
}
.lc-team__cards {
  list-style: none;
  margin: 0;
  padding: 0 var(--lc-5) var(--lc-5);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--lc-4);
}
.lc-team-card {
  border-radius: var(--lc-r-md);
  border: 1px solid var(--lc-border);
  border-left: 4px solid var(--member);
  background: var(--lc-paper);
  transition: box-shadow var(--lc-dur-1) var(--lc-ease-out);
}
.lc-team-card.is-linked {
  box-shadow: 0 0 0 2px var(--member);
}
.lc-team-card__hit {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  display: grid;
  grid-template-columns: 28px 1fr;
  column-gap: var(--lc-4);
  row-gap: 2px;
  padding: var(--lc-4) var(--lc-5);
  cursor: pointer;
}
.lc-team-card__hit:focus-visible {
  outline: 2px solid var(--lc-focus);
  outline-offset: 2px;
}
.lc-team-card__avatar {
  grid-row: span 2;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 600;
  font-size: 13px;
}
.lc-team-card__who {
  display: flex;
  align-items: center;
  gap: var(--lc-4);
  min-width: 0;
}
.lc-team-card__name {
  font-size: 15px;
  font-weight: 650;
  color: var(--lc-text);
}
.lc-team-card__model {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  padding: 1px 6px;
  border: 1px solid;
  border-radius: var(--lc-r-sm);
  white-space: nowrap;
}
.lc-team-card__model.is-declared {
  opacity: 0.78;
}
.lc-team-card__model.is-unknown,
.lc-team-card__model.is-human,
.lc-team-card__model.is-service {
  border-color: var(--lc-border);
  color: var(--lc-muted);
}
.lc-team-card__logo svg {
  width: 13px;
  height: 13px;
  display: block;
}
.lc-team-card__state,
.lc-team-card__work,
.lc-team-card__meta {
  grid-column: 2;
}
.lc-team-card__state {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--lc-muted);
}
.lc-team-card__work {
  font-size: 16px;
  line-height: 1.3;
  color: var(--lc-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.lc-team-card__work.is-said {
  font-style: italic;
}
.lc-team-card__meta {
  font-size: 12px;
  color: var(--lc-muted);
}
.lc-team-card__detail {
  padding: 0 var(--lc-5) var(--lc-4) calc(28px + var(--lc-4) + var(--lc-5));
}
.lc-team__offline {
  margin: 0;
  padding: var(--lc-4) var(--lc-6);
  font-size: 12px;
  color: var(--lc-muted);
}
.lc-team__rail {
  list-style: none;
  margin: 0;
  padding: var(--lc-4) 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--lc-4);
  overflow-y: auto;
}
.lc-team__pip {
  position: relative;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  outline: 2px solid transparent;
  outline-offset: 2px;
}
.lc-team__pip--working {
  outline-color: var(--lc-text);
}
.lc-team__pip--between {
  outline: 2px dashed var(--lc-muted);
}
.lc-team__pip.is-linked {
  outline-width: 3px;
}
.lc-team__pip-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 600;
}
.lc-team__pip-logo {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--lc-paper);
  display: flex;
  align-items: center;
  justify-content: center;
}
.lc-team__pip-logo svg {
  width: 11px;
  height: 11px;
}
.lc-gl-label__model {
  font-size: 11px;
  font-weight: 600;
  margin-left: 3px;
  color: var(--lc-paper-muted);
}
.lc-gl-label.is-linked {
  box-shadow: 0 0 0 2px currentColor;
}
```

Before committing, check `--lc-font-mono`, `--lc-dur-1`, `--lc-ease-out` and `--lc-paper-muted`
exist in `Live.css` (`grep -n -- '--lc-font-mono:' packages/web/src/live/Live.css`). If
`--lc-font-mono` is not defined, use the family `canvasFont.ts`/the existing mono rules use,
without a `var()` fallback. `tokens:check` fails on an undefined token with a fallback.

- [ ] **Step 3: Run the fast gates**

```bash
pnpm --filter @musterd/web exec vitest run src/live
pnpm typecheck && pnpm lint && pnpm format:check
```

Expected: all green. If typecheck reports stale `dist` first, run `pnpm -r build` and re-run it
(see `docs/wiki/running-the-gates.md`).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/routes/live.tsx packages/web/src/live/Live.css packages/web/src/live/TeamColumn.tsx packages/web/src/live/OfficeScene.tsx packages/web/src/live/TeamColumn.render.test.ts
git commit -m "feat(live): mount the team column in place of the roster rail (ADR 464)"
```

---

### Task 7: Gates, browser pass, docs, PR

**Files:**
- Modify: `docs/architecture/08-web.md` (the "Roster" bullet near `:69`; the file tree near `:126`)

- [ ] **Step 1: Docs.** In `08-web.md`:
  - Replace the Roster bullet with a Team column bullet: what it shows, its sources, and that the
    expand carries the roster detail (ADR 464).
  - Add tree lines:
    - `modelBadge.ts` — presence → provider logo + readable model; observed/declared/unknown/human
    - `teamCards.ts` — roster + lanes + goals → ordered team cards in plain words
    - `TeamCard.tsx` — one member card; click expands to `SeatDetail`
    - `TeamColumn.tsx` — the /live team column + collapsed avatar rail
  - Update the `RosterPanel.tsx` line to say it now also exports `SeatDetail`.

- [ ] **Step 2: Full web gates**

```bash
pnpm -r build
pnpm --filter @musterd/web perf:check
pnpm --filter @musterd/web a11y:check
pnpm --filter @musterd/web a11y:targets:check
pnpm format:check
```

Expected: all green. On a perf or CSS budget red, read the message's named remedy. Do not raise a
budget without logging it in `docs/perf/web-live-baseline.md` (ADR 151). On a contrast red on
`.lc-team-card__model.is-declared`, raise its opacity or switch to the provider `ink` on `paper`,
then re-measure with `pnpm a11y:contrast`.

- [ ] **Step 3: Browser pass.** Run `pnpm dev` in `packages/web`, then open
  `http://localhost:5174/live?team=revive`:
  - At 1920×1080, with the team column expanded: every present member has a card with a logo,
    model label, state and work. Hovering a card rings its plate; hovering a plate rings its card.
    Take a screenshot.
  - Collapse the column: a 56px rail of avatars with logo pips. Take a screenshot.
  - At 390×844: the page has no horizontal scroll, and rail avatars are at least 24px.
  - Falsifier 4: measure the floor's on-screen width via `javascript_tool` on `.lc-gl-canvas`
    before (on `main`) and after. It must not shrink with the column expanded.

- [ ] **Step 4: Commit docs, push, PR**

```bash
git add docs/architecture/08-web.md
git commit -m "docs(web): team column replaces the roster rail on /live (ADR 464)"
pnpm typecheck && pnpm lint && pnpm format:check
git push -u origin feat/live-team-column
gh pr create --title "/live team column: who, which model, what — readable by a room (ADR 464, lane 1)" --body-file <(printf '%s\n' "Lane 1 of ADR 464. Screenshots: 1920×1080 expanded, collapsed, 390×844." "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)")
gh pr merge --squash --auto --delete-branch
```

Every commit in this plan ends with the seat trailer
`Co-authored-by: miley <miley@revive.musterd>` and
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (AGENTS.md git workflow step 2).

---

## Later lanes (planned when each starts)

2. Top bar meter, headline ticker (`headline()`), log drawer. The stream column and companion mode
   retire, and the team column moves to the right edge.
3. Ask banner and in-room ask moment, plus the "asking nick" card state.
4. Motion rules (working members lose errands and chats), walk tags from `headline()`, and the
   "how to read the office" key.
5. `/broadcast` adopts `TeamColumn` and the ticker.
