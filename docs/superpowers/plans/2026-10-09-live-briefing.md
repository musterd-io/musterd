# /live and /broadcast briefing — implementation plan

> **For agentic workers:** this plan is carried by the seat that owns each lane (musterd is the
> orchestration model — no writing subagents). Steps use checkbox (`- [ ]`) syntax.

**Goal:** a viewer sees, at a glance, what the team is working on, what is blocked or waiting on a
human, what is in review, and what just shipped — on `/live` for members and on `/broadcast` for the
stream.

**Architecture:** one pure selector (`briefing.ts`) over the data the pages already hold; `/live`
renders it as a Now panel, `/broadcast` as a lower-third. No protocol or server change.

**Tech Stack:** React 19 + TanStack Router, vitest (node, `renderToStaticMarkup` — no jsdom), CSS tokens
in `Live.css`/`Broadcast.css`.

**Spec:** [`docs/superpowers/specs/2026-10-09-live-briefing-design.md`](../specs/2026-10-09-live-briefing-design.md)

## Increments

| #   | Increment                                                              | Lane                         | Depends on |
| --- | ---------------------------------------------------------------------- | ---------------------------- | ---------- |
| 1   | `briefing.ts` + tests; headline replaces the topbar meter              | `01M4FG58SX6BBJ736S4W1CHASS` | —          |
| 2   | The Now panel on `/live`, Team tab, admin seat requests                | `01M4FG5JRAR3QD460DWC7M7E7M` | 1          |
| 2b  | The office blocked marker, split out of 2                              | `01M4GP19XE5JEC6MA7YCGZGSK6` | 2          |
| 3   | The `/broadcast` lower-third                                           | `01M4FG5NWKCYSYQ9RWG06Y4TNC` | 1          |

The spec lane `01M4FG1R7C84HM4RE5GF7FF6WZ` closes when this plan's PR merges; it is the design record, not
one of the increments. When an increment closes and others remain, say what is left (`follows_up`).

## Global Constraints

- No new runtime dependency; no new font family (Recursive, three cuts).
- `pnpm perf:check` budgets hold; new route code stays in the existing graph or a lazy chunk.
- `pnpm a11y:check` and `pnpm a11y:targets:check` stay green (desktop and 390×844, `/live` connected).
- `--lc-warn` is for fills only; text in the warn hue uses `--lc-warn-ink`.
- Every new colour or length token is defined where its consumer mounts (`pnpm tokens:check`).
- Animation and timers stop when the tab is hidden; still mode is honoured.
- `packages/protocol` and `packages/server` are not touched.
- **Local test runs:** this laptop hosts ~12 seats. Run `pnpm typecheck && pnpm lint && pnpm format:check`
  locally; vitest and the a11y/perf gates run in CI (push the branch and read the result). The "run the
  test" steps below name the command so CI or a measured run can reproduce it.

## Review Focus

Inputs the spec implies but a happy-path test would miss, most likely first:

1. **A blocked lane with no owner or no goal** renders (owner chip omitted, goal omitted), never "undefined".
2. **A seat-claim `requests` list given to a non-admin viewer** is ignored: the selector takes `requests`
   only when the caller passes it, and `/broadcast` never does. Tested at the selector and at the render.
3. **Zero everything** (a fresh team): the headline reads "quiet — nothing in flight", not "0 in progress · 0 blocked …".
4. **A lane `done` 23h59m ago vs 24h01m ago** — the 24 h edge.
5. **Hundreds of lanes**: the panel mounts a bounded number of rows (five per section plus "+N more").

## File structure

| File                                       | Responsibility                                                       | Inc |
| ------------------------------------------ | -------------------------------------------------------------------- | --- |
| `packages/web/src/live/briefing.ts`        | pure selector: `briefing(input)` → `Briefing`                        | 1   |
| `packages/web/src/live/briefing.test.ts`   | selector tests                                                       | 1   |
| `packages/web/src/live/TopMeter.tsx`       | headline replaces the "N working" tail                               | 1   |
| `packages/web/src/live/NowPanel.tsx/.css`  | the four-section panel + Team tab                                    | 2   |
| `packages/web/src/live/useSeatRequests.ts` | admin-only pending-requests poll; `[]` for everyone else             | 2   |
| `packages/web/src/live/officeRoom.ts`      | blocked marker input for the office plates                           | 2   |
| `packages/web/src/live/BroadcastBriefing.tsx` | lower-third; rotates buckets, Needs-a-human holds it              | 3   |

---

## Increment 1 — the selector and the headline (lane `01M4FG58SX6BBJ736S4W1CHASS`)

### Task 1: `briefing.ts`

**Files:**
- Create: `packages/web/src/live/briefing.ts`
- Test: `packages/web/src/live/briefing.test.ts`

**Interfaces:**
- Consumes: `askIsLoud`, `AskView` (`./asks`); `Lane`, `LaneBoard`, `Request` (`@musterd/protocol`).
- Produces:

```ts
export type NeedsKind = 'ask' | 'approval' | 'blocked' | 'seat-request';
export interface NeedsItem {
  id: string;            // stable React key: `ask:<env.id>` | `lane:<lane.id>` | `req:<request.id>`
  kind: NeedsKind;
  title: string;         // ask question (first line, ≤ 90), lane title, or "wants to join as <target>"
  owner: string | null;  // who is asking / who owns the blocked lane
  waitingOn: string | null; // ask.to, when routed
  since: number;         // ms epoch the wait began
  laneId: string | null; // set for 'blocked'
}
export interface WorkItem { id: string; title: string; owner: string | null; goal: string | null; since: number }
export interface ShippedItem { id: string; title: string; by: string | null; at: number }
export interface Briefing {
  needsHuman: NeedsItem[];
  inProgress: WorkItem[];
  inReview: WorkItem[];
  shipped: ShippedItem[];
  headline: string;
}
export const SHIPPED_WINDOW_MS = 24 * 60 * 60 * 1000;
export function briefing(input: {
  board: LaneBoard | null;
  goals: readonly { id: string; title: string }[];
  asks: readonly AskView[];
  requests?: readonly Request[];
  now: number;
}): Briefing;
```

**Definition of the words, once.** `inProgress` is **lanes** in `claimed`/`active`, so the headline counts
lanes ("3 in progress"), not people. That is what retires the "1 working" vs "3 working" disagreement: the
old meter counted a presence posture, the old column counted lane-owning cards, and they are different
facts. The per-member Team tab keeps the person view.

- [ ] **Step 1: Write the failing test**

```ts
import type { LaneBoard } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { AskView } from './asks';
import { briefing, SHIPPED_WINDOW_MS } from './briefing';

const NOW = 1_800_000_000_000;
const lane = (id: string, state: string, over: Record<string, unknown> = {}) => ({
  id, title: `title ${id}`, state, owner_seat: 'ann', goal_id: null, depends_on: [],
  claimed_at: NOW - 60_000, updated_at: NOW - 60_000, resolved_at: null, ...over,
});
const board = (...lanes: unknown[]) => ({ lanes, warnings: [] }) as unknown as LaneBoard;
const ask = (id: string, state: string, species = 'consult', age = 5_000, to: string | null = 'nick'): AskView =>
  ({ env: { id, from: 'ann', ts: NOW - age, body: 'May I?\nmore' }, species, tier: 'standard', to,
     deadline: NOW + 1, state }) as unknown as AskView;
const run = (over: Record<string, unknown> = {}) =>
  briefing({ board: board(), goals: [], asks: [], now: NOW, ...over });

describe('briefing', () => {
  it('buckets lanes by state', () => {
    const b = run({ board: board(
      lane('a', 'active'), lane('b', 'claimed'), lane('c', 'blocked'),
      lane('d', 'awaiting_acceptance'), lane('e', 'open', { owner_seat: null }),
    ) });
    expect(b.inProgress.map((x) => x.id)).toEqual(['lane:a', 'lane:b']);
    expect(b.inReview.map((x) => x.id)).toEqual(['lane:d']);
    expect(b.needsHuman.map((x) => [x.kind, x.laneId])).toEqual([['blocked', 'c']]);
  });

  it('puts loud asks and approve-asks in needsHuman, and not settled ones', () => {
    const b = run({ asks: [ask('1', 'open'), ask('2', 'held', 'approve', 9_000), ask('3', 'accepted')] });
    expect(b.needsHuman.map((x) => [x.id, x.kind])).toEqual([['ask:2', 'approval'], ['ask:1', 'ask']]);
    expect(b.needsHuman[1]!.title).toBe('May I?');
  });

  it('includes seat requests only when the caller passes them', () => {
    const req = { id: 'r1', target: 'seat:zed', ts: NOW - 1000, status: 'pending' } as never;
    expect(run().needsHuman).toEqual([]);
    expect(run({ requests: [req] }).needsHuman.map((x) => x.kind)).toEqual(['seat-request']);
  });

  it('keeps a lane shipped inside 24h and drops it outside', () => {
    const b = run({ board: board(
      lane('in', 'done', { resolved_at: NOW - SHIPPED_WINDOW_MS + 60_000 }),
      lane('out', 'done', { resolved_at: NOW - SHIPPED_WINDOW_MS - 60_000 }),
    ) });
    expect(b.shipped.map((x) => x.id)).toEqual(['lane:in']);
  });

  it('survives a lane with no owner and no goal', () => {
    const b = run({ board: board(lane('x', 'blocked', { owner_seat: null })) });
    expect(b.needsHuman[0]!.owner).toBeNull();
  });

  it('headline counts equal list lengths', () => {
    const b = run({
      board: board(lane('a', 'active'), lane('b', 'active'), lane('c', 'blocked'),
        lane('d', 'done', { resolved_at: NOW - 1000 })),
      asks: [ask('1', 'open')],
    });
    expect(b.headline).toBe('2 in progress · 2 need a human · 1 shipped today');
    expect(b.headline).toContain(`${b.inProgress.length} in progress`);
    expect(b.headline).toContain(`${b.needsHuman.length} need a human`);
  });

  it('says quiet for an empty team', () => {
    expect(run().headline).toBe('quiet — nothing in flight');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/web exec vitest run src/live/briefing.test.ts`
Expected: FAIL — `Cannot find module './briefing'`. (CI, or one measured local run — see Global Constraints.)

- [ ] **Step 3: Write the implementation**

```ts
import type { Lane, LaneBoard, Request } from '@musterd/protocol';
import { askIsLoud, type AskView } from './asks';

export const SHIPPED_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHOWN_TITLE = 90;

export type NeedsKind = 'ask' | 'approval' | 'blocked' | 'seat-request';
export interface NeedsItem {
  id: string; kind: NeedsKind; title: string; owner: string | null;
  waitingOn: string | null; since: number; laneId: string | null;
}
export interface WorkItem { id: string; title: string; owner: string | null; goal: string | null; since: number }
export interface ShippedItem { id: string; title: string; by: string | null; at: number }
export interface Briefing {
  needsHuman: NeedsItem[]; inProgress: WorkItem[]; inReview: WorkItem[];
  shipped: ShippedItem[]; headline: string;
}

const recency = (l: Lane) => l.claimed_at ?? l.updated_at;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => clip(s.split('\n', 1)[0]!.trim(), SHOWN_TITLE);

export function briefing(input: {
  board: LaneBoard | null;
  goals: readonly { id: string; title: string }[];
  asks: readonly AskView[];
  requests?: readonly Request[];
  now: number;
}): Briefing {
  const { board, goals, asks, requests = [], now } = input;
  // "Name — what it promises" → "Name": the item names the goal, it does not retell it.
  const goalName = new Map(goals.map((g) => [g.id, g.title.split(' — ')[0]!.trim()] as const));
  const work = (l: Lane): WorkItem => ({
    id: `lane:${l.id}`, title: l.title, owner: l.owner_seat,
    goal: l.goal_id ? (goalName.get(l.goal_id) ?? null) : null, since: recency(l),
  });

  const lanes = board?.lanes ?? [];
  const inProgress = lanes.filter((l) => l.state === 'claimed' || l.state === 'active')
    .sort((a, b) => recency(b) - recency(a)).map(work);
  const inReview = lanes.filter((l) => l.state === 'awaiting_acceptance')
    .sort((a, b) => recency(b) - recency(a)).map(work);
  const shipped = lanes
    .filter((l) => l.state === 'done' && l.resolved_at !== null && now - l.resolved_at < SHIPPED_WINDOW_MS)
    .sort((a, b) => b.resolved_at! - a.resolved_at!)
    .map((l): ShippedItem => ({ id: `lane:${l.id}`, title: l.title, by: l.owner_seat, at: l.resolved_at! }));

  const needsHuman: NeedsItem[] = [
    ...asks.filter((a) => askIsLoud(a.state)).map((a): NeedsItem => ({
      id: `ask:${a.env.id}`, kind: a.species === 'approve' ? 'approval' : 'ask',
      title: firstLine(a.env.body), owner: a.env.from, waitingOn: a.to, since: a.env.ts, laneId: null,
    })),
    ...lanes.filter((l) => l.state === 'blocked').map((l): NeedsItem => ({
      id: `lane:${l.id}`, kind: 'blocked', title: l.title, owner: l.owner_seat,
      waitingOn: null, since: recency(l), laneId: l.id,
    })),
    ...requests.filter((r) => r.status === 'pending').map((r): NeedsItem => ({
      id: `req:${r.id}`, kind: 'seat-request',
      title: `wants to join${r.target ? ` as ${r.target.replace(/^(seat|role):/, '')}` : ''}`,
      owner: null, waitingOn: null, since: r.ts, laneId: null,
    })),
  ].sort((a, b) => a.since - b.since); // longest-waiting first

  const parts = [
    inProgress.length ? `${inProgress.length} in progress` : null,
    needsHuman.length ? `${needsHuman.length} need${needsHuman.length === 1 ? 's' : ''} a human` : null,
    inReview.length ? `${inReview.length} in review` : null,
    shipped.length ? `${shipped.length} shipped today` : null,
  ].filter((p): p is string => p !== null);
  return { needsHuman, inProgress, inReview, shipped, headline: parts.length ? parts.join(' · ') : 'quiet — nothing in flight' };
}
```

- [ ] **Step 4: Run to verify it passes** — same command; Expected: PASS (7 tests).
- [ ] **Step 5: Commit** — `git add packages/web/src/live/briefing.ts packages/web/src/live/briefing.test.ts` then commit
  `feat(web): briefing selector — one definition of "in progress", "needs a human", "shipped"` with the seat trailer.

### Task 2: the headline replaces the meter's tail

**Files:**
- Modify: `packages/web/src/live/TopMeter.tsx` (the `who` string, lines ~25–34)
- Modify: `packages/web/src/routes/live.tsx` (pass `board`, `asks`, `goals` to `TopMeter`)
- Test: `packages/web/src/live/TopMeter.render.test.ts` (new)

**Interfaces:** Consumes `briefing()`. `TopMeter` gains optional `headline?: string`; when set it renders
in place of `who`. Produces nothing later tasks need (inc 2 deletes the `who` fallback with the column).

- [ ] **Step 1: failing test** — render `TopMeter` with `headline="2 in progress · 1 needs a human"` and
  assert the markup contains it and does not contain `between tasks`.
- [ ] **Step 2: run** `pnpm --filter @musterd/web exec vitest run src/live/TopMeter.render.test.ts` — FAIL.
- [ ] **Step 3: implement** — add the prop; `<span className="lc-meter__who">{headline ?? who}</span>`; in
  `live.tsx` compute `const brief = useMemo(() => briefing({ board, goals: report?.goals ?? [], asks, now }), …)`
  with `now` from the page's existing 1 s clock, and pass `headline={brief.headline}`.
- [ ] **Step 4: run** — PASS. Then `pnpm typecheck && pnpm lint && pnpm format:check`.
- [ ] **Step 5: verify in the browser** — `pnpm dev` in this workspace, `http://localhost:5174/live?team=revive`
  at 1440×900: the topbar tail and the (still-present) team column header must not disagree on how many
  are in progress. Screenshot into the PR.
- [ ] **Step 6: commit, PR, auto-merge, `lane_submit`** per the repo's git workflow. Stakes `normal`.

---

## Increment 2 — the Now panel (lane `01M4FG5JRAR3QD460DWC7M7E7M`)

### Task 3: `useSeatRequests`

**Files:** Create `packages/web/src/live/useSeatRequests.ts`; test `useSeatRequests.test.ts`.

**Interfaces:** Consumes `fetchRequests(cfg, { pendingOnly: true })` and `AuditFetchError` (`./client`).
Produces `useSeatRequests(cfg: LiveConfig | null): readonly Request[]` — polls every 30 s while the tab is
visible, and returns `[]` for any error, including 401/403 (a non-admin credential is the normal case, not
a failure). The pure part is `settleRequests(result: Request[] | Error): Request[]`, which is what the
test pins.

- [ ] **Step 1: failing test** — `settleRequests(new AuditFetchError(…403…))` → `[]`; `settleRequests(list)` →
  `list`; a thrown non-audit `Error` → `[]`.
- [ ] **Step 2–4:** run (FAIL) → implement (`try { return await fetchRequests(...) } catch { return [] }`
  inside the effect; interval cleared on unmount and while hidden) → run (PASS).
- [ ] **Step 5: commit.**

### Task 4: `NowPanel`

**Files:** Create `NowPanel.tsx`, `NowPanel.css`, `NowPanel.render.test.ts`; modify `TeamColumn.tsx`
(exported as the Team tab's body, unchanged), `routes/live.tsx` (mount `NowPanel` in the column slot).

**Interfaces:**
- Consumes: `Briefing` (inc 1), `TeamColumn` props for the Team tab.
- Produces: `<NowPanel brief={Briefing} onOpenLane={(id: string) => void} onOpenAsk={(id: string) => void}
  team={ReactNode} />`.

Structure (the JSX the test asserts against):

```tsx
<aside className="now" aria-label="Now">
  <div role="tablist" className="now__tabs">…Now · Team…</div>
  <section className={`now__needs${brief.needsHuman.length ? ' is-loud' : ''}`} aria-label="Needs a human">
    {brief.needsHuman.length === 0
      ? <p className="now__calm">nothing is waiting on anyone</p>
      : <>
          <h2 className="now__h">Needs a human <b>{brief.needsHuman.length}</b></h2>
          <ul>{brief.needsHuman.slice(0, ROWS).map(/* card: kind chip · title · owner · age */)}</ul>
          {brief.needsHuman.length > ROWS && <p className="now__more">+{brief.needsHuman.length - ROWS} more</p>}
        </>}
  </section>
  <Section title="In progress" items={brief.inProgress} />
  <Section title="In review" items={brief.inReview} />
  <Section title="Shipped" sub="24 h" items={brief.shipped} />
</aside>
```

`ROWS = 5` for the three quiet sections, `ROWS = 8` for Needs a human (a loud section that hides items
defeats its job; the "+N more" row is the escape, not the norm). Colours: band fill `--lc-warn` at low
alpha via `color-mix`, text `--lc-warn-ink`, defined on `.now` (the consumers mount inside it).

- [ ] **Step 1: failing render test** — with a brief containing 1 blocked lane, 1 ask, 2 in progress:
  markup contains `class="now__needs is-loud"`, the blocked lane's full title (not clipped), `+0` absent;
  with an empty brief: contains `nothing is waiting on anyone` and no `is-loud`; with 20 in-progress items:
  exactly 5 `<li` in that section and `+15 more`.
- [ ] **Step 2:** run `pnpm --filter @musterd/web exec vitest run src/live/NowPanel.render.test.ts` — FAIL.
- [ ] **Step 3:** implement; wire into `live.tsx` replacing `<TeamColumn …/>` in the `lc__canvas` grid, with
  `TeamColumn` passed as the `team` tab body. Admin seat requests: `const requests = useSeatRequests(cfg)`
  passed into `briefing({ …, requests })`; a seat-request row's `onOpen` is `window.location.assign('/approvals')`.
- [ ] **Step 4:** run — PASS; `pnpm typecheck && pnpm lint && pnpm format:check`.
- [ ] **Step 5: office marker — moved to increment 2b (lane `01M4GP19XE5JEC6MA7YCGZGSK6`, 2026-10-09).** Original intent: in `officeRoom.ts` add a `blocked: ReadonlySet<string>` of owner names
  derived from `brief.needsHuman` (`kind === 'blocked'`), and have the plate render a small marker when the
  seat is in it. Test: `officeRoom` given a board with one blocked lane owned by `ann` lists `ann` in
  `blocked`.
- [ ] **Step 6: look at it** — `pnpm dev`; 1440×900 and 390×844; every non-empty Needs-a-human item
  visible with no scroll and no click (the spec's falsifier 3). Screenshots into the PR.
- [ ] **Step 7: CI gates** — push; `a11y:check`, `a11y:targets:check`, `perf:check` must be green. If
  `perf:check` fails, read which budget (ADR 183) before reaching for a raise.
- [ ] **Step 8:** commit, PR, auto-merge, `lane_submit`. Stakes `normal`.

---

## Increment 3 — the `/broadcast` lower-third (lane `01M4FG5NWKCYSYQ9RWG06Y4TNC`)

### Task 5: `BroadcastBriefing`

**Files:** Create `BroadcastBriefing.tsx`, `BroadcastBriefing.render.test.ts`; modify `Broadcast.css`,
`routes/broadcast.tsx` (mount in the lower area, alongside the `Ticker`).

**Interfaces:**
- Consumes: `Briefing`; the page's still-mode flag (`stillMode.ts`).
- Produces: `<BroadcastBriefing brief={Briefing} />`. **Its caller must call `briefing()` without
  `requests`** — the component's props cannot carry a seat request, and the test asserts the markup never
  contains `wants to join`.

Behaviour: the headline sentence in large type; below it one bucket at a time from
`['inProgress','inReview','shipped']`, up to three rows (title and owner only), advancing every 12 s;
when `brief.needsHuman.length > 0` the lower-third shows only Needs a human (up to three rows, "+N more")
and the rotation is suspended. The pure part is `pickBucket(brief, tick): 'needs' | 'inProgress' |
'inReview' | 'shipped' | null`, which the test pins. Timer: `setInterval` created only while
`document.visibilityState === 'visible'` and not in still mode; cleared on hide and unmount.

- [ ] **Step 1: failing tests** — `pickBucket` returns `'needs'` for every tick when needsHuman is
  non-empty; cycles the non-empty buckets by tick otherwise; returns `null` for an empty brief. Render:
  a brief whose `needsHuman` holds a `seat-request` item (a bug upstream) renders **no** `wants to join`
  text — the component filters `kind === 'seat-request'` as a second wall.
- [ ] **Step 2:** run `pnpm --filter @musterd/web exec vitest run src/live/BroadcastBriefing.render.test.ts` — FAIL.
- [ ] **Step 3:** implement; in `broadcast.tsx` build `briefing({ board, goals: report?.goals ?? [], asks, now })`
  (no `requests`) and mount `<BroadcastBriefing brief={brief} />`.
- [ ] **Step 4:** run — PASS; `pnpm typecheck && pnpm lint && pnpm format:check`.
- [ ] **Step 5: look at it** — `pnpm dev`, `http://localhost:5174/broadcast?team=revive` at 1920×1080: readable
  at stream size (capture at the stage size, per the designer skill), and a stranger can say what the team
  is doing from one frame.
- [ ] **Step 6: CI gates, then** commit, PR, auto-merge, `lane_submit`. Stakes **high**: expect a human
  acceptor. **Not deployed by this lane** — the `/live` and `/broadcast` bundle republishes from `main`
  within ~60 s; the stream restart (if one is running) is a separate act.

---

## Self-review (against the spec)

- Decision 1 (one selector) → Task 1. Decision 2 (blocked is loud) → Task 1 + Task 4 (`is-loud`).
- Decision 3 (two kinds of approval) → Task 1 (`approval` kind from `approve` asks; `requests` optional),
  Task 3 (admin-only read), Task 5 (second wall on `/broadcast`).
- Decision 4 (no protocol/server change) → Global Constraints; no task touches those packages.
- Falsifier 1 (headline counts equal list lengths) → Task 1 test "headline counts equal list lengths".
- Falsifier 2 (seat requests never reach `/broadcast`) → Tasks 1 and 5 tests.
- Falsifier 3 (everything non-empty visible at 1440×900) → Task 4 step 6.
- **One wording change from the spec:** the headline counts **lanes** ("3 in progress"), not people
  ("3 working"). The spec's example sentence is updated in the same commit as this plan.
