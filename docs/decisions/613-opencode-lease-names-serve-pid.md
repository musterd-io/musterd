# 613 — The opencode lease file names the serve daemon's pid

- Status: accepted
- Date: 2026-10-15
- Lane: `01M50C7QGJCCWE8CR2551EX6XR`
- Amends: ADR 354's file-channel invariant (the `spawner_pid` comment), dated amendment there

## Context

The ADR 354 lease-file channel attests a wake through process ancestry: the adapter honors
`.musterd/wake-lease.json` only when `spawner_pid` is one of its own ancestors — the pid of the
harness process the actuator spawned. Recorded in
[docs/wiki/dream-opencode-session-provenance.md](../wiki/dream-opencode-session-provenance.md) with
the full process tree (2026-10-14, dreamy): an OpenCode dream wake spawns `opencode run` (PID
35892, env `MUSTERD_PROVENANCE`/`MUSTERD_WAKE_LEASE` present), but the session is delegated to the
persistent `opencode serve --service` daemon (PID 79436), and the MCP adapter (PID 18783) is a
child of **serve**, booted forty minutes before the dream began. Both delivery paths miss it: the
env is boot-time-only, and the `run` pid is a sibling of the adapter's ancestry, not an ancestor.
So every OpenCode dream wake claims its seat as `provenance: "session"`, `wake_lease: null`: no
fence, `from_provenance` on its insights stamps `session`, and `musterd dream`'s window never
advances past the 24h default (the page's second claim, two dated sightings on dreamy and ghost).

## Problem

The channel's invariant is right — an attestation needs a process relationship — but the backend
writes the wrong pid for this harness. The pid the opencode adapter's ancestry actually includes
is the **serve daemon's**. Writing the `run` child's pid makes the file undeliverable by
construction on OpenCode, so the one provenance the file exists to carry never arrives.

## Decision

When the opencode wake backend writes the lease file, `spawner_pid` names the persistent
`opencode serve` daemon the session is delegated to — discovered by scanning the process table
for exactly one `opencode[.exe] serve` process owned by the current user. When discovery is
ambiguous (zero or several matches, or a platform without the scan), the backend falls back to
the `run` child's pid — exactly today's behavior, never worse.

The schema is unchanged (`spawner_pid` stays a positive int); its meaning narrows to what the
reader always required: *the pid the adapter's ancestry must include*. ADR 354's comment ("the
harness process the actuator spawned") is amended — on OpenCode the harness the adapter belongs
to is the daemon, and the actuator spawns a client of it, not the harness itself.

The trust shape changes in one bounded way: any adapter on the same serve daemon **in this
workspace** honors the lease during its window — the check now attests "this adapter serves this
workspace on the machine where the dream runs" rather than "this adapter descends from the
spawned client." A person opening opencode in that folder mid-dream would inherit the dream's
fence until `expires_at`. We accept that: the window is minutes, the refusal reasons name the
dream, and the standing alternative is that OpenCode seats never dream at all. The workspace
binding and the expiry are the bounds, as they always were for the env channel on harnesses that
forward it.

## Consequences

- An OpenCode dream wake's adapter honors the file, attests the lease, and
  `settleProvenance` (ADR 494 §4) settles the session to `dream`: the fence engages, its insights
  stamp `from_provenance = 'dream'`, and the next night's packet window advances — the wiki
  page's falsifiers invert.
- No protocol schema change; the file's readers (`packages/mcp/src/wakeLeaseFile.ts`) need no
  change — the pid the adapter's ancestry includes was always the invariant.
- The scan is per-wake, per-opencode-backend only; other harnesses' writers are untouched.
  Ambiguity falls back to today's behavior, so a machine running several serve daemons degrades
  to the documented defect rather than risking a wrong attestation.
- The resident-Claude-Code shape (lane `01M50C7QK0`, ADR 609) is the claim-side sibling of this
  same architecture; this ADR does not change it.

## Observability & Evaluation

- **Eval:** the wiki falsifiers — `musterd status --json` during an OpenCode dream wake shows
  `provenance: "dream"` and a non-null `wake_lease`; `musterd dream`'s `until - since` differs
  from 86400000 after a night that saved an insight. Checkable on the next opencode dream night
  (dreamy, ghost).
- **Traces:** none — local file channel by design; the settle and the `from_provenance` stamps
  are the observable trail.
- **Experiment:** n/a — one dream night decides it.
