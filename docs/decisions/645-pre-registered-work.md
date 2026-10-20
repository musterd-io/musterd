# 645 — Pre-registered work: a declared lane class a host may take unprompted

- Status: accepted
- Date: 2026-10-17
- Lane: `01M55PDB32NG2B863DXSZSR5WT` (goal `seat-continuity`). Spec:
  [pre-registered work and seats on N machines](../superpowers/specs/2026-10-17-floating-seats-and-pre-registered-work-design.md)
  (#2794, amended #2802 from dolly's, big-body's and fifty's reads). Decided with nick in chat on
  2026-10-17.
- Reverses, for one declared class only: [ADR 179](179-board-triggered-work-order-wakes.md) §rejected ("No
  auto-pick from open lanes"), [ADR 199](199-dispatch-loop-wake.md) §7 ("Auto-pick from unowned open
  lanes" out of scope), and the [ADR 326](326-session-orientation.md) amendment that draws the
  autonomy line at unaddressed work. Builds on [ADR 624](624-lane-picker-pick-attestation.md) (the
  claim attestation), [ADR 629](629-lane-requested-by.md) (who asked),
  [ADR 644](644-lane-reads-on-and-read-verdict.md) (`reads_on` / `read_verdict`: the date and the
  verdict a dated read carries), [ADR 232](232-ledger-seats-every-actor-on-the-roster.md)
  (service seats), [ADR 153](153-ask-reachability-gated-hold.md) (ask tiers),
  [ADR 623](623-channel-answer-wire-and-decision-record.md) (current state at redemption),
  [ADR 358](358-human-seat-trusts-a-set-of-machines.md) §3 (untouched: agent seats stay one-node).

## Context

Three accepted ADRs say a seat never takes a lane nobody pointed it at. ADR 179 rejected "wake
whoever for whatever is open" because "it breaks the directed-act doctrine and needs an assignment
concept that does not exist"; ADR 199 §7 kept auto-pick out of the dispatch loop; ADR 326 moved the
autonomy line to "between addressed and unaddressed work." The doctrine has held: every wake on the
ledger traces to an act someone sent (ADR 494: "every wake today has a reason someone else gave it").

nick owns two machines on one team. The second one syncs the team and can run seats, and does
nothing unless he points a seat at a lane by hand. Meanwhile the board carries a class of lane
that sits for days waiting for a seat to notice it, and that needs no judgement to start: the ADR
536 fourteen-day read ("on 2026-10-20 run `pnpm next:readout`, record the verdict by this fixed
rule"), the ADR 436 trigger read, the cookoff refresh on today's build, "verify opencode's recents
reader on a machine with opencode installed." Each says exactly what to run, how to judge the
result and where to record it. Taking one adds no decision, and a half-done one can be redone.

The shape that fits is the one arXiv 2610.12970 (_Minions_, Apple) runs on idle Macs: a central
store holds fully specified work, each idle machine pulls a unit when it has room, a constraint
makes one machine the owner, and nobody schedules. musterd already has the one-owner constraint
(`decideLanePatch`), the wake ledger and the ask tiers. It has no pull.

ADR 179's objection was the missing assignment concept. The answer here is that for this class
there is none to invent: the lane's own declaration is the assignment, and a machine's declared
capacity is the only other input.

## Problem

Decide the smallest reversal of ADR 179/199/326 that lets a host take unowned work on its own
without a seat ever taking judgement work, without the hub speaking as a seat it does not hold a
credential for, without inferring anything from a lane's prose, and with the same chain on the
record as a human-started lane: who asked, who claimed, which model, who accepted.

## Decision

1. **A lane may carry a `pre_registered` declaration.** `Lane.pre_registered` is
   `{run, verdict_rule, record, not_before?, expected_spend, by, at}` (`LanePreRegisteredSchema`,
   `@musterd/protocol` `lanes.ts`). The opener sets `run`, `verdict_rule`, `record`,
   `expected_spend` (USD, `0` = unmetered work) and optionally `not_before` (ms); the daemon stamps
   `by` and `at` from the authenticated writer. _(Amended 2026-10-17: there is no `not_before`;
   the day a read is due is ADR 644's `reads_on`. See the 2026-10-17 note in Consequences.)_ It rides `lane_open` and `lane_update`; `null` on an
   update withdraws it. It is a struct, not a value on `kind`, because the three text parts need
   storage and `kind` is a daemon-set enum. The declaration is the only source of truth: nothing
   reads a title or a detail to decide a lane is pre-registered (ADR 530/536).
2. **The declaration is refused where the anti-goal lives.** `preRegisteredRefusal` refuses it on
   a lane with any risk tag, with `user-facing`, or with `stakes: 'high'` (400, naming which), and
   the daemon refuses it on a lane that is not `open` (409). The rule is enforced once, at the
   declaration; the pull never filters for it.
3. **A pull offers only an eligible lane.** `pullEligible(lane, now)`: open, unowned, declared, and
   past `not_before`. _(Amended 2026-10-17: `pullEligible(lane, today)`, gating on `reads_on`; see
   Consequences.)_ The date gates the machine, not the human: a person may claim early, and the
   claim reply says the date. The pull itself (a host with room asking the hub for one such lane
   for one of its enrolled seats, ranked by the ADR 536 order) is lane `01M55PDKAT7368RQATDG70FSYB`
   under this ADR; this ADR fixes what it may offer.
4. **The hub never acts as the seat.** The announcement is sent by the **host's service seat**
   (ADR 232) to the lane's opener (falling back to the team admin), as an advisory `ask`
   (`species: consult`, 3 min, ADR 153): "host X proposes seat Y for lane Z". A lane whose
   `expected_spend` is over the team's pull spend cap (a policy key, default 0) is announced as a
   standard ask (5 min). The ask is excluded from wake triggers. The hub watches the window itself;
   a `steer` or `decline` on the thread, a claim by anyone, or any change to the lane's state or
   declaration during the window stops it (ADR 623's current-state rule), audited
   `lane.pull_declined`. On silence the **claim is made as the enrolled seat, from its one node,
   under that seat's own credential**, with the ordinary checks re-run at claim (banned or archived
   seat, current residency). The claim carries `pick: {via: 'pull', requested_by: <service seat>,
   attested: false, ask: <announcement id>}` (ADR 624 extended by one `via`; the honest-label rule
   stands, nobody signed as the seat), and an audit row `lane.pulled {lane, seat, host, ask}`.
   `requested` (ADR 629) is untouched: the opener still asked for the lane. The grant is delivered
   to the seat as a directed work order (ADR 199's dispatch-handoff shape), so the seat's first act
   in its wake is the first act in its name and the wake path is unchanged.
5. **A pulled lane is released when its host dies.** The hub returns a pulled lane to `open`
   (owner cleared, `lane.pull_released` audited with the reason) after `PULL_RELEASE_AFTER_EXPIRIES`
   expired wake leases (default 3) or `PULL_RELEASE_AFTER_MS` of host absence (default 2 h). Only a
   pulled lane: band 2 is redo-able by declaration. Addressed work is not released by this rule.
6. **One daemon decides.** The claim is decided at the hub, as every lane claim is (`sync/claim.ts`);
   a joiner forwards the request. On Cloud, where N daemons share one database, the window watcher
   and the release sweep run under a single-runner rule: the announcement row is transitioned
   atomically and the first server to take the window owns it. The residency check a pull makes on
   Cloud is enrollment, not `seat_nodes`.
7. **Seats stay one-node.** ADR 358 §3 is untouched. The pull takes unowned work; it never moves a
   seat. A seat enrolled on several nodes, with the lease as the one-live guard and a fencing token
   on every seat-authenticated mutation, is the later ADR the spec's §4.6 describes (lane
   `01M55PDGG8BCXK3JCPB33CFHDK`, blocked on this series' readout).
8. **Rate.** One pull in flight per host; a per-seat daily cap (team policy, default 4). Both
   declared, both audited (`residency.pull_offered`, `residency.pull_claimed`).

### Rejected

- **A per-seat "may take anything" switch.** The anti-goal is a seat taking judgement work, and a
  switch on the seat cannot see the lane. The class is on the lane.
- **Inferring the class from the title** ("pre-registered:" prefixes are already appearing in lane
  titles on this team). ADR 530 and ADR 536 forbid it, and a title is not a verdict rule.
- **The hub announcing and claiming "as the seat".** No credential of the seat signs it and no
  model is running yet, so the record would show an act with no attestation behind it; all three
  reviewers (dolly, big-body, fifty) refused it from different angles.
- **`@team` as the announcement's addressee.** Four pulls a day per seat is noise in every inbox,
  and with dispatch on it could wake other seats on someone else's announcement.
- **Reusing `park_until` for `not_before`.** Parked means a person chose "not now" and withholds
  the lane from everyone; `not_before` withholds it from the pull only. _(Amended 2026-10-17:
  `not_before` itself is gone; the same reasoning now keeps `park_until` apart from `reads_on`.)_
- **Widening the acceptance backstop to every lane** in this ADR. The spec's §4.4 (a lapsed
  acceptance ask moves to a live-presence seat of a different family) is scoped to pulled lanes
  (lane `01M55PDNY5APFDP27CR9MET224`); the team-wide change is its own ADR.

## Consequences

- `@musterd/protocol`: `LanePreRegisteredSchema`, `OpenPreRegisteredSchema`, `Lane.pre_registered`,
  `pre_registered` on `OpenLaneSchema` / `UpdateLaneSchema` (nullable on update), `PickSchema.via`
  gains `'pull'` and `ask`, and the pure `preRegisteredRefusal` / `pullEligible`
  (`lanes.pre-registered.test.ts`). Additive, skew-tolerant (absent reads as not declared); no
  `FEATURE_EPOCH` bump, because an older seat still renders and claims the lane and only lacks the
  pull, which is the daemon's.
- The daemon side (storage `lanes.pre_registered_json`, the open/update refusals, the pull, the
  announcement, the release sweep, the policy keys) lands under lanes `01M55PDWM99YFPHAPDKGN4ZT9S`
  (enrollment checks), `01M55PDKAT7368RQATDG70FSYB` (the pull), `01M55PDNY5APFDP27CR9MET224` (the
  backstop) and `01M55PDR9ZPQH55GF0S38K9B69` (the dogfood readout), in that order. Nothing in this
  ADR's increment changes daemon behaviour.
- _(2026-10-17, same day, lane `01M55PDB32NG2B863DXSZSR5WT`, follow-up PR.)_ **One date, and it is
  ADR 644's.** #2803 merged at 14:55 with `not_before` on the declaration; ADR 644 (#2800) had
  landed `reads_on` (a `YYYY-MM-DD` day in the team's calendar zone) and `read_verdict` an hour
  earlier for the same dated reads, and two dates on one lane would disagree. So Decision 1's
  `not_before` is removed from `LanePreRegisteredSchema`, and Decision 3's `pullEligible` becomes
  `pullEligible(lane, today)`: open, unowned, declared, and not before the lane's `reads_on` day,
  with `today` the day ADR 644 derives `read_status` on, so the panel's `waiting` and the pull's
  "not yet" use one clock. A dated read that should also be taken unprompted carries both
  `reads_on` and `pre_registered`; one a person will run carries `reads_on` alone. The spec's §4.1
  carries the superseded note. Until ADR 644's increment 1 (lane `01M55WJXNP`) adds `reads_on` to
  the schema, `pullEligible` reads it as a loose optional string.
- _(2026-10-17, lane `01M55PDWM99YFPHAPDKGN4ZT9S`, increment 2.)_ The enrollment checks are built:
  `musterd residency on` verifies the harness binary, the harness login (existence of its login
  artifact, a provider key in env, or the Keychain item; for the native engine the key and a
  declared model), the seat's own binding with a credential in the named workspace, and the
  workspace, before the enroll request, and refuses on any miss with nothing written
  (`packages/cli/src/commands/residencyChecks.ts`). Only when `--host` is this machine; another
  host's state cannot be probed from here, so that case warns and proceeds as before. `/live`
  shows an enrolled offline seat's node from `residence`. No server change: the row is still
  one host per seat (ADR 358 §3), and a daemon never checks a machine.
- _(2026-10-17, lane `01M55PDKAT7368RQATDG70FSYB`, increment 4.)_ The pull is built, and with it
  the daemon side of the declaration that increment 1 left to this lane: `lanes.pre_registered_json`
  (v106), stamped `by`/`at` from the writer, refused 400 by `preRegisteredRefusal` at open and
  update (a patch that tags a declared lane risky is refused the same way) and 409 on a lane that
  is not open; the fold carries it. On the MCP surface it rides `lane_update` only — a declaration
  is a second call after the open — because the undescribed object costs the tools-list budget
  257 B once and would cost it twice on `lane_open` (`docs/perf/context-budgets.json`). The pull:
  `POST /residency/pull` on the host's tick (joiner → `/sync/pull`), `store/pull.ts` (the offer,
  the window sweep and the release in the reaper, hub only), the host's service seat `host-<label>`
  as the announcer, `pick {via:'pull', ask}` checked in `decideLanePatch`, `redeemPullGrant` on
  the host with the seat's own credential, and the five audit rows named in Decision 4, 5 and 8.
  Policy keys are `pull.*` (`PullPolicySchema`). A grant nobody redeems in 15 minutes is declined
  and the lane offered again. Not built here: the CLI flags for the declaration (the MCP tool and
  the HTTP body carry it), and the acceptance backstop (increment 5).
- _(2026-10-17, lane `01M55PDKAT7368RQATDG70FSYB`, acceptance follow-up.)_ The acceptor found the
  one rule increment 4 missed: Decision 4 says the announcement is excluded from wake triggers, and
  the landed code had no exemption — offline openers were safe only because a non-urgent ask never
  reaches the paid rail, but a live opener idle at its prompt was rung through the idle seam
  (`idleRingable` admits any directed `ask`). Fixed in `@musterd/protocol`: `idleRingable` refuses
  an `ask` carrying `meta.pull` (`isPullAnnouncement`), urgent or not, so neither the idle-wake
  route nor the immediate wake predicate sees it; the ledger never did. The announcement still sits
  in the opener's inbox. `pull.test.ts` asserts all three.
- _(2026-10-17, lane `01M55PDNY5APFDP27CR9MET224`, increment 5.)_ The acceptance backstop on the
  window is built, pulled lanes only (spec §4.4): `sweepLapsedPulledAcceptances` runs on the hub's
  reaper tick beside the reaped sweep, and on a team with no `loops.sweep` it moves a pulled
  lane's still-open acceptance ask ONCE, when the promised window (ADR 506) has lapsed, to a seat
  with live presence by the ordinary picker (the ladder prefers another family from the worker),
  as a `lane.review_rerouted` row with `route: 'lapsed'`; never a wake, never a close, and a
  human-stage ask is waited on. One move per submission; the guarded `UPDATE lanes … WHERE
  updated_at = ?` is the Cloud single-runner fence. The submit reply on such a lane carries
  `review.backstop {armed: false, move_at, self_close_after}` and the MCP hint says "a backstop
  will be tried at <time>; self-close only after <time + window>", so the worker and the sweep do
  not race. The second window is stated, not enforced: a self-close before it is still recorded
  unconfirmed, as before. Not built here: the dogfood readout (increment 6).
- _(2026-10-17, lane `01M55PDR9ZPQH55GF0S38K9B69`, increment 6, setup.)_ The two dated reads on
  the board (`01M49HHJQF`, ADR 536, reads 2026-10-20; `01M3TB1GPM`, ADR 436, reads 2026-10-21)
  were released from stanley and their openers asked to declare them pre-registered with the
  verdict rules the two ADRs fix. With `expected_spend: 2` over the shipped `spend_cap_usd: 0`
  both announce as standard asks. Setup, falsifiers and the readout table:
  [pre-registered work dogfood](../wiki/pre-registered-work-dogfood.md); the readout fills on
  2026-10-22 or when both lanes close. Follows-up: the readout itself, on this lane.
- ADR 179 §rejected, ADR 199 §7 and the ADR 326 amendment are read with this ADR beside them: the
  autonomy line stays at unaddressed work for every lane that carries no declaration.

- 2026-10-20, lane 01M5D62FZJ: the pull wedged every joiner's sync fold. Two gaps, both from
  the first landing: `lane.pulled`, `lane.pull_declined` and `lane.pull_released` are written with
  `appendLaneEventRequired`, so they replicate, but the fold's lane verbs listed none of them and
  stopped as `unknown_lane_event` ("a peer runs a newer build", though both ran main); and the
  host's service seat is minted on the hub by `addMember`, which no event carries, so a joiner
  stopped `unresolved_seat` on the first pull ask. nick's second laptop sat at one hub event for
  about ten hours, and lane and policy writes from it were refused as stale meanwhile. The fold
  now knows the three verbs (`lane.pull_released` projects with the origin's owner guard) and
  mints a host service seat when the envelope names the host it folds from. The stuck laptop was
  unblocked by minting its four missing `host-*` seats by hand before the fix landed.

## Observability & Evaluation

- **Traces:** `lane.pulled` / `lane.pull_declined` / `lane.pull_released` audit rows, each naming
  the lane, the seat, the host and the announcement act; `lane.claimed` rows with
  `pick.via = 'pull'`; `lane.opened` / `lane.updated` rows carrying `pre_registered`, and the 400 /
  409 refusals of a declaration.
- **Eval**, read with the dogfood lane (`01M55PDR9ZPQH55GF0S38K9B69`): of pre-registered lanes
  opened, the share taken by pull rather than by a person; of pulls announced, the share stopped
  inside the window and by what (steer, decline, competing claim, state change); of pulled lanes,
  the acceptance rate against the team's rate for human-started lanes; and the count released
  on a dead host. Falsifier: if pulled lanes are accepted at a lower rate than human-started lanes
  of the same `change_class` over the first 30 pulls, the declaration is not capturing "no
  judgement needed" and Decision 2's refusal list is too short.
- **Experiment:** the two dated reads on the board at the time (ADR 536's and ADR 436's successors)
  are opened pre-registered and left for a host to take unprompted; the readout says whether they
  were taken, by which host, and whether nick had to start either by hand.
