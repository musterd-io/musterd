/**
 * Spec §6: a build never serves a database migrated by a NEWER build. Under expand/contract the
 * old binary keeps running against the expanded schema (additive; fine) — but a database whose
 * `schema_version` is past what this build's ladder knows was contracted or reshaped by something
 * newer, and serving it would mean writing rows this build cannot reason about. Both engines
 * (`runMigrations`, `migratePostgres`) refuse with the same stable sentence.
 */
export const SCHEMA_NEWER_SENTENCE = 'schema newer than this build';

export function assertSchemaNotNewer(have: number, max: number): void {
  if (have > max)
    throw new Error(
      `${SCHEMA_NEWER_SENTENCE}: database is at schema ${have}, this build knows ${max}`,
    );
}

/**
 * Cloud (spec §6): migration is a separate step run before the rollout, never on boot. A server that
 * finds its database BEHIND its own ladder was deployed without that step; it refuses rather than
 * serve queries against columns that do not exist yet.
 */
export const SCHEMA_OLDER_SENTENCE = 'schema older than this build';

export function assertSchemaNotOlder(have: number, max: number): void {
  if (have < max)
    throw new Error(
      `${SCHEMA_OLDER_SENTENCE}: database is at schema ${have}, this build needs ${max} — run the migrate step (scripts/cloud/migrate.mjs) first`,
    );
}

/**
 * ADR 496: the version row is a claim, not evidence. A database can say v84 and lack a column v81
 * adds — musterd-1b did, migrated from a branch before the ladder's numbers were final — so after
 * the ladder the live catalog is compared with what baseline + ladder land on, and a table or
 * column that should be there and is not refuses the migrate step and the boot with this sentence.
 */
export const SCHEMA_DRIFT_SENTENCE = 'schema drift';
