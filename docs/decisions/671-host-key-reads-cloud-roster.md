# 671 — A host credential reads the roster on a cloud team

- Status: accepted
- Date: 2026-10-19
- Lane: `01M55Y58R3D1CCBERNJCXBJZQ9` (goal `cloud-agents`)
- Builds on: ADR 395 (the actuator's host credential), ADR 241 (occupancy verified by lease on
  the roster), ADR 636 (spend approval reads the seat's kind from the roster), ADR 648 (a host
  key provisions its sponsor's seats), the cloud design spec §4.3 (no team rows without a
  credential for that team)
- Amends: ADR 648 Decision 5 (one more thing the key may do: a public-grade roster read)

## Context

The wake actuator (`musterd host`) authenticates with the host credential ADR 395 put in the
seat's binding. Two of its reads go to the roster: the ADR 241 occupancy check polls `GET
/teams/:slug/members` for a Presence attesting this wake's lease, and the ADR 636 spend-approval
arming reads the woken seat's kind from the same projection. On a self-hosted daemon both work
by accident of ADR 071: the roster read is best-effort authenticated, a host key names no
member, so the read falls through to the public projection — which carries presences and kinds.

A cloud team serves no team rows to a caller without a credential for that team (spec §4.3), and
its roster read authenticates the bearer as a member. A host key is not a member, so the server
answers with the bootstrap-only refusal. The actuator's verifier swallows the error (a roster
that cannot be read is "no occupancy") and the kind read logs and moves on.

Measured on the first cloud pilot (seat `pilot-2`, Fly app `musterd-agent-pilot`, team
`revive-staging`, 2026-10-19 `host.log`): every wake ran its turns, metered its calls, and was
then reported `wake FAILED … native loop ended (completed) without occupying the seat`, and every
wake logged `spend approval kind unread … a bootstrap key only claims a seat`. The seat was
occupied; the host could not see it.

## Problem

The cloud host cannot read the one projection its wake loop verifies against, and the credential
it holds is the only one it is allowed to hold. Reading as the seat instead is not an option: a
seat credential on the roster route needs a session lease (ADR 337), and minting one would occupy
the seat — manufacturing the evidence the verifier is looking for. Carrying occupancy on the wake
routes the key already has would change the protocol's response shapes for a fact the roster
already states.

## Decision

1. **On a cloud team, a valid host credential reads the roster at the public grade.** `GET
   /teams/:slug` and `GET /teams/:slug/members` accept a bearer that is an active, unexpired
   bootstrap credential of `use_kind: 'host'` for that team, and answer exactly as they answer an
   anonymous loopback read on a self-hosted daemon: viewer `null`, the public projection, the
   ADR 601 public scrub. No member is resolved; no Presence is touched.
2. **Re-checked per request, like the wake routes.** The key's scope is resolved by
   `hostKeyScope` on every read — a creator who left or lost standing fails closed — and the
   credential's use is recorded. A `claim_seat` key, a revoked or expired host key, or a key for
   another team is refused as today.
3. **Self-hosted is unchanged.** The best-effort read (ADR 071) already yields the public
   projection for a host key; this ADR makes Cloud agree with it rather than adding a second
   path.
4. **ADR 648 Decision 5 is amended by this ADR**: the host key's reach gains one read — the
   public roster — and nothing else; the write set (four provisioning steps, wake leases,
   reports, turns) is as ADR 648 and ADR 395 state.

## Consequences

- The cloud actuator's occupancy check and spend-approval arming see the roster; a completed
  wake on a cloud seat reports `occupied`, and spend approval arms where the policy sets a
  threshold (the `/report` read that follows is the seat's own, outside this ADR).
- A stolen cloud host key can now read a team's public roster projection — names, kinds,
  presence, status lines at the public grade — in addition to the wake and provisioning reach
  ADR 648 §5 describes. It still cannot read messages, lanes, credentials, grants, or any
  member-scoped detail.
- A test pins the boundary on the cloud harness: host key reads both roster routes with no
  credential material in the body; a `claim_seat` key and a revoked host key are refused.

## Observability & Evaluation

- **Traces:** the host credential's `last_used_at` advances on each roster read
  (`recordBootstrapCredentialUse`); a refused key writes the ordinary deny path. On the host,
  the ADR 241 verify line `⚡ woke <seat>: invoke→roster …` replaces `wake FAILED … without
  occupying the seat` for a cloud seat.
- **Eval:** `cloudMode.test.ts` "a host key reads the roster at the public grade"; the pilot's
  next wake on `musterd-agent-pilot` should report `occupied: true` in `host.log`.
- **Experiment:** n/a — a fix to an auth boundary, judged by its test and the live pilot's next
  wake.
