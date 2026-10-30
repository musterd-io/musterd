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
(lane `01M653WK0K`, #3600). `musterd next` (re-run at 80 columns on the merged CLI,
2026-10-30): carrying rows give the title the line — `blocked · First-run tour cold read
with a new human at the keybo… — 01M4V751KR`, goal/areas/branch on the dim line under it;
the stale-goal warning reads `⚠ <goal> · quiet 3d` over a short-id lane row; the
`↳ no wake due` detail and seed summaries cut at the edge (lane `01M653W2N4`, #3603 +
#3616, every line pinned ≤80 columns by `orient.test.ts`). Three row families still run
past the edge — owed rows at 102–105 cells, review-debt at 81, shipped rows at 114–120 —
carried by lane `01M65K3JKM`, below. Bare `musterd` lists each start-here command once
(verified live: four term rows, `next` only in START HERE).

**Messaging.** `musterd inbox --peek` now leads with `⚑ waiting on you — 9`, and
`musterd status` prints `⚑ 9 waiting on you` in the same minute (re-run 2026-10-30 on the
merged CLI): the directed acts, in message-rows, before the general unread (ADR 770 as
amended, lanes `01M658ZSMQ`/`01M65AB64H`, #3609 + #3615). The section is the daily view's
own projection — one helper over one walked window — so the header N and the rows under it
are the same set. Empty and filtered views keep ADR 752's honest lines. The defect the
first pass found here is fixed; see below.

**Completion.** `done` receipts and JSON-for-writes (ADR 758) stand as shipped; nothing in
this pass re-opened them.

**Recovery.** The daemon-down and unframed-reply errors now say what happened and what to do:
the unframed non-2xx reads "the daemon answered 500 without an error frame — retry, and if it
persists run `musterd status`…" (lane `01M653WNCD`, #3606). A refused claim now names its
next step for every refusal code — `claim refused (claim_conflict): … — next: see who holds
the seat with `musterd status --all`, or claim another name` (#3617, same lane, second
landing). Live check of the shallow end: an unknown command answers
`✗ unknown command "badcmd" · musterd help` on one line.

**Copy.** The contrast frame is out of the surveyed strings, `session` reads Presence/seat
where that is the meaning, and the roster-home string no longer says "worktree"
(lane `01M653WKTK`, #3604). Two strings kept their shape deliberately: proper nouns keep
capitals, and "is the daemon running?" keeps the daemon named twice rather than thinning to
"is it running?" — the retry suite pins the fuller form and it reads clearer.

## The one defect this pass found — fixed

`status` said **5** waiting; the inbox section said **6**. Both surfaces used
`openActionNeeded`, but `status`'s count unions the answered/discharged sets across every
drained unread page (helpers.ts), while the directed section read them from the first
bounded inbox response only. That was ADR 770's core promise — the two counts cannot
drift — not kept in that corner.

Fixed by #3615 (lanes `01M658ZSMQ`/`01M65AB64H`): the section no longer computes its own
count at all — it renders `pendingActionSummary`, the helper `status` counts with, over the
same walked window, under the `⚑ waiting on you — N` header. The ADR's eval is now a
seeded test (an answered ask leaves both surfaces; status N == inbox N == the section's row
count). Re-run live 2026-10-30: `⚑ 9 waiting on you` / `⚑ waiting on you — 9`.

The `next` re-run found the same budget slip in three more row families — owed rows append
their suffix after the title cut (102–105 cells), review-debt rows land at 81, shipped rows
print the full title (114–120) — carried by lane `01M65K3JKM`. The `answer:` copy-paste
command lines measure 81 and stay whole: a command is not cut.

## What remains open

- Lane `01M65K3JKM` (owed / review-debt / shipped row widths in `next`).
- The three human-only paths from the journeys review (passkey ceremony in a real browser,
  interactive `init` with a person typing, a first agent's maiden launch) — still unexercised
  by an agent, still owed a human walk.
- Whether the daily view is *warm* — the goal's own words — is not an agent's call. The
  mechanics above are verified; the feel verdict belongs to the human who reads it daily.

## Verdict

The five journeys read as one experience now: the waiting count lands on exactly the acts
it counts (falsifier re-run above: the two Ns agree, and the section's rows equal N), and
the `next` register's carrying family — the rows a seat works from — holds the column edge,
pinned by test. What remains open is named, not hidden: the owed/review-debt/shipped row
widths (`01M65K3JKM`), the three human-only paths, and the warmth verdict. Every proposal
in the design record is a named lane with its gate; this page is the evidence they were
checked against the shipped CLI of 2026-10-30.
