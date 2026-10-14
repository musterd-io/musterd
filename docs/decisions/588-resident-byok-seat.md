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
3. **The engine is pi, embedded behind the seam ADR 251 named.** _(Amended 2026-10-13: the
   dependency narrows to `pi-agent-core` + `pi-ai`; `pi-durable` is not taken. See the amendment
   below.)_ A second `AgentLoopEngine`
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
   record of what ran. _(Amended 2026-10-13: the daemon's rows are the resume substrate, not
   pi-durable's storage. See the amendment below.)_ Model per wake through the ADR 101 ladder, so a coordination wake can run
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
- _2026-10-13 (engine lane `01M4VTA1K7DNKWE94DTJFPXAQC`)._ Landed as amended: `packages/cli`
  depends on `@earendil-works/pi-agent-core` 1.2.0 and `@earendil-works/pi-ai` 1.2.0 (this ADR is
  the hard-rule-6 record; `pi-durable` is not taken) and no longer on `@anthropic-ai/sdk` — the
  phase-1 engine, its pricing re-export and the SDK tool-runner regression fixture are removed with
  this note. `engines/pi.ts` is the one engine every native wake runs on; `engines/jail.ts` and
  `engines/workingTools.ts` are Decision 4 (our own `read`/`write`/`edit`/`bash`, since pi's
  `CodingTools` ride pi-durable); `engines/rehydrate.ts` is the amended Decision 5. The resume
  substrate read is a new route, `POST /teams/:slug/residency/wake-transcript`, with its query and
  response schemas added to `@musterd/protocol` under this ADR (the amendment makes the daemon's
  rows the substrate, which needs a read path; nothing existing changed). Working tools ride only a
  `seat-policy` wake (a work order); a reply wake stays coordination-only. `musterd residency on
  --harness musterd --key-env <VAR>` stores the variable NAME in the host registry; the host reads
  the key at spawn and defers, naming the variable, when it is unset. Known gap: the gateway and the
  engine both post a `wake_turns` row per turn (same lease, same index — the row is an overwrite);
  the engine's row carries the transcript and lands last on every path measured, but the two
  writers should become one when the doorbell lane touches the row.
- _2026-10-13 (same lane, second increment)._ Three seats (wallow, fifty, miley) filed findings on
  #2554 against `engines/jail.ts`: the bash allowlist judged only the command head, so a reader
  could leave the workspace by argument (`cat ~/.musterd/…`), a flag could turn a reader into an
  executor or a writer (`rg --pre`, `sort -o`, `find -fprint*`, `sed 'e …'`/`'w …'`), git's own
  options could execute or retarget (`-c`, `--upload-pack`, `--exec`, `--git-dir`), and `musterd`
  passed with any subcommand. Decision 4 is now enforced per argument and per binary: every token is
  confined (nothing absolute, `~`, `..`, `.musterd/`, `.git/`, or an existing path that resolves
  outside through a symlink), any `$` is refused, the flags above are denied by binary, `sed` is a
  line-range print only, git's execute/reconfigure options are denied anywhere on the line, and
  `musterd` is the seat half of the CLI. What the allowlist cannot be is a sandbox for code the seat
  writes and then runs under `pnpm test` — that executes as the host user by the nature of a worker
  seat, and the durable boundary is an OS sandbox around the bash child.
  Follows-up: lane `01M4VYT6JWHYG6E8ZZ9J55AS9X` (security goal) — sandbox-exec / bubblewrap around the child, workspace-only, gateway-only network.
- _2026-10-13 (same lane, the live proof)._ Seat `resident` enrolled on this team (Haiku 5.5,
  harness `musterd`, key from launchd's environment via `--key-env`), woken three times by directed
  acts. Wake 1: occupied in 2.1 s, 24 turns, $0.0276, the gateway metered 24 calls at $0.0276; the
  seat wrote `docs/wiki/resident-seat.md` and opened #2570. Wake 2 (after #2571 gave the capture
  rail the host-scoped key): 5 turns, $0.0026, every row carrying a transcript. Wake 3: rehydrated
  from wake 2 (`replayed 5, skipped 24 non-pi rows`), 7 turns, $0.0035, merged #2570 at 8c548b20
  with `gh pr merge --squash`. Each wake's gateway total, summed `wake_turns` rows and
  `residency.wake_cost` agree. The jail held across the seat's bash calls. Not met from the engine
  lane's done line: the seat's `lane_submit` (and so its ADR 585 claims) was refused — the hub's
  roster lacks the joiner-minted seat and the lane's birth never folded on the hub; that is lane
  `01M4W28V0BVY8G8WRF2ADG45TT` under `seat-continuity`, not an engine fault. Two settings a resident
  seat needs that the defaults deny: `hourly_cap` 2 held wake 3 for 40 minutes (enrol with
  `--hourly-cap 20 --cooldown 1m`), and GitHub refuses `gh pr merge --auto` once a PR's checks are
  complete, so a seat merges directly when its gates are already green. The actuator does not need
  a manual restart after a merge: the refresher restarts it with the daemon, and launchd's
  environment carries the key across that restart.
- pi's embedding API is at 1.2.0 and moves; the engine file is the one place it is touched (the
  ADR 251 blast-radius rule), and a breaking pi release is an engine-lane fix, never a protocol
  change.

- _Amendment (dated, 2026-10-13, same day, lane `01M4VTS0720NZWKGJ3K9Y0Z13R`)._ nick asked for alternatives to pi
  and for the seat to be "extremely bleeding edge and unique". The assessment: uniqueness is not in
  the loop — every loop in the field converged on one shape and the eleven-harness study ships it
  as a 90-line scaffold. The two things nobody has are **cross-vendor replay** (wake N on one model,
  wake N+1 on another, from a transcript musterd owns) and **claim-gated continuation** (the daemon
  funds the next wake only after the previous wake's ADR 585 claims verify). Both need the
  transcript format and the chain to be the daemon's, not a library's. So Decision 3 narrows:
  the dependency is `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` — the turn and the
  providers, where tracking the vendors' tool shapes is worth outsourcing — and **`pi-durable` is
  not taken**. Decision 5 changes accordingly: the daemon's `wake_turns` rows are the canonical,
  provider-neutral transcript and the resume substrate; whichever engine runs the next wake is
  rehydrated from them. The loop is a swappable executor behind the seam, which is what ADR 251
  §3 built the seam for. Alternatives weighed and set aside: Claude Managed Agents and the Claude
  Agent SDK (Claude-only, transcript held by the vendor — both unique features die), the OpenAI
  Agents SDK with Temporal (OpenAI tool shapes, durability in Temporal rather than the ledger,
  heavy for a laptop daemon), Hermes Agent (a Python product, not a library; its sandbox backends
  are worth copying for Cloud), Cloudflare Agents on Durable Objects (the right shape for hosted
  seats later; a different runtime and a Cloudflare tie), Letta / LangGraph / Mastra (a framework
  layer no serious harness uses), and a loop of our own (full control, the co-training tax and the
  maintenance stream the readout measured). Decision 6's in-process doorbell now uses
  `pi-agent-core`'s own steering queue (`agent.steer`), which needs no pi-durable.

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
