# 583 — The ADR 436 trigger is answered at the request path: a metering gateway, not a loop

- Status: accepted
- Date: 2026-10-13
- Builds on: [ADR 436](436-wake-edge-is-a-contract-not-a-loop.md) (the wake edge is a contract; Decision 5 is the trigger this ADR answers),
  [ADR 131 §7](131-harness-residency-wake-ledger-host.md) (the actuator seam),
  [ADR 251](251-native-backend-musterd-as-its-own-harness.md) (the native reference row),
  [ADR 364](364-tokens-are-the-attested-unit-when-the-harness-prints-no-price.md) (unpriced is a fact, not zero),
  [ADR 101](101-model-as-a-variable.md) (model as a variable),
  [ADR 221](221-cannot-actuate-is-a-deferral.md) (cannot-actuate is a deferral, never a charge)
- Lane: `01M4VNF7AW72K4RSVV56ACVDW3` · Goal: `verified-work`
- Input: [own model, native harness, or neither — research readout](../design/2026-10-13-own-model-vs-native-harness.md)

## Context

ADR 436 decided that the wake edge is a contract the host enforces around every backend, that
musterd does not take over the loop, and that the question is reopened "by a new ADR" when,
thirty days after clause 1 landed, either of two things holds: a backend still cannot be priced
from its own artifact, or the median prompt floor on any harness exceeds three times Claude
Code's. Clause 1 landed 2026-09-21; the binding read is 2026-10-21.

Read on 2026-10-13, eight days early, `pnpm wake:rail` says both clauses hold:

| harness     | settled wakes priced | median floor (prompt tokens) |
| ----------- | -------------------- | ---------------------------- |
| claude-code | 42 / 61              | 237k                         |
| grok        | 0 / 37               | 2,878k (12.2× Claude Code)   |
| codex       | 0 / 38               | 530k                         |
| opencode    | 0 / 32               | 357k                         |

Nothing in the next eight days changes that. Three of four harnesses are unpriced on every wake,
because they print no price (Codex), or print one the host cannot verify (Grok, OpenCode); and
Grok's floor is four times the trigger's bar. ADR 364 keeps "unpriced" an honest fact in the
ledger, but a ledger that is honest about not knowing the cost of 60% of wakes is not the
accountability record the product claims.

ADR 436's own framing of the reopen was "owning the loop, one engine per provider": grow the
ADR 251 native backend an Anthropic, OpenAI, xAI and OpenCode-provider engine each, and route
wakes through it so musterd sees every token. The research readout measured that option against
the October 2026 field and the daemon's own state. The native backend is dormant (0 enrolled seats,
0 transcript rows since the August experiment); every loop feature it would need is now commodity
in half a dozen MIT/Apache harnesses; a harness with its own tool schema pays a model-co-training
tax that grows per model generation; and a musterd-owned loop is a "third-party harness" under
Anthropic's terms, which puts its users on API rates where Claude Code users pay a flat
subscription. Owning the loop would buy the price and the floor at the cost of the model and
harness diversity ADR 101 and ADR 056 exist for.

The price and the floor have a cheaper common cause. Both are facts about the model calls a
wake makes, and every harness musterd wakes makes those calls over HTTP to a base URL it reads
from its environment or its config: `ANTHROPIC_BASE_URL` (Claude Code; also honoured by
OpenCode's Anthropic provider), `OPENAI_BASE_URL` (Codex), and the per-provider base-URL
settings OpenCode and Grok CLI document. The host already composes a sanitized environment per
backend (`wakeEnv` and each backend's allowlist in `packages/cli/src/host/backends/*`). Whoever
owns that URL sees every request and every response, including the usage block the provider
returns.

## Problem

The daemon must price every wake and measure every harness's floor from one source it controls,
on Claude Code, Codex, OpenCode and Grok alike, and must be able to stop a wake that has spent
its budget before the next model call rather than after the child exits, without musterd owning
the agent loop, and without holding or reading any credential.

## Decision

1. **The ADR 436 trigger is answered at the request path.** The host runs a local **metering
   gateway**: a pass-through HTTP proxy, bound to loopback, that each wake's harness is pointed
   at through the base-URL variable that harness documents. The gateway forwards every request
   to the real provider unchanged, relays the response (streaming included) unchanged, and reads
   the provider's usage block from the response as it passes. It is the one place musterd sees
   model calls on every harness.
2. **Every call is attributed and priced where it is seen.** The gateway tags each call with the
   wake lease, seat and lane it was spawned for (the lease id is already in the child's
   environment as `MUSTERD_WAKE_LEASE`; the gateway is per-wake, so the mapping is by
   construction, not by inspection), prices it from the response usage against the provider
   price table the host already carries for its cost readers, and reports it to the daemon as the
   per-turn rail ADR 251 §7 defined (`wake_turns`, `POST /residency/wake-turn`). That rail
   stops being native-only: it becomes the price source for every backend, and `settled` cost
   for a gateway-metered wake is the sum of its turn rows, exactly as ADR 251 §6 reconciles the
   native row. ADR 364 stays the rule for what the gateway cannot see: a harness that bypasses
   the base URL (a vendor cloud session, a harness with no base-URL knob) is recorded unpriced
   with a reason naming the bypass. Nothing is estimated.
3. **The floor is measured, not inferred.** The first request's prompt tokens on each wake are
   the floor the ADR 436 rail reports, read from the usage block, per harness, with no
   normalisation step. The rail's per-harness normalisation (ADR 436 Consequences, 2026-09-30)
   is retired for gateway-metered wakes.
4. **Budget is enforced before the next call.** When a wake's summed turn cost reaches its
   `budget_usd` (ADR 131 bounds), the gateway refuses the next request with a structured
   provider-shaped error the harness surfaces to the model, and reports `wake_failed` with the
   standard taxonomy (`budget_exhausted`). The refusal is the ADR 221 kind of gate: a machine
   decision on a machine fact, never a model judgment, and it never charges an attempt. Chain-
   or lane-level bounds are not decided here.
5. **The gateway holds nothing.** It never reads, stores or logs an `Authorization` header, an
   API key or an OAuth token; headers pass through byte-for-byte (hard rule 5). It never reads
   or stores request or response bodies beyond the usage block and the model id; agent-turn
   content stays where ADR 445 already captures it. It listens on loopback only, on a port
   minted per wake, and dies with the wake.
6. **"One engine per provider" is reversed, not deferred.** The option ADR 436 Decision 5 named
   is closed: musterd does not own the loop to see the tokens, because it can see the tokens
   without owning the loop. The ADR 251 native backend remains the ADR 436 §2 reference row, grows
   no working tools, and is metered by this gateway like any other backend. A model-agnostic
   executor, should a customer ever require one, is an embedding decision over an existing
   MIT harness and its own ADR; it is not licensed here.
7. **Scope.** cursor-agent has no wake backend and is excluded as in ADR 436 §6. Harnesses that
   cannot be pointed at a base URL are excluded by construction and the rail says so (Decision 2).
   Interactive sessions (not wakes) are not metered by this ADR; whether the same gateway
   fronts a Workspace's interactive sessions is a separate decision.

## Consequences

- Lane `01M4VNFB7BQF6KEDYT08RRYJTA` (verified-work 2) implements it: the gateway process in
  `packages/cli/src/host`, the base-URL variable added to each backend's environment allowlist,
  the per-turn report from the gateway, and `pnpm wake:rail` reading price and floor from turn
  rows first. Done when Grok, Codex and OpenCode wakes show priced on the rail from gateway rows,
  and a wake over `budget_usd` is refused mid-run with a ledger entry.
- The provider price table becomes load-bearing for three more harnesses. It is already
  bundled for the cost readers; a wrong or stale row now misprices a wake rather than leaving it
  unpriced, so the table gains a dated provenance line per row and the rail flags a model id
  with no row as unpriced with reason `no_price_row`.
- If a provider SDK or proxy library is pulled in to relay streaming responses, that is a hard
  rule 6 dependency ADR of its own. The intent is none: Node's HTTP client can relay a byte
  stream, and the Anthropic and OpenAI usage blocks are documented JSON.
- Claude Code wakes run under the operator's subscription today and keep doing so; the gateway
  is the documented LLM-gateway path (`ANTHROPIC_BASE_URL`) with the harness unchanged. If a
  vendor's terms come to forbid even a pass-through proxy on subscription traffic, Claude Code
  wakes fall back to the harness's own cost artifact, as now, and the rail says which path priced
  each wake.
- ADR 436 Decision 5's thirty-day read on 2026-10-21 (lane `01M3TB1GPMMH2VKFJ2V97CSP9P`) still
  runs and records its snapshot; its Decision 5 follow-up ADR is this one.
- The three remaining pillars of the retired native-harness phase 2 spec that do not need a loop
  are lanes under the same goal: this gateway (verified-work 2) and the verification rail
  (verified-work 3, `01M4VNFG0PGBS8N2TA7CPW4551`, its own ADR because it changes the submit
  body schema). Replay into any harness needs no new decision: the ADR 430 packet plus each
  harness's native resume is already the path.

- _Implementation note (dated, 2026-10-13, lane `01M4VNFB7BQF6KEDYT08RRYJTA`)._ Landed as
  `packages/cli/src/host/gateway.ts` + `prices.ts`, wired into `pollHostOnce` (one gateway per
  actuation, closed at settle; `musterd host --no-gateway` runs without it), the base-URL
  variables placed last in every backend's child environment, `price_source` /
  `budget_exhausted` on the supplementary report and the `wake_cost` row, `no_price_row` as an
  unpriced reason, and `pnpm wake:rail` reading a gateway-priced wake's floor from the usage block.
  The lane's primary-doc research changed two things the Decision assumed: **(a)** Claude Code
  honours `ANTHROPIC_BASE_URL` under a claude.ai login (the gateway forwards `anthropic-beta`,
  which carries the OAuth capability) and Grok Build honours `GROK_MODELS_BASE_URL`; but **Codex
  reads no base-URL variable** (`openai_base_url` lives in user-level `config.toml`, and its
  built-in provider also speaks WebSocket) and **OpenCode reads only `opencode.json`**. Both are
  therefore still priced by their own artifact (Decision 2's fallback, now named
  `harness_artifact`) until a config-path lane points each at the gateway — that is the remaining
  distance to this ADR's Eval bar, and the Codex WebSocket transport is an open question for it.
  **(b)** Cache-read multipliers differ per model (0.1× standard, 0.05× Opus/Sonnet 5.5, 0.025×
  Fable 5.1, 0.25× xAI), so the table carries them per row. Long-context tiers are not modelled.

- _OpenCode note (dated, 2026-10-19, lane `01M4VQ3JDCPHTH6BTT928C84MK`)._ OpenCode now runs behind
  the gateway. OpenCode 2.x hands a plain `opencode run` to the user's background `opencode serve`,
  whose provider config a wake cannot reach. A metered wake therefore runs `opencode run
  --standalone`, a private server that reads the wake's environment, with `OPENCODE_CONFIG_CONTENT`
  pointing OpenCode's hosted providers (`opencode` Zen and `opencode-go`, both OpenAI-compatible,
  upstreams from models.dev) at `<gateway origin>/<id>`. OpenCode merges that over the seat's own
  `opencode.json`, which is never edited. `--session` resume works the same from a private server.
  The lease names the run's pid, because the adapter descends from it and not from `serve`
  (ADR 613's fallback). A local model (ADR 663) is not re-pointed. Other OpenCode providers
  (anthropic, openai, xai) are not re-pointed either, since their SDK base paths differ from the
  gateway's upstreams, and they stay on the artifact. Checked live on 2026-10-19: one free-model
  wake on this machine metered 2 calls, 0 unmetered. A model with no row in the price table is
  metered and left unpriced (`no_price_row`) instead of being guessed.

## Observability & Evaluation

- **Traces.** Per metered call: a `wake_turns` row (lease, turn, usage, cost, model) through the
  existing `POST /residency/wake-turn`; per wake: the existing `residency.wake_cost` row now
  carrying `price_source: gateway | harness_artifact | none`; on refusal: `residency.wake_failed`
  with `budget_exhausted`. Agent-turn content is not touched (ADR 445 owns it). Spans: one
  per proxied call under the wake's span, attributes `musterd.model`, `musterd.price_source`.
- **Eval.** The ADR 436 rail. Success: 100% of settled wakes on every enrolled harness that
  honours a base URL carry a gateway-priced cost row; the floor column is read from usage with
  n = every wake, not a sample; zero wakes exceed `budget_usd` by more than one call's cost.
  Baseline: the 2026-10-13 rail above (priced 42/61, 0/37, 0/38, 0/32; floor n = 3–32).
- **Experiment.** After the gateway lands on the daemon, re-run the ADR 436 three-act thread on
  all four harnesses and read the rail. Then one adversarial probe: a wake with `budget_usd` set
  below one turn's cost must be refused on its second call, settle `budget_exhausted`, and charge
  exactly one turn. Confirms Decision 4 is a gate and not a report.
