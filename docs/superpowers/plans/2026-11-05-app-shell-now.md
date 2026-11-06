# App shell phase 1 — the tab pill and the Now screen — Implementation Plan

> **For agentic workers:** implement each increment in your own seat, in its lane: claim it first,
> one branch and one PR per lane. Don't use writing subagents (AGENTS.md hard rule 8). Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening the musterd app shows, on one screen, everything waiting on you and the team as
/live's team column shows it, under a floating three-tab pill; every press and transition moves on
a spring and reads as warm, compact and musterd.

**Architecture:** The daemon's app roster (ADR 791) grows into the team as /live reads it: every
standing member (agents and people), each with /live's card state, label, shown lane, goal, since,
model badge and portrait, plus the viewer's "for you" list. The phone keeps pulling it, now on a
30 s cadence while Now is on screen. The app moves from a Stack to a Tabs layout with its own pill
bar (`CustomTabBar`-style, glass), and the Seats screen's parts fold into one Now screen built from
compact two-line rows. Springs and the sheet run on `react-native-reanimated` off the JS thread.

**Tech Stack:** TypeScript, zod (`@musterd/protocol/app-channel`), the daemon (`packages/server`),
Expo SDK 58 / expo-router Tabs, `react-native-reanimated` + `react-native-worklets`,
`react-native-gesture-handler`, `react-native-svg`, `expo-glass-effect`, `expo-haptics`.

**Spec:** [`docs/superpowers/specs/2026-11-05-app-shell-design.md`](../specs/2026-11-05-app-shell-design.md)
(read it with this plan: its "Look and feel" and "The feel bar" sections are acceptance criteria).
Mockup: [`2026-11-05-app-shell-now-v3.html`](../specs/2026-11-05-app-shell-now-v3.html).

## Increments

| Increment                                                              | Lane                          | Tasks |
| ---------------------------------------------------------------------- | ----------------------------- | ----- |
| 0. Design doc and this plan                                            | `01M6Q46MQZ8W13FC05W4JQ8HAX`  | —     |
| 1. ADR: the app is the team on the phone; the roster is /live's team   | `01M6Q58CFSNEX50G13ECNZ5C4F`  | 1     |
| 2. Protocol: `AppMember`, the roster's `members` and `for_you`         | `01M6Q58GSP66VKS1V08NHYNH42`  | 2     |
| 3. Daemon: fill `members` and `for_you` as /live does                  | `01M6Q58N0T2K2ZT90JC03WJ0Q1`  | 3     |
| 4. Dependency ADR + install: reanimated, worklets, gesture-handler, svg | `01M6Q59ESA60Y0FF8BXC5W9ETW`  | 4     |
| 5. Phone: the tab pill and the Tabs layout                             | `01M6Q58XNEJAXH9XCDBD3HN5GJ`  | 5     |
| 6. Phone: team rows, the Now screen, Seats folded in                   | `01M6Q594CMPHBKYQ6SQ7WM2K4A`  | 6, 7  |
| 7. TestFlight build and nick's feel pass                               | `01M6Q5975E9EKHMTCK2WYEX5Z4`  | 8     |

Order: 1 → 2 → 3, and 4 → 5 in parallel with 2 → 3. 6 needs 3 and 5. 7 needs 6. Increments 2 and 3
are protocol/server work: the ios-engineer charter says the wire is engineer's, so lane 2 and 3 are
opened for hand-off to an engineer seat; cider keeps 1, 4, 5, 6, 7.

## Global Constraints

- The app is **light only, iPhone only, TestFlight only** (ADR 676 decision 11). No simulator builds
  on the laptop (memory `mac-lan-no-simulator-builds`); verify on a TestFlight build from the free
  `ios-testflight` workflow.
- **Every frame the phone reads is parsed through a protocol schema at the boundary** (hard rule 4);
  the app imports only `@musterd/protocol/app-channel` and `/approval`, never the barrel.
- **Protocol shapes change only with an ADR** (hard rule 1); **a new runtime dependency needs an ADR**
  (hard rule 6).
- **One accent:** mustard `#E1AD01`; **one face:** DM Sans; palette from `packages/mobile/src/ui/theme.ts`.
- **States, words, order and dot colours are /live's** (`packages/web/src/live/teamCards.ts`,
  `Live.css`): `working` · `review` ("waiting for review") · `blocked` ("blocked on") · `asking`
  ("asking <to>" / "waiting on <to> · 42m") · `between` ("between tasks") · `away`. Order by that
  list, humans last within a state, then newest `since`, then name. Dots: working green
  (`success`), review mustard (`accent`), blocked red (`danger`), asking amber (`warning`), between
  a hollow amber ring, away none.
- **No cards and no coloured left borders** on the Now screen. Rows are two lines on the warm page,
  separated by a hairline at most.
- **Motion:** springs only, off the JS thread, each within 120–400 ms; Reduce Motion turns each into
  an instant change (`useReduceMotion`, `src/ui/motion.tsx`). **Haptics** say what happened: a
  light tick on tab switch, success on a sent action, warning on a failure; never on scroll.
- The roster stays **pulled, never pushed** (ADR 791 amended 2026-11-03). Max 64 members
  (`APP_ROSTER_MAX`).
- `pnpm typecheck && pnpm lint && pnpm format:check` before every push; CI is the authority.

## Review Focus

1. **A team of 1 agent and the viewer only**, or a roster with every member offline: Now shows the
   viewer's own row under Team and an "N offline" fold of zero is hidden, never a blank screen.
   Test in task 6 (`teamRows` with an empty present set) and task 7 (render).
2. **A member whose portrait fetch fails or arrives late**: the row shows the letter disc, then
   swaps to the portrait without the row jumping. Test in task 6 (`MemberRow` with `portrait: null`
   then a URI; height constant).
3. **The roster arrives while a sheet or the ask screen is open**: rows re-sort under the sheet
   without closing it, and the 30 s poll pauses while the ask screen is focused (its token must not
   be re-issued, `index.tsx`'s `focused` rule). Test in task 7 (`useRosterPoll` stops when
   `focused` is false).
4. **An old daemon that sends a roster without `members`**: the phone shows the `seats` list as
   today's Seats did (online / asleep / offline) and the For you section from its own asks, with no
   crash. Test in task 2 (schema accepts the old shape) and task 6 (`teamRows` from `seats` only).
5. **Tab badge and For you disagree** (the phone has an ask the daemon's `for_you` does not list,
   or the reverse): the badge counts the union by ask id. Test in task 7.

---

### Task 1: ADR — the app is the team on the phone; the roster carries /live's team

**Files:**

- Create: `docs/decisions/NNN-app-is-the-team-on-the-phone.md` (NNN from `pnpm adr:next`; push the
  branch as a draft PR with the one-line stub first, ADR 223)
- Modify: `docs/decisions/676-mobile-app-sealed-ask-client.md` (a dated note in Consequences beside
  line 114's "a team view … stay deferred"; Decision stays frozen)
- Modify: `docs/decisions/791-phone-quick-actions-and-roster.md` (a dated note in Consequences: the
  roster grows into the team; decision 7's `seats` stays for old phones)

**Interfaces:** Produces the decisions task 2 and 3 implement. Decision text, numbered:

1. The app's scope widens: asks, the team, goals, a few settings and a chat with a member. Still
   no office scene, no Android, no App Store.
2. The roster delivery gains `members`: every standing member (agent and human, not observers, not
   service seats), each with /live's card state and what the card shows. `seats` stays as it is.
3. The roster gains `for_you`: everything waiting on the binding's person as /live counts it, so the
   phone's badge and /live agree.
4. The phone pulls the roster on open, on pull-to-refresh, on any delivery, and every 30 s while Now
   is in the foreground. Still never pushed.
5. The app's shell is three tabs: Now, Work, You. Seats folds into Now.

- [ ] **Step 1: Reserve the number and push** — `pnpm adr:next`, create the stub, `git commit -m "reserve ADR NNN"`, push, `gh pr create --draft`.
- [ ] **Step 2: Write the ADR**: Context (the spec, nick's four moments), Problem, the Decision above, Consequences (old phones, roster size, 30 s cadence cost), **Observability & Evaluation** (Traces: `app.roster_pull` count per binding per hour; Eval: n/a until phase 2 nudges; Experiment: n/a). Add the dated notes to 676 and 791.
- [ ] **Step 3: Run** `pnpm format:check`. Expected: PASS (`obs-evals:check`, `adr-numbers:check`, `intents:check` green).
- [ ] **Step 4: Commit** with `Refs ADR-NNN`; mark the PR ready; `gh pr merge --squash --auto --delete-branch`.

### Task 2: Protocol — `AppMember`, `members`, `for_you`

**Files:**

- Modify: `packages/protocol/src/appChannel.ts` (the `roster` delivery, ~:300–325)
- Modify: `packages/protocol/src/appChannel.test.ts` (or `appPoll.test.ts`'s sibling for the roster)
- Modify: `docs/architecture/02-protocol.md` (the app-channel paragraph), `SPEC.md` Appendix A (one line)

**Interfaces:**

- Produces, in `appChannel.ts`:
  - `export const APP_MEMBER_STATES = ['working', 'review', 'blocked', 'asking', 'between', 'away'] as const;`
    `export type AppMemberState = (typeof APP_MEMBER_STATES)[number];`
  - `export const AppMemberSchema = z.object({ name: z.string(), kind: z.enum(['agent', 'human']), state: z.enum(APP_MEMBER_STATES), label: z.string(), title: z.string().nullable(), source: z.enum(['lane', 'status']).nullable(), goal: z.string().nullable(), since: z.number().int().nullable(), more_lanes: z.number().int().nonnegative(), model: z.string().nullable(), online: z.boolean(), wakeable: z.boolean(), lane: z.object({ id: z.string(), title: z.string() }).nullable(), portrait: PortraitDigestSchema.nullable(), waiting: z.object({ to: z.string().nullable(), since: z.number().int() }).optional() })`
    — `label` is /live's `stateLabel` verbatim; `model` is `modelBadge(m).label` ("opus 5.5", "human", "model unknown").
  - `export const AppForYouSchema = z.object({ id: z.string(), from: z.string(), kind: z.enum(['approve', 'question', 'review', 'help']), summary: z.string().max(200), ts: z.number().int() })`
  - On the `roster` delivery: `members: z.array(AppMemberSchema).max(APP_ROSTER_MAX).optional()`, `for_you: z.array(AppForYouSchema).max(32).optional()`. Both optional: an old daemon sends neither; an old phone ignores both.
  - `export type AppMember = z.infer<typeof AppMemberSchema>;` `export type AppForYou = z.infer<typeof AppForYouSchema>;`

- [ ] **Step 1: Write the failing tests**:
  - a roster with 65 `members` is rejected; with 64 accepted.
  - a roster without `members` and `for_you` (today's shape, copied from an existing test fixture) still parses.
  - `AppMemberSchema` rejects `state: 'online'` and a negative `more_lanes`; accepts every value of `APP_MEMBER_STATES`.
  - `AppForYouSchema` rejects a 201-char `summary`.
- [ ] **Step 2: Run** `pnpm --filter @musterd/protocol test -- appChannel`. Expected: FAIL (`AppMemberSchema` not exported).
- [ ] **Step 3: Implement** the schemas and fields above; update the two docs.
- [ ] **Step 4: Run** `pnpm --filter @musterd/protocol test`. Expected: PASS, ≥95% lines.
- [ ] **Step 5: Commit** `feat(protocol): the app roster carries /live's team and for-you (Refs ADR-NNN)`; PR; auto-merge.

### Task 3: Daemon — fill `members` and `for_you`

**Files:**

- Modify: `packages/server/src/notify/appQuickAction.ts` (`buildAppRoster`, :185–236)
- Create: `packages/server/src/notify/appTeam.ts` (the pure fold, so it is testable without a DB)
- Modify: `packages/server/src/notify/appQuickAction.test.ts`; create `appTeam.test.ts`
- Modify: `docs/architecture/03-server.md` (the `appQuickAction.ts` line :178; add an `appTeam.ts` line)

**Interfaces:**

- Consumes: task 2's `AppMember`, `AppForYou`; `summarize(ctx, teamSlug, teamId, viewer)` from
  `transport/http.ts:2873` (the `MemberSummary[]` /live reads), `listLanes`, `openQuestions`,
  `portraitsOf`, and the team's open asks as `/live`'s banner reads them (the store call behind
  `GET /teams/:slug/asks`).
- Produces, in `appTeam.ts`:
  - `export function appMembers(roster: MemberSummary[], lanes: Lane[], goals: readonly { id: string; title: string }[], asks: readonly { from: string; to: string | null; ts: number; loud: boolean }[], waiting: ReadonlyMap<string, { to: string | null; since: number }>, portraits: ReadonlyMap<string, string>, wakeable: ReadonlySet<string>, now: number): AppMember[]`
    — the same fold as `teamCards()` in `packages/web/src/live/teamCards.ts:64–137` (state, label, title, goal name before " — ", since, moreLanes, sort), with `model` from the same rule as `modelBadge` (`packages/web/src/live/modelBadge.ts:58`; copy `displayModel` into the server or move it to protocol — builder's call, no new dependency). Offline members are included with `state: 'away'`, sorted last.
  - `export function appForYou(person: string, asks: readonly AskLike[], questions: readonly QuestionLike[], now: number): AppForYou[]` — open asks addressed to `person` or to the team, and open questions to `person`, oldest first, `summary` = the first 200 chars of the body on one line.
- `buildAppRoster` adds `members` and `for_you` beside `seats`; the binding's person is `for_you`'s `person`.

- [ ] **Step 1: Write the failing tests** in `appTeam.test.ts`, mirroring `teamCards.test.ts`'s cases:
  - an agent with an `awaiting_acceptance` lane → `state: 'review'`, `label: 'waiting for review'`.
  - an agent with an open question to nick → `state: 'asking'`, `label: 'waiting on nick · 42m'` at `now = since + 42 min`.
  - a human with no lane and a status "on stream" → `state: 'between'`, `title: 'on stream'`, `source: 'status'`.
  - an offline agent → `state: 'away'`, after every present member.
  - the sort: working agent, working human, review agent, between human, away agent, in that order from a shuffled input.
  - `model`: a presence with `claude-opus-5-5` → `'opus 5.5'`; a human → `'human'`; none → `'model unknown'`.
  - `appForYou`: two asks, one to the team and one to another person → only the team one; a question to nick → included; oldest first; `summary` cut at 200.
- [ ] **Step 2: Run** `pnpm --filter @musterd/server exec vitest run src/notify/appTeam.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `appTeam.ts`, then wire `buildAppRoster`. Add one test in `appQuickAction.test.ts`: the built roster carries `members` with the binding's human included and `for_you` with an open ask to that human.
- [ ] **Step 4: Run** `MUSTERD_TEST_DRIVER=sqlite pnpm --filter @musterd/server exec vitest run src/notify/appTeam.test.ts src/notify/appQuickAction.test.ts`. Expected: PASS.
- [ ] **Step 5: Update** `03-server.md`; run `pnpm format:check` (arch-trees). Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): the app roster carries /live's team and for-you (Refs ADR-NNN)`; PR; auto-merge.

### Task 4: Dependency ADR and install — reanimated, worklets, gesture-handler, svg

**Files:**

- Create: `docs/decisions/MMM-mobile-motion-dependencies.md` (next number after task 1's; same reserve-first rule)
- Modify: `packages/mobile/package.json`, `pnpm-lock.yaml`, `packages/mobile/babel.config.js` (create if absent: `react-native-worklets/plugin` last in `plugins`), `packages/mobile/app.json` (no plugin needed for these four)
- Modify: `packages/mobile/src/app/_layout.tsx` (wrap in `GestureHandlerRootView`)
- Modify: `tests/dependency-guards.test.ts` (nothing to add: the SDK-floor guard covers them if bundled)
- Modify: `docs/architecture/09-mobile.md` ("How it is built" paragraph: the four packages and why)

**Interfaces:** Produces the four packages at the versions `npx expo install --check` reports for SDK 58 (`react-native-reanimated ~4.x`, `react-native-worklets`, `react-native-gesture-handler ~3.x`, `react-native-svg`), and `GestureHandlerRootView` at the root.

- [ ] **Step 1: Reserve MMM and push the draft PR.**
- [ ] **Step 2: Write the ADR** on the ADR 764 pattern: Decision 1 reanimated + worklets (springs off the JS thread; alternative: RN `Animated`, which cannot drive the sheet's gesture and the pill's spring on the UI thread); 2 gesture-handler (the drag-to-dismiss sheet; alternative: `PanResponder`, JS-thread only); 3 svg (tab icons, the page glow, the capsule gradient; alternatives: `expo-linear-gradient` + phosphor, two packages for what one draws); 4 nothing else: no phosphor, no blur. Observability: `n/a — a build-time dependency; the TestFlight run log's pod list is the trace`.
- [ ] **Step 3: Install** from `packages/mobile`: `npx expo install react-native-reanimated react-native-worklets react-native-gesture-handler react-native-svg`. Then `npx expo install --check`. Expected: "Dependencies are up to date".
- [ ] **Step 4: Wire** the babel plugin and `GestureHandlerRootView`; run `pnpm --filter @musterd/mobile typecheck`. Expected: PASS.
- [ ] **Step 5: Run** `pnpm typecheck && pnpm lint && pnpm format:check` and `npx vitest run tests/dependency-guards.test.ts`. Expected: PASS (the stale-install gate is quiet after the install).
- [ ] **Step 6: Commit** `feat(mobile): reanimated, worklets, gesture-handler and svg for the app shell (Refs ADR-MMM)`; PR; auto-merge. Dispatch one `ios-testflight` run on main after merge and confirm `expo doctor` 20/20 in its log: the native pods are the risk, not the TS.

### Task 5: Phone — the tab pill and the Tabs layout

**Files:**

- Create: `packages/mobile/src/ui/tabBar.tsx`, `packages/mobile/src/ui/tabIcons.tsx`, `packages/mobile/src/ui/springs.ts`, `packages/mobile/src/ui/springs.test.ts`
- Create: `packages/mobile/src/app/(tabs)/_layout.tsx`, `(tabs)/now.tsx` (a placeholder that mounts today's `index.tsx` content), `(tabs)/work.tsx`, `(tabs)/you.tsx` (each a one-line "coming" screen in the app's voice, with `Backdrop`)
- Modify: `packages/mobile/src/app/_layout.tsx` (the Stack gains the `(tabs)` group as its first screen, `headerShown: false` for it; `ask/[ref]`, `pair`, `poll` stay on the Stack above the tabs)
- Delete: `packages/mobile/src/app/index.tsx` (moved to `(tabs)/now.tsx` in this task, rewritten in task 7)
- Modify: `docs/architecture/09-mobile.md` (screens list and `ui/` tree)

**Interfaces:**

- Produces, in `springs.ts` (plain TS, testable):
  - `export const SPRING = { press: { damping: 14, stiffness: 600 }, settle: { damping: 12, stiffness: 280 }, sheet: { damping: 18, stiffness: 220 } } as const;`
  - `export const TAB_BOUNCE = [0.8, 1.15, 1] as const;` (movetrail's sequence)
  - `export function tabTint(tab: 'now' | 'work' | 'you', p: Palette): string` → now `p.accent`, work `'#1a9e88'` (agent jade), you `'#d9557d'` (human rose).
  - `export function pillBottom(insetBottom: number): number` → `Math.max(insetBottom - 16, 2)` (movetrail's rule).
- Produces, in `tabBar.tsx`: `export function TabBar(props: BottomTabBarProps)` — a `Glass` pill (tint `rgba(253,249,241,0.82)`, radius 26, height 52, hairline border `rgba(231,223,216,0.55)`, shadow colour `#6B3D0A` opacity 0.18 radius 22) with one `TabButton` per route; the active one over a mustard SVG gradient capsule (`#FFF6DB → #FBE7A8`, border `rgba(225,173,1,0.35)`, radius 16); a red badge from `options.tabBarBadge`. On press: `tap()` haptic, the `TAB_BOUNCE` sequence on the icon with `SPRING.press` then `SPRING.settle`, label colour timing 200 ms to `p.accentText`. Hides on scroll-down and returns on scroll-up through `useChromeVisible()` (a shared value in a context, `chrome.tsx`, exported `ChromeProvider`, `useChromeVisible`, `onScrollHide(e)`).
- Produces, in `tabIcons.tsx`: `NowIcon`, `WorkIcon`, `YouIcon` as `react-native-svg` components `{ color: string; active: boolean; size?: number }` — the three glyphs from the v3 mockup (a ring with a filled centre; three bars; a head and shoulders), `active` fills the centre.

- [ ] **Step 1: Write the failing tests** in `springs.test.ts`: `pillBottom(34)` → 18, `pillBottom(0)` → 2; `tabTint('now', light)` → `'#E1AD01'`; `TAB_BOUNCE` ends at 1.
- [ ] **Step 2: Run** `npx vitest run packages/mobile/src/ui/springs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `springs.ts`, `tabIcons.tsx`, `chrome.tsx`, `tabBar.tsx`, the `(tabs)` layout and the three screens; move `index.tsx` to `(tabs)/now.tsx` unchanged except the import paths and `NAV_HEIGHT` padding (the Now tab has no NavBar: the wordmark becomes the screen's own header in task 7). A notification tap still routes to `/ask/[ref]` (check `notificationAnswers.ts`'s `router.push` path is unchanged).
- [ ] **Step 4: Run** the test (PASS) and `pnpm --filter @musterd/mobile typecheck && pnpm lint && pnpm format:check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): three tabs under a floating glass pill (lane 01M6Q58XNE)`; PR; auto-merge.

### Task 6: Phone — team rows (pure fold + components)

**Files:**

- Create: `packages/mobile/src/native/team.ts`, `packages/mobile/src/native/team.test.ts`
- Create: `packages/mobile/src/ui/memberRow.tsx`, `packages/mobile/src/ui/stateDot.tsx`, `packages/mobile/src/ui/forYouRow.tsx`, `packages/mobile/src/ui/offlineFold.tsx`
- Modify: `packages/mobile/src/native/quickAction.ts` (`Roster` type gains `members`/`for_you` through the schema; `fetchRoster` unchanged)
- Modify: `packages/mobile/src/native/notice.ts` (`seatActions` takes an `AppMember`-shaped `{online, wakeable, lane}`: unchanged signature, so no edit; confirm)
- Modify: `docs/architecture/09-mobile.md` (`native/` tree: `team.ts`; `ui/` list)

**Interfaces:**

- Consumes: task 2's `AppMember`, `AppForYou`; `Seat` (`ui/seat.tsx`), `fetchPortrait`, `seatActions`, `QuickActions`.
- Produces, in `team.ts`:
  - `export interface TeamRows { present: AppMember[]; offline: AppMember[]; forYou: AppForYou[]; counts: { here: number; offline: number; needYou: number } }`
  - `export function teamRows(roster: Roster | null, ownAsks: readonly { id: string; from: string; ts: number; summary: string }[], viewer: string | null): TeamRows` — `present` = `members` with `state !== 'away'` in the daemon's order; `offline` = the rest sorted wakeable agents, other agents, people (`OfflineSeats.tsx:45`'s `byReach`); `forYou` = the union by `id` of `roster.for_you` and `ownAsks`, oldest first; with no `members` (old daemon) it builds `present`/`offline` from `seats` with `state` = `'working'` when `lane` else `'between'` for online, `'away'` otherwise, `label` by the same table, `model: null`.
  - `export function summaryLine(c: TeamRows['counts']): string` → `"10 here · 20 offline · 2 need you"`, dropping a zero part except "here".
  - `export function sinceLabel(since: number | null, now: number): string | null` — `elapsed()` from `teamCards.ts:141` verbatim ("<1m", "42m", "3h", "2d").
- Produces, in `memberRow.tsx`: `export function MemberRow({ member, pin, now, onPress }: { member: AppMember; pin: PairingPin; now: number; onPress: (m: AppMember) => void })` — 44 pt, `Seat` size 28 with `StateDot`, line 1 name + model (muted 10.5) + `sinceLabel` right; line 2 `label` then ` · ` then `title` (quoted when `source === 'status'`), `+N more` muted; `Squish` press; the portrait fetched as `SeatCard` does today (`seats.tsx:173–190`), fixed height so a late portrait does not reflow.
- Produces, in `stateDot.tsx`: `export function StateDot({ state, size = 9 }: { state: AppMemberState; size?: number })` — the Global Constraints colour table; `between` a hollow ring; `away` renders nothing.
- Produces, in `forYouRow.tsx`: `export function ForYouRow({ item, onPress }: { item: AppForYou; onPress: () => void })` — portrait-less `Seat` letter 26, one-line summary, "from · kind · ago", a mustard `Review`/`Answer` chip (`kind === 'question'` → Answer, else Review).
- Produces, in `offlineFold.tsx`: `export function OfflineFold({ members, open, onToggle, renderRow }: {...})` — the folded row with up to 4 stacked 20 pt faces, "N offline", `Show`/`Hide`; hidden when `members.length === 0`.

- [ ] **Step 1: Write the failing tests** in `team.test.ts`:
  - `teamRows` with `members` of [away agent, working human, working agent] → `present` keeps the daemon's order `[working agent, working human]`, `offline` = `[away agent]`.
  - old-daemon roster (no `members`, two `seats`: online with lane, offline wakeable) → present one `working` row with `model: null`; offline one `away` row; `counts.here === 1`.
  - `forYou` union: `for_you` has ids `a,b`; `ownAsks` has `b,c` → three items by `ts` ascending; `needYou === 3`.
  - `summaryLine({here: 10, offline: 20, needYou: 2})` → `'10 here · 20 offline · 2 need you'`; `({here: 3, offline: 0, needYou: 0})` → `'3 here'`.
  - `sinceLabel(now - 42*60_000, now)` → `'42m'`; `sinceLabel(null, now)` → `null`.
  - offline order: `[person, wakeable agent, agent]` → `[wakeable agent, agent, person]`.
- [ ] **Step 2: Run** `npx vitest run packages/mobile/src/native/team.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `team.ts`, then the four components.
- [ ] **Step 4: Run** the test (PASS), `pnpm --filter @musterd/mobile typecheck && pnpm lint && pnpm format:check` (PASS).
- [ ] **Step 5: Commit** `feat(mobile): team rows in /live's states, the for-you row and the offline fold (lane 01M6Q594CM)`.

### Task 7: Phone — the Now screen; Seats folded in

**Files:**

- Modify: `packages/mobile/src/app/(tabs)/now.tsx` (rewrite: header, For you, Team, offline fold, pull-to-refresh, the 30 s poll)
- Create: `packages/mobile/src/native/useRosterPoll.ts`, `useRosterPoll.test.ts`
- Create: `packages/mobile/src/ui/memberSheet.tsx` (phase-1 version: portrait, name, model, state, the lane line, today's `QuickActions` from `seatActions`; no nudge, no chat — those are phase 2/3)
- Modify: `packages/mobile/src/app/(tabs)/_layout.tsx` (Now's `tabBarBadge` from `counts.needYou`)
- Delete: `packages/mobile/src/app/seats.tsx`; move the poll card into `now.tsx`'s For you top line (`roster.poll`, admin only), its `Start a poll` button moves to `(tabs)/you.tsx`
- Modify: `packages/mobile/src/app/_layout.tsx` (drop the `seats` screen), `docs/architecture/09-mobile.md`, and the asks-screen notice copy in `src/native/notice.ts` if any names "Seats" (`ROSTER_TEXT` stays).

**Interfaces:**

- Consumes: task 6's `teamRows`, `summaryLine`, `MemberRow`, `ForYouRow`, `OfflineFold`, `StateDot`; `loadAsks` (`native/asks.ts:109`), `fetchRoster`, `checkPairing`, `requestRedelivery`, `flushOutbox`, `markShown` as `index.tsx` uses them today.
- Produces, in `useRosterPoll.ts`: `export function useRosterPoll(input: { pin: PairingPin | null; focused: boolean; intervalMs?: number; load: () => Promise<void> }): void` — calls `load` on focus, on every `onDelivery`, and every `intervalMs` (default `30_000`) while `focused` and `AppState` is `active`; stops otherwise. The pure schedule is `export function nextPollDelay(state: { focused: boolean; appActive: boolean; lastAt: number }, now: number, intervalMs: number): number | null` (null = do not poll), tested.
- Produces, in `memberSheet.tsx`: `export function MemberSheet({ member, pin, onClose }: {...})` — a gesture-handler + reanimated sheet (`SPRING.sheet`, drag to dismiss past 120 pt, backdrop fade), `tap()` on open, content per the spec's "A member's sheet" minus nudge and chat.
- The Now screen's layout, top to bottom: `Rise` header (wordmark left, `summaryLine` under it, own portrait right → `/you` tab); `SectionLabel 'For you' count`, `ForYouRow`s (press → `/ask/[ref]`), or one muted line `'Nothing waiting on you'`; `SectionLabel 'Team' '<here> here'`, `MemberRow`s (press → `MemberSheet`); `OfflineFold`. Rows use reanimated's layout animations (`LinearTransition.springify()` with `SPRING.settle`) so a re-sort slides rows rather than redrawing them.

- [ ] **Step 1: Write the failing tests** in `useRosterPoll.test.ts` for `nextPollDelay`: focused + active + lastAt 10 s ago → 20 000; not focused → null; app in background → null; lastAt 40 s ago → 0.
- [ ] **Step 2: Run** `npx vitest run packages/mobile/src/native/useRosterPoll.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `useRosterPoll.ts`, `memberSheet.tsx`, rewrite `now.tsx`, delete `seats.tsx`, move the poll pieces, set the badge.
- [ ] **Step 4: Run** the tests (PASS); `pnpm --filter @musterd/mobile typecheck && pnpm lint && pnpm format:check` (PASS, arch-trees green after the `09-mobile.md` edits).
- [ ] **Step 5: Add the Review Focus tests** that belong here: a `teamRows` render with `present: []` and `offline: []` shows the viewer's own row and no fold (task 6's fold hides on zero); the badge equals `forYou.length` after the union (reuse task 6's union case through `teamRows`).
- [ ] **Step 6: Commit** `feat(mobile): the Now screen — for you, the team as /live shows it, Seats folded in (lane 01M6Q594CM)`; PR; auto-merge.

### Task 8: TestFlight build and nick's feel pass

**Files:** none in the repo beyond a dated line in `docs/architecture/09-mobile.md` ("Shipped on build N, 2026-11-DD").

- [ ] **Step 1: Dispatch** `gh workflow run ios-testflight.yml --ref main` once task 7 has merged; confirm `expo doctor` 20/20 and the pod list carries `RNReanimated`, `RNWorklets`, `RNGestureHandler`, `RNSVG` in the run log.
- [ ] **Step 2: Record** on the phone (nick, or a 20 s screen recording he sends): open the app, switch tabs, pull to refresh, open a member sheet, dismiss it by dragging. This is the spec's "short recorded run of its signature moments".
- [ ] **Step 3: Ask nick** through `team_question` for the feel verdict against the spec's feel bar and anti-goals (too complicated / slop / crowded / not warm). A "change X" answer reopens task 5, 6 or 7 in its lane; a yes closes this lane with `read_verdict`.
- [ ] **Step 4: Submit** lanes 5, 6, 7 for acceptance with the build number and nick's verdict as evidence.
