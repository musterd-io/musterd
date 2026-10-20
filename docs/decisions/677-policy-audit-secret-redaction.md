# 677 — Policy audit secret redaction and history scrub

- Status: accepted
- Date: 2026-10-19
- Lane: `01M5AMGDSC9C5DH66B3MYE8QPQ`
- Relates to: ADR 367 (hub-authoritative team policy), ADR 399 (seed relay credentials stay hub-side), ADR 185 (sparse policy)

## Context

`applyPolicyChange` stores the complete sparse policy on the hub and stamps that same object into a
`policy.change` audit event. The event is copied to `sync_log.payload` and folded on replicas. Policy
fields can contain bearer credentials and secret-bearing URLs, including the seed relay token.
Consequently, the current event path stores those values in audit history and distributes them to
replicas. ADR 367 establishes the hub as the policy authority; ADR 399 keeps the seed relay
credential hub-side, but did not close this event-data path.

## Problem

The hub needs its full policy for integrations, while audit and replication records must not retain
or distribute the configured credentials. Existing policy events also need in-place remediation
without changing event identity or sequence order.

## Decision

1. New `policy.change` event details redact the values of `ask_slack_webhook`,
   `seeds_relay_token`, `seeds_relay_url`, `away_relay_token`, `away_relay_url`, and
   `slack_bot_token`; they also redact `doorbell.slack_url` and `doorbell.webhook_url`. Each present
   value is replaced with the exact structured marker `{"$redacted":"policy-secret"}`. The marker
   carries no original value, host, length, or digest. Ordinary sparse policy values are unchanged.
2. The hub's stored `teams.policy` remains complete and continues to drive its integrations. The
   `policy.change` audit detail and replicated payload use the redacted projection instead.
3. A replica's `policy.change` fold removes marked secret fields before replacing its projected
   policy. It recursively removes the two nested doorbell URL fields, preserves ordinary policy
   fields, and never stores a marker as a configured value.
4. A one-time migration redacts the same fields in existing `policy.change` rows in both
   `audit.detail` and `sync_log.payload`. It updates payload columns in place and preserves row IDs,
   origin and hub sequence numbers, timestamps, event identity, counts, and all ordinary fields.
   The migration is idempotent and implemented for the SQLite and PostgreSQL migration paths.
5. The migration must not run against persistent team data until Nick confirms that the exposed
   `seeds_relay_token` has been rotated on the hub and replicas. The change must remain unmerged
   until that confirmation, because the daemon applies schema migrations when it opens its
   database. No credential value is recorded in this ADR, a fixture, an Act, or a commit.
6. The collaboration protocol schema and sync event action remain unchanged. The event detail is
   already an open record; no runtime dependency is added.

## Consequences

- New audit and sync rows retain enough ordinary policy data for existing fold semantics, while
  replicas no longer receive the listed secrets. Hub integrations continue to use the unredacted
  local row.
- Historical copies are scrubbed without deleting or renumbering replicated events. A malformed
  historical `policy.change` payload must fail the migration transaction rather than be silently
  skipped with a credential potentially left behind.
- Merge and automatic daemon refresh are held until the token-rotation precondition is confirmed.

## Observability & Evaluation

**Traces** — after a policy update, the hub's `teams.policy` still contains each configured value;
its matching `audit.detail` and `sync_log.payload` contain only the redaction marker; after one fold,
the replica policy has neither the marker nor those secret fields. Falsify by querying those three
records in the in-process hub/replica fixture.

**Eval** — use hand-written sentinel values in SQLite and PGlite fixtures. Assert no sentinel appears
in new or migrated policy events, replica policy omits marked fields, ordinary fields survive, and
historical row IDs, counts, timestamps, event identity, `origin_seq`, and `hub_seq` are byte-for-byte
unchanged. Baseline: current ADR 367 behavior puts the full sparse policy in the event. The
server's focused migration and sync policy tests are the executable evaluation.

**Experiment** — none as a rollout flag; this is deterministic persistence behavior. The persistent
history migration is applied only after the relay token rotation is confirmed.
