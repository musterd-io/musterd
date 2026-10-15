# 604 — The wake-lease file stamps the wake's derivation

- Status: accepted
- Date: 2026-10-15
- Lane: `01M50C7QP89KF7PRCZTKNNJAET`
- Amends: ADR 354's file channel (the `provenance` field was a constant there)

## Context

The wake-lease file (`.musterd/wake-lease.json`, ADR 354/546) is the second channel for the ADR 241
correlation token, written by the actuator beside `binding.json` at spawn and read by the MCP
adapter when the environment channel does not survive the harness. Its `provenance` field was
schema'd as `z.literal('wake')` — "the file exists to carry the one provenance the env could not" —
and `holdWakeLease` writes that literal for every wake on every harness, including wakes whose
order carries `derivation: 'dream'` (ADR 494). Recorded as a defect in
[docs/wiki/dream-lease-stamped-wake.md](../wiki/dream-lease-stamped-wake.md): wanderer/grok and
lazara/Claude Code dream wakes on 2026-10-08, grokbot again on 2026-10-10.

## Problem

A dream wake's lease file states `provenance: "wake"`, which is false. The lie is overridden where
it matters — the server derives Presence provenance from its own lease record (ADR 494 §4), never
from the file — but the file is also the take-over handle (`musterd <seat>`, ADR 546) and the only
place a host-side reader can see what a wake *is*, and there it cannot tell a dream from an
interrupt. Dreams re-observed the mismatch three times and promoted it; an artifact whose schema
declares a constant that is not one keeps costing that attention.

## Decision

`WakeLeaseFileSchema.provenance` becomes `z.enum(['wake', 'dream'])`. The writers stamp it from the
wake order they already hold: `order.derivation === 'dream'` writes `dream`, everything else keeps
writing `wake`. That is `holdWakeLease` (gaining an optional `provenance`, default `'wake'`, used
by the grok, opencode, native and codex backends) and the Claude Code backend's inline write.

No reader changes: the adapter's half (`packages/mcp/src/wakeLeaseFile.ts`) consumes only
`lease_id` and `harness`, and the schema it parses with is the same package the writer builds from.

The env channel is deliberately unchanged: `MUSTERD_PROVENANCE` still stamps `wake` for a dream
wake, and the server settle overrides it from the lease exactly as before. Stamping `dream` there
too is a coherent follow-up, but no recorded defect asks for it and every current reader either
ignores the value or settles past it — so it is noted here, not done.

## Consequences

- **Version skew fails closed.** A stale adapter (pre-enum protocol, the ADR 135 condition) refuses
  a `dream`-stamped file as malformed and falls back to the environment channel — which is silent
  on exactly the harnesses the file exists for (Codex). On those, a dream wake under a stale
  adapter attests no lease from the file until the adapter is rebuilt; the server-side settle still
  makes the session a dream when the lease arrives by env. The window is bounded by `expires_at`
  and by the file being best-effort by design. We accept this over the additive-alternative (a
  second `derivation` field), which would have left the field the wiki names false in place
  forever — two fields, one truth.
- The file schema is local-only (never sent to the daemon), so no wire version pin moves.
- `docs/wiki/dream-lease-stamped-wake.md` is corrected in the same commit: the defect claim struck
  FIXED, and its porcelain paragraph struck — `**/.musterd/wake-lease.json` is already ignored on
  origin/main (ADR 354), so the file has not dirtied porcelain since.

## Observability & Evaluation

- **Eval:** the wiki claim's falsifier now passes — a dream wake's `.musterd/wake-lease.json`
  carries `provenance: "dream"` (check after any dream night: the file exists from spawn to
  settle). Schema tests pin the enum; `holdWakeLease` tests pin the default and the dream stamp;
  one backend test per writer pins that `derivation: 'dream'` on the order reaches the file.
- **Traces:** none — the file is a local, best-effort channel that is never sent to the daemon.
- **Experiment:** n/a — the change is observable in one dream night on any harness.
