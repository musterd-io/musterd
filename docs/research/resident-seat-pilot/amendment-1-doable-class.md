# Resident seat pilot — amendment 1: a lane must be doable from a workspace

Amends [the manifest](../resident-seat-pilot-manifest.md)'s `lane class` term on 2026-10-15,
after the worker seat's first wake. As the manifest requires, this note says why. Everything not
named here stands.

## Why

On pass 2 (2026-10-15) arm B (`mason`) was handed `01M3AMY549` (demo rehearsal B), which needs a
ChatGPT Business account and phones. Mason woke on it twice, at 10:59:44 and 11:04:47 PDT. Both
wakes reported within two minutes, and mason sent no act on either: no accept, no `blocked`, no
status. On pass 1 it had been handed `01M4FF0P6H` (Twitch inc 6), which needs nick's live box
session. That lane re-woke mason about once a minute overnight, 13 times, each wake a no-op
(insight `01M4Z8A0R1`). nick directed that mason not be given work it cannot actually do.

A screen on B alone would give B only the lanes it can finish and leave C every lane. That breaks
the comparison the kill criterion rests on, so the new term applies to both arms.

**Correction (2026-10-15 11:50 PDT).** Both pass-2 wakes on `01M3AMY549` described above, and all
six on `01M3W6GWVN` that followed (11:09 to 11:35), never ran the seat. Each lease is paired with a
`residency.wake_deferred` row whose reason is `API key variable ANTHROPIC_API_KEY is unset on this
host — the resident seat cannot run (ADR 588)`. They are a host outage, not mason going silent. The
last `residency.wake_cost` row for mason is at 00:44:41. So "mason sent no act" is true, but it
says nothing about how mason behaves. The overnight no-op wakes on `01M4FF0P6H` (insight
`01M4Z8A0R1`) are a separate reading and are not corrected here. The amendment stands on that
lane and on nick's direction. Deferred wakes are **not** counted as silent wakes. The finding
reports arm B's outage window from these rows and leaves it out of measure 1's latency.

## The added term

A lane is **in class** only if, in addition to the manifest's terms, it can be finished from a
seat's own workspace: no step needs a human's live session, a third-party account, a phone, or
hosted or streaming hardware. Unlike the manifest's other terms this one is a reading, not a row,
because the `lanes` table carries no field for it. The dispatcher records each exclusion with its
reason in the day's pass section of [window-start](window-start.md), so a later reader can recount
the class without it.

## How the finding reads it

- **From pass 3 (2026-10-16)** the term applies at allocation, to both arms.
- **Already handed:** at 11:09 PDT on 2026-10-15 nick's dispatcher (ryder) released the two B
  lanes that fail the term, `01M3AMY549` and `01M4FF0P6H`, back to the board, and sent mason a
  `steer` (`01M50C1XQ3`) so the intervention is on the record (Run protocol step 2). Both are
  reported as **excluded with intervention**, not as handed-and-unfinished. Their wakes stay in the
  spend and latency measures. The C lanes handed so far were checked against the term: one fails
  it, pass 1's `01M4FF0S55` (stream inc 7, dolly), which needs a Twitch viewer. It is reported
  excluded on the same terms but not taken back, because C's seats are attended and can say so
  themselves.
- **Readability floor:** with the two excluded, B holds 7 in-class lanes against the floor of 8.
  The floor is read over the window as amended.
- **A seat that wakes on a lane and ends with no act** is counted per arm as a silent wake and
  reported beside measure 2, whose numerator already carries its spend. A lease the host deferred
  (`residency.wake_deferred`) is not a wake of the seat and is not counted here.
