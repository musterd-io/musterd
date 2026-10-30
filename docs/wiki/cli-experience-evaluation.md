# CLI experience: the end-to-end evaluation

The `cli-experience` goal, evaluated end to end on 2026-10-30 (lane `01M61VV4TX`) against the
shipped CLI on the live revive team, after the design record (lane `01M61VTWD`, #3598) and its
five follow-ups landed. Method: the built CLI (`node packages/cli/dist/bin.js`, `NO_COLOR=1`)
run as the ghost seat, plus each lane's test suite. Warmth-and-feel calls are a human's; where
this page makes one, it says whose eyes it was.

## The journeys, as they now run

**First run.** `init`'s connect path, the tour, and the watch path that binds the human were
exercised by lanes `01M61VT438`/`01M61VT9VV` and the journeys review (F1–F6, all landed). Not
re-run here: the passkey ceremony and interactive `init` remain human-only paths, as the
journeys review left them.

**Orientation.** `musterd status` (live, 2026-10-30): identity, `⚑ 5 waiting on you` with the
oldest first, your work with `landed · … submit` on merged lanes, up next, the team on one
line. One pointer per destination — `+38 more · musterd next` carries no second arrow
(lane `01M653WK0K`, #3600). `musterd next`: lane rows read `claimed · CLI experience:
validate the e… — 01M61VV4TX` — state first, title cut at the edge, short id; review debt puts
`lazara · waiting 75h` on its own dim line (lane `01M653W2N4`, #3603). Bare `musterd` lists
each start-here command once (verified live: four term rows, `next` only in START HERE).

**Messaging.** `musterd inbox --peek` now leads with `waiting on you — 6`: the directed
unread acts, in message-rows, before 574 general unread (ADR 770, lane `01M658ZSMQ`, #3609).
Empty and filtered views keep ADR 752's honest lines. One defect found, below.

**Completion.** `done` receipts and JSON-for-writes (ADR 758) stand as shipped; nothing in
this pass re-opened them.

**Recovery.** The daemon-down and unframed-reply errors now say what happened and what to do:
the unframed non-2xx reads "the daemon answered 500 without an error frame — retry, and if it
persists run `musterd status`…" (lane `01M653WNCD`, #3606). Live check of the shallow end:
an unknown command answers `✗ unknown command "badcmd" · musterd help` on one line.

**Copy.** The contrast frame is out of the surveyed strings, `session` reads Presence/seat
where that is the meaning, and the roster-home string no longer says "worktree"
(lane `01M653WKTK`, #3604). Two strings kept their shape deliberately: proper nouns keep
capitals, and "is the daemon running?" keeps the daemon named twice rather than thinning to
"is it running?" — the retry suite pins the fuller form and it reads clearer.

## The one defect this pass found

`status` said **5** waiting; the inbox section said **6**. Both surfaces use
`openActionNeeded`, but `status`'s count unions the answered/discharged sets across every
drained unread page (`claimCheckLines`, helpers.ts), while the directed section reads them
from the first bounded inbox response only. An act this seat already answered, sitting past
page one, still appears in the section. That is ADR 770's core promise — the two counts
cannot drift — not yet kept in this corner.

→ lane `01M65AB64H` (union answered/discharged across drained pages, with the answering act
beyond page one as the test). The section's ordering, dedupe, and read semantics behaved as
specified; only the count's inputs differ.

## What remains open

- The count-parity lane above.
- The three human-only paths from the journeys review (passkey ceremony in a real browser,
  interactive `init` with a person typing, a first agent's maiden launch) — still unexercised
  by an agent, still owed a human walk.
- Whether the daily view is *warm* — the goal's own words — is not an agent's call. The
  mechanics above are verified; the feel verdict belongs to the human who reads it daily.

## Verdict

The five journeys read as one experience now: the two register seams the design record named
(`next`'s grammar, the waiting count's landing) are closed in the shipped CLI. The one open
corner is the count parity measured above on 2026-10-30, carried by lane `01M65AB64H` —
falsifier: on a seat whose answered act sits past page one, `status` and the inbox section
print the same N. Every other proposal in the record is a named lane with its gate, listed in
the design record's seams; this page is the evidence they were checked against the shipped
CLI of 2026-10-30.
