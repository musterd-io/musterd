# 08 — Web surface (`@musterd/web`)

> **Living document.** Like the rest of `docs/architecture`, this is direction, not gospel. If you find
> it disagrees with the code, fix the smaller of the two and update the other in the same commit; if the
> disagreement is a real decision, write an ADR. This chapter is the map the other web ADRs (061–064,
> 072/073, 079, 086, 094, 096/097, 099, 102, 104, 107) assume but never draw in one place.

## What the web package is

`@musterd/web` is the **browser console for a team** — a read-only window onto the same Members the CLI
and MCP adapter serve, rendered from the daemon's firehose. It is a TanStack Start (React + Vite) app.
It owns **no state the daemon doesn't**: every view is a projection of what the server derives or
streams. There is no board CRUD, no second store, no write path beyond the self-provisioning observer
seat it needs to subscribe.

Two design commitments follow from "read-only projection":

- **The daemon is the source of truth.** The web renders `GET` projections (`/messages`, `/lanes`,
  `/report`) and the live firehose. When a view looks stale, the fix is a server projection, not client
  state. (See the ADR 104 board: "the dashboard renders what the engine derives.")
- **Same origin as the daemon in production.** The daemon static-serves the built app (ADR 062), so the
  client talks to `window.location.host` for `/teams`, `/ws`, `/health` — no configured base URL. In dev,
  `vite.config.ts` proxies those paths to the daemon (`MUSTERD_DAEMON`, default `:4849`) and strips the
  browser `Origin` so the ADR 040 cross-origin gate sees a clean request.

## Routes

| Route              | What it is                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (`index.tsx`)  | Marketing / hero + the roadmap map (rendered from `content/roadmap.data.ts`, the same source `ROADMAP.md` is generated from).                                                                                                                                   |
| `/live`            | The team console: the isometric **office** + the **stream** + the governance **roster**. The flagship surface.                                                                                                                                                  |
| `/board`           | Read-only kanban over `GET /lanes` — one column per lane state (ADR 104 increment 1); closed lanes are the last 14 days' (ADR 534).                                                                                                                                                                           |
| `/approvals`       | The approval queue / card web views (ADR 072/073).                                                                                                                                                                                                              |
| `/audit`           | The audit-log view (ADR 071 projection).                                                                                                                                                                                                                        |
| `/office-preview`  | A design/verification harness: a scripted act sequence + a control bar that fires each `OfficeEvent` on demand. Not a live surface — the place to eyeball choreography without a daemon.                                                                        |
| `/character-sheet` | The character turnaround (ADR 142): the office character at ~4×, every facing, every pose, across two dozen names. The office draws people ~40px tall, where a wardrobe bug is invisible until it ships — iterate on the character **here**, not in the office. |

## The `/live` connection model

`live/client.ts` + `live/useLiveStream.ts` implement the canonical **"backfill then tail"** pattern:

1. **Self-provision an observer seat.** The browser `claim`s its own read-only observer seat
   (self-authorizing, ADR 077 claim handshake; localhost-trust like team creation). `/board` and the
   other live views reuse the same hidden observer.
2. **Backfill history over HTTP** — `GET /teams/:slug/messages` — so the view is not empty on load.
3. **Subscribe to the firehose** — a WS `subscribe` with scope `team-all` (ADR 061) — and live-tail,
   **deduping by envelope id** against the backfill.

A shared read-only **watch link** (`/live?team=<slug>&as=<observer>#w=<credential>`, ADR 063) lets a team
hand someone a spectator view without provisioning them a real seat.
The watch link mints a public-grade observer (ADR 136): it sees Team-broadcast Acts, not directed
traffic. It is a scoped observer, not anonymous access; roster handles and Presence remain visible.

> **Known limitation (2026-07-07):** the HTTP backfill is capped (200) and returns the oldest of an
> over-cap history, so on a busy team the newest acts arrive only via the live socket, not the backfill.
> Deep-history scroll needs a paging fix; tracked separately from ADR 107.

## The three `/live` panels

- **Office** (`live/OfficeScene.tsx` + `live/office-scene/`) — a 2D isometric co-work office (ADR 079).
  Presence → placement, act → choreography, travel-intensity == notification tier. Members are drawn from a
  **procedural jointed skeleton** (ADR 133 — `skeleton.ts` solves the joints, `character.ts` paints them):
  a distance-driven walk cycle, a seated pose with the hands typing on the desk, and eased sit/stride
  blends. ADR 086 layers ambient life (idle strolls, gestures) on top — since ADR 464 lane 4 a
  `working` member keeps their desk (micro-gestures only; errands and desk chats go to members
  between tasks, `ambientSeed.ts` `ambientPool`), a purposeful walk wears its verb over the plate
  (`headline.ts` `walkTag`: "handing off → dolly"), and `live/OfficeKey.tsx` says how to read the
  room in one closable corner card; the scene idle-parks to 0 rAF/sec
  when nobody is working. A read-only working-hours sign is painted from the Team schedule projection
  (Member inheritance is resolved by the daemon), including timezone and weekday grouping (ADR 206).
- **Log drawer** (`live/LogDrawer.tsx`, hosting `live/Stream.tsx`) — every message, one keystroke
  away (ADR 464 lane 2): the act feed, newest-last, live rows type out, threaded replies indent,
  day/now dividers, the model stamp and the click-through. A huddle is ONE card in the feed
  (`live/StreamHuddleCard.tsx`, placed by `huddles.ts` `streamPlacement`): its root and thread rows
  fold into it, each turn with its time-to-turn (`+1.4m`), and the card sits at the huddle's latest
  row, so it rides the live edge while the room talks and stays where it closed. The office floor is
  unaffected: every huddle act is still its own bubble. The huddle rail's "in the log" opens the
  drawer on the card. A seat's name on its first turn opens its path through the room (huddle replay
  increment 2): its wake, then each tool call and hook on the same +Δ clock, read once per card from
  the daemon's huddle trace (`GET /huddles/:id/trace`, ADR 493) by `live/huddleTrace.ts`. `L` opens it, Escape closes it, and a
  speech-bubble click opens it on its act (`live/reveal.ts`). The stream column and companion mode
  it replaced retired on 2026-09-28.
- **Busyness meter** (`live/TopMeter.tsx`, from `live/busyness.ts`) — in the top bar: the team,
  a heartbeat that pulses on every act (the last act's age on hover), and acts over the loaded span
  (never extrapolated). Counts of who is working on what are the Now card's, not the meter's
  (live-briefing spec, increment 4). The team log's door is a topbar button beside Seeds.
- **Headline ticker** — retired 2026-10-12 (nick: never looked at it, on `/live` or `/broadcast`;
  the team column beside the room carries each member's latest moment). `live/headline.ts` stays:
  the office scene reads `walkTag` from it.
- **Team column** (`live/TeamColumn.tsx` + `live/TeamCard.tsx`) — who is here, read by a room
  (ADR 464): one card per present member with the provider logo and readable model name
  (`modelBadge.ts`: observed / declared / unknown / human — never a guess), a plain-language state
  (`teamCards.ts`: working on · waiting for review · blocked on · asking nick · between tasks ·
  away, from the lane board + posture + the derived asks), the lane title in large type with its goal and elapsed time, and offline seats
  folded to a count. Hovering a card rings the member's plate in the office and vice versa
  (`OfficeHandle.setLinked`). Click expands to the operator detail the roster rail used to carry
  (`SeatDetail`, exported from `live/RosterPanel.tsx`): posture chip with offline reason
  (ADR 138/141), account-status exceptions and capability deviations (ADR 070), residency (ADR 131),
  and the per-seat `trace` expander (ADR 445). Collapsed, it is a rail of avatars with logo pips.
  `/broadcast` mounts the same column `still` beside the room (ADR 464 lane 5): no hover, no
  expanding, no operator notes, sized off the 16:9 stage rather than the window.
- **Room framing** (2026-10-01): `/live` and `/broadcast` fit the *furnished* room (`furnishedBox` in
  `office-scene/render.ts` — door, agile board, wall faces, floor tip), not the whole scene with its
  empty wall tops and slab (`fitBox` / `ROOM_BOX` in `iso.ts`; the musterd.io hero and /office-preview
  keep the whole-room fit). A height-bound panel grows ~12%; a width-bound one never crops the door or
  the board. At ≥1600px `/live`'s team column steps to 24vw / 460px with its type 12% up — the step
  `/broadcast` takes at its 1080 rung. The overlay reel and the floating work stack it replaced are gone.
- **Holds banner** (`live/HoldsBanner.tsx`, read by `live/useTeamHolds.ts`) — above the room, the
  Team's active holds (ADR 516): `⏸ merges paused by nick until 15:30 (42m left): demo 14:00`, one
  line per hold from `describeHoldLine` in `@musterd/protocol/wire`, a 30s poll of `GET /holds`, and
  nothing when nothing is in force — an admin no longer gets an empty bar on every visit (nick,
  2026-10-12): the `pause…` form is `HoldsPause`, mounted in the topbar's right end. Both are one
  lazy chunk. Increment 4: `lift` on each hold and the `pause…` form (effect, reason, duration preset)
  render from the read's `can_set` alone — the daemon's per-reader answer, never the viewer's role in
  the client — and a refusal shows in place in the daemon's words.
- **How agents talk to me** (`live/StyleSheet.tsx`, merges in `live/styleEdit.ts`; ADR 514
  increment 5) — on `/board`, a signed-in human's own identity chip opens a sheet. /board has no
  per-human row, so the chip is that row (2026-10-07). It shows the viewer's four dials, each
  `yours` (with a way back to the team's) or `team default`, the team's value marked under its option,
  their prose with a live `n / 5 lines` count, the floor read-only, and the block a seat steered by
  them reads. All of it goes over `GET`/`PUT /members/me/style`. For a viewer the roster calls admin, a second section edits the
  floor toggles, default dials and team prose over `GET`/`POST /policy`, read-merge-write on the
  sparse stored doc (ADR 185). Each knob there is labelled `default` or `set for the team`; who set it,
  and when, stays with `musterd team policy style`, which reads the audit. A `POST /policy` refusal
  hides that section. Agents get no chip: they have no preferences.
- **Ask banner** (`live/AsksStrip.tsx`, words from `live/askPhrase.ts`) — the top of the office
  (ADR 464 §6): "✋ ryder is asking nick: *question* · holding until answered · 4:12", Approve / Deny
  inline for an answerer, "+N more waiting" opens the sheet, a settled outcome for ~6s
  (`AskView.settledAt`), else a quiet "no open questions" pill. The strip's machinery is unchanged
  underneath — derivation and tier clock (`asks.ts`), answers, the sheet with the operator terms,
  the review queue, browser notifications (ADR 443), sign-in offers (ADR 222). The room plays the
  same ask (ADR 464 §3.3): `OfficeData.asks` raises the asker's hand with a `?` cue and rests an
  `lc-gl-ask` card at the human's plate while it is open; settled, the card wears ✓ / ✗ / → for a
  beat and clears. `/broadcast` shows the same banner read-only (`live/StreamAskBanner.tsx`: the
  `askBanner()` view-model and `lc-asks` markup, no buttons, no sheet, "+N more waiting" as
  words, type scaled for the 720p encode); the rotating `AsksReel` it replaced is gone.
- **Shared Seeds tray** (`live/SeedsTray.tsx`) — a read-only drawer from the `/live` top bar (ADR 319).
  Active uses the protocol's shared tray rule; history reveals completed/promoted work and links a
  promoted Seed to the ordinary focused Lane view. It refetches on firehose activity so promotion
  leaves the active tray without adding a browser mutation path.

## Act rendering vocabulary (the load-bearing contract)

Every act projects to a consistent set of renderings. This is the seam ADR 102 (lane events) and ADR 107
(steering acts) each extended, and the thing to touch when a new act is added:

| Concern          | Lives in                                                                                              | What it produces                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tone**         | `live/format.ts` `actTone` → `ActTone`                                                                | The colour role (accent / success / lane / steer / challenge / …). Backs the stream badge and the office cue/speech colour.                                              |
| **Label**        | `live/format.ts` `actLabel`                                                                           | The short human word in the badge (`status_update` → "status"). Clean single-word acts read verbatim.                                                                    |
| **Glyph**        | `live/Stream.tsx` `ACT_GLYPH` / `ActIcon`                                                             | A 12px stroke glyph per act in the badge.                                                                                                                                |
| **Tone colour**  | `live/office-scene/render.ts` `toneColor`                                                             | The concrete office cue/speech colour per tone (mirrors the `--lc-*` CSS tokens).                                                                                        |
| **Choreography** | `live/office-scene/mapping.ts` `actToEvent` → `OfficeEvent`, played by `office-scene/index.ts` `emit` | The office motion: screen-pulse, walk-over (help/handoff), the claim walk (to the wall board, think, take the lane's card — its slot goes empty — and carry it home), megaphone, redirect sweep (steer), question cue (challenge), board pulse (defer), etc. `null` = not animated. |
| **Sound**        | `live/sound.ts` `CUES`                                                                                | A short WebAudio cue per act (opt-in, default off).                                                                                                                      |
| **CSS tokens**   | `live/Live.css` (`--lc-*`, `.lc-badge--*`)                                                            | The palette + badge/spine variants the tones resolve to.                                                                                                                 |

Two act **families** layer on the base acts:

- **Lane events (ADR 102)** ride `act: 'message'` + `meta.lane_*` (ADR 083 — no new act token). The web
  recovers the sub-type with `format.ts` `laneEvent(env)` → `lane_open | lane_claim | lane_state |
lane_resolve | lane_handoff`, and every renderer above keys on that recovered kind. A non-recovering
  client still sees a coherent `message`.
- **Steering acts (ADR 103 / render ADR 107)** — `steer` / `challenge` / `defer` are real protocol acts.
  `steer` is interrupt-class (a room-wide sweep + urgent redirect run); `challenge` is a "justify?"
  question cue; `defer` is a lane-family board pulse. See ADR 107 for the full projection.

**To add a new act's rendering:** add its `actTone` case (+ a `--lc-*` token and `.lc-badge--*` if it
needs a new colour), an `actLabel` case if the token isn't already a clean word, an `ACT_GLYPH` entry, a
`toneColor` case if it introduced a tone, an `actToEvent` case (+ an `OfficeEvent` kind and an `emit`
branch if it needs new motion), and a `sound.ts` cue. Cover the projection with a `mapping.test.ts` case
and a `format.test.ts` tone/label assertion. Verify against a live daemon or `/office-preview`.

## Module map

Curated, not exhaustive — the load-bearing files, grouped. (Intentionally **not** a `File tree` block:
the web tree is large and UI-heavy, so it is not under `arch-trees:check`; keep this list honest by
hand.)

```
router.tsx / routeTree.gen.ts   // TanStack router setup (routeTree is generated)
routes/                         // one file per route (live, board, approvals, audit, previews, index)
content/roadmap.data.ts         // the roadmap SOURCE — ROADMAP.md is generated from it (scripts/gen-roadmap.ts)
live/
  client.ts                     // observer claim + backfill + WS subscribe (browser port of the CLI watch)
  seedClient.ts                 // lazy Seed HTTP projection; keeps Seed schemas out of eager `/live`
  useLiveStream.ts              // the React hook: envelopes, roster, liveIds, conn status, `fresh`; seeds from liveCache, drives the chime; roster refetch on presence is coalesced
  liveCache.ts                  // this browser's last /live snapshot per team + seat (roster, newest 120 envelopes, open lanes) in localStorage: painted at once on the next visit, cleared on sign-out
  coalesce.ts                   // at most one run in flight + one trailing run per gap — the roster refetch's burst guard (viewers × presence frames)
  format.ts                     // act tone/label, laneEvent recovery, roster/colour/status projections
  Stream.tsx                    // the act feed + ACT_GLYPH + typewriter; hosted by the log drawer on /live (lazy)
  StreamHuddleCard.tsx          // a huddle as one card in the feed: header, turn lines with time-to-turn, close/yet-to-speak footer
  huddleTrace.ts                // the huddle trace fetch (ADR 493, type-only protocol import) + seatPath: one seat's wake → tools → hooks, in time order
  reveal.ts                     // the "reveal this act in the log" window event + revealWhenMounted (the drawer mounts the stream lazily)
  LogDrawer.tsx                 // the /live log drawer (ADR 464 lane 2): a right-edge dialog around the stream; Escape closes, focus returns; lazy, mounted only while open
  busyness.ts                   // envelopes + roster → last-act age, acts over the loaded span (bucketed), who is working (pure, node-tested)
  TopMeter.tsx                  // the top bar's busyness meter: team · heartbeat · sparkline
  headline.ts                   // notable act → { who, verb, object, target } from names and titles, never the body; collapseHeadlines (pure)

  RosterPanel.tsx               // the roster rail (no route mounts it since ADR 464) + `SeatDetail`, the per-seat operator block the team card expands to; `trace` expander (ADR 445 inc 4b) lazy-loads the timeline
  askPhrase.ts                  // the ask banner's words (spec §6 table) + askBanner() view-model: open / settled / idle (pure)
  OfficeKey.tsx                 // "how to read the office" — the four postures in a closable corner card (ADR 464 §3.4), /live only
  TeamColumn.tsx                // the /live team column (ADR 464) + its collapsed avatar rail; `captionColorFor` (the narrator's colour)
  TeamCard.tsx                  // one member card: avatar, name, model badge, plain state, work in big type; click expands to `SeatDetail` (lazy: its chunk loads on the first expand)
  teamCards.ts                  // roster + lane board + goals → ordered team cards in plain words (pure, node-tested)
  modelBadge.ts                 // presence → provider + readable model label; observed / declared / unknown / human / service — never a guess
  briefing.ts                   // the Now briefing's one selector (pure, node-tested): needs-a-human by human, goals in motion ("d of n done", who), shipped by who; waitingFor(viewer)
  NowOverlay.tsx                // the Now card's shell (lazy chunk): overlay / full screen, docked into the topbar's "Now" chip (portalled); opens itself once per period (nowWhen.ts)
  NowPanel.tsx                  // the Now card's body: waiting-on-you band, goals in motion, shipped since yesterday; a goal row lights its people in the room
  MemberFace.tsx                // a member's head as the office draws them (appearanceOf), as small inline SVG; the agent visor / human eyes tell survives
  TraceTimeline.tsx             // the per-seat trace timeline (ADR 445 inc 4b): pure TraceTimeline + default SeatTracePanel (fetch, then re-reads every 4s while open, paused on a hidden tab, last list kept on a failed refresh); a lazy chunk, never on /live's eager graph
  SeedsTray.tsx                 // read-only active/history Seed drawer; promoted history → focused Lane
  OfficeScene.tsx               // React wrapper: mounts the scene, feeds it envelopes → emit
  Board.tsx / ApprovalQueue.tsx / ApprovalCard.tsx / AuditLog.tsx   // the other live views
  sound.ts                      // opt-in WebAudio firehose cues
  Live.css                      // the /live palette + component styles (--lc-* tokens)
  office-scene/
    index.ts                    // the imperative scene handle {update, emit, dispose}; the emit switch
    mapping.ts                  // actToEvent: act/envelope → OfficeEvent (the projection)
    types.ts                    // OfficeEvent / OfficeNode / Pose / OfficeHandle
    render.ts                   // canvas drawing primitives + toneColor + Cue
    actors.ts / nav.ts / seating.ts / layout.ts / iso.ts   // placement, walk routing, iso projection
    skeleton.ts                 // THE character animation: 3D joints, renderer-free (walk/sit/type) — ADR 133
    appearance.ts               // THE character identity: skin/hair/hats/clothes, name-seeded, pure — ADR 142
    character.ts                // paints a skeleton in an appearance (facing + limb self-occlusion)
    speech.ts                   // the over-head speech-bubble text model
    arrivals.ts                 // who is new: pure roster diff (created / firstOnline — never-seen-online this session, created ≤24 h) + the wall board's new-arrivals corner (lane 01M3F81DD9)
    welcomeWagon.ts             // the Welcome Wagon beat sequencer: 2 s waves, Act 1 / Act 2 / crowd scripts, mark/seat gates, backlog cap, busy-room cap — pure
    welcomeRoom.ts              // the Welcome Wagon's wiring behind ports: roster → arrivals → beats → residents, and the paint the renderer is shown (unit-tested; index.ts only plugs it in)
components/                     // marketing surface (Hero, Roadmap, Footer, LiquidGlass, Wedge)
  tour/                         // the first-run tour on /live and /board (lane 01M4M4DDYF, spec docs/design/tour-web-copy.md): Tour.tsx (lazy chunk, human viewers only; entry button portalled into the topbar), tourMachine.ts (the CLI tour's step machine, ported; copy from content/tour.data.ts via build-prep → content/generated/tour.ts); LaneTicket.tsx (the tour lane as a ticket: track, story, accept stamp; the spotlight reads data-member / data-lane on the team and lane cards)
brand/                          // unified marks — the mark (full + small cuts) + MusterdWord topbar lockup (ADR 497, was the ADR 154 chip); social-card.png + siteMeta.ts (og:image on musterd.io)
```

## The doorbell's `live` sink (ADR 443)

`live/doorbellNotify.ts` is a pure fold over the timeline the page already holds. `openRingsFor` returns the acts that ring the connected seat (the protocol's `ringTargets`, read from `@musterd/protocol/wire`, so no zod) and are still unanswered. `newRings` keeps only what arrived live over the socket (`liveIds`, never the backfill — arrival, not timestamps, so a skewed browser clock cannot silence it) and was not already rung. `AsksStrip` raises one browser `Notification` per new ring. The text is record fields only, never the body, and a click focuses the tab and scrolls to the act. Only a connected roster member is rung, never an observer or a watch link. Permission is asked from the strip's "notify me here" click, never on load. Measured 2026-09-23: +0.8 KB initial JS gzip on `/live` (135.4 of 136.2 KB).

**What this does and does not protect:** see [SPEC §3](../../SPEC.md#3-collaboration-acts) (the doorbell) — one home for that fact.

## Testing & verification

- **Unit:** the render seam is covered by fast vitest files — `office-scene/mapping.test.ts` (the
  `actToEvent` projection), `live/format.test.ts` (tones/labels/`toneColor`), and the scene's
  `actors`/`nav`/`seating`/`skeleton`/`speech` tests. `skeleton.test.ts` is where the _animation_ is
  pinned — feet never through the floor, arms counter-swinging the legs, the seated head clearing the desk
  — because those are the things a screenshot can't check and a reviewer can't eyeball. Run from the repo
  root (`pnpm exec vitest run packages/web/src/live/`) — a per-package `vitest` invocation trips the app's
  build target.
- **Visual / live:** drive `/office-preview` headless for choreography without a daemon, or point the
  dev server at a live daemon (`MUSTERD_DAEMON=…`, `pnpm dev` → `:5174`) and watch real acts flow through
  `/live`. ADR 107 records a full live-daemon verification of the steering acts.
- The build (`pnpm --filter @musterd/web build`) prerenders each route; a broken route fails the build,
  which the CI `gates` job runs.

## How the built bundle is actually served (ADR 132)

The dev server is **only** an inner-loop tool for un-merged work. The **viewer** — the thing teammates
look at — is served by the **daemon** from its own origin: `http://<host>:4849/live`
([ADR 062](../decisions/062-daemon-static-serve.md) static-serve + the same-origin WS gate). There is no
separate web host and no proxy in that path.

The bundle gets there via the `--live` **build-publisher**
([ADR 132](../decisions/132-live-viewer-on-daemon-origin.md)): a single interval LaunchAgent that advances
the `…/agents-live` worktree to `origin/main`, runs `pnpm --filter @musterd/web build`, and **atomically
publishes** `dist/client` into the daemon's web-root (`~/.musterd/live/web`). Because `serveStatic` reads
per-request, a UI change goes live **without restarting the daemon** — so shipping web work never drops a
teammate's session. Consequences worth internalising:

- The daemon's build SHA and the served UI's SHA are **independent** and routinely differ. That is by
  design; it is not drift to "fix" with `musterd service refresh` (which bounces the shared daemon).
- `~/.musterd/live/build.log` is the source of truth for what the UI is serving (`published <sha>`).
- A failed web build keeps the **previously published** bundle — the viewer never goes blank on a bad merge.
- `:5173` (the retired ADR 124 `pnpm dev` viewer) is dead; dev servers now bind `:5174`, so a stale link
  fails fast rather than silently resolving to somebody's WIP.
