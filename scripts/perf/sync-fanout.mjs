#!/usr/bin/env node
/**
 * Cross-machine sync, measured end to end (goal realtime-sync, lane 01M4V9D2NE) — and the hub's
 * cost per event at 1 and 3 joiners, which ADR 552 §Consequences owes and its reopen condition
 * ("the per-joiner page read dominating hub load") is judged on.
 *
 * One real hub daemon and N real joiner daemons, each its OWN OS PROCESS with its own database and
 * node.json, talking over loopback HTTP + WebSocket with every 60 s tick left enabled. Separate
 * processes are the point: the hub's CPU is then `process.cpuUsage()` of that one process, not a
 * share of a test runner's.
 *
 * Measured (each repeated --rounds times after --warmup untimed rounds):
 *   joiner->hub   POST on joiner 1 -> `deliver` frame on a seat connected to the hub
 *   hub->joiner   POST on the hub  -> `deliver` frame on a seat on EACH joiner (median, and the
 *                 slowest joiner of the round: the spread a fan-out adds)
 *   presence      a seat claims on joiner 1 -> the hub's roster shows it live
 *   hub cost      --events hub sends, spaced --gap-ms apart: hub CPU per event (burst minus an idle
 *                 window of the same length), and the hub's `/sync/pull` request count and total
 *                 handler ms, read from its own `http_request` log lines
 *
 * Usage (build first: pnpm -r build):
 *   node scripts/perf/sync-fanout.mjs [--joiners 1,3] [--rounds 10] [--warmup 3]
 *                                     [--events 40] [--gap-ms 250] [--history 0] [--json out.json]
 *
 * `--history K` first puts K messages on the hub, so a pull reads a hub with a past rather than an
 * empty fixture (the 2026-10-12 saturation was a hub with a long one). Joiners catch up before timing.
 *
 * Results land in ADR 552 §Consequences; this script is how they are reproduced.
 */
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SERVER = pathToFileURL(
  new URL('../../packages/server/dist/index.js', import.meta.url).pathname,
).href;
const PROTOCOL = pathToFileURL(
  new URL('../../packages/protocol/dist/index.js', import.meta.url).pathname,
).href;

// ---------------------------------------------------------------------------------------- child
if (process.argv[2] === '--child') {
  const { createServer } = await import(SERVER);
  const server = createServer({ port: 0 });
  const { port } = await server.listen();
  process.on('message', async (m) => {
    if (m.type === 'cpu') process.send({ type: 'cpu', id: m.id, ...process.cpuUsage() });
    if (m.type === 'stop') {
      await server.close();
      process.exit(0);
    }
  });
  process.send({ type: 'ready', port });
} else {
  await main();
}

// -------------------------------------------------------------------------------------- parent
async function main() {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const joinerCounts = arg('joiners', '1,3').split(',').map(Number);
  const rounds = Number(arg('rounds', 10));
  const warmup = Number(arg('warmup', 3));
  const events = Number(arg('events', 40));
  const gapMs = Number(arg('gap-ms', 250));
  const history = Number(arg('history', 0));
  const jsonOut = arg('json', null);

  const { makeEnvelope, PROTOCOL_VERSION } = await import(PROTOCOL);
  const WebSocket = createRequire(new URL('../../packages/server/package.json', import.meta.url))(
    'ws',
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const until = async (pred, ms) => {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await sleep(10);
    return pred();
  };

  async function post(base, path, body, auth) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  }

  /** One daemon in its own process, its own state, its stdout+stderr parsed into `logs`. */
  async function daemon(root, name) {
    const dir = join(root, name);
    const child = fork(SELF, ['--child'], {
      silent: true,
      env: {
        ...process.env,
        HOME: dir,
        MUSTERD_DB: join(dir, 'musterd.db'),
        MUSTERD_NODE_STATE: join(dir, 'node.json'),
        MUSTERD_CONFIG: join(dir, 'config.json'),
        MUSTERD_SILENT: '',
      },
      cwd: dir,
    });
    const logs = [];
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          try {
            logs.push({ at: Date.now(), ...JSON.parse(l) });
          } catch {
            /* not a log line */
          }
        }
      });
    }
    const port = await new Promise((resolve, reject) => {
      child.once('exit', (c) => reject(new Error(`${name} exited ${c}`)));
      child.on('message', (m) => m.type === 'ready' && resolve(m.port));
    });
    let n = 0;
    const cpu = () =>
      new Promise((resolve) => {
        const id = ++n;
        const on = (m) => {
          if (m.type === 'cpu' && m.id === id) {
            child.off('message', on);
            resolve((m.user + m.system) / 1000); // µs -> ms
          }
        };
        child.on('message', on);
        child.send({ type: 'cpu', id });
      });
    const stop = () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.send({ type: 'stop' });
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      });
    return { name, base: `http://127.0.0.1:${port}`, logs, cpu, stop };
  }

  /** A seat connected over /ws; `frames` fill as the daemon delivers. */
  async function seat(d, key, name, grant) {
    const frames = [];
    const ws = new WebSocket(`${d.base.replace('http', 'ws')}/ws`);
    ws.on('message', (m) => frames.push({ at: Date.now(), ...JSON.parse(m.toString()) }));
    await new Promise((r) => ws.on('open', r));
    const sentAt = Date.now();
    ws.send(
      JSON.stringify({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team: 'bravo',
        key,
        target: { seat: name },
        grant,
        surface: 'cli',
      }),
    );
    const ok = await until(() => frames.some((f) => f.type === 'occupied'), 10_000);
    if (!ok) throw new Error(`seat ${name} never occupied on ${d.name}`);
    return { ws, frames, sentAt };
  }

  const gotDeliver = (s, id) => () =>
    s.frames.some((f) => f.type === 'deliver' && f.envelope?.id === id);
  let seq = 0;
  const envelope = () => {
    const id = `fan-${Date.now()}-${++seq}`;
    return {
      id,
      env: makeEnvelope({
        id,
        team: 'bravo',
        from: 'nick',
        to: { kind: 'team' },
        act: 'message',
        body: 'probe',
        ts: Date.now(),
      }),
    };
  };

  async function scenario(joinerCount) {
    const root = mkdtempSync(join(tmpdir(), 'musterd-fanout-'));
    const { mkdirSync } = await import('node:fs');
    const names = ['hub', ...Array.from({ length: joinerCount }, (_, i) => `j${i + 1}`)];
    for (const n of names) mkdirSync(join(root, n), { recursive: true });
    const hub = await daemon(root, 'hub');
    const joiners = [];
    for (let i = 1; i <= joinerCount; i++) joiners.push(await daemon(root, `j${i}`));
    try {
      const mk = async (d) => {
        const r = await post(d.base, '/teams', {
          slug: 'bravo',
          creator: { name: 'nick', kind: 'human' },
        });
        return { cred: r.json.human_credential, key: r.json.agent_key };
      };
      const hubAuth = await mk(hub);
      // Seats must exist on both sides (roster identity replicates via git in real life).
      const addSeat = async (d, auth, name) => {
        await post(d.base, '/teams/bravo/members', { name, kind: 'agent' }, auth.cred);
        const g = await post(
          d.base,
          '/teams/bravo/grants',
          { scope: 'seat', target: name, lifetime: 'standing' },
          auth.cred,
        );
        return g.json.token;
      };
      const probeSeats = Array.from({ length: warmup + rounds }, (_, i) => `p${i}`);
      const bobGrant = await addSeat(hub, hubAuth, 'bob');
      for (const p of probeSeats)
        await post(hub.base, '/teams/bravo/members', { name: p, kind: 'agent' }, hubAuth.cred);

      const js = [];
      for (const [i, d] of joiners.entries()) {
        const auth = await mk(d);
        // A first act mints the joiner's node row; enrollment needs it.
        await post(d.base, '/teams/bravo/messages', { envelope: envelope().env }, auth.cred);
        const inv = await post(
          hub.base,
          '/teams/bravo/nodes/invite',
          { label: d.name },
          hubAuth.cred,
        );
        const enr = await post(d.base, '/node/enroll', {
          hub_url: hub.base,
          code: inv.json.invite,
          team: 'bravo',
        });
        if (enr.status !== 200) throw new Error(`enroll ${d.name}: ${enr.status}`);
        const adaName = `ada${i + 1}`;
        await post(
          hub.base,
          '/teams/bravo/members',
          { name: adaName, kind: 'agent' },
          hubAuth.cred,
        );
        const adaGrant = await addSeat(d, auth, adaName);
        for (const p of probeSeats)
          await post(d.base, '/teams/bravo/members', { name: p, kind: 'agent' }, auth.cred);
        js.push({ d, auth, ada: await seat(d, auth.key, adaName, adaGrant), adaName });
      }
      const bob = await seat(hub, hubAuth.key, 'bob', bobGrant);

      if (history > 0) {
        for (let i = 0; i < history; i++)
          await post(hub.base, '/teams/bravo/messages', { envelope: envelope().env }, hubAuth.cred);
        const { id, env } = envelope();
        await post(hub.base, '/teams/bravo/messages', { envelope: env }, hubAuth.cred);
        for (const j of js)
          if (!(await until(gotDeliver(j.ada, id), 300_000)))
            throw new Error(`${j.d.name} never caught up on ${history} events`);
      }

      // ---- latency ------------------------------------------------------------------------
      const j2h = [];
      const h2j = [];
      const h2jWorst = [];
      const presence = [];
      for (let r = 0; r < warmup + rounds; r++) {
        const timed = r >= warmup;
        // joiner 1 -> hub
        let { id, env } = envelope();
        let t0 = Date.now();
        await post(joiners[0].base, '/teams/bravo/messages', { envelope: env }, js[0].auth.cred);
        const gotHub = await until(gotDeliver(bob, id), 20_000);
        if (timed) j2h.push(gotHub ? Date.now() - t0 : Infinity);

        // hub -> every joiner
        ({ id, env } = envelope());
        t0 = Date.now();
        await post(hub.base, '/teams/bravo/messages', { envelope: env }, hubAuth.cred);
        const per = await Promise.all(
          js.map(async (j) =>
            (await until(gotDeliver(j.ada, id), 20_000))
              ? j.ada.frames.find((f) => f.envelope?.id === id).at - t0
              : Infinity,
          ),
        );
        if (timed) {
          h2j.push(...per);
          h2jWorst.push(Math.max(...per));
        }

        // presence: a fresh seat claims on joiner 1; the hub's roster shows it live
        const pname = probeSeats[r];
        const g = (
          await post(
            joiners[0].base,
            '/teams/bravo/grants',
            { scope: 'seat', target: pname, lifetime: 'standing' },
            js[0].auth.cred,
          )
        ).json.token;
        t0 = Date.now();
        const claimed = seat(joiners[0], js[0].auth.key, pname, g);
        let live = false;
        while (Date.now() - t0 < 20_000 && !live) {
          const roster = await (
            await fetch(`${hub.base}/teams/bravo/members`, {
              headers: { authorization: `Bearer ${hubAuth.cred}` },
            })
          ).json();
          const m = roster.members.find((x) => x.name === pname);
          live = Boolean(m) && m.presence !== undefined && m.presence !== 'offline';
          if (!live) await sleep(15);
        }
        if (timed) presence.push(live ? Date.now() - t0 : Infinity);
        (await claimed).ws.close();
        await sleep(300);
      }

      // ---- hub cost per event -------------------------------------------------------------
      const window = events * gapMs;
      const hubReqs = (from) =>
        hub.logs.filter(
          (l) => l.at >= from && l.msg === 'http_request' && /\/sync\/pull$/.test(l.path ?? ''),
        );
      await sleep(1500); // let presence/ping settle
      const idleStart = await hub.cpu();
      const idleT0 = Date.now();
      await sleep(window);
      const idleCpu = (await hub.cpu()) - idleStart;
      const idleMs = Date.now() - idleT0;

      const burstStart = await hub.cpu();
      const joinerStart = await Promise.all(joiners.map((j) => j.cpu()));
      const burstT0 = Date.now();
      for (let i = 0; i < events; i++) {
        const { env } = envelope();
        await post(hub.base, '/teams/bravo/messages', { envelope: env }, hubAuth.cred);
        await sleep(gapMs);
      }
      await sleep(1500); // let the last pulls land
      const burstCpu = (await hub.cpu()) - burstStart;
      const burstMs = Date.now() - burstT0;
      const joinerCpu = (await Promise.all(joiners.map((j) => j.cpu()))).map(
        (c, i) => c - joinerStart[i],
      );
      const pulls = hubReqs(burstT0);
      const idlePulls = hubReqs(idleT0).filter((l) => l.at < idleT0 + idleMs).length;

      const stats = (xs) => {
        const f = xs.filter(Number.isFinite);
        return {
          n: xs.length,
          lost: xs.length - f.length,
          median: median(f),
          min: Math.min(...f),
          max: Math.max(...f),
        };
      };
      return {
        joiners: joinerCount,
        history,
        latency_ms: {
          joiner_to_hub: stats(j2h),
          hub_to_joiner: stats(h2j),
          hub_to_slowest_joiner: stats(h2jWorst),
          presence_attach_to_hub_roster: stats(presence),
        },
        hub_cost: {
          events,
          gap_ms: gapMs,
          burst_ms: burstMs,
          hub_cpu_ms_burst: Math.round(burstCpu),
          hub_cpu_ms_idle_same_window: Math.round(idleCpu * (burstMs / idleMs)),
          hub_cpu_ms_per_event: +((burstCpu - idleCpu * (burstMs / idleMs)) / events).toFixed(2),
          hub_cpu_ms_per_event_per_joiner: +(
            (burstCpu - idleCpu * (burstMs / idleMs)) /
            events /
            joinerCount
          ).toFixed(2),
          pull_requests_in_burst: pulls.length,
          pull_requests_per_event: +(pulls.length / events).toFixed(2),
          pull_handler_ms_total: pulls.reduce((a, l) => a + (l.ms ?? 0), 0),
          pull_requests_idle_window: idlePulls,
          joiner_cpu_ms_burst: joinerCpu.map(Math.round),
        },
      };
    } finally {
      for (const d of [...joiners, hub]) await d.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }

  const results = [];
  for (const n of joinerCounts) {
    console.error(`-- ${n} joiner(s) …`);
    const r = await scenario(n);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
  }
  if (jsonOut)
    (await import('node:fs')).writeFileSync(
      jsonOut,
      JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
    );
  process.exit(0);
}
