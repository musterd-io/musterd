# Office sound inventory

Every sound the office can play on `/live` and `/broadcast` as of 2026-10-27, where it comes from, what gates it, and the designer's keep / rework / cut verdict for the re-evaluation nick asked for (lane 01M6096TA7).

## How sound reaches a viewer

- **Two engines, both opt-in and default OFF on `/live`** (`live/sound.ts`): the *act cues* (`firehoseSound`, one short figure per act) and the *room tone* (`roomTone`, a bed plus small life noises plus placed "moments"). Each has its own toggle and stored preference; a hidden tab never plays either.
- **`/broadcast` turns both on** without persisting (`enableForBroadcast`, ADR 228) and runs the whole mix through a ×4 master (+12 dB) measured against the hosted pipeline so the bed sits near −30 LUFS: audible, still background. Act cues on the stream are throttled to one per 700 ms (`BROADCAST_CUE_GAP_MS`); moments to one per 400 ms.
- **Everything is synthesized** in WebAudio. There are no audio files (ADR 151 bytes).

## Inventory

| Layer | Sound | When | Where it pans | Loudness (linear gain, pre-master) |
| --- | --- | --- | --- | --- |
| Act cue | `message` E5 tri | any message act | centre | 0.10 |
| Act cue | `status_update` A5 sine, 0.18 s | a status update | centre | 0.05 — near-subliminal by design |
| Act cue | `request_help` E5→A5 rising | request_help | centre | 0.11–0.12 |
| Act cue | `handoff` G5→C6 | handoff | centre | 0.10 |
| Act cue | `accept` E5→G5 | accept | centre | 0.10 |
| Act cue | `decline` G4→E4 falling | decline | centre | 0.09–0.10 |
| Act cue | `wait` D5 sine 0.46 s | wait | centre | 0.07 |
| Act cue | `ask` G5→C6 tri | ask | centre | 0.12–0.13 — the loudest cue |
| Act cue | `steer` A4→E5→A5 tri, three notes | steer | centre | 0.11–0.13 |
| Act cue | `challenge` D5→A5 | challenge | centre | 0.09–0.10 |
| Act cue | `defer` G5→D5 | defer | centre | 0.08 |
| Act cue | `resolve` C5→E5→G5 major arpeggio | resolve | centre | 0.11–0.12 |
| Act cue | `end` C5→G4 | a lane/thread end | centre | 0.08–0.09 |
| Bed | air hum + slow swell | whenever room tone is on | centre | `ROOM_GAIN` 0.075 × air 0.34 |
| Life | `keys` (per-desk keyboard, thock + click) | a desk in its *typing* phase; weight 0.39 | that desk | per key 0.017–0.026 / 0.010–0.015, on `LIFE_GAIN` 34 |
| Life | `murmur` / `whisper` | only with two members actually near each other; 0.20 / 0.04 | the pair | — |
| Life | `tap` / `softTap` (pen on desk) | any working desk; 0.07 / 0.03 | that desk | — |
| Life | `stapler`, `drawer` | any working desk; 0.03 each | that desk | — |
| Life | `footsteps` | always available; 0.03 | random side | — not tied to anyone walking |
| Life | `sip`, `water`, `blow`, `eating` | always available; 0.03 / 0.02 / 0.01 / 0.02 | random side | — not tied to a sip beat, a bottle, a plate |
| Life | `paws`, `jingle`, `yawn`, `bark` | dog on the floor (paws: walking); 0.025 / 0.01 / 0.01 / 0.005 | the dog | bark deliberately rare |
| Life | `birds` | 05:00–11:00 office clock with daylight; 0.03 | random side | — |
| Life | `nightair` | dark room with someone in it; 0.02 | random side | — |
| Moment | `fanfare` | an accept lands on a celebrant | the celebrant | — |
| Moment | `door` | a member walks in or out | the entrance | — |
| Moment | `askbell` | an ask arrives (one held tone) | the asked desk | — |
| Moment | `whoosh` | a directed act sweeps from sender to recipient | sender → recipient | — |
| Moment | `plateOpen` / `plateClose` | the viewer opens or closes a nameplate | the plate | — viewer's own hand |
| Moment | `boardOpen` / `boardClose` | the viewer opens or closes the board overlay | centre | — viewer's own hand |
| Moment | `ring`, `ratchet`, `rattle`, `doorbell`, `pop` | the Welcome Wagon (phone, label maker, wagon wheels, front-door chime, confetti) | their props | — |

Life events fire every 2.5–8 s in a quiet room, about twice as often under full work density (`lifeGapFor`). `chime` and `creak` were cut on 2026-09-02 because they could be mistaken for a cue (the one rule the bed has).

## What I can and cannot judge from here

The verdicts below are design judgements from the synthesis, the gates and the stream's measured loudness. I cannot listen in this harness, so **which of these actually sounds wrong is nick's ear**; each verdict names what to listen for.

## Verdicts

**Keep as is.** `keys`, `murmur`/`whisper`, `tap`, `stapler`, `drawer`, the dog set, `birds`, `nightair`, the bed. Gated on something the eye can see (a typing desk, a pair, the dog, the clock), placed where it happens, rare where it should be. They are the office being inhabited.

**Keep, re-level.** `askbell` and the `ask` cue both fire on one ask, from the same desk, and `ask` is the loudest cue in the table. Listen for: an ask arriving as two sounds. Proposal: the cue carries the "for you" and the bell carries the "where"; drop the cue's gain to the `message` level, or play the bell alone on `/broadcast`.

**Rework: tie to motion (lane 01M5XS6KAD).** `footsteps`, `sip`, `water`, `eating`, `blow` play from a random side on a timer, while the office now has real walks, sip beats, water errands and plates. A footstep nobody is taking is the thing the `creak` cut was about. Proposal: these leave the life roll and fire from the choreography — footsteps from a walker's stride (plank vs tile by the floor under them), the sip from the sip beat, the bottle from the water errand, eating from the nook plate, the chair creak from sit-down and stand-up (the creak returns as a *placed* sound, which is what distinguishes it from a cue), the coffee machine from the island pour. Then the roll keeps only what has no visible cause (keys, taps, murmur, the dog, the day pair).

**Rework: the viewer's own hand.** `plateOpen`/`plateClose` and `boardOpen`/`boardClose` are UI feedback on the room-tone layer. On `/broadcast` nobody clicks, so they never play there; on `/live` they are the only sounds that are not the room. Listen for: a paper rustle when opening the board reading as something happening in the office. Proposal: keep them, but under the act-cue toggle (feedback for the viewer), not the room-tone one.

**Cut or demote.** `whoosh` on every directed act: on a busy stream it is the most frequent moment after the door, and a sweep gesture is the shape `creak` was cut for. Listen for: whooshes as noise during a burst. Proposal: keep it for steer (interrupt-class) only; a plain directed message gets the cue and nothing from the room.

**Open question for nick.** `/live` defaults both engines off, so a first-time viewer hears nothing; `/broadcast` plays everything. Is the stream mix (bed + cues + moments at ×4) the one to judge first, since that is the one strangers hear?

## Falsifiers

- The table lists every `case` in `soundEngine.ts`'s `moment` and `life` dispatch and every key of `CUES` as of `c4ffb6fa`; falsify: a `case '<name>'` in either dispatch, or a `CUES` key, not in the table.
- "`footsteps` is not tied to anyone walking" (2026-10-27): falsify: `lifeAvailable('footsteps', …)` in `soundLife.ts` reading anything from `ctx`. <!-- claim: defect -->
- "an ask plays two sounds" (2026-10-27): falsify: `emit` in `office-scene/index.ts` not calling `roomTone.moment('askbell', …)` while `Stream.tsx` chimes `ask`. <!-- claim: defect -->
