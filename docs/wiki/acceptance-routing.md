# Acceptance routing

Who gets asked to accept a lane, why it is nearly always the same seat, and how to measure any of it without fooling yourself.

## The grade ladder funnels every ask to the one cross-family seat (2026-08-14; falsify: re-run `scripts/research/adr-260-acceptance-eval.ts` and read the per-day `cross_family` share) <!-- claim: other -->

`pickReviewCounterpart` sorts candidates `cross_family` before `cross_model` (`packages/server/src/store/review.ts:369`, stable sort, no tie-break policy). On a team that is claude except for one grok seat, "highest grade available" resolves to that seat's name every time. Measured share of live-routed asks graded `cross_family`: 0–11% per day through 08-05, then **70% on 08-12, 57% on 08-13, 83% on 08-14**, with the same seat top reviewer on all three days.

The shift dates to **08-12**, when ADR 253 (#752) took humans out of the live pick — not to ADR 260's quiet filter, which went live 08-13 10:02. The quiet filter plausibly amplifies it (dropping busy same-family seats leaves the cross-family seat top of the ladder more often) but did not cause it.

This is a **queue at one acceptor**, and it depresses any 10-minute latency statistic on its own. Anyone measuring acceptance latency across 08-12 has this inside their window whether they modelled it or not.

## An acceptance ask is usually answered by the seat it was sent to — slowly (2026-08-14; falsify: the ON window rows printed by the eval script) <!-- claim: other -->

Over 28h post-ADR-260: the asked seat answered **15 of 18** asks (2 jumped the route, 1 still open), median 60 minutes, exactly **1** inside the 10-minute bar. On 12 of the 16 slow rows the asked seat has its own `lane.closed` / `git.pr_merged` audits between the ask arriving and the lane closing — it was awake and servicing other lanes while the ask sat.

Candidate *supply* is therefore not the binding constraint on this team; attention is. Adding names to an ask does not make a working seat look sooner. That is why quiet-set fan-out (increment 2 of the ADR 254 arc) is parked rather than built — see the dated note in ADR 260 §Observability.

## The attention finding, observed rather than inferred — a seat held for numbers already in its inbox (2026-08-14; falsify: messages `01M0124WS2JAFCZDRRP14WR4TW` and `01M0124A7753EES3VHWJGPBBEF` in the acts log, 8 minutes apart) <!-- claim: other -->

Everything above about attention is inferred from the audit log. On the day the Eval landed it happened in the open, inside the lane that was measuring it.

The Eval's numbers were sent to the cross-family seat at 21:19. Eight minutes later that seat told nick it was holding increment 2 because "izzo's Eval is in flight… I will not touch `ELIGIBLE_ACTS` until those numbers land." It was awake the whole interval — claiming a lane, writing a plan, posting two status updates. The message was in its inbox and unread; a third message finally surfaced it, and the seat then answered within minutes and accepted the verdict.

Three things this shows that the log alone cannot:

- **The stall is not the acceptor being unavailable, and not the candidate set being too small.** A wider set would have added names to an ask that the correct, quiet, willing recipient already had. It would not have made anyone look sooner.
- **A seat can be actively blocked *on* the thing sitting unread in its own inbox** and describe itself, accurately from its own point of view, as waiting (2026-08-14; falsify: the seat's own status at `01M0124A77`, timestamped after delivery of `01M0124WS2`). Nothing in the routing layer is broken in that story. What is missing is anything that puts an obligation in front of a seat between task boundaries — `team_inbox_check` is polled at boundaries the seat chooses, and a seat deep in a plan chooses none. <!-- claim: defect -->
- **The mechanism is symmetrical and this page's author is not exempt.** The same day, the same seat's own acceptance ask (#837) was routed to that same cross-family seat by the concentration described above — the paper about the queue joined the queue.

This section was sent to the seat concerned in full before it landed (2026-08-14; falsify: message `01M012H0H8` in the acts log, and the absence of any reply answering it), with an explicit offer to rewrite it as a harness-interrupt gap if that seat had been mid-turn and unable to check, and to carry its own words instead of this reconstruction. It replied three times on other matters and did not answer that question, so **its account is missing rather than declined** — anyone who gets one should add it here. That gap is the same phenomenon the section describes, one turn further out, and it is recorded rather than treated as agreement. <!-- claim: other -->

## The obligation interrupt is installed by ONE harness — so the seats the ladder favours are the seats it can never reach (2026-08-14; falsify: `grep -rc interrupt-check packages/cli/src/onboard/harnesses/*.ts` — claudeCode 3, cursor 0, codex 0) <!-- claim: defect -->

ADR 225 makes a routed acceptance obligation-class, and the machinery is real: `pendingInterrupts` in `packages/server/src/store/messages.ts` admits `lane_review` asks, and `GET /inbox/interrupt-check` raises the line. But that endpoint is called by a **PostToolUse hook**, and the hook is wired by exactly one harness adapter — `claudeCode.ts`. `cursor.ts` and `codex.ts` wire nothing.

Measured over all acceptance asks, by recipient:

| seat | asks received | interrupts ever raised |
| --- | --- | --- |
| **wanderer** (grok) | **38** | **0** |
| **gptbot** (codex) | **5** | **0** |
| miley | 26 | 16 |
| stanley | 19 | 10 |
| izzo | 15 | 12 |
| dolly | 15 | 3 |

**The two mechanisms compound in the worst direction.** The ADR 188/253 ladder sorts `cross_family` first, so it deliberately routes acceptance toward model diversity — and on this team the cross-family seats are exactly the ones on other harnesses. The more the ladder prefers a different model, the more obligations land on a seat that is structurally impossible to interrupt. wanderer received 38 acceptance asks and could not be reached by the obligation rail for any of them.

That is a better explanation of the 60-minute median than inattention, and it is a correction to how this page first described the observed instance: the seat was not failing to look, it was **unreachable by design**. The audit's `interrupt.raised` row carries `actor` = the *sender* and `target` = the recipient; joining on `actor` (the intuitive read) produces a confident 0/32 that means nothing.

## No evidence the interrupt helps where it does fire — and the data cannot show it (2026-08-14; falsify: re-run the join in the section above, and read the reverse-causality note before quoting it) <!-- claim: defect -->

Post-#785 acceptance asks, split by whether the interrupt was delivered before the lane closed: **delivered n=6, median 202m, 0 inside ten minutes. Not delivered n=22, median 25m, 6 inside ten minutes.**

Do **not** read that as "interrupts make acceptance slower." It is reverse causality by construction: the line is a tool-boundary probe over the *unread* inbox, so an ask can only be delivered if it is still sitting when the seat next runs a tool. Fast-answered asks are answered before the probe ever sees them. Delivery is partly a *marker* of having already sat.

What the numbers do establish is narrower and still useful: **there is no evidence in this log that the obligation interrupt produces ten-minute acceptance**, and 0/6 of the asks it reached were answered inside the bar — one of them 324 minutes later, interrupted at minute zero. Anyone proposing more interrupt rails as the fix for acceptance latency is proposing something this team has already shipped for its claude seats, with no measured benefit.

## A burst of acceptances is not a latency measurement (2026-08-14; falsify: the OFF window in the eval, 08-12 21:45–22:10) <!-- claim: other -->

The 12.8h window between the web-low arming and ADR 260 going live scores 89% good-within-10-minutes, and it is worthless: 8 of its 9 fast confirms are one seat clearing six queued lanes in 25 minutes. A seat sitting down to work its acceptance backlog produces a cluster of tiny ages that looks exactly like excellent routing.

Before citing any acceptance window, print the rows and look at who closed them and when. n is small enough here that one seat's evening changes every number on the page.

## Routing changes faster than it can be measured — 11 commits and 4 policy changes in one week (2026-08-14; falsify: `node scripts/research/adr-260-acceptance-eval.ts --rerun --days 7`) <!-- claim: defect -->

The instrument now refuses to report a before/after when the window is contaminated, and the first thing it did was refuse. A 7-day window to 2026-08-14 contains **4 `policy.change` rows** and **11 commits** to `review.ts` / `orientation.ts` / `envelope.ts` — ADR 253, ADR 254, ADR 255, ADR 257, ADR 258, ADR 264, #785 and more.

The practical consequence: **a clean measurement window for acceptance routing may not exist on this team at the current rate of change.** That is not an argument for measuring anyway. It means any acceptance statistic quoted over a multi-day window here is describing a moving system, and the honest options are a deliberate freeze on routing code for the length of a window, or descriptive-only numbers that nobody cites as a before/after.

**And a freeze is weaker than it sounds, because the worst contamination leaves no trace** (2026-08-14; falsify: `grep -c "transcript_age_ms" ~/.musterd/host.log` against stanley's #844 / ADR 269, and the retraction note on ADR 260). A wake report whose `transcript_age_ms` was fractional was rejected whole by a `.int()` schema: 48 refusals, $22.54 of real spend, and **no ledger row for the refusal**. That ran ~3 weeks, inside both arms of the Eval that was trying to measure across it, and it inflated the lease rate by re-leasing acts that could never settle — one act held 12 leases. <!-- claim: defect -->

Holding files still excludes the changes you can see. It cannot exclude a defect that arrives silently and distorts a denominator. So when quoting any acceptance number over a window here, the freeze buys you the visible half only — and the arm most likely to be wrong is the one whose denominator you did not think to check.

The re-run prints its numbers either way — refusing to *compare* is not the same as refusing to *look*. Descriptive read of that same dirty window, for scale: n=56 live-routed, top reviewer 55% (31/56), `cross_family` 68%, good-≤10m 38%. The concentration figure is consistent with the smaller 28h window above, which is the one number here that has now been seen twice.

## Two traps in the pre-registered definitions (2026-08-14; falsify: read the header comment of `scripts/research/adr-260-acceptance-eval.ts`) <!-- claim: other -->

- **A jumped route leaves the numerator, not the denominator.** The rule (`closer != asked reviewer AND closer != owner`) is written as "drop from the confirm numerator". Dropping those rows entirely raised the measured baseline from 23% to 27% — the routed ask still went unanswered, so it is a miss, not an absence.
- **The daemon is not a seat jumping the route.** `closed_by = 'musterd'` is the ADR 229 24h sweep. Classified as "jumped" it silently excludes 14 of the worst rows in the 14-day baseline.
- **A behaviour change starts when the daemon restarts, not when the PR merges** — and never at the commit's author date. #785's author date is 08-12, its merge 08-13 09:33, and the first autorefresh bounce carrying it 08-13 10:02. Cutting the window at either of the first two puts pre-change submits in the post-change bucket. See [shared-daemon](shared-daemon.md).

## A new route value silently joins the population it is not evidence about (2026-09-01; falsify: `sqlite3 ~/.musterd/musterd.db "select count(*) from audit where action='lane.ready_for_review' and detail like '%\"route\":\"named\"%'"` — the exclusion was written at count 0 of 494 ready rows) <!-- claim: defect -->

`liveRouted` in the ADR 260 eval defines the population every headline number ranges over, and it is written as a list of *exclusions*: not exempt, not human-required, no candidate-failure, not wake-queued, has a reviewer. That shape is the trap. It admits by default, so a route value invented later is **opted in by silence** — nobody has to decide anything for it to land in the denominator of a pre-registered prediction.

dolly's [#1152](https://github.com/SandRiseStudio/musterd/pull/1152) added exactly such a value. `route: 'named'` records an acceptance a human routed by hand — the fix for assigned work being invisible to the ledger, where a real review by `ghost` (lane `01M1F9QVG6XCFQAZSH7XSZ13JT`) was recorded as an unconfirmed self-close because `applyAcceptanceVerdict` binds only to a server-composed ask. The routing is right and the recording is right. But a named row satisfies every clause above, so it would have entered the concentration population, and **concentration is a claim about what the ladder does with the asks**:

- A person hand-routing repeatedly to one trusted seat drives top-reviewer share up with the sort doing nothing. In that number it is indistinguishable from the ladder failing to disperse — so the pre-registered FAIL arm could have fired on a mechanism that was never exercised.
- A named route abstains to `same_model` whenever the observed pairing falls short of a better grade (2026-09-01; falsify: read `namedAcceptor` in `packages/server/src/store/review.ts` — the `?? 'same_model'` on the grade is the abstention). That is the honest record, since nothing was promised about a seat the ladder did not choose. But each such row drags `crossFamilyShare`, a figure that claims to describe the *picker's* achieved diversity. <!-- claim: other -->

The generalisation worth carrying: **an experimenter's hand in the population is not data**, and a filter written as exclusions cannot enforce that on its own. Two habits follow. Prefer stating the population positively where the values are known and small (`route is a pick route`) so a new value must be admitted deliberately rather than by default. And when a new route value is unavoidable, put it on the exclusion list *before its first row lands* — after that, no amendment can distinguish "excluded because it is not ladder data" from "excluded because it moved the number the wrong way", and the window is contaminated in a way no later correction reaches. That timing is why this one was written against a verified count of zero; the amendment beside `CONCENTRATION_PREDICTION` carries the same falsifier.

The rule was followed once, on purpose, the next day: [ADR 351](../decisions/351-unattested-worker-routes-ungraded.md)
added `route: 'ungraded'` and excluded it from `liveRouted` in the same PR, written at count 0 of
its own rows (2026-09-02; falsify: `sqlite3 ~/.musterd/musterd.db "select count(*) from audit where <!-- claim: other -->
action='lane.ready_for_review' and detail like '%\"route\":\"ungraded\"%'"` returns more than 0 on
a daemon built before the ADR 351 PR — the rows would predate the exclusion).

The near miss is the point: the value was proposed, reviewed, and approved without anyone noticing it changed a pre-registered denominator, and it surfaced only because the PR was routed to the seat that owns the instrument. It would not have survived a review by anyone else on the team — see [measuring a moving page](measuring-a-moving-page.md).

## A named acceptor on an already-awaiting lane was validated and then dropped (2026-09-04; falsify: `sqlite3 ~/.musterd/musterd.db "select count(*) from audit where action='lane.review_rerouted'"` returns 0 on a daemon built after #1326 despite a `lane_submit --acceptor` on an awaiting lane — the arm did not fire) <!-- claim: defect -->

~~`lane_submit {acceptor}` on a lane already in `awaiting_acceptance` returned 200 with a lane that looked right, minted no ask, and hinted "no acceptor was ever routed — self-close sanctioned" (2026-09-04; falsify: the acts table after such a submit holds no `lane_review` ask to the named seat)~~ FIXED 2026-09-04 by [ADR 348 amendment](../decisions/348-an-acceptance-can-be-routed-by-hand.md), lane `01M1QYHJFY11HEXSX0QSEXYZNR`. <!-- claim: defect -->

The mechanism is worth keeping because it is a shape, not a typo. The routing block was gated on the *transition* into `awaiting_acceptance` — correct for the automatic pick, which is the submit — and the explicit `acceptor` was computed and validated *before* that gate and read only *inside* it. A bad name threw 400 at the validation; a good name sailed through and was never read (2026-09-04; falsify: remove the re-route arm from `packages/server/src/transport/http.ts` and run the integration test `re-routes an already-awaiting lane to a named seat` — it fails at its first ask assertion, which is the drop reproduced). So the failure was visible exactly when it was harmless and silent exactly when it mattered, and the response's hint was derived from "did a route happen" rather than "was one asked for", which turned a no-op into advice to record an unconfirmed close. Two seats hit it in one hour (ryder on `01M1MMKHX8`, miley on `01M1PYA3JQ`); both queried the acts table to notice, and both hand-minted the ask. <!-- claim: defect -->

What the fix leaves behind, for a reader who meets the rows:

- `lane.review_rerouted` is a lane verb since 2026-09-04. It replicates (it is in the fold's `LANE_VERBS`) and carries no state. `standingAcceptance` and `reviewRouting` read the newest of it and `lane.ready_for_review`; the ADR 260 eval reads only the latter, so a re-route never joins the picker population — but its "jumped route" rule will call a re-routed-then-accepted lane jumped, because it reads the submit row's reviewer (2026-09-04; falsify: `scripts/research/adr-260-acceptance-eval.ts` line ~87, `rows('lane.ready_for_review')` is the only scan). <!-- claim: other -->
- A superseded ask is closed by a daemon-composed `resolve` on its own thread (`meta.lane_review_superseded`), and a verdict on it no longer moves the lane. A seat that finds a `resolve` it did not write on an acceptance ask should read the body: the acceptance went somewhere else.
- The invariant is the durable half: a named acceptor with no ask minted by the end of the handler is a 500, never a 200. If you see `acceptor "X" was named and validated but no acceptance ask was minted`, that is a daemon bug — report it; the lane is awaiting with no ask.

## The only reply the rail recorded was the one that closed the lane (2026-09-16; falsify: on a daemon built before `lane.review_acknowledged` exists, reply `wait` to a fresh `lane_review` ask and read the lane — it stays `awaiting_acceptance` and no audit row names the acknowledge, so nothing but `accept` was ever countable) <!-- claim: defect -->

Every other obligation on this rail has an "I have this" reply that does not discharge it: a `request_help` is taken with `accept` and discharged by *doing the work* (`delivery.ts`, #745), and so is a handoff. A `lane_review` ask was the one act where that learned reflex is also the irreversible close (ADR 202) — and the daemon said so only in the ack, i.e. after the write.

Three seats sent "taking this" announcements as `accept` in one month — miley `01M2GH2FZN` ("taking it as mine"), stanley `01M2GPXE4S` ("taking the acceptance review of…"), schmidt `01M1MKB55W` — and all three were harmless *only* because they answered `request_help` acts rather than acceptance asks. The first one aimed at a real `lane_review` ask closed lane `01M2NR7N9V` unreviewed, `verified: true`, with the acceptor's name on the `lane.closed` row (2026-09-16 14:31). It was sent by this section's author, two days after guidance v23 was written specifically to prevent it, which is the part worth keeping: **the seat that had read the warning still sent the wrong act, because the right one did not exist.**

The fix names both moves in the ask body itself and makes `wait` on a `lane_review` ask the acknowledge — audited `lane.review_acknowledged`, moving nothing, discharging nothing. Two properties are load-bearing and easy to lose in a later refactor:

- **It does not discharge the ask.** `openAcceptanceLoad` must keep counting the verdict as owed, or acknowledging would quietly clear the queue this page measures — and the ADR 260 latency numbers would improve by definition rather than by anyone reviewing anything.
- **Its ack states the negative outcome out loud** ("no lane moved, the verdict is still yours"). A silent acknowledge leaves "acknowledged" and "accepted" indistinguishable from the sender's side, which is the original defect with the sign flipped.

Related in kind: [a check that cannot separate two causes](cannot-separate-two-causes.md). This is the affordance version of it — not two causes sharing one reading, but two *intentions* sharing one act.


## Acceptance concentrates on one seat for two measured reasons, and neither is "the picker prefers it" (2026-09-05; falsify: `sqlite3 ~/.musterd/musterd.db "select policy from residency"` shows more than one row carrying `"flow":"auto"`, or a `lane.ready_for_review` row after cd138abd whose `selected.tie_decided_by` is `roster` while the losing `tie_break` candidate held fewer open asks) <!-- claim: defect -->

Lane `01M1QYHJFY` left "six acceptance asks on gptbot while ghost, kimi and schmidt sat idle" out of scope. Measured before deciding anything (lane `01M1S6GZ96`), the premise as told was half wrong and the number was worse.

- **The peak was 14, not six.** gptbot held 14 open acceptance asks at once at 22:04 on 2026-09-04; the next-highest holder in the same week peaked at 6 (2026-09-05; falsify: replay the open-ask depth query in lane `01M1S6GZ96`'s detail against the acts table for that hour). <!-- claim: defect -->
- **46 of gptbot's 60 picks that week were `wake_queued`** — the ADR 191 offline-wake path, taken only when nobody live was eligible. On those picks ghost, kimi and schmidt were `no_live_presence` 39, 43 and 29 times and `busy` the rest. They were offline, not idle (2026-09-05; falsify: the `review_selection.candidates` snapshots on those rows). <!-- claim: defect -->
- **The wake pool has exactly one spendable seat.** `residency` holds five enrollments and only gptbot's policy carries `flow: auto`, which `pickWakeReviewer` requires; so every no-live-candidate submit from a claude worker wakes the same seat. That is structural, not a sort. The remedy is enrolling a second cross-family seat (ghost on muse-spark, kimi or schmidt on gemini are live on `cli` and none is host-enrolled) — a human decision, not made by the lane that measured it.
- **Cost of the queue, measured:** wake-queued picks to gptbot closed a mean 189 minutes after submit (max 974), against 29 minutes when gptbot was picked live; three closed `review_unanswered`.
- **The second cause was in the sort.** Both pickers ordered by grade and took the first; among equal grades, `listMembers` order stood, by design (ADR 188 §2: "no new tie-break policy"). 32 `tie_break` exclusions in 30 days, every one resolved to the earlier roster seat — miley over five seats, stanley over three, kimi over ghost and schmidt. ~~Ties fall to roster order (2026-09-05)~~ FIXED 2026-09-05 by lane `01M1S6GZ96`: load, then recency, then roster, and `selected.tie_decided_by` says which.

The generalisation: **the snapshot recorded the loser as `tie_break` on every one of those rows, so the concentration was measurable from the day ADR 303 landed and nobody read it.** A field written for the audit is only evidence if something reads it; "recorded, not read" is [recorded-not-routed](recorded-not-routed.md)'s quieter sibling.

## The load rung has no time bound — a lane that stalls in `awaiting_acceptance` charges its acceptor for as long as it sits there (2026-09-05; falsify: `sqlite3 ~/.musterd/musterd.db "select json_extract(policy,'$.loops') from teams where slug='revive'"` shows `"sweep":true`, or a `lane.ready_for_review` row whose `selected.tie_decided_by` is `load` names a winner holding an OLDER open ask than the `tie_break` loser) <!-- claim: other -->

miley's note accepting lane `01M1S6GZ96` (#1334): `openAcceptanceLoad` counts every daemon-composed `lane_review` ask that has no verdict, no `resolve` on its thread, and a lane still in `awaiting_acceptance`. There is no age cut-off. The `awaiting.has(lane)` filter is the only release valve, so an ask that nobody answers keeps charging its holder one unit of load until the lane leaves that state — by accept, reject, abandon, or the ADR 229 sweep — and the equal-grade tie-break routes new acceptances away from that seat for the whole time.

- **This is deliberate, and it is the honest reading.** A seat holding an unanswered acceptance holds an obligation; the tie-break's question is "who has the least on their plate right now", and an ask from last week is still on the plate. Ageing it out would let a seat that ignores asks look free.
- **The bound is the sweep, and on this team there is none.** ADR 229's backstop closes an unanswered lane after 24h of grace only when `loops.sweep` is armed. Measured 2026-09-05: revive's policy loops read `{"dispatch":true}` — the sweep is off — so a stalled lane charges its acceptor without limit. Measured the same evening: lane `01M1Q9WQP6` had sat awaiting for 10.7h charging dolly, and `01M1T4CKYG` 1.9h charging wanderer.
- **The effect is one unit per lane, never more.** Load ranks only among EQUAL grades (ADR 188's ladder decides first), and a seat with one stale ask is behind a seat with none, not out of the running. Two seats both carrying a stale ask tie on load and fall through to recency.
- **How to read it in the rows.** `review_selection.selected.tie_decided_by: "load"` on a ready row means the loser held more open asks at that instant; join the loser's name against the open `lane_review` asks at that `ts` to see which lanes were charging them. If the charging lane is older than the sweep's grace and the sweep is armed, that is the falsifier above firing.

What would change the choice: a measured case where a seat is steered away from work by a lane whose stall belongs to its owner (a merge still open, say), with the acceptor holding nothing they could act on. The right fix then is on the lane — abandon it, or arm the sweep — rather than an age cut-off in the picker.


## After a re-route the relieved acceptor's orientation brief still named the lane as owed — `owed_reviews` did not honour the superseded-ask set the verdict edge already did (2026-09-18; falsify: mint an acceptance ask to A, re-route it to B via `lane.review_rerouted`, run `musterd next` as A — if the lane appears under owed reviews, this is unfixed) <!-- claim: defect -->

Measured on #1541 (lane `01M2RKFG60`). A 414 reap-reroute superseded wanderer's ask and minted `01M2SCMGK3` to ryder at 21:33. wanderer's brief the next morning still said "12h verdict still owed"; they judged the lane and accepted at 09:06 (a first accept on the superseded ask was inert). ryder read the standing ask at 09:12 and declined at 09:15 — inert, since ADR 202 lets no decline undo an accept. Two full acceptance reviews, opposite verdicts, nine minutes.

- **The relief was sent and ignored.** `rerouteAcceptances` delivers a `resolve` to the old acceptor ("nothing is owed on it") and writes `superseded_ask` on the `lane.review_rerouted` audit row. `supersededAcceptanceAsks()` reads that row; the verdict edge and `openAcceptanceAsk` consult it. `deriveNext`'s `owed_reviews` and `deriveNextSummary`'s `owed` did not — both filtered on lane state alone, and after a re-route two ask rows share one lane, which lane state cannot separate.
- **Why the brief and not the inbox mattered.** The `resolve` is one act with no interrupt weight, on inboxes that on this team run thousands deep. The seat orients from `next`, and `next` kept saying the review was theirs.
- **Fix (lane `01M2TNWK0K`).** Both reads exclude asks in the superseded set — one predicate, three readers. Test: the same reroute leaves the lane in B's brief and summary and out of A's; dropping either exclusion turns exactly that test red.

## A re-route chain can hold an ask for hours, and the submitter is never told who holds it now (2026-10-12; falsify: count `resolve`-then-`ask` pairs on lane `01M4Q7PMAP` in the acts log — anything but 3 hops, or the third hop not ~1h44m after the second, and this is wrong) <!-- claim: defect -->

Seen on two nights. 2026-10-07 (insight `01M4D34ZD1`): two hops in under 2 minutes, and the submitter posted "awaiting nick" 19 minutes after the ask had reached miley. 2026-10-12, lane `01M4Q7PMAP`: resubmitted 12:47:57, re-routed gptbot → ghost at 12:52:44, ghost → lazara at 12:52:51, lazara → wallow at 14:37:13, resolved by wallow at 14:39:13. Total 1h51m; the seat that decided took 2 minutes, and 1h44m was one holder sitting on the ask before passing it on.

Each hop delivers a `resolve` to the old holder and a new `ask` to the next. Nothing goes to the submitter. Before reporting "awaiting <name>", read the newest `[lane] acceptance requested` act on the lane and use its addressee, not the name you passed to `lane_submit`. The relieved-acceptor side of the same gap is the section above.

## A re-reviewed lane can still close inside sixty seconds (2026-10-13; falsify: a lane whose second acceptance ask takes more than 60s despite every earlier decline being answered on the named references; read the acts-table timestamps) <!-- claim: other -->

Measured twice on adjacent nights, on live lanes that had been declined once and then re-submitted with each concrete item the reviewer named corrected:

- 2026-10-12 lazara's two lanes: asks at `1791844569983` and `1791848824907`, resolved at `1791844617534` and `1791848882957` — **47.6s and 58.1s** (lazara insight `01M4SWJVA9F8XF775DK2YWG0ME`). Cross-family acceptor izzo. Both had been through a quiet-set fan-out with no blocker.
- 2026-10-13 dreamy's model-attribution lane (`01M4BVZV0KZ4F2WN0F668EBHGW`): second acceptance ask at `1791939632319`, closing resolve at `1791939680014` — **47.7s**, cross-family acceptor wallow, after izzo's decline on #2509 was answered on the named references (occupancy/model_attested renamed to the `presence.model` / `audit.actor_model` / `meta.model` triples).

Against this page's own evidence those fast rows are the tails of a wide distribution, not a contradiction of it: the sections above describe what happens when the ask sits unread while the recipient works other lanes or is structurally unreachable. Fast turns occur exactly when the recipient is live and the only blocker was something concrete the reviewer could check. They are a floor on the distribution, not a property of routing generally — and they read as measurement *misses* of the slow-median thesis only when someone quotes them without the fast-path conditions attached.

## A first-submit acceptance with no re-route can close inside two minutes (2026-10-15; falsify: on lanes `01M4YE8CGD`, `01M4S0WNZ5` and `01M4SB4BZB`, a `resolve`-then-`ask` re-route before the close, or ask-to-resolve gaps other than 41.2s, 79.9s and 99.4s in the acts table) <!-- claim: other -->

The section above is about lanes that were declined and re-submitted. This one is the first ask on a lane, answered by the seat it was sent to, with no earlier decline and no re-route. Seen on two nights, all on non-risky lanes:

- 2026-10-14, lane `01M4YE8CGD` (ADR 597, #2599): ask `1792023967784`, resolved by alfie `1792024008984` — **41.2s** (lazara insight `01M4Z1HC7A`). The same night, lane `01M4W5VFAB` took **17m 3s** on the same shape, so the fast case is not every case.
- 2026-10-15, lane `01M4S0WNZ5` (spend controls increment 1): ask `01M50DYTWC` at `1792089746316`, resolved by miley `1792089826230` — **79.9s**. Lane `01M4SB4BZB` (spend controls increment 2): ask `01M50J4TGE` at `1792094136846`, resolved by fifty `1792094236266` — **99.4s**.

Same reading as the re-reviewed case: these are the fast tail, seen when the acceptor is live and the lane needs no human stage. A risky lane does not close this way however quick the peer is — its peer accept is only stage one (see the 2026-10-15 izzo insight `01M50BPJVJ`, and ADR 603).

## A re-routed acceptance can hop several seats, and nobody tells the submitter or the owner (2026-10-13; falsify: in `~/.musterd/musterd.db`, `select from_member,to_member,act,ts from messages where body like '%Take the tour again%' and ts > 1791800000000 order by ts` shows fewer than six `resolve`-then-`ask` pairs, or an act to alfie or miley that names the new acceptor) <!-- claim: defect -->

Each re-route sends a `resolve` to the old holder ("the ask you held is closed") and a new `ask` to the next one. Neither act goes to the seat that submitted the lane or to the seat that owns it. Seen on two nights:

- **2026-10-07** (dolly insight `01M4D34ZD185AVYM90TXQVV0HM`): lanes `01M46YWG8Y` and `01M49C49BS` hopped nick → ghost → miley in under 2 minutes. 20 minutes later the submitter posted that the lane was "awaiting nick", who no longer held it.
- **2026-10-12** (dolly insight `01M4WEDMX53GXNSKANPVP6RN5R`): lane `01M4Q7PMAP` hopped gptbot → ghost → lazara → wallow. It was submitted at 12:47 and closed at 14:39. 1h44m of that was one holder before they passed it on. The seat that decided took 2 minutes.
- **2026-10-12 → 10-13** (lane `01M4RGKRKS`, owner alfie, built and submitted by miley): six re-routes. The ask went nick → dreamy → sloane. Then a human-required ask went nick → sloane → **miley, the lane's own submitter** → fifty. There were two peer accepts, and 23h20m from submit to close. The closing human read took 5 minutes. No act in that span told alfie or miley who held the ask.
- **2026-10-17** (lane `01M55N47KJ`, miley, x11 at 24 fps arm): submitted 12:56:04, re-routed big-body → ghost at 13:01:59 and ghost → stanley at 13:19:39. stanley accepted, the human-required ask was minted at 13:21:18, and nick closed it at 13:34:22. 38m18s from submit to close; 23m35s of it was the two hops. The packet's acts for this lane show no act to miley naming stanley (falsify: an act on lane `01M55N47KJ` between 12:56:04 and 13:21:18 addressed to miley that names ghost or stanley).

Two shapes from the third case are worth checking for before you re-route:

- **A human-required ask re-routed to a peer cannot close.** The peer's `accept` only mints another "human acceptance required" ask (2026-10-13; falsify: the same query shows the lane closed by fifty's accept rather than by nick's resolve at 10:02). <!-- claim: defect -->
- **A re-route can land on the submitter**, who can only pass it on again (2026-10-13; falsify: the 06:29 ask on that lane is addressed to someone other than miley). <!-- claim: defect -->

Until the submitter is told, look up the lane's newest `[lane] acceptance requested` act before you report "awaiting <name>". The name you passed to `lane_submit` may be stale. The holder-side half of the same gap is the 2026-09-18 section above.

## After a re-route the long wait can sit with the new holder, not the one passing it on (2026-10-17; falsify: resolve-then-ask timestamps on lane `01M5162FVM` (night 2026-10-15) or lane `01M50M90ST` (night 2026-10-17) other than big-body's hop then the new holder's long hold) <!-- claim: other -->

Two dated observations, two nights:

- **2026-10-15** (izzo's dream, lane `01M5162FVM`): big-body re-routed to wanderer at 19:45:42 after holding the ask 42m28s; wanderer then held it 1h10m before resolving at 20:55:40. Submit-to-close 1h52m.
- **2026-10-17** (alfie's dream, lane `01M50M90ST`): big-body re-routed to fifty after holding 7m4s; fifty then held 1h29m5s before resolving. Submit-to-close 1h36m9s.

Both hops were by big-body. The submitter is never told who holds the ask now — each hop delivers a `resolve` to the old holder and a new `ask` to the next, and nothing goes to the submitter (see the 2026-10-13 section above).

Counter-cases where the hold was *before* the hop: lane `01M5162MTC` (big-body held 45m13s, sloane resolved 86s after the hop) and sloane's `01M4S53AV4` (29m32s before the hop). big-body re-routed on 4 of these 5 hops.

The re-route sections on this page (2026-10-12, 10-13) place the hold before the hop; these two nights show it can sit after instead — a re-route chain's wait is not always with the one passing it on.

## ~~A second verdict on an answered ask binds to nothing, and says nothing~~ FIXED 2026-10-19 by ADR 680 (lane `01M5BC0CJQK8DR6J1CWM63FWXC`): the daemon now names it — `lane_unbound` on the ack, `lane.review_unbound` in the audit and in the lane's history (2026-10-19; falsify: in `~/.musterd/musterd.db`, `select count(*) from messages where act in ('accept','decline') and json_extract(meta,'$.in_reply_to') in (select id from messages where json_extract(meta,'$.lane_review.lane') is not null) and created_at > 1792454295980` — the verdicts it finds have no row in `audit` naming them, and their lanes are not `awaiting_acceptance`; if a row names such a verdict, the silence is fixed) <!-- claim: defect -->

A reviewer's verdict can arrive after its ask has already been answered and the lane has since closed on a *newer* PR. The daemon does the right thing with the lane — ADR 202 means one verdict closes a lane, so a second one moves nothing — and then says nothing at all. Two doors are shut on the same state: `applyAcceptanceVerdict` returns early because the lane is no longer `awaiting_acceptance`, and ADR 545's `lane_superseded` marker is gated on that same state, so the sender gets neither a "moved nothing" sentence nor a record of the no-op.

Seen on 2026-10-19 on lane `01M5ASVF3G` (slippy's release-train spec, PR #2919 → #2950):

- 13:50:30 — slippy submits, the acceptance ask fires to big-body.
- 13:51:56 — big-body declines with two corrections; the lane goes back to `active`.
- 14:17:38 — slippy resubmits with #2950 (the registry-name fix) and the lane awaits acceptance again.
- 14:20:07 — big-body accepts; the lane closes `done`, verified, `counterpart_confirm`.
- 16:58:16 — big-body sends **another decline** on the original 13:50 ask. It binds to nothing, and the lane does not move. Nothing in the acts log, the audit trail or the lane's history says that his second decline was a no-op.

What it cost: the first decline's *live* finding — the spec's opening still said "Nothing here is decided until nick marks it" while §8 and ADR 669 recorded D1–D6 as decided — had died with the message at 13:51. The 14:17 resubmission fixed only the other correction, the one big-body had named in the same message, and the lane closed on that. The contradiction sat on `main` for 2h20m after the lane closed and was only put back in front of the owner because the reviewer wrote the same findings a second time, by hand, two and a half hours later. It was fixed by #2972.

The rule this suggests: a verdict that binds to nothing should leave a row that names it. The ask is already answered and the lane already closed; the only thing missing is that nobody can afterwards see that the reviewer spoke and was not heard. Until the daemon writes that row, treat a second verdict on an ask as a note to the lane owner, and say in the message that it binds to nothing — the lane's state will not change, and the sender's ack will not say so.

## A verdict that binds to nothing is named, on the ack and in the lane's history (2026-10-19; falsify: on a daemon built after ADR 680, a decline on a closed lane's answered ask gets no `lane_unbound` on its ack and writes no `lane.review_unbound` row — read `select count(*) from audit where action='lane.review_unbound'`) <!-- claim: other -->

ADR 680 (lane `01M5BC0CJQK8DR6J1CWM63FWXC`) closes the silence above, and closes the third gap on the same rail: a `lane_review` ask stops being the one that binds when a re-route supersedes it (ADR 545, `lane_superseded`), when the ask is advisory (ADR 667, `lane_advisory`), or when the lane leaves the acceptance stage — closed on a newer PR, sent back, parked, abandoned. The third was silent; it now has its own marker.

- The reply's ack carries `lane_unbound {lane, ask, verdict, state}`: the verdict that bound to nothing and the lane's state at that moment. The sender learns on the spot, the way ADR 545 and ADR 667's seats learn.
- The audit carries `lane.review_unbound {lane, ask, reviewer, verdict, answer, state}` against the lane, so the lane's history shows a reviewer who was not heard — the reply's own id rides the row, so a readout joins the verdict to its words.
- Nothing is woken and nothing is copied: the lane is settled, and the sender is the one who can act on what they just learned.

The shape it replaced, measured on the team's own database (2026-10-19): of the 1,659 accept/decline acts that answer a `lane_review` ask, 1,256 bound and **139 did not** — 129 on a closed lane, 10 on a lane sent back. One reply in eleven that can be measured bound to nothing, and said so to nobody.

## The picker moves the reviewer off the lane — the fix is judged by a seat that never saw the finding (2026-10-19; falsify: the `lane.ready_for_review` row minted for the ADR 680 resubmit names alfie as the reviewer, or a re-run of the decline count below shows most picker-routed declines followed by the SAME seat) <!-- claim: other -->

The tie-break's recency rung — "least recently picked", `lastPickedAt` in `packages/server/src/store/review.ts:591` — makes the seat that just held an ask the *most* recently picked, so it sorts to the back of the equal-grade, equal-load set (the rungs themselves are in the 2026-09-05 section above). A seat that declines is therefore the seat most likely to be passed over on the next ask for that lane.

Measured on the team's own database (2026-10-19): of 133 declines that were followed by another acceptance ask on the same lane, **52 were picker-routed and 42 of those went to a different seat**; 57 were `route: "named"` and **48 of those stayed with the same seat**; 24 rows carry no route at all. The picker moves the reviewer off the lane about four times in five; the named route does not.

Two dated sightings:

- **2026-10-16**, lane `01M4S9AVXF` (sloane's branch-overlap spike): five picker-routed asks and five declines between 11:11:55 and 12:55:03 (1h43m08s) — wanderer (11:11), big-body (11:39), schmidt (12:03), wanderer (12:39), stanley (12:52). The sixth ask, at 13:11:50, went to **wanderer** again and was accepted 2h03m04s after the first ask. stanley's decline named two hand-restated figures that disagreed with their own sums, and wanderer was never asked after it: the lane closed on a seat that had not seen the finding.
- **2026-10-19**, lane `01M5BC0CJQK8DR6J1CWM63FWXC` (ADR 680): alfie declined #3000 on one sentence of the ack. The fix (#3008) changed exactly that sentence. The resubmit's ask was minted at `1792471309621` and named **stanley**; the picker snapshot on that submit records alfie as `tie_break` and stanley as the only `eligible` candidate. stanley accepted 2m08s later. Nobody in the rail was asked whether alfie's sentence had been fixed.

The counter-case sits in the first sighting: wanderer was asked a third time, because the candidate set had narrowed to seats that were busy or offline and the recency rung had nobody else to prefer. The rule is not "the decliner is never re-asked" — it is that the decliner is re-asked only by default, and the default points elsewhere.

**What to do with it.** A decline that names a specific, checkable item is a specification of the fix, and the rail will not check the fix against it. State the condition in the decline ("this sentence must read X"), and where the item is narrow enough to be worth checking, verify it against the landed diff yourself — or name the acceptor on the resubmit, so the ask goes back to the seat that raised it. (dreamy insight `01M5BXE07`.)

## An ack must say what happened: a silence and a false promise are the same defect (2026-10-19; falsify: the `lane_unbound` ack text in `packages/protocol/src/lanes.wire.ts` still says the owner sees the reply, or ADR 680's Consequences lack the dated amendment) <!-- claim: defect -->

The acceptance rail has two ways to leave a sender unable to tell what happened, and they are the same defect with different signs.

- **Silence** (2026-09-16, above): an acknowledge that said nothing left "acknowledged" and "accepted" indistinguishable from the sender's side, so the fix made `wait` state the negative outcome out loud — "no lane moved, the verdict is still yours".
- **A false promise** (2026-10-19): the ack for an unbound verdict read "The reply is recorded against the lane, so its owner sees that you spoke." It told the reviewer their words had reached the owner. They had not — the daemon notifies nobody, and ADR 680's own Consequences say a row on a closed lane is a place a reviewer may not look. The reviewer waits, and the finding sits. The sentence now reads: "It is recorded in the lane's history, but nobody is notified: if it carries a finding, send it to the lane's owner or open a lane for it."

The part that transfers: **a fix whose whole point is to remove a silence must not create a quieter one.** An ack is the sender's only channel, so it carries both halves — what is true, and what to do next. "The reply is recorded and nobody is woken" is a true sentence; "if it carries a finding, send it to the lane's owner or open a lane for it" is the do-next half that keeps a reviewer from waiting for a notification that will not come. (dreamy insight `01M5BX3RM`.)

## ~~After a two-stage close the brief still named a verdict the seat had already given~~ FIXED 2026-10-20 by #3092: the brief reads the ask's ledger with the verdict edge's own predicate (2026-10-20; falsify: `musterd next` as the seat that accepted on lane `01M5D8F7FTXT07SSGPPYGX9JV8` names that lane as waiting on your verdict again — the ask carries an answer, so a brief that names it has the defect live) <!-- claim: defect -->

The brief's owed-reviews slice carried its own notion of "unanswered", and it was looser than the verdict edge's. Two dated sightings, two doors into the same slice:

- **2026-09-18** (the section above): after a re-route the relieved acceptor was still told a verdict was owed, because `owed_reviews` filtered on lane state and did not honour the superseded-ask set the verdict edge already read.
- **2026-10-20**: on a risky lane (`01M5D8F7FTXT07SSGPPYGX9JV8`, owner miley, `risk: ["user-facing"]`) the acceptance ask arrived at 15:02:47 and was answered at 15:48:08 — and the answer did not close the lane. ADR 188's two-stage close moves a risky lane's wait to a human: the accept fired "human acceptance required" to nick one second later and the lane stayed in `awaiting_acceptance`. At 19:40 the brief still read `⧗ owed by you — 1 lane(s) waiting on your verdict: 01M5D8F7FTXT07SSGPPYGX9JV8 … miley has waited 4h` to the seat that had just answered. `orientation.ts` used "the lane is still in the acceptance stage" as the unanswered test, with the comment "an accept closes the lane it accepts"; ADR 188's two-stage close broke that for risky lanes.

**One predicate, read from the verdict edge.** #3092 (lane `01M5E5QJXDM2K92B1V4WQ78R1M`, merged 2026-10-20) adds `acceptanceAskUnanswered` in `packages/server/src/store/review.ts` — an `accept`/`decline` in reply to the ask, or a `resolve` that closed its thread, means nobody owes it — and the directed slice drops an answered ask. A `wait` is not an answer, so a seat that said "taking it" still sees it owed. The regression in `packages/server/src/store/orientation.test.ts` fails without the fix (the ask answered, the lane still `awaiting_acceptance`) and passes with it. Checked on the live daemon 2026-10-20 (build `6573a9a8`): the lane is still `awaiting_acceptance` and still one of the brief's 14 review-debt rows, but the directed slice no longer names it — `musterd next` as the seat that answered renders no `owed by you` section at all, because that section is drawn only when the slice is non-empty (`packages/cli/src/commands/next.ts`). The ambient slice still names the lane, and marks it: `packages/server/src/transport/integration.two-stage-close.test.ts` asserts its review-debt row reads `{ pending_human: true, peer_confirmed_by: 'gee' }` — peer-confirmed, pending a human, not a verdict owed by the peer.

**The half that is still open.** Naming the human actually owed a risky lane, and saying "nobody was asked" on an owner's own lane, both want a brief-shape change — a protocol field, and a protocol change needs its own ADR. The PR says so, and says the half is tracked on the lane; that lane is resolved, so the half has no live tracker. It matters: on the same evening one lane sat 7h in `awaiting_acceptance` with no ask minted at all (the submit hint read "no eligible acceptor is live" at 19:45, with 12 seats live) and the brief neither named a party owed nor said that nobody was asked (2026-10-20; falsify: a brief for a lane with no eligible acceptor says "nobody was asked"). <!-- claim: defect -->

**What to do with it.** `awaiting_acceptance` is not evidence that a verdict is owed — read the ask's ledger. And on a risky lane, the wait after your accept belongs to a human, whatever the brief says about it. (dreamy insight `01M5EFMRH`.)

