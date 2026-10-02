#!/usr/bin/env node
/**
 * Deploy musterd Cloud (cloud increment 1D, lane 01M3Z43NHT; spec §6). One sequence, one image:
 *
 *   1. build    `fly deploy --build-only --push` on Fly's remote builder, tagged with the commit;
 *   2. migrate  run that image once in the MIGRATE app, which alone holds the owner URLs:
 *               `node scripts/cloud/migrate.mjs`, then read its exit code. A failed migrate stops here,
 *               and nothing new is serving;
 *   3. roll     `fly deploy --image` on the serving app: blue-green on ONE machine (nick, 2026-10-02;
 *               lane 01M3Z4EMH3), the new machine gated on `/health` before the old one retires. A server refuses to boot on a schema that is not exactly
 *               its own, so step 2 must succeed first.
 *   4. check    `GET https://<probe>.musterd.dev/health` through Cloudflare.
 *
 *   node scripts/cloud/deploy.mjs            (from a clean checkout of the commit to ship)
 *
 * Env: FLY_APP (musterd-cloud), FLY_MIGRATE_APP (musterd-cloud-migrate), CLOUD_PROBE_HOST
 * (health.musterd.dev). Prints Fly's own progress and the migrate log — never a URL or secret.
 */
import { spawnSync } from 'node:child_process';

const APP = process.env.FLY_APP ?? 'musterd-cloud';
const MIGRATE_APP = process.env.FLY_MIGRATE_APP ?? 'musterd-cloud-migrate';
const PROBE = process.env.CLOUD_PROBE_HOST ?? 'health.musterd.dev';
const CONFIG = 'deploy/cloud/fly.toml';

function run(cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.status !== 0) {
    const tail = capture
      ? `\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-5).join('\n')}`
      : '';
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} … exited ${r.status}${tail}`);
  }
  return capture ? r.stdout : '';
}

function step(n, what) {
  console.log(`\n── ${n}. ${what}`);
}

/**
 * Create the one-shot migrate machine through the Machines API. `fly machine run` cannot be used:
 * flyctl looks an image up inside the app it runs in, and the image lives in the SERVING app's
 * repository (2026-10-02, first deploy: `Could not find image`). The API takes any image ref the
 * org can pull. The Fly token is read in-process and never printed.
 */
async function createMigrateMachine(image) {
  const token = run('fly', ['auth', 'token'], { capture: true }).trim();
  const res = await fetch(`https://api.machines.dev/v1/apps/${MIGRATE_APP}/machines`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      region: 'iad',
      config: {
        image,
        init: { cmd: ['node', 'scripts/cloud/migrate.mjs'] },
        restart: { policy: 'no' },
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
        metadata: { purpose: 'migrate' },
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) {
    throw new Error(`creating the migrate machine → ${res.status} ${body.error ?? ''}`.trim());
  }
  return body.id;
}

/** The exit code a stopped one-shot machine reported, from its event log. */
function exitCodeOf(machineId) {
  const machines = JSON.parse(
    run('fly', ['machines', 'list', '--app', MIGRATE_APP, '--json'], { capture: true }),
  );
  const m = machines.find((x) => x.id === machineId);
  for (const ev of m?.events ?? []) {
    const code = ev?.request?.exit_event?.exit_code;
    if (typeof code === 'number') return code;
  }
  return null;
}

try {
  const sha = run('git', ['rev-parse', '--short=12', 'HEAD'], { capture: true }).trim();
  if (run('git', ['status', '--porcelain'], { capture: true }).trim() !== '') {
    throw new Error('the working tree is dirty; deploy a commit, not uncommitted edits');
  }
  const label = `git-${sha}`;
  const image = `registry.fly.io/${APP}:${label}`;

  step(1, `build ${image} (remote builder)`);
  run('fly', [
    'deploy',
    '--config',
    CONFIG,
    '--app',
    APP,
    '--remote-only',
    '--build-only',
    '--push',
    '--image-label',
    label,
  ]);

  step(2, `migrate in ${MIGRATE_APP}`);
  const id = await createMigrateMachine(image);
  console.log(`migrate machine ${id}`);
  try {
    run('fly', [
      'machine',
      'wait',
      id,
      '--app',
      MIGRATE_APP,
      '--state',
      'stopped',
      '--wait-timeout',
      '10m',
    ]);
    run('fly', ['logs', '--app', MIGRATE_APP, '--machine', id, '--no-tail']);
    const code = exitCodeOf(id);
    if (code !== 0)
      throw new Error(`migrate exited ${code ?? 'with no recorded code'}; nothing was rolled`);
  } finally {
    run('fly', ['machine', 'destroy', id, '--app', MIGRATE_APP, '--force'], { capture: true });
  }

  step(3, `roll ${APP} onto ${label}`);
  run('fly', [
    'deploy',
    '--config',
    CONFIG,
    '--app',
    APP,
    '--image',
    image,
    '--strategy',
    'bluegreen',
    '--ha=false',
    '--wait-timeout',
    '5m',
  ]);

  step(4, `check https://${PROBE}/health`);
  const res = await fetch(`https://${PROBE}/health`);
  const body = await res.text();
  console.log(`${res.status} ${body.trim()}`);
  if (res.status !== 200) process.exit(1);
} catch (e) {
  console.error(`deploy failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
