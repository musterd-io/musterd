// Plan 1A Task 23: what did the async Driver cost the hook path? Runs the PreToolUse gate's own
// store calls against two builds of @musterd/server on the same seed — BEFORE (a dist built from
// main before Task 1: synchronous store functions on a raw better-sqlite3 handle) and AFTER (this
// checkout's dist: the same functions through the async Driver) — each in its own process, and
// prints one markdown table of p50 / p95 / p99 per call. The bar (plan Task 23): after ≤ 1.2× before
// at p95 on every query.
//
//   node scripts/perf/async-store-overhead.mjs <before-dist> <after-dist> [rounds=300]
//   e.g. node scripts/perf/async-store-overhead.mjs ~/.musterd/runtime/packages/server/dist packages/server/dist
//
// The seed is built through each build's own store functions (team, 50 members, 400 lanes, 5,000
// messages, 20,000 audit rows), file-backed in $TMPDIR with WAL, ANALYZE'd, one warm-up round.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEED = { members: 50, lanes: 400, messages: 5_000, audit: 20_000 };

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99) };
}

async function benchOne({ dist, rounds, dir }) {
  const mod = async (p) => import(pathToFileURL(join(dist, p)).href);
  const { openDb } = await mod('db/open.js');
  const { createTeam, getPolicy } = await mod('store/teams.js');
  const { addMember, getMemberByName } = await mod('store/members.js');
  const { openLane, laneCoveringPath } = await mod('store/lanes.js');
  const { insertMessage, countUnread } = await mod('store/messages.js');
  const { appendAudit } = await mod('store/audit.js');
  const { findGateAsk } = await mod('store/gateAsk.js');
  const { makeEnvelope } = await import('@musterd/protocol');

  const raw = openDb(join(dir, 'bench.db'));
  raw.pragma('journal_mode = WAL');
  // AFTER exposes sqliteDriver; BEFORE has no such module and takes the raw handle.
  let db = raw;
  let flavour = 'sync store on raw handle';
  try {
    const { sqliteDriver } = await mod('db/sqliteDriver.js');
    db = sqliteDriver(raw);
    flavour = 'async store through the Driver';
  } catch {
    /* before Task 1 */
  }

  const team = await createTeam(db, { slug: 'bench' });
  const members = [];
  for (let i = 0; i < SEED.members; i++) {
    const { row } = await addMember(db, team, { name: `seat-${i}`, kind: i ? 'agent' : 'human' });
    members.push(row);
  }
  for (let i = 0; i < SEED.lanes; i++) {
    await openLane(db, team.id, team.slug, members[i % SEED.members].name, {
      title: `lane ${i}`,
      scope: [`src/${i % 40}/**`],
      claim: i % 3 === 0,
    });
  }
  const t0 = Date.now() - 86_400_000;
  for (let i = 0; i < SEED.messages; i++) {
    const from = members[i % SEED.members];
    const to = members[(i * 7) % SEED.members];
    await insertMessage(
      db,
      team.id,
      from.id,
      to.id,
      makeEnvelope({
        id: `m${String(i).padStart(8, '0')}`,
        team: team.slug,
        from: from.name,
        to: { kind: 'member', name: to.name },
        act: 'message',
        body: `hello ${i}`,
        thread: null,
        meta: null,
        ts: t0 + i * 10,
      }),
      { now: t0 + i * 10 },
    );
  }
  for (let i = 0; i < SEED.audit; i++) {
    await appendAudit(db, team.id, {
      actor: members[i % SEED.members].name,
      action: i % 5 ? 'lane.state_changed' : 'action.gate',
      target: `t${i % 500}`,
      result: 'allow',
      detail: { class: i % 5 ? undefined : 'deploy', i },
    });
  }
  raw.exec('ANALYZE');

  const seat7 = members[7];
  const cursorTs = t0 + (SEED.messages / 2) * 10;
  const queries = {
    getPolicy: () => getPolicy(db, team.id),
    laneCoveringPath: () => laneCoveringPath(db, team.id, team.slug, 'src/7/index.ts'),
    getMemberByName: () => getMemberByName(db, team.id, 'seat-7'),
    countUnread: () => countUnread(db, seat7, cursorTs),
    findGateAsk: () => findGateAsk(db, team.id, 'fp-deploy'),
    appendAudit: () =>
      appendAudit(db, team.id, {
        actor: 'seat-7',
        action: 'action.gate',
        target: 'bench',
        result: 'allow',
        detail: { class: 'deploy' },
      }),
  };
  const out = {};
  for (const [name, fn] of Object.entries(queries)) {
    await fn(); // warm-up
    const samples = [];
    for (let r = 0; r < rounds; r++) {
      const a = performance.now();
      await fn();
      samples.push(performance.now() - a);
    }
    out[name] = summarize(samples);
  }
  raw.close();
  return { flavour, queries: out };
}

if (process.env.ASYNC_STORE_BENCH_ONE) {
  const opts = JSON.parse(process.env.ASYNC_STORE_BENCH_ONE);
  const r = await benchOne(opts);
  process.stdout.write(JSON.stringify(r));
} else {
  const [beforeDist, afterDist, roundsArg] = process.argv.slice(2);
  if (!beforeDist || !afterDist) {
    console.error('usage: async-store-overhead.mjs <before-dist> <after-dist> [rounds]');
    process.exit(2);
  }
  const rounds = Number(roundsArg ?? 300);
  const reports = [];
  for (const [label, dist] of [
    ['before', beforeDist],
    ['after', afterDist],
  ]) {
    const dir = join(process.env.TMPDIR ?? '/tmp', `async-store-${label}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const child = spawnSync(process.execPath, [process.argv[1]], {
      env: {
        ...process.env,
        ASYNC_STORE_BENCH_ONE: JSON.stringify({ dist: resolve(dist), rounds, dir }),
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    rmSync(dir, { recursive: true, force: true });
    if (child.status !== 0) {
      console.error(child.stderr);
      process.exit(child.status ?? 1);
    }
    reports.push({ label, dist, ...JSON.parse(child.stdout) });
  }
  const [b, a] = reports;
  const f = (x) => x.toFixed(3);
  console.log(
    `Seed: ${SEED.members} members · ${SEED.lanes} lanes · ${SEED.messages} messages · ${SEED.audit} audit rows; ${rounds} rounds after one warm-up; ANALYZE after seed; file-backed WAL; each build in its own process.`,
  );
  console.log(`before = ${b.dist} (${b.flavour}); after = ${a.dist} (${a.flavour})`);
  console.log('');
  console.log(
    '| call | before p50 / p95 / p99 (ms) | after p50 / p95 / p99 (ms) | after ÷ before (p95) |',
  );
  console.log('| --- | --- | --- | --- |');
  let worst = 0;
  for (const q of Object.keys(b.queries)) {
    const x = b.queries[q];
    const y = a.queries[q];
    const ratio = y.p95 / x.p95;
    worst = Math.max(worst, ratio);
    console.log(
      `| \`${q}\` | ${f(x.p50)} / ${f(x.p95)} / ${f(x.p99)} | ${f(y.p50)} / ${f(y.p95)} / ${f(y.p99)} | ${ratio.toFixed(2)}× |`,
    );
  }
  console.log('');
  console.log(
    `worst p95 ratio: ${worst.toFixed(2)}× (bar: ≤ 1.20×) — ${worst <= 1.2 ? 'PASS' : 'FAIL'}`,
  );
}
