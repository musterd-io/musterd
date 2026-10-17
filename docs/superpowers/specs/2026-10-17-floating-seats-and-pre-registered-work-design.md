# Pre-registered work and seats on N machines: a team whose machines pull their own work

**Date:** 2026-10-17
**Seat:** stanley
**Status:** design agreed with nick in chat on 2026-10-17; after the builder check nick chose to keep
agent seats one-node (ADR 358 §3) and to take floating seats later as its own ADR (§4.6). This
document is the written form. **Amended 2026-10-17 (lane `01M55WM708DDZGW7442GQ946JW`)** from
dolly's, big-body's and fifty's reads, applied on nick's "apply all"; the amendments are marked
_(review 2026-10-17)_ where they land. Nothing is built.
**Lane:** `01M55P9MGK3T8WW8RN9PD8X8GP` (goal `seat-continuity`)
**Source:** a brainstorm from arXiv 2610.12970, _Minions: A Dynamic and Distributed Virtual GPU Cloud
Built on Idle Apple Silicon Devices_ (Apple, 2026). The paper has no measurements; what it
contributes is a shape, not a number.

## 1. What this is for

nick owns two machines on one musterd team: the hub and a second MacBook Air. The Air syncs the team
and can run seats, but it does nothing unless nick points a seat at a lane by hand. He wants the
second machine, and any machine a team is spread across, to pick up seat work on its own, through
one mechanism that is the same for every musterd agent on every machine.

The paper's shape is this: a central store holds work; each idle machine _pulls_ a unit of work
when it has room; a database constraint makes one machine the owner; a machine that sleeps or dies
mid-job has its job returned to the queue; nobody schedules anything. musterd already has the
owner-per-lane constraint, the wake ledger and the ask tiers. What it does not have is the pull.

**Success, in nick's words:** a seat on any machine in the team takes the right kind of work on its
own, says so briefly first, and if nothing changes, takes it. The record shows the same chain as for any lane: who asked, who claimed, which model, who
accepted.

**Goals**

- One mechanism, any host. Air 2 is the first case, never a special case. The design holds for N
  machines on one network and for machines on different networks, as long as each can reach the hub.
- A declared class of lane is taken unprompted; every other lane still starts with a person.
- A machine that dies does not strand pre-registered work: the lane is unowned until claimed, and
  any machine may take it. (A seat's _addressed_ work still lives with the seat's one node; moving
  that is the later floating-seats ADR, §4.6.)
- Acceptance stays spread across seats. An always-awake host is the backstop, not the default judge.

**Non-goals**

- A scheduler, balancer or any central component that decides where a seat runs.
- Auto-scaling: minting seats on demand. Seats are the unit of attribution; the roster stays
  human-made.
- Running models locally on a host. That is a separate, smaller design (a fourth provider in the
  resident engine and a named local upstream in the ADR 583 gateway).
- Picking a lane for a seat other than the one you are talking to (the "dispatch console" the pick
  spec sets aside).
- Changing the ADR 430 wake packet.
- Floating seats (one seat enrolled on several nodes). Deferred to its own ADR by nick's decision
  on 2026-10-17; §4.6 records the shape so the later ADR starts from it.

**Anti-goals (a failure even if it works)**

- A seat takes a brainstorm, a user-facing lane, a risk-tagged lane or a dogfood run unprompted.
- A lane's class is inferred from its title or body. ADR 530 and ADR 536 forbid inference; the
  class is declared when the lane is opened.
- One awake machine ends up accepting most of the team's work because it is the only one listening.
  ADR 056's cross-family acceptance is the thing being protected.
- A host can act as a seat it was never enrolled for.

## 2. Words

- **Host:** a machine running `musterd host`, the actuator that spawns wakes (ADR 131). A host is
  attached to a daemon: the hub's own, or a joiner's.
- **Hub:** the team's daemon of record. Today nick's laptop; later Cloud. Joiners replicate from it.
- **Enrollment:** the record that a seat may run on a host. One host per seat (`residency`, unique
  on `member_id`); unchanged by this design.
- **Pre-registered lane:** a lane whose work and verdict rule are fixed in advance, so taking it adds
  no decision. Examples on the board on 2026-10-17: the ADR 536 fourteen-day read (lane
  `01M49HHJQF`), the ADR 436 trigger read (`01M3TB1GP`), the cookoff refresh on today's build
  (`01M1VDRC6B`), and "verify opencode's recents reader on a machine with opencode installed"
  (`01M4PHMBGY`).
- **Addressed work:** an act sent to a seat: an ask, a request_help, a handoff, a review work
  order. Today's wake triggers.

## 3. Constraints found before design

- **Unprompted pickup is rejected by three accepted ADRs.** ADR 179 §rejected: "No auto-pick from
  open lanes. An idle seat is never woken because unowned work exists… it breaks the directed-act
  doctrine and needs an assignment concept that does not exist." ADR 199 §7 repeats it. ADR 326
  moves the autonomy line to "between addressed and unaddressed work." The build therefore needs an
  ADR that reverses this for one declared class, and nothing else.
- **No trigger reads the board.** `claimWakeLeases` (`packages/server/src/store/residency.ts`)
  derives every due wake from the seat's inbox and the lanes it already owns. The continuation edge's
  own comment: "Never wakes for unowned open work."
- **A dead machine strands its lanes.** A reaped presence leaves the lane owned and idle; only a
  seat that _leaves_ has its lanes released (`releaseDepartedSeatClaims`). A dead wake lease retries
  the same seat on the same host, and no other host can take it because enrollment is one host per
  seat and leases are filtered by host.
- **An agent seat is bound to one node.** ADR 358 §3 ("agents stay one-node") binds every agent
  seat to exactly one node through `seat_nodes`; the hub refuses a claim or lane patch from any
  other node with `403 bound_elsewhere` (`assertSeatResident`, `packages/server/src/sync/claim.ts`),
  and the reaper records what happened when a joiner tried (2026-10-02: every later push wedged
  behind the first refusal). The reason is ADR 042's parallel-minds hazard: one seat must never run
  live in two places. This design keeps the binding: a seat still has one node, and what moves
  between machines is unowned work, never a seat. Relaxing it is the later ADR (§4.6). The
  identity authorisation checks is the node id; `residency.host` is a hostname string that goes
  stale after a move, so "host" in this document means the node.
- **Lane claims are already decided at the hub; wake leases are not.** A joiner forwards a lane
  patch to the hub (`sync/claim.ts`) and the hub's answer counts. `wake_leases` is never
  replicated: each daemon derives due wakes from its own copy and expires its own leases, and the
  wake-budget counters (ADR 236's 6 h ceiling, attempts per act) are local audit rows. The band-2
  pull therefore needs one hub-owned decision (the claim), while wake leases stay per node.
- **Credentials are not all portable.** A seat on Claude Code or Codex under a subscription login
  depends on a human having logged that harness in on that machine; the session cannot be copied. A
  key-bound seat (the resident engine, keys in the keychain, ADR 605) can run wherever the key is.
- **Ask tiers exist.** An advisory ask proceeds after 3 minutes of silence, a standard one after 5,
  a blocking one holds 15 (ADR 147/153, the `team_send` contract). The "about to take this" moment
  nick wants is an advisory ask, not a new concept.
- **An acceptance backstop exists in outline.** ADR 235: a submit either arms a backstop or the
  worker waits a window and self-closes, recorded unconfirmed. `sweepReapedAcceptances` already
  moves an acceptance ask away from a reaped reviewer.

## 4. The design

### 4.1 Three bands of work

Every lane is in exactly one band. The band decides who may start it.

| Band | What                                                                                                   | Who starts it                                                           | Mechanism                                                               |
| ---- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1    | Addressed work: asks, request_help, handoffs, review work orders                                       | The sender, by addressing the seat                                      | Today's wake triggers; the dispatch and review loops switched on         |
| 2    | Pre-registered work: fully specified, judged by a fixed rule, safe to redo                             | An enrolled host, unprompted, after an advisory ask lapses              | New: the pull (§4.3)                                                    |
| 3    | Everything else: brainstorms, user-facing or risk-tagged lanes, dogfood runs, open-ended feature work  | A person, or a seat a person is talking to (`musterd pick`, a handoff) | Unchanged                                                               |

Band 1 needs no new mechanism. It needs `loops.dispatch` and `loops.review` switched on for the
team (they are team policy, off by default, ADR 199 §1) and `flow: 'auto'` on each seat that should
answer unprompted. Both stay off by default.

**Band 2 is declared, never inferred.** A lane is pre-registered because the opener said so. The
declaration carries three things the lane must already contain: what to run, the rule that turns the
result into a verdict, and where the verdict is recorded. A lane missing any of the three is refused
the declaration at open time (a `lane_open` / `lane_update` check, the same shape as
`decidePickPatch`). A lane that carries a risk tag, `stakes: high` or `user-facing` is refused the
declaration at the same check, so the anti-goal is enforced once, at open, and the pull never has
to filter for it (stanley's call). _(review 2026-10-17, dolly)_ **The declaration is a struct, not
a value on `kind`:** `pre_registered: {run, verdict_rule, record, not_before?, expected_spend}`.
Checking the three parts against free-text `detail` would be inference, which §1's anti-goal
forbids; the parts need storage anyway; and `kind` is a daemon-set enum. `expected_spend` is
declared because "safe to redo" is not "free to redo": the cookoff refresh in §2 runs fifteen
model-call arms. A pull whose `expected_spend` is over the team's cap for a pull (a policy key,
default 0 = unmetered work only) is announced as a **standard** ask (5 min), not advisory. The
exact schema is the ADR's.

_(Superseded 2026-10-17 by ADR 645 §1/§3.)_ A pre-registered lane was to carry its own
**not-before date**. The same afternoon the Experiments panel's ADR 644 landed `reads_on` (a
`YYYY-MM-DD` day in the team's calendar zone) and `read_verdict` on every lane, for exactly these
dated reads. Two dates on one lane would disagree, so the declaration carries none: a dated read
carries `reads_on` beside `pre_registered`, and the pull withholds the lane until that day
(`pullEligible`). A person may still claim it early, and the claim reply says the date (the date
gates the machine, not the human). It is not `park_until`: parked means a person chose "not now",
and a parked lane is withheld from everyone; a read's day withholds it from the pull only.

### 4.2 Enrollment: verified when made

A seat still has one host. What changes is that enrolling a seat on a host runs on that host and
checks, before writing the row:

1. the seat's harness is installed there (the binary the residency names);
2. the model credential is present: a harness login for a login-bound seat, a keychain key for a
   key-bound one;
3. the seat's musterd credential for this host exists (one per (seat, host), chmod-600, revocable
   on its own);
4. the seat's workspace exists there (what `bootstrap.sh` provisions).

A check that fails refuses the enrollment and says which of the four is missing. Capability is
therefore declared and verified, never inferred at wake time. The enrollment table doubles as the
blast radius: it lists exactly what a stolen machine could act as.

A team across N hosts is expected to be uneven: two machines may hold the Claude Code seats, the
others key-bound seats, one a local model. Nothing in the design assumes every host can run every
seat, and a pre-registered lane that names a `role` is taken only by a host holding a seat with it.

### 4.3 The pull: hosts claim, the hub grants

Nothing pushes. Each host polls its daemon as today; wake leases for addressed work (band 1) stay
exactly where they are, per node. The one new decision is the band-2 claim, and it is made at the
hub, because a lane claim already is (`sync/claim.ts`): a host on a joiner asks through its own
daemon, which forwards the request and relays the answer. One atomicity point, no host-to-host
traffic. The hub down means nothing new is pulled; work already claimed continues on the host that
holds it (sloane's lane `A joiner keeps working through a hub outage` is the precedent).

- **Band 2 pull.** A host with room asks the hub (through its daemon) for a pre-registered lane
  one of its enrolled seats may take: open, unowned, not-before date passed, and the seat holds any
  `role` the lane names. The hub ranks by the ADR 536 order (goal motion, then age), picks the seat
  (the one holding the role; among several, the least recently woken), and answers with one (lane,
  seat) pair. _(review 2026-10-17, dolly 2, big-body 3)_ **The hub never acts as the seat.** No
  credential of the seat signs the announcement and no model is running yet, so an act "as the
  seat" would carry no attestation and break the chain this feature is judged by. Instead:
  1. the **host's own service seat** (ADR 232) sends the **advisory ask** (`species: consult`,
     `tier: advisory`) **to the lane's opener** (falling back to the team's admin when the opener
     has left): "host `<X>` proposes seat `<Y>` for `<lane>` (pre-registered: `<run>`); answer in
     3 min to stop it". Not `@team`: at four pulls a day per seat that is noise in every inbox, and
     with dispatch on it could wake other seats. The ask is excluded from wake triggers. It goes
     out whether or not a human is live; advisory means silence proceeds (ADR 153);
  2. the hub watches the window itself, so replication lag cannot let a host claim over an
     objection it has not seen. A `steer` or `decline` on the ask's thread, a claim of the lane by
     anyone, **or any change to the lane's state or declaration during the window** (parked,
     abandoned, re-scoped, un-declared; ADR 623's current-state-at-redemption rule) stops it; the
     hub records `lane.pull_declined` with the reason. _(fifty)_ On Cloud, where N daemons share
     one database, the watcher needs a single-runner rule: the announcement row is transitioned
     atomically and the first server to take the window owns it (the same rule is applied to
     `sweepReapedAcceptances`, which today runs on every server);
  3. on silence, the claim is made **as the enrolled seat, from that node, under that seat's own
     credential** (enrollment check 3), with the ordinary server checks re-run at claim time
     (banned or archived seat, current residency: enrollment-time probes go stale). `assertSeatResident`
     passes because the seat's one node is this one; on Cloud the residency check is enrollment,
     not `seat_nodes` (fifty). The claim's ADR 624 attestation gets its own value, **`pulled`**
     (neither a human-signed pick nor a self-claim), and an audit row
     `lane.pulled {lane, seat, host, ask}` joins the claim to the announcement. `requested` is
     untouched: it records who asked for the lane, which is still the opener;
  4. the grant is delivered as a **directed work order to the seat** (the dispatch-handoff shape,
     ADR 199), so the wake path is untouched and the seat's first act in its wake is the first act
     in its name. The pull ends in band 1.
- **A pulled lane is released when its host dies.** _(review 2026-10-17, dolly 1)_ Once claimed, the
  lane is owned by a one-node seat and nothing today returns it. For a pulled lane the hub releases
  it back to `open` (owner cleared, `lane.pull_released` audited with the reason) after its wake
  lease has expired `PULL_RELEASE_AFTER_EXPIRIES` times (default 3) or its host has been absent for
  `PULL_RELEASE_AFTER_MS` (default 2 h). Band 2 is redo-able by definition, so release is safe; the
  next pull may take it on another host. Addressed work is not released by this rule; that is §4.6.
- **Rate.** One band-2 pull in flight per host at a time, and a per-seat daily cap set by team
  policy (default: 4). Both are declared, both audited (`residency.pull_offered`,
  `residency.pull_claimed`).

### 4.4 Acceptance: spread first, awake host as backstop

The reviewer picker (ADR 260) chooses as it does today. The change is at the window.
_(review 2026-10-17, dolly 8)_ **Scoped to band-2 lanes for now.** As first written this changed
acceptance for every lane on the team. It applies only to lanes claimed by pull; widening it to all
lanes is its own ADR, and it keeps ADR 603's human stage on risky lanes (none can be band 2) and
ADR 158's refusal of an unattested worker (a `pulled` claim with no model yet is not a worker until
its wake attests one). _(big-body 4)_ No security issue found in the live-presence-only move.

- When a submit arms no backstop and the acceptance window lapses (ADR 506, default 20 min), the
  hub moves the ask to a seat with **live presence** (not merely an awake host; the move never
  starts a paid wake), **preferring a seat of a different model family from the worker**, and the
  worker gets a second window of the same length before it may self-close. `sweepReapedAcceptances`
  already moves an ask on a reap and runs on the hub only; this moves it on the window as well, on
  the hub only. The submit reply (ADR 235) changes to say so, so the worker and the sweep do not
  race: "an acceptor asked, a backstop will be tried at <time>; self-close only after <time + window>".
- A self-close is still possible, still recorded unconfirmed, but only after the backstop was also
  silent.
- An always-awake host is never preferred at first pick. Availability does not decide who judges.

### 4.5 What the record shows

Every band-2 pickup leaves the same chain as a human-started lane, plus the announcement:

- the advisory ask (the host's service seat, when, the proposed seat and lane, to the opener);
- the claim (attestation `pulled`) and the `lane.pulled` audit row naming the ask, and
  `lane.pull_released` if the host died;
- the wake rows (`residency.woke`, `wake_cost`, the host that ran it);
- the submit and the acceptance, by the ordinary path.

A lane taken by pull and a lane handed off are distinguishable in one query. The `/live` roster
shows which host a seat is enrolled on, and a pulled lane shows its announcement.

### 4.6 Later, as its own ADR: floating seats

Deferred by nick on 2026-10-17 after the builder check. The shape, so the later ADR starts here:
a seat enrolled on several nodes (`seat_nodes` holds a set; `residency` one row per (seat, host),
each row verified by §4.2's four checks); the hub derives and stores that seat's wake leases and
keeps its counters, so a lease lost on one host is re-offered to the others on the next poll and
the ADR 236 ceiling is counted once; the hub-granted lease replaces ADR 358 §3's one-node binding
as the guard against ADR 042's parallel minds (one lease per seat at a time; `bound_elsewhere`
stays for nodes the seat is not enrolled on); and a branch rule: a seat with unpushed work on a
lane branch resumes only on the host holding it, the host reporting pushed-or-not at settle, a
resume elsewhere deferred (`branch_elsewhere`, not counted) rather than guessed. _(review
2026-10-17, big-body 2)_ A hub lease is a sound one-live guard **only if it fences writes from an
expired holder**: during a partition or a delayed host, lease expiry can let host B start while host
A still has a live process. The later ADR must give every lease a monotonically increasing fencing
token carried on every seat-authenticated mutation, with the server rejecting a stale token, and
must say what happens to host A's in-flight work; without that ADR 042's parallel-minds hazard
remains. It is the piece that stops a dead machine stranding a seat's _addressed_ work. Measured by the ADR 436 rail: the
share of expired leases a second host picked up. Lane `01M55PDGG8BCXK3JCPB33CFHDK` holds it,
blocked on increment 6's readout.

## 5. What is left to the builder

- The exact schema of the `pre_registered` struct and the not-before date (ADR; agree with the
  Experiments-panel lane), and the pull spend-cap policy key.
- The release thresholds (`PULL_RELEASE_AFTER_EXPIRIES`, `PULL_RELEASE_AFTER_MS`) as policy keys.
- The Cloud single-runner rule for the window watcher and for `sweepReapedAcceptances` (fifty).
- The enrollment checks' exact probes per harness (how "logged in" is detected for Claude Code,
  Codex, Grok, OpenCode without reading a credential).
- The band-2 request forwarding on a joiner (reuse of the lane-patch forward in `sync/claim.ts`).
- Policy keys and defaults: the per-seat daily pull cap, the per-host concurrency cap, the band-2
  ask window (advisory, 3 min, unless a team sets otherwise).
- The host's concurrency signal (what "has room" means on a laptop: a declared cap, not a load
  reading).
- Tests: a pre-registered lane with a future date is not offered, then is; a `steer` inside the
  window stops the claim; a park or un-declare inside the window stops it; the claim is refused for
  a banned seat and for a seat whose residency moved since enrollment; a pulled lane is released
  after the third expired lease and may be pulled by another host; the acceptance backstop prefers
  a different family and touches no band-3 lane; a host whose seat lacks the lane's `role` is not
  offered it; a lane declared pre-registered with a risk tag is refused at open; an
  `expected_spend` over the cap announces as a standard ask.

## 6. Increments

Each increment is a lane under goal `seat-continuity`, opened unowned on 2026-10-17; the lanes are
declarations and are abandoned if the design is rejected.

1. **ADR** (lane `01M55PDB32NG2B863DXSZSR5WT`) reversing ADR 179 / 199 / 326 for the declared class, with the `pre_registered`
   struct, the not-before date, the `pulled` attestation value, the release rule, and the two Cloud
   sentences (enrollment is the residency check; a single-runner rule for the watcher). ADR 358 §3
   is untouched. Nothing else lands before it.
2. **Enrollment checks** (lane `01M55PDWM99YFPHAPDKGN4ZT9S`): the four checks at enroll time, and `/live` showing a seat's host. No
   behavior change for an already-enrolled seat.
3. **Floating seats** (lane `01M55PDGG8BCXK3JCPB33CFHDK`, blocked on increment 6's readout): §4.6, its own ADR.
4. **Band 2 pull** (lane `01M55PDKAT7368RQATDG70FSYB`): the service-seat announcement to the opener, the hub-decided claim as
   the enrolled seat, the directed work order, the joiner forward, the release rule, the caps and
   the audit rows.
5. **Acceptance backstop on the window** (lane `01M55PDNY5APFDP27CR9MET224`), band-2 lanes only, preferring a different family.
6. **Dogfood:** (lane `01M55PDR9ZPQH55GF0S38K9B69`) the two dated reads on the board at the time are opened as pre-registered lanes and
   taken by the Air without nick starting them. The readout is the share of band-2 lanes taken
   unprompted, their acceptance rate, and how many were stopped inside the window.

## 7. Open questions settled here, by stanley

- No scheduler. Work is pulled; a placement service would be a component that can be wrong about
  where a seat should be, and the paper's experience is that informal capacity is enough inside one
  organisation. Seats stay one-node for now (nick, 2026-10-17): band 2 does not need floating,
  and floating is a trust-model change that deserves its own ADR once the pull is measured.
- No auto-scaling, because seats are the unit of attribution.
- Band 2 is a declared lane class rather than a per-seat "may take anything" switch, because the
  anti-goal is a seat taking judgement work, and a per-seat switch cannot see the lane.
- The announcement is an advisory ask (3 min) rather than standard (5 min), because the work is
  redo-able by definition; nick asked for a light moment.
- The hub, not the host, watches the announcement window and decides the claim, because the host's
  copy of the thread can lag.
- _(review 2026-10-17)_ The `local`-style shortcut of letting the hub speak as the seat is gone: the
  host's service seat announces, the claim is the seat's own with a `pulled` attestation, and the
  grant is a work order. Three reads said the same thing from three angles.
- _(review 2026-10-17)_ A pulled lane is released on a dead host because band 2 is redo-able; an
  addressed lane is not, because it is not.
- _(review 2026-10-17)_ The backstop is band-2-only until its own ADR widens it.
- The pull record is an audit row plus the claim attestation, not `requested`, because `requested`
  already means "who asked for this lane" (ADR 629) and the opener still did.
- The not-before date gates pulls only. A person claiming early is a decision the record can show.
- Band 2 refuses risk-tagged, high-stakes and user-facing lanes at declaration time rather than
  filtering them at pull time, so there is one place the rule lives.
- Backstop "awake" means live presence, so a backstop never costs a wake.
