# Keep credentials out of policy audit and replication

**Status:** design approved 2026-10-19. This page records the approved implementation direction;
the implementation and any protocol decision remain subject to an ADR. Lane
`01M5AMGDSC9C5DH66B3MYE8QPQ` (big-body), security goal.

## Problem

`policy.change` stores the full sparse team policy in `audit.detail`. The same event is written to
`sync_log.payload` and replicated. That policy can contain credentials and secret-bearing endpoint
URLs, including `seeds_relay_token`. A historical `policy.change` therefore leaves those values in
the audit history and on replicas, even though policy reads and exports otherwise protect them.

ADR 367 records the current full-policy event shape. ADR 399 rejects replicating seed-relay
credentials and keeps seed-relay ingest hub-only. This design preserves hub behavior while making
the audit/replication boundary match that credential rule.

## Approved design

1. **Redact secret-bearing values in new policy events.** The local hub policy remains complete.
   When building the `policy.change` event detail, replace credential values with an explicit
   structured redaction marker. Cover `ask_slack_webhook`, `seeds_relay_token`, `seeds_relay_url`,
   `away_relay_token`, `away_relay_url`, and `slack_bot_token`, plus
   `doorbell.slack_url` and `doorbell.webhook_url`. The marker carries no original value, host,
   length, or digest. Keep ordinary policy fields unchanged.
2. **Strip markers when folding on replicas.** A replica must omit redacted fields from its
   projected `teams.policy`, including the nested doorbell fields. It must never persist a marker
   as a configured credential or interpret the marker as an empty credential. The hub continues to
   use its full local policy for outbound integrations. This is consistent with seed-relay ingest
   remaining hub-only under ADR 399.
3. **Scrub historical copies in place.** Add a one-time database migration that replaces the listed
   credential values in existing `policy.change` rows in both `audit.detail` and
   `sync_log.payload` with the same marker. Preserve row identifiers, origin and hub sequence
   numbers, timestamps, and all non-secret event fields. Do not delete rows or reset sequence
   floors; replicated event identity and ordering remain stable.
4. **Rotate the exposed relay token before the history scrub is applied.** Nick must confirm
   `seeds_relay_token` has been rotated on the hub and replicas. No token value belongs in the spec,
   an Act, test output, or commit. Rotation is an operational precondition, not part of the migration.

## Behavior and acceptance

- Updating policy still stores the complete policy on the hub and preserves current hub-side
  integration behavior.
- New `policy.change` audit details contain a marker for each present secret-bearing field and
  contain no original secret or URL value.
- Folded replica policy contains no redaction markers and no corresponding secret-bearing fields;
  unrelated policy values still project as before.
- Migration tests demonstrate that historical `audit.detail` and `sync_log.payload` are scrubbed
  while row IDs, counts, sequence values, timestamps, event identity, and ordinary fields remain
  unchanged.
- The migration is safe for the supported SQLite and PostgreSQL migration paths.
- Rotation is confirmed before the migration is run against persistent team data.

## Scope

This design covers team-policy events and their stored audit/replication copies. It does not change
the policy schema, policy read authorization, member doorbell preferences, event ordering, sync
protocol, or integration configuration on the hub. It does not add a new runtime dependency.

## Decision record

The implementation must resolve the event-marker representation and portable migration mechanics
in an ADR before changing the event contract or stored history. The decision record should amend the
relevant rationale in ADR 367 and ADR 399 without rewriting their accepted decisions.
