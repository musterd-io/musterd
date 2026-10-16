# `musterd pick` (the lane picker): implementation plan

> **For agentic workers:** implement in your own seat, one lane per PR (AGENTS.md hard rule 8 — no
> writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a factual open-lane picker that the human runs or the agent opens. It is a two-pane
terminal view plus a /live overlay, and it assigns the picked lane to the seat the human is talking to.

**Architecture:** One pure function in protocol, `pickerRows`, turns `GET /lanes`
(`{lanes, warnings}`) into grouped rows. Three front ends call it: the terminal picker, the plain
table, and /live. A /live pick is the existing `lane_handoff` from the signed-in human. A terminal pick
is the seat's own claim, carrying a new optional `pick` field (`attested: false`). The daemon records
the field and raises a directed notice on the seat's interrupt line.

**Tech stack:** TypeScript, zod (protocol), node `readline` raw mode (CLI, no new dependency), React
(/live), vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-musterd-pick-design.md`. Read it first.

## Increments

| # | Lane | Owner | Needs | What lands |
| - | ---- | ----- | ----- | ---------- |
| 1 | `01M5162FVMTMQYBS3WJPBEN4B3` | izzo | spec `01M515KHW0` | ADR; `PickSchema`, `pick` on the claim patch, `declined` on the lane, `release_reason` on the patch (schemas only); `pickerRows` + `filterPicker` |
| 2 | `01M5162MTCDYFFDZ6J0JQTTSDJ` | open | 1 | daemon: persists `declined`, records `pick` on `lane.claimed`, raises the pick notice, refuses a `pick` that claims `attested: true` |
| 3 | `01M5162QS1DP8JVVR93SMZ9N1B` | open | 1 | CLI `musterd pick`: generic picker shell, two-pane view, table fallback, `--open`, Figma frame |
| 4 | `01M5162T6HS83383H11MX6EQJF` | open | 1, 2 | /live `PickOverlay` |
| 5 | `01M5162W38T5QC48EWZH1A326A` | open | 2 | musterd skill + pick act text (behavior B), end-to-end scenario |

Lanes 2–5 may go to other seats. Each section below is detailed enough to start from. The owner
re-reads the anchors at claim time, because line numbers drift.

## Global constraints

- `@musterd/protocol` schema changes need the ADR from lane 1 (hard rule 1). Lanes 2–5 add no
  schema. If they need one, they amend lane 1's ADR by a new ADR, not silently.
- No new runtime dependency (hard rule 6). The terminal picker uses `node:readline` raw mode, as
  ADR 491 does.
- CLI output must match a Figma terminal frame (hard rule 2). The two-pane frame goes into
  `docs/design/figma-brief-terminal.md` in lane 3.
- A terminal pick is **never** `attested: true`. The daemon refuses it (lane 2).
- Parse all input at the boundary through protocol zod schemas (hard rule 4).
- Words: "lane picker" (this feature), never "picker" alone in user-facing copy. The ADR 491
  "seat picker" is a different screen.
- Fast local gates only: `pnpm typecheck && pnpm lint && pnpm format:check`. CI runs the tests.
  On this laptop, tests are not run locally.

## Review focus

1. **A lane whose dependency was closed more than 14 days ago.** The board leaves it out (ADR 534
   history window), and the daemon treats a missing dependency as met. `pickerRows` must therefore
   read "blocked" only from `unmet_dependency` warnings, never from `depends_on` alone. Test in
   Task 1.3.
2. **A long or multi-line brief with ANSI escapes or control characters**, typed by a seat. The
   terminal view must strip control bytes before painting, or one brief repaints the whole
   screen. Test in Task 3.3.
3. **The board changes between paint and pick** (claimed elsewhere). The pick re-reads the lane
   and refuses with "taken by X". Test in Task 3.4.
4. **The seat already owns the lane** (it was picked twice). The pick is a no-op that says so, and
   no second notice is raised. Test in Task 2.2.
5. **A decline note from a seat that later picks the lane up itself.** `declined` is cleared on
   any claim, so the note never sits on an owned lane. Test in Task 2.1.

---

## Lane 1: `01M5162FVM`, ADR + schemas + `pickerRows` (izzo)

### Task 1.1: Reserve the ADR number, then write the ADR

**Files:**
- Create: `docs/decisions/NNN-lane-picker-pick-attestation.md`

- [ ] **Step 1: Branch and reserve the number.**

```bash
git fetch origin main && git checkout -b feat/lane-picker-1 origin/main
pnpm adr:next            # prints NNN and the skeleton
```

- [ ] **Step 2: Push a draft PR straight away** (ADR 223: the number is contested from the moment
  you take it).

```bash
git commit --allow-empty -m "ADR NNN: lane picker — reserve (lane 01M5162FVM)"
git push -u origin feat/lane-picker-1
gh pr create --draft --title "ADR NNN: the lane picker's pick attestation (lane 01M5162FVM)" --body "Lane \`01M5162FVMTMQYBS3WJPBEN4B3\`."
```

- [ ] **Step 3: Write the ADR** with these sections: Context, Problem, Decision, Consequences,
  Observability & Evaluation.
  - **Decision 1.** `pick` on the claim patch: `{via: 'terminal' | 'live', requested_by, attested,
    harness?, at}`.
  - **Decision 2.** The honest-label rule: `attested` is true only for a handoff whose actor is the
    `requested_by` human. A terminal pick sends `false`. The daemon refuses `true` from a seat
    claiming for itself.
  - **Decision 3.** `declined: {by, reason, at} | null` on the lane, set by a release that carries
    `release_reason`, and cleared by any claim.
  - **Decision 4.** `pickerRows` is the one list. Blocked is read from `unmet_dependency` warnings.
  - **Decision 5.** A claim carrying `pick` raises a directed `message` to the claiming seat, with
    `meta.lane_pick`, which the interrupt line delivers.
  - **Observability & Evaluation:**
    - picks per day by `via`;
    - declines over picks;
    - time from pick to the seat's first act on the lane.
    - Falsifier: if most picks are declined, the list does not show what a seat can do.

- [ ] **Step 4: Commit** (`docs: ADR NNN …  Refs ADR-NNN`).

### Task 1.2: Schemas

**Files:**
- Modify: `packages/protocol/src/lanes.ts`: `UpdateLaneSchema` (around line 680) and `LaneSchema`
  (around line 495).
- Test: `packages/protocol/src/lanes.pick.test.ts` (new).

**Interfaces, produced:** `PickSchema`, `Pick`, `LaneDeclinedSchema`, `LaneDeclined`, plus
`UpdateLane.pick`, `UpdateLane.release_reason` and `Lane.declined`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { LaneSchema, PickSchema, UpdateLaneSchema } from './lanes.js';

describe('lane picker schemas (ADR NNN)', () => {
  it('a terminal pick parses and keeps its honest label', () => {
    const p = PickSchema.parse({
      via: 'terminal',
      requested_by: 'nick',
      attested: false,
      harness: 'claude-code',
      at: 1,
    });
    expect(p.attested).toBe(false);
    expect(UpdateLaneSchema.parse({ owner_seat: 'izzo', pick: p }).pick).toEqual(p);
  });

  it('refuses an unknown via and an over-long release reason', () => {
    expect(PickSchema.safeParse({ via: 'slack', requested_by: 'n', attested: false, at: 1 }).success).toBe(false);
    expect(UpdateLaneSchema.safeParse({ state: 'open', release_reason: 'x'.repeat(501) }).success).toBe(false);
  });

  it('a lane without declined still parses (older daemon), and declined round-trips', () => {
    const base = LaneSchema.parse(minimalLane());
    expect(base.declined ?? null).toBeNull();
    const d = { by: 'izzo', reason: 'needs a second machine', at: 2 };
    expect(LaneSchema.parse({ ...minimalLane(), declined: d }).declined).toEqual(d);
  });
});

function minimalLane() {
  return {
    id: '01M5162FVMTMQYBS3WJPBEN4B3', team: 't', project: 'p', title: 'x', detail: null,
    owner_seat: null, role: null, scope: [], depends_on: [], branch: null, goal_id: null,
    risk: [], stakes: 'normal', state: 'open', created_by: 'nick', created_at: 0,
    claimed_at: null, resolved_at: null, updated_at: 0,
  };
}
```

(If `LaneSchema` requires more fields than `minimalLane` gives, copy the fixture from
`laneDetail.test.ts`. Do not loosen the schema.)

- [ ] **Step 2: Implement.** Add these definitions above `LaneSchema`:

```ts
/** ADR NNN: how a lane-picker pick reached the daemon, and how strongly "who asked" is proven. */
export const PickSchema = z.object({
  via: z.enum(['terminal', 'live']),
  requested_by: z.string().min(1).max(64),
  /** True only for a /live handoff whose actor IS `requested_by`. A terminal pick is never attested. */
  attested: z.boolean(),
  harness: z.string().max(32).optional(),
  at: z.number().int(),
});
export type Pick = z.infer<typeof PickSchema>;

/** ADR NNN: the most recent decline — a release that gave a reason. Cleared by any claim. */
export const LaneDeclinedSchema = z.object({
  by: z.string(),
  reason: z.string().max(500),
  at: z.number().int(),
});
export type LaneDeclined = z.infer<typeof LaneDeclinedSchema>;
```

On `LaneSchema`, add `declined: LaneDeclinedSchema.nullable().optional(),`. It is optional, like
`parked`, so older daemons and fixtures stay assignable.

On `UpdateLaneSchema`, add `pick: PickSchema.optional(),` and
`release_reason: z.string().min(1).max(500).optional(),`.

- [ ] **Step 3: Fast gates, then commit** (`feat(protocol): lane picker schemas  Refs ADR-NNN`).

### Task 1.3: `pickerRows`

**Files:**
- Create: `packages/protocol/src/picker.ts`, `packages/protocol/src/picker.test.ts`
- Modify: `packages/protocol/src/index.ts` (add `export * from './picker.js';`)

**Interfaces, produced** (lanes 3 and 4 consume these exact names):

```ts
export interface PickerRow {
  id: string;            // full lane id
  short: string;         // first 10 chars, as the board prints
  title: string;
  detail: string | null;
  goal_id: string | null;
  areas: string[];
  risk: string[];
  scope: string[];
  age_ms: number;        // now - created_at
  blocked_on: Array<{ lane: string; owner: string | null; detail: string }>; // [] = claimable
  declined: LaneDeclined | null;
}
export interface PickerGroup { goal: string | null; rows: PickerRow[] }
export interface PickerView {
  seat: string;
  claimable: PickerGroup[];
  blocked: PickerGroup[];
  carrying: string[];    // short ids the seat already owns (claimed | active | blocked)
}
export function pickerRows(board: { lanes: Lane[]; warnings: LaneWarning[] }, seat: string, now: number): PickerView;
export function filterPicker(view: PickerView, text: string): PickerView;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import type { Lane, LaneWarning } from './lanes.js';
import { filterPicker, pickerRows } from './picker.js';

const lane = (o: Partial<Lane>): Lane =>
  ({
    id: '01AAAAAAAAAAAAAAAAAAAAAAAA', team: 't', project: 'p', title: 't', detail: null,
    owner_seat: null, role: null, scope: [], areas: [], depends_on: [], branch: null,
    goal_id: null, risk: [], stakes: 'normal', stakes_provenance: 'declared', merged: null,
    state: 'open', created_by: 'nick', created_at: 0, claimed_at: null, resolved_at: null,
    updated_at: 0, ...o,
  }) as Lane;
const unmet = (subject: string, w: string): LaneWarning => ({
  kind: 'unmet_dependency', subject, with: w, owner: 'dolly', detail: `building on "dep" (owner dolly), still active`,
});

describe('pickerRows (ADR NNN)', () => {
  it('keeps only open lanes, groups by goal with goalless last, oldest first in a group', () => {
    const v = pickerRows(
      {
        lanes: [
          lane({ id: '01B0000000000000000000000B', goal_id: 'cloud', created_at: 20 }),
          lane({ id: '01B0000000000000000000000A', goal_id: 'cloud', created_at: 10 }),
          lane({ id: '01C0000000000000000000000C', goal_id: null }),
          lane({ id: '01D0000000000000000000000D', goal_id: 'alpha' }),
          lane({ id: '01E0000000000000000000000E', state: 'claimed', owner_seat: 'x' }),
          lane({ id: '01F0000000000000000000000F', state: 'parked' }),
        ],
        warnings: [],
      },
      'izzo',
      100,
    );
    expect(v.claimable.map((g) => g.goal)).toEqual(['alpha', 'cloud', null]);
    expect(v.claimable[1]!.rows.map((r) => r.short)).toEqual(['01B0000000', '01B0000000']);
    expect(v.claimable[1]!.rows[0]!.id).toBe('01B0000000000000000000000A');
    expect(v.claimable[1]!.rows[0]!.age_ms).toBe(90);
  });

  it('reads blocked ONLY from unmet_dependency warnings — a depends_on the board omits is met', () => {
    const v = pickerRows(
      {
        lanes: [
          lane({ id: '01G000000000000000000000G1', depends_on: ['01OLD00000000000000000000X'] }),
          lane({ id: '01G000000000000000000000G2', depends_on: ['01DEP00000000000000000000Y'] }),
        ],
        warnings: [unmet('01G000000000000000000000G2', '01DEP00000000000000000000Y')],
      },
      'izzo',
      0,
    );
    expect(v.claimable.flatMap((g) => g.rows).map((r) => r.id)).toEqual(['01G000000000000000000000G1']);
    expect(v.blocked[0]!.rows[0]!.blocked_on).toEqual([
      { lane: '01DEP00000000000000000000Y', owner: 'dolly', detail: 'building on "dep" (owner dolly), still active' },
    ]);
  });

  it('lists what the seat is carrying, and carries the decline note', () => {
    const v = pickerRows(
      {
        lanes: [
          lane({ id: '01H000000000000000000000H1', state: 'active', owner_seat: 'izzo' }),
          lane({ id: '01H000000000000000000000H2', declined: { by: 'izzo', reason: 'needs a second machine', at: 5 } }),
        ],
        warnings: [],
      },
      'izzo',
      0,
    );
    expect(v.carrying).toEqual(['01H0000000']);
    expect(v.claimable[0]!.rows[0]!.declined?.reason).toBe('needs a second machine');
  });

  it('filterPicker: every word must match id, title, goal or areas, case-insensitively; empty groups drop', () => {
    const v = pickerRows(
      {
        lanes: [
          lane({ id: '01J000000000000000000000J1', title: 'Cloud duplicate envelope id', goal_id: 'cloud', areas: ['server'] }),
          lane({ id: '01J000000000000000000000J2', title: 'stream ensure stall', goal_id: 'launch' }),
        ],
        warnings: [],
      },
      'izzo',
      0,
    );
    expect(filterPicker(v, 'SERVER dup').claimable.flatMap((g) => g.rows).map((r) => r.id)).toEqual(['01J000000000000000000000J1']);
    expect(filterPicker(v, '01J000000000000000000000J2').claimable.map((g) => g.goal)).toEqual(['launch']);
    expect(filterPicker(v, '   ')).toEqual(v);
  });
});
```

- [ ] **Step 2: Implement** `packages/protocol/src/picker.ts`

```ts
/**
 * ADR NNN — the lane picker's one list. Every front end (terminal, plain table, /live) renders
 * this and nothing else, so what a human sees is the board, never a seat's selection of it.
 * Blocked is read from the board's own `unmet_dependency` warnings: the daemon already decided
 * what "met" means (a dependency the board omits is closed), and this must not decide again.
 */
import type { Lane, LaneDeclined, LaneWarning } from './lanes.js';

// (the interfaces from the Interfaces block above)

const HELD = new Set(['claimed', 'active', 'blocked']);

export function pickerRows(
  board: { lanes: Lane[]; warnings: LaneWarning[] },
  seat: string,
  now: number,
): PickerView {
  const unmet = new Map<string, PickerRow['blocked_on']>();
  for (const w of board.warnings) {
    if (w.kind !== 'unmet_dependency') continue;
    const list = unmet.get(w.subject) ?? [];
    list.push({ lane: w.with, owner: w.owner, detail: w.detail });
    unmet.set(w.subject, list);
  }
  const rows = board.lanes
    .filter((l) => l.state === 'open' && l.owner_seat === null)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
    .map(
      (l): PickerRow => ({
        id: l.id,
        short: l.id.slice(0, 10),
        title: l.title,
        detail: l.detail,
        goal_id: l.goal_id,
        areas: l.areas ?? [],
        risk: l.risk,
        scope: l.scope,
        age_ms: Math.max(0, now - l.created_at),
        blocked_on: unmet.get(l.id) ?? [],
        declined: l.declined ?? null,
      }),
    );
  return {
    seat,
    claimable: group(rows.filter((r) => r.blocked_on.length === 0)),
    blocked: group(rows.filter((r) => r.blocked_on.length > 0)),
    carrying: board.lanes
      .filter((l) => l.owner_seat === seat && HELD.has(l.state))
      .map((l) => l.id.slice(0, 10)),
  };
}

function group(rows: PickerRow[]): PickerGroup[] {
  const by = new Map<string | null, PickerRow[]>();
  for (const r of rows) by.set(r.goal_id, [...(by.get(r.goal_id) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([goal, rs]) => ({ goal, rows: rs }));
}

export function filterPicker(view: PickerView, text: string): PickerView {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return view;
  const hit = (r: PickerRow) => {
    const hay = [r.id, r.title, r.goal_id ?? '', ...r.areas].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const keep = (gs: PickerGroup[]) =>
    gs.map((g) => ({ ...g, rows: g.rows.filter(hit) })).filter((g) => g.rows.length > 0);
  return { ...view, claimable: keep(view.claimable), blocked: keep(view.blocked) };
}
```

- [ ] **Step 3: Fast gates, push, mark the PR ready, arm auto-merge.** After the merge,
  `lane_submit`.

---

## Lane 2: `01M5162MTC`, daemon

**Anchors** (verify at claim time):
- `packages/server/src/store/lanes.ts` `recordLaneEdges` (around line 180): the `lane.claimed` and
  `lane.released` rows.
- `packages/server/src/store/lanes.ts` `updateLane` (around line 560): where `merged` and `parked`
  are persisted.
- `packages/server/src/transport/http.ts` `deliverLaneAct` (around line 1471): a directed act from
  a member.
- `packages/server/src/sync/claim.ts` `decideLanePatch` (around line 327): claim refusals.
- DB: a migration adds `declined_json TEXT NULL` to `lanes`. Follow the latest migration's shape in
  `packages/server/src/db/migrations.ts`, and add it to both drivers.

### Task 2.1: Persist `declined`

- **Test** (`integration.lane-picker.test.ts`, inside `withDrivers`):
  - A seat claims a lane, then PATCHes `{state:'open', owner_seat:null, release_reason:'needs a
    second machine'}`. `GET /lanes/:id` shows `declined` `{by, reason, at}`. The `lane.released`
    row's detail carries `reason`.
  - Then another seat claims the lane: `declined` is null (Review focus 5).
  - `release_reason` on a patch that is not a release is a 400.
- **Implement:**
  - In `updateLane`, add `const declined = patch.release_reason !== undefined && released ? {by:
    audit.actor, reason: patch.release_reason, at: now} : claimed ? null : (existing.declined ??
    null)`, and persist it to `declined_json`.
  - In `recordLaneEdges`, pass `reason` into the `lane.released` detail.
  - In the transport, refuse `release_reason` unless the patch moves the lane to `open`.
  - MCP `lane_release` gains an optional `reason` input. CLI `musterd lane release <id> [--reason
    "<why>"]` gains a flag. Both send `release_reason`.

### Task 2.2: Record `pick`, refuse a forged attestation, raise the notice

_(2026-10-16: the "raise the notice" half is replaced by ADR 626. The daemon only records the pick
and refuses a forged attestation. The pending-pick marker, written by `musterd pick` and shown by
`inbox --interrupt-check`, moves to lane 3, Task 3.4.)_

- **Test:**
  1. A seat claims for itself with `pick: {via:'terminal', requested_by:'nick', attested:false,
     at}`. The `lane.claimed` row detail has `pick` verbatim. The seat's inbox holds one directed
     `message` with `meta.lane_pick.lane === id`, and `GET /inbox?interrupt=1` (or the existing
     interrupt-check route) lists it.
  2. The same claim with `attested:true` is a 400 naming ADR NNN.
  3. A second identical pick by the seat that already owns the lane changes nothing and raises
     no second notice (Review focus 4).
  4. A race: another seat claims first, and the pick gets the existing live-owner refusal.
- **Implement:**
  - In the PATCH handler, after `parseOrBadRequest`: if `body.pick?.attested === true &&
    body.owner_seat === member.name`, throw `bad_request`.
  - Pass `pick` into the audit detail of `lane.claimed` (`recordLaneEdges` gets `pick` through
    `LaneAudit`).
  - After a claim that changed the owner and carries `pick`, call `deliverLaneAct(ctx, team,
    member, member.name, body, {lane_pick: {lane, title, requested_by, via}}, 'steer')`.
    - Use `steer`, because it is interrupt-class without `urgent`
      (`store/interruptCandidates.ts`). If a self-addressed envelope is refused by
      `routeEnvelope`, send it from the daemon's system sender, the way `laneReroute`
      composes acts.
    - Body: `nick picked this lane for you in the lane picker (terminal, unattested): "<title>".
      Reply with a 3–5 line plan, then start unless redirected.`
- Docs: `docs/architecture/03-server.md` (the lanes.ts and http.ts lines).

---

## Lane 3: `01M5162QS1`, CLI `musterd pick`

**Anchors:**
- `packages/cli/src/launcher/picker/tty.ts` `runPicker`. It is typed to the seat picker's
  `PickerState` / `reduce`.
- `packages/cli/src/launcher/fuzzy.ts`.
- `packages/cli/src/render/theme.ts` and `ui.ts`.
- `packages/cli/src/commands/lane.ts`, the `lanes` read and the claim patch.

### Task 3.1: Make the picker shell generic (refactor, no behaviour change)

- Change `runPicker<S, E, O>(initial: S, io, start, reducer: (s: S, e: E | {type:'key', key:
  Key}) => S | {done: O}, render: (s: S, size) => string[], signals?)`. The seat picker passes its
  existing `reduce` and `renderPicker`.
- **Test:** the existing `tty.test.ts` and `state*.test.ts` pass unchanged. Add one test with a
  trivial counter state, to prove the shell is generic.

### Task 3.2: Lane picker reducer (`packages/cli/src/pick/state.ts`)

- State: `{view: PickerView, filter: string, tab: 'claimable' | 'blocked', cursor: number, notice:
  string | null}`.
- Keys:
  - printable keys append to the filter; backspace deletes;
  - `↑`/`↓` move the cursor over rows, skipping group headers;
  - `tab` flips the tab and resets the cursor;
  - `⏎` on a claimable row gives `{done: {pick: row}}`;
  - `⏎` on a blocked row sets `notice` to "blocked on <short> (owner X)";
  - `esc` and `⌃C` quit (exit 130 for `⌃C`).
- **Tests:** table-driven, keys in and state out. Cover every key above, the cursor clamped when
  the filter shrinks the list, and Enter on an empty list doing nothing.

### Task 3.3: Two-pane view (`packages/cli/src/pick/view.ts`)

- `renderLanePicker(state, {cols, rows}): string[]`.
  - At 100 columns or more: list | brief.
  - From 60 to 99 columns: the list, then the brief below it.
  - Below 60 columns: returns `null` (the caller prints the table).
  - The header is `musterd pick — <team> · for <seat>`, plus `carrying <ids>` when non-empty.
  - The brief shows the title, `goal · areas · opened <date>`, the risk line ("acceptance goes to
    a human"), the scope, the detail wrapped, and the decline note.
- Strip control bytes: `s.replace(/[\u0000-\u001f\u007f\u009b]|\u001b\[[0-9;]*[A-Za-z]/g, '')` on
  every lane-sourced string before layout (Review focus 2).
- **Tests:**
  - snapshots at 120, 90, and 50 columns;
  - a brief containing `\u001b[2J` and `\r` renders without either.
- Figma: add the two-pane frame to `docs/design/figma-brief-terminal.md`. The 120-column snapshot
  is its reference.

### Task 3.4: The command (`packages/cli/src/commands/pick.ts`, registered in the CLI dispatcher)

- Flow:
  1. Read `GET /lanes` (unfiltered, for warnings) and build `pickerRows(board, identity.name,
     Date.now())`.
  2. If stdout is not a TTY, or the terminal is under 60 columns, print the table (Task 3.5).
     Then, with `--open`, open `/live?team=<team>&pick=<seat>` (`open` on macOS, `xdg-open` on
     Linux; with no display, print the URL). Exit 0.
  3. Otherwise run the picker. On `{pick: row}`, re-read `GET /lanes/:id`. If it is no longer
     open and unowned, show the notice "taken by <owner> <age> ago", refresh, and keep the
     filter (Review focus 3).
  4. Otherwise PATCH `{owner_seat: identity.name, pick: {via:'terminal', requested_by: <the
     human>, attested:false, harness, at}}`.
- ADR 626: after a successful pick, write `.musterd/pending-pick.json` `{lane, title, requested_by,
  at}` in the workspace. `musterd inbox --interrupt-check` prints it once (the ADR 626 text) and
  deletes it. Test both halves.
- `requested_by`: the team's human admin when there is exactly one, otherwise `--for-human
  <name>`, which is required then. Never invent one. `harness`: `MUSTERD_LAUNCH_SURFACE`, or
  omitted.
- Errors:
  - daemon unreachable: the `musterd status` one-liner, exit 1, no list;
  - service-seat refusal: print the daemon's message.
- **Tests** (in-process daemon, as in `lane.test.ts`):
  - the non-TTY path prints the table and never calls `setRawMode`;
  - the pick PATCH carries `attested:false`;
  - a lane claimed between read and pick gets the "taken by" notice.
- Docs: `docs/architecture/04-cli.md` (file tree lines for `pick/state.ts`, `pick/view.ts`,
  `commands/pick.ts`).

### Task 3.5: Plain table (`packages/cli/src/pick/table.ts`)

- `renderPickTable(view): string[]`. One line per row: `<full id>  <goal>  <areas>  <age>
  <title>`. Claimable first, then a `blocked:` section with `on <short>`. Full ids, so an agent
  can act on them.
- **Test:** a snapshot of a two-group view.

---

## Lane 4: `01M5162T6H`, /live `PickOverlay`

**Anchors:**
- `packages/web/src/live/BoardOverlay.tsx`, `boardOverlayMath.ts` (`ESCAPE_SCOPES`),
  `useBoardData.ts`.
- `boardWrite.ts` (lane writes from /live).

- `PickOverlay.tsx` opens when the URL has `pick=<seat>`. It reads `useBoardData`, builds
  `pickerRows(board, seat, now)`, and renders the two-pane layout (list on the left, brief on the
  right, stacked under 700px) with the same keys.
- **A pick** calls the existing handoff write (`owner_seat: seat`, plus a `handoff_note`), with
  `pick: {via:'live', requested_by: <viewer>, attested: true, at}`. Lane 2's rule accepts
  `attested:true` here, because the actor is the viewer, not the seat. Re-read the lane before
  sending, as in Task 3.4.
- **Not signed in:** the existing sign-in flow runs first, with a return URL carrying
  `pick=<seat>`.
- **Tests:**
  - render tests: groups, the blocked tab, the brief pane, the decline note;
  - a11y sweep entry: keyboard-only pick, a focus trap, and `esc` closes;
  - the handoff payload carries `attested:true` and the viewer's name.
- Docs: `docs/architecture/08-web.md`.

---

## Lane 5: `01M5162W38`, behavior B

- **Skill text:** in `.agents/skills/musterd/SKILL.md`, add a section "When a lane is picked for
  you" covering:
  - recognise `meta.lane_pick` (terminal) or a handoff whose note says "lane picker" (/live);
  - claim the lane if it is not already held;
  - `status_update`;
  - reply to the human with a 3–5 line plan (what you will build; the open decisions and your
    default for each);
  - start unless redirected within the standard-tier window;
  - to decline, `lane_release` with `reason`.

  Run `pnpm skills:check`, and bump the guidance epoch if that check requires it.
- **Handoff note wording** (spec §10), used by lane 4: `<human> picked this lane for you in the
  lane picker: "<title>". Reply with a 3–5 line plan, then start unless redirected.`
- **End-to-end scenario** in `pnpm test:scenarios`:
  1. A human picks a lane through `PATCH … pick{via:'live'}` for an agent seat.
  2. The agent's inbox holds the directed act.
  3. A scripted agent claims it and sends the plan reply.
  4. The lane is claimed by the agent, and its history shows the handoff from the human.

---

## Self-review

- **Spec coverage:**
  - §5.1 → 1.3
  - §5.2 → 3.2–3.4
  - §5.3 → 3.4, 3.5
  - §5.4 → 4
  - §5.5 → 1.2, 2.2, 4
  - §5.6 → 2.2
  - §5.7 → 2.1, 5
  - §6 → Review focus, 2.2, 3.4
  - §7 → each lane's tests
  - §8 → 1.1
  - §10 decline note → 1.2, 2.1 (a board field, not N calls)
  - §10 handoff note → 5
- **Deliberate deviation from the plan template:** lanes 2–5 are specified as files, anchors,
  interfaces, and tests, not as full code listings. They may go to other seats, and their
  anchors drift. Each owner re-reads them at claim time. Lane 1, the one starting now, is
  written in full.
