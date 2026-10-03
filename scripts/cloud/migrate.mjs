#!/usr/bin/env node
/**
 * The cloud migrate step (spec 2026-09-29 §6; cloud increment 1C): bring both Cloud databases to
 * this build's schema, as the OWNER, BEFORE a rollout. A cloud server never migrates on boot — it
 * refuses to start against a schema that is not exactly its own (`schema older than this build` /
 * `schema newer than this build`), and this is the step that makes it so.
 *
 *   MUSTERD_DATABASE_OWNER_URL=… MUSTERD_TRACE_DATABASE_OWNER_URL=… node scripts/cloud/migrate.mjs
 *   node --env-file=<a chmod-600 file> scripts/cloud/migrate.mjs
 *
 * Use the DIRECT (unpooled) host: DDL through a transaction-mode pooler is not safe. Prints the
 * versions it reached — never a URL (hard rule 5). Runs from a built tree (`pnpm -r build`).
 *
 * After the ladder the live catalog is verified against what it lands (ADR 496): a table or column
 * the version row claims and the database lacks fails this step with `schema drift: missing …`.
 * MUSTERD_MIGRATE_REPAIR=1 replays the ladder (every entry is idempotent) and prints what came
 * back; extras the ladder does not know are printed and left alone.
 */
import { migrateCloud } from '../../packages/server/dist/cloud/migrate.js';

try {
  const v = await migrateCloud(process.env, { report: (line) => console.log(line) });
  console.log(`migrated: coordination store at schema ${v.main}, trace store at schema ${v.trace}`);
} catch (e) {
  console.error(`migrate failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  process.exit(1);
}
