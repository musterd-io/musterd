# 494 — When a seat dreams

- Status: accepted
- Date: 2026-10-01
- Deciders: nick (the Multiplayer AI room voted for Dreaming, goal `dreaming`, 2026-10-01), izzo
- Lanes: `01M3X2EJHE` (this ADR, izzo); built on by `01M3X2FTNC` (what a dream sees, ryder) and
  `01M3X2F2ZR` (sleep on `/live`, miley), plus the consolidation and morning-digest lanes
- Builds on: ADR 131 (residency: the wake ledger and the host), ADR 206 (working hours),
  ADR 443 (the doorbell)
- Spec: `docs/demo/multiplayer-ai-2026-10-01/options.md`, Dreaming lane 1

## Context

The room voted for Dreaming: a seat that is idle overnight re-reads the day's record, turns it into
insights and wiki pages, and leaves a digest for the morning. Idle compute becomes memory.

Every wake today has a reason someone else gave it. An `immediate` or `batched` wake answers an act
directed at the seat. A `work_order` wake answers the board (ADR 179). A dream has no sender: it
is a wake the seat takes because it is idle and it is night. That is new, and it must not become a
way for an unattended machine to spend money all night or to wake a human at 3 a.m.

The pieces already exist. Residency (ADR 131) leases wakes under a per-seat policy, prices each
one (`residency.wake_cost`), and reports them (`Report.wake`). Working hours (ADR 206) give each
Member an effective schedule, the Member's own or the Team's. The doorbell (ADR 443) is the one
path by which an act reaches a human's desk, and `ringTargets` is the one function that decides it.

## Problem

Say when a seat may dream, what a night of dreaming may cost, and how it is kept off the doorbell,
in terms the daemon can derive from records it already holds.

## Decision

### 1. A dream is a residency wake with its own derivation

Add `dream` to `WAKE_DERIVATIONS`. The daemon leases a dream exactly like any other wake: one
`wake_leases` row, one `residency.wake_leased`, `residency.woke` or `residency.wake_failed`, and a
`residency.wake_cost` when the host reports one, each with `derivation: 'dream'`. Nothing about a
dream bypasses the ledger, so the host, the deferral guard and the report treat it as a wake.

A dream wake carries a `lane_id` of null and an `act_id` of null. Its wake line says "dream" and
points the seat at its wake context (`team_wake_context`, `wake.kind: "dream"`). What that context
holds, and what a dreaming seat may write, belongs to the dream-packet lane, not to this ADR.

### 2. The gate: idle, and outside working hours

A seat is due a dream only when all of these hold. The predicate is one pure function,
`isDreamDue`, in `@musterd/protocol`; the server passes it the facts.

1. **Enrolled and switched on.** The seat is enrolled for residency, and its effective
   `residency.dream.enabled` is true. The default is false, for every team and seat.
2. **Idle.** The seat has no live presence and the host has not reported a live local session for
   it (the ADR 131 §5 guard still applies at actuation, and a deferral still burns no budget).
3. **Nothing else is due.** No `immediate`, `batched` or `work_order` wake is due for the seat. A
   dream always yields to work someone asked for; it never pre-empts it, and a dream lease is
   never derived in the same pass as another wake for the same seat.
4. **Outside working hours.** `now` is outside the seat's effective `working_hours` (ADR 206: the
   Member's schedule, else the Team's), evaluated in that schedule's timezone. A seat with **no
   effective schedule never dreams**: without one the daemon cannot tell night from a quiet
   afternoon, and guessing would put the seat's spend on the human's working day.
5. **Inside tonight's budget.** See §3.

A **night** is the stretch from the end of one working day to the start of the next working day
in the effective schedule, so a weekend is one long night. Each night is keyed by the date its
working day ended, so the per-night counts in §3 reset when the next working day starts.

ADR 206 said the schedule is informational in v1. This ADR is the first reader that acts on it,
and only to *withhold* a wake: the schedule never makes a seat do anything during the day.

### 3. The per-night budget, priced like any wake

Add one block to `ResidencyPolicySchema`, set as a team default with a sparse per-seat override,
like every other residency knob (ADR 131 §3 amendment):

```ts
dream: {
  enabled: false,      // the switch; nothing dreams until an admin turns it on
  nightly_wakes: 1,    // dream leases per seat per night, 1..3
  budget_usd?: number, // optional ceiling on reported dream cost per seat per night
}
```

- **Count.** A seat gets at most `nightly_wakes` dream leases a night, counted from
  `residency.wake_leased {derivation: 'dream'}` rows inside the night. A failed or exhausted
  dream counts; a **deferred** one does not (ADR 131 §5: a working human never spends a budget).
- **Shared rails.** A dream is a wake, so it also counts against the seat's existing `cooldown_ms`
  and `hourly_cap`, and against the same watchdog `timeout` and transcript bounds. A dream gets no
  rail of its own and no exemption from any rail.
- **Money.** When `budget_usd` is set, a seat whose reported dream cost for the night
  (`residency.wake_cost` rows joined to tonight's dream leases) has reached it is not due another
  dream that night. This stops the *next* lease; it never kills a running one, which keeps ADR 131's
  honesty clause that `budget_usd` flags and never kills. An unreported cost reads as zero, so the
  count is the bound that always holds and the money is the one that holds when the host reports.
- **Fresh, never resumed.** A dream always starts a fresh session. Its job is to re-read the record,
  not to continue a conversation, and ADR 131's measurements make a resumed life the expensive
  case. The host's resume ladder is skipped for `derivation: 'dream'`.

The wake block of the report (`Report.wake`) already prices every lease, so dream cost needs no new
reader: it is the `dream` slice of the existing wake economics.

### 4. A dream never rings the doorbell

A dream-born session is stamped with provenance **`dream`**, an additive entry in `PROVENANCES`,
server-derived from the lease the way `wake` is (ADR 131 §6): no wire field lets a client claim it,
and no client can shed it. The seat's presence carries it while the dream runs, and every act it
sends carries `from_provenance: 'dream'`.

- **No ring.** `ringTargets` takes the act's `from_provenance` and returns no one for `dream`. No
  doorbell record is written, so no sink fires: not `os`, not `slack`, not `webhook`. This is the
  rule even for an `ask`, the act that otherwise always rings.
- **No chain.** A `dream`-provenance act is never a wake reason for another seat, on any lane,
  immediate or batched. One seat's dream cannot wake a second seat, so a night has no chains to
  bound.
- **Nothing is lost.** The act is still stored and still sits in its recipients' inboxes and on
  `/live`. In the morning a human finds it there, and the morning digest names what is waiting.

What a dream may write at all (insights, wiki pages, its own note; never code, never a lane) is the
dream-packet lane's write fence. This section is the backstop that holds even if the fence has a
gap: whatever a dream sends, nothing rings.

### 5. What a dream is not

- **Not the morning digest.** The digest is posted at the start of working hours by a scheduled
  seat on its own schedule, not by a dream wake: the dream gate (§2) holds only outside working
  hours, so no dream can post it. It is not a dream, so it falls under the ordinary ring rule (ADR
  443 §2), and that rule rings no one for a team-addressed `message`. Getting the digest to Slack is
  therefore the digest lane's own delivery path, not the doorbell's.
- **Not an orchestrator.** A dream decides nothing about anyone's work. It reads the record and
  writes memory. ADR 131 §7's no-orchestrator line holds.
- **Not on by default.** `dream.enabled` defaults to false everywhere. Turning it on is an admin
  `residency policy` write, audited like every other policy write.

## Consequences

- Protocol, all additive and needing no wire bump: `WAKE_DERIVATIONS += 'dream'`,
  `PROVENANCES += 'dream'`, `ResidencyPolicySchema.dream`, `isDreamDue`, and a `from_provenance`
  input to `ringTargets`.
- The lease derivation gains one pass, run only for enrolled seats whose effective policy has
  `dream.enabled`. It reads working hours, which the store already holds, and the night's dream
  leases and costs, which the audit already holds. No new table.
- ADR 206's schedule stops being purely informational. It now withholds a wake; it still never
  causes work in the day.
- A team that sets no working hours never dreams. That is deliberate. The fix is to set a schedule,
  not to guess one.
- The ADR 131 §5 deferral guard and the ADR 088 composed-line bar apply unchanged: a dream's wake
  line carries no body and names no sender, because there is none.
- Cost is bounded per seat per night by `nightly_wakes` runs, each under the watchdog timeout, and
  by `budget_usd` where the host reports cost. Across a team it is that times the number of seats
  with `dream.enabled`.
- **2026-10-02 — landed in #1958 (lane 01M3X2FTNC).** `PROVENANCES += 'dream'` and the dream wake
  packet and write fence are on `main`; a dreaming seat reads its packet with `musterd dream`.
  `ResidencyPolicySchema.dream`, `isDreamDue` and the lease-derivation pass are not in that PR —
  they remain to be built.

- **2026-10-02 — the trigger is built (lane 01M3Z4ZRMM).** What shipped, and three places it reads
  the Decision more narrowly or differently:
  - **Flat policy keys.** `dream_enabled`, `dream_nightly_wakes` (1–3, default 1) and
    `dream_budget_usd?` sit directly on `ResidencyPolicySchema` instead of the sketched `dream: {…}`
    block. The ADR 185 sparse merge handles two levels (policy → residency); a third nested level
    would replace a whole `dream` block on any partial write. Same semantics, same defaults.
  - **`dream` is lease-derived; `wake` is still attested.** `settleProvenance` (store/dream.ts)
    settles every claim path (ambient touch, HTTP claim, WS claim): a session presenting this
    seat's own dream lease is `dream` whatever it attests, and `dream` without one is not believed.
    §4's "no client can claim it or shed it" now holds for `dream`. It does not yet hold for `wake`,
    which the host still declares (ADR 131 §6 as built) — a separate change.
  - **The packet is `GET /teams/:slug/dream`** (`musterd dream`), not a `team_wake_context` kind.
    The dream's composed line names that command and the dreaming skill.
  - The lease pass runs in `claimWakeLeases` only when no asked-for wake was leased this poll and the
    seat is cooled; tonight's count excludes leases the host reported `residency.wake_deferred`.
    Acts sent from a dream are dropped from both wake lanes, and a `dream` presence is not an
    attended session (ADR 444).
- **2026-10-03 — the digest is the hub's to post (lane 01M41G32BM).** The first live morning
  produced two digests for one team. A joiner enrolled the night before posted its own beside the
  hub's, with every ask aged from its re-sync ("16h4m") and nothing learned. Each daemon's
  once-per-day guard saw only its own rows. `digestTick` now skips any team this daemon is an
  enrolled joiner of, as the reaper's team-wide sweeps do (ADR 361 §1, ADR 371 §2). The joiner
  gets the hub's digest by the pull. §5 is unchanged; this records where it runs.
- **2026-10-03 — a dream wakes on a current checkout (lane 01M41G80VN).** ghost, grokbot and wanderer
  dreamed on detached checkouts behind #1956, so the skill the wake names was not on disk. Before a
  dream wake the host now fast-forwards the seat's workspace to `origin/main`. It does this only for a
  detached HEAD with a clean tree, and only when the move is a fast-forward. A reply or work-order wake
  is never moved.
- **2026-10-04 — the packet carries the skill (lane 01M44B3C5Q).** The fast-forward above never
  moves a branch, and ghost rests on its handed-off `ghost/dreaming-digest`, so it dreamed without the
  skill a second night. `musterd dream` now adds `skill: {path, text}`, read from the running build's
  own checkout, which autorefresh keeps on main. The wake line points there and keeps the
  workspace path only as a fallback.
- **2026-10-04 — a dream reads insights whole (lane 01M44Z7WYM).** The packet clipped insight bodies at
  600 chars, the same as act bodies. That cut 16 of the 29 insights from the prior 14 days, and the dreams
  argued over what the clipped conditions promoted (ghost's wiki page, #2048). Insight bodies now
  arrive whole, up to the server's own 2,048-byte cap, each with its own `truncated`. The packet
  budget rises from 24 KB to 48 KB to hold a full night of them.
- **2026-10-04 — promotion counts nights by key (lane 01M454DC0H).** miley and ghost dreamed two
  minutes apart across UTC midnight (22:3x PDT on 10-03) and dated the night a day apart in prose. One
  said a sighting counted for promotion and the other said it did not. The packet and each learned
  insight now carry `night`, which is §2's key under the seat's effective working hours, and the
  dreaming skill's promotion rule counts two different `night` values.
- **2026-10-03 — §5's "unanswered" is bounded by ADR 502.** The digest lists the last seven days,
  counts older open asks in one line, and treats an ask whose named lane is `done` or `abandoned` as
  settled.

## Observability & Evaluation

**Traces.** No new span. A dream is a `musterd.residency.wake` span with `derivation: 'dream'`,
and every decision is an existing `residency.*` audit row with that derivation.

**Eval.** Dataset: one week of `revive` nights with `dream.enabled` on two seats. Baseline: the
same seats' audit before the switch, where no wake has `derivation: 'dream'`. Targets, each read
from the audit and the doorbell rows alone:

1. Every `residency.wake_leased {derivation: 'dream'}` falls outside the seat's effective working
   hours, at a moment when the seat had no live presence and no other wake due.
2. No seat has more than `nightly_wakes` dream leases in one night.
3. No `doorbell.surfaced` row traces to an act with `from_provenance: 'dream'`.
4. No `residency.woke` for any seat has a trigger act with `from_provenance: 'dream'`.

**Experiment.** The value claim, that a dream leaves the team wiser, belongs to the consolidation
and digest lanes, which can measure it (insights saved per night, wiki pages promoted, whether the
morning's first session cites them). This ADR measures only that the gate, the budget and the
doorbell rule hold.

Falsifier: any one of the four targets above failing on a real night.
