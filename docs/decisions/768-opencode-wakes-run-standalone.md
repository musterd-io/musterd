# 768 — Every OpenCode wake runs --standalone, so no background serve outlives it

- Status: accepted — 2026-10-29
- Date: 2026-10-29
- Lane: `01M64PZ3WXJSZFJW9WJWXBHG3D`
- Amends: ADR 613's serve-pid scan and the trust widening around it (dated markers added there); ADR 583's note, which made `--standalone` gateway-only

## Context

A musterd OpenCode wake runs `opencode run`. Since OpenCode 2.x that command does little of the
work itself: it hands the prompt to the user's background `opencode serve --service`, a daemon
OpenCode auto-starts, never asks about, and never exits (ADR 583's OpenCode note, 2026-10-19; the
measured process tree is in
[docs/wiki/dream-opencode-session-provenance.md](../wiki/dream-opencode-session-provenance.md)).
Two decisions grew out of that delegation:

- **ADR 583's note, 2026-10-19:** a *metered* wake needs its `OPENCODE_CONFIG_CONTENT` override
  read by the server that makes the provider calls, and a wake cannot reach the shared daemon's
  config — so a gateway wake already runs `opencode run --standalone`, a private server that
  starts with the run, reads the wake's own environment, and exits with the run. Every other wake
  (local model, or no gateway) still ran plain `opencode run`.
- **[ADR 613](613-opencode-lease-names-serve-pid.md), 2026-10-15:** the MCP adapter belongs to
  the *serve* daemon, not the run, so the ADR 354 lease file — which names a pid the adapter's
  ancestry must include — was written with the serve daemon's pid, found by scanning the process
  table for exactly one `opencode serve` owned by the current user. That widened the check's
  trust: any adapter on that serve daemon **in this workspace** honored the lease during its
  window.

The shared daemon is exactly the kind of process a wake must not leave behind. On 2026-10-29 the
one on this laptop was still holding a deleted 4.9 GB `opencode.db` open long after the sessions
that started it were gone, until it was killed by hand — no musterd command could end it, because
it is nobody's child.

## Problem

One cause, two costs: the wake delegates to a process it does not spawn.

1. **Lifetime.** The background serve outlives every session and every wake. It accumulates open
   files (a deleted 4.9 GB database, held live until killed by hand), it is never restarted when
   OpenCode is upgraded, and the host's only lever is `kill` on a pid it did not create.
2. **Provenance.** To reach the adapter anyway, ADR 613 had to write a pid the actuator never
   spawned and widen ADR 354's ancestry check into a workspace-and-window trust. That widening
   buys a dream fence it should never have needed to buy.

## Decision

**Every musterd OpenCode wake runs `opencode run --standalone`** — a metered wake, a local-model
wake, and a wake with no gateway alike. `opencodeStandaloneArgs` is applied unconditionally in the
backend's `attempt`, not only when a gateway origin is set.

Everything else follows from that one rule:

- **The lease file names the run child's pid, always.** `opencodeServePid` and its `ps` seam are
  deleted; no process-table scan exists in the backend.
- **ADR 613's trust widening goes with it.** The ADR 354 invariant — *the pid the adapter's
  ancestry must include* — is what the file carries again, and a standalone adapter satisfies it
  by descent: adapter ← private server ← run child. The window in which an unrelated adapter in
  this workspace could honor a wake's lease is closed.
- **Cost:** one private server cold start per wake. `--session` resume is unchanged — sessions
  live in OpenCode's shared store, so a private server resumes the same conversation (ADR 583's
  OpenCode note, 2026-10-19).
- **Config posture is unchanged:** the ADR 583 override is still set only on a metered wake, and
  a local model is still not re-pointed (ADR 663). Only *which server reads* it changes.

## Consequences

- After a wake ends, no `opencode serve` process that wake started remains — the private server's
  lifetime is the run's. That is the acceptance bar for the lane that produced this ADR.
- A person's own interactive OpenCode is untouched: the transform applies to `run` argv only, and
  the launcher's interactive entry (`musterd <seat> opencode`) passes no `run`.
- An OpenCode dream wake's adapter honors the lease by descent rather than by a workspace-wide
  window, so the wiki page's falsifiers keep holding on the new mechanism — a dated note was
  added there, and ADR 613's Decision carries the amendment markers pointing at it.
- This change neither starts nor clears a serve daemon a *person's* own session left running: a
  daemon minted before this change keeps holding its files until it is killed once. It is a
  one-time residue, not a shape musterd produces any more.
- No protocol schema changes: `spawner_pid` keeps its type and its reader
  (`packages/mcp/src/wakeLeaseFile.ts`) needs no change — the invariant the reader always
  required is now the invariant every writer satisfies.

## Observability & Evaluation

- **Eval:** the lane's acceptance check, taken on this machine — after a wake settles,
  `pgrep -f 'opencode serve'` shows no process the wake started (baseline: before this change a
  plain wake's serve stayed up until killed), and a `--session` resume from the private server
  restores the captured conversation. Interactive `musterd <seat> opencode` must still open.
- **Traces:** none — argv and a local file write; the lease write and `settleProvenance` (ADR 494
  §4) remain the observable trail, and `spawner_pid` on the lease is the per-wake evidence.
- **Experiment:** n/a — one wake on one machine decides it. The unit suite pins the argv
  (`['run', '--standalone', …]`) and the lease pid for all three wake shapes.
