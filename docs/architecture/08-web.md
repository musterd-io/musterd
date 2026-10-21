# 08 — Web surface (`@musterd/web`)

> **Living document.** Like the rest of `docs/architecture`, this is direction, not gospel. If you find
> it disagrees with the code, fix the smaller of the two and update the other in the same commit; if the
> disagreement is a real decision, write an ADR. This chapter is the map the other web ADRs (061–064,
> 072/073, 079, 086, 094, 096/097, 099, 102, 104, 107) assume but never draw in one place.

## What the web package is

`@musterd/web` is the **browser console for a team** — a read-only window onto the same Members the CLI
and MCP adapter serve, rendered from the daemon's firehose. It is a TanStack Start (React + Vite) app.
It owns **no state the daemon doesn't**: every view is a projection of what the server derives or
streams. There is no board CRUD, no second store, no write path beyond the observer seat it needs to
subscribe.

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

1. **Connect as a seat.** A signed-in member connects as themselves (ADR 222). Otherwise the browser
   uses the read-only observer it cached for the team (ADR 077 claim handshake); `/board` and the other
   live views reuse the same hidden observer. Minting a new observer takes a human admin's credential
   (ADR 580), so a page with no cached observer and no sign-in opens the sign-in fields instead of
   asking. An admin's sign-out mints one with the outgoing credential. `/broadcast` watches only with
   the seat its capturer hands it (ADR 594, `broadcastSeat`): a broadcast-grade observer that sees
   every DM except human to human, with recognisable credentials masked by the daemon (ADR 601). It
   never falls back to the browser's cached observer, which is full-grade; with no handed seat it
   shows the refusal and loads nothing.
2. **Backfill history over HTTP** — `GET /teams/:slug/messages` — so the view is not empty on load.
3. **Subscribe to the firehose** — a WS `subscribe` with scope `team-all` (ADR 061) — and live-tail,
   **deduping by envelope id** against the backfill.

A shared read-only **watch link** (`/live?team=<slug>&as=<observer>#w=<credential>`, ADR 063) lets a team
hand someone a spectator view without provisioning them a real seat.
The watch link mints an observer with the signed-in admin's credential, so the share button is
offered only to a signed-in member. The sharer picks its grade (ADR 616): a **public link** (the
default, ADR 136) sees Team-broadcast Acts and no directed traffic; a **demo link** is `broadcast`
grade (ADR 601), so it also sees agent DMs and asks, never a DM between two humans, with keys masked.
Each grade has its own cached seat (`acquireWatchLinkObserver`), so a public link never carries the
demo seat's credential. A demo link adds `&grade=broadcast` so the viewer's page can label itself;
the daemon, not the label, decides what the seat reads. Either is a scoped observer, not anonymous
access; roster handles and Presence remain visible.

> **Known limitation (2026-07-07):** the HTTP backfill is capped (200) and returns the oldest of an
> over-cap history, so on a busy team the newest acts arrive only via the live socket, not the backfill.
> Deep-history scroll needs a paging fix; tracked separately from ADR 107.

## The three `/live` panels

- **Office** (`live/OfficeScene.tsx` + `live/office-scene/`) — a 2D isometric co-work office (ADR 079). Behind `?office=rendered` the scene loads pre-rendered PNG assets (`office-scene/rendered/`, source in `packages/web/art/office/`) and an item whose asset is present blits it where it painted vectors — the office re-make's build flag (spec `2026-10-20-office-realism-design.md`). Increment 2 draws the whole room from the corner camera (`CORNER_CAMERA` in `iso.ts`, carried on the `Fit`): the floor and walls as one image per day state crossfaded by `roomState.ts`, the ceiling bank as an additive overlay, every static item, and the lamp and fan per desk; people, chairs, monitors, desk props and the wall fixtures still paint on top until increments 3–4.
  Presence → placement, act → choreography, travel-intensity == notification tier. Members are drawn from a
  **procedural jointed skeleton** (ADR 133 — `skeleton.ts` solves the joints, `character.ts` paints them):
  a distance-driven walk cycle, a seated pose with the hands typing on the desk, and eased sit/stride
  blends. ADR 086 layers ambient life (idle strolls, gestures) on top — since ADR 464 lane 4 a
  `working` member keeps their desk (micro-gestures only; errands, desk chats and the aisle meet — two
  idle members get up, meet between their desks, talk and go back (nick, 2026-10-12) — go to members
  between tasks, `ambientSeed.ts` `ambientPool`; who gets a gesture is a rotation through a seeded permutation of the seated members, desk or lounge (ADR 686: idle members sit on the leisure furniture first, and a desk-only pool left them without a beat), advancing on each single-member decision — `decideAmbient`, a pure replay every viewer agrees on — not a uniform draw, which left a third of a twelve-person room without one in ten minutes; and the walk floor, `WALK_FLOOR_SLOTS`: after about 50 s with no walk decided, the next slot sends an idle member on an errand or an aisle meet, and a floor walk this browser cannot start falls back to a coffee run), a purposeful walk wears its verb over the plate
  (`headline.ts` `walkTag`: "handing off → dolly"), and `live/OfficeKey.tsx` says how to read the
  room in one closable corner card; the scene idle-parks to 0 rAF/sec
  when nobody is working. A working-hours sign is painted from the Team schedule projection
  (Member inheritance is resolved by the daemon), including timezone and weekday grouping (ADR 206);
  a Team with no schedule gets the same card reading `ANY DAY · no set hours`. On `/live` that card is
  the door to **settings** (below): a hotspot button over it (`hoursAnchor`, the scene handle's
  `setSettingsSpot`) shows for a signed-in human and wears a dot while a channel pairing waits.
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
- **Who is here** (`live/WhoIsHere.tsx`, from `live/hereRow.ts`; [ADR 692](../decisions/692-live-who-is-here.md))
  — at the head of the topbar's tools: the faces of the members with /live open, others by arrival
  and the viewer last. A /live tab claims with `workspace: '/live'` (`LiveConfig.page`), and a member
  is here when one of their `web` rows carries that label; observer seats (the anonymous watcher, a
  watch link, the /broadcast capture seat) never reach the roster. One face per member, however many
  tabs. The stack fans open on hover or focus, each face has a card (kind, here since, tabs), and an
  arrival slides in with one ring of the member's colour; "<name> opened /live" shows for a few
  seconds only when they were already online elsewhere (the team column announces a fresh arrival).
  /live re-reads the roster every 60 s so a tab closed beside another live session leaves the row.
  Lazy: its chunk loads after the first roster read.
- **Headline ticker** — retired 2026-10-12 (nick: never looked at it, on `/live` or `/broadcast`;
  the team column beside the room carries each member's latest moment). `live/headline.ts` stays:
  the office scene reads `walkTag` from it.
- **Team column** (`live/TeamColumn.tsx` + `live/TeamCard.tsx`) — who is here, read by a room
  (ADR 464): one card per present member with the provider logo and readable model name
  (`modelBadge.ts`: observed / declared / unknown / human — never a guess), a plain-language state
  (`teamCards.ts`: working on · waiting for review · blocked on · asking nick · between tasks ·
  away, from the lane board + posture + the derived asks), the lane title in large type with its goal and elapsed time, and offline seats
  folded to a count. Hovering a card rings the member's plate in the office and vice versa
  (`OfficeHandle.setLinked`). On a signed-in `/live` the viewer's own card and office plate say
  "you" (`OfficeScene`'s `you` → `OfficeData.you`; never on `/broadcast` or for an observer); a human's
  plate carries a person glyph in their own hue in the provider slot, where it used to show the
  unknown "?" (`modelProviderIcon.ts` `HUMAN_GLYPH_SVG`). Click expands to the operator detail the roster rail used to carry
  (`SeatDetail`, exported from `live/RosterPanel.tsx`): posture chip with offline reason
  (ADR 138/141), account-status exceptions and capability deviations (ADR 070), residency (ADR 131),
  and the per-seat `trace` expander (ADR 445). Collapsed, it is a rail of avatars with logo pips.
  At its foot, the Experiments section (`live/Experiments.tsx` + `experimentReads.ts`, ADR 644): every
  lane carrying `reads_on`, grouped by the server's `read_status` (overdue, due, waiting, read for 7
  days), so an overdue read is seen by the room; the folded rail carries the overdue count.
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
  the client — and a refusal shows in place in the daemon's words. Since 2026-10-19 the `pause…`
  form lives in settings' Team sheet, not the topbar.
- **Settings** (`live/settings/SettingsOverlay.tsx`, its own lazy chunk and `Settings.css`; nick,
  2026-10-19, lane 01M5BDF1A5) — opened from the working-hours calendar under the wall clock, which
  wears an oak "settings ›" tab fixed under its frame (the clock leaves no room above it, and its
  header band keeps the days) and a red pin when a pairing waits. The board overlay's gesture again: it comes off the wall out of the card's rect and goes back on it, at
  600px so the room stays in view, dressed in the card's oak, brass and mustard band. Two sheets.
  **You** (`YouPanel.tsx`, any signed-in human, every route self-only): staged channel pairings as
  one compact row each — workspace, user and check code exactly as the daemon holds them, Confirm /
  Reject (ADR 618 §7; this replaced the full-width pairing panel above the room) — then availability
  (`POST /availability`), the viewer's effective hours read-only, where asks ring them
  (`GET`/`PUT /members/me/doorbell`, ADR 443; a personal URL is CLI-only, never shown here), each
  paired away channel's switches (away channels 6), and how agents talk to them (`StyleSheet.tsx`'s
  `MyStylePart`). **Team** (`TeamPanel.tsx`, shown when the roster says admin; the daemon still
  decides): the Team's hours read-only (an editor is lane 01M5BDFCFE), `pause…`, the policy knobs in
  plain groups from one table (`policyKnobs.ts`: waking agents, spend, acceptance & asks, huddles,
  joining — no secret is in it, and a test holds that), and the team style. Every Team write goes
  through one copy of the sparse stored doc, so a knob and a style edit cannot undo each other (ADR
  185). Pairings are read by `live/usePendingPairings.ts` (30s poll, client loaded on first use).
  Sound, room tone and the share link stay in the topbar (nick).
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
- **Lane picker** (`live/PickOverlay.tsx`, state in `live/pickList.ts`, its own lazy chunk and
  `PickOverlay.css`) — `/live?pick=<seat>` (musterd pick spec §5.4, ADR 624, lane 01M5162T6H). The
  board's open lanes for that seat from `pickerRows` (read through `@musterd/protocol/wire`, since the
  root index carries node-only modules), grouped by goal on the left, the highlighted lane's brief on
  the right with its risk, blocked-on and declined notes. Type to filter, ↑/↓, ⏎ picks, Esc closes;
  Tab moves focus inside the dialog, so claimable/blocked is a two-button switch. A pick is the
  existing handoff from the signed-in human (`owner_seat` + `handoff_note`), re-reading the board
  first so a lane taken meanwhile says by whom. Not signed in, it asks first and stays open; a service
  seat is refused (ADR 232). The a11y gate measures it open and drives it by keyboard alone
  (`scripts/a11y/pick-keyboard.mjs`).
- **Ask banner** (`live/AsksStrip.tsx`, words from `live/askPhrase.ts`) — the top of the office
  (ADR 464 §6): "✋ ryder is asking nick: *question* · holding until answered · 4:12", Approve / Deny
  inline for an answerer, "+N more waiting" opens the sheet, a settled outcome for ~6s
  (`AskView.settledAt`; the strip's clock keeps ticking through that window), else a quiet "no open
  questions" pill. An ask whose body lists options (`askPhrase.askChoices`: `A.`/`A)`/`1.` lines
  from A or 1, and "I recommend C") is a **choice**. The rail shows its letters and **Choose…**
  instead of Approve, and the sheet and the composer list every option in full as its own answer
  (`live/AskChoices.tsx`), with the asker's recommendation tagged and nothing pre-selected. The
  pick is sent as `accept` with the option as its body ("C — …", `choiceReply`), the ask records
  `AskView.chose`, and the rail settles on "nick chose C ✓" (lane 01M511XNQC). Two things are never a
  choice (lane 01M5AVXZ9B): a lane review (`meta.lane_review` — an acceptance ask, whose answers are
  accept / decline; `askChoicesOf` is what every surface calls), and numbered lines inside a quoted
  passage, which are someone else's words — the ADR 603 human-acceptance ask quotes the peer's
  findings verbatim, and on 2026-10-19 the rail offered them to nick as "pick one". A human lane
  verdict the daemon refused at the passkey gate (ADR 662) does not settle its ask:
  `resurrectRefusedVerdicts` re-offers a non-advisory `lane_review` ask while its lane is still in
  acceptance and the only settling verdict was a human one — unsigned, or signed but refused
  (lanes 01M5EA60RD, 01M5EBKZQY). The strip's machinery is unchanged
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
| **Choreography** | `live/office-scene/mapping.ts` `actToEvent` → `OfficeEvent`, played by `office-scene/index.ts` `emit` | The office motion: screen-pulse, walk-over (help/handoff), the claim walk (to the wall board, think, take the lane's card — its slot goes empty — and carry it home), the pin walk (a resolve or submit: carry the card back and pin it under its new column, which the wall shows before the board data catches up — nick, 2026-10-12; a done pin by someone other than the lane's owner is an acceptance and puffs confetti over the done column as the card lands, at once if the acceptor is not in the room, and never during a replay; a card that lands swings on its tape (two swings over ~1 s, peaking ~4 board units — `wallboard.ts` `stickySway`), a slot a card has lately hung in keeps a tack hole once it is empty (`wallboard.ts` `projectWallBoard`: per column, the cards there now plus lanes updated in the last 7 days that have moved past it, capped at the column's slots — derived from the board, so every viewer sees the same cork; lane 01M50WEBTC), a stopped plan's cards hang sun-faded and pin first in their column (`briefing.ts` `stalledLaneIds`, the Now card's rule at lane level — lane 01M4V9YKMG), each nameplate sits a seeded ±0.8° off true, and the entrance parts a crack of light as someone comes or goes; the dog sometimes tags along on a coffee or water errand, seeded on the shared slot; the window light shafts follow the sun — a low sun at dawn and dusk throws them long and leaning, noon short and straight, the lean flipping sides across the day (`lighting.ts` `sunBeam`, shared by the painted beams, the dust motes and the dog's sunbeam nap spots); a speech bubble slides sideways, whole and readable, while it would cover the wall board (`speech.ts` `bubbleShiftOffBoard`); a nameplate whose "working on" chip would run across the board drops the chip, `plateLayout.ts` `plateCoversBoard`), the deliver walk (a submit with a named acceptor — the daemon's `lane_review` ask — carries the card to the acceptor's desk instead and replaces that submit's pin — the carrier is the lane's owner as the room saw them claim or pin it (`office-scene/laneOwners.ts`), not the ask's sender, which on a re-routed ask is whoever re-routed it; the acceptor's accept then pins it under done), megaphone, redirect sweep (steer), question cue (challenge), board pulse (defer), etc. `null` = not animated. In a room of six or more seated members, a fired ambient slot can also carry one companion's in-place beat, and a companion near something moving (the dog, an aisle meet, a colleague's errand) swivels to watch it go by (`ambientSeed.ts` `decideAmbient`, `actors.ts` `notice`; ADR 617). On open, the last ten minutes' walks replay once at 2×, drained by the frame loop (never inside `update`) (`office-scene/replay.ts`, `OfficeHandle.replay`) so the room is never a still life. The grammar these walks share, its invariants and the beats still to build: [`2026-10-13-office-liveliness-design.md`](../superpowers/specs/2026-10-13-office-liveliness-design.md). |
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
  authorityProof.ts             // the ADR 662 passkey ceremony for a human's lane verdict on the asks rail; dynamically imported so it stays out of the eager bundle
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
  WhoIsHere.tsx                 // the topbar's "who is here" row (ADR 692): faces that fan open, a card per face, the arrival ring and note, the fold-out on leave; a lazy chunk
  hereRow.ts                    // roster → the members with a /live-labelled web row: one per member, kind, tabs, here-since, idle; others by arrival, the viewer last (pure, node-tested)
  headline.ts                   // walkTag — the verb a walker wears (handing off → dolly / claiming … / finished …); the ticker's headline builders left with the ticker (2026-10-12)

  RosterPanel.tsx               // the roster rail (no route mounts it since ADR 464) + `SeatDetail`, the per-seat operator block the team card expands to; `trace` expander (ADR 445 inc 4b) lazy-loads the timeline
  askPhrase.ts                  // the ask banner's words (spec §6 table) + askBanner() view-model: open / settled / idle (pure)
  OfficeKey.tsx                 // "how to read the office" — the four postures in a closable corner card (ADR 464 §3.4), /live only
  TeamColumn.tsx                // the /live team column (ADR 464) + its collapsed avatar rail; `captionColorFor` (the narrator's colour)
  TeamCard.tsx                  // one member card: avatar, name, model badge, plain state, work in big type, goal + areas + age meta; click expands to `SeatDetail` (lazy: its chunk loads on the first expand)
  teamCards.ts                  // roster + lane board + goals → ordered team cards in plain words, carrying derived/declared areas from the shown lane (pure, node-tested)
  Experiments.tsx               // the team column's Experiments section (ADR 644): the dated reads as rows with shape marks, capped at five (urgent never hidden), linked to /board on /live, still on /broadcast
  experimentReads.ts            // lane board → the dated reads in group order, phrases and day counts in the team's calendar zone; status is the server's read_status, never derived here (pure, node-tested)
  modelBadge.ts                 // presence → provider + readable model label; observed / declared / unknown / human / service — never a guess
  briefing.ts                   // the Now briefing's one selector (pure, node-tested): needs-a-human by human, goals in motion ("d of n done", who), shipped by who; waitingFor(viewer)
  NowOverlay.tsx                // the Now card's shell (lazy chunk): overlay / full screen, docked into the topbar's "Now" chip (portalled); opens itself once per period (nowWhen.ts)
  NowPanel.tsx                  // the Now card's body: waiting-on-you band, goals in motion, shipped since yesterday; a goal row lights its people in the room
  MemberFace.tsx                // a member's head as the office draws them (appearanceOf), as small inline SVG; the agent visor / human eyes tell survives
  TraceTimeline.tsx             // the per-seat trace timeline (ADR 445 inc 4b): pure TraceTimeline + default SeatTracePanel (fetch, then re-reads every 4s while open, paused on a hidden tab, last list kept on a failed refresh); a lazy chunk, never on /live's eager graph
  SeedsTray.tsx                 // read-only active/history Seed drawer; promoted history → focused Lane
  OfficeScene.tsx               // React wrapper: mounts the scene, feeds it envelopes → emit
  Board.tsx / ApprovalQueue.tsx / ApprovalCard.tsx / AuditLog.tsx   // the other live views; a card's chain control (and a focused card) reads one lane and shows asked, claimed, model, accepted, authorized (ADR 629)
  sound.ts                      // opt-in WebAudio firehose cues
  Live.css                      // the /live palette + component styles (--lc-* tokens)
  office-scene/
    index.ts                    // the imperative scene handle {update, emit, dispose}; the emit switch
    laneOwners.ts               // who owns each lane the room has watched (claim / pin walks) — the deliver walk's carrier when the ask was re-routed (lane 01M4V774MK); bounded
    mapping.ts                  // actToEvent: act/envelope → OfficeEvent (the projection)
    types.ts                    // OfficeEvent / OfficeNode / Pose / OfficeHandle
    render.ts                   // canvas drawing primitives + toneColor + Cue
    damage.ts                   // broadcast only: dirty-rect repaint — a measure pass keys and boxes every paint unit, the diff against the last frame is the damage, the paint pass clips to it and skips the units that cannot touch it (smooth-capture spec lever 2, ADR 625; `&dirty=0` opts out)
    replay.ts                   // replay on open (nick, 2026-10-12): the last ten minutes' lane walks (claim / pin / handoff) from backfill, oldest first, capped — the handle plays them at REPLAY_TEMPO× then settles to live
    domCadence.ts               // broadcast only: the page's DOM animations (steam, motes, twinkles, fan, banner) are paused and advanced per drawn frame — the box's software compositor was composing 60 frames/s over a 15 fps canvas (lane 01M4S96VAW, 2026-10-13)
    actors.ts / nav.ts / seating.ts / layout.ts / iso.ts   // placement, walk routing, iso projection
    skeleton.ts                 // THE character animation: 3D joints, renderer-free (walk/sit/type) — ADR 133
    appearance.ts               // THE character identity: skin/hair/hats/clothes, name-seeded, pure — ADR 142
    character.ts                // paints a skeleton in an appearance (facing + limb self-occlusion)
    rendered/                   // pre-rendered art behind `?office=rendered` (office realism, spec 2026-10-20; the art source is packages/web/art/office/)
      manifest.ts               // the render's manifest contract: parseManifest / assetById (id, file, size, anchor, px per floor unit, camera KX/KY)
      assets.ts                 // the flag (`renderedOfficeFromSearch`) and the never-rejecting loader (`loadRenderedAssets`: images by id + the files that failed)
      blit.ts                   // blitAsset: one image at a floor point through project(), its anchor on the point, sized by fit.scale / asset.scale
      roomState.ts              // which rendered light state the room shows: roomMixFor (day/evening/night × ceiling on/off/spill, a 45-minute crossfade at each edge), figureTintFor
      figureSheet.ts            // sprite-sheet geometry for the figure: SheetSpec, frameRect from the scene clock, dir8FromHeading with hysteresis (increment 3)
      tint.ts                   // tintedSheet: a member's colour multiplied over a neutral layer sheet, cached per (layer, colour); mulHex
      figure.ts                 // layersFor (appearance.ts → back-to-front layers with a colour each) and drawFigureFrame (one composed frame at a floor point)
    speech.ts                   // the over-head speech-bubble text model
    arrivals.ts                 // who is new: pure roster diff (created / firstOnline — never-seen-online this session, created ≤24 h). Its new-arrivals polaroid corner under the wall board was retired 2026-10-12 (nick: one kind of card on the wall)
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
- An **open tab survives a publish** (lane 01M58JC1EF). The swap carries the outgoing bundle's hashed
  chunks into the new web-root and keeps them for an hour after they are retired (`.own-assets` lists
  which chunks the live bundle owns). A tab on the old build can still lazy-load, for example, the team
  log. Build-sync (`live/buildSync.ts`) moves the tab onto the new build: it polls `build.json` and
  checks again when the tab comes back into view. If a chunk still fails to load (`vite:preloadError`),
  the page reloads once per build, and does not loop.
- **Every nameplate is one chalk stock** (lane 01M5B31024, 2026-10-19, superseding 01M5AVZA7C's
  per-member tint the same day): `.lc-gl-label__plate` is #fffaf0 for every member, opaque, with the
  member's hue only as a hint in the rim (55% into the paper rim). The paper-2 stock before it sat one
  step from the mustard floor; chalk lifts the plates by lightness (never darkness, nick's standing
  line). nick picked it from five stocks shown side by side — a tinted plate per member read as
  twelve colours and drowned state. The stocks tried are recorded beside the rule.
- **A nameplate says the member's job** (lane 01M5FXZF49, 2026-10-21; a Twitch viewer asked "can you
  show their occupations"): one plain word beside the name on /live and /broadcast
  (`.lc-gl-label__job`), from the seat's declared role through `live/occupation.ts` — `designer`,
  `writer` for product-communications, `ops` for platform, `auditor` for steward (words set by
  product-communications). `admin` shows none: it is a permission, and "founder" belongs to the `founder`
  role, so it is true wherever it shows. A role with no word there, a member with no role, and a service
  show none; a raw role id never reaches the plate. It sits on the face, not on a
  second line, so plates grow no taller for `plateLayout.ts` to settle. Deriving a job from a member's
  lane areas was rejected: "docs" led for nearly everyone. A job assigned while the room is open
  swipes in once under a mustard highlighter (`.is-new`, index.ts `plateJobs`): never on page open,
  never under reduced motion. `/office-preview`'s 🪪 gives Dev a job to judge it, and
  `?plates=broadcast` shows the stream's plates. Roles for the roleless seats: lane 01M5FY2XFX.
- **/live wears a product frame** (lane 01M5BEE19C, 2026-10-19; nick: /live in a pitch read "too
  silly/casual/game like" for something teams buy). The `.lc` palette is neutral white and cool grey
  (it was warm cream), the uppercase mono section labels are sentence case in the linear cut (mono
  stays for clocks and counts; no re-font, ADR 477 stands), and on `main.lc` the room and the team
  column are two bordered panels on a grey page. On `main.lc` a speech bubble is a white card with the
  act's tone as a subtle 1.5px border all the way round (a 3px top edge until 2026-10-20), clipped at 4 lines (was 5); `:where()` keeps it at the base rule's
  specificity so the marked bubbles (`.is-mark--*`) and hover-expand still win. Every motion is
  unchanged. /broadcast's stage is a `div.lc` and keeps its own frame (no panels), and its team
  column takes the neutral palette with /live (ADR 464: they share one column).
- **The product frame reaches /broadcast and says where a bubble leads** (lane 01M5BP0TEQ,
  2026-10-19, nick's picks). /broadcast's bubbles take the white card (`:where(main.lc,
  .bc__stage.lc)`) but keep their own type size and 5 lines, because the stream arrives at 720p and
  nobody can hover it; its corner notice is white at rest and warms only on the ship beat, and the
  stream-only "Between tasks" label is sentence case. On /live a clickable bubble carries an
  "open ›" (`.lc-speech__open`, a child of the bubble's outer so hover-expand cannot clip it, hung off
  the bottom edge so it takes no row, flipped left when the tail sits right): a lane act
  (`format.ts` `laneIdOf` — the lane bag in its meta, never an id quoted in prose) opens the board
  on that lane's card with its chain open, anything else opens its row in the log. The board overlay
  opens on columns whenever a lane is focused, so the asks strip's and the Now panel's lane links
  land on the card too. A woken plate rings violet (`--lc-woken-rim`, the woken tag's own colour, at
  70% in the rim plus a 1px halo; nick picked option E) — on one chalk stock, colour on the floor
  means state.
- **A walk lands before the next beat** (lane 01M5B02V4A, 2026-10-19). The per-member walk queue
  (`actors.ts` `pending` → `startNext` on walk end) and the per-member speech queue were already
  there; what cut walks short was `setHomes`, which runs on every envelope and presence frame and
  used to send any walker more than 8 units from home straight back. Now an act walk in flight is
  never touched by a roster update; if the home moved meanwhile, `step` re-homes the member with one
  plain walk after the act lands, and only then drains the queue. `cancelAmbient(only)` yields only
  the acting member's stroll or gesture, so a stranger's wave is not killed by someone else's act.
  A plate wearing a walk tag is lifted (`is-tagged`, z 2) above its neighbours and under every bubble.
- **A nameplate's stock is its owner's hue** (lane 01M5AVZA7C, 2026-10-19): `.lc-gl-label__plate` is
  the member colour at 22% into near-white with the hue drawn firmly on the rim, opaque. The paper-2
  stock it replaces sat one step from the mustard floor and nick read the plates as blending in; the
  tint lifts them by lightness (never darkness, his standing line) and keeps the recede ranking under
  the speech bubble — no glow, no extra drop. The three stocks tried are recorded beside the rule.
- **An experiment row shows its result, not just the word** (lane 01M5B1ZM80, 2026-10-19;
  [experiment results](../superpowers/specs/2026-10-19-experiment-results-design.md)). A lane that
  carries a `metric` and two or more daily `samples` draws a sparkline (`experimentReads.sparkline`:
  baseline rule, dashed target rule, latest value; ink only until `read`); a verdict with `measured`
  reads `met · 61% (target 60%, n 23)` (`resultPhrase`); the note's first sentence shows under the
  row, the whole note on a click on `/live`; an `evidence` URL is a link. The fields are read off the
  lane defensively until `@musterd/protocol` serves them (ryder's lane 01M5B1YQVH).
- **Every experiment read carries a live countdown** (lane 01M5AXHFZT, 2026-10-19):
  `experimentReads.clockPhrase` counts toward the read day's 00:00 in the team zone
  (`readDayStart`, DST from Intl) — `2d 14h 05m`, `today · 9h 12m left`, `overdue · 2d 04h` — read
  against a minute tick in `Experiments.tsx` (`useMinuteTick`: one timeout re-armed to the wall
  minute, paused while hidden, ticking on the stream too). The status itself stays the server's.
- **The desk moves from the seat's pulse, not its posture** (ADR 660, lane 01M5AJ9T16). The daemon
  sends one `seat_pulse` per seat at most every ~5 s — distinct harness tool calls in the last minute
  and the latest call's kind — and nothing while a seat is idle. `live/pulse.ts` decides liveness from
  the frame's own `ts` (15 s, three missed pulses) at draw time; there is no interval. In the scene the
  typing amplitude is `typingFromPulse(intensity)`, the monitor stays lit while the owner sits but its
  desktop moves and blooms only while a pulse is live, a `run` brightens the bloom for three seconds,
  and `living()` parks the loop once no seat pulses. A seat on a harness with no hooks, or one that is
  truly idle, sits still at a lit screen — honestly.
- `:5173` (the retired ADR 124 `pnpm dev` viewer) is dead; dev servers now bind `:5174`, so a stale link
  fails fast rather than silently resolving to somebody's WIP.
