# 663 — A local model wake: the `local` unpriced reason, on three signals read at spawn

- Status: accepted
- Date: 2026-10-19

## Context

The local-model-seat design (`docs/superpowers/specs/2026-10-17-local-model-seat-on-air-2-design.md`,
agreed with nick on 2026-10-17 and amended the same day from dolly's, big-body's and fifty's reads)
puts a 3–4B open-weight model on Air 2 behind one OpenCode seat. Its §4.4 asks for one change, made
before the gauntlet, so the record is honest from the first act: a wake that ran a model served on
the host must say so, and must not read as either a priced wake or an unpriceable one.

Today such a wake is indistinguishable from any other OpenCode wake. The backend settles every wake
`harness_price_unverified` with OpenCode's own figure (a literal `0`) as `harness_cost_usd`. The
ADR 436 rail then counts it in "0/N priced" and could fire the trigger for a harness whose metered
wakes are fine, and `/report` has nowhere to put it.

The spec's first draft took a loopback base URL as the signal and exempted local wakes from the
unpriced-wake cap. Both reviews rejected that. A loopback URL is a configuration claim, not
evidence: the ADR 583 gateway itself binds loopback, and so does a local proxy in front of a paid
API. An exemption keyed on it would let a paid call switch a spend guard off.

On 2026-10-19 nick asked for a look at NVIDIA's Dory 1.0 4B (released 2026-10-16). It runs on
Apple Silicon only through llama.cpp's `llama-server`: Ollama has no tag, and llama.cpp support is
an open draft PR. A signal that named only Ollama would rule out every model that ships
llama.cpp-first, by construction rather than by a reading.

## Problem

Name a wake that ran on a host-served model, with a signal that is hard to trip by accident, that
the ADR 436 rail and `/report` can show apart, and that never turns a spend guard off.

## Decision

1. **`local` is a fourth `unpriced_reason`** (`packages/protocol/src/residency.ts`). It amends
   ADR 364's closed set: the wake ran a model served on the host itself, and the price is known to
   be zero. ADR 583's `no_price_row` and ADR 364's other two reasons are unchanged.
2. **Three signals must agree, read once at spawn.** The OpenCode backend marks a wake `local` only
   when (a) the seat's binding declares `local: true` (a new optional binding field, hand-set,
   per-machine, merge-guarded on save like `host_key`); (b) the workspace's one pinned `model`
   resolves to a provider in `LOCAL_SERVING_PROVIDERS` — `ollama` and `llama.cpp`; and (c) that
   provider's `options.baseURL` is loopback. Only the workspace's `.opencode/opencode.json` and
   `opencode.json` are read, never the global file, because a global pin would relabel every seat on
   the host. A `jsonc` sibling, an unparseable file, or two files that disagree answer "not local".
   Any disagreement keeps `harness_price_unverified`.
3. **The snapshot rides the record.** A `local` wake carries `local_serving {provider, model,
   base_url}`, as read at spawn, on its supplementary wake report. The daemon copies it onto the
   `residency.wake_cost` audit row. An edit to the config mid-wake changes nothing.
4. **Counted, never exempted.** A `local` wake still counts against `unpriced_wake_cap` (ADR 639),
   because the signal is a claim. `/report` shows it as `local_wakes`, beside cost and never inside
   it. The ADR 436 trigger takes it out of the "priced" denominator, so a local seat can neither
   trip nor silence the clause for its harness's metered wakes; the rail still prints it as
   `local ×N`.
5. **No price row, no `cost_usd: 0`.** The price table is read only by the gateway and the resident
   engine, so a zero row would never be reached on this path.

The per-seat advisory acceptance scope the spec pairs with this change is a separate server
mechanism (the picker's re-route after an advisory verdict). It gets its own ADR with its own lane.
Follows-up: `01M5APAM3AMT67WF3859GT53ZE`

## Consequences

- A seat becomes `local` by three hand edits on its own host: `local: true` in its binding, and in
  its workspace `opencode.json` a pinned `<provider>/<model>` plus that provider's loopback
  `baseURL`. Nothing else changes for any other seat.
- `BindingSchema` is strict. A host whose CLI or adapter predates this ADR refuses a binding that
  carries `local`, and the seat goes quiet. Set `local` only once that host runs this build.
- Every reader that rebuilds a binding (claim, autojoin, `persistBinding`) keeps `local` through
  the merge guard, for the same seat only. A folder re-bound to another seat drops it.
- The gauntlet (lane `01M55R1FN3M1BPFQ5J5RH2QGX1`) starts on this. Its first check is that a
  wake's `wake_cost` row reads `unpriced_reason: local` with the snapshot.
  Follows-up: `01M55R1FN3M1BPFQ5J5RH2QGX1`
- Adding a provider to `LOCAL_SERVING_PROVIDERS` is a one-line change, and it needs a dated note
  here naming the server it stands for.
- The resident engine (`pi.ts`) still has no local provider. That is the spec's second step, taken
  only if the main run says a local model deserves a first-class seat.

## Observability & Evaluation

**Traces** — each `residency.wake_cost` row carries `unpriced_reason` and, for a `local` wake, the
`local_serving` snapshot; `/report`'s `wake.local_wakes` counts them by lease; the ADR 436 rail
prints `local ×N` on the harness's unpriced line.

**Eval** — the tests pin the rule. All three signals together yield `local`. Each pair without the
third stays `harness_price_unverified`: the binding without the provider, the provider without
loopback, loopback without the binding. The read happens once, at spawn. The rail leaves `local`
out of the trigger's denominator, and the cap counter still counts it. Headline check after the
gauntlet's first wake: the seat's `wake_cost` row reads `local` with the snapshot it ran under, and
`unpriced_wake_count` moved by one.

**Experiment** — the gauntlet and dogfood run 13 (lanes `01M55R1FN3M1BPFQ5J5RH2QGX1`,
`01M2M6NV4C2CNBJYVYQTFMAQRW`) are the experiment. Their verdict rules are fixed in the spec, before
any model is pulled.
