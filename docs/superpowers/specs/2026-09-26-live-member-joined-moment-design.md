# The "joined the team" moment — the Welcome Wagon

**Date:** 2026-09-26 · **Author:** miley, designed with nick (brainstorm, same day)
**Status:** spec for review — implementation follows the order in §8
**Lane:** 01M3F81DD9 (goal launch) · branch `feat/live-member-joined-moment`

## 1. The problem

A Member being added to the team is invisible on `/live`.

- Creating a Member emits no frame. `addMember` in the member-add route
  (`packages/server/src/transport/http.ts`, the `hue_shared_with` call site) and the seat-file
  projection (`packages/server/src/projection/reconcile.ts`) never broadcast. Removal does — it
  broadcasts `presence: offline` — so the room hears people leave but not people arrive.
- `/live` refetches the roster only on a `presence` frame (`packages/web/src/live/useLiveStream.ts`).
  A new Member therefore appears silently on the next *unrelated* presence change or a reload.
- Their first time online is the same door walk-in every reconnect gets. Nothing says *new*.

The demo goal makes this the hook, not a nicety: an audience joins a live team from their phones
as guests, 20–50 people inside a minute, and the room they are watching should visibly welcome
them.

**Owner bar (nick, 2026-09-26):** extremely magical, fun, quirky, delightful, smooth, intuitive.

**Falsifiers.**
1. With `/live` open, `musterd member add ada` makes Act 1 start within 2 s, with no reload.
2. Ada's first connect plays Act 2; her second connect plays the ordinary walk-in.
3. Opening `/live` on a team never plays any welcome on first load.
4. 30 simulated guests inside 60 s produce at most one doorbell, one confetti burst and one caption
   per 2 s wave, and the scene stays inside the ADR 151 perf budget.
5. With `prefers-reduced-motion: reduce`, no walk, wagon or confetti plays; the end state appears
   and the caption line is written.

## 2. The direction: the office welcomes them

Chosen from three directions (Welcome Wagon, Materialize, Surprise Party) because it spends the
room's existing residents — receptionist, dog, teammates, wallboard, door — instead of layering an
effect on top. The welcome comes *from the office*. Two acts:

- **Act 1 — created.** The room makes space for them.
- **Act 2 — first time online.** The room welcomes them in.

For a demo guest, creation and first connect land within a second; the two acts run as one
sequence (§3.3).

Kept from the brainstorm's quirk list: **the dog pulls the welcome wagon**, and **the wallboard's
flip counter during a crowd**. Dropped: the gift bow on the waiting desk, agents arriving in a
delivery crate, and the lanyard staying on for the day.

## 3. Storyboard

Times are seconds from the trigger. `{name}` is the Member's name; "their hue" is the Member's
`hue` (the same colour the roster and nameplates already use).

### 3.1 Act 1 — created (~4 s)

| t   | Beat                                                                                                                                                                                                                                                         | Sound                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| 0.0 | The receptionist's phone rings; she picks up (her existing `call` pose). Bubble: `oh! someone new: {name}`.                                                                                                                                                  | two-tone ring          |
| 0.9 | Her label maker goes *ka-chunk*: a nameplate strip in their hue prints and curls off the counter.                                                                                                                                                            | ratchet click ×3       |
| 1.4 | **The dog is the welcome wagon.** It wakes, trots to reception, takes the handle of a small red wagon (nameplate, a monitor box, a potted plant) and pulls it to their desk on the real nav grid.                                                           | small wheel rattle     |
| 3.6 | The nameplate snaps into the desk's holder with a brief glow in their hue. The dog flops down beside the desk. The desk is now an ordinary owned, empty desk (presence-honesty §4). The dog runs this errand at an eager trot (130 u/s) — the delivery lands when it lands, not on this beat. | —                      |
| 4.0 | Caption line: `{name} was added to the team · by {sponsor}` (the `· by` clause only when `sponsored_by` is set).                                                                                                                                              | —                      |

**No free desk.** The 12 desk slots are usually full on a large team (revive has 25 Members;
offline owners keep their desks). Then the dog carries the printed nameplate in its mouth to the
wallboard, where it is pinned as a polaroid in their hue in a small *new arrivals* corner. The
corner is derived from the roster, not remembered: it shows Members created in the last 24 h
(`created_at`) who hold no desk, at most 3, newest first. So it survives a reload as a still, and
a polaroid leaves when its Member gets a desk or ages out.

### 3.2 Act 2 — first time online (~6.5 s)

| t   | Beat                                                                                                                                                                                                        | Sound                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 0.0 | The door glows in their hue — the existing door pulse, warmer and held longer.                                                                                                                              | ding-dong             |
| 0.3 | **Human:** walks in carrying a cardboard box with a plant poking out (a new `CarryKind`). **Agent:** walks in empty-handed; a small status light blinks twice above their head, like booting up.         | —                     |
| 1.6 | They stop at a check-in mark (the existing reception routing). The receptionist looks up (`greeting`) and tosses a lanyard in their hue; it arcs over and settles around their neck. Bubble: `welcome, {name}!` | soft whoosh + clip    |
| 2.6 | On the walk to the desk, **the three nearest online teammates** swivel toward them and wave; the nearest one says `👋`. The dog gets up and trots alongside.                                                | —                     |
| 5.2 | They sit. A small confetti puff — the office's 18-piece burst, in their hue alternated with mustard — settles and fades. The lanyard is gone once they are seated — it is a prop of the moment, not a lasting mark.                                    | pop + sparkle         |
| 6.0 | Their monitor lights with `hello` for a second (a name does not fit a monitor at office scale), then the normal work glow.                                                                              | —                     |
| 6.2 | Caption line: `{name} joined the team — welcome`.                                                                                                                                                           | —                     |

The receptionist never leaves her desk (her module's own rule); the toss is how she reaches them.
Only teammates who are **online and not mid-choreography** may wave — a real act always wins.

### 3.3 Act 1 + Act 2 together (demo guest)

When a Member is created and online inside the same wave, the sequence is Act 2 with Act 1
folded in: the phone rings and the label prints as the door opens, and the dog delivers the
wagon to the desk while the guest walks there, arriving just before them. One caption:
`{name} joined the team — welcome`.

### 3.4 The crowd (20–50 guests)

- **Waves.** Arrivals within 2 s of each other form one wave, settled to one record per name (a
  `member add` and a connect a second later arrive as two refetches and play as the one folded
  moment of §3.3), without anyone who left before it started.
- **No queue** (amended 2026-09-26 while building). Guests check in at the three marks in parallel;
  anyone past the last mark walks straight in — the reception design's own rule (`layout.ts`
  `CHECK_IN_MARKS`: ceremony that queues is the gate it rejected). The conveyor toss reaches them as
  they pass the counter.
- **Conveyor mode.** The receptionist tosses one lanyard every 0.6 s with a short `welcome!`
  bubble instead of the full greeting.
- **Once per wave:** one confetti burst, one caption — and one doorbell per roster update, rung as
  the guests walk through the door (amended 2026-09-26: the bell used to wait for the wave's script,
  two seconds after the walk-in):
  `{n} people joined — welcome` (all human) or `{n} members joined — welcome` (mixed); a single-Member wave uses the §3.2 line. Never "guests" — attendees are Members like anyone else (sloane's copy read, 2026-09-26).
- **Flip counter.** While a crowd is arriving, a flip counter on the wallboard ticks up per
  lanyard: `12 → 13 → 14`, labelled `joined`. It stays for 60 s after the last arrival, then folds away.
- **Past 12 desks** guests stand in the gallery by the door (the existing overflow strip).
- **The dog** does one lap of the room per crowd, not one wagon run per guest. Wagon deliveries
  happen only for Members who get a desk, at most one wagon trip in flight at a time.
- **Backlog cap.** At most 6 full solo sequences queue; beyond that, pending arrivals merge into
  the next wave.

## 4. Detection

### 4.1 Server signal (no protocol change)

Every Member-creation path that can reach the hub broadcasts the existing frame
`{ type: 'presence', member, status: 'offline' }` for the new name, through one helper
(`broadcastMemberAdded`). Any presence frame already makes `/live` refetch the roster, so the new
Member arrives in the viewer's roster within the refetch coalesce window (~1 s).

- **Paths:** the member-add route; the invite-redeem path (fifty, #1717) and the agent-connect
  path (ADR 452, stanley) are coordinated with their owners rather than edited here — those
  Members go online immediately and the existing `online` broadcast already refetches.
- **`reconcile.ts`:** wired only if the projection has the hub in reach; otherwise the next
  presence change covers it.
- **Side effect, accepted:** `musterd inbox --watch` prints `· {name} offline` for a new Member.
  That is true, and arguably a useful notice.
- **Not chosen:** a dedicated `member_added` frame. Cleaner in name, but it is a protocol schema
  change (hard rule 1, ADR required), and `/live` does not need it: roster diffing already
  distinguishes a new name.

### 4.2 Client detection (`packages/web/src/live/office-scene/arrivals.ts`, pure)

Given the previous and next roster:

- **`created`** — a name in `next` that was not in `previous`. The first roster load of the page
  never counts (no welcome stampede).
- **`firstOnline`** — a Member present in both, going from not-online to online, whose previous
  entry was offline with `offline_reason: 'unknown'` (the server's never-connected value) — AND whom
  this viewer has not seen online since the page loaded, AND who was created in the last 24 h (or is
  of unknown age). Amended 2026-09-26: `unknown` is also what a lapsed *ambient* presence reads (a
  Member present only through CLI/HTTP calls, ADR 057); end to end on a throwaway daemon, a human
  active a minute earlier was welcomed as "joined the team" on their next command.
- **Excluded:** `kind: 'service'` (ledger seats are not arrivals).
- **Waves:** events within 2 s group into one wave; a wave carries its events in arrival order.

**Honest limits.**
- Only a live viewer sees the moment. Nothing is persisted and a reload does not replay it.
- A Member created more than 24 h before their first connect gets the ordinary walk-in, not Act 2
  (so the pre-ADR-141 `unknown` rows on revive — `delta`, `nativeprobe` — are no longer welcomed).
  Accepted: the window is what separates a first arrival from a lapsed CLI presence.

## 5. Components

| Unit                                            | Job                                                                                                                         | Depends on                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `server` · `broadcastMemberAdded`               | One helper; every creation path with a hub calls it.                                                                        | hub                                |
| `web/live/arrivals.ts`                          | Roster diff → `created` / `firstOnline` events, first-load suppression, service exclusion, 2 s waves. Pure.                 | `MemberSummary`                    |
| `web/live/office-scene/welcomeWagon.ts`         | The beat sequencer (§3): a plain state object stepped by the scene loop, the shape `pet.ts` and `receptionist.ts` use. Owns timing, the backlog cap and conveyor mode. Emits what each resident should do this frame. | `arrivals.ts` events              |
| `pet.ts` — new `wagon` mode                     | fetch the wagon → pull it along a nav path → deliver → flop. Gait from distance travelled (the existing no-skate rule).     | `nav.ts`                           |
| `receptionist.ts` — new beats                   | `ring` (reuses `call`), `label`, `toss`, and conveyor tossing.                                                              | —                                  |
| `actors.ts` — wave hook                         | Up to three nearest idle online members swivel and wave; never interrupts a real act.                                        | existing walk engine               |
| `render.ts` painters                            | wagon, label strip, lanyard, box-with-plant carry, confetti, boot light, wallboard polaroids, flip counter, hello screen.   | `sprite-cache.ts`                  |
| `captions.ts`                                   | The arrival lines, one per wave.                                                                                             | —                                  |
| `sound.ts`                                      | Synthesized ring, ratchet, rattle, ding-dong, whoosh, pop; honours the existing mute; one doorbell per wave.                | —                                  |

Copy on public surfaces (the bubbles and captions in §3) goes to sloane for a brand-voice read,
as `welcome.ts` already requires.

## 6. Guardrails

- **Reduced motion.** No walk, wagon, toss or confetti. The end state appears (nameplate on the
  desk or polaroid on the wall) and the caption line is written.
- **`/broadcast`** plays the moment — it is the demo stream.
- **Still mode** holds the final frame.
- **Perf (ADR 151).** Confetti capped at 24 pieces per wave; no per-frame allocation in the
  sequencer or painters; the sequencer asks for animation frames only while a sequence is playing,
  so an idle office stays at rAF 0/s (ADR 086).
- **Priority.** A pending welcome waits to *start* while a real act's walk plays (never the
  newcomer's own walk-in); once started it finishes (the receptionist welcome's rule — stopping
  mid-thought reads worse than talking over a walk). The wait is capped at 4 s past the wave window
  (amended 2026-09-26: on a room as chatty as revive there is always an act walk in flight, and the
  uncapped rule meant the welcome never played — found on the office-preview harness).
- **Contrast gate.** Bubble and caption text use the existing tokens.

## 7. Testing

- **Unit:** `arrivals.ts` (diffing, first-load suppression, service exclusion, `unknown` gating,
  wave grouping); `welcomeWagon.ts` (beat timing, fold of Act 1 into Act 2, backlog cap, conveyor
  mode, reduced-motion end state); the pet `wagon` mode; the receptionist beats.
- **Scene loop:** idle office stays at rAF 0/s before and after a sequence; real acts preempt the
  start.
- **Server:** an observer connection receives `presence: offline` for a member added through the
  route.
- **Dev harness:** `?simulate=arrivals` (dev builds only) drives one solo human, one solo agent and
  a 30-guest crowd on `:5174`, so the moment can be judged before merge.
- **End to end:** a throwaway daemon, `/live` open, `musterd member add ada`, then connect as ada —
  falsifiers 1 and 2 by eye, recorded as a short capture on the PR.
- **Perf:** the existing `/live` perf baseline run with a 30-guest simulation.

## 8. Order

1. Server helper + route wiring + test (small, lands first; `/live` begins refetching on creation).
2. `arrivals.ts` + tests.
3. `welcomeWagon.ts` sequencer + tests, with placeholder painters.
4. Residents: receptionist beats, pet `wagon` mode, wave hook.
5. Painters, sound, captions — the look and feel pass, judged on the dev harness.
6. Crowd: conveyor mode, flip counter, backlog cap; perf baseline.
7. Docs: `docs/architecture` file trees (drift-checked) and the server doc's broadcast note.
