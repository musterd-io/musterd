import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseTailscaleSelf,
  probeUpgradeHost,
  serveForwardsPort,
} from '../integrations/tailscale.js';
import type { Exec, ExecResult } from '../process.js';
import {
  CAPTURE_PATHS,
  formatFlyExit,
  parseFlyExit,
  parseLaunchedMachine,
  parsePushedDigest,
  parseSecrets,
  runChecks,
  occupiedMachines,
  readCaptureImage,
  startedMachines,
  writeCaptureImage,
  type Check,
  lastEncoderProgressAt,
  machineCreatedAt,
} from './hosted.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = ''): ExecResult => ({ code: 1, stdout: '', stderr });
const absent: ExecResult = { code: 127, stdout: '', stderr: 'not found' };

/** `tailscale status --json`, optionally carrying capture peers. `peers` is [hostname, online]. */
function tsStatus(peers: Array<[string, boolean]> = []): string {
  return JSON.stringify({
    BackendState: 'Running',
    Self: {
      DNSName: 'nicks-laptop.tail400343.ts.net.',
      TailscaleIPs: ['100.100.246.14', 'fd7a:115c:a1e0::1'],
    },
    Peer: Object.fromEntries(
      peers.map(([HostName, Online], i) => [`key${i}`, { HostName, Online }]),
    ),
  });
}
const TS_STATUS = tsStatus();

/** A fully-green system, so each test can knock out exactly one thing. */
function greenExec(over: Partial<Record<string, ExecResult>> = {}): Exec {
  return (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    for (const [prefix, result] of Object.entries(over)) {
      if (key.startsWith(prefix)) return result!;
    }
    if (key === 'tailscale version') return ok('1.80.0\n');
    if (key === 'tailscale status --json') return ok(TS_STATUS);
    if (key === 'tailscale serve status --json')
      return ok(JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } }));
    // The image's commit has nothing on main's capture paths since it was built: an up-to-date image.
    if (key.startsWith('git -C /repo log')) return ok('');
    if (key === 'fly version') return ok('flyctl v0.3.0\n');
    if (key === 'fly auth whoami') return ok('nick@example.com\n');
    if (key.startsWith('fly status')) return ok('{}');
    if (key.startsWith('fly secrets list'))
      return ok(
        JSON.stringify([
          { name: 'TS_AUTHKEY', digest: 'dc45' },
          { name: 'MUSTERD_STREAM_KEY', digest: '26a8' },
        ]),
      );
    return fail(`unexpected: ${key}`);
  };
}

const green = {
  exec: greenExec(),
  probeUpgrade: async () => 'allowed' as const,
  app: 'musterd-broadcast',
  port: 4849,
  repoRoot: '/repo',
  image: {
    digest: 'sha256:' + 'a'.repeat(64),
    at: 1_000,
    source: 'machine' as const,
    commit: 'c0ffee0000000000000000000000000000000000',
  },
};

const by = (checks: Check[], key: string): Check => {
  const c = checks.find((x) => x.key === key);
  if (!c) throw new Error(`no check ${key}`);
  return c;
};

describe('parsers', () => {
  it('strips the trailing dot off MagicDNS and picks the v4 address', () => {
    expect(parseTailscaleSelf(TS_STATUS)).toEqual({
      dnsName: 'nicks-laptop.tail400343.ts.net',
      ip4: '100.100.246.14',
      running: true,
    });
  });

  it('treats a stopped backend as not running rather than throwing', () => {
    const stopped = JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'x.ts.net.' } });
    expect(parseTailscaleSelf(stopped)?.running).toBe(false);
    expect(parseTailscaleSelf('not json')).toBeNull();
  });

  it('reads the serve forward by port number', () => {
    const doc = JSON.stringify({ TCP: { '4849': { TCPForward: '127.0.0.1:4849' } } });
    expect(serveForwardsPort(doc, 4849)).toBe(true);
    expect(serveForwardsPort(doc, 4850)).toBe(false);
    expect(serveForwardsPort('{}', 4849)).toBe(false);
  });

  // flyctl actually returns lowercase keys (verified against fly v0.4.74 on 2026-07-27). Reading
  // only the capitalised form is what made a fully-configured app report "none set" on first run,
  // so both casings are pinned here.
  it('reads secrets in either flyctl casing, and never a value', () => {
    const lower = JSON.stringify([
      { name: 'TS_AUTHKEY', digest: 'dc4562a27d8bfba7', status: 'Staged' },
    ]);
    expect(parseSecrets(lower)).toEqual([{ name: 'TS_AUTHKEY', digest: 'dc4562a27d8bfba7' }]);
    expect(parseSecrets(JSON.stringify([{ Name: 'TS_AUTHKEY', Digest: 'abc' }]))).toEqual([
      { name: 'TS_AUTHKEY', digest: 'abc' },
    ]);
  });

  it('counts only started machines, in either casing', () => {
    const doc = JSON.stringify([
      { id: 'aaa', state: 'stopped' },
      { id: 'bbb', state: 'started' },
    ]);
    expect(startedMachines(doc)).toEqual(['bbb']);
    expect(startedMachines(JSON.stringify([{ ID: 'ccc', State: 'started' }]))).toEqual(['ccc']);
  });

  // The 2026-09-03 incident. `started` is the wrong question for "is a machine already there":
  // Fly reports `created`, then `starting`, for the whole boot — 29.0s on the run that caught this,
  // 26.5s of it pulling the image. During that window startedMachines() is empty, the ADR 293
  // supervisor read liveCount 0 under desired:'live' as a crash, and launched a SECOND
  // performance-4x machine on top of a perfectly healthy start. Twitch refuses a second ingest on
  // one key, so one of the two died on `Input/output error` and the survivor was chosen by a race.
  it('occupiedMachines counts a machine that is still booting, which started does not', () => {
    const booting = JSON.stringify([{ id: 'aaa', state: 'created' }]);
    expect(startedMachines(booting)).toEqual([]);
    expect(occupiedMachines(booting)).toEqual(['aaa']);

    const starting = JSON.stringify([{ ID: 'bbb', State: 'starting' }]);
    expect(startedMachines(starting)).toEqual([]);
    expect(occupiedMachines(starting)).toEqual(['bbb']);
  });

  it('occupiedMachines still counts a started machine, and ignores ones that are truly gone', () => {
    const mixed = JSON.stringify([
      { id: 'gone', state: 'destroyed' },
      { id: 'off', state: 'stopped' },
      { id: 'dying', state: 'destroying' },
      { id: 'up', state: 'started' },
    ]);
    expect(occupiedMachines(mixed)).toEqual(['up']);
  });

  // A machine mid-replacement is still holding the Twitch key — launching beside it is the same
  // double-ingest as launching beside a booting one.
  it('occupiedMachines counts a replacing machine', () => {
    expect(occupiedMachines(JSON.stringify([{ id: 'r', state: 'replacing' }]))).toEqual(['r']);
  });

  // The trap this exists for: a rebuilt tag resolved to the PREVIOUS digest and two machines
  // silently streamed stale code. The LAST digest in the output is the one just pushed.
  it('takes the last digest in the build output', () => {
    const out = `--> pushing capture@sha256:${'1'.repeat(64)}\ndone capture@sha256:${'2'.repeat(64)}\n`;
    expect(parsePushedDigest(out)).toBe('sha256:' + '2'.repeat(64));
    expect(parsePushedDigest('no digest here')).toBeNull();
  });

  it('reads the machine id fly machine run prints', () => {
    expect(parseLaunchedMachine('Machine ID: d8d55d6a7e96e8\n')).toBe('d8d55d6a7e96e8');
    expect(parseLaunchedMachine('machine id: ABCDEF12345678')).toBe('abcdef12345678');
    expect(parseLaunchedMachine('no machine yet')).toBeNull();
  });

  // Status prints newest first. The destroy line has no exit_code, so the first match is the
  // crash, not the start underneath it (2026-10-16, machine 830722b7704158).
  it('takes the first Fly exit event and ignores a destroy line', () => {
    const text = [
      '2026-10-16T14:10:40Z stopped destroy flyd',
      '2026-10-16T14:10:39Z stopped crash flyd exit_code=-1,oom_killed=false,requested_stop=false',
      '2026-10-16T12:06:12Z started start flyd exit_code=0,oom_killed=false,requested_stop=true',
    ].join('\n');
    expect(parseFlyExit(text)).toEqual({ code: -1, oom: false, requestedStop: false });
    expect(formatFlyExit(parseFlyExit(text)!)).toBe('exit -1, not oom, not a requested stop');
    expect(parseFlyExit('no exit here')).toBeNull();
  });

  it('names oom and a requested stop when Fly says so', () => {
    const exit = parseFlyExit('exit_code=137,oom_killed=true,requested_stop=true');
    expect(exit).toEqual({ code: 137, oom: true, requestedStop: true });
    expect(formatFlyExit(exit!)).toBe('exit 137, oom, a requested stop');
  });
});

describe('probeUpgradeHost', () => {
  const listen = (handler: (req: unknown, socket: import('node:net').Socket) => void) =>
    new Promise<{ server: Server; port: number }>((resolve) => {
      const server = createServer();
      server.on('upgrade', handler);
      server.listen(0, '127.0.0.1', () =>
        resolve({ server, port: (server.address() as { port: number }).port }),
      );
    });

  it('reads a 403 from the ADR 040 gate as rejected', async () => {
    const { server, port } = await listen((_req, socket) => {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    await expect(probeUpgradeHost({ hostname: '127.0.0.1', port }, 'box.ts.net')).resolves.toBe(
      'rejected',
    );
    server.close();
  });

  it('reads anything the gate lets through as allowed', async () => {
    // A 400 from the WS layer still means the host gate passed — which is the thing under test.
    const { server, port } = await listen((_req, socket) => {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    await expect(probeUpgradeHost({ hostname: '127.0.0.1', port }, 'box.ts.net')).resolves.toBe(
      'allowed',
    );
    server.close();
  });

  it('says unreachable when nothing is listening', async () => {
    await expect(
      probeUpgradeHost({ hostname: '127.0.0.1', port: 1 }, 'box.ts.net', 500),
    ).resolves.toBe('unreachable');
  });
});

describe('runChecks', () => {
  it('passes everything on a green system', async () => {
    const checks = await runChecks(green);
    expect(checks.filter((c) => c.state !== 'ok')).toEqual([]);
  });

  it('gives every failure an exact fix — that is the whole point of doctor', async () => {
    const checks = await runChecks({ ...green, exec: () => absent, digest: null });
    for (const c of checks.filter((x) => x.state === 'fail')) {
      expect(c.fix, `${c.key} has no fix`).toBeTruthy();
    }
  });

  it('skips dependants instead of cascading red when tailscale is absent', async () => {
    const checks = await runChecks({ ...green, exec: greenExec({ tailscale: absent }) });
    expect(by(checks, 'tailscale').state).toBe('fail');
    for (const k of ['tailnet', 'serve', 'allowed-host']) {
      expect(by(checks, k).state, k).toBe('skip');
    }
    // Fly is an independent system — it must still be checked.
    expect(by(checks, 'fly').state).toBe('ok');
  });

  it('skips the app and secrets when flyctl is not authenticated', async () => {
    const checks = await runChecks({ ...green, exec: greenExec({ 'fly auth whoami': fail() }) });
    expect(by(checks, 'fly-auth').state).toBe('fail');
    expect(by(checks, 'app').state).toBe('skip');
    expect(by(checks, 'secrets').state).toBe('skip');
  });

  it('catches the ADR 040 gate and prescribes the allow-list command', async () => {
    const checks = await runChecks({ ...green, probeUpgrade: async () => 'rejected' as const });
    const c = by(checks, 'allowed-host');
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('ws_upgrade_rejected');
    // Both forms, because the container resolves the daemon by IP (Fly owns /etc/resolv.conf, so
    // MagicDNS never installs) — an allow-list carrying only the name still fails.
    expect(c.fix).toContain('musterd service install --allowed-hosts');
    expect(c.fix).toContain('nicks-laptop.tail400343.ts.net');
    expect(c.fix).toContain('100.100.246.14');
  });

  it('distinguishes a refusing daemon from an absent one', async () => {
    const checks = await runChecks({ ...green, probeUpgrade: async () => 'unreachable' as const });
    const c = by(checks, 'allowed-host');
    expect(c.state).toBe('fail');
    expect(c.fix).toContain('musterd service status');
    expect(c.fix).not.toContain('--allowed-hosts');
    // Reports what it OBSERVED (no answer), never a cause it could not distinguish. "Down" and
    // "unreachable from here" look identical to this probe; claiming the first would be a check
    // asserting more than its evidence, which is the failure mode doctor exists to end.
    expect(c.fix).toMatch(/no answer/);
    expect(c.fix).toMatch(/unreachable from here/);
    expect(c.fix).not.toMatch(/daemon is not answering/);
  });

  /**
   * The capture-node census. It is the only check here that is not a launch precondition — a pile
   * of dead nodes stops nothing — and it earns its place because the condition is otherwise only
   * visible in Tailscale's admin console. What matters is that healthy churn stays quiet: the
   * suffixes are CORRECT (tmpfs state, new node per run, hostname already taken), so a check that
   * reddened on seeing one would be wrong about the mechanism and would be ignored within a week.
   */
  describe('capture nodes', () => {
    const withPeers = (peers: Array<[string, boolean]>) => ({
      ...green,
      exec: greenExec({ 'tailscale status --json': ok(tsStatus(peers)) }),
    });

    it('is quiet when no capture node is registered', async () => {
      const c = by(await runChecks(withPeers([])), 'capture-nodes');
      expect(c.state).toBe('ok');
      expect(c.detail).toBe('none registered');
    });

    it('is quiet for a live node with a couple mid-reap behind it — that is health, not a leak', async () => {
      const c = by(
        await runChecks(
          withPeers([
            ['musterd-broadcast', false],
            ['musterd-broadcast-1', false],
            ['musterd-broadcast-2', true],
          ]),
        ),
        'capture-nodes',
      );
      expect(c.state).toBe('ok');
      expect(c.detail).toContain('3 on the tailnet, 2 offline');
      expect(c.fix).toBeUndefined();
    });

    it('fails past the point reap can explain, and names the one cause that can', async () => {
      const c = by(
        await runChecks(
          withPeers([
            ['musterd-broadcast', false],
            ['musterd-broadcast-1', false],
            ['musterd-broadcast-2', false],
            ['musterd-broadcast-3', true],
          ]),
        ),
        'capture-nodes',
      );
      expect(c.state).toBe('fail');
      expect(c.fix).toContain('not ephemeral');
      expect(c.fix).toContain('fly secrets set TS_AUTHKEY');
      // Never the value, only the instruction to mint one — same contract as the secrets check.
      expect(c.fix).not.toMatch(/tskey-/);
    });

    it('ignores a peer that merely starts with the capture name', async () => {
      const c = by(
        await runChecks(
          withPeers([
            ['musterd-broadcaster', false],
            ['musterd-broadcast-lab', false],
            ['nicks-laptop', true],
          ]),
        ),
        'capture-nodes',
      );
      expect(c.state).toBe('ok');
      expect(c.detail).toBe('none registered');
    });

    it('skips rather than claiming a clean tailnet when tailscale is absent', async () => {
      const checks = await runChecks({ ...green, exec: greenExec({ tailscale: absent }) });
      expect(by(checks, 'capture-nodes').state).toBe('skip');
    });
  });

  it('names the missing secret and never asks for a value it could print', async () => {
    const checks = await runChecks({
      ...green,
      exec: greenExec({
        'fly secrets list': ok(JSON.stringify([{ name: 'TS_AUTHKEY', digest: 'dc45' }])),
      }),
    });
    const c = by(checks, 'secrets');
    expect(c.state).toBe('fail');
    expect(c.fix).toContain('MUSTERD_STREAM_KEY=<twitch stream key>');
    expect(c.fix).not.toContain('TS_AUTHKEY=');
  });

  it('flags an unbuilt image and skips it outside a checkout', async () => {
    expect(by(await runChecks({ ...green, image: null }), 'image')).toMatchObject({
      state: 'fail',
      fix: 'musterd stream build',
    });
    expect(by(await runChecks({ ...green, repoRoot: null }), 'image').state).toBe('skip');
  });

  // The false green this record removes: a doctor that reports a digest without saying whose.
  it('says whether the MACHINE holds the image or merely this checkout', async () => {
    expect(by(await runChecks(green), 'image').detail).toContain('recorded for this machine');
    const legacy = await runChecks({
      ...green,
      image: { digest: 'sha256:' + 'b'.repeat(64), at: 1_000, source: 'checkout' as const },
    });
    expect(by(legacy, 'image').detail).toContain('this checkout only');
  });

  // 2026-10-15: doctor passed an image built 2026-10-12, before ADR 594 taught the box's CLI to hand
  // the page its seat, and every start crash-looped on "the broadcast page never reported ready".
  // An image is only as good as the capture code in it, so the check compares it with main.
  it('fails an image whose commit is behind main on the capture paths, naming the newest', async () => {
    const exec = greenExec({
      'git -C /repo log': ok(
        'e1d1541 ADR 594: broadcast-carries-its-own-observer\n9f0a2b3 fix(broadcast): x\n',
      ),
    });
    const c = by(await runChecks({ ...green, exec }), 'image');
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('2 capture commits behind origin/main');
    expect(c.detail).toContain('e1d1541 ADR 594');
    expect(c.fix).toBe('musterd stream build');
  });

  it('asks git only about the paths the box runs, from the commit the image was built at', async () => {
    const asked: string[] = [];
    const exec: Exec = (cmd, args) => {
      if (cmd === 'git') asked.push(args.join(' '));
      return greenExec()(cmd, args);
    };
    await runChecks({ ...green, exec });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('c0ffee0000000000000000000000000000000000..origin/main');
    for (const p of CAPTURE_PATHS) expect(asked[0]).toContain(p);
  });

  it('passes an up-to-date image and shows the commit it was built at', async () => {
    const c = by(await runChecks(green), 'image');
    expect(c.state).toBe('ok');
    expect(c.detail).toContain('c0ffee0');
  });

  it('fails an image recorded before builds recorded their commit — its age is unknowable', async () => {
    const { commit: _drop, ...noCommit } = green.image;
    const c = by(await runChecks({ ...green, image: noCommit }), 'image');
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('built before images recorded their commit');
    expect(c.fix).toBe('musterd stream build');
  });

  it('fails, rather than passing blind, when git cannot compare the commit with main', async () => {
    const exec = greenExec({ 'git -C /repo log': fail('fatal: bad revision') });
    const c = by(await runChecks({ ...green, exec }), 'image');
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('cannot compare');
  });
});

/** One digest per MACHINE, not one per checkout (2026-09-17, lane 01M2RAJ0JK).
 *
 * `.image-digest` lives in the checkout that built it, but streamwatch's LaunchAgent always resolves
 * the MAIN checkout — so the supervisor read a file the stream never wrote. The record now sits
 * beside `state.json`, where every checkout and the supervisor see the same one. The per-checkout
 * file stays readable as a migration fallback and nothing writes it any more. */
describe('the capture image record', () => {
  let dir: string;
  let repo: string;
  let statePath: string;
  const A = 'sha256:' + 'a'.repeat(64);
  const B = 'sha256:' + 'b'.repeat(64);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capture-image-'));
    repo = join(dir, 'checkout');
    mkdirSync(join(repo, 'scripts', 'broadcast'), { recursive: true });
    mkdirSync(join(dir, 'stream'), { recursive: true });
    statePath = join(dir, 'stream', 'state.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withCheckoutDigest = (d: string) =>
    writeFileSync(join(repo, 'scripts', 'broadcast', '.image-digest'), d + '\n');

  it('reads nothing when neither the machine record nor a checkout file exists', () => {
    expect(readCaptureImage({ statePath, repoRoot: repo })).toBeNull();
  });

  it('round-trips what `stream build` recorded, and remembers which checkout built it', () => {
    writeCaptureImage({ statePath, digest: A, repoRoot: repo, now: 1_000 });
    expect(readCaptureImage({ statePath, repoRoot: repo })).toEqual({
      digest: A,
      at: 1_000,
      source: 'machine',
      repo,
    });
  });

  it('round-trips the commit the image was built at', () => {
    writeCaptureImage({ statePath, digest: A, repoRoot: repo, now: 1_000, commit: 'abc1234def' });
    expect(readCaptureImage({ statePath, repoRoot: repo })?.commit).toBe('abc1234def');
  });

  // The whole point: the reader does not care which checkout it is standing in.
  it('a build in ONE checkout is visible from another — the bug this record exists to close', () => {
    const other = join(dir, 'worktree');
    mkdirSync(join(other, 'scripts', 'broadcast'), { recursive: true });
    writeCaptureImage({ statePath, digest: A, repoRoot: other, now: 2_000 });
    const seen = readCaptureImage({ statePath, repoRoot: repo }); // read from the OTHER checkout
    expect(seen?.digest).toBe(A);
    expect(seen?.source).toBe('machine');
  });

  it('falls back to this checkout’s legacy file when the machine record is absent', () => {
    withCheckoutDigest(B);
    const seen = readCaptureImage({ statePath, repoRoot: repo });
    expect(seen?.digest).toBe(B);
    expect(seen?.source).toBe('checkout');
    expect(seen?.at).toBeGreaterThan(0); // the file's mtime — the legacy age gate still needs it
  });

  it('the machine record WINS over a legacy checkout file that disagrees', () => {
    withCheckoutDigest(B);
    writeCaptureImage({ statePath, digest: A, repoRoot: repo, now: 3_000 });
    expect(readCaptureImage({ statePath, repoRoot: repo })?.digest).toBe(A);
  });

  it('survives a corrupt record by falling back rather than throwing', () => {
    withCheckoutDigest(B);
    writeFileSync(join(dir, 'stream', 'image.json'), '{not json');
    expect(readCaptureImage({ statePath, repoRoot: repo })?.digest).toBe(B);
  });

  it('refuses a record that is not a digest — a tag can resolve to a stale image', () => {
    writeFileSync(join(dir, 'stream', 'image.json'), JSON.stringify({ digest: 'capture', at: 1 }));
    expect(readCaptureImage({ statePath, repoRoot: repo })).toBeNull();
  });

  it('reads with no checkout at all (the supervisor outside a repo)', () => {
    writeCaptureImage({ statePath, digest: A, repoRoot: repo, now: 4_000 });
    expect(readCaptureImage({ statePath, repoRoot: null })?.digest).toBe(A);
  });
});

describe('stall signals (ADR 737)', () => {
  it('lastEncoderProgressAt reads the newest ffmpeg progress line, colour codes and all', () => {
    const logs = [
      '\x1b[2m2026-10-26T18:43:40Z\x1b[0m app[784161da167238] sjc [info]frame=17900 fps= 30 q=15.0 speed=1x',
      '2026-10-26T18:43:43Z app[784161da167238] sjc [info]{"t":599607,"frames":0}',
      '2026-10-26T18:43:44Z app[784161da167238] sjc [info]frame=18012 fps= 30 q=15.0 speed=1x',
    ].join('\n');
    expect(lastEncoderProgressAt(logs)).toBe(Date.parse('2026-10-26T18:43:44Z'));
  });

  it('lastEncoderProgressAt is null when the buffer holds no progress line', () => {
    expect(
      lastEncoderProgressAt('2026-10-26T18:43:43Z app[x] sjc [info]▸ tailnet up\n'),
    ).toBeNull();
  });

  it('machineCreatedAt reads the named machine only', () => {
    const json = JSON.stringify([
      { id: 'aaa', state: 'started', created_at: '2026-10-26T18:32:55Z' },
      { id: 'bbb', state: 'started' },
    ]);
    expect(machineCreatedAt(json, 'aaa')).toBe(Date.parse('2026-10-26T18:32:55Z'));
    expect(machineCreatedAt(json, 'bbb')).toBeNull();
    expect(machineCreatedAt('not json', 'aaa')).toBeNull();
  });
});
