# Office sound inventory

Every sound the office can play on `/live` and `/broadcast` as of 2026-10-28 (sound identity inc 1 landed), where it comes from, what gates it, and the designer's keep / rework / cut verdict for the re-evaluation nick asked for (lane 01M6096TA7).

## How sound reaches a viewer

- **Two engines, both opt-in and default OFF on `/live`** (`live/sound.ts`): the *act cues* (`firehoseSound`, one of five gestures per act — `gestureFor`; the rest are silent) and the *room tone* (`roomTone`, a bed plus small life noises plus placed "moments"). Each has its own toggle and stored preference; a hidden tab never plays either.
- **`/broadcast` turns both on** without persisting (`enableForBroadcast`, ADR 228) and runs the whole mix through a ×4 master (+12 dB) measured against the hosted pipeline so the bed sits near −30 LUFS: audible, still background. Act cues on the stream are throttled to one per 700 ms (`BROADCAST_CUE_GAP_MS`); moments to one per 400 ms — except the chimes, which queue a beat apart instead of dropping (lane 01M625KHCN, 2026-10-28).
- **Everything is synthesized** in WebAudio. There are no audio files (ADR 151 bytes).

## Inventory

| Layer | Sound | When | Where it pans | Loudness (linear gain, pre-master) |
| --- | --- | --- | --- | --- |
| Gesture (stream cue) | `question` G4→C5 sine, second held | ask, request_help | centre | 0.09 — since 2026-10-28 (sound identity inc 1); replaces the `ask` and `request_help` cues |
| Gesture (stream cue) | `redirect` C4 tri, 120 ms | steer, challenge, decline | centre | 0.09 — replaces the `steer`, `challenge`, `decline` cues |
| Gesture (stream cue) | `handoff` E4 then G4, 300 ms apart | handoff | centre | 0.08 — replaces the `handoff` cue |
| Gesture (stream cue) | `arrive` D4→E4 sine | (scene-only until inc 2; the welcome `doorbell` already plays it) | centre | 0.07 |
| Gesture (stream cue) | `done` — one bar of the shelf chimes (the bar voice, C5) | accept | centre | 0.09 fundamental — replaces the `accept` cue |
| Folded | ~~`message`, `status_update`, `wait`, `defer`, `resolve`, `end`~~ | ~~each act~~ SILENT since 2026-10-28 (inc 1, spec §2.4): the office shows them and the eye is enough | — | — |
| Bed | air hum + slow swell | whenever room tone is on | centre | `ROOM_GAIN` 0.075 × air 0.34 |
| Life | `keys` (per-desk keyboard, thock + click) | a desk in its *typing* phase; weight 0.39 | that desk | per key 0.017–0.026 / 0.010–0.015, on `LIFE_GAIN` 34 |
| Life | `murmur` / `whisper` | only with two members actually near each other; 0.20 / 0.04 | the pair | lowpassed noise, 0.075–0.10 × level (whisper lower) — the quietest voice by 17 dB on the 2026-07-29 render; OK |
| Life | `tap` / `softTap` (pen on desk) | any working desk; 0.07 / 0.03 | that desk | click 0.045 / 0.018 since 2026-10-28 (inc 3; was 0.108 / 0.042, 4–5× a keystroke) — now 2× keys |
| Life | `stapler`, `drawer` | any working desk; 0.03 each | that desk | stapler clicks 0.03 + 0.07, drawer noise 0.05 since 2026-10-28 (inc 3; were 0.05 + 0.14 and 0.10, the two loudest noise events in the room) — now 2× keys |
| Life | ~~`footsteps`~~ | ~~always available; 0.03~~ LEFT THE ROLL 2026-10-27 (lane 01M5XS6KAD) — now `stepPlank`/`stepTile` moments per foot plant | the walker | — |
| Life | ~~`sip`, `water`, `blow`, `eating`~~ | ~~always available~~ LEFT THE ROLL 2026-10-27 (lane 01M5XS6KAD) — now `sipAt` on the sip beat, `bottle` at the cooler, `eatAt` at the couch plate; `blow` is gone | the body | — |
| Life | `paws`, `jingle`, `yawn`, `bark` | dog on the floor (paws: walking); 0.025 / 0.01 / 0.01 / 0.005 | the dog | paws click 0.035 (≈ keys); jingle sine pings 0.006–0.010 (quiet, bright); yawn lowpassed 0.05; bark bandpassed 0.12 — loud, and meant to be at 0.005 weight; OK |
| Life | ~~`birds`~~ LEFT THE ROLL 2026-10-28 (lane 01M625KHCN; nick: all morning on the stream, "doesn't really sound like birds") | ~~05:00–11:00 office clock with daylight; 0.03~~ | random side | sine chirps 0.0055–0.0085 — a sine at this gain lands near a 0.03 noise click; quiet and outside; OK |
| Life | `nightair` | dark room with someone in it; 0.02 | random side | sine pings 0.0035–0.0055 — the quietest thing the room plays; OK |
| Moment | ~~`fanfare`~~ REMOVED 2026-10-28 (inc 3; superseded by `laneDone`, emit site moved in inc 2) | an accept lands on a celebrant | the celebrant | sine pings 0.020–0.026 + sparkle clicks 0.012–0.020 — clearly above the bed, under the ask bell; OK (rare, earned) |
| Moment | `door` | a member walks in or out | the entrance | latch 0.04 + sigh 0.022 + steps 0.035 since 2026-10-28 (inc 3; halved — the door is the foley under the `arrive`/`leave` cousin now, −6 dB) |
| Moment | ~~`askbell`~~ REMOVED 2026-10-28 (inc 3; superseded by `question`, emit site moved in inc 2) | an ask arrives (one held tone) | the asked desk | one sine 0.018, held — a pure tone carries far more than a 0.018 noise burst; with the `ask` cue now at 0.10 this is the right pair: cue says *for you*, bell says *where*; OK |
| Moment | `whoosh` (welcome wagon's toss only since inc 2/3; superseded by `redirect` as the directed-act sound) | ~~a directed act sweeps from sender to recipient~~ a steer's redirect sweeps from sender to recipient (steer only since 2026-10-27, step 2) | sender → recipient | noise sweep 0.026 over 0.6 s — ≈ keys, and now once per steer; OK |
| Moment | `plateOpen` / `plateClose` | the viewer opens or closes a nameplate | the plate | click 0.035 (≈ keys) — viewer's own hand, `/live` only; OK at this level |
| Moment | `boardOpen` / `boardClose` | the viewer opens or closes the board overlay | centre | paper noise 0.03 — viewer's own hand, `/live` only; OK at this level |
| Moment | `ring`, `ratchet`, `rattle`, `doorbell`, `pop` | the Welcome Wagon (phone, label maker, wagon wheels, front-door chime, confetti) | their props | ring triangle 0.018 (quiet, across the room); ratchet clicks 0.03; rattle clicks 0.012; doorbell RETUNED 2026-10-28 (inc 1) to the `arrive` gesture at 0.014 — the same object as every other arrival; pop 0.05 + 0.01 sparkle, once; OK |
| Moment | `stepPlank` / `stepTile` | each foot plant of a walker covering ground (plank or café tile by the floor under them); own 110 ms gate | the walker | plank click 0.05 at 110–160 Hz, tile 0.035 at 1.3–1.8 kHz — plank ≈ 2× keys, tile ≈ keys; a walk is the right amount louder than typing; OK (since 2026-10-27, lane 01M5XS6KAD) |
| Moment | `creak` | a chair taking or losing someone's weight (the sit blend crossing 0.9) | the chair | narrow bandpass (Q 7) 0.05, 0.4 s — a third of the old timer creak; placed on a visible sit; OK |
| Moment | `sipAt`, `bottle`, `eatAt`, `machine` | the sip beat, the cooler fill, the couch plate, the island pour | the body / the fixture | sip bandpass 0.055 (bottle × 0.72 = 0.04); eat clicks 0.045–0.065; machine sawtooth hum 0.045 under a 180 Hz lowpass + hiss 0.018, a few seconds — each ≈ 1.5–2.5× keys, on a visible action; OK |
| Moment | `laneDone` | a lane reaches done (emit site: inc 2, landed) | the shelf chimes by the work board | bar voice, sine 0.022 (was 0.03 until inc 3) + partial ×0.22 + mallet breath ×0.3, 1.8 s decay — one bar per lane (`barForLane`), 1–3 bars by the chain (`voicesForChain`), rolled 15–40 ms apart; ≈ 3× keys, a struck bar across a room |
| Moment | `goalDone` | a goal reaches done (emit site: inc 2, landed) | the shelf chimes | all eight bars rolled 60–90 ms apart, 0.02 each, the top 0.024 held 2.6 s (trimmed in inc 3) — the loudest thing the room plays, and the only time all eight sound |
| Moment | `question` / `redirect` / `handoffSend` / `handoffAnswer` | the gestures, placed (emit sites: inc 2, landed) | the asked desk / the redirected desk / each desk of a handoff | the gesture recipe at the room's scale: sine peaks 0.018 / 0.02 / 0.016 / 0.016 — the old askbell's level; the handoff answer lands 0.42 s after the note (inc 3 stripped the recipe's own 0.3 s from the placed moment) |
| Moment | `arrive` / `leave` | a member walks in or out (emit site: inc 2, landed; `door` is the foley under it at −6 dB since inc 3) | the door cousin above the entrance | D4→E4 up, E4→D4 down, sine 0.014 |

How to read the Life and Moment loudness column (filled 2026-10-28, step 3): every Life event and Moment rides the one `LIFE_GAIN` ×34 bus, so the numbers are envelope peaks *relative to each other*, and the calibrated reference is a keystroke at 0.017–0.026, measured on 2026-07-30 at the bed's level (+0.4 to +1.3 dB). A noise event at 2× keys is about +6 dB over the bed, which is where a foreground sound in a real room sits; at 4–5× it is +13 dB, the level the keystroke was cut from for being too loud. A pure tone (sine or triangle) at the same envelope value is far louder than a bandpassed noise burst, because the bandpass throws away most of the energy and the oscillator keeps all of it, so the sines (`askbell`, `doorbell`, `fanfare`, `birds`, `nightair`, `jingle`, `ring`) are judged on that scale, not the clicks'. Readings carry about ±3 dB; the column flags only differences larger than that. Since inc 3 (2026-10-28) the `click` voice has a wider band (Q 1.6, was 2.2) and a slower edge (8 ms attack, was 4): every transient in the room is rounder, at the same envelope.

Life events fire every 2.5–8 s in a quiet room, about twice as often under full work density (`lifeGapFor`). `chime` and `creak` were cut on 2026-09-02 because they could be mistaken for a cue (the one rule the bed has).

## What I can and cannot judge from here

The verdicts below are design judgements from the synthesis, the gates and the stream's measured loudness. I cannot listen in this harness, so **which of these actually sounds wrong is nick's ear**; each verdict names what to listen for.

## Verdicts

**Re-decided 2026-10-28 — the sound identity** (`docs/superpowers/specs/2026-10-28-office-sound-identity-design.md`): the room stays foley and is re-levelled (inc 3); the musterd layer becomes one voice — the shelf chimes for finished work, five gestures in all, everything else folded into the room. Inc 1 (this page's table) is the synth; inc 2 moves the emit sites; inc 4 draws the chimes. Inc 3 re-levelled the room to the numbers above. The verdicts below predate it and stand where they do not conflict.

**Keep as is.** `keys`, `murmur`/`whisper`, `tap`, `stapler`, `drawer`, the dog set, `birds`, `nightair`, the bed. Gated on something the eye can see (a typing desk, a pair, the dog, the clock), placed where it happens, rare where it should be. They are the office being inhabited.

**Keep, re-level.** `askbell` and the `ask` cue both fire on one ask, from the same desk, and `ask` was the loudest cue in the table. Listen for: an ask arriving as two sounds. Proposal: the cue carries the "for you" and the bell carries the "where"; drop the cue's gain to the `message` level, or play the bell alone on `/broadcast`. DONE 2026-10-27 (step 2): the cue is at message level (0.10); the bell is unchanged.

**Keep, re-level (step 3, 2026-10-28).** Three noise events sit at the level the keystroke was pulled down from: `tap` (0.108), `stapler` (0.14 on its second click) and `drawer` (0.10) are 4–5× a keystroke, +13–14 dB, which on the stream is a pen crack across the room every few seconds. Listen for: taps and the stapler jumping out of an otherwise even bed. Proposal: `tap` to 0.05, `softTap` to 0.02, `stapler` to 0.03 + 0.07, `drawer` to 0.05 — twice a keystroke, like the steps and the sip, so the desk sounds sit on one scale. DONE 2026-10-28 (inc 3). `doorbell` (sine 0.04) is twice the ask bell and the loudest pure tone in the room; proposal: 0.02, under the bell, since a new teammate's chime should never out-ring a question for the viewer. `door` (0.045) is fine alone, but it is the most frequent moment on a busy stream; hold at 0.045 and drop to 0.03 only if nick hears it as a door slamming all day. DONE 2026-10-28 (inc 3): halved, as the foley under the door cousin. Everything else in the two layers is within ±3 dB of where its role puts it and is kept as is.

**Rework: tie to motion (lane 01M5XS6KAD).** `footsteps`, `sip`, `water`, `eating`, `blow` play from a random side on a timer, while the office now has real walks, sip beats, water errands and plates. A footstep nobody is taking is the thing the `creak` cut was about. Proposal: these leave the life roll and fire from the choreography — footsteps from a walker's stride (plank vs tile by the floor under them), the sip from the sip beat, the bottle from the water errand, eating from the nook plate, the chair creak from sit-down and stand-up (the creak returns as a *placed* sound, which is what distinguishes it from a cue), the coffee machine from the island pour. Then the roll keeps only what has no visible cause (keys, taps, murmur, the dog, the day pair). DONE 2026-10-27 (lane 01M5XS6KAD): the five left the roll, the placed moments above replaced them, and an empty office with nothing available now says nothing at all (`pickLifeEvent` → null).

**Rework: the viewer's own hand.** `plateOpen`/`plateClose` and `boardOpen`/`boardClose` are UI feedback on the room-tone layer. On `/broadcast` nobody clicks, so they never play there; on `/live` they are the only sounds that are not the room. Listen for: a paper rustle when opening the board reading as something happening in the office. Proposal: keep them, but under the act-cue toggle (feedback for the viewer), not the room-tone one. OPEN 2026-10-27: the ticks are synthesized by the room-tone engine, which only runs while that toggle is on, so moving them needs either a third synth home or a toggle redesign — nick's call before it is built.

**Cut or demote.** `whoosh` on every directed act: on a busy stream it is the most frequent moment after the door, and a sweep gesture is the shape `creak` was cut for. Listen for: whooshes as noise during a burst. Proposal: keep it for steer (interrupt-class) only; a plain directed message gets the cue and nothing from the room. DONE 2026-10-27 (step 2): the whoosh plays only when the tethered act is a steer.

**Stream first, then `/live` follows (decided 2026-10-28, step 3).** `/live` defaults both engines off, so a first-time viewer hears nothing; `/broadcast` plays everything. The mix to judge is the stream's: it is the one strangers hear, and it is the one with a measured loudness (−30 LUFS bed at ×4). `/live` is the same mix at ×1 for a viewer who opted in on headphones, so a relative fix (one event too loud against the rest) is right on both and is made once in the synth; only the master differs, and the master is not in question. The ×4 is retuned at `BROADCAST_MASTER_GAIN` alone, never per sound. Falsify: a per-sound gain that differs between `/live` and `/broadcast` in `soundEngine.ts`.

## Measured 2026-10-28 (inc 3)

Rendered through an `OfflineAudioContext` on the dev server (mono, 44.1 kHz, six renders averaged, each voice straight into the render's gain so the bus makeup cancels), peak dBFS against a keystroke click at 0.026, after the re-level:

| Voice | Over a keystroke | Role |
| --- | --- | --- |
| `tap` / `softTap` | +1.3 / −5.9 dB | desk foley, at or under keys |
| `stapler` | +6.4 dB | foreground action, 2× keys |
| `drawer` | +3.2 dB | foreground action |
| `door` (foley) | −0.8 dB | under the arrive/leave cousin |
| `stepPlank` / `sipAt` | −6.4 / +3.3 dB | on a visible action |
| `question` / `arrive` bells | +7.5 / +7.3 dB | 2× keys, a pure tone |
| `laneDone` one bar / three | +11 / +17.7 dB | the chimes, a struck bar across a room |
| `goalDone` roll | ~+18 dB (was +21 before the trim) | the loudest thing the room plays, once |

The harness resolves about 3 dB, so everything in the room sits where its role puts it; the chimes are the only voices deliberately above the foreground band.


## Falsifiers

- "the room foley sits within 3 dB of the inc 3 render table" (2026-10-28): falsify: a re-render putting any room foley more than 3 dB outside that table. <!-- claim: other -->
- The table lists every `case` in `soundEngine.ts`'s `moment` and `life` dispatch and every key of `CUES` as of inc 1 (2026-10-28); falsify: a `case '<name>'` in either dispatch, or a `CUES` key, not in the table. <!-- claim: other -->
- ~~"`footsteps` is not tied to anyone walking" (2026-10-27)~~ FIXED 2026-10-27 by lane 01M5XS6KAD: `footsteps` is no longer in `LIFE_EVENTS`; falsify: a `footsteps` entry back in the table. <!-- claim: defect -->
- "an ask plays two sounds" (2026-10-27): falsify: `emit` in `office-scene/index.ts` not calling `roomTone.moment('askbell', …)` while `Stream.tsx` chimes `ask`. <!-- claim: defect -->
