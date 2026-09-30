import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { findBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import { buildProvisioner, hostCommand } from './host.js';

/** ADR 463 §3 — how `musterd host` decides it is a sponsor's host, and runs the provisioner. */
let repo: string;
let regFile: string;
const savedReg = process.env['MUSTERD_HOST_REGISTRY'];

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-host-prov-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  regFile = join(repo, 'registry.json');
  writeFileSync(regFile, JSON.stringify({ entries: [] }));
  process.env['MUSTERD_HOST_REGISTRY'] = regFile;
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  if (savedReg === undefined) delete process.env['MUSTERD_HOST_REGISTRY'];
  else process.env['MUSTERD_HOST_REGISTRY'] = savedReg;
});

const bind = (over: Record<string, unknown> = {}) =>
  saveBinding(repo, {
    version: 2,
    server: 'http://localhost:4849',
    team: 'acme',
    agent_key: 'mscr_dana',
    claim: { mode: 'seat', name: 'dana' },
    ...over,
  } as never);

function seams(mint = vi.fn(async () => ({ credential: {} as never, agent_key: 'msak_host' }))) {
  const claim = vi.fn(async () => ({ provisions: [] }));
  return {
    mint,
    claim,
    opts: {
      cwd: repo,
      hostLabel: 'dana-mbp',
      resolveIdentity: (() => ({
        team: 'acme',
        http: { mintBootstrapCredential: mint },
      })) as never,
      clientFor: () => ({ claimProvisions: claim, reportProvision: vi.fn() }) as never,
    },
  };
}

describe('buildProvisioner (ADR 463 §3)', () => {
  it('mints one host credential, keeps it in the binding, and ticks under this host label', async () => {
    bind();
    const s = seams();
    const log = vi.fn();
    const tick = await buildProvisioner(parseArgs([]), log, s.opts);
    expect(tick).not.toBeNull();
    expect(s.mint).toHaveBeenCalledWith('acme', {
      use: 'host',
      target: 'dana-mbp',
      label: 'provision:dana-mbp',
    });
    expect(findBinding(repo, {})?.host_key).toBe('msak_host');
    await tick!();
    expect(s.claim).toHaveBeenCalledWith('acme', 'dana-mbp');
    // Built again, the kept credential is reused — never a second mint.
    await buildProvisioner(parseArgs([]), log, s.opts);
    expect(s.mint).toHaveBeenCalledTimes(1);
  });

  it('is off, silently, in a folder with no binding or outside a repo', async () => {
    const s = seams();
    const log = vi.fn();
    expect(await buildProvisioner(parseArgs([]), log, s.opts)).toBeNull(); // no binding yet
    bind();
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-not-a-repo-')));
    try {
      saveBinding(bare, findBinding(repo, {})!);
      expect(await buildProvisioner(parseArgs([]), log, { ...s.opts, cwd: bare })).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    expect(log).not.toHaveBeenCalled();
    expect(s.mint).not.toHaveBeenCalled();
  });

  it('is off, silently, when the daemon refuses the host credential (not a sponsor’s folder)', async () => {
    bind();
    const s = seams(
      vi.fn(async () => {
        throw new CliError('forbidden', 4, 'forbidden');
      }),
    );
    const log = vi.fn();
    expect(await buildProvisioner(parseArgs([]), log, s.opts)).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(findBinding(repo, {})?.host_key).toBeUndefined();
  });

  it('says so for a failure that is not an expected refusal', async () => {
    bind();
    const s = seams(
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    const log = vi.fn();
    expect(await buildProvisioner(parseArgs([]), log, s.opts)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('provisioning is off: ECONNRESET'));
  });
});

describe('musterd host runs the provisioner each tick', () => {
  const quiet = {
    backends: new Map(),
    log: vi.fn(),
    doorbell: false,
    loadRegistry: () => ({ entries: [] }),
  };

  it('--once runs the provisioner alongside the wake poll, and does not exit on an empty registry', async () => {
    const provisioner = vi.fn(async () => ({ claimed: 0, ready: 0, failed: 0 }));
    const code = await hostCommand(parseArgs(['--once']), { ...quiet, provisioner } as never);
    expect(code).toBe(0);
    expect(provisioner).toHaveBeenCalledTimes(1);
  });

  it('--no-provision never builds or runs it', async () => {
    const provisioner = vi.fn(async () => ({ claimed: 0, ready: 0, failed: 0 }));
    const code = await hostCommand(parseArgs(['--once', '--no-provision']), {
      ...quiet,
      provisioner,
    } as never);
    expect(provisioner).not.toHaveBeenCalled();
    expect(code).toBe(1); // nothing registered and nothing to provision: the old empty-registry exit
  });

  it('a provisioner that throws never stops the wake half', async () => {
    const log = vi.fn();
    const provisioner = vi.fn(async () => {
      throw new Error('clone failed');
    });
    const code = await hostCommand(parseArgs(['--once']), {
      ...quiet,
      log,
      provisioner,
    } as never);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('provision tick failed: clone failed'),
    );
  });
});

/** Lane 01M3QTE5235VK1NNQBSSZ28ZZ1: `musterd host <anything but provisions>` must not start an actuator. */
describe('musterd host — unknown positional', () => {
  it('refuses `host status` with a usage error instead of polling as a second actuator', async () => {
    const log = vi.fn();
    await expect(
      hostCommand(parseArgs(['status']), {
        backends: new Map(),
        log,
        doorbell: false,
        provisioner: null,
        loadRegistry: () => ({ entries: [] }),
      } as never),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(log).not.toHaveBeenCalled();
  });

  it('names what it does accept', async () => {
    await expect(
      hostCommand(parseArgs(['statsu']), { provisioner: null, doorbell: false } as never),
    ).rejects.toThrow(/musterd host \[provisions\]/);
  });
});
