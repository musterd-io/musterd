# 700 — Sponsored agents on a seat-file team: the file declares the sponsor, the hub's mint vouches for it

- Status: proposed
- Date: 2026-10-21
- Lane: `01M5G6A1VT4WJZTQ8K6R9CYPA8` (goal `cloud-agents`)
- Builds on: [ADR 058](058-durable-on-git-live-on-daemon.md) (seat files are the roster's single writer), [ADR 449](449-member-expiry-sponsored-agents.md) (`sponsored_by`, expiry capped at the sponsor's), [ADR 463](463-sponsor-hosted-agents.md) (sponsor-hosted agents, the cascade), [ADR 592](592-unknown-seat-parks-not-stalls.md) (publishing a seat file), [ADR 689](689-sponsor-scoped-credentials-replicate-to-joiners.md) (sponsor-scoped credentials reach joiners)
- Amends: ADR 463 §4.2 and its 2026-09-28 note ("seat-file teams cannot hold sponsored agents")
- Review gate: the security role (big-body). Decision 2 is an authority claim read from a file anyone with push access can write.

## Context

musterd holds a team's roster one of two ways. A **seat-file team** keeps it in its team home
repo (`.musterd/team.toml` and `seats/<name>.toml`), and the daemon projects those files
(ADR 058). Every laptop team works this way, revive included. A **daemon-roster team** keeps it
in the daemon's database, and a hosted (Cloud) team has no git home, so it can work no other way.

Sponsored agents exist only on the daemon roster. An agent minted by a member (ADR 449
`sponsored_by`, ADR 463) carries a sponsorship the seat-file schema has no field for. So
`mintSponsoredAgent` refuses a file-backed team, and since the 2026-09-28 note to ADR 463
`reconcileTeam` refuses to project a team that holds any sponsored member and `team export`
refuses to write one out. Every hosted cloud seat is a sponsored agent (ADR 463 §2, ADR 647,
ADR 648, ADR 689).

## Problem

The team that builds musterd cannot hold the feature it is building. Cloud-agents phase 2b was
designed for a laptop hub whose roster "arrives by git" (ADR 689, fourth landing), and its tests
pass on daemon-roster fixtures. On revive, `create.sh --hub` would create and deploy the Fly
machine, then fail at its last step, `musterd agent <seat> --hosted`, with "keeps its roster in
seat files". This surfaced on 2026-10-21 while preparing lane 2b-5. Nothing had run the arc on a
seat-file team.

The asymmetry also strands every laptop team. Adding a hosted agent means switching roster
modes, and once one exists the switch back is refused. Each feature built on one mode quietly
assumes it.

Two things make the seat file hard to extend, and they are why ADR 463 stopped short:

1. **Authority.** A sponsorship is an authority claim. A sponsor's host key serves the seat
   (ADR 463 §1) on the sponsor's machine and model key. If the file alone said who sponsors an
   agent, anyone who can push to the team home could make another member's host run, and pay
   for, a seat they never minted.
2. **The cascade.** When a sponsor loses standing, every descendant is disabled and loses its
   residency, grant, OAuth chains and presence (`revokeSponsoredDescendants`). On a file-backed
   team, reconcile writes account status, so the descendant's own file would re-enable it on the
   same pass.

## Decision

Close the asymmetry on the seat-file side. A seat-file team can hold sponsored agents, with the
same guarantees a daemon-roster team gives.

1. **The seat file carries `sponsored_by`.** `SeatFileSchema` gains an optional
   `sponsored_by = "<member name>"`, valid only on an agent seat. This is a protocol schema
   addition, and this ADR is its gate (hard rule 1). `team export` writes it, and its refusal
   while sponsored members exist is removed.

2. **The file declares and the hub's mint vouches.** A file's `sponsored_by` takes effect only
   when the hub holds its own record of that mint: a hub-origin `member.sponsored_agent_created`
   fact with that sponsor as actor and that agent as target. The fact now replicates to joiners
   as a hub fact, as `credential.accepted` does (ADR 689 d2), and the hub's ingest refuses a
   pushed copy. Reconcile projects `sponsored_by` only where file and fact agree. A file naming
   a sponsor with no matching fact projects the agent **unsponsored** and warns. That agent can
   do nothing a sponsor's host key would grant, so a forged line costs nobody anything. **A file
   that drops the line changes nothing.** Un-sponsoring is not a narrowing: `hostMayServe` serves
   a sponsored seat only from its sponsor's own key, and an unsponsored seat from any team-wide
   key (an admin's or the legacy one), so clearing the sponsor would widen which machines may run
   the agent. Once vouched, the sponsorship stands until a hub-authorized act ends it: removing
   the agent, or the sponsor losing standing (decision 4). Reconcile keeps it and warns that the
   file omits it. A file can add no authority the hub did not record, and a file edit alone can
   remove none the hub did.

3. **A descendant's standing is derived, never written over.** Reconcile first resolves every
   sponsor's standing: present, not disabled or banned, not expired. It then projects any agent
   whose corroborated sponsor lacks standing as disabled, whatever its own file says. A file can
   no longer re-enable what the cascade took on the same pass. The ADR 449 expiry rule holds on
   the way in: an agent's `until` is clamped to its sponsor's.

4. **The cascade runs from reconcile.** A pass in which a sponsor loses standing, by a removed
   seat file, an admin `account_status`, or a lapsed `until`, calls `revokeSponsoredDescendants`
   for that sponsor. That is the same implementation the remove route and the expiry sweep call
   (ADR 463 §4.2), with the same `member.revoked_cascade` row naming the trigger `reconcile`.
   The fail-closed refusal in `reconcileTeam` is removed; these rules replace it.

5. **The hosted mint on a seat-file team writes the file first.** `musterd agent <name>
   --hosted` against a file-backed team writes `seats/<name>.toml` (`kind = "agent"`,
   `sponsored_by` the caller, `until` clamped) into the caller's team home. It then calls the
   mint, and publishes the file (ADR 592) only after the mint succeeds. The hub's mint route,
   for a file-backed team, requires that file in its own roster root with `kind = "agent"` and
   `sponsored_by` equal to the authenticated caller. It runs every check it runs today (host
   seen, cap, name, standing) before creating anything, then records the fact (decision 2) and
   queues the provision. A refused mint deletes the unpublished file. `create.sh` needs no
   change.

## Consequences

- revive, and any laptop team, can hold hosted cloud seats. Lane 2b-5
  (`01M5DTSQ7BKX54NG9V3PHVK4A5`) runs on the team it was written for.
- The roster mode stops gating this feature. A team can move between modes with its sponsored
  agents intact, because export writes `sponsored_by` and reconcile reads it back.
- One more ledger tag crosses nodes (`member.sponsored_agent_created`, hub-origin only), with the
  forged-origin refusal ADR 689 d6 already applies to credential facts.
- A seat file is a git-visible record of who sponsors whom, which a daemon-roster team does not
  have.
- The mint's off-hub case stays out. A sponsor whose CLI runs on a joiner writes the file into
  that joiner's checkout, and the hub refuses the mint until its roster root has the file after
  its next git refresh. The refusal names that wait, and the sponsor retries. Minting at a
  joiner is not added here.
- Follows-up: lane `01M5G6ERTFSRACVP1Z5C9CZBKX` (decisions 1–4: protocol field, replicated
  fact, reconcile and export) and lane `01M5G6F7ZZ2XARR38YZPED8PX8` (decision 5: the hosted
  mint on a seat-file team), then lane `01M5DTSQ7BKX54NG9V3PHVK4A5` (2b-5) on revive.

## Observability & Evaluation

- **Traces:** reconcile's warning for an uncorroborated `sponsored_by`, naming the file and the
  sponsor it claims, and for a vouched sponsorship the file omits. `member.revoked_cascade` rows with trigger `reconcile`. The replicated
  `member.sponsored_agent_created` fact in `sync_log` with its `origin_node`.
- **Eval:** reconcile tests on both drivers. (a) A forged `sponsored_by` with no fact projects
  the agent unsponsored and a sponsor's host key cannot serve it. (b) A sponsor disabled in its
  file disables its descendant on the same pass even though the descendant's file says active.
  (c) A removed sponsor file cascades with one row per descendant. (d) An agent's `until` later
  than its sponsor's is clamped. (e) Export then reconcile is a fixed point for a team holding
  a sponsored agent. (f) A joiner-pushed `member.sponsored_agent_created` is refused at ingest.
  (i) A vouched agent whose file drops `sponsored_by` keeps its sponsor, and a team-wide host key
  still cannot lease its wakes or claim its provision (big-body's review, 2026-10-21).
  Mint tests: (g) a file-backed mint without the file, or with another sponsor named, is refused
  and leaves no member; (h) a refused mint leaves no seat file behind.
- **Experiment:** lane 2b-5's week on revive is the reading. Falsifier: any step of `create.sh`
  on revive refused for the roster mode, or a sponsored agent on revive that a file edit alone
  re-enables after its sponsor lost standing.
