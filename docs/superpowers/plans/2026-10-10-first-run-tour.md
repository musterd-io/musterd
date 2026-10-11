# First-run tour Implementation Plan

> **Execution:** alfie implements this in its own seat, task by task (AGENTS.md hard rule 8: no
> writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `musterd tour` walks a person through musterd on their own team with their own agent, from
"what this is" to "when to add a seat", advancing on real lane events; the same script feeds the web
tour miley builds.

**Architecture:** One typed script in `content/tour.data.ts`. `pnpm tour:gen` writes a committed copy
into the CLI (`packages/cli/src/tour/script.generated.ts`) and `pnpm tour:check` gates drift. The CLI
tour is a pure step machine (`tour/machine.ts`) fed by a 2-second poll of the team timeline
(`GET /teams/:slug/messages`), plus pure screen renderers (`tour/screens.ts`) and a thin IO command
(`commands/tour.ts`). The web build reads the same `content/tour.data.ts` at build-prep (miley's lane).

**Tech Stack:** TypeScript on Node ≥22, `@clack/prompts` (already a CLI dependency, ADR 005),
Vitest, Node native TypeScript for `scripts/`.

**Spec:** `docs/superpowers/specs/2026-10-10-first-run-tour-design.md`

## Increments

| # | Increment | Lane |
| --- | --- | --- |
| 1 | Script, `tour:gen`, `tour:check` (Tasks 1–2) | `01M4FDBXPX` |
| 2 | `musterd tour` and the init offer (Tasks 3–6) | `01M4FDBXPX` |
| 3 | Web UI-copy spec, handed to miley (Task 7) | `01M4FDBXPX` |
| 4 | The web tour on `/live` and `/board` | `01M4M4DDYF` |

## Global Constraints

- Node ≥22. No new runtime dependency (AGENTS.md hard rule 6).
- Only `@musterd/protocol` is imported across package boundaries; the CLI imports the **generated**
  copy, never `content/`.
- Copy follows brand.md §4: second person, present tense, plain, no hype words, **no contrast frame**
  (no ", not", "not a", "rather than", "instead of").
- Glossary terms exactly (brand.md §5): team, member, seat, lane, act. "Seat" only where durability or
  occupancy is the subject.
- ADR 550 §3: the record step says "opened by", never "asked by".
- Every new CLI screen gets a `cmd/tour` frame in `docs/design/figma-brief-terminal.md`, pinned by a
  test, in the same PR (hard rule 2). Every new `src/` file gets a described line in
  `docs/architecture/04-cli.md`'s file tree (`arch-trees:check`).
- Run only the fast gates locally: `pnpm typecheck && pnpm lint && pnpm format:check`, plus
  `pnpm --filter @musterd/cli test -- tour` while iterating. CI is the authority.

## Facts the design rests on (verified 2026-10-10, read-only)

- A named human acceptor works: `lane_submit` with `acceptor` (CLI `lane submit --to`) routes a
  directed `ask` with `meta.lane_review {lane, route:'named', grade:'human'}` to that member,
  skipping the picker and the low-stakes exemption (`packages/server/src/store/review.ts:780-806`,
  `transport/http.ts:7104-7126`, `protocol/laneReroute.ts:138-167`). Without it, a one-agent team
  self-closes (`review.ts:633-637`, `http.ts:7410-7425`).
- No PR or SHA is needed to submit (`packages/mcp/src/tools/lanes.ts:367-387`).
- `accept`/`decline` with `meta.in_reply_to` = the ask id moves the lane (ADR 202,
  `protocol/route.ts:1344-1459`); `http.send` returns `lane_verdict {lane, state}`.
- An agent's own `lane_claim` emits `message` to `@team` with `meta.lane_claim {lane, title}`
  (`http.ts:7047-7055`). A handoff emits **no** claim event — so the tour opens the lane unowned and
  asks the agent to claim it.
- Team acts skip their sender on the socket (`route.ts:514-519`); the timeline does not:
  `GET /messages` returns every act on the team to any claimed seat (`http.ts:8140-8155`). Hence the
  poll.
- The observed model is on the roster: `presences[0].model` + `model_source`
  (`packages/cli/src/render/rows.ts:379-405`). The close audit stores no model id, so step 6 reads
  the roster.
- Risk: the agent's submit reply tells it it may self-resolve on silence (`mcp/src/tools/lanes.ts:470-472`).
  The request text tells the agent to wait; the machine handles a self-close anyway.

## Review Focus

1. **The agent self-closes before the person judges** — the tour must say so plainly and still show
   the record, never hang on step 5. (Task 3, test `self-close while waiting`.)
2. **Resume after Ctrl-C** — rerunning must pick up the open `[tour]` lane and replay its acts, never
   open a second lane. (Task 5, test `resumes an open tour lane`.)
3. **Acts that are not about this lane** arrive constantly on a real team — only acts naming this
   lane id (and, for declines, replying to this tour's request) may move the tour. (Task 3, test
   `ignores other lanes`.)
4. **The same act seen twice** by overlapping polls must not advance twice. (Task 5, test
   `dedupes overlapping polls`.)
5. **No agent on the roster** — the tour must stop at step 2 with the how-to line and exit 0 on
   Ctrl-C, never throw. (Task 5, test `no agent on the team`.)

---

### Task 1: The tour script

**Files:**
- Create: `content/tour.data.ts`
- Test: `content/tour.data.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TourStepId = 'what' | 'team' | 'give_work' | 'claims' | 'hands_back' | 'judge'
    | 'record' | 'add_seat' | 'next';
  export type TourWait = 'continue' | 'none' | 'lane_opened' | 'lane_claimed' | 'awaiting_you' | 'verdict';
  export interface TourHint { afterMs: number; text: string }
  export interface TourStep { id: TourStepId; title: string; body: string[]; wait: TourWait; hints: TourHint[] }
  export const TOUR_STEPS: readonly TourStep[];
  export const TOUR_LANE_PREFIX = '[tour]';
  export const TOUR_LANE_TITLE: string;      // '[tour] Summarise this repo's README in three lines'
  export const TOUR_REQUEST: string;         // the request_help body sent to the agent
  export const TOUR_MESSAGES: { declined: string; selfClosed: string; noAgent: string; sentBack: string; pickAgent: string };
  export function fill(text: string, vars: Record<string, string>): string;
  ```
  Placeholders: `{you}`, `{agent}`, `{lane}`, `{model}`. `fill` replaces each `{name}` it has a value
  for and leaves unknown ones untouched.

- [ ] **Step 1: Write the failing test**

```ts
// content/tour.data.test.ts
import { describe, expect, it } from 'vitest';
import { fill, TOUR_LANE_PREFIX, TOUR_LANE_TITLE, TOUR_REQUEST, TOUR_STEPS } from './tour.data.ts';

const BANNED = [', not ', 'not a ', 'rather than', 'instead of', "isn't", "it's not",
  'revolutionary', 'magic', 'supercharge', '10x', 'seamless', 'game-changing'];

describe('tour script', () => {
  it('has the nine steps in order', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(
      ['what', 'team', 'give_work', 'claims', 'hands_back', 'judge', 'record', 'add_seat', 'next']);
  });
  it('waits on the event the spec names for each step', () => {
    const waits = Object.fromEntries(TOUR_STEPS.map((s) => [s.id, s.wait]));
    expect(waits).toEqual({ what: 'continue', team: 'none', give_work: 'lane_opened',
      claims: 'lane_claimed', hands_back: 'awaiting_you', judge: 'verdict', record: 'none',
      add_seat: 'continue', next: 'none' });
  });
  it('hints the silent agent at 60s and 3m', () => {
    const claims = TOUR_STEPS.find((s) => s.id === 'claims')!;
    expect(claims.hints.map((h) => h.afterMs)).toEqual([60_000, 180_000]);
  });
  it('carries no contrast frame or hype word', () => {
    const all = [...TOUR_STEPS.flatMap((s) => [s.title, ...s.body, ...s.hints.map((h) => h.text)]),
      TOUR_REQUEST].join('\n').toLowerCase();
    for (const w of BANNED) expect(all, w).not.toContain(w);
  });
  it('says "opened by", never "asked by", on the record step', () => {
    const rec = TOUR_STEPS.find((s) => s.id === 'record')!.body.join('\n');
    expect(rec).toContain('opened by');
    expect(rec.toLowerCase()).not.toContain('asked by');
  });
  it('names the person as acceptor in the request', () => {
    expect(TOUR_REQUEST).toContain("acceptor: '{you}'");
    expect(TOUR_REQUEST).toContain('{lane}');
  });
  it('fill replaces known placeholders and keeps unknown ones', () => {
    expect(fill('{you} and {agent} on {x}', { you: 'nick', agent: 'ada' })).toBe('nick and ada on {x}');
  });
  it('titles the lane with the tour prefix', () => {
    expect(TOUR_LANE_TITLE.startsWith(TOUR_LANE_PREFIX + ' ')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run content/tour.data.test.ts`
Expected: FAIL — cannot resolve `./tour.data.ts`.

- [ ] **Step 3: Write the script**

```ts
// content/tour.data.ts
/**
 * The first-run tour's script — the single source for both tours (spec
 * docs/superpowers/specs/2026-10-10-first-run-tour-design.md). `pnpm tour:gen` copies it into the
 * CLI; the web build reads it at build-prep. Edit here, then regenerate; `tour:check` fails on drift.
 * Copy rules: brand.md §4 (no contrast frame), ADR 550 §3 ("opened by", never "asked by").
 */
export type TourStepId = 'what' | 'team' | 'give_work' | 'claims' | 'hands_back' | 'judge'
  | 'record' | 'add_seat' | 'next';
export type TourWait = 'continue' | 'none' | 'lane_opened' | 'lane_claimed' | 'awaiting_you' | 'verdict';
export interface TourHint { afterMs: number; text: string }
export interface TourStep { id: TourStepId; title: string; body: string[]; wait: TourWait; hints: TourHint[] }

export const TOUR_LANE_PREFIX = '[tour]';
export const TOUR_LANE_TITLE = `${TOUR_LANE_PREFIX} Summarise this repo's README in three lines`;

export const TOUR_REQUEST =
  "{you} is taking the musterd tour, and this is your part. Claim lane {lane} with lane_claim. " +
  "Read this repo's README and write a three-line summary of it into the lane's detail with " +
  "lane_update. Change no files. Then submit it to {you}: lane_submit {id: '{lane}', acceptor: '{you}'}. " +
  "{you} will accept it or send it back. Wait for that verdict, and leave the lane open until it comes.";

export const TOUR_STEPS: readonly TourStep[] = [
  { id: 'what', title: 'What musterd is', wait: 'continue', hints: [], body: [
    'musterd makes your agents accountable.',
    'Your agents and the people you work with join one team as named members. Every piece of work ' +
      'carries its chain: who opened it, who claimed it, which model did it, and who accepted it.',
    'In the next few minutes you give {agent} a small piece of work and judge what comes back.',
  ] },
  { id: 'team', title: 'Your team', wait: 'none', hints: [], body: [
    'This is your roster. You and {agent} are both members, each with a name that stays.',
    '{agent} is running {model}. The harness reports the model; the agent does not choose what it says.',
  ] },
  { id: 'give_work', title: 'Give it work', wait: 'lane_opened', hints: [], body: [
    'Work on musterd is a lane: one claimed unit of work with an owner.',
    'The tour opens one for you, in your name: summarise this repo\'s README in three lines. No files change.',
  ] },
  { id: 'claims', title: 'It claims it', wait: 'lane_claimed', body: [
    'The tour has asked {agent} to claim lane {lane}.',
    'Claiming is how a member says "this one is mine". When two members reach for the same work, the claim shows it first.',
  ], hints: [
    { afterMs: 60_000, text: "Still waiting. Switch to {agent}'s window and say: check your inbox." },
    { afterMs: 180_000, text: '{agent} can take a few minutes to wake. The tour waits as long as it takes. Ctrl-C to stop; `musterd tour` picks up where you left off.' },
  ] },
  { id: 'hands_back', title: 'It hands it back', wait: 'awaiting_you', hints: [
    { afterMs: 180_000, text: "{agent} is still working. Switch to its window if you want to watch." },
  ], body: [
    '{agent} claimed it. It is doing the work now, then it submits the lane to you.',
    'Submitting asks a different member to judge the work. Nobody accepts their own.',
  ] },
  { id: 'judge', title: 'You judge it', wait: 'verdict', hints: [], body: [
    '{agent} says the work is done. Here is what it wrote:',
  ] },
  { id: 'record', title: 'The record', wait: 'none', hints: [], body: [
    'This is the chain the team keeps for lane {lane}:',
    'opened by {you} · claimed by {agent} · model {model} · {verdict}',
    'Every lane on the team carries the same chain, whoever does the work.',
  ] },
  { id: 'add_seat', title: 'When to add a seat', wait: 'continue', hints: [], body: [
    'Add a seat when you want one of these:',
    '  More capacity: a second piece of work, built, researched or brainstormed in parallel.',
    '  A different model: another perspective, or a model you want to try.',
    '  A role the team lacks: a domain or a responsibility nobody holds yet.',
    'One command does it: musterd agent <name>',
    'Ideas we have not tested with a new team yet: a reviewer on a different model, a second tool ' +
      'joining, a teammate bringing their own agent.',
  ] },
  { id: 'next', title: 'Where to go next', wait: 'none', hints: [], body: [
    'musterd board          the team\'s work, in your browser',
    'musterd live           watch the team at work',
    'musterd inbox --watch  stay present and see acts as they arrive',
  ] },
];

export const TOUR_MESSAGES = {
  noAgent: 'No agent on your team yet. Open your agent in this folder, or add one: musterd agent <name>',
  pickAgent: 'Which agent should take the tour lane?',
  declined: '{agent} said no to lane {lane}:',
  selfClosed: '{agent} closed lane {lane} itself before you judged it. The record shows that too.',
  sentBack: 'Sent back to {agent} with your note. It will submit again.',
} as const;

export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run content/tour.data.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add content/tour.data.ts content/tour.data.test.ts
git commit -m "feat(tour): the first-run tour script (lane 01M4FDBXPX)"
```

### Task 2: `tour:gen` and `tour:check`

**Files:**
- Create: `scripts/gen-tour.ts`, `scripts/gen-tour.test.ts`
- Create (generated, committed): `packages/cli/src/tour/script.generated.ts`
- Modify: `package.json` (scripts `tour:gen`, `tour:check`; append `&& pnpm tour:check` to `format:check`)

**Interfaces:**
- Consumes: everything Task 1 exports.
- Produces: `packages/cli/src/tour/script.generated.ts` re-declaring the same exports
  (`TOUR_STEPS`, `TOUR_LANE_PREFIX`, `TOUR_LANE_TITLE`, `TOUR_REQUEST`, `TOUR_MESSAGES`, `fill`, and
  the types) as literal source, with a `// GENERATED by pnpm tour:gen — edit content/tour.data.ts` header.
  `export function renderTourModule(): string` from `scripts/gen-tour.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/gen-tour.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderTourModule } from './gen-tour.ts';

describe('tour:gen', () => {
  it('starts with the generated header', () => {
    expect(renderTourModule().split('\n')[0]).toBe(
      '// GENERATED by pnpm tour:gen from content/tour.data.ts — do not edit; edit the source and regenerate.');
  });
  it('the committed CLI copy matches the source', () => {
    expect(readFileSync('packages/cli/src/tour/script.generated.ts', 'utf8')).toBe(renderTourModule());
  });
});
```

- [ ] **Step 2: Run it to see it fail** — `pnpm vitest run scripts/gen-tour.test.ts` → FAIL (no module).

- [ ] **Step 3: Write the generator**

```ts
// scripts/gen-tour.ts
/*
 * Copy content/tour.data.ts into the CLI as a committed, generated module (the CLI may import only
 * @musterd/protocol across package lines, so it cannot import content/ directly).
 *   pnpm tour:gen    — write packages/cli/src/tour/script.generated.ts
 *   pnpm tour:check  — exit 1 if that file is out of date
 * The web build reads content/tour.data.ts at its own build-prep (lane 01M4M4DDYF).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'content', 'tour.data.ts');
const TARGET = join(root, 'packages', 'cli', 'src', 'tour', 'script.generated.ts');
const HEADER =
  '// GENERATED by pnpm tour:gen from content/tour.data.ts — do not edit; edit the source and regenerate.';

/** The source module verbatim under the header: it imports nothing, so it is valid in the CLI as is. */
export function renderTourModule(): string {
  const src = readFileSync(SOURCE, 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('content/tour.data.ts must stay import-free to be copied');
  return `${HEADER}\n${src}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const next = renderTourModule();
  const check = process.argv.includes('--check');
  let current = '';
  try { current = readFileSync(TARGET, 'utf8'); } catch { /* missing reads as drift */ }
  if (check) {
    if (current !== next) {
      process.stderr.write('tour:check — packages/cli/src/tour/script.generated.ts is stale; run pnpm tour:gen\n');
      process.exit(1);
    }
    process.stdout.write('✓ tour:check — CLI tour script matches content/tour.data.ts\n');
  } else {
    mkdirSync(dirname(TARGET), { recursive: true });
    writeFileSync(TARGET, next);
    process.stdout.write('tour:gen → packages/cli/src/tour/script.generated.ts\n');
  }
}
```

- [ ] **Step 4: Wire the scripts** — in `package.json` add, beside `roadmap:gen`/`roadmap:check`:

```json
"tour:gen": "node --disable-warning=ExperimentalWarning scripts/gen-tour.ts",
"tour:check": "node --disable-warning=ExperimentalWarning scripts/gen-tour.ts --check",
```

and append ` && pnpm tour:check` to the end of `format:check`.

- [ ] **Step 5: Generate, then run the test and the check**

```bash
pnpm tour:gen && pnpm vitest run scripts/gen-tour.test.ts && pnpm tour:check
```
Expected: the file is written, the test passes, `✓ tour:check`. Then edit one word in
`content/tour.data.ts`, run `pnpm tour:check` → exit 1; revert.

- [ ] **Step 6: Add the file-tree line and commit** — in `docs/architecture/04-cli.md` add under `src/`:
`  tour/` `// the first-run tour (spec 2026-10-10-first-run-tour-design)` and
`    script.generated.ts // GENERATED from content/tour.data.ts by pnpm tour:gen — the tour's copy`.

```bash
git add scripts/gen-tour.ts scripts/gen-tour.test.ts packages/cli/src/tour/script.generated.ts package.json docs/architecture/04-cli.md
git commit -m "feat(tour): tour:gen copies the script into the CLI; tour:check gates drift (lane 01M4FDBXPX)"
```

### Task 3: The step machine

**Files:**
- Create: `packages/cli/src/tour/machine.ts`
- Test: `packages/cli/src/tour/machine.test.ts`

**Interfaces:**
- Consumes: `TourStepId` from `./script.generated.js`; `Envelope` from `@musterd/protocol`.
- Produces:
  ```ts
  export type TourOutcome = 'accepted' | 'self_closed' | 'declined';
  export interface TourState {
    step: TourStepId; me: string; agent: string; laneId?: string; requestId?: string; askId?: string;
    outcome?: TourOutcome; declineReason?: string; sentBack: number;
  }
  export type TourEvent =
    | { type: 'continue' }
    | { type: 'lane_opened'; laneId: string; requestId: string }
    | { type: 'act'; env: Envelope }
    | { type: 'verdict'; accept: boolean }
    | { type: 'skip_to_record' };
  export function initialState(me: string, agent: string): TourState;   // step 'what', sentBack 0
  export function advance(s: TourState, e: TourEvent): TourState;       // pure; returns s unchanged when e does not apply
  export function stepAfter(id: TourStepId): TourStepId | null;          // order from the script
  ```
- Rules:
  - `continue` on a `continue`/`none` step → next step. On any other step: unchanged.
  - `lane_opened` on `give_work` → `claims`, with `laneId`, `requestId`.
  - `act` on `claims`: `env.from === agent` and `meta.lane_claim.lane === laneId` → `hands_back`.
    `env.from === agent`, `env.act` is `decline` or `challenge`, `meta.in_reply_to === requestId` →
    stays on `claims` with `outcome:'declined'`, `declineReason: env.body`.
  - `act` on `hands_back`: `env.act === 'ask'`, `env.to` is member `me`, `meta.lane_review.lane === laneId`
    → `judge`, `askId: env.id`. `meta.lane_resolve.lane === laneId` from the agent → `record`,
    `outcome:'self_closed'`.
  - `act` on `judge`: `meta.lane_resolve.lane === laneId` from the agent → `record`, `outcome:'self_closed'`.
  - `verdict` on `judge`: accept → `record`, `outcome:'accepted'`; decline → `hands_back`,
    `askId` cleared, `sentBack + 1`.
  - `skip_to_record` on `claims` with `outcome:'declined'` → `record`.
  - Any act about another lane id, or from anyone but the agent (except the ask to `me`), → unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/tour/machine.test.ts
import { describe, expect, it } from 'vitest';
import type { Envelope } from '@musterd/protocol';
import { advance, initialState, type TourState } from './machine.js';

const env = (p: Partial<Envelope> & { meta?: Record<string, unknown> }): Envelope => ({
  v: 1, id: p.id ?? 'A1', team: 't', from: p.from ?? 'ada', to: p.to ?? { kind: 'team' },
  act: p.act ?? 'message', body: p.body ?? '', thread: null, ts: 1, meta: p.meta ?? null,
} as unknown as Envelope);

const at = (step: TourState['step'], extra: Partial<TourState> = {}): TourState =>
  ({ ...initialState('nick', 'ada'), step, laneId: 'L1', requestId: 'R1', ...extra });

describe('tour machine', () => {
  it('walks the happy path', () => {
    let s = initialState('nick', 'ada');
    s = advance(s, { type: 'continue' });                        expect(s.step).toBe('team');
    s = advance(s, { type: 'continue' });                        expect(s.step).toBe('give_work');
    s = advance(s, { type: 'lane_opened', laneId: 'L1', requestId: 'R1' }); expect(s.step).toBe('claims');
    s = advance(s, { type: 'act', env: env({ meta: { lane_claim: { lane: 'L1', title: 't' } } }) });
    expect(s.step).toBe('hands_back');
    s = advance(s, { type: 'act', env: env({ id: 'Q1', act: 'ask', to: { kind: 'member', name: 'nick' },
      meta: { lane_review: { lane: 'L1' } } }) });
    expect(s).toMatchObject({ step: 'judge', askId: 'Q1' });
    s = advance(s, { type: 'verdict', accept: true });
    expect(s).toMatchObject({ step: 'record', outcome: 'accepted' });
  });
  it('ignores other lanes', () => {
    const s = at('claims');
    expect(advance(s, { type: 'act', env: env({ meta: { lane_claim: { lane: 'L2' } } }) })).toBe(s);
  });
  it('ignores a claim by someone else', () => {
    const s = at('claims');
    expect(advance(s, { type: 'act', env: env({ from: 'bob', meta: { lane_claim: { lane: 'L1' } } }) })).toBe(s);
  });
  it('records a decline that replies to the request', () => {
    const s = advance(at('claims'), { type: 'act', env: env({ act: 'decline', body: 'no README here',
      meta: { in_reply_to: 'R1' } }) });
    expect(s).toMatchObject({ step: 'claims', outcome: 'declined', declineReason: 'no README here' });
    expect(advance(s, { type: 'skip_to_record' }).step).toBe('record');
  });
  it('self-close while waiting', () => {
    for (const step of ['hands_back', 'judge'] as const) {
      const s = advance(at(step), { type: 'act', env: env({ meta: { lane_resolve: { lane: 'L1', state: 'done' } } }) });
      expect(s).toMatchObject({ step: 'record', outcome: 'self_closed' });
    }
  });
  it('sending it back returns to hands_back', () => {
    const s = advance(at('judge', { askId: 'Q1' }), { type: 'verdict', accept: false });
    expect(s).toMatchObject({ step: 'hands_back', sentBack: 1 });
    expect(s.askId).toBeUndefined();
  });
  it('continue does nothing on an event step', () => {
    const s = at('claims');
    expect(advance(s, { type: 'continue' })).toBe(s);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @musterd/cli test -- tour/machine` → FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/tour/machine.ts
import type { Envelope } from '@musterd/protocol';
import { TOUR_STEPS, type TourStepId } from './script.generated.js';

export type TourOutcome = 'accepted' | 'self_closed' | 'declined';
export interface TourState {
  step: TourStepId; me: string; agent: string; laneId?: string; requestId?: string; askId?: string;
  outcome?: TourOutcome; declineReason?: string; sentBack: number;
}
export type TourEvent =
  | { type: 'continue' }
  | { type: 'lane_opened'; laneId: string; requestId: string }
  | { type: 'act'; env: Envelope }
  | { type: 'verdict'; accept: boolean }
  | { type: 'skip_to_record' };

export function initialState(me: string, agent: string): TourState {
  return { step: 'what', me, agent, sentBack: 0 };
}

export function stepAfter(id: TourStepId): TourStepId | null {
  const i = TOUR_STEPS.findIndex((s) => s.id === id);
  return TOUR_STEPS[i + 1]?.id ?? null;
}

const waitOf = (id: TourStepId) => TOUR_STEPS.find((s) => s.id === id)!.wait;
const metaLane = (env: Envelope, key: string): string | undefined => {
  const v = (env.meta as Record<string, unknown> | null | undefined)?.[key];
  return v && typeof v === 'object' ? ((v as { lane?: unknown }).lane as string | undefined) : undefined;
};

export function advance(s: TourState, e: TourEvent): TourState {
  switch (e.type) {
    case 'continue': {
      const w = waitOf(s.step);
      const next = stepAfter(s.step);
      return (w === 'continue' || w === 'none') && next ? { ...s, step: next } : s;
    }
    case 'lane_opened':
      return s.step === 'give_work' ? { ...s, step: 'claims', laneId: e.laneId, requestId: e.requestId } : s;
    case 'skip_to_record':
      return s.step === 'claims' && s.outcome === 'declined' ? { ...s, step: 'record' } : s;
    case 'verdict':
      if (s.step !== 'judge') return s;
      if (e.accept) return { ...s, step: 'record', outcome: 'accepted' };
      { const { askId: _drop, ...rest } = s; return { ...rest, step: 'hands_back', sentBack: s.sentBack + 1 }; }
    case 'act': {
      const env = e.env;
      if (!s.laneId) return s;
      const fromAgent = env.from === s.agent;
      if (s.step === 'claims' && fromAgent) {
        if (metaLane(env, 'lane_claim') === s.laneId) return { ...s, step: 'hands_back' };
        const replyTo = (env.meta as Record<string, unknown> | null | undefined)?.['in_reply_to'];
        if ((env.act === 'decline' || env.act === 'challenge') && replyTo === s.requestId)
          return { ...s, outcome: 'declined', declineReason: env.body };
        return s;
      }
      if ((s.step === 'hands_back' || s.step === 'judge') && fromAgent && metaLane(env, 'lane_resolve') === s.laneId)
        return { ...s, step: 'record', outcome: 'self_closed' };
      if (s.step === 'hands_back' && env.act === 'ask' && env.to.kind === 'member' && env.to.name === s.me
        && metaLane(env, 'lane_review') === s.laneId)
        return { ...s, step: 'judge', askId: env.id };
      return s;
    }
  }
}
```

- [ ] **Step 4: Run to see it pass** — `pnpm --filter @musterd/cli test -- tour/machine` → PASS.

- [ ] **Step 5: File tree + commit** — add `    machine.ts // the tour's pure step machine: (state, event) → state` to 04-cli.md.

```bash
git add packages/cli/src/tour/machine.ts packages/cli/src/tour/machine.test.ts docs/architecture/04-cli.md
git commit -m "feat(tour): the pure step machine, advanced only by acts about the tour's lane (lane 01M4FDBXPX)"
```

### Task 4: The screens and their frames

**Files:**
- Create: `packages/cli/src/tour/screens.ts`
- Test: `packages/cli/src/tour/screens.test.ts`
- Modify: `docs/design/figma-brief-terminal.md` (new `cmd/tour` entries under `## Page: Commands`)

**Interfaces:**
- Consumes: `TOUR_STEPS`, `TOUR_MESSAGES`, `fill` (generated); `TourState` (Task 3).
- Produces:
  ```ts
  export interface TourVars { you: string; agent: string; lane: string; model: string }
  export function stepTitle(id: TourStepId): string;   // 'Step 3 of 9 · Give it work'
  export function stepBody(s: TourState, v: TourVars): string;        // body lines filled, joined by '\n'
  export function verdictLine(s: TourState, you: string): string;     // 'accepted by nick' | 'sent back by nick, then accepted by nick' | 'closed by ada itself' | 'declined by ada'
  export function hintFor(id: TourStepId, elapsedMs: number, v: TourVars): string | null; // latest due hint
  ```
  `stepBody` for `record` substitutes `{verdict}` with `verdictLine`. Model renders `model unattested`
  when absent, matching `rows.ts` `memberFacets`.

- [ ] **Step 1: Write the failing frame tests** (NO_COLOR is set by `vitest.config.ts`, so text is plain)

```ts
// packages/cli/src/tour/screens.test.ts
import { describe, expect, it } from 'vitest';
import { initialState } from './machine.js';
import { hintFor, stepBody, stepTitle, verdictLine } from './screens.js';

const v = { you: 'nick', agent: 'ada', lane: '01M4TOUR01', model: 'claude-opus-5-5' };

describe('cmd/tour frames', () => {
  it('cmd/tour · title', () => {
    expect(stepTitle('give_work')).toBe('Step 3 of 9 · Give it work');
  });
  it('cmd/tour · record (accepted)', () => {
    const s = { ...initialState('nick', 'ada'), step: 'record' as const, laneId: v.lane, outcome: 'accepted' as const };
    expect(stepBody(s, v)).toBe([
      'This is the chain the team keeps for lane 01M4TOUR01:',
      'opened by nick · claimed by ada · model claude-opus-5-5 · accepted by nick',
      'Every lane on the team carries the same chain, whoever does the work.',
    ].join('\n'));
  });
  it('verdict lines', () => {
    const base = { ...initialState('nick', 'ada'), step: 'record' as const };
    expect(verdictLine({ ...base, outcome: 'accepted', sentBack: 1 }, 'nick')).toBe('sent back by nick, then accepted by nick');
    expect(verdictLine({ ...base, outcome: 'self_closed' }, 'nick')).toBe('closed by ada itself');
    expect(verdictLine({ ...base, outcome: 'declined' }, 'nick')).toBe('declined by ada');
  });
  it('hints arrive at 60s and 3m on claims', () => {
    expect(hintFor('claims', 59_000, v)).toBeNull();
    expect(hintFor('claims', 61_000, v)).toBe("Still waiting. Switch to ada's window and say: check your inbox.");
    expect(hintFor('claims', 181_000, v)).toMatch(/^ada can take a few minutes to wake\./);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm --filter @musterd/cli test -- tour/screens` → FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/tour/screens.ts
import type { TourState } from './machine.js';
import { fill, TOUR_STEPS, type TourStepId } from './script.generated.js';

export interface TourVars { you: string; agent: string; lane: string; model: string }

const stepOf = (id: TourStepId) => TOUR_STEPS.find((s) => s.id === id)!;

export function stepTitle(id: TourStepId, index: number): string {
  return `Step ${index + 1} of ${TOUR_STEPS.length} · ${stepOf(id).title}`;
}

export function verdictLine(s: TourState, you: string): string {
  if (s.outcome === 'self_closed') return `closed by ${s.agent} itself`;
  if (s.outcome === 'declined') return `declined by ${s.agent}`;
  const accepted = `accepted by ${you}`;
  return s.sentBack > 0 ? `sent back by ${you}, then ${accepted}` : accepted;
}

export function stepBody(s: TourState, v: TourVars): string {
  const vars = { ...v, model: v.model || 'model unattested', verdict: verdictLine(s, v.you) };
  return stepOf(s.step).body.map((line) => fill(line, vars)).join('\n');
}

export function hintFor(id: TourStepId, elapsedMs: number, v: TourVars): string | null {
  const due = stepOf(id).hints.filter((h) => elapsedMs >= h.afterMs);
  const last = due[due.length - 1];
  return last ? fill(last.text, { ...v }) : null;
}
```

Note: in `stepBody`, when the model is absent, `{model}` must read `model unattested` on the record
line and `{agent} is running model unattested.` would be wrong on the team step — so in Task 5 the
team step passes `model` as the roster's text, and when absent the IO layer drops that second line.
Add the case to the test: `stepBody({...step:'team'}, {...v, model:''})` returns only the first line.
Implement by filtering out lines containing `{model}` when `v.model` is empty, before filling, for
every step except `record`.

- [ ] **Step 4: Run to see it pass.**

- [ ] **Step 5: Add the frames** — in `docs/design/figma-brief-terminal.md` under `## Page: Commands`,
add `cmd/tour` in the existing numbered format: one block per step at 80 columns (the nine titles,
the record line above, both hints), the decline and self-close messages, ending each block with
"pinned by `packages/cli/src/tour/screens.test.ts`". Add `screens.ts // the tour's pure text: titles,
filled bodies, verdict line, due hint` to 04-cli.md.

```bash
git add packages/cli/src/tour/screens.ts packages/cli/src/tour/screens.test.ts docs/design/figma-brief-terminal.md docs/architecture/04-cli.md
git commit -m "feat(tour): the tour's screens, pinned as cmd/tour frames (lane 01M4FDBXPX)"
```

### Task 5: `musterd tour`

**Files:**
- Create: `packages/cli/src/commands/tour.ts`, `packages/cli/src/tour/run.ts`
- Test: `packages/cli/src/tour/run.test.ts`
- Modify: `packages/cli/src/commandTable.ts` (one line), `packages/cli/src/help/catalog.ts` (one entry),
  `docs/architecture/04-cli.md`

**Interfaces:**
- Consumes: Tasks 1–4; `resolve` (`commands/helpers.ts:280`); `http.roster`, `http.openLane`,
  `http.updateLane`, `http.laneBoard`, `http.send`, `http.messages` (`client.ts`); `makeEnvelope`,
  `ulid` as in `commands/send.ts:193-209`.
- Produces:
  ```ts
  // tour/run.ts — all IO behind a port so the loop is testable
  export interface TourPort {
    roster(): Promise<{ name: string; kind: string; model?: string }[]>;
    findOpenTourLane(me: string): Promise<{ id: string; owner?: string; state: string; created_at: number; detail?: string } | null>;
    openLane(title: string): Promise<{ id: string }>;
    abandonLane(id: string): Promise<void>;
    laneDetail(id: string): Promise<string>;
    request(agent: string, body: string): Promise<string>;              // returns the request act id
    verdict(askId: string, accept: boolean, note: string): Promise<void>;
    messagesSince(ts: number): Promise<Envelope[]>;
    now(): number;
    sleep(ms: number): Promise<void>;
  }
  export interface TourUi {
    show(title: string, body: string): void;
    hint(text: string): void;
    pressEnter(): Promise<boolean>;                          // false = cancelled
    pickAgent(names: string[]): Promise<string | null>;
    judge(summary: string): Promise<{ accept: boolean; note: string } | null>;
    afterDecline(reason: string): Promise<'skip' | 'quit'>;
  }
  export async function runTour(port: TourPort, ui: TourUi, me: string, opts: { reset: boolean; pollMs: number }): Promise<number>;
  ```
- Behaviour:
  - Agents = roster members with `kind === 'agent'`. None → `ui.show` the `noAgent` message, exit 0.
    More than one → `ui.pickAgent`. If an open tour lane exists and `reset` is false, its owner (if
    any) is the agent.
  - `reset` → `abandonLane` on any open tour lane, then start fresh.
  - Resume: an open tour lane exists → state `{ step: 'claims', laneId }` and the poll starts from
    `created_at - 5000`, so every act since the lane opened replays through `advance`; no second lane.
  - Fresh: walk `what` and `team` with `pressEnter`, then `openLane(TOUR_LANE_TITLE)` and
    `request(agent, fill(TOUR_REQUEST, {you, lane}))`, then `advance(lane_opened)`.
  - Event steps: loop `messagesSince(cursor)`, dedupe by id in a `Set`, feed each act to `advance`
    in timestamp order; between polls `sleep(pollMs)` and show `hintFor` once per newly due hint.
  - `judge`: `laneDetail` → `ui.judge`; send `verdict(askId, …)`; `advance(verdict)`.
  - Declined on `claims` → `ui.afterDecline(reason)`; `skip` → `advance(skip_to_record)`; `quit` → exit 0.
  - `record`, `add_seat`, `next` → show and end with exit 0.
- `commands/tour.ts` builds the real port from `resolve(parsed.flags)` and the real UI from
  `@clack/prompts` (`p.note`, `p.log.info`, `p.confirm`, `p.select`, `p.text`), with `--reset` from
  flags and `pollMs: 2000`. Cancel (Ctrl-C) anywhere returns 0 and prints
  "Stopped. `musterd tour` picks up where you left off."

- [ ] **Step 1: Write the failing tests** against a fake port and UI

```ts
// packages/cli/src/tour/run.test.ts
import { describe, expect, it } from 'vitest';
import type { Envelope } from '@musterd/protocol';
import { runTour, type TourPort, type TourUi } from './run.js';

function fakes(script: { roster?: { name: string; kind: string; model?: string }[]; acts?: Envelope[];
  openLane?: { id: string; owner?: string; state: string; created_at: number } | null }) {
  const calls: string[] = [];
  let t = 1_000;
  const acts = script.acts ?? [];
  const port: TourPort = {
    roster: async () => script.roster ?? [{ name: 'nick', kind: 'human' }, { name: 'ada', kind: 'agent', model: 'm1' }],
    findOpenTourLane: async () => script.openLane ?? null,
    openLane: async () => { calls.push('openLane'); return { id: 'L1' }; },
    abandonLane: async (id) => void calls.push(`abandon:${id}`),
    laneDetail: async () => 'three lines',
    request: async () => { calls.push('request'); return 'R1'; },
    verdict: async (_id, accept) => void calls.push(`verdict:${accept}`),
    // every poll returns the whole list; the loop must dedupe
    messagesSince: async () => acts,
    now: () => (t += 1_000),
    sleep: async () => undefined,
  };
  const shown: string[] = [];
  const ui: TourUi = {
    show: (title) => void shown.push(title),
    hint: () => undefined,
    pressEnter: async () => true,
    pickAgent: async (names) => names[0] ?? null,
    judge: async () => ({ accept: true, note: '' }),
    afterDecline: async () => 'skip',
  };
  return { port, ui, calls, shown };
}
const claim = { id: 'C1', from: 'ada', to: { kind: 'team' }, act: 'message', ts: 2, meta: { lane_claim: { lane: 'L1' } } } as unknown as Envelope;
const ask = { id: 'Q1', from: 'ada', to: { kind: 'member', name: 'nick' }, act: 'ask', ts: 3, meta: { lane_review: { lane: 'L1' } } } as unknown as Envelope;

describe('runTour', () => {
  it('runs end to end and accepts', async () => {
    const f = fakes({ acts: [claim, ask] });
    expect(await runTour(f.port, f.ui, 'nick', { reset: false, pollMs: 0 })).toBe(0);
    expect(f.calls).toEqual(['openLane', 'request', 'verdict:true']);
    expect(f.shown.at(-1)).toBe('Step 9 of 9 · Where to go next');
  });
  it('dedupes overlapping polls', async () => {
    const f = fakes({ acts: [claim, claim, ask, ask] });
    await runTour(f.port, f.ui, 'nick', { reset: false, pollMs: 0 });
    expect(f.calls.filter((c) => c.startsWith('verdict'))).toHaveLength(1);
  });
  it('resumes an open tour lane', async () => {
    const f = fakes({ acts: [claim, ask], openLane: { id: 'L1', owner: 'ada', state: 'claimed', created_at: 1 } });
    await runTour(f.port, f.ui, 'nick', { reset: false, pollMs: 0 });
    expect(f.calls).not.toContain('openLane');
  });
  it('reset abandons the open lane and starts fresh', async () => {
    const f = fakes({ acts: [claim, ask], openLane: { id: 'L0', state: 'open', created_at: 1 } });
    await runTour(f.port, f.ui, 'nick', { reset: true, pollMs: 0 });
    expect(f.calls.slice(0, 2)).toEqual(['abandon:L0', 'openLane']);
  });
  it('no agent on the team', async () => {
    const f = fakes({ roster: [{ name: 'nick', kind: 'human' }] });
    expect(await runTour(f.port, f.ui, 'nick', { reset: false, pollMs: 0 })).toBe(0);
    expect(f.calls).toEqual([]);
  });
  it('self-close while waiting still ends on the record', async () => {
    const closed = { id: 'X1', from: 'ada', to: { kind: 'team' }, act: 'message', ts: 3,
      meta: { lane_resolve: { lane: 'L1', state: 'done' } } } as unknown as Envelope;
    const f = fakes({ acts: [claim, closed] });
    await runTour(f.port, f.ui, 'nick', { reset: false, pollMs: 0 });
    expect(f.shown).toContain('Step 7 of 9 · The record');
    expect(f.calls).not.toContain('verdict:true');
  });
});
```

- [ ] **Step 2: Run to see them fail** — `pnpm --filter @musterd/cli test -- tour/run` → FAIL.

- [ ] **Step 3: Implement `tour/run.ts`** following the Behaviour list above exactly: a `seen = new Set<string>()`,
a `cursor` starting at `lane.created_at - 5000` (resume) or `port.now() - 5000` (fresh), acts sorted
by `ts` before `advance`, a loop that exits when `state.step` leaves the event steps, and the hint
shown once per newly due `afterMs` (track the last shown `afterMs`). With `pollMs: 0` and a finite
act list the loop must terminate: if a poll yields no new act and the step is unchanged, `sleep` and
poll again — the fake's `now()` advances 1s per call, so in tests put a guard of 10,000 polls that
returns exit 1 with "the tour stopped hearing from the team" (never reached in a real run sooner than
~5.5 hours at 2s).

- [ ] **Step 4: Implement `commands/tour.ts`** — the real port: `findOpenTourLane` reads
`http.laneBoard(team, {})` for a lane whose `title` starts with `TOUR_LANE_PREFIX`, `created_by === me`,
and state not in `done|abandoned`; `abandonLane` = `updateLane(id, {state:'abandoned', abandon_reason:'tour reset'})`;
`laneDetail` reads the same board row's `detail`; `request` sends `makeEnvelope({act:'request_help', to:{kind:'member',name:agent}, …})`
through `http.send` and returns its id; `verdict` sends `accept`/`decline` with `meta:{in_reply_to: askId}`
and the note as body (`'accepted in the tour'` when the note is empty); `messagesSince` = `http.messages(team, {since, limit: 200})`.
Register: `tour: async () => (await import('./commands/tour.js')).tourCommand,` in `COMMANDS`
(alphabetical) and a catalog entry:

```ts
{
  name: 'tour',
  signature: '[--reset]',
  summary: 'a hands-on tour: give your agent a small lane, judge it, read the record',
  group: 'setup',
  primary: true,
  detail: 'Walks you through musterd on your own team: the tour opens one small lane in your name, ' +
    'asks your agent to claim it and submit it to you, and you accept it or send it back. Then it ' +
    'shows the lane\'s record and when to add a seat. Ctrl-C stops; run it again to pick up where you ' +
    'left off. --reset abandons an open tour lane and starts over.',
  examples: ['musterd tour', 'musterd tour --reset'],
},
```

Add `commands/tour.ts` and `tour/run.ts` lines to 04-cli.md.

- [ ] **Step 5: Run the tests, the command-table test, and the fast gates**

```bash
pnpm --filter @musterd/cli test -- tour commandTable
pnpm typecheck && pnpm lint && pnpm format:check
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/tour.ts packages/cli/src/tour/run.ts packages/cli/src/tour/run.test.ts packages/cli/src/commandTable.ts packages/cli/src/help/catalog.ts docs/architecture/04-cli.md
git commit -m "feat(cli): musterd tour — hands-on, advances on the tour lane's real acts, resumable (lane 01M4FDBXPX)"
```

### Task 6: The offer at the end of `musterd init`

**Files:**
- Modify: `packages/cli/src/onboard/init.ts:944-952`
- Test: `packages/cli/src/onboard/init.test.ts` (extend)

- [ ] **Step 1: Failing test** — in the existing init flow test where the agent comes online, stub
`p.confirm` to return `true` for the message `Take the 5-minute tour?` and assert the tour entry was
invoked (inject `runTourAfterInit` through the same seam the test already uses for prompts; read
`init.test.ts` first and follow its mocking style exactly). Second case: `false` → the
"You are mustered" note prints as today.

- [ ] **Step 2: Implement** — only when the agent came online (the success branch at `:932`), before
the note at `:946`:

```ts
const tour = guard(await p.confirm({ message: 'Take the 5-minute tour?', initialValue: true }));
if (tour) {
  p.outro(pc.yellow('Starting the tour.'));
  return (await import('../commands/tour.js')).tourCommand({ ...parsed, positionals: [], flags: {} });
}
```

Match `parsed`'s real shape from `args.ts` (the variable name in `init.ts` may differ). When the agent
did not come online, change nothing: the tour needs a live agent.

- [ ] **Step 3: Tests pass; add an `onboard/init` frame note** to the figma brief's init entry for the
new prompt line; fast gates; commit

```bash
git commit -am "feat(init): offer the tour once the agent is online (lane 01M4FDBXPX)"
```

### Task 7: The web UI-copy spec and the handoff

**Files:**
- Create: `docs/design/tour-web-copy.md`

- [ ] **Step 1:** Write the spec in the product-communications handoff format — a table of
`surface / state / exact string / notes` — for `/live` and `/board`: the entry point ("Take the tour"
for a viewer whose team has a live agent and no completed tour lane), one row per step (title and
body come from `content/tour.data.ts` by step id; list the ids, never paste the copy, so there is one
home), the waiting states with their hint timings, the judge panel (Accept / Send back with a note),
the decline and self-close states, and Ctrl-C's equivalent (a "Stop" link; reopening resumes). Note
the build-time read: the web's build-prep (`packages/web/scripts/gen-site-content.ts`) imports
`content/tour.data.ts` and emits into `src/content/generated/` (gitignored).
- [ ] **Step 2:** Run the five sweeps from the product-communications skill on the new copy; fast gates; commit.
- [ ] **Step 3:** After the CLI PR has merged: update lane `01M4M4DDYF`'s scope to include
`packages/web/scripts/gen-site-content.ts`, then `team_send {act:'handoff', to:'miley', meta:{lane_handoff:{lane:'01M4M4DDYF'}}}`
with the spec path, and `lane_submit` lane `01M4FDBXPX` with `follows_up: ['01M4M4DDYF']`.

## Verification before calling it done

- [ ] `pnpm typecheck && pnpm lint && pnpm format:check` green; CI `gates` green on the PR.
- [ ] Live: nick runs `musterd tour` on a fresh team with one agent. Watch for each of the Review
      Focus items on that run; note any copy that read wrong for the first outside run.
