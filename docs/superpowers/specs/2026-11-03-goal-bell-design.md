# The goal bell — design

**Date:** 2026-11-03 · **Owner:** miley (designer) · **Asked by:** nick · **Status:** design, not built ·
**Lane:** `01M6HBK1KKYRN5K66R4HJ714BN`

## Intent

nick, 2026-11-03: "instead of chimes, can we have a bell that members can ring for completed work?
ive seen this on the show selling sunset when an agent makes a sale". In that show the bell is a
ritual: the person who closed the deal walks over and rings it, and the whole office stops and
cheers. Finishing a goal should feel like that in the musterd office: a moment the whole room
shares, visible from across the room and on /broadcast.

A single lane finishing is smaller and happens far more often, so it gets a small signal and no
ceremony. nick: "we need something smaller/more subtle for when a lane is done … a soft ding and a
little glow at their desk".

## What happens

### A goal ships

1. **The ringer** gets up from wherever they are and walks to the bell.
2. **The room turns.** Every other member in the room stops what they are doing (typing, a coffee
   run, a conversation) and turns to face the bell.
3. **The ring.** The ringer takes the rope and pulls it: the bell swings and rings, a long brass
   ring.
4. **Applause.** As the bell rings, everyone else claps.
5. **Back to work.** The ringer walks back, and the room carries on.

The same moment plays on /live and /broadcast.

### A lane is done

A soft ding and a small warm glow at the desk of the member who finished it. Nobody gets up and the
room does not turn.

## The bell

- **A brass bell on a wall bracket over the work board**, where the shelf chimes hang today (nick:
  "yes, over the work board"). It replaces the chimes, which are removed: their bars, their swing,
  their notes and their layout test.
  Only the office's chimes go: the object and the `laneDone` and `goalDone` moments they played. The
  bar voice and the pentatonic scale stay, because the stream's accept chime and other cues use them
  (`soundEngine.ts`).
- **A rope hangs from it** down beside the board, and must not cover anything that matters on the
  board: the goal tabs in the left gutter, the columns and their notes, and the read strip (nick:
  "maybe there is a string/rope hanging down from the bell (but doesnt cover anything important on
  the work board)").
- **The work-board sign moves to the centre of the board**: it sat over the right half only because
  the chimes held the left (signs lane `01M6FXKVDD`, PR #3765).
- It is rendered art like the other wall fixtures (Blender, `scene.py`), in the signs' brass. The
  swing is live: the rendered bell is drawn at its swing angle while it rings.

## Constraints

- **Nothing about what is recorded changes.** The bell reads the same events the chimes read today:
  a lane reaching done (`walk-pin` with state `done`) and a goal shipping (`goal-done`, from a goal's
  outcome note, `mapping.ts`). Replays and history ring nothing, as today.
- **Sound is not motion.** With reduced motion on, nobody walks or claps: the bell still rings, it
  swings no further than a small tilt, and the room's light warms briefly. The lane ding still plays.
- **The office's existing rules hold**: render loops stop when unseen, the perf and art byte budgets
  (`docs/perf/budgets.json`), the figures' pose pipeline, and walking paths (`nav.ts`).
- **The ding is not the question bell.** A question already rings a two-note bell at the asked desk
  (sound identity spec §2.3). The lane ding must be clearly a different sound: one soft, single note.

## What nick decided

- The bell replaces the chimes; it hangs over the work board, with a rope that clears the board's
  content.
- A goal shipping: a member walks to the bell and rings it, all others watch and clap.
- A lane done: a soft ding and a little glow at their desk.

## miley's calls (nick can overrule)

- **Who rings it.** The member who recorded the goal's outcome (`goal-done`'s `who`), if they have a
  figure on the floor right now, human or agent; else nobody walks, and the bell rings by itself
  while the room still turns to it and claps. (No "closer of the last lane" fallback: the client keeps
  no goal-to-closer record, and building one would mean new state or new data.)
- **Where the rope hangs.** Down the board's right edge, outside the frame, in the plaster between the
  board and the wall's end; the bell sits on a bracket at the board's top-right corner.
- **Where the ringer stands.** At the board's right end, reached from `BOARD_STAND`'s row.
- **Who claps.** Every member present in the room except the ringer: online members and visitors on
  the floor. Members who are away (not in the room) do nothing.
- **Goals close together.** One ceremony at a time. A goal that ships while a ceremony is playing
  adds one more strike to it instead of a second ceremony, however many arrive. A goal that ships
  after the ceremony ends starts a new one.
- **Whose desk dings.** The member who closed the lane (`walk-pin`'s `who`), one note, one desk. The
  chimes' chord (one voice per seat in the lane's chain) goes away.
- **A goal's last lane still dings** at its closer's desk; the bell follows once the ding has played
  (the gap the chimes keep today, about 0.4 s), and the ringer stands up after it.
- **The ding is a smaller, higher cousin of the bell**, so the two read as one family. The desk glow
  is brief (about a second and a half) and warm, in the lamp colour.
- **The bell's sound is a recorded take**, licensed for reuse like the office's other recorded sounds
  (ADR 776), if a clean one can be found; otherwise synthesized like the chimes were. Either way it
  is a long ring that fades, not a short ding.
- **Timing.** The ringer's walk is at their normal pace; the room turns as the ringer stands up; the
  claps start on the first strike and last about two seconds.

## Left to the builder

- The new figure poses (a two-handed rope pull; clapping; turning to face a point) and how they fit
  the existing gesture vocabulary (`skeleton.ts` `GESTURE`) and the figure pipeline (`figure.py`,
  `figure.json`).
- The bell's exact model, size and bracket, and the rope's length and sway.
- How members interrupt what they are doing and resume it after.
- How the moment is staged on /broadcast's framing.

## Non-goals

- No new event or protocol change.
- No bell for anything other than a goal shipping; no change to the question and handoff bells.
- Nobody rings the bell by clicking it.
