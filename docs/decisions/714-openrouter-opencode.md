# 714 — OpenRouter with OpenCode

- Status: accepted
- Date: 2026-10-22

## Context

OpenCode already provides its own OpenRouter provider and account connection. Its interactive
provider selection and credentials belong to OpenCode. Musterd's OpenCode integration currently
adds MCP/onboarding configuration, while Musterd-triggered OpenCode wakes can use a per-wake
`OPENCODE_CONFIG_CONTENT` override to send supported provider traffic through the loopback metering
gateway (ADR 583). The gateway forwards authorization headers without reading or logging them and
prices recognized model usage from the host's dated price table.

## Problem

Members need to use OpenRouter from ordinary OpenCode sessions alongside their other provider
accounts, and choose OpenRouter for Musterd-triggered OpenCode wakes without exposing credentials,
changing their interactive configuration, or silently bypassing wake metering.

## Decision

1. Interactive OpenCode setup remains native to OpenCode. Musterd will document connecting an
   OpenRouter account and selecting its model, but will not import, store, rewrite, or export the
   OpenRouter credential or take ownership of the user's provider selection.
2. A Musterd-triggered OpenCode wake may route OpenRouter requests through the existing loopback
   metering gateway. Its provider base URL is overridden for that wake only; the user's project and
   global OpenCode configuration are not edited. OpenCode's existing credential store supplies the
   bearer credential, which the gateway forwards unchanged and never reads or logs.
3. Wake usage is attributed to the OpenRouter provider and the model id returned by the upstream.
   The gateway uses the existing dated price table and existing `no_price_row` behavior for models
   without a row; it does not claim an unpriced call was free or accurately priced. The first
   implementation must demonstrate how supported OpenRouter model usage is priced and how the
   configured wake budget behaves before it is enabled for general use.
4. Interactive calls remain outside Musterd wake metering. No OpenRouter API key is written to
   project config, Musterd state, traces, or logs.

## Consequences

OpenCode's native `/connect` and model-selection flow remains the source of truth for interactive
sessions; Musterd onboarding and help text explain how to use it alongside other accounts. Wake
configuration is ephemeral and scoped to the spawned process. Gateway tests must cover forwarded
authorization without logging it, routing, returned usage/model attribution, known and unknown
prices, and wake-budget behavior. OpenRouter pricing is model-specific and can change, so price rows
need dated provenance and unknown models remain visibly unpriced. The interaction between
OpenRouter's returned usage/cost fields and the gateway's current table-based pricing must be settled
and tested before declaring generic model coverage.

Follows-up: implement interactive setup guidance and OpenRouter routing for metered OpenCode wakes
under Goal `openrouter-opencode`, with unknown-price and budget handling covered by acceptance tests.

## Observability & Evaluation

- **Traces:** wake records carry the gateway's provider, model, usage, and priced cost where a dated
  row exists. No credential, prompt, or completion is recorded by this change.
- **Eval:** use a controlled upstream fixture to verify interactive configuration is untouched,
  wake requests route through the gateway, authorization is forwarded but not logged, usage is
  attributed, and budget behavior is correct for priced and unpriced models.
- **Experiment:** n/a — this change establishes deterministic provider routing and accounting; it
  makes no model-quality claim.

