/*
 * Demo stage setup — lane 01M3FCFQ8K, docs/demo.md §7 step 1. One command before the talk:
 *
 *   node scripts/demo/setup.ts --owner <gh-owner> --public-origin https://<tunnel-host>          # plan only
 *   node scripts/demo/setup.ts --owner <gh-owner> --public-origin https://<tunnel-host> --apply  # do it
 *
 * It creates a fresh public GitHub repo, connects Cloudflare Pages to it (production = main, a
 * preview per PR), creates the team with you as admin, sets agent_connect=any_member (ADR 456),
 * mints the room invite (ADR 450), seeds the repo with the planner skill and its harness bridges,
 * adds the planner agent in a worktree of the repo, and enrolls it on this machine's residency host.
 * It ends by printing the join URL, room code, /live, /board and Pages URLs.
 *
 * Preconditions (checked, and each failure names its fix):
 *   - the demo daemon is running on this laptop (docs/operations/public-demo-tunnel.md), `--server`;
 *   - `gh` is signed in as someone who can create repos under `--owner`;
 *   - CLOUDFLARE_API_TOKEN (Pages: Edit) and CLOUDFLARE_ACCOUNT_ID are set, and the Cloudflare Pages
 *     GitHub app is installed on `--owner` — else pass --skip-pages and connect it in the dashboard;
 *   - `musterd` on PATH (or `--musterd <bin>`), Node ≥22.
 *
 * Idempotent where it can be: an existing repo, Pages project, team binding or planner worktree is
 * reused, so a run interrupted half-way is resumed by running it again. The invite is the exception:
 * every --apply mints a fresh one (revoke the old with `musterd team invite revoke <id>`).
 *
 * The planner gets the skill, not the charter: a daemon-roster team has no role library, so the
 * `planner` role is a label and the playbook reaches it through the repo (#1759, docs/demo.md §7).
 * Waking agents that joiners create is lane 01M3FBKS39, not this script. Teardown: docs/demo.md §7.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  defaultRepoName,
  joinUrl,
  pagesProjectBody,
  pagesProjectName,
  pagesUrl,
  parseAgentDir,
  parseInvite,
  seedFiles,
  steps,
  surfaceUrls,
  type StageOptions,
} from './plan.ts';

const { values: a } = parseArgs({
  options: {
    team: { type: 'string', default: 'demo' },
    owner: { type: 'string' },
    repo: { type: 'string' },
    presenter: { type: 'string', default: process.env['USER'] ?? 'presenter' },
    planner: { type: 'string', default: 'planner' },
    server: { type: 'string', default: 'http://127.0.0.1:4851' },
    'public-origin': { type: 'string' },
    harness: { type: 'string', default: 'claude-code' },
    expires: { type: 'string', default: '3h' },
    'member-until': { type: 'string', default: '12h' },
    musterd: { type: 'string', default: 'musterd' },
    'skip-pages': { type: 'boolean', default: false },
    apply: { type: 'boolean', default: false },
  },
});

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!a.owner) die('--owner <github user or org> is required');
if (!a['public-origin'])
  die(
    '--public-origin https://<tunnel hostname> is required (docs/operations/public-demo-tunnel.md)',
  );

const o: StageOptions = {
  team: a.team,
  owner: a.owner,
  repo: a.repo ?? defaultRepoName(new Date()),
  presenter: a.presenter,
  planner: a.planner,
  server: a.server,
  publicOrigin: a['public-origin'],
  harness: a.harness,
  invite: { expires: a.expires, memberUntil: a['member-until'] },
  apply: a.apply,
};
const skipPages = a['skip-pages'];
const project = pagesProjectName(o.repo);
// Layout v2 (ADR 447): ~/musterd/<team>/<repo>/<member>. `musterd agent` derives the planner's
// worktree as a sibling of this checkout from the same rule.
const checkout = join(homedir(), 'musterd', o.team, o.repo, o.presenter);
const plannerDir = join(homedir(), 'musterd', o.team, o.repo, o.planner);
const skillSrc = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.agents/skills/planner/SKILL.md',
);

console.log(
  `${o.apply ? 'Setting up' : 'Plan for'} the demo stage — team "${o.team}", repo ${o.owner}/${o.repo}`,
);
console.log(`  checkout: ${checkout}`);
for (const [i, s] of steps(o).entries())
  console.log(
    `  ${i + 1}. ${s.what}${s.id === 'pages' && skipPages ? '  (skipped: --skip-pages)' : ''}`,
  );
if (!o.apply) {
  console.log('\nNothing written. Re-run with --apply to do it.');
  process.exit(0);
}

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  if (r.error) die(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0)
    die(`${cmd} ${args.join(' ')} exited ${r.status}\n${String(r.stderr).trim()}`);
  return String(r.stdout);
}
const ok = (cmd: string, args: string[], opts: SpawnSyncOptions = {}): boolean =>
  spawnSync(cmd, args, { stdio: 'ignore', ...opts }).status === 0;
// Every musterd call runs from the presenter checkout (its binding is who acts, ADR 442) against the
// demo daemon, never whatever this shell's default team is.
const musterd = (args: string[], cwd = checkout): string =>
  run(a.musterd, args, { cwd, env: { ...process.env, MUSTERD_SERVER: o.server } });
const done = (msg: string): void => console.log(`✓ ${msg}`);

// Preflight — fail before creating anything public.
if (Number(process.versions.node.split('.')[0]) < 22) die('Node ≥22 required');
if (!ok('gh', ['auth', 'status'])) die('gh is not signed in — run `gh auth login`');
if (!ok(a.musterd, ['--version']))
  die(`${a.musterd} not found — put musterd on PATH or pass --musterd`);
const health = await fetch(`${o.server.replace(/\/+$/, '')}/health`).catch(() => null);
if (!health?.ok)
  die(`no daemon answering at ${o.server} — start it per docs/operations/public-demo-tunnel.md`);
const cfToken = process.env['CLOUDFLARE_API_TOKEN'];
const cfAccount = process.env['CLOUDFLARE_ACCOUNT_ID'];
if (!skipPages && (!cfToken || !cfAccount))
  die('set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or pass --skip-pages');

// 1. Repo.
const full = `${o.owner}/${o.repo}`;
if (ok('gh', ['repo', 'view', full])) done(`repo ${full} exists`);
else {
  run('gh', ['repo', 'create', full, '--public', '--description', 'Built live by a musterd team']);
  done(`created https://github.com/${full}`);
}
if (!existsSync(join(checkout, '.git'))) {
  mkdirSync(dirname(checkout), { recursive: true });
  run('gh', ['repo', 'clone', full, checkout]);
}

// 2. Seed. Files already present are left alone, so a re-run never clobbers the team's work.
const files = seedFiles({ repo: o.repo, team: o.team, skillMd: readFileSync(skillSrc, 'utf8') });
let wrote = 0;
for (const [rel, body] of Object.entries(files)) {
  const p = join(checkout, rel);
  if (existsSync(p)) continue;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  wrote++;
}
if (wrote > 0) {
  run('git', ['add', '-A'], { cwd: checkout });
  run('git', ['commit', '-m', 'Seed the demo stage: page, AGENTS.md, planner skill and bridges'], {
    cwd: checkout,
  });
  run('git', ['branch', '-M', 'main'], { cwd: checkout });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: checkout });
  done(`seeded ${wrote} files and pushed main`);
} else done('seed already present');

// 3. Pages.
if (!skipPages) {
  const api = `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/pages/projects`;
  const headers = { authorization: `Bearer ${cfToken}`, 'content-type': 'application/json' };
  const existing = await fetch(`${api}/${project}`, { headers });
  if (existing.ok) done(`Pages project ${project} exists`);
  else {
    const res = await fetch(api, {
      method: 'POST',
      headers,
      body: JSON.stringify(pagesProjectBody(project, o.owner, o.repo)),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { errors?: { message?: string }[] };
      die(
        `Cloudflare refused the Pages project (${res.status}): ${body.errors?.map((e) => e.message).join('; ') ?? 'no detail'}\n` +
          `  If it names GitHub: install the Cloudflare Pages GitHub app on ${o.owner}, or re-run with --skip-pages and\n` +
          `  connect ${full} in the dashboard (Workers & Pages → Create → Pages → Connect to Git; production branch main).`,
      );
    }
    done(`Pages project ${project} connected to ${full}`);
    // The seed commit landed before the project existed; an empty commit gives Pages its first build.
    run('git', ['commit', '--allow-empty', '-m', 'Trigger the first Pages deploy'], {
      cwd: checkout,
    });
    run('git', ['push'], { cwd: checkout });
  }
}

// 4. Team, with the presenter as admin. The binding it writes into the checkout is gitignored.
const bindingPath = join(checkout, '.musterd', 'binding.json');
const bound = existsSync(bindingPath)
  ? (JSON.parse(readFileSync(bindingPath, 'utf8')) as { team?: string }).team
  : undefined;
if (bound === o.team) done(`team ${o.team} already bound here`);
else {
  musterd(['team', 'create', o.team, '--member', o.presenter, '--server', o.server, '--json']);
  done(`team ${o.team} created, ${o.presenter} is admin`);
}

// 5. Policy — any attendee may start any member-created agent (ADR 456 §2). The member expiry on the
// invite below is what bounds that power; never drop --member-until on this team.
musterd(['team', 'policy', '--agent-connect', 'any_member']);
done('agent_connect = any_member');

// 6. Invite.
const invite = parseInvite(
  musterd([
    'team',
    'invite',
    'create',
    '--expires',
    o.invite.expires,
    '--member-until',
    o.invite.memberUntil,
    '--json',
  ]),
);
done(`invite ${invite.id} minted`);

// 7. Planner.
let dir = plannerDir;
if (existsSync(plannerDir)) done(`planner worktree exists at ${plannerDir}`);
else {
  dir = parseAgentDir(
    musterd(['agent', o.planner, '--role', 'planner', '--harness', o.harness, '--json']),
  );
  done(`agent ${o.planner} added at ${dir}`);
}

// 8. Residency.
musterd([
  'residency',
  'on',
  '--seat',
  o.planner,
  '--workspace',
  dir,
  '--harness',
  o.harness,
  '--json',
]);
done(`${o.planner} enrolled on this machine's residency host`);

const urls = surfaceUrls(o.server, o.team);
console.log(`
Stage ready.

  Room code   ${invite.roomCode}          (keep off the projector until the join slide)
  Join URL    ${joinUrl(o.publicOrigin, o.team, invite.linkSecret)}
  /live       ${urls.live}
  /board      ${urls.board}
  Pages       ${skipPages ? '(connect in the dashboard — --skip-pages)' : pagesUrl(project)}
  Repo        https://github.com/${full}
  Invite id   ${invite.id}              (musterd team invite revoke ${invite.id} if the code leaks)

Next: make sure the residency host is running — \`musterd host\` in a spare terminal, or
\`musterd service install --wake\` once — so ${o.planner} wakes when the room pitches.`);
