#!/usr/bin/env node
import { readBuildStamp } from '@musterd/protocol/build-stamp';
import pg from 'pg';
import { resolveConsoleConfig } from './config.js';
import { assertSchema, type Queryable } from './db.js';
import { createConsoleServer } from './http.js';
import { kmsSigner, loadServiceAccount } from './kms.js';
import { makeLog } from './log.js';
import { migrate, SCHEMA_VERSION } from './schema.js';

/**
 * `musterd-console serve` — boot against the runtime role, refuse a foreign schema, listen.
 * `musterd-console migrate` — the separate pre-rollout step (spec §6), as the OWNER: reads
 *   MUSTERD_CONSOLE_DATABASE_OWNER_URL (the direct, unpooled host) and the runtime role's name
 *   from MUSTERD_CONSOLE_RUNTIME_ROLE. The server never reads the owner URL.
 * Prints versions and states — never a URL (hard rule 5).
 */
/**
 * The dist's own stamp (ADR 135), null when it has none. Inside the Fly image it is always null,
 * because the Docker build has no `.git`; resolveConsoleConfig then reads `FLY_IMAGE_REF`.
 */
function buildStamp(): string | null {
  return readBuildStamp(import.meta.url) ?? null;
}

async function serve(): Promise<void> {
  const log = makeLog();
  const config = resolveConsoleConfig(process.env, buildStamp());
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
  const db: Queryable = pool;
  await assertSchema(db, SCHEMA_VERSION);
  const signer = config.kms
    ? kmsSigner(
        { keyVersion: config.kms.keyVersion },
        { credentials: await loadServiceAccount(config.kms.credentialsFile) },
      )
    : undefined;
  // Fail closed: a configured key that cannot be read never starts serving an empty JWKS.
  if (signer) await signer.publicJwk();
  const server = createConsoleServer({ config, db, log, ...(signer ? { signer } : {}) });
  server.listen(config.port, config.host, () =>
    log.info('listening', { host: config.host, port: config.port, schema: SCHEMA_VERSION }),
  );
  const stop = () => server.close(() => void pool.end().then(() => process.exit(0)));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function runMigrate(): Promise<void> {
  const ownerUrl = process.env['MUSTERD_CONSOLE_DATABASE_OWNER_URL']?.trim();
  const role = process.env['MUSTERD_CONSOLE_RUNTIME_ROLE']?.trim();
  if (!ownerUrl) throw new Error('migrate needs MUSTERD_CONSOLE_DATABASE_OWNER_URL');
  if (!role) throw new Error('migrate needs MUSTERD_CONSOLE_RUNTIME_ROLE');
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const v = await migrate(client, role);
    process.stdout.write(`migrated: console store at schema ${v}\n`);
  } finally {
    await client.end();
  }
}

const cmd = process.argv[2] ?? 'serve';
const run = cmd === 'migrate' ? runMigrate : cmd === 'serve' ? serve : null;
if (!run) {
  process.stderr.write('usage: musterd-console serve | migrate\n');
  process.exit(2);
}
run().catch((e: unknown) => {
  process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
