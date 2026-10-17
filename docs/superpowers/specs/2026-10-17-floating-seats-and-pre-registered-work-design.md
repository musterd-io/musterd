# Floating seats and pre-registered work: a team across N machines that pulls its own work

**Date:** 2026-10-17
**Seat:** stanley
**Status:** design agreed with nick in chat on 2026-10-17. This document is the written form; nick
has not yet approved it. Nothing is built.
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
own, says so briefly first, and if nothing changes, takes it. A machine that dies does not strand
the work. The record shows the same chain as for any lane: who asked, who claimed, which model, who
accepted.

**Goals**

- One mechanism, any host. Air 2 is the first case, never a special case. The design holds for N
  machines on one network and for machines on different networks, as long as each can reach the hub.
- A declared class of lane is taken unprompted; every other lane still starts with a person.
- Seats float: a seat may run on more than one host, and a wake lost on one host is taken by another.
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
- **Enrollment:** the record that a seat may run on a host. Today one host per seat (`residency`,
  unique on `member_id`). This design makes it one row per (seat, host).
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
- **Lane claims are already decided at the hub.** A joiner forwards a lane patch to the hub
  (`packages/server/src/sync/claim.ts`); the hub's answer is the one that counts. Leases must do the
  same or two hosts take one wake.
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

Band 1 needs no new mechanism. It needs `loops.dispatch`, `loops.review` and the seat's `flow:
'auto'` switched on for the seats that should answer unprompted. They are off by default (ADR 199
§1) and stay so; a team turns them on per seat.

**Band 2 is declared, never inferred.** A lane is pre-registered because the opener said so. The
declaration carries three things the lane must already contain: what to run, the rule that turns the
result into a verdict, and where the verdict is recorded. A lane missing any of the three is refused
the declaration at open time (a `lane_open` / `lane_update` check, the same shape as
`decidePickPatch`). The field is left to the ADR; the recommendation is a value on the existing
`Lane.kind` (today only `incident`), because the incident path is the one place the daemon already
gives an unowned lane an owner, and this is its second case.

A pre-registered lane may also carry a **not-before date**, since most of today's examples are
dated reads. Before that date the lane is visible and not offered. There is no lane field for this
today; the Experiments-panel lane (`01M55KZF5M`, slippy) needs the same field and the two designs
should agree on it.

### 4.2 Enrollment: one row per (seat, host), verified when made

`residency` becomes one row per (seat, host). Enrolling a seat on a host runs on that host and
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

A team across N hosts is expected to be uneven: two machines may run the Claude Code seats, all N
run key-bound seats, one has a local model. Nothing in the design assumes every host can run every
seat.

### 4.3 The pull: hosts claim, the hub grants

Nothing pushes. Each host polls its daemon as today. The changes are at the grant:

- A due wake for a seat is **offered to every host enrolled for that seat**. The first host to
  claim the lease runs it. A busy host (its own concurrency cap) does not claim, so load spreads
  without a balancer.
- **The grant is decided at the hub.** A joiner forwards a lease claim to the hub the way it
  forwards a lane patch. One atomicity point, no host-to-host traffic. The hub down means nothing
  new is leased; work already leased continues on the host that holds it (sloane's lane
  `A joiner keeps working through a hub outage` is the precedent).
- **A lost lease is re-offered.** When a lease expires because the host was unreachable or died
  (`expireWakeLeases`), the wake is due again on the next poll and any other enrolled host may take
  it. The lane keeps its owner (the seat); only the host changes. This replaces "retry the same host
  until the 6 h ceiling" with "retry anywhere the seat is enrolled, then the ceiling."
- **Branch rule.** A seat with unpushed work on a lane branch resumes on the host holding that
  branch while that host is awake. Otherwise it resumes anywhere, because the branch was pushed with
  the lane (the handoff contract). The host records which it did; a resume elsewhere with an
  unpushed branch is refused, not guessed.
- **Band 2 pull.** A host with room asks its daemon for a pre-registered lane it may take: open,
  unowned, not-before date passed, and the seat enrolled on this host holds any `role` the lane
  names. The daemon ranks by the ADR 536 order (goal motion, then age) and answers with one lane.
  The host then:
  1. sends an **advisory ask** to the team on the seat's behalf: "taking `<lane>` (pre-registered:
     `<what it runs>`); say so in 3 min to stop me";
  2. on a `steer`, `decline` or a claim by someone else, drops it and records
     `residency.pull_declined`;
  3. on silence, claims the lane as the seat (an ordinary `lane_claim`, `takeover_of_offline_owner`
     never set, because the lane was unowned) and starts the wake. The claim's `requested` is
     `{basis: 'self', ref: <the ask id>}` so the record shows the announcement.
- **Rate.** One band-2 pull in flight per host at a time, and a per-seat daily cap set by team
  policy (default: 4). Both are declared, both audited (`residency.pull_offered`,
  `residency.pull_claimed`).

### 4.4 Acceptance: spread first, awake host as backstop

The reviewer picker (ADR 260) chooses as it does today. The change is at the window:

- When a submit arms no backstop and the acceptance window lapses (ADR 506, default 20 min), the
  ask is moved to an awake seat on any enrolled host, **preferring a seat of a different model
  family from the worker**, before the worker may self-close. `sweepReapedAcceptances` already
  moves an ask on a reap; this moves it on the window as well.
- A self-close is still possible, still recorded unconfirmed, but only after the backstop was also
  silent.
- An always-awake host is never preferred at first pick. Availability does not decide who judges.

### 4.5 What the record shows

Every band-2 pickup leaves the same chain as a human-started lane, plus the announcement:

- the advisory ask (who announced, when, the lane);
- the claim, with `requested.basis = self` and `ref` = the ask;
- the wake rows (`residency.woke`, `wake_cost`, the host that ran it);
- the submit and the acceptance, by the ordinary path.

A lane taken by pull and a lane handed off are distinguishable in one query. The `/live` roster
shows a seat's enrolled hosts and which one holds its current lease.

## 5. What is left to the builder

- The exact field for the pre-registered declaration and the not-before date (ADR; agree with the
  Experiments-panel lane).
- The migration from one-host-per-seat `residency` to (seat, host) rows, and what `musterd
  residency` prints for a seat enrolled on several hosts.
- The enrollment checks' exact probes per harness (how "logged in" is detected for Claude Code,
  Codex, Grok, OpenCode without reading a credential).
- The lease forwarding on a joiner (reuse of the lane-patch forward in `sync/claim.ts`).
- Policy keys and defaults: the per-seat daily pull cap, the per-host concurrency cap, the band-2
  ask window (advisory, 3 min, unless a team sets otherwise).
- The host's concurrency signal (what "has room" means on a laptop: a declared cap, not a load
  reading).
- Tests: two hosts enrolled for one seat, one dies mid-wake, the other finishes; a pre-registered
  lane with a future date is not offered, then is; a `steer` inside the window stops the claim; the
  acceptance backstop prefers a different family; a host enrolled for seat A cannot claim a wake for
  seat B.

## 6. Increments

Each increment is a lane under goal `seat-continuity`, opened unowned on 2026-10-17; the lanes are
declarations and are abandoned if the design is rejected.

1. **ADR** (lane `01M55PDB32NG2B863DXSZSR5WT`) reversing ADR 179 / 199 / 326 for the declared class, with the field for the declaration
   and the not-before date. Nothing else lands before it.
2. **Enrollment** (lane `01M55PDWM99YFPHAPDKGN4ZT9S`) per (seat, host) with the four checks, and `/live` showing it. No behavior change
   yet: a seat on one host behaves as today.
3. **Lease offer to all enrolled hosts** (lane `01M55PDGG8BCXK3JCPB33CFHDK`) and re-offer on expiry; hub-decided grants from a joiner.
   Measured by the ADR 436 rail: the share of expired leases that a second host picked up.
4. **Band 2 pull** (lane `01M55PDKAT7368RQATDG70FSYB`) with the advisory ask, the claim, the caps and the audit rows.
5. **Acceptance backstop on the window** (lane `01M55PDNY5APFDP27CR9MET224`), preferring a different family.
6. **Dogfood:** (lane `01M55PDR9ZPQH55GF0S38K9B69`) the two dated reads on the board at the time are opened as pre-registered lanes and
   taken by the Air without nick starting them. The readout is the share of band-2 lanes taken
   unprompted, their acceptance rate, and how many were stopped inside the window.

## 7. Open questions settled here, by stanley

- Seats float; no scheduler. Chosen over a placement service because the pull model needs no
  component that can be wrong about where a seat should be, and the paper's experience is that
  informal capacity is enough inside one organisation.
- No auto-scaling, because seats are the unit of attribution.
- Band 2 is a declared lane class rather than a per-seat "may take anything" switch, because the
  anti-goal is a seat taking judgement work, and a per-seat switch cannot see the lane.
- The announcement is an advisory ask (3 min) rather than standard (5 min), because the work is
  redo-able by definition; nick asked for a light moment.
