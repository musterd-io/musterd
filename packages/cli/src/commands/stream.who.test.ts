import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentSeatName } from './stream.js';

/**
 * Who `musterd stream start|stop` records as `by` (lane 01M3TDDDET).
 *
 * The incident: on 2026-09-30 miley ran `musterd stream stop` from miley's own workspace, and the
 * state file said "stopped by ryder" — the machine-global config's `current` identity, i.e. whoever
 * last claimed on this laptop. The stream must record the seat the invoking FOLDER resolves to, the
 * same answer `musterd whoami` gives there (ADR 442: a folder is the member it is bound to, or
 * nobody).
 */
describe('stream provenance names the invoking seat, not the laptop', () => {
  let root: string;
  let cwd: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'MUSTERD_CONFIG',
    'MUSTERD_TEAM',
    'MUSTERD_AGENT_KEY',
    'MUSTERD_CLAIM',
    'MUSTERD_SERVER',
  ];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-stream-who-')));
    cwd = process.cwd();
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // The laptop's global config last claimed as ryder — the identity the bug recorded.
    const config = join(root, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        server: 'http://127.0.0.1:1',
        current: 'revive',
        identities: {
          revive: { name: 'ryder', key: 'mskey_ryder000000000000000', surface: 'cli' },
        },
      }),
    );
    process.env['MUSTERD_CONFIG'] = config;
  });

  afterEach(() => {
    process.chdir(cwd);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('records the seat the workspace is bound to, even when the global config names another', () => {
    const dir = join(root, 'miley');
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:1',
        team: 'revive',
        claim: { mode: 'seat', name: 'miley' },
        seat_credential: 'msac_seat0000000000000000',
      }),
    );
    process.chdir(dir);
    expect(currentSeatName({})).toBe('miley');
  });

  it('says unknown from a folder bound to nobody, rather than borrowing the laptop identity', () => {
    const dir = join(root, 'unbound');
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    expect(currentSeatName({})).toBe('unknown');
  });
});
