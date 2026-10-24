import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { prepareBuildSource, writeCaptureImage } from '../broadcast/hosted.js';
import { readStreamState, writeStreamState } from '../broadcast/streamState.js';
import { CliError } from '../errors.js';
import type { Exec, ExecResult } from '../process.js';
import { streamCommand, type StreamDeps } from './stream.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

const TS_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'nicks-laptop.tail400343.ts.net.', TailscaleIPs: ['100.100.246.14'] },
});

function greenExec(over: Record<string, ExecResult> = {}): Exec {
  return (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    for (const [prefix, result] of Object.entries(over)) {
      if (key.startsWith(prefix)) return result;
    }
    if (key === 'tailscale version') return ok('1.80.0');
    if (key === 'tailscale status --json') return ok(TS_STATUS);
    if (key === 'tailscale serve status --json')
      return ok(JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }));
    if (key === 'fly version') return ok('flyctl v0.3.0');
    if (key === 'fly auth whoami') return ok('nick@example.com');
    if (key.startsWith('fly status')) return ok('{}');
    if (key.startsWith('fly secrets list'))
      return ok(
        JSON.stringify([
          { name: 'TS_AUTHKEY', digest: 'dc45' },
          { name: 'MUSTERD_STREAM_KEY', digest: '26a8' },
        ]),
      );
    if (key.startsWith('fly machine list')) return ok('[]');
    return { code: 1, stdout: '', stderr: `unexpected: ${key}` };
  };
}

describe('musterd stream', () => {
  let repo: string;
  let out: string[];
  let base: StreamDeps;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'musterd-stream-'));
    mkdirSync(join(repo, 'scripts', 'broadcast'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'broadcast', 'hosted.Dockerfile'), '# marker\n');
    out = [];
    base = {
      exec: greenExec(),
      probeUpgrade: async () => 'allowed',
      cwd: repo,
      server: 'http://127.0.0.1:4849',
      out: (s) => void out.push(s),
      err: (s) => void out.push(s),
      // Hermetic supervisor plumbing: no test may touch ~/.musterd, the real fly, or the daemon.
      statePath: join(repo, 'stream-state.json'),
      who: () => 'miley',
      launch: () => ({ code: 0, output: '' }),
      sendAsk: async () => {},
      mintSeat: async (team) => ({ team, name: 'broadcast-test', token: 'mscr_test' }),
      stageSeat: () => ({ code: 0, output: '' }),
      postWindDown: async () => true,
    };
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const run = (argv: string[], over: Partial<StreamDeps> = {}) =>
    streamCommand(parseArgs(argv), { ...base, ...over });

  const MANIFEST_UNKNOWN =
    'failed to get manifest ...: request failed: not found [http 404]: ' +
    '{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}';
  const digest = 'sha256:' + 'a'.repeat(64);
  const withImage = () =>
    writeFileSync(join(repo, 'scripts', 'broadcast', '.image-digest'), digest);
  /** Backdate `.image-digest` — the supervisor reads its mtime to tell a rebuild from another
   * checkout's file, and a test that writes it "now" can only ever exercise the rebuild arm. */
  const agedImage = (at: number) => {
    const p = join(repo, 'scripts', 'broadcast', '.image-digest');
    utimesSync(p, new Date(at), new Date(at));
  };

  it('needs a subcommand and rejects an unknown one', async () => {
    await expect(run([])).rejects.toThrow(CliError);
    await expect(run(['blast'])).rejects.toThrow(/unknown subcommand/);
  });

  describe('doctor', () => {
    it('exits 0 and says ready on a fully-green system', async () => {
      withImage();
      expect(await run(['doctor'])).toBe(0);
      expect(out.join('')).toContain('ready');
    });

    it('exits 1 and prints the repair when something is missing', async () => {
      // No .image-digest written — the image check is the one that fails.
      expect(await run(['doctor'])).toBe(1);
      const text = out.join('');
      expect(text).toContain('capture image built');
      expect(text).toContain('musterd stream build');
    });

    it('emits machine-readable checks under --json', async () => {
      const code = await run(['doctor', '--json']);
      const doc = JSON.parse(out.join('')) as {
        ok: boolean;
        checks: { key: string; state: string }[];
      };
      expect(code).toBe(1);
      expect(doc.ok).toBe(false);
      expect(doc.checks.map((c) => c.key)).toContain('allowed-host');
    });

    it('probes the daemon on the configured port, not a hardcoded one', async () => {
      const seen: string[] = [];
      await run(['doctor'], {
        server: 'http://127.0.0.1:9999',
        probeUpgrade: async (h) => (seen.push(h), 'allowed'),
      });
      expect(seen).toEqual(['nicks-laptop.tail400343.ts.net', '100.100.246.14']);
      expect(out.join('')).toContain('tailscale serve forwards 9999');
    });
  });

  describe('start', () => {
    it('refuses without a recorded image rather than running a tag', async () => {
      await expect(run(['start'])).rejects.toThrow(/stream build/);
    });

    it('refuses when a machine is already live', async () => {
      withImage();
      const exec = greenExec({
        'fly machine list': ok(JSON.stringify([{ id: 'abc123', state: 'started' }])),
      });
      await expect(run(['start'], { exec })).rejects.toThrow(/already live \(machine abc123\)/);
    });

    it('refuses when the tailnet address cannot be discovered', async () => {
      withImage();
      const exec = greenExec({ 'tailscale status': { code: 1, stdout: '', stderr: '' } });
      await expect(run(['start'], { exec })).rejects.toThrow(/tailnet address/);
    });
  });

  describe('stop / status', () => {
    it('stopping nothing still records the intent, and status reports it', async () => {
      expect(await run(['stop'])).toBe(0);
      expect(out.join('')).toContain('nothing live');
      out.length = 0;
      expect(await run(['status'])).toBe(0);
      expect(out.join('')).toContain('stopped by miley');
    });

    it('stops the started machine with SIGINT so ffmpeg finalizes', async () => {
      const calls: string[][] = [];
      const inner = greenExec({
        'fly machine list': ok(JSON.stringify([{ id: 'abc123', state: 'started' }])),
        'fly machine stop': ok(''),
      });
      const exec: Exec = (cmd, args) => (calls.push([cmd, ...args]), inner(cmd, args));
      expect(await run(['stop'], { exec })).toBe(0);
      expect(calls).toContainEqual([
        'fly',
        'machine',
        'stop',
        'abc123',
        '-a',
        'musterd-broadcast',
        '--signal',
        'SIGINT',
        '--timeout',
        '30',
      ]);
    });

    it('reports the live machine and honours --app', async () => {
      const exec = greenExec({
        'fly machine list': ok(JSON.stringify([{ id: 'abc123', state: 'started' }])),
      });
      expect(await run(['status', '--app', 'other-app'], { exec })).toBe(0);
      expect(out.join('')).toContain('abc123');
      expect(out.join('')).toContain('other-app');
    });
  });

  // ── wind-down: `stop` queues, the supervisor stops at the deadline (lane 01M5GDACC0) ─────────
  describe('wind-down', () => {
    const NOW = 1_787_000_000_000;
    const DEADLINE = NOW + 30 * 60_000;
    let statePath: string;
    let posts: (number | null)[];
    let calls: string[][];
    let exec: Exec;

    beforeEach(() => {
      statePath = join(repo, 'stream-state.json');
      posts = [];
      calls = [];
      const inner = greenExec({
        'fly machine list': ok(JSON.stringify([{ id: 'abc123', state: 'started' }])),
        'fly machine stop': ok(''),
      });
      exec = (cmd, args) => (calls.push([cmd, ...args]), inner(cmd, args));
      writeStreamState(statePath, {
        desired: 'live',
        by: 'nick',
        at: NOW - 3_600_000,
        team: 'acme',
        restarts: [],
      });
    });

    const at = (now: number, over: Partial<StreamDeps> = {}): Partial<StreamDeps> => ({
      exec,
      statePath,
      now: () => now,
      fetchEpitaph: async () => null,
      postWindDown: async (team, stopAt) => (expect(team).toBe('acme'), posts.push(stopAt), true),
      ...over,
    });
    const stopped = () => calls.some((c) => c[1] === 'machine' && c[2] === 'stop');

    it('stop on a live stream queues the stop 30 minutes out and tells the daemon', async () => {
      expect(await run(['stop', '--reason', 'end of day'], at(NOW))).toBe(0);
      expect(stopped()).toBe(false);
      const s = readStreamState(statePath)!;
      expect(s.desired).toBe('live');
      expect(s.stopAt).toBe(DEADLINE);
      expect(s.reason).toBe('end of day');
      expect(posts).toEqual([DEADLINE]);
      expect(out.join('')).toContain('wind-down card is up');
    });

    it('status names the queued stop', async () => {
      await run(['stop'], at(NOW));
      out.length = 0;
      expect(await run(['status'], at(NOW + 10 * 60_000))).toBe(0);
      expect(out.join('')).toMatch(/stopping at .*\(20 min\)/);
    });

    it('a second stop does not push the deadline out', async () => {
      await run(['stop'], at(NOW));
      await run(['stop'], at(NOW + 5 * 60_000));
      expect(readStreamState(statePath)!.stopAt).toBe(DEADLINE);
      expect(posts).toEqual([DEADLINE]);
      expect(out.join('')).toContain('already stopping');
    });

    it('ensure leaves the stream up before the deadline and stops it after', async () => {
      await run(['stop'], at(NOW));
      expect(await run(['ensure'], at(DEADLINE - 60_000))).toBe(0);
      expect(stopped()).toBe(false);
      expect(await run(['ensure'], at(DEADLINE + 1))).toBe(0);
      expect(stopped()).toBe(true);
      const s = readStreamState(statePath)!;
      expect(s.desired).toBe('stopped');
      expect(s.stopAt).toBeUndefined();
      expect(posts).toEqual([DEADLINE, null]);
    });

    it('a stream that crashes during the wind-down is not relaunched once the deadline passes', async () => {
      let launches = 0;
      await run(['stop'], at(NOW));
      const gone = greenExec();
      expect(
        await run(
          ['ensure'],
          at(DEADLINE + 1, {
            exec: gone,
            launch: () => ((launches += 1), { code: 0, output: '' }),
          }),
        ),
      ).toBe(0);
      expect(launches).toBe(0);
      expect(readStreamState(statePath)!.desired).toBe('stopped');
    });

    it('--now stops at once and takes a queued card down', async () => {
      await run(['stop'], at(NOW));
      expect(await run(['stop', '--now'], at(NOW + 60_000))).toBe(0);
      expect(stopped()).toBe(true);
      expect(readStreamState(statePath)!.desired).toBe('stopped');
      expect(posts).toEqual([DEADLINE, null]);
    });

    it('--cancel keeps it live and takes the card down', async () => {
      await run(['stop'], at(NOW));
      expect(await run(['stop', '--cancel'], at(NOW + 60_000))).toBe(0);
      const s = readStreamState(statePath)!;
      expect(s.desired).toBe('live');
      expect(s.stopAt).toBeUndefined();
      expect(posts).toEqual([DEADLINE, null]);
      expect(await run(['ensure'], at(DEADLINE + 1))).toBe(0);
      expect(stopped()).toBe(false);
    });

    it('the stop still happens on time when the daemon cannot be told', async () => {
      expect(await run(['stop'], at(NOW, { postWindDown: async () => false }))).toBe(0);
      expect(out.join('')).toContain('no card shows');
      await run(['ensure'], at(DEADLINE + 1, { postWindDown: async () => false }));
      expect(stopped()).toBe(true);
    });
  });

  // ── desired state + supervisor (ADR 293) ──────────────────────────────────────────────────────
  describe('desired state', () => {
    const NOW = 1_787_000_000_000;
    let statePath: string;
    let launches: number;
    let asks: string[];

    beforeEach(() => {
      statePath = join(repo, 'stream-state.json');
      launches = 0;
      asks = [];
    });

    const sup = (over: Partial<StreamDeps> = {}): Partial<StreamDeps> => ({
      statePath,
      now: () => NOW,
      who: () => 'miley',
      launch: () => ((launches += 1), { code: 0, output: '' }),
      sendAsk: async (body: string) => void asks.push(body),
      // Hermetic default: no test may read the real daemon's epitaphs. Tests that care inject one.
      fetchEpitaph: async () => null,
      mintSeat: async (team) => ({ team, name: 'broadcast-test', token: 'mscr_test' }),
      stageSeat: () => ({ code: 0, output: '' }),
      ...over,
    });

    // 2026-09-03: `stream start` failed TWICE with `MANIFEST_UNKNOWN ... manifest unknown` (http
    // 404) against a digest `stream build` had just pushed and flyctl itself resolved, then
    // succeeded ~4 minutes later untouched. Registry propagation lag against a digest-pinned
    // launch. Giving up hands the supervisor a retry loop that would burn all three flap slots on
    // a 404 that was about to stop happening — the same reasoning as the prerender crawl's
    // retryCount, which exists because one transient fetch failure used to fail a whole build.
    it('retries a launch that failed on a not-yet-propagated image digest, then succeeds', async () => {
      withImage();
      let n = 0;
      const code = await run(
        ['start'],
        sup({
          launch: () => {
            n += 1;
            return n === 1
              ? {
                  code: 1,
                  output:
                    'failed to get manifest ...: request failed: not found [http 404]: ' +
                    '{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}',
                }
              : { code: 0, output: '' };
          },
          sleep: async () => {},
        }),
      );
      expect(code).toBe(0);
      expect(n).toBe(2);
    });

    // 2026-09-15: a MANIFEST_UNKNOWN exit is not proof no machine was created. `fly machine run`
    // creates the machine, then the VM fails to pull an unpublished digest and heals on its own.
    // The retry must NOT launch a second machine over the top of the one its "failed" attempt
    // already left — that is the 2026-09-03 duplicate-launch reached through start's own retry.
    // 2026-09-15: a MANIFEST_UNKNOWN exit is not proof no machine was created. `fly machine run`
    // creates the machine, then the VM fails to pull an unpublished digest and heals on its own.
    // The retry must NOT launch a second machine over the top of the one its "failed" attempt
    // already left — that is the 2026-09-03 duplicate-launch reached through start's own retry.
    it('does NOT relaunch when the failed attempt left a machine that then comes up', async () => {
      withImage();
      let listCalls = 0;
      const inner = greenExec({});
      // 1st list = the top-of-function guard (empty → proceed). 2nd = the reap check, which finds
      // the machine `created`. 3rd+ = the settle poll, by which point it has reached `started`.
      const stateful: Exec = (cmd, args) => {
        const key = [cmd, ...args].join(' ');
        if (key.startsWith('fly machine list')) {
          listCalls += 1;
          if (listCalls === 1) return ok('[]');
          const state = listCalls >= 3 ? 'started' : 'created';
          return ok(JSON.stringify([{ id: 'm-booting', state }]));
        }
        return inner(cmd, args);
      };
      let n = 0;
      const code = await run(
        ['start'],
        sup({
          exec: stateful,
          launch: () => ((n += 1), { code: 1, output: MANIFEST_UNKNOWN }),
          sleep: async () => {},
        }),
      );
      expect(code).toBe(0);
      expect(n).toBe(1); // launched once, then waited for the machine it had already created
      expect(out.join('')).toContain('m-booting');
      expect(out.join('')).toContain('not up yet');
    });

    // The guard must not trade a duplicate launch for a silent lie. `isUnpropagatedImage` matches
    // EVERY MANIFEST_UNKNOWN, including a digest that is permanently unresolvable — and `created`
    // is an OCCUPYING state, so "a machine exists" would report `◉ live` and `ensure`'s
    // `liveCount > 0` would then read `noop — live` forever. Nobody would stream, and nothing
    // would say so. Waiting for `started` is what keeps the failure loud.
    it('FAILS LOUDLY when the leftover machine never starts — a stuck machine is not a live one', async () => {
      withImage();
      let listCalls = 0;
      const inner = greenExec({});
      const stateful: Exec = (cmd, args) => {
        const key = [cmd, ...args].join(' ');
        if (key.startsWith('fly machine list')) {
          listCalls += 1;
          // Occupying forever, never `started`: the permanently-unresolvable-digest case.
          return listCalls === 1
            ? ok('[]')
            : ok(JSON.stringify([{ id: 'm-stuck', state: 'created' }]));
        }
        return inner(cmd, args);
      };
      let n = 0;
      await expect(
        run(
          ['start'],
          sup({
            exec: stateful,
            launch: () => ((n += 1), { code: 1, output: MANIFEST_UNKNOWN }),
            sleep: async () => {},
          }),
        ),
      ).rejects.toThrow(/never started|not resolvable/);
      expect(n).toBe(1); // still only one launch — it failed, it did not duplicate
    });

    // Two machines here is the duplicate this command exists to prevent; it must be said, not
    // papered over by reporting the first id as live.
    it('says so when it finds MORE than one occupying machine', async () => {
      withImage();
      let listCalls = 0;
      const inner = greenExec({});
      const stateful: Exec = (cmd, args) => {
        const key = [cmd, ...args].join(' ');
        if (key.startsWith('fly machine list')) {
          listCalls += 1;
          if (listCalls === 1) return ok('[]');
          const state = listCalls >= 3 ? 'started' : 'created';
          return ok(
            JSON.stringify([
              { id: 'm-one', state },
              { id: 'm-two', state },
            ]),
          );
        }
        return inner(cmd, args);
      };
      await run(
        ['start'],
        sup({
          exec: stateful,
          launch: () => ({ code: 1, output: MANIFEST_UNKNOWN }),
          sleep: async () => {},
        }),
      );
      expect(out.join('')).toContain('duplicate launch');
      expect(out.join('')).toContain('m-one, m-two');
    });

    // A retry loop over real errors is how you bill for nothing. Anything but the transient
    // registry signature stays fatal on the first try.
    it('does NOT retry a launch that failed for any other reason', async () => {
      withImage();
      let n = 0;
      await expect(
        run(
          ['start'],
          sup({
            launch: () => ((n += 1), { code: 1, output: 'Error: insufficient capacity in sjc' }),
            sleep: async () => {},
          }),
        ),
      ).rejects.toThrow(/fly machine run failed/);
      expect(n).toBe(1);
    });

    it('start --args forwards a value that starts with -- as BROADCAST_ARGS', async () => {
      withImage();
      let flyArgs: string[] = [];
      expect(
        await run(['start', '--args', '--duration 600'], {
          ...sup(),
          launch: (args) => {
            flyArgs = args;
            launches += 1;
            return { code: 0, output: '' };
          },
        }),
      ).toBe(0);
      expect(flyArgs).toContain('BROADCAST_ARGS=--duration 600');
    });

    // ADR 594: since ADR 580 the page cannot mint its own observer, so start mints one and stages it
    // as a Fly secret — never on the `fly machine run` argv, where `ps` and the machine config show it.
    it('start stages a minted observer as a Fly secret and keeps it off the machine run argv', async () => {
      withImage();
      let flyArgs: string[] = [];
      const staged: Array<{ app: string; seat: unknown }> = [];
      expect(
        await run(['start'], {
          ...sup(),
          stageSeat: (app, seat) => (staged.push({ app, seat }), { code: 0, output: '' }),
          launch: (args) => ((flyArgs = args), (launches += 1), { code: 0, output: '' }),
        }),
      ).toBe(0);
      expect(staged).toEqual([
        {
          app: 'musterd-broadcast',
          seat: { team: 'revive', name: 'broadcast-test', token: 'mscr_test' },
        },
      ]);
      expect(flyArgs.join(' ')).not.toContain('mscr_test');
    });

    it('a seat that cannot be staged launches nothing', async () => {
      withImage();
      await expect(
        run(['start'], { ...sup(), stageSeat: () => ({ code: 1, output: 'not authorized' }) }),
      ).rejects.toThrow(/could not stage .* not authorized/);
      expect(launches).toBe(0);
    });

    it('a refused seat mint records no live intent for the supervisor to relaunch seatless', async () => {
      withImage();
      await expect(
        run(['start'], {
          ...sup(),
          mintSeat: async () => {
            throw new Error('minting one takes a human admin (ADR 580)');
          },
        }),
      ).rejects.toThrow(/human admin/);
      expect(launches).toBe(0);
      expect(readStreamState(statePath)).toBeNull();
    });

    it('start records the machine id the launch printed', async () => {
      withImage();
      expect(
        await run(
          ['start'],
          sup({ launch: () => ({ code: 0, output: 'Machine ID: d8d55d6a7e96e8\n' }) }),
        ),
      ).toBe(0);
      expect(readStreamState(statePath)!.machine).toBe('d8d55d6a7e96e8');
    });

    it('start --once does not record a machine id onto a stopped intent', async () => {
      withImage();
      expect(
        await run(
          ['start', '--once'],
          sup({ launch: () => ({ code: 0, output: 'Machine ID: d8d55d6a7e96e8\n' }) }),
        ),
      ).toBe(0);
      const st = readStreamState(statePath)!;
      expect(st.desired).toBe('stopped');
      expect(st.machine).toBeUndefined();
    });

    it('records the occupying machine when the launch output names none', async () => {
      withImage();
      let listCalls = 0;
      const inner = greenExec({});
      const exec: Exec = (cmd, args) => {
        const key = [cmd, ...args].join(' ');
        if (key.startsWith('fly machine list')) {
          listCalls += 1;
          if (listCalls === 1) return ok('[]');
          const state = listCalls >= 3 ? 'started' : 'created';
          return ok(JSON.stringify([{ id: 'abc123def45678', state }]));
        }
        return inner(cmd, args);
      };
      expect(
        await run(
          ['start'],
          sup({
            exec,
            launch: () => ({ code: 1, output: MANIFEST_UNKNOWN }),
            sleep: async () => {},
          }),
        ),
      ).toBe(0);
      expect(readStreamState(statePath)!.machine).toBe('abc123def45678');
    });

    it('start records desired live with provenance before launching', async () => {
      withImage();
      expect(await run(['start'], sup())).toBe(0);
      expect(launches).toBe(1);
      const st = readStreamState(statePath);
      expect(st).toMatchObject({
        desired: 'live',
        by: 'miley',
        at: NOW,
        team: 'revive',
        restarts: [],
      });
    });

    it('start --once records stopped — a deliberately unsupervised run is never resurrected', async () => {
      withImage();
      expect(await run(['start', '--once'], sup())).toBe(0);
      expect(launches).toBe(1);
      expect(readStreamState(statePath)).toMatchObject({
        desired: 'stopped',
        reason: '--once run',
      });
    });

    it('start clears a stand-down — the human re-arming IS the human decision', async () => {
      withImage();
      writeStreamState(statePath, {
        desired: 'live',
        at: NOW - 1,
        restarts: [NOW - 3000, NOW - 2000, NOW - 1000],
        standDownAt: NOW - 500,
      });
      await run(['start'], sup());
      const st = readStreamState(statePath)!;
      expect(st.standDownAt).toBeUndefined();
      expect(st.restarts).toEqual([]);
    });

    it('stop records who and why, even when nothing is live', async () => {
      expect(await run(['stop', '--reason', 'nick asked'], sup())).toBe(0);
      expect(readStreamState(statePath)).toMatchObject({
        desired: 'stopped',
        by: 'miley',
        reason: 'nick asked',
      });
    });

    it('status surfaces stop provenance instead of a bare "not live"', async () => {
      writeStreamState(statePath, {
        desired: 'stopped',
        by: 'miley',
        at: NOW,
        reason: 'nick asked',
        restarts: [],
      });
      await run(['status'], sup());
      expect(out.join('')).toContain('miley');
      expect(out.join('')).toContain('nick asked');
    });

    it('status calls out a crash (desired live, no machine) and a stand-down', async () => {
      writeStreamState(statePath, { desired: 'live', by: 'miley', at: NOW, restarts: [] });
      await run(['status'], sup());
      expect(out.join('')).toMatch(/desired live/i);
      out.length = 0;
      writeStreamState(statePath, { desired: 'live', at: NOW, restarts: [], standDownAt: NOW });
      await run(['status'], sup());
      expect(out.join('')).toMatch(/stood down/i);
    });
  });

  describe('ensure', () => {
    const NOW = 1_787_000_000_000;
    let statePath: string;
    let launches: number;
    let asks: string[];

    beforeEach(() => {
      statePath = join(repo, 'stream-state.json');
      launches = 0;
      asks = [];
    });

    const sup = (over: Partial<StreamDeps> = {}): Partial<StreamDeps> => ({
      statePath,
      now: () => NOW,
      who: () => 'miley',
      launch: () => ((launches += 1), { code: 0, output: '' }),
      sendAsk: async (body: string) => void asks.push(body),
      // Hermetic default: no test may read the real daemon's epitaphs. Tests that care inject one.
      fetchEpitaph: async () => null,
      ...over,
    });

    it('does nothing when desired is stopped or state is absent', async () => {
      expect(await run(['ensure'], sup())).toBe(0);
      writeStreamState(statePath, { desired: 'stopped', by: 'miley', at: NOW, restarts: [] });
      expect(await run(['ensure'], sup())).toBe(0);
      expect(launches).toBe(0);
      expect(asks).toEqual([]);
    });

    it('does nothing while the machine is up', async () => {
      withImage();
      writeStreamState(statePath, { desired: 'live', at: NOW - 60_000, restarts: [] });
      const exec = greenExec({
        'fly machine list': ok(JSON.stringify([{ id: 'abc123', state: 'started' }])),
      });
      expect(await run(['ensure'], sup({ exec }))).toBe(0);
      expect(launches).toBe(0);
      expect(readStreamState(statePath)!.machine).toBe('abc123');
    });

    it('does not record a machine id onto a stopped intent', async () => {
      writeStreamState(statePath, { desired: 'stopped', by: 'miley', at: NOW, restarts: [] });
      const exec = greenExec({
        'fly machine list': ok(JSON.stringify([{ id: 'abc123', state: 'started' }])),
      });
      expect(await run(['ensure'], sup({ exec }))).toBe(0);
      const st = readStreamState(statePath)!;
      expect(st.desired).toBe('stopped');
      expect(st.machine).toBeUndefined();
      expect(launches).toBe(0);
    });

    it('restarts a crashed stream and stamps the ledger', async () => {
      withImage();
      writeStreamState(statePath, {
        desired: 'live',
        team: 'revive',
        at: NOW - 60_000,
        restarts: [],
      });
      expect(await run(['ensure'], sup())).toBe(0);
      expect(launches).toBe(1);
      expect(readStreamState(statePath)!.restarts).toEqual([NOW]);
    });

    it('a relaunch replays recorded broadcast args and says so', async () => {
      withImage();
      writeStreamState(statePath, {
        desired: 'live',
        team: 'revive',
        at: NOW - 60_000,
        restarts: [],
        args: '--duration 600',
      });
      let flyArgs: string[] = [];
      expect(
        await run(
          ['ensure'],
          sup({
            launch: (args) => {
              flyArgs = args;
              launches += 1;
              return { code: 0, output: '' };
            },
          }),
        ),
      ).toBe(0);
      expect(flyArgs).toContain('BROADCAST_ARGS=--duration 600');
      expect(out.join('')).toContain('broadcast args kept (--duration 600)');
      expect(readStreamState(statePath)!.args).toBe('--duration 600');
    });

    it('start records --args on the stream record so a later relaunch can replay them', async () => {
      withImage();
      let flyArgs: string[] = [];
      expect(
        await run(['start', '--args', 'duration 600'], {
          ...sup(),
          launch: (args) => {
            flyArgs = args;
            launches += 1;
            return { code: 0, output: '' };
          },
        }),
      ).toBe(0);
      expect(flyArgs).toContain('BROADCAST_ARGS=duration 600');
      expect(readStreamState(statePath)!.args).toBe('duration 600');
    });

    it('at the flap cap: stands down, asks ONCE, and never launches', async () => {
      withImage();
      writeStreamState(statePath, {
        desired: 'live',
        at: NOW - 60_000,
        restarts: [NOW - 20 * 60_000, NOW - 10 * 60_000, NOW - 5 * 60_000],
      });
      expect(await run(['ensure'], sup())).toBe(0);
      expect(launches).toBe(0);
      expect(asks.length).toBe(1);
      expect(readStreamState(statePath)!.standDownAt).toBe(NOW);
      // the next tick is quiet — the ask already stands
      expect(await run(['ensure'], sup())).toBe(0);
      expect(asks.length).toBe(1);
    });

    /*
     * Lane 01M2K6BWVR — the end-to-end half. `standDownReport` is unit-tested next door; this is the
     * wiring, because the defect lived entirely in the wiring: `LaunchResult` already carried
     * `output`, and `ensure` destructured `{ code }` and dropped it on the floor. The pure function
     * could have been perfect and the human would still have been told the wrong thing.
     */
    it('three failed launches are reported as the environment, with fly’s own error', async () => {
      // The real line from ensure.log, not an abbreviated one — its length is load-bearing (the
      // cause is at the end, past where a naive cap would cut).
      const dns =
        'Error: failed to run query ($appName: String!) { appcompact:app(name: $appName) { id ' +
        'internalNumericId name hostname cnameTarget deployed network status appUrl platformVersion ' +
        'organization { id internalNumericId slug paidPlan } postgresAppRole: role { name } } }: ' +
        'Post "https://api.fly.io/graphql": dial tcp: lookup api.fly.io: no such host';
      withImage(); // a relaunch needs a recorded digest to run
      const failing = sup({ launch: () => ((launches += 1), { code: 1, output: dns }) });
      writeStreamState(statePath, {
        desired: 'live',
        at: NOW - 60_000,
        restarts: [],
        image: 'sha256:' + 'a'.repeat(64), // same digest → not a deploy, so restarts are charged
      });

      // Each tick: no machine, so a restart is spent; the launch fails, so still no machine.
      for (let i = 0; i < 3; i++) expect(await run(['ensure'], failing)).toBe(0);
      expect(launches).toBe(3);
      // The fourth tick is the one that gives up and speaks to a human.
      expect(await run(['ensure'], failing)).toBe(0);

      expect(asks.length).toBe(1);
      const ask = asks[0]!;
      // What it must say: this is the environment, and here is the thing to go and fix.
      expect(ask).toContain('launch attempts failed');
      expect(ask).toContain('lookup api.fly.io: no such host');
      expect(ask).toContain('musterd stream doctor');
      // What it must never say again. Nothing crashed — no machine ever came up.
      expect(ask).not.toContain('crashed');
    });

    it('machines that really did vanish still read as the broadcast stopping', async () => {
      // Launches SUCCEED here, so a machine came up each time and then went away on its own —
      // the one case the old wording actually fitted.
      withImage();
      writeStreamState(statePath, {
        desired: 'live',
        at: NOW - 60_000,
        restarts: [],
        image: 'sha256:' + 'a'.repeat(64),
      });
      for (let i = 0; i < 3; i++) expect(await run(['ensure'], sup())).toBe(0);
      expect(await run(['ensure'], sup())).toBe(0);
      expect(asks.length).toBe(1);
      expect(asks[0]!).toContain('stopped 3×');
      expect(asks[0]!).not.toContain('launch attempts failed');
    });

    it('a machine gone across an image change is a deploy — relaunched, budget untouched', async () => {
      withImage(); // .image-digest now says aaa… — but the dead machine ran bbb…
      writeStreamState(statePath, {
        desired: 'live',
        at: NOW - 60_000,
        restarts: [],
        image: 'sha256:' + 'b'.repeat(64),
      });
      expect(await run(['ensure'], sup())).toBe(0);
      expect(launches).toBe(1);
      const st = readStreamState(statePath)!;
      expect(st.restarts).toEqual([]);
      expect(st.image).toBe('sha256:' + 'a'.repeat(64));
      expect(out.join('')).toMatch(/deploy/i);
    });

    // The live hazard this pair closes (2026-09-17): `.image-digest` is gitignored and per-checkout,
    // and streamwatch's LaunchAgent runs from the MAIN checkout while streams are routinely started
    // from a worktree. Main held a 14-day-old digest against a 1-day-old live machine, so a crash
    // would have relaunched 14-day-old capture code — and been logged as a deploy, uncharged.
    it('a crash relaunches the image the STREAM recorded, not the one this checkout holds', async () => {
      withImage(); // this checkout says aaa…
      agedImage(NOW - 120_000); // …and it was written before the stream started
      const running = 'sha256:' + 'b'.repeat(64);
      writeStreamState(statePath, {
        desired: 'live',
        at: NOW - 60_000,
        restarts: [],
        image: running,
      });
      const args: string[][] = [];
      expect(
        await run(
          ['ensure'],
          sup({ launch: (a: string[]) => (args.push(a), { code: 0, output: '' }) }),
        ),
      ).toBe(0);
      expect(args[0]!.join(' ')).toContain(running);
      expect(args[0]!.join(' ')).not.toContain('a'.repeat(64));
      expect(readStreamState(statePath)!.image).toBe(running);
    });

    it('a stale checkout digest is charged to the flap budget — it is a crash, not a deploy', async () => {
      withImage();
      agedImage(NOW - 120_000);
      writeStreamState(statePath, {
        desired: 'live',
        at: NOW - 60_000,
        restarts: [],
        image: 'sha256:' + 'b'.repeat(64),
      });
      expect(await run(['ensure'], sup())).toBe(0);
      expect(readStreamState(statePath)!.restarts).toEqual([NOW]);
      expect(out.join('')).not.toMatch(/deploy/i);
    });

    // Lane 01M52Z987280 — the dead machine's last words, merged into the supervisor's own lines.
    // The wiring is the defect class: the epitaph could be sitting in audit perfectly and a crash
    // note would still read "no stop record" and nothing else, which was the whole 2026-10-16 story.
    describe('last words (lane 01M52Z987280)', () => {
      const EP = {
        ts: NOW - 30_000,
        seat: 'broadcast-t1',
        reason: 'ffmpeg ended (code 1) — the sink dropped',
        code: 1,
        ran_ms: 1_477_000,
      };
      const crashState = () => {
        withImage();
        agedImage(NOW - 120_000); // the recorded digest predates the run → a crash, not a deploy
        writeStreamState(statePath, {
          desired: 'live',
          at: NOW - 60_000,
          restarts: [],
          image: 'sha256:' + 'b'.repeat(64),
        });
      };

      it('a crash restart quotes the epitaph the machine posted before dying', async () => {
        crashState();
        expect(await run(['ensure'], sup({ fetchEpitaph: async () => EP }))).toBe(0);
        const note = out.join('');
        expect(note).toContain('crash detected');
        expect(note).toContain(
          'last words (exit 1 after 25m): “ffmpeg ended (code 1) — the sink dropped”',
        );
      });

      it('no epitaph is itself the finding: died without reporting', async () => {
        crashState();
        expect(await run(['ensure'], sup())).toBe(0); // the base default returns null
        expect(out.join('')).toContain('no last words — it died without reporting');
      });

      it('a stale epitaph is not quoted against a newer death', async () => {
        crashState();
        const stale = { ...EP, ts: NOW - 16 * 60_000 };
        expect(await run(['ensure'], sup({ fetchEpitaph: async () => stale }))).toBe(0);
        expect(out.join('')).toContain('no last words');
        expect(out.join('')).not.toContain(EP.reason);
      });

      it('a deploy restart never asks for last words — it already named its cause', async () => {
        withImage(); // record now says aaa…, the dead machine ran bbb…
        writeStreamState(statePath, {
          desired: 'live',
          at: NOW - 60_000,
          restarts: [],
          image: 'sha256:' + 'b'.repeat(64),
        });
        let asked = 0;
        expect(await run(['ensure'], sup({ fetchEpitaph: async () => ((asked += 1), EP) }))).toBe(
          0,
        );
        expect(out.join('')).toMatch(/deploy/i);
        expect(out.join('')).not.toContain('last words');
        expect(asked).toBe(0);
      });

      it('the stand-down ask carries the last words a human needs', async () => {
        withImage();
        agedImage(NOW - 120_000);
        writeStreamState(statePath, {
          desired: 'live',
          at: NOW - 60_000,
          restarts: [NOW - 20 * 60_000, NOW - 10 * 60_000, NOW - 5 * 60_000],
        });
        expect(await run(['ensure'], sup({ fetchEpitaph: async () => EP }))).toBe(0);
        expect(asks.length).toBe(1);
        expect(asks[0]!).toContain('stopped 3×');
        expect(asks[0]!).toContain(EP.reason);
      });

      it('status names the last end when the stream is not live', async () => {
        writeStreamState(statePath, {
          desired: 'stopped',
          by: 'nick',
          at: NOW - 60_000,
          restarts: [],
        });
        expect(await run(['status'], sup({ fetchEpitaph: async () => EP }))).toBe(0);
        const text = out.join('');
        expect(text).toContain('last end');
        expect(text).toContain('exit 1 after 25m live');
        expect(text).toContain(EP.reason);
      });

      it('status stays quiet when there is nothing to quote', async () => {
        expect(await run(['status'], sup())).toBe(0);
        expect(out.join('')).not.toContain('last end');
      });

      // Lane 01M539NG4N — the 2026-10-16 death of 830722b7704158 left no epitaph. Fly's event was
      // exit_code=-1,oom_killed=false,requested_stop=false. The note has to quote that, and only that.
      const dead = '830722b7704158';
      const flyStatus = [
        '2026-10-16T14:10:40Z stopped destroy flyd',
        '2026-10-16T14:10:39Z stopped crash flyd exit_code=-1,oom_killed=false,requested_stop=false',
        '2026-10-16T12:06:12Z started start flyd exit_code=0,oom_killed=false,requested_stop=true',
      ].join('\n');

      it('no epitaph quotes the Fly exit of the machine the state file still names', async () => {
        crashState();
        writeStreamState(statePath, { ...readStreamState(statePath)!, machine: dead });
        const exec = greenExec({ [`fly machine status ${dead}`]: ok(flyStatus) });
        expect(await run(['ensure'], sup({ exec }))).toBe(0);
        const note = out.join('');
        expect(note).toContain('no last words — it died without reporting');
        expect(note).toContain('exit -1, not oom, not a requested stop');
        expect(note).not.toContain('exit 0');
      });

      it('a Fly status that fails keeps the hard-kill sentence', async () => {
        crashState();
        writeStreamState(statePath, { ...readStreamState(statePath)!, machine: dead });
        const exec = greenExec({
          'fly machine status': { code: 1, stdout: '', stderr: 'not found' },
        });
        expect(await run(['ensure'], sup({ exec }))).toBe(0);
        const note = out.join('');
        expect(note).toContain('a hard kill, or pre-epitaph capture code');
        expect(note).not.toContain('not oom');
      });

      it('a recent epitaph is not replaced, and Fly is not asked', async () => {
        crashState();
        writeStreamState(statePath, { ...readStreamState(statePath)!, machine: dead });
        let statusCalls = 0;
        const inner = greenExec({ 'fly machine status': ok(flyStatus) });
        const exec: Exec = (cmd, args) => {
          if (args[0] === 'machine' && args[1] === 'status') statusCalls += 1;
          return inner(cmd, args);
        };
        expect(await run(['ensure'], sup({ exec, fetchEpitaph: async () => EP }))).toBe(0);
        expect(out.join('')).toContain(
          'last words (exit 1 after 25m): “ffmpeg ended (code 1) — the sink dropped”',
        );
        expect(out.join('')).not.toContain('not oom');
        expect(statusCalls).toBe(0);
      });

      it('a stale epitaph yields to the Fly exit', async () => {
        crashState();
        writeStreamState(statePath, { ...readStreamState(statePath)!, machine: dead });
        const exec = greenExec({ [`fly machine status ${dead}`]: ok(flyStatus) });
        const stale = { ...EP, ts: NOW - 16 * 60_000 };
        expect(await run(['ensure'], sup({ exec, fetchEpitaph: async () => stale }))).toBe(0);
        expect(out.join('')).toContain('exit -1, not oom, not a requested stop');
        expect(out.join('')).not.toContain(EP.reason);
      });

      it('the stand-down ask quotes the Fly exit when there are no last words', async () => {
        withImage();
        writeStreamState(statePath, {
          desired: 'live',
          at: NOW - 60_000,
          restarts: [NOW - 20 * 60_000, NOW - 10 * 60_000, NOW - 5 * 60_000],
          machine: dead,
        });
        const exec = greenExec({
          [`fly machine status ${dead}`]: ok('exit_code=-1,oom_killed=true,requested_stop=false'),
        });
        expect(await run(['ensure'], sup({ exec }))).toBe(0);
        expect(asks.length).toBe(1);
        expect(asks[0]!).toContain('no last words — it died without reporting');
        expect(asks[0]!).toContain('exit -1, oom, not a requested stop');
      });

      it('quotes the dead machine, then records the id the relaunch printed', async () => {
        crashState();
        writeStreamState(statePath, { ...readStreamState(statePath)!, machine: dead });
        const exec = greenExec({ [`fly machine status ${dead}`]: ok(flyStatus) });
        expect(
          await run(
            ['ensure'],
            sup({
              exec,
              launch: () => ({ code: 0, output: 'Machine ID: d8d55d6a7e96e8\n' }),
            }),
          ),
        ).toBe(0);
        expect(out.join('')).toContain('exit -1, not oom, not a requested stop');
        expect(readStreamState(statePath)!.machine).toBe('d8d55d6a7e96e8');
      });

      it('a stop that lands during the relaunch is not rewritten live', async () => {
        crashState();
        writeStreamState(statePath, { ...readStreamState(statePath)!, machine: dead });
        expect(
          await run(
            ['ensure'],
            sup({
              launch: () => {
                writeStreamState(statePath, {
                  desired: 'stopped',
                  by: 'miley',
                  at: NOW,
                  reason: 'nick asked',
                  restarts: [],
                });
                return { code: 0, output: 'Machine ID: d8d55d6a7e96e8\n' };
              },
            }),
          ),
        ).toBe(0);
        const st = readStreamState(statePath)!;
        expect(st.desired).toBe('stopped');
        expect(st.reason).toBe('nick asked');
        expect(st.machine).toBeUndefined();
      });

      it('a non-hex machine id is not passed to fly', async () => {
        crashState();
        const raw = readStreamState(statePath)!;
        writeFileSync(statePath, JSON.stringify({ ...raw, machine: '--help' }));
        const calls: string[] = [];
        const inner = greenExec();
        const exec: Exec = (cmd, args) => {
          calls.push([cmd, ...args].join(' '));
          return inner(cmd, args);
        };
        expect(await run(['ensure'], sup({ exec }))).toBe(0);
        expect(calls.some((c) => c.includes('machine status'))).toBe(false);
        expect(out.join('')).toContain('a hard kill, or pre-epitaph capture code');
      });
    });

    // The falsifier from lane 01M2RAJ0JK: a build in ANY checkout is visible to `ensure` run from
    // any other. Before the machine record, this is the case that could not work — streamwatch
    // always resolves the main checkout, so a worktree's build was invisible to it.
    it('launches the MACHINE record, not this checkout’s file, when the two disagree', async () => {
      withImage(); // this checkout says aaa… (a worktree that built long ago)
      const fromAnotherCheckout = 'sha256:' + 'c'.repeat(64);
      writeCaptureImage({
        statePath,
        digest: fromAnotherCheckout,
        repoRoot: join(repo, 'elsewhere'),
        now: NOW - 10_000,
      });
      writeStreamState(statePath, {
        desired: 'live',
        at: NOW - 60_000,
        restarts: [],
        image: fromAnotherCheckout,
      });
      const args: string[][] = [];
      expect(
        await run(
          ['ensure'],
          sup({ launch: (a: string[]) => (args.push(a), { code: 0, output: '' }) }),
        ),
      ).toBe(0);
      expect(args[0]!.join(' ')).toContain(fromAnotherCheckout);
      expect(args[0]!.join(' ')).not.toContain('a'.repeat(64));
    });

    // Sloane's residual on #1538, now answered by the same rule in both directions: a rebuild is a
    // deploy whichever checkout ran it, because there is only one record to disagree with.
    it('a rebuild recorded for the machine is a deploy even though it predates the run', async () => {
      const rebuilt = 'sha256:' + 'd'.repeat(64);
      writeCaptureImage({ statePath, digest: rebuilt, repoRoot: repo, now: NOW - 120_000 });
      writeStreamState(statePath, {
        desired: 'live',
        at: NOW - 60_000,
        restarts: [],
        image: 'sha256:' + 'e'.repeat(64),
      });
      expect(await run(['ensure'], sup())).toBe(0);
      expect(out.join('')).toMatch(/deploy/i);
      expect(readStreamState(statePath)!.restarts).toEqual([]); // a deploy never spends the budget
      expect(readStreamState(statePath)!.image).toBe(rebuilt);
    });

    it('start needs no checkout digest at all once the machine has a record', async () => {
      // No withImage(): nothing in this checkout. The machine record alone must be enough.
      writeCaptureImage({
        statePath,
        digest: 'sha256:' + 'f'.repeat(64),
        repoRoot: repo,
        now: NOW,
      });
      const args: string[][] = [];
      expect(
        await run(
          ['start'],
          sup({ launch: (a: string[]) => (args.push(a), { code: 0, output: '' }) }),
        ),
      ).toBe(0);
      expect(args[0]!.join(' ')).toContain('f'.repeat(64));
    });

    // Lane 01M50D71N1: `start` names a stale image but still launches it — doctor is the gate.
    it('start warns that the image is behind main on the capture paths, and launches anyway', async () => {
      writeCaptureImage({
        statePath,
        digest: 'sha256:' + 'f'.repeat(64),
        repoRoot: repo,
        now: NOW,
        commit: 'c0ffee0000000000000000000000000000000000',
      });
      const exec = greenExec({ [`git -C ${repo} log`]: ok('e1d1541 ADR 594: seat handoff\n') });
      let launched = 0;
      expect(
        await run(['start'], {
          ...sup({ launch: () => ((launched += 1), { code: 0, output: '' }) }),
          exec,
        }),
      ).toBe(0);
      expect(launched).toBe(1);
      expect(out.join('')).toContain('1 capture commit behind origin/main (newest: e1d1541');
    });

    it('start records the launched image so ensure can tell a deploy from a crash', async () => {
      withImage();
      expect(await run(['start'], sup())).toBe(0);
      expect(readStreamState(statePath)!.image).toBe('sha256:' + 'a'.repeat(64));
    });

    it('a crash relaunch records the image it launched too', async () => {
      withImage();
      writeStreamState(statePath, { desired: 'live', at: NOW - 60_000, restarts: [] });
      expect(await run(['ensure'], sup())).toBe(0);
      expect(readStreamState(statePath)!.image).toBe('sha256:' + 'a'.repeat(64));
    });

    it('a failed relaunch still spends the budget (the next ticks converge on stand-down)', async () => {
      withImage();
      writeStreamState(statePath, { desired: 'live', at: NOW - 60_000, restarts: [] });
      expect(await run(['ensure'], sup({ launch: () => ({ code: 1, output: 'boom' }) }))).toBe(0);
      expect(readStreamState(statePath)!.restarts).toEqual([NOW]);
    });
  });
});

describe('stream build uploads origin/main, not the folder it runs in', () => {
  const TIP = 'b40e5716f0000000000000000000000000000000';
  const record = (over: Record<string, ExecResult> = {}) => {
    const calls: string[] = [];
    const exec: Exec = (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      for (const [prefix, r] of Object.entries(over)) if (key.startsWith(prefix)) return r;
      if (key.endsWith('rev-parse origin/main')) return ok(`${TIP}\n`);
      if (key.endsWith('rev-parse HEAD')) return ok('71f1759000000000000000000000000000000000\n');
      return ok();
    };
    return { exec, calls };
  };
  const removed: string[] = [];
  const base = { root: '/folder', mkTemp: () => '/tmp/x', rm: (d: string) => void removed.push(d) };

  beforeEach(() => {
    removed.length = 0;
  });

  it('fetches, exports the fetched tip into a temp dir, and records that commit', () => {
    // 2026-10-17: a human's folder sat at 71f1759 and `stream build` came back fully cached, three
    // capture fixes short of main.
    const { exec, calls } = record();
    const src = prepareBuildSource({ ...base, exec, here: false });
    expect(calls).toEqual([
      'git -C /folder fetch origin main',
      'git -C /folder rev-parse origin/main',
      `git -C /folder archive --format=tar -o /tmp/x/src.tar ${TIP}`,
      'mkdir -p /tmp/x/src',
      'tar -xf /tmp/x/src.tar -C /tmp/x/src',
    ]);
    expect(src.dir).toBe('/tmp/x/src');
    expect(src.commit).toBe(TIP);
    expect(src.label).toContain('origin/main at b40e571');
    src.cleanup();
    expect(removed).toEqual(['/tmp/x']);
  });

  it('never switches or writes the folder itself', () => {
    const { exec, calls } = record();
    prepareBuildSource({ ...base, exec, here: false });
    expect(calls.some((c) => / (switch|checkout|reset|pull|stash)\b/.test(c))).toBe(false);
  });

  it('refuses when origin/main cannot be fetched, and names --here', () => {
    const { exec } = record({
      'git -C /folder fetch': { code: 128, stdout: '', stderr: 'offline' },
    });
    expect(() => prepareBuildSource({ ...base, exec, here: false })).toThrow(/offline.*--here/);
  });

  it('removes the temp dir when the export fails', () => {
    const { exec } = record({ tar: { code: 2, stdout: '', stderr: 'disk full' } });
    expect(() => prepareBuildSource({ ...base, exec, here: false })).toThrow(/disk full/);
    expect(removed).toEqual(['/tmp/x']);
  });

  it('--here builds the folder as it stands and says when it carries uncommitted edits', () => {
    const { exec, calls } = record({ 'git -C /folder status --porcelain': ok(' M a.ts\n') });
    const src = prepareBuildSource({ ...base, exec, here: true });
    expect(src.dir).toBe('/folder');
    expect(src.commit).toBe('71f1759000000000000000000000000000000000');
    expect(src.label).toBe('this folder (--here): 71f1759 plus uncommitted edits');
    expect(calls.some((c) => c.includes('fetch'))).toBe(false);
  });
});
