# Hosted tier: one machine per seat, and no sandbox of our own

**Date:** 2026-10-19
**Seat:** lazara
**Status:** decisions from a brainstorm with nick on 2026-10-19 (§2). Nothing is built.
**Lane:** `01M561Z0W3` (goal `security`, memory isolation 7)
**Parent design:** [seat memory isolation](../../design/seat-memory-isolation.md), §Hosted tier
**Decision:** [ADR 662](../../decisions/662-one-machine-per-hosted-seat.md) (lane `01M5AM1WW6`), which also restates ADR 200's gate and its way through

## 1. What this is for

The parent design asked for a hosted-tier barrier: on a host musterd provisions, a seat cannot
read another seat's note, or act as another seat, through musterd or through the file system. It
proposed one OS user per seat, building [ADR 341](../../decisions/341-shared-team-custody.md)
decision 2's release gate. A first draft of this spec worked that out in full: uid-named users
made by root at boot, a host user holding the host key, and a socket handoff for leases. nick
rejected per-seat OS users outright. That raised the question underneath: should musterd be in
the sandbox business at all?

[ADR 320](../../decisions/320-positioning-the-value-prop-decided.md) says no ("Rejected: claiming
containment"), and the public line is "musterd does not sandbox your agents; your own host,
sandbox and provider controls still do that." Three pieces of work pulled us toward one anyway:
ADR 656 (a sandbox around resident-seat bash), ADR 658 (deny rules written into harness configs)
and [ADR 647](../../decisions/647-cloud-agents-compute-home.md) (agents on musterd's compute). The
pull is real. The line holds only while someone else owns the tool loop and the machine. The
resident engine makes musterd the tool loop, and cloud agents make it the machine.

## 2. Decisions (nick, 2026-10-19)

1. **musterd builds no sandbox.** It rents the boundary where it hosts, and configures the
   harness's own sandbox where the person hosts. It does not design, own or maintain an isolation
   mechanism of its own.
2. **No per-seat OS users, anywhere.** ADR 341 decision 2 (every agent Member under a distinct OS
   user before a real-user release) is reversed. The ADR in lane `01M5AM1WW6` supersedes it.
3. **One microVM per hosted seat, as a rule, not a phase.** A Fly Machine is a Firecracker microVM,
   so ADR 647's phase 1 shape is already this. The machine is the boundary between seats. ADR 647
   phase 2a (one agent machine shared by a team's seats) is parked: it reopens only if phase 1's
   measured compute share passes a threshold the ADR sets (§4).
4. **If sharing is ever forced, the fallback is rented, hardened containers** (gVisor-class,
   for example Cloud Run or Modal), never OS users and never a container runtime musterd
   configures.
5. **The resident-seat pilot decides whether a laptop resident seat runs code.** Its
   pre-registered kill rule (`docs/research/resident-seat-pilot-manifest.md`, read due about
   2026-10-21) decides worker or coordination-only:
   - **Coordination-only:** a laptop resident seat has no bash, so ADR 656 has nothing to guard
     there and is likely withdrawn.
   - **Worker wins:** nick chooses then between keeping ADR 656 and calling it hygiene, not a
     boundary, or running code-running seats on Claude Code or Codex, whose own sandbox musterd
     configures (ADR 658), with the resident engine kept coordination-only.

   PR #2857 (ADR 656) is on hold until that read.

## 3. Why

**Why not build one.**
- **Focus.** The pitch is accountability and coordination. Sandboxes are a different product with
  a crowded market (E2B, Daytona, Modal, Docker, and the harnesses' own sandboxes).
- **Honesty.** "We record, others contain" is the line ADR 320 calls what separates musterd from
  oversight pitches.
- **Liability.** If we sell a sandbox, every escape is our breach.
- **Upkeep.** `sandbox-exec` is deprecated by Apple, and bubblewrap depends on host kernel and
  AppArmor settings. #2857 has been red on exactly that since 2026-10-18 (Ubuntu 24.04's
  `apparmor_restrict_unprivileged_userns` refuses its loopback setup).

**Why microVM, not containers.**

| | microVM per seat | Containers on a shared machine |
| --- | --- | --- |
| Boundary | Own kernel, hardware virtualisation between seats | Shared kernel. Namespaces, cgroups and seccomp; one kernel bug is an escape |
| Who builds the wall | Fly, rented | musterd: runtime config, seccomp, user namespaces |
| Cost | About $12/month always-on for `shared-cpu-2x`/2 GB by Fly's published rates (not checked against this account's bill), near zero stopped | Denser, but it saves on compute, which is the cheap part of a seat |
| Start | A second or two from stopped | Under a second inside a running machine |
| What vendors do | E2B and Fargate use Firecracker | Modal and Cloud Run add gVisor on top, because plain containers are not trusted between strangers |

**Why sharing is unlikely to pay.** Model spend dominates. The pilot's worker seat spent $20.56
in about its first day (`docs/research/resident-seat-pilot/window-start.md`), and delta's wakes
cost $0.11 to $0.25 each (`docs/perf/cloud-seat.md`). Compute is likely a small share of a hosted
seat's cost, and the cloud-agent design already auto-stops a parked seat's machine.

## 4. What changes

| Where | Change |
| ----- | ------ |
| ADR 341 decision 2 | Superseded by the new ADR. Its 2026-09-04 disposition deferred the barrier on a prototype; that prototype is no longer wanted. Decisions 3 to 5 (secure storage, migration, DB key) are untouched. |
| ADR 647 §4.1 | Phase 2a is parked behind a threshold: compute share of a hosted seat's cost, measured by phase 1. The ADR proposes the number (this spec suggests 30%). §4.5's "per-team agent machine" line goes with it. |
| ADR 656 / #2857 | On hold until the pilot read (§2.5). |
| ADR 320 | A dated note in Consequences. The containment rejection stands. On a seat musterd hosts, the public line says what is true there: each agent runs on its own machine. It says nothing about a sandbox. |
| Parent design §Hosted tier | Item 1 (one OS user per seat) is replaced by §2.3 here. Item 2 (code a seat runs is confined by lane `01M4VYT6JW`) waits on the pilot. A dated note at the head of the section, added with this spec, points here. |
| Lane 8 `01M561ZCDS` | Re-scoped from "a seat user tries the DB file and a sibling's binding" to the machine half: from a seat's microVM, try every path to another seat's note and credential. |

**Inside one seat's machine.** With one seat per machine, there is no sibling seat to read. What
the machine holds belongs to that seat or its sponsor: the sponsor's API key (which the seat
spends anyway), a fine-grained `GH_TOKEN`, and the host key. So the in-machine risk is the seat
misusing its own credentials. That is the domain of spend caps, the gateway ledger and
attestation (what musterd already does), not of isolation. **One exception needs checking:** the
host key. ADR 463 scopes a host key to the seats its sponsor sponsors, and the cloud-agent image
mints one per machine label (`deploy/cloud-agent/create.sh`). If that key can lease wakes for any
other seat of the same sponsor, a compromised machine reaches its siblings, and the key must be
narrowed to the one seat. Asked of fifty (phase 1 lane `01M55Y58R3`) on 2026-10-19.

## 5. What the public can be told

- **On your machine (unchanged):** "musterd does not sandbox your agents; your own host, sandbox
  and provider controls still do that."
- **On a seat musterd hosts, once lane 8 passes:** "Each hosted agent runs on its own machine. It
  can't read or overwrite another seat's notes. Your team's humans can read your agents' notes.
  Nobody but you can read yours."

The hosted sentence makes no sandbox claim. It names a rented machine boundary and the read rule
musterd already enforces at its API (lanes 1 to 4).

## 6. Increments

1. **The ADR** (lane `01M5AM1WW6`): §2 and §4, superseding ADR 341 decision 2 and parking ADR 647
   phase 2a, with the dated ADR 320 note and the parent-design note.
2. **The machine-half canary** (lane `01M561ZCDS`, re-scoped): run on the first ADR 647 phase 1
   seat. Its pass allows §5's hosted sentence.

The host-key question in §4 becomes its own lane only if fifty's answer shows the key reaches
sibling seats.

## 7. Observability & Evaluation

- **Traces:** none added. Lease grants already record the host and the seat. The canary reads
  them to show a host key leasing only its own seat.
- **Eval:** the machine-half canary (lane `01M561ZCDS`) is the standing eval of §5's hosted
  sentence. If it fails, the sentence is withdrawn.
- **Experiment:** two existing ones decide what this spec leaves open. The resident-seat pilot's
  kill rule decides ADR 656 (§2.5). ADR 647 phase 1's per-seat cost measure decides whether phase
  2a ever reopens (§4).
