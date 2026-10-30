# 776 — Recorded sound samples for the office room

- Status: accepted
- Date: 2026-10-30

## Context

Every sound the `/live` office plays has been synthesized in WebAudio from oscillators and filtered
noise. No audio file ships, which kept the sound layer at zero bytes on the wire (the office art and
the bundles carry their own budgets, [ADR 151](151-web-perf-budgets-gate.md)/183).

On 2026-10-30 nick listened to every sound in a row on a soundboard rendered from the real synth. His
read: apart from the keyboard, the sounds were "very annoying/similar" and played too often. Lane
01M67C125R cut most of the room foley. For the sounds he wanted kept but made "more realistic", the
door, sip, eating, the dog, and the viewer's own nameplate and board clicks, better synthesis was
offered and declined in favour of recordings.

## Problem

Most of the synthesized foley was one recipe, a short burst of bandpassed noise at a different
centre frequency. However it is tuned, a door, a bark and a page turn built that way share one
timbre and read as artificial. Making these sounds realistic means real recordings, which means
shipping audio bytes, and nothing in the budget gate counts or caps them.

## Decision

1. **The office may ship short recorded samples** for room foley, as
   `packages/web/src/live/sounds/office-sound-<voice>-<n>.mp3`: mono, 44.1 kHz, 48 kbps. A voice may
   have several takes, and one is picked at random per play and nudged in pitch so repeats differ.
2. **Sources must be CC0 or public domain, needing no attribution.** Each file's source clip is named
   in `docs/wiki/office-sound-inventory.md`. The first set comes from BigSoundBank (CC0).
3. **They load lazily.** Only URLs live in the sound-engine chunk. The bytes are fetched once the room
   tone starts, which needs the viewer's own click on the sound button. A voice plays its synth recipe
   until its takes have decoded, and keeps playing it if they fail to load.
4. **Levels match what they replace.** Each take's gain on the LIFE bus is set so its peak matches the
   synth voice it replaces, so changing the source does not also change the mix.
5. **They get their own budget line.** `officeSoundBytes` in `docs/perf/budgets.json`, at 160,000 B, is
   checked by `pnpm perf:check` over every `office-sound-*.mp3` the build emits. Raising it is
   deliberate and logged, the same way as `officeArtBytes`.
6. **Synthesis stays the default.** The musterd voice (the gestures and the shelf chimes) and the
   keyboard remain synthesized. A recording replaces a voice only after nick has heard it on the
   soundboard.

## Consequences

- The first set of 11 takes covers the door (2), sip (2), eating (2), bark, collar jingle (2),
  nameplate and board, about 101 KB. The whisper takes were heard and rejected as creepy, so chatter
  was cut instead.
- Recordings for the water bottle, plate and cutlery, coffee machine, wagon phone, wagon wheels,
  front-door chime and confetti are still to come. Those voices stay synthesized until then. The paws,
  yawn, label maker and toss have no source yet.
  Follows-up: lane 01M67CQQQK (the second set, auditioned on the soundboard first).
- A viewer who never turns sound on downloads none of these bytes.

## Observability & Evaluation

- Traces: n/a. No new events, and a take that fails to load falls back silently to synthesis, by design.
- Eval: `pnpm perf:check` fails if the emitted `office-sound-*.mp3` files pass `officeSoundBytes`.
  The soundboard artifact renders each take beside the synth voice it replaces, for the by-ear check.
- Experiment: n/a. This is a quality call made by ear (nick, 2026-10-30), not a measured hypothesis.
