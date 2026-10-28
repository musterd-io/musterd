# Office sound identity: one instrument, five gestures, a warmer room

**Date:** 2026-10-28 · **Owner:** miley (designer) · **Decided with:** nick

What the `/live` and `/broadcast` office sounds like, re-decided from the sound re-evaluation lane
(`01M6096TA73JQDSD9A4PCDQENH`, inventory: `docs/wiki/office-sound-inventory.md`). This design
replaces the act-cue layer and the milestone moments; it keeps the room foley and re-levels it.

## 1 Why

nick, 2026-10-28, on the inventory of what plays today: "i want to reevaluate the existing sounds.
we need sounds that are all unique/relevant to musterd and also extremely magical, warm, fun,
helpful, smooth, delightful" — and, pressed on which to get exactly right: "when a lane/goal is
done. to emphasize — i dont want generic/cliche sounds effects." He still wants "somewhat realistic
office foley".

Today the office has two sound layers, and neither is ours. The room is generic foley (keys, pen,
stapler, drawer) at uneven levels — three events sit +13 dB over a keystroke, where the keystroke
itself was once cut from for being too loud. The musterd layer is twelve unrelated sine blips, one
per act, plus a `fanfare` for an accept that is the cliché exactly: a rising arpeggio and sparkle,
the sound every app plays when you tick a box. Nothing in it could only have come from this room.

Success: after ten minutes on the stream a stranger knows a lane finishing by ear without looking,
finds it warm rather than notifying, and the room under it sounds like a real office that nobody
has to think about.

## 2 What is decided

### 2.1 Two layers, two jobs

- **The room** (foley) stays realistic. Its job is to never draw attention: it is the office being
  inhabited. Keys, pen, drawer, steps, chair, sip, cooler, plate, machine, the dog, birds, night air,
  the bed. It is kept and re-levelled (§2.5), not redesigned.
- **The musterd layer** is the signature: everything that only happens because the team did
  something. It gets one coherent voice — one scale, one timbre family, five gestures — and every
  sound in it comes from an object that is real in the scene, so it never reads as a notification
  pasted over foley.

### 2.2 The instrument: the shelf chimes

One object in the room is musterd's and only musterd's: a short row of hanging bars on the wall,
beside the work board (`WALL_BOARD`, `layout.ts`), so the thing that rings for finished work hangs
next to the thing that shows it. Eight bars, wood with a metal sleeve in the render, one note each.

- **Scale:** C major pentatonic from C4 to E5 (C D E G A C D E; corrected 2026-10-28 in inc 3 — the first draft said E6). Pentatonic so that
  any bars struck together are consonant: a busy day cannot play a wrong note.
- **Timbre:** a struck bar — soft mallet attack (no click), a fundamental with one inharmonic
  partial at ×2.76 for the "bar" quality, 1.5–2.5 s decay, a touch of air. Warm, not glassy. The
  synth is WebAudio like everything else (ADR 151: no audio files).
- **Lane done:** one bar struck. Which bar is a hash of the lane id onto the eight, so the same
  lane always rings the same note and a day of shipped lanes plays a slow melody nobody composed.
  It never plays the same twice: ±4 cents, ±8% attack gain, ±15% decay, jittered per strike.
- **The chord thickens with the people:** a lane rings as many bars as distinct seats in its chain
  (requested-by, owner, acceptor — 1 to 3). Extra voices are the next bars up the scale, struck
  15–40 ms apart, so a solo lane is one note and a team lane is a small rolled chord.
- **Goal done:** the whole scale rolled once, bottom to top, 60–90 ms between bars, the top bar
  allowed to ring out. It is the only time all eight sound.
- **Accept** (the old `fanfare`) is a lane done's sound: the accept is what makes the lane done, and
  the room should not say it twice. The confetti stays.
- **Visible:** the struck bar swings for its decay (overlay, not re-bake), so a viewer who looks can
  see what rang. No figure walks to it; the room strikes it.

### 2.3 The five gestures

Everything a stranger needs to tell apart by ear. All in the pentatonic scale; all from an object.

| Gesture | Acts | Object | Shape |
| --- | --- | --- | --- |
| **Done** | lane done, goal done, accept | shelf chimes | §2.2 |
| **Question** | ask, request_help | the bell on the asked desk | two notes, rising a fourth (G→C), the second held, unresolved. Replaces `askbell` and the `ask`/`request_help` cues. |
| **Redirect** | steer, challenge, decline | the same desk bell, stopped | one low note (C4) damped short, 120 ms, with the mallet's thud left in. The one sound allowed to be a little tense; decline is the quietest of the three. Replaces the `whoosh`. |
| **Arrival / departure** | a member walks in or out | a small cousin of the chimes above the front door | arrive: two bars up (D→E); leave: the same two down. Replaces `door`'s generic creak-and-latch, which becomes the foley under it at −6 dB. |
| **Passing hands** | handoff | both desks' bells | one note at the sender's desk, the answer a third up at the receiver's, 300 ms later, panned each to its desk. |

### 2.4 What folds into the room

`message`, `status_update`, `wait`, `defer`, `resolve`, `end` lose their cues. The office already
shows them (a glance, a bubble, the board), and the eye is enough. A message is keys and a glance; a
status update is silence. The `CUES` table in `soundEngine.ts` shrinks to the five gestures, and
`Stream.tsx`'s per-act chime maps every other act to no sound. The Welcome Wagon props (`ring`,
`ratchet`, `rattle`, `doorbell`, `pop`) are kept as foley for that scene, with `doorbell` retuned to
the arrival gesture so a new teammate's chime is the same object as every other arrival.

### 2.5 The room, re-levelled

The reference is a keystroke (0.017–0.026 envelope on the ×34 LIFE bus), measured at the bed's
level. Foreground actions sit at about 2× keys (+6 dB). Three events sit at 4–5× and come down:
`tap` 0.108→0.05, `softTap` 0.042→0.02, `stapler` 0.05+0.14→0.03+0.07, `drawer` 0.10→0.05. The
rest of the room (steps, sip, creak, machine, plate, the dog, birds, night air) is within ±3 dB of
its role and is unchanged. "Warm" in the foley means softer transients: the `click` voice's attack
goes from 4 ms to 8 ms and the bandpass Q from 2.2 to 1.6 across the board, re-measured after.

### 2.6 Loudness and the stream

The stream mix (×4 master, bed at −30 LUFS) is the one judged. Every new voice is set relative to
the keystroke on the LIFE bus, once, in the synth; `/live` at ×1 inherits it. The chimes sit at
about 3× keys (a struck bar across a room), the desk bells at 2×, the door cousin at 2×. Nothing in
the musterd layer is louder than the goal roll, and the goal roll is the loudest thing the room ever
plays. Throttles stay: one milestone moment per 400 ms on the stream, so a burst of accepts rings
once and the rest are dropped, never queued.

## 3 How it gets made

- **Synth:** `packages/web/src/live/soundEngine.ts` — a `bar(ctx, out, freq, …)` voice and a
  `chimes` family; the `CUES` table replaced by the five gestures; `Moment` union gains
  `laneDone`, `goalDone`, `question`, `redirect`, `arrive`, `leave`, `handoffSend`, `handoffAnswer`
  and loses `fanfare`, `askbell`, `whoosh`, `doorbell`. The pure logic (which bar for a lane id, how
  many voices for a chain, the roll timing) lives in `soundLife.ts` where tests hold it without an
  AudioContext.
- **Emit sites:** `office-scene/index.ts` — the `accept`/`fanfare` site becomes the lane-done
  site; a goal reaching done emits the roll (the goal grid already knows a goal shipped,
  `goalGrid.ts`); the ask site emits `question`; steer/challenge/decline emit `redirect`; the door
  site emits `arrive`/`leave`; handoff emits the pair. `Stream.tsx` stops chiming the folded acts.
- **Scene:** the shelf chimes are a baked prop in `packages/web/art/office/scene.py` beside the
  work board, re-rendered for the room layers only (not the figure); the swing is an overlay
  painter in `office-scene/` keyed on the struck bar.
- **Inventory:** `docs/wiki/office-sound-inventory.md` is rewritten to the new table in the same
  PR as the synth (hard rule 3).

## 4 Goals, non-goals, anti-goals

- **Goals:** a done you know by ear; one voice for the musterd layer; a room that never draws
  attention; every sound from an object in the scene.
- **Non-goals:** music. No bed melody, no key changes, no tempo. The scale exists so accidents are
  consonant, not so the room plays songs. No audio files. No change to the `/live` default (both
  engines stay opt-in and off).
- **Anti-goals:** anything a stranger has heard in another app — a rising major arpeggio, a
  "ding", a swoosh, a cash-register, a level-up. A cue that plays when nothing visible happened.
  The same sound twice in a row that is bit-identical.

## 5 Constraints

ADR 151 (bytes: WebAudio only, no samples); ADR 228 (the ×4 master is the one stream knob); the
400 ms moment throttle and 700 ms cue throttle on the stream; reduced-motion keeps the sound and
drops the swing; hidden tabs play nothing; the ADR 150 lane gate on `office-scene/**`.

## 6 Increments

| # | Increment | Lane |
| --- | --- | --- |
| 1 | The bar voice, the chimes family and the five gestures in the synth; the folded acts go silent; inventory rewritten | `01M61R493R3PE8EMD2JTVBJWF4` |
| 2 | Emit sites: lane done (chain-sized), goal roll, question, redirect, arrive/leave, handoff pair | `01M61R4CBAFSSR15NSYKEBNEWS` |
| 3 | The room re-level (§2.5) and the softer click, re-measured | `01M61R4F1345Q7VRB959G2M559` |
| 4 | The shelf chimes prop baked beside the work board, and the swing overlay | `01M61R4HQ31CNSCG6PSV1YNGCQ` |

1–3 ship without 4 and are audible on the stream the same day; 4 makes the instrument visible.

## 6.1 Settled after the builder check (2026-10-28)

nick's answers:

- **Every done rings.** The chimes strike on a lane's state reaching `done` by any route (accept,
  self-close, exempt close, admin close); `abandoned` is silent. Keyed on the state change, once per
  lane, never on the accept act itself, so an accept and the state change cannot ring twice.
- **Sound ships before the prop.** Increments 1–3 are audible before increment 4 draws the chimes;
  the board column moving on a done is the visible thing until then.

miley's calls:

- A lane whose chain the client cannot see rings one voice. Adding the chain to the client payload
  is increment 2's choice if cheap, else a follow-up; never a server change inside this design.
- The chimes are panned to the board, not the celebrant, and play whether or not the celebrant is
  in the room; the confetti still needs them present.
- A goal roll arriving in the same instant as its last lane's chord **replaces** the chord (the roll
  wins; the lane note is its first bar). The throttle is per kind for these two only. Goals already
  done on page load or replay stay silent.
- Redirect covers the `steer`, `challenge` and `decline` acts (reply acts), not lane-level closes.
- Departure is the existing walk-out door event, not presence loss. Arrival and departure count
  against the 400 ms moment throttle.
- A question plays once, from the scene; the stream's own `ask` chime goes silent when the room
  tone is on, and plays the same gesture centred when it is the only engine on. A team ask with no
  addressee is centred.
- Per-strike jitter satisfies "never bit-identical"; the same lane twice keeps its note.

## 7 Left to the builder

The exact partial ratios and filter shapes of the bar voice; the hash from lane id to bar; where
exactly on the wall the chimes hang and how large (they must not cover the board); whether the
door cousin is drawn or implied; the test fixtures. The builder listens on the stream before
calling an increment done and writes what they heard in the PR.

## 8 Risks

- A bar voice synthesized from sines can sound like a 1990s keyboard. Mitigation: the inharmonic
  partial, the air, and the jitter; if it still reads as a preset, add a second detuned partial
  before adding anything else.
- The folded acts go silent and someone misses `message`. The toggle is unchanged; if a human asks
  for it back it returns as foley (keys), not as a cue.
