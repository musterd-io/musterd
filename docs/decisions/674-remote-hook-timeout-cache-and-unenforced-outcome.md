# 674 — Remote hook timeout, 60-second enforcement cache, and the `unenforced` hook outcome

- Status: accepted
- Date: 2026-10-19

## Context

`musterd gate check --stdin` (ADR 150) and the other harness hooks (`inbox --interrupt-check`, `session orient-nudge`, `trace`) run inside a seat's tool-call loop. On a local daemon (`127.0.0.1`), `GET /teams/:slug/enforcement` is a sub-millisecond loopback read and `fetchWithRetry` (`packages/cli/src/client.ts`) needs no request timeout because a stopped daemon fails immediately with `ECONNREFUSED`.

Against a remote team server (`musterd` Cloud, ADR 475; `docs/superpowers/specs/2026-09-29-musterd-cloud-design.md` §4.7), three assumptions of the local hook path break:

1. **No request timeout.** `fetchWithRetry` calls `fetch()` with no `AbortSignal`, so a blackholed route or hung proxy stalls every tool boundary for the OS TCP timeout (~30–75 s).
2. **Uncached enforcement reads.** `gate check` calls `GET /teams/:slug/enforcement` on every tool invocation, paying a network round-trip even on undeclared calls that match no class.
3. **Undifferentiated fail-open on outage.** When the server cannot be reached, `gate check` catches the error and exits 0 silently. For a `warn` class or an undeclared call that is acceptable only if the gap is visible; for a `block` class or a `costly-action` class (Gate B), silent fail-open turns off the human-approval / contended-surface block at the exact moment the server cannot adjudicate or record it.

## Problem

How should harness hooks bound network latency, cache enforcement rules, and adjudicate tool calls when the team server is unreachable, without stalling the harness or silently dropping `block` and `costly-action` gates?

## Decision

Implement the Cloud spec §4.7 contract across `@musterd/protocol`, `@musterd/cli`, and `@musterd/server`:

1. **1.5 s hard timeout on hook HTTP calls.** `HttpClientOpts` accepts an optional `timeoutMs` (`HOOK_HTTP_TIMEOUT_MS = 1_500` on hook-facing clients). `fetchWithRetry` bounds each `fetch` with `AbortSignal.timeout(timeoutMs)` (or an equivalent abort timer) and treats a timeout or HTTP 5xx on the gate path as server-unreachable, never retrying when `timeoutMs` is set.
2. **60 s local enforcement cache.** `gate check` caches the team's `EnforcementPolicy` at `.musterd/enforcement-cache.json` (`{ team, server, fetched_at, enforcement }`) with TTL `ENFORCEMENT_CACHE_TTL_MS = 60_000`.
   - When the cached table for `(team, server)` is younger than 60 s, `gate check` matches against it locally with zero network round-trips for undeclared calls.
   - When the cache is older than 60 s (or absent), `gate check` fetches `GET /teams/:slug/enforcement`; if that fetch fails or times out, it keeps serving the stale cached table (if one exists for `(team, server)`) while treating the server as unreachable for adjudication.
3. **Per-class outage posture (`block` / `costly-action` fail closed; `warn` / unclassified fail open and visibly):**
   - When the server is unreachable and the call matches a class with `posture: 'block'` or `kind: 'costly-action'`, `gate check` **denies** the call (`emitDeny`) with `"gate unreachable — '<class>' requires server adjudication; wait for the team server or ask a human out of band"`.
   - When the server is unreachable and the call matches a `warn` class (not `costly-action`) or matches no class while the server could not be reached to refresh/adjudicate, `gate check` **allows** the call, emits a `PreToolUse` advisory (`emitWarn`) containing `unenforced` so the acting seat sees the `unenforced` notice in its own tool result on that call, and records `outcome: 'unenforced'` on the `HookOutcome` trace event.
4. **Protocol additions (`@musterd/protocol`):**
   - Add `'unenforced'` to `TRACE_OUTCOMES` (`packages/protocol/src/trace.ts`) so `HookOutcome` events carry `outcome: 'unenforced'` on the wire.
   - Add `'unenforced'` to `ACTOR_ATTESTATION_KINDS` (`packages/protocol/src/enforcement.ts`) with `{ count, since_ts, until_ts }` on `ActorAttestationSchema` so the local counter kept in `.musterd/gate-unenforced.json` while the server is down flushes as one `gate.unenforced` audit row on recovery.

## Consequences

- Undeclared tool calls (the common case) make zero network requests while `.musterd/enforcement-cache.json` is fresh (<60 s), eliminating per-call remote latency.
- A policy edit to `enforcement.classes` can take up to 60 s to reach a seat's local cache (the documented stale-enforcement window in spec §4.7).
- During a server outage, `block` classes and `costly-action` classes fail closed (`"gate unreachable"`), while `warn` and unclassified calls proceed with an explicit per-call `unenforced` advisory and a local counter that flushes to the audit log (`gate.unenforced`) on the next reachable call.

## Observability & Evaluation

- **Traces:**
  - `HookOutcome` trace events (`kind: 'HookOutcome'`, `detail.hook: 'gate'`) carry `outcome: 'unenforced'` whenever a call proceeds unenforced during a server outage.
  - On the next reachable gate invocation, the local counter in `.musterd/gate-unenforced.json` flushes via `POST /teams/:slug/actor` (`kind: 'unenforced'`), writing one `gate.unenforced` audit row with `{ count, since_ts, until_ts }`.
- **Eval:**
  - Unit and integration tests in `packages/cli/src/commands/gate.test.ts` and `packages/server/src/transport/gate-http.test.ts` verify the 1.5 s timeout, the 60 s cache hit/refresh/stale-fallback behavior, the §8 seat-bar outage matrix (`block` and `costly-action` denied with `"gate unreachable"`, `warn` and unclassified allowed + `unenforced` emitted per call in the tool result), and the recovery flush to `gate.unenforced`.
- **Experiment:**
  - Falsifier: against an unreachable or blackholed server, `gate check` must complete within 2 s, deny a matched `block` or `costly-action` class with `"gate unreachable"`, allow a `warn` class with `unenforced` in stdout `additionalContext`, and flush the accumulated count as a single `gate.unenforced` audit row when the server returns.
