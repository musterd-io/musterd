#!/usr/bin/env node
/**
 * Provision the Cloud database (cloud increment 1D, lane 01M3Z42764) and hand its credentials to
 * Fly without a human or an agent ever seeing them (hard rule 5). Run by a human, once, with their
 * own Neon API key; rerunning it rotates the two login passwords and re-stages the secrets.
 *
 *   node scripts/cloud/provision-neon.mjs   (key: NEON_API_KEY, or
 *   ~/.musterd/cloud/neon-api.key mode 600 — never typed on a command line)
 *
 * What it does, in order:
 *   1. Finds or creates the Neon project (default `musterd-staging`, aws-us-east-1, Postgres 17).
 *   2. Ensures the `musterd` and `musterd_trace` databases, as the project's owner login.
 *   3. Creates the three NOLOGIN roles of `db/pg/tenancy.ts` if the ladder has not yet, and two
 *      login users made in SQL — `musterd_app_login` IN ROLE musterd_app, `musterd_operator_login`
 *      IN ROLE musterd_operator — with fresh random passwords. Made in SQL, not the Neon API, so they
 *      are not members of `neon_superuser`: an injection in the app cannot `SET ROLE` its way out
 *      of row-level security.
 *   4. Pipes the app/operator URLs (pooled host) into `fly secrets import --stage` for the serving
 *      app, and the owner URLs (direct host) into the separate migrate app. The serving app never
 *      holds a credential that can change the schema (spec §12.1, "the app role owns nothing").
 *
 * Prints names, counts and ids — never a URL or a password.
 *
 * Env: NEON_PROJECT (musterd-staging), NEON_REGION (aws-us-east-1), FLY_APP (musterd-cloud),
 * FLY_MIGRATE_APP (musterd-cloud-migrate).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const pg = createRequire(new URL('../../packages/server/package.json', import.meta.url))('pg');

const PROJECT = process.env.NEON_PROJECT ?? 'musterd-staging';
const REGION = process.env.NEON_REGION ?? 'aws-us-east-1';
const FLY_APP = process.env.FLY_APP ?? 'musterd-cloud';
const FLY_MIGRATE_APP = process.env.FLY_MIGRATE_APP ?? 'musterd-cloud-migrate';
const DBS = { main: 'musterd', trace: 'musterd_trace' };
const LOGINS = { app: 'musterd_app_login', operator: 'musterd_operator_login' };

function apiKey() {
  if (process.env.NEON_API_KEY) return process.env.NEON_API_KEY.trim();
  const path = join(homedir(), '.musterd', 'cloud', 'neon-api.key');
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is mode ${mode.toString(8)}; chmod 600 it`);
  return readFileSync(path, 'utf8').trim();
}

const KEY = apiKey();
async function neon(method, path, body) {
  const res = await fetch(`https://console.neon.tech/api/v2${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  // Neon's error bodies carry a code and a message, never a credential.
  if (!res.ok)
    throw new Error(`Neon ${method} ${path} → ${res.status} ${json.message ?? ''}`.trim());
  return json;
}

async function findOrCreateProject() {
  const { projects } = await neon('GET', `/projects?search=${encodeURIComponent(PROJECT)}`);
  const found = projects.find((p) => p.name === PROJECT);
  if (found) return { id: found.id, created: false };
  const made = await neon('POST', '/projects', {
    project: { name: PROJECT, region_id: REGION, pg_version: 17 },
  });
  return { id: made.project.id, created: true };
}

/** The owner login and the project's direct + pooled hosts, read back from Neon. */
async function ownerAndHosts(projectId) {
  const { branches } = await neon('GET', `/projects/${projectId}/branches`);
  const branch = branches.find((b) => b.default) ?? branches[0];
  const { databases } = await neon('GET', `/projects/${projectId}/branches/${branch.id}/databases`);
  const ownerRole = databases[0].owner_name;
  const { password } = await neon(
    'GET',
    `/projects/${projectId}/branches/${branch.id}/roles/${encodeURIComponent(ownerRole)}/reveal_password`,
  );
  const { endpoints } = await neon('GET', `/projects/${projectId}/endpoints`);
  const rw = endpoints.find((e) => e.type === 'read_write') ?? endpoints[0];
  const direct = rw.host;
  const pooled = direct.replace(/^([^.]+)/, '$1-pooler');
  return { ownerRole, ownerPassword: password, seedDb: databases[0].name, direct, pooled };
}

const url = (user, password, host, db) =>
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/${db}?sslmode=require`;

async function withClient(connectionString, fn) {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function ensureDatabases(ownerUrl) {
  return withClient(ownerUrl, async (c) => {
    const made = [];
    for (const name of Object.values(DBS)) {
      const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      // CREATE DATABASE cannot take a bind parameter; the names are the constants above.
      if (r.rowCount === 0) {
        await c.query(`CREATE DATABASE "${name}"`);
        made.push(name);
      }
    }
    return made;
  });
}

/** Group roles (as the ladder declares them) + the two login users. Returns fresh passwords. */
async function ensureRoles(ownerUrl) {
  const pw = {
    app: randomBytes(24).toString('base64url'),
    operator: randomBytes(24).toString('base64url'),
  };
  const verbs = await withClient(ownerUrl, async (c) => {
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_owner') THEN CREATE ROLE musterd_owner NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_app') THEN CREATE ROLE musterd_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'musterd_operator') THEN CREATE ROLE musterd_operator NOLOGIN BYPASSRLS; END IF;
    END $$;`);
    const out = {};
    for (const [kind, login] of Object.entries(LOGINS)) {
      const exists =
        (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login])).rowCount > 0;
      // base64url passwords hold only [A-Za-z0-9_-], so the literal cannot break out of its quotes.
      if (exists) await c.query(`ALTER ROLE ${login} WITH LOGIN PASSWORD '${pw[kind]}'`);
      else
        await c.query(`CREATE ROLE ${login} LOGIN PASSWORD '${pw[kind]}' IN ROLE musterd_${kind}`);
      out[login] = exists ? 'password rotated' : 'created';
    }
    return out;
  });
  return { pw, verbs };
}

function stageFlySecrets(app, secrets) {
  const input = Object.entries(secrets)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const r = spawnSync('fly', ['secrets', 'import', '--app', app, '--stage'], {
    input,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`fly secrets import --app ${app} failed (exit ${r.status})`);
  return Object.keys(secrets);
}

try {
  const project = await findOrCreateProject();
  console.log(
    `neon project ${PROJECT} (${project.id}) ${project.created ? 'created' : 'found'} in ${REGION}`,
  );
  const h = await ownerAndHosts(project.id);
  const ownerSeed = url(h.ownerRole, h.ownerPassword, h.direct, h.seedDb);
  const made = await ensureDatabases(ownerSeed);
  console.log(
    `databases ${Object.values(DBS).join(', ')}: ${made.length ? `created ${made.join(', ')}` : 'present'}`,
  );
  const { pw, verbs } = await ensureRoles(ownerSeed);
  for (const [login, verb] of Object.entries(verbs)) console.log(`role ${login}: ${verb}`);

  const served = stageFlySecrets(FLY_APP, {
    MUSTERD_DATABASE_APP_URL: url(LOGINS.app, pw.app, h.pooled, DBS.main),
    MUSTERD_DATABASE_OPERATOR_URL: url(LOGINS.operator, pw.operator, h.pooled, DBS.main),
    MUSTERD_TRACE_DATABASE_APP_URL: url(LOGINS.app, pw.app, h.pooled, DBS.trace),
    MUSTERD_TRACE_DATABASE_OPERATOR_URL: url(LOGINS.operator, pw.operator, h.pooled, DBS.trace),
  });
  console.log(`staged on ${FLY_APP}: ${served.join(', ')}`);
  const owner = stageFlySecrets(FLY_MIGRATE_APP, {
    MUSTERD_DATABASE_OWNER_URL: url(h.ownerRole, h.ownerPassword, h.direct, DBS.main),
    MUSTERD_TRACE_DATABASE_OWNER_URL: url(h.ownerRole, h.ownerPassword, h.direct, DBS.trace),
  });
  console.log(`staged on ${FLY_MIGRATE_APP}: ${owner.join(', ')}`);
  console.log(
    'done. Next: the deploy runs the migrate step before the rollout (docs/guides/cloud-ops.md).',
  );
} catch (e) {
  console.error(`provision failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  process.exit(1);
}
