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

const REGISTRY = 'https://registry.fly.io/v2';
const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Wait until the registry serves the tag `fly deploy --build-only --push` just pushed. The push lands
 * after flyctl returns (2026-10-02: the tag 404'd right after the build and answered 200 minutes
 * later), and a machine created before it lands cannot pull its image.
 */
async function waitForTag(token, repo, tag) {
  const headers = {
    authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`,
    accept: MANIFEST_TYPES,
  };
  for (let waited = 0; waited <= 300; waited += 5) {
    const res = await fetch(`${REGISTRY}/${repo}/manifests/${tag}`, { method: 'HEAD', headers });
    if (res.ok) return waited;
    if (res.status !== 404) throw new Error(`registry answered ${res.status} for ${repo}:${tag}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${repo}:${tag} never appeared in the registry (waited 300 s)`);
}

/**
 * Create the one-shot migrate machine through the Machines API, on the SERVING app's image: a
 * machine in one app pulls another app's image in the same org (verified 2026-10-02), so migrate
 * and serve run one digest. flyctl's `fly machine run` looks the image up inside the migrate app
 * and refuses it, so the API is called directly. The Fly token never leaves this process.
 */
async function createMigrateMachine(token, image) {
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

/**
 * The exit code a stopped one-shot machine reported, from its `exit` event. Fly omits a zero
 * `exit_code` (verified 2026-10-02: exit 3 carries `exit_code: 3`, exit 0 carries none), so an exit
 * event without one is a clean exit. No exit event at all is null — the machine never ran.
 */
function exitCodeOf(machineId) {
  const machines = JSON.parse(
    run('fly', ['machines', 'list', '--app', MIGRATE_APP, '--json'], { capture: true }),
  );
  const m = machines.find((x) => x.id === machineId);
  const exit = (m?.events ?? []).find((ev) => ev?.type === 'exit');
  if (!exit) return null;
  return exit.request?.exit_event?.exit_code ?? 0;
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
  const token = run('fly', ['auth', 'token'], { capture: true }).trim();
  const waited = await waitForTag(token, APP, label);
  if (waited) console.log(`image appeared in the registry after ${waited} s`);
  const id = await createMigrateMachine(token, image);
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
