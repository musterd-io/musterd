# 686 — The office is never still for more than about a minute

- Status: accepted
- Date: 2026-10-20

## Context

The office's idle life is a shared, seeded lattice (`ambientSeed.ts`, the E1 spec; companions in
[ADR 617](617-companion-gesture.md)). Every 10 s slot, every viewer derives the same decision from
the roster: a pet beat, a desk chat, an aisle meet, or one member's beat. Since
[ADR 464](464-live-audience-first.md) §3.1, a member whose posture is `working` keeps their
desk and gets only seated gestures. Errands, desk chats and aisle meets go to members between tasks.

On 2026-10-20 nick watched the Twitch stream and asked whether it had frozen: the audio played,
bubbles appeared and the fans turned, but no figure moved for long stretches.

## Problem

The idle members could never walk. `ambientPool` drew its candidates from desk-seated members only.
E1a kept "the scheduler's desk test, unchanged", and no decision chose that test on its merits.
Seating (`seating.ts`) puts idle members on the leisure furniture first. So the people ADR 464 allows
to walk were the people the pool never asked, and the people it asked were mostly working. Walking
was left entirely to the lattice's chance draws: an aisle meet, or an errand in about one member beat
in six.

Measured with a walk-gap sampler on `/office-preview?quiet`. It reads each figure's floor position
every 500 ms; a "still stretch" is the time with no figure moving.

| Room | Walks in the run | Longest still stretch |
| --- | --- | --- |
| 14 seats, ~10 idle (the revive mix that afternoon) | 0 in 10 min | the whole 10 min |
| 14 seats, everyone idle | 4 in 10 min | 7.1 min |
| 14 seats, default fixture | 3 in 20 min | 8.3 min |
| 8 seats, default fixture | 0 in 20 min | the whole 20 min |

## Decision

1. **The pool is everyone seated.** `ambientPool.members` holds present members at a desk OR on the
   leisure furniture. `errands` stays "members whose posture is not `working`", so ADR 464 §3.1 is
   unchanged: a working member still never leaves their desk. Desk chats stay desk-only. The beat
   pick already has a lounging variant, and every errand already starts from the member's home seat,
   wherever that is.
2. **A walk floor.** `WALK_FLOOR_SLOTS` = 5 (about 50 s). When that many slots pass with no walk
   decided (no aisle meet, no floor walk), the next slot is a walk, whatever its own roll said. Either
   35% of the time an aisle meet between two members who may walk, or one walker's errand. The
   errand spends the rotation's next turn when that member may walk, so ADR 617's coverage holds, and
   otherwise goes to a seeded pick of the idle members. Each 10-minute coverage window opens with a
   walk due, so a still stretch never straddles two windows. It is counted over the decided sequence,
   so every viewer agrees.
3. **A decided walk walks.** A floor errand this browser cannot start (the fridge with the lounge
   full, say) falls back to a coffee run, as does any aisle meet whose two members would never reach
   each other. A floor walk may also play while someone is mid-gesture or a cue is fading; it waits
   only for nobody else to be on their feet. These are per-browser fallbacks: which errand plays can
   differ between viewers for one slot, but whether someone walks cannot.
4. **When everyone is working, nobody is sent.** With no member who may walk, the floor never fires.
   ADR 464's rule wins over liveliness: the room then moves only with real acts and the dog.

The rotation's no-repeat guard now judges against the member actually taken last, not the last of the
lap's shuffled order. A deferred companion turn could change who really went last, and the floor's
extra turns made that visible as the same member twice running.

## Consequences

- The measurement above, re-run with the change on the same fixture, is in the table in
  Observability & Evaluation.
- Room density is higher: about 2.5–4 walk starts per minute where it was near zero. That is more
  frames drawn on every viewer, inside ADR 086's limits (20 fps ambient cap, suspended when the room
  is unseen).
- A room where everyone is working is still allowed to be still apart from real acts, by
  Decision 4. If that reads as frozen on the stream, the answer is a different beat for working
  members, not sending them walking.

## Observability & Evaluation

- Traces: none. The page's `__office.ambientLog()` already records every slot's decision and whether
  it played.
- Eval: the walk-gap sampler (`scripts/perf/office-walk-gaps.mjs`) reports walk starts per minute,
  the share of time someone is walking, and the longest still stretch. Bar: the longest still stretch
  stays at or under 90 s in a 10-minute run on any room with at least one idle member.

  | Room (10 min, after) | Walks/min | Someone walking | Longest still stretch |
  | --- | --- | --- | --- |
  | 14 seats, ~10 idle | 3.4 | 29% | 49 s |
  | 14 seats, everyone idle | 3.4 | 28% | 43 s |
  | 8 seats, 3 idle | 3.7 | 39% | 33 s |

  Intermediate rounds showed what each part of the Decision buys. With the pool widening and a 60 s
  floor alone, the longest stretches were 92 s, 79 s and 153 s. Adding the coffee fallback for floor
  errands gave 76 s and 113 s. Letting the floor play past gestures gave 94 s and 104 s. The last
  round added the fallback for every meet and the 50 s floor.
- Experiment: n/a. This is a floor with a measured bar, not an A/B.
