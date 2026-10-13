# 588 — The resident seat: hire a seat on your own key, on pi, behind the rails

- Status: accepted
- Date: 2026-10-13
- Builds on: [ADR 251](251-native-backend-musterd-as-its-own-harness.md) (the native row and the
  `AgentLoopEngine` seam), [ADR 436](436-wake-edge-is-a-contract-not-a-loop.md) (the wake edge is
  a contract; musterd does not take over the loop), [ADR 583](583-metering-gateway-not-a-loop.md)
  (every call priced at the request path), [ADR 585](585-verification-rail-claims-at-submit.md)
  (claims checked at submit and accept), [ADR 443](443-the-doorbell.md) (the doorbell),
  [ADR 101](101-model-as-a-variable.md) (model as a variable),
  [ADR 131](131-harness-residency-wake-ledger-host.md) (residency and the actuator seam)
- Lane: `01M4VT9RZN8F9YJ22FF8HW1WC8` · Goal: `hosted-seat`
- Input: [own model, native harness, or neither — research readout](../design/2026-10-13-own-model-vs-native-harness.md);
  nick, 2026-10-13: "no one is using the musterd native harness because we haven't built it to.
  What if users can bring their own API keys to use the existing models in a musterd native harness?"

## Context

The readout and ADR 583 settled one half of the native-harness question: musterd does not build
a harness for a person's own session. Every loop feature is commodity in six MIT/Apache harnesses,
a harness with its own tool schema pays a model co-training tax that grows per generation, and a
musterd harness is a "third-party harness" under the vendors' terms, so its users pay API rates
where Claude Code users pay a flat plan. That decision stands.

Two things the readout also found point the other way for a different seat.

**Reach is a per-vendor seam, and most vendors give us none.** From the live-doorbell evals:
Claude Code takes an idle inject at about 5 s and nothing mid-turn except at a tool boundary;
Codex has no external push seam (a `queue --thread` path is planned); OpenCode has no inject path
and the roster records it deaf by design; Cursor has no peer-injection API; Grok hears only at
PreToolUse and Stop. A seat that must answer a directed act in seconds, mid-turn, on any act,
cannot be an interactive session on any of those harnesses. It can only be a seat musterd runs.

**Bring-your-own-key is not a differentiator, and "nobody uses it" is not evidence.** Every open
harness takes any provider key. The native backend is a 728-line coordination-only loop that was
never offered to anyone; zero usage says nothing about it. What musterd has that no open harness
has is the four rails that landed around the seat this week: request-path metering (ADR 583),
claim verification at submit and accept (ADR 585), daemon-held per-turn transcripts (ADR 251 §7),
and the attestation chain per act. A seat nobody drives by hand is the first place all four apply
at once with nothing missing.

The field has the shape already, without the record: Paperclip's heartbeat-driven org chart,
Hermes's gateway, Claude Managed Agents, OpenAI's Symphony. None of them can print who asked, who
claimed, which model, what it cost, what it claimed and who confirmed it.

The engine question is settled by the same research that retired the harness: do not write a
loop. pi (`earendil-works/pi`, MIT, 115k stars) ships the loop as libraries: `@earendil-works/pi-durable`
(a harness whose conversations, turns, tool calls and tasks are committed to storage before they
are shown; `resume()` continues a run a dead process left; `steer()` queues input into a running
loop; extensions bring tools, hooks and wrappers; `CodingTools` is `read`/`write`/`edit`/`bash`),
`@earendil-works/pi-agent-core` (the loop, `getApiKey`, a preflight that can block a tool call)
and `@earendil-works/pi-ai` (providers). Its tool shapes are the vendors' own, so the co-training
tax is pi's to track; Databricks measured pi + Opus beating the vendor harnesses on pass rate at
under half the cost.

## Problem

Offer a seat that is always on, on the operator's own key, answers a directed act in seconds from
inside its loop, does real lane work in a jailed workspace, resumes after a crash, and whose every
model call, claim and transcript are on musterd's record — without building or maintaining an
agent loop of musterd's own, and without pretending this is a harness for a person's session.

## Decision

1. **What it is.** A **resident seat**: a Member enrolled with harness `musterd`, run by
   `musterd host` in-process, on an API key the operator names (`--key-env <VAR>`, read at spawn,
   never stored or logged, forwarded by the gateway byte-for-byte). It is opt-in per seat, never a
   default, and the roster shows it as what it is: surface `musterd`, provenance `wake` or
   `resident`.
2. **What it is not.** Not a harness for a person's own session. No TUI, no `musterd chat`, no
   replacement for Claude Code, Codex, Cursor, OpenCode or Grok as the thing a human sits in front
   of. A human who wants a seat of their own keeps their harness and musterd stays the layer.
3. **The engine is pi, embedded behind the seam ADR 251 named.** A second `AgentLoopEngine`
   implementation wraps `@earendil-works/pi-durable` with `@earendil-works/pi-ai` providers. musterd's
   MCP tool surface is injected as a pi extension exactly as the phase-1 bridge does today; pi's
   `CodingTools` are the working tools. No loop code of musterd's own: the native backend keeps
   owning occupancy, verification, bounds and reporting (ADR 251 §5–6), pi owns the turn. This ADR
   is the hard-rule-6 record for the three `@earendil-works/pi-*` packages; the alternative — the
   phase-2 spec's own loop with its own tool schema — is rejected on the co-training tax and the
   maintenance the readout measured.
4. **Jailed at the tool, deterministically.** pi's preflight blocks any tool call whose path does
   not `realpath` inside the seat's workspace and any `bash` whose parsed command head is off the
   allowlist (the repo's declared build/test/lint scripts, `pnpm exec prettier|tsc|vitest`, a git
   subset bounded to the current non-main branch, `gh pr create`). Denials are captured as turns.
   There is no unjailed mode.
5. **Metered, verified, recorded.** The ADR 583 gateway fronts every call (the pi provider's base
   URL is the gateway's), so `budget_usd` is enforced before the next call and cost reconciles to
   the summed `wake_turns` rows. Submits file ADR 585 claims through the same bridge every seat
   uses. Every turn posts a `wake_turns` row; pi-durable's SQLite storage lives in the seat's
   workspace as the resume substrate (`resume()` on host start), with the daemon's rows as the
   record of what ran. Model per wake through the ADR 101 ladder, so a coordination wake can run
   on Haiku and a lane on Opus under one seat.
6. **Reach is in-process.** The resident engine subscribes to the seat's inbox (the ADR 552 poke)
   and delivers a directed act into the running loop through pi's steering queue between tool
   calls — no hook, no spawn. The roster shows the seat `hearing`; it is never deaf. This is the
   idle-wake goal's native adapter.
7. **The pilot is pre-registered and has a kill criterion** (lane `01M4VTAEJZYTYACT224Y8T309F`):
   one coordination seat on Haiku 5.5 and one worker seat on Opus 5.5, resident on this team for a
   week, against the Claude Code wake backend on the same lane class. If the worker seat lands fewer
   accepted lanes per dollar than the Claude Code backend, the resident seat ships as
   coordination-only and the worker shape waits for a reason to return.
8. **It is the local half of Cloud increment 8.** The same seat, the same key, on a laptop today
   and on a Cloud host later (ADR 463's sponsor-hosted shape); nothing here presumes a laptop.

## Consequences

- Lanes under `hosted-seat`: the engine (`01M4VTA1K7DNKWE94DTJFPXAQC`), the in-process doorbell
  (`01M4VTA7Y6S500YTY504RT4RCV`), the pilot (`01M4VTAEJZYTYACT224Y8T309F`). The engine lane adds the
  `@earendil-works/pi-durable`, `pi-agent-core` and `pi-ai` dependencies to `packages/cli` citing
  this ADR, and gains `musterd residency on --harness musterd --key-env <VAR>`.
- ADR 251's phase-1 engine (`engines/anthropic.ts`, the SDK tool runner) is superseded by the pi
  engine for every native wake once the engine lane lands; it stays as the scripted suite's fake
  until then and is removed with a dated note here.
- The retired phase-2 spec's three pillars are now all placed: verification (ADR 585), metering
  (ADR 583), and resume-by-replay (pi-durable, this ADR). Its chain-gate design (a continuation
  funded only after claims verify) is not decided here; the rail's confirmed/unconfirmed outcomes
  are the input a later ADR would gate on.
- Economics are stated, not hidden: a resident seat pays API rates. At this team's coordination
  volume a Haiku seat is on the order of $20–30 a month; a worker seat on Opus is priced per lane
  by the gateway and the pilot reports it. A subscription seat on Claude Code stays cheaper for a
  human's own session, which is why Decision 2 holds.
- pi's embedding API is at 1.2.0 and moves; the engine file is the one place it is touched (the
  ADR 251 blast-radius rule), and a breaking pi release is an engine-lane fix, never a protocol
  change.

## Observability & Evaluation

- **Traces.** The existing residency rails with surface `musterd`: `wake_leases`, `wake_turns`
  (now every turn, pi's events mapped), `residency.wake_cost` with `price_source: gateway`,
  `lane.claims_filed` / `lane.claims_verified` on the seat's submits and accepts, presence rows
  attesting model and provenance. New: a `residency.steered` audit row per in-process delivery
  (act id, delivered-at, answered-at).
- **Eval.** The pilot's four numbers, read weekly: directed act → first in-thread answer p50/p95
  for the resident seat against the Claude Code idle canary (5.06–5.25 s) and spawn wakes
  (occupancy 5–22 s); dollars per accepted lane for the worker seat against the Claude Code backend
  on the same lane class; accepted/submitted; the share of the seat's claims the acceptor confirmed.
  **Baseline:** the ADR 436 rail and the gateway rows for Claude Code wakes over the same week.
- **Experiment.** The pilot (Decision 7), run as an ADR 051 manifest under `docs/research/` before
  the seats are enrolled, with the kill criterion stated there and the finding recorded here as a
  dated note either way. One adversarial probe inside it: a directed `steer` sent while the worker
  seat is mid-tool-call must be answered in-thread before the seat's next model call completes.
