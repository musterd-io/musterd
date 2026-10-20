# Policy audit secret redaction plan

**Lane:** `01M5AMGDSC9C5DH66B3MYE8QPQ`
**Design:** [policy audit secret redaction](../specs/2026-10-19-policy-audit-secret-redaction-design.md)

## Outcome

Keep policy credentials available to the hub while preventing new and historical `policy.change`
audit and replication records from retaining those values. Replica folds omit redacted credentials.
The history scrub preserves row identity and ordering. The one-time scrub must not run against
persistent team data until Nick confirms the exposed relay token has been rotated on the hub and
replicas.

## Increments

| Increment | Lane | Work | Acceptance |
| --- | --- | --- | --- |
| 1. Record the event and migration contract | `01M5AMGDSC9C5DH66B3MYE8QPQ` | Take the next free ADR number with `pnpm adr:next`, publish its stub before authoring the body, then decide the marker shape, hub/replica boundary, and portable SQLite/PostgreSQL scrub mechanics. Amend the rationale in ADRs 367 and 399 without changing their accepted decisions. | ADR documents event compatibility, marker semantics, row-preserving migration, and an observability/evaluation entry; `change-adr:check` accepts the record. |
| 2. Redact new events and replica projections | `01M5AMGDSC9C5DH66B3MYE8QPQ` | Keep the complete sparse policy in the hub's `teams.policy`; construct a redacted `policy.change` detail; make replica folding omit marker-bearing fields, including nested doorbell URLs. Update server behavior documentation. | New event details expose no configured credential or secret-bearing URL; hub integrations still use the local policy; replicas retain ordinary policy values but neither markers nor redacted fields. |
| 3. Scrub existing event history | `01M5AMGDSC9C5DH66B3MYE8QPQ` | Add a one-time migration for `audit.detail` and `sync_log.payload` on both supported database backends. Preserve IDs, row counts, sequence values, timestamps, event identity, and non-secret fields. Document the rotation precondition and operator procedure. | Migration behavior is covered for both migration paths and proves the preserved fields; execution against persistent team data occurs only after rotation is confirmed. |

## Boundaries

- No policy schema, authorization, sync protocol, ordering, or hub integration behavior changes.
- No credential value, host, length, or digest appears in a marker, fixture output, Act, or commit.
- Do not execute the history migration against persistent data until the rotation precondition is
  explicitly confirmed. Authoring and disposable-database validation do not satisfy that precondition.
- Protocol schema changes require a separate ADR and are not assumed by this plan.
