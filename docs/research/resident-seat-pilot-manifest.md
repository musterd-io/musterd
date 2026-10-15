# Resident seat pilot manifest — one week of BYOK seats against the Claude Code wake backend (ADR 588 §7)

> **Pre-registered, not yet run.** This is the ADR 051-shaped experiment manifest for
> [ADR 588](../decisions/588-resident-byok-seat.md) Decision 7, written on lane
> `01M4VTAEJZYTYACT224Y8T309F` before the worker seat is enrolled. The finding it produces is
> `docs/research/015-resident-seat-pilot.md`; its verdict is recorded as a dated note in ADR 588
> Consequences either way. Nothing below changes after the worker seat's first wake; a change after
> that is a new manifest with a note here saying why.
>
> **2026-10-15:** amended once, mid-window, at nick's direction. The lane class gains a
> doable-from-a-workspace term for both arms from pass 3. Why and how it is read:
> [amendment 1](resident-seat-pilot/amendment-1-doable-class.md). Everything else below stands.

## Question

Does a seat musterd runs itself — always on, on the operator's own key, reached in-process — do the
team's small lane work at a cost per accepted lane no worse than the Claude Code wake backend it
would replace, and answer a directed act faster than a spawned wake? ADR 588 pre-registered the
shape; this manifest pins the terms so the week's rows can be read as an answer.

## Arms

| Arm | Seat | Model | Harness | Does | Is woken by |
| --- | --- | --- | --- | --- | --- |
| **A** coordination | `resident` (enrolled 2026-10-13) | `claude-haiku-5-5` | `musterd` | inbox, acceptance reviews, triage; no lane claims | directed acts, acceptance asks, `dispatch_handoff` of reply-shaped work |
| **B** worker | one new seat, minted for the pilot | `claude-opus-5-5` | `musterd` | claims and lands lanes of the class below in its jailed workspace | `dispatch_handoff` of a lane in the class |
| **C** baseline | the Claude Code seats already enrolled with residency (`delta`, `dolly`, `sloane`, `lazara`, `alfie` on 2026-10-14) | whatever the wake attests (`presence.model`, ADR 581) | `claude-code` | the same lane class, the same week | `dispatch_handoff` of a lane in the class, and their ordinary reply wakes |

Arm C is not a control group assembled for the pilot: it is the backend the team already runs,
read from the same rows over the same seven days. The ADR 436 rail already prices it
(`residency.wake_cost` with `price_source: gateway`; last week 14 of 15 Claude Code work orders
were priced).

## Pinned terms

| Term | Pin |
| --- | --- |
| `model` | A: `claude-haiku-5-5`; B: `claude-opus-5-5` — set on the seat's binding (`binding.model`, source `binding`) or `MUSTERD_MODEL` in the host's env; the engine refuses to run without one (ADR 101, never defaulted). Verified before scoring: every one of the seat's `wake_leases` has a presence row attesting that id. An unattested wake is excluded and counted. C: read, not set. |
| `harness` | A, B: `musterd` at the daemon's build SHA on the day of the first worker wake (recorded in the finding from `residency.wake_cost.daemon_build`). C: `claude-code` at whatever version the seats run; `adapter_build` recorded per wake. |
| `engine` | `engines/pi.ts` over `@earendil-works/pi-agent-core` 1.2.0 + `pi-ai` 1.2.0 (ADR 588 Decision 3 as amended). The jail of Decision 4 as landed in #2554's follow-ups. |
| `key` | one operator-named env var on the Air's launchd job (`--key-env`), the same for A and B. The gateway forwards it; it is never on a row. |
| `enrolment` | `musterd residency on --harness musterd --key-env <VAR> --hourly-cap 20 --cooldown 1m --lane both --flow auto`; B additionally `--tool-policy seat-policy --budget 5 --work-timeout 30m --max-turns 80`. A keeps the 2026-10-13 enrolment (`budget $2`, `work-timeout 20m`, 40 turns). The defaults (`hourly_cap` 2, `cooldown` 30m) are what held wake 3 for 40 minutes on 2026-10-13 and are not a resident seat's. |
| `spend ceiling` | A ≤ $15 for the week (ADR 588 Consequences prices it at $20–30 a month); B ≤ $100 for the week. The host's `budget_usd` bounds a wake; the week's ceiling is read daily from the summed `residency.wake_cost` rows and crossing it stops dispatch to that arm, which the finding records as an outcome, not a failure of the manifest. |
| `lane class` | a lane is **in class** when all of: `stakes` = `normal`; no `risk` tag; `surface_globs` touch none of `packages/protocol/src/**`, `docs/decisions/**`, `SPEC.md`, `.github/**`, `deploy/**`; at most 3 surface globs; no open dependency; no `brainstorm`/`spec first` in the title. The daemon's rows decide this (the `lanes` table at dispatch time), not a reader's judgement. |
| `allocation` | once a day at the first human pass, the open unowned in-class lanes are listed by `created_at` and handed off alternately: first to B, second to C, third to B … Whoever dispatches (nick, or arm A when it triages) records nothing extra — the `handoff` act and the `wake_leases.lane_id` are the allocation record. A lane handed to C goes to the Claude Code resident seat the board's picker chooses; the dispatcher does not choose the seat. |
| `window` | seven days from the worker seat's first `wake_leases` row, inclusive; the same window reads C. Reply latency (measure 1) also reads A for the window. |
| `team topology` | revive as it is; no seats added beyond B, no roles changed. `musterd team export` at the start of the window is committed with the finding. |
| `guidance` | the stamped guidance content version at the window's start (`musterd init --check` clean on the Air), recorded in the finding. |
| `baseline` | arm C over the same window (ADR 052). Second reference for measure 1 only: the idle canary (5.2 s, n=1, [idle-wake-canary.md](../wiki/idle-wake-canary.md)) and spawn-wake occupancy (5–22 s, ADR 588 §Observability). |

## Measures (derived from rows, never reconstructed)

1. **Directed act → first in-thread answer**, p50 and p95, per arm. Start = the directed act's `ts`
   in `messages`. End = the first act by the addressed seat with `thread` (or `reply_to`) equal to
   the directed act's, not a `status_update`. For A and B the delivery leg is also read from
   `residency.steered.delivered_at` (ADR 588 Decision 6); its absence on a wake that answered means
   the act arrived by spawn, which is counted separately. For C the start is the same and the end is
   the same; spawn wakes and idle-canary injects are not separated in the headline but are in the
   table.
2. **Dollars per accepted lane**, B against C. Numerator: the sum of `residency.wake_cost.cost_usd`
   over every lease whose `wake_leases.lane_id` is the lane, including continuations
   (`dispatch_continuation`) and the submit wake. Denominator: lanes in the arm that reached `done`
   by an `accept` on a `lane_review` ask (ADR 202) inside the window plus a 48-hour acceptance tail.
   Unpriced wakes (`unpriced_reason` set) are counted and the lane is excluded from the ratio, since
   the rail's rule is that a wake without a price cannot be compared.
3. **Accepted / submitted**, per arm: `lane_review` asks raised by the arm's submits, and how many
   closed by `accept` versus `decline` or re-route. Declines carry the acceptor's note into the
   finding verbatim.
4. **Claims confirmed**: of the ADR 585 claims each arm's submits filed (`lane.claims_filed`), the
   share the daemon recorded confirmed (`lane.claims_verified`), by claim kind.
5. **Cost reconciles**: for every A and B lease, the summed `wake_turns.cost_usd` equals the
   lease's `residency.wake_cost.cost_usd` within $0.001 (the 2026-10-13 proof held on four wakes;
   the week is the real test). A mismatch is a defect lane, not a pilot result.
6. **The adversarial probe** (ADR 588 §Observability): once during the window, a `steer` is sent to
   B while a `wake_turns` row shows it inside a tool call. Pass: the seat's in-thread answer lands
   before its next model call completes, read from the transcript's turn order. Probe 2 on 2026-10-13
   passed this for A (delivered +390 ms, answered +14.1 s at the tool boundary); B runs working
   tools, so its tool calls are longer and the bound is the point.

Wasted work (the ADR 083 measure) and the MAST block (`musterd report coordination`) are read for
the window and reported, not scored: with one worker seat they are a description, not a comparison.

## Kill criterion (pre-registered, decides Decision 7)

**If B's dollars per accepted lane (measure 2) are higher than C's, the resident seat ships as
coordination-only and the worker shape waits.** Ties within 10% are read as "no evidence either
way" and the worker shape still waits: the burden is on the new shape.

Readability floor: the criterion is read only if B was handed **at least 8 in-class lanes** and
**at least 4 reached a verdict**. Under that, the finding records "underpowered" with the counts,
and the window extends by one further week once; a second underpowered week is a result in
itself (the team does not produce enough in-class lanes for a worker seat to be worth running)
and the worker shape waits on that ground.

Measures 1, 3 and 4 do not decide; they are reported beside the decision so a later reader can
see what the coordination-only shape buys and what the worker shape would have cost in acceptance
and in unconfirmed claims. A reconciliation failure (measure 5) or a probe failure (measure 6)
opens a defect lane and does not stop the week.

## Run protocol

1. **Before the first B wake:** this manifest is on `main`; B is minted with `musterd agent`
   (which pushes the seat file, ADR 592) in a human-bound checkout on the Air; the key is in
   launchd's env under the enrolment's variable; `launchctl kickstart` the host; the roster shows B
   `hearing`. Record `daemon_build`, the guidance version, and the team export.
2. **Daily (one human pass):** list open unowned in-class lanes, hand off alternately per the
   allocation rule, read the two arms' spend against the ceilings. Nothing else is touched by hand:
   no steering B through a lane, no re-running a failed wake, no editing B's branches. A human who
   does intervene on a B lane sends a `steer` to B so the row exists, and that lane is reported
   with the intervention.
3. **Once in the window:** the adversarial probe (measure 6), on a day B has a work order running.
4. **After the window plus the 48-hour acceptance tail:** derive the six measures from
   `~/.musterd/musterd.db` on the hub (`messages`, `audit`, `wake_leases`, `wake_turns`, `lanes`)
   with the queries kept beside the finding; run `pnpm wake:rail --since <window start> --wakes`
   for the per-wake table. Attestation check first (an unattested wake is excluded and counted).
5. **Write finding 015**: question · this manifest by link · the per-arm tables · the kill
   criterion's verdict with the counts that made it readable or not · honest-N caveat · what it
   changes. Add the dated note to ADR 588 Consequences. Disenrol B if the verdict is
   coordination-only; keep A either way.

## Confounds, stated

- **Lane difficulty is not matched.** Alternation by `created_at` is the only balancing; with N in
  the single digits one hard lane moves the ratio. The finding lists every lane with its surface
  and its verdict so a reader can see which lane carried the number.
- **C's price is an API-rate price for a subscription seat.** The gateway prices Claude Code
  wakes at API rates while the seat's human pays a flat plan; the comparison is on the record's
  price, which is the price a resident seat would actually pay. ADR 588 Decision 2 already grants
  that a subscription seat is cheaper for a human's own session.
- **Acceptors can see the seat's name**, and grade `cross_model` (ADR 101) routes a B submit away
  from Claude acceptors. Measure 3 is reported per acceptor family for that reason.
- **One week on one team is one week on one team.** The verdict decides Decision 7 for this team's
  lane mix; it is not a claim about the worker shape in general.
- **A and C share the reply-wake path's confounds** (the ADR 436 rail's floor normalisation per
  harness); measure 1 reads wall-clock latency only and makes no token claim.

## Related

ADR 588 (what is being piloted; Decision 7 and §Observability), ADR 051 / ADR 194 (manifests,
compare → promote → observe), ADR 052 (baselines), ADR 436 and `scripts/research/wake-contract-rail.ts`
(the priced-wake rail arm C is read from), ADR 583 (the gateway that prices every arm), ADR 585
(the claims measure 4 counts), ADR 202 (the accept that decides measure 2's denominator),
[enrolling a resident seat](../wiki/resident-seat.md), [idle-wake-canary.md](../wiki/idle-wake-canary.md),
[frontier-cadence-manifest.md](./frontier-cadence-manifest.md) (the manifest shape this follows).
