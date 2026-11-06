# The app comes alive, phase 1 — the live floor, moments, and the live nudge — Implementation Plan

> **For agentic workers:** implement each increment in your own seat, in its lane: claim it first,
> one branch and one PR per lane. Don't use writing subagents (AGENTS.md hard rule 8). Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening the app shows the team at work as a live floor — desks with portraits, a rotating
speech bubble, LIVE — over a feed of moments led by lane landings; a landing glows its desk and
reaches the phone within seconds through a content-free silent push.

**Architecture:** The daemon's app roster (ADR 814) gains `moments`, folded from the day's lanes,
goal outcomes and team messages through the ADR 407 read scope. When a lane reaches `done` or a goal
finishes, `route.ts` (beside `deliverAskToAppChannels`) asks the app adapter to nudge each paired
phone: a new relay frame `app_nudge` that the relay turns into an APNs `background` push with no
content; the app's push subscriber emits the existing `onDelivery` event, and `useRosterPoll` pulls.
The phone draws the floor and the feed from `members` + `moments`, with pure folds deciding desks,
bubbles and which landings are new (glow + haptic).

**Tech Stack:** TypeScript, zod (`@musterd/protocol`), the daemon (`packages/server`), the away
relay (`workers/away-relay`, Cloudflare), Expo / React Native + reanimated + svg (`packages/mobile`),
Swift (`modules/musterd-keys`).

**Spec:** [`docs/superpowers/specs/2026-11-06-app-alive-design.md`](../specs/2026-11-06-app-alive-design.md)
(read with it the shell design's feel bar, which is this plan's acceptance bar).

## Increments

| Increment | Lane | Tasks |
| --- | --- | --- |
| 0. Design and this plan | `01M6SASNA5YECENP5Q5RV35DVE` | — |
| 1. ADR: moments on the roster and the live nudge | `01M6SBV98SDFB9GE7W876GP4G5` | 1 |
| 2. Protocol: `AppMoment`, roster `moments`, relay `app_nudge` | `01M6SBVB6QK30SNZV2RZR9KZ87` | 2 |
| 3. Daemon: the moments fold and the nudge | `01M6SBVD6C0KSYY22Z911B7V13` | 3, 4 |
| 4. Relay: `app_nudge` → APNs background push | `01M6SBVF43KCDVDVGXA5HWKT26` | 5 |
| 5. Phone: receive the silent push; the floor; the moments feed | `01M6SBVPSFB957DAD046E1ZYSJ` | 6, 7 |
| 6. TestFlight build and nick's feel pass | `01M6SBVJ59Z6T39A9JRTHZTJZB` | 8 |

Order: 1 → 2 → (3, 4, 5 in parallel) → 6. The relay deploy (increment 4) is a human step: whoever
holds the relay's wrangler login deploys it after merge, on nick's accept.

## Global Constraints

- Moments are the team's work only: `landed`, `goal`, `verdict`, `started`, `poll`, `said`. Nothing
  else (spec: "Someone joined / went quiet — not shown").
- A landing is a lane reaching `done` — /live's `movedLanes` trigger — credited to `owner_seat`;
  `accepted` is `lane.verified === true` (the close /live gives its flourish).
- Moments and asks go through the timeline's read scope at the binding person's grade
  (`readScopeSql`, ADR 407), as `for_you` does.
- At most `APP_MOMENTS_MAX` = 20 moments, today's only (since local midnight on the daemon), newest
  first.
- The silent push carries **no content**: no lane title, no names. At most one in flight per binding;
  pushes for one binding inside `APP_NUDGE_COALESCE_MS` = 5000 are coalesced into one.
- Reactions are phase 2: no `reactions` field in phase 1.
- The floor shows at most `FLOOR_MAX` = 8 desks (present members, most recently active first) and
  "+N" beyond.
- Motion budget: one bubble change every `BUBBLE_MS` = 4000 at most, one glow at a time, the bell only
  on a goal; Reduce Motion freezes the floor (no bubble rotation, glow as a still highlight).
- Haptics: success on a new landing while Now is in front; heavy impact on a goal; never on scroll.
- No new runtime dependency (reanimated, svg, gesture-handler already in, ADR 815).
- Light only, iPhone only, TestFlight only; builds through `ios-testflight`, which nick starts.

## Review Focus

1. **A burst of merges** (five lanes land inside a minute): one silent push per 5 s per phone, one
   pull, five glows queued one at a time, not five at once. Tests in task 4 (coalesce) and task 7
   (`glowQueue`).
2. **The phone opens after a landing it never saw live**: no glow or haptic for landings older than
   the last pull the screen showed; they are just rows. Test in task 7 (`newLandings` with a prior
   snapshot from before).
3. **A confidential or DM-only lane title** (a lane whose resolve act a team-grade reader can't see):
   no moment for that reader. Test in task 3 (read scope).
4. **An empty floor** (nobody here): a quiet room line, no desks, no LIVE tag. Test in task 7
   (`floorDesks([])`).
5. **Silent push while the app is in the background or the phone is locked**: dropped; no pull, no
   haptic; the next open pulls. Test in task 6 (the Swift hook only emits when the app is active) —
   by `swift-drift.test.ts`'s pattern.

---

### Task 1: ADR — moments on the roster and the live nudge

**Files:** Create `docs/decisions/NNN-app-moments-and-live-nudge.md` (NNN from `pnpm adr:next`;
reserve and push the draft first, ADR 223). Modify `docs/decisions/814-app-is-the-team-on-the-phone.md`
(a dated `_(Amended …)_` marker beside decision 4's "Never pushed", and a Consequences note).

**Interfaces:** Produces the decisions tasks 2–7 implement:
1. The roster gains optional `moments` (the Global Constraints' kinds, cap, window, scope).
2. A new relay frame `app_nudge {binding, push, dedupe_id}`; the relay sends an APNs `background`
   push (`apns-push-type: background`, `apns-priority: 5`, body `{"aps":{"content-available":1}}`),
   no content.
3. The daemon sends it on a routed act with `meta.lane_resolve.state === 'done'` or
   `meta.goal_outcome`, coalesced per binding over 5 s, at most one in flight.
4. The phone acts on it only in the foreground, by pulling the roster. The roster itself stays
   pulled (814 decision 4 amended, not reversed).

- [ ] **Step 1:** reserve NNN, push the stub as a draft PR.
- [ ] **Step 2:** write the ADR (Context: the spec's intent and nick's "I like the snappier
  approach"; Observability: Traces — `app.nudge {binding_id, coalesced}` audit count per hour; Eval
  n/a; Experiment: a landing shows on a foreground phone within 10 s of `done`, measured from the
  audit row to the phone's pull).
- [ ] **Step 3:** `pnpm format:check` → PASS.
- [ ] **Step 4:** commit `Refs ADR-NNN`; ready + auto-merge.

### Task 2: Protocol — `AppMoment`, roster `moments`, relay `app_nudge`

**Files:** Modify `packages/protocol/src/appChannel.ts`, `appChannel.test.ts`,
`packages/protocol/src/relay.ts` (+ its test), `SPEC.md` A.33, `docs/architecture/02-protocol.md`;
a dated note in ADR NNN's Consequences if needed for `change-adr:check`.

**Interfaces — Produces:**
- `export const APP_MOMENT_KINDS = ['landed', 'goal', 'verdict', 'started', 'poll', 'said'] as const;`
- `export const APP_MOMENTS_MAX = 20;`
- `export const AppMomentSchema = z.object({ id: z.string(), kind: z.enum(APP_MOMENT_KINDS), member: z.string(), lane: z.object({ id: z.string(), title: z.string() }).nullable(), goal: z.string().nullable(), text: z.string().max(200).nullable(), accepted: z.boolean().optional(), ts: z.number().int() })`
  — `text` is the one-line body for `verdict`, `poll`, `said`; `accepted` only on `landed`.
- On the roster delivery: `moments: z.array(AppMomentSchema).max(APP_MOMENTS_MAX).optional()`.
- In `relay.ts`: `RelayAppNudgeFrameSchema = z.object({ protocol: version, type: z.literal('app_nudge'), binding: z.string().min(1).max(64), push: RelayAppPushTargetSchema, dedupe_id: z.string().min(1).max(128) })`, added to the daemon→relay frame union.

- [ ] **Step 1: failing tests:** 21 moments rejected, 20 accepted; `kind: 'joined'` rejected; a
  roster without `moments` parses; `app_nudge` with a `sealed` field is rejected (`.strict()`: no
  content may ride it); an `app_nudge` round-trips through the daemon→relay union.
- [ ] **Step 2:** `pnpm --filter @musterd/protocol exec vitest run src/appChannel.test.ts src/relay.test.ts` → FAIL.
- [ ] **Step 3:** implement; docs.
- [ ] **Step 4:** protocol suite → PASS; `change-adr:check` covered.
- [ ] **Step 5:** commit; PR; auto-merge.

### Task 3: Daemon — the moments fold

**Files:** Modify `packages/server/src/notify/appTeam.ts` (+ test), `appQuickAction.ts`
(`appTeamFor`) (+ test), `docs/architecture/03-server.md`.

**Interfaces:**
- Consumes: task 2's `AppMoment`, `APP_MOMENTS_MAX`; `readScopeSql`, `messageVisibilityOf` (as
  `for_you` uses them).
- Produces, in `appTeam.ts`: `export function appMoments(input: { lanes: Lane[]; goals: { id: string; title: string }[]; acts: MomentActLike[]; since: number; now: number }): AppMoment[]` where
  `MomentActLike = { id: string; act: string; from: string; ts: number; body: string; meta: Record<string, unknown> | null; to_kind: string }`.
  Rules: `landed` from lanes with `state === 'done'` and `resolved_at >= since` (member
  `owner_seat`, `accepted: lane.verified === true`); `started` from lanes `claimed_at >= since`;
  `goal` from acts with `meta.goal_outcome`; `verdict` from `accept`/`decline` acts carrying
  `meta.lane_review` (text = the verdict's first line); `poll` from acts with `meta.poll.state ===
  'open'`; `said` from team-addressed `message` acts by a human with no `meta` lane/goal/poll keys.
  Newest first, cut to `APP_MOMENTS_MAX`; goal name before " — " as in `appMembers`.
- `appTeamFor` adds `moments` (only when `ctx.memberSummaries` is set, like `members`), reading the
  day's acts through the viewer's read scope.

- [ ] **Step 1: failing tests** in `appTeam.test.ts`: each kind from one fixture; an accepted vs an
  unconfirmed landing; a lane resolved yesterday excluded; 25 landings cut to 20, newest first; an
  agent's team `message` is not a `said` moment, a human's is. In `appQuickAction.test.ts`: a
  confidential lane-review verdict is not a moment for a team-grade non-party (Review Focus 3).
- [ ] **Step 2:** run both files → FAIL.
- [ ] **Step 3:** implement; wire; doc line.
- [ ] **Step 4:** `pnpm --filter @musterd/server exec vitest run src/notify/appTeam.test.ts src/notify/appQuickAction.test.ts` → PASS.
- [ ] **Step 5:** commit (task 4 follows in the same lane).

### Task 4: Daemon — the live nudge

**Files:** Create `packages/server/src/notify/appNudge.ts` (+ test). Modify
`packages/server/src/protocol/route.ts` (one detached call beside `deliverAskToAppChannels`),
`docs/architecture/03-server.md`.

**Interfaces:**
- Consumes: task 2's `RelayAppNudgeFrameSchema`; the app adapter's binding/relay helpers
  (`relayLinkFor`, the binding list `deliverAskToAppChannels` reads).
- Produces: `export const APP_NUDGE_COALESCE_MS = 5_000;`
  `export function isNudgeMoment(env: Envelope): boolean` — true for `meta.lane_resolve.state === 'done'` or `meta.goal_outcome`;
  `export class NudgeGate { constructor(coalesceMs: number); shouldSend(bindingId: string, now: number): boolean }` — pure, per binding: the first call in a window sends, later ones inside it are coalesced;
  `export async function nudgeAppsOnMoment(ctx: Ctx, team: { id: string; slug: string }, env: Envelope, now?: number): Promise<number>` — returns how many bindings were nudged; audits `app.nudge {binding_id, coalesced}`; never throws.

- [ ] **Step 1: failing tests:** `isNudgeMoment` for a done resolve (true), an `abandoned` resolve
  (false), a goal outcome (true), a plain message (false); `NudgeGate`: five calls in 4 s → one send,
  a call at 6 s → a second send, two bindings independent (Review Focus 1).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement; add `void nudgeAppsOnMoment(ctx, team, firehoseEnv)` in `route.ts`.
- [ ] **Step 4:** run `appNudge.test.ts` + the existing route tests that touch app delivery → PASS.
- [ ] **Step 5:** commit; PR (tasks 3–4); auto-merge.

### Task 5: Relay — `app_nudge` → APNs background push

**Files:** Modify `workers/away-relay/src/apns.ts` (+ test), the relay's frame handler (where
`app_deliver` is handled) (+ test), `docs/architecture/` relay section.

**Interfaces:** Produces `export async function sendApnsBackground(config: ApnsConfig, push: { token: string; environment: 'production' | 'development' }, nowMs: number, fetchImpl?: typeof fetch): Promise<ApnsResult>` with headers `apns-push-type: background`, `apns-priority: 5`, `apns-expiration` = now + 60 s, body exactly `{"aps":{"content-available":1}}`.

- [ ] **Step 1: failing tests:** the request's headers and body are exactly the above (no alert, no
  musterd payload); an `app_nudge` frame reaches `sendApnsBackground` once per `dedupe_id`.
- [ ] **Step 2:** `npx vitest run workers/away-relay` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** commit; PR; auto-merge. **Then ask nick** (`team_question`) to deploy the relay
  (or name who holds the wrangler login): the daemon's nudges are dropped by an old relay until then,
  which is safe (the 30 s pull still runs).

### Task 6: Phone — receive the silent push

**Files:** Modify `packages/mobile/modules/musterd-keys/ios/MusterdPushSubscriber.swift`,
`packages/mobile/plugins/withMusterdKeys.js` (add `remote-notification` to `UIBackgroundModes`),
`packages/mobile/src/native/swift-drift.test.ts`, `docs/architecture/09-mobile.md`.

**Interfaces:** Produces the Swift AppDelegate hook
`application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`: when
`UIApplication.shared.applicationState == .active`, emit `onDelivery` (the event `useRosterPoll`
already pulls on); always call the completion handler with `.noData`. No change on the TS side.

- [ ] **Step 1: failing test** in `swift-drift.test.ts` (it reads the Swift source): the subscriber
  defines `didReceiveRemoteNotification`, guards on `.active` before `sendEvent("onDelivery")`, and
  calls `completionHandler(.noData)`; the config plugin adds `remote-notification` (Review Focus 5).
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS; `pnpm --filter @musterd/mobile typecheck`.
- [ ] **Step 5:** commit (task 7 follows in the same lane).

### Task 7: Phone — the floor and the moments feed

**Files:** Create `packages/mobile/src/native/floor.ts` (+ `floor.test.ts`),
`packages/mobile/src/ui/floor.tsx`, `packages/mobile/src/ui/momentRow.tsx`. Modify
`packages/mobile/src/native/team.ts` (`TeamRows` gains `moments`), `packages/mobile/src/app/(tabs)/index.tsx`,
`packages/mobile/src/ui/springs.ts` (+ test), `docs/architecture/09-mobile.md`.

**Interfaces:**
- Consumes: task 2's `AppMoment`; `AppMember`, `teamRows`, `usePortrait`, `StateDot`, `SPRING`,
  `GLIDE`.
- Produces, in `floor.ts`:
  - `export const FLOOR_MAX = 8; export const BUBBLE_MS = 4_000;`
  - `export function floorDesks(present: AppMember[]): { desks: AppMember[]; more: number }` — the 8 most recently active (`since` newest first, then the roster order), `more` = the rest.
  - `export function bubbleText(m: AppMember, viewer: string | null): { text: string; mine: boolean } | null` — `asking <viewer>` → "asking you →" with `mine: true`; working → the title cut to 28 chars; review → "waiting for review"; blocked → "blocked"; between/away → null.
  - `export function newLandings(prev: readonly AppMoment[] | null, next: readonly AppMoment[]): AppMoment[]` — `landed`/`goal` moments in `next` not in `prev`; empty when `prev` is null (first load: no celebration for what you weren't there for).
  - `export function glowQueue(landings: AppMoment[]): string[]` — member names in order, one per landing, deduped consecutively.
- In `springs.ts`: `export const GLOW_MS = 1_200;` (one glow's life).
- `floor.tsx`: `Floor({ desks, more, live, bubble, glowing, onPressMember })` — warm floor (`#f0c188`→`#dca35f` gradient via svg), desks laid out in two rows, a bubble over its member, the glowing desk's ring brightening for `GLOW_MS`; Reduce Motion → no rotation, still highlight.
- `momentRow.tsx`: `MomentRow({ moment, pin, onPress })` — landings and goals full (portrait, "landed <title>", goal, age, ✓ accepted mark); others one line.
- Now: header gets the LIVE tag when any present member is `working`; the floor under it; "Happening now" with `MomentRow`s between For you and Team; on each roster change, `newLandings` → `success()` haptic and the glow queue; a `goal` → heavy impact and the bell glyph over the floor.

- [ ] **Step 1: failing tests** in `floor.test.ts`: `floorDesks` with 11 present → 8 desks + `more: 3`, newest first; `floorDesks([])` → no desks (Review Focus 4); `bubbleText` for each state, "asking you →" only when the asker's `waiting.to`/label names the viewer; `newLandings(null, next)` → `[]`, and with a prior snapshot → only the new ones (Review Focus 2); `glowQueue` of five landings by three members → five entries in order (Review Focus 1). In `springs.test.ts`: `GLOW_MS` within 120–1500, `BUBBLE_MS` ≥ 3000.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** implement `floor.ts`, then `floor.tsx`, `momentRow.tsx`, the Now changes.
- [ ] **Step 4:** `npx vitest run packages/mobile` → PASS; typecheck, lint, format.
- [ ] **Step 5:** commit; PR (tasks 6–7); auto-merge.

### Task 8: TestFlight and nick's feel pass

- [ ] **Step 1:** ask nick to start `ios-testflight` on main after increments 3 and 5 land (and the
  relay is deployed); confirm doctor 20/20 and the upload.
- [ ] **Step 2:** `team_question` to nick: open the app, watch the floor; have a seat land a lane
  while Now is open (or wait for one) — does it glow within seconds, and does the floor feel the way
  he described? A "change X" reopens task 7.
- [ ] **Step 3:** submit increments 3–5 with the build number and his verdict.
