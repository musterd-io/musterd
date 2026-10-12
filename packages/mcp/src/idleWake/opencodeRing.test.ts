import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectAdapterFor } from './inject.js';
import { opencodeRing } from './opencodeRing.js';

const LINE = '⚡ musterd [revive]: steer from ryder (steer) — read exactly it — pointer only';
const T = 5_000_000;

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-'));
  mkdirSync(join(dir, '.musterd'));
  return dir;
}

function stamp(dir: string, over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, '.musterd', 'opencode-plugin.json'),
    JSON.stringify({ generation: 5, pid: 1, status: 'idle', at: T, ...over }),
  );
}

/** A fake clock whose sleep advances it, and a hook that runs at each poll (the plugin's turn). */
function clock(onPoll: () => void = () => {}) {
  let t = T;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      onPoll();
      return Promise.resolve();
    },
    newSeq: () => 'seq1',
  };
}

describe('opencode ring inject (ADR 558 increment 3)', () => {
  it('is deaf by name with no plugin stamp, an old generation, or a stale stamp', () => {
    const dir = workspace();
    expect(opencodeRing(dir, clock()).probe()).toEqual({ ready: false, reason: 'no-plugin' });
    stamp(dir, { generation: 4 });
    expect(opencodeRing(dir, clock()).probe()).toEqual({ ready: false, reason: 'plugin-stale' });
    stamp(dir, { at: T - 91_000 });
    expect(opencodeRing(dir, clock()).probe()).toEqual({ ready: false, reason: 'plugin-gone' });
    stamp(dir);
    expect(opencodeRing(dir, clock()).probe()).toEqual({ ready: true });
  });

  it('writes the ring 0600 and returns the plugin ack for its seq', async () => {
    const dir = workspace();
    stamp(dir);
    const ack = join(dir, '.musterd', 'idle-ring-ack.json');
    writeFileSync(ack, JSON.stringify({ seq: 'older', ok: true, at: T }));
    let polls = 0;
    const r = await opencodeRing(
      dir,
      clock(() => {
        if (++polls === 3) writeFileSync(ack, JSON.stringify({ seq: 'seq1', ok: true, at: T }));
      }),
    ).inject(LINE);
    expect(r).toEqual({ ok: true });
    const ringPath = join(dir, '.musterd', 'idle-ring.json');
    expect(JSON.parse(readFileSync(ringPath, 'utf8'))).toEqual({ seq: 'seq1', line: LINE, at: T });
    expect(statSync(ringPath).mode & 0o777).toBe(0o600);
  });

  it('replaces a symlink planted at the ring path, never writing through it', async () => {
    const dir = workspace();
    stamp(dir);
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');
    const ringPath = join(dir, '.musterd', 'idle-ring.json');
    symlinkSync(victim, ringPath);
    await opencodeRing(dir, clock()).inject(LINE);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(lstatSync(ringPath).isSymbolicLink()).toBe(false);
  });

  it('passes the plugin refusal through, busy included', async () => {
    const dir = workspace();
    stamp(dir);
    const ack = join(dir, '.musterd', 'idle-ring-ack.json');
    const r = await opencodeRing(
      dir,
      clock(() =>
        writeFileSync(ack, JSON.stringify({ seq: 'seq1', ok: false, reason: 'busy', at: T })),
      ),
    ).inject(LINE);
    expect(r).toEqual({ ok: false, reason: 'busy' });
  });

  it('no ack within the timeout is a failure by name (the plugin is not watching)', async () => {
    const dir = workspace();
    stamp(dir);
    expect(await opencodeRing(dir, clock()).inject(LINE)).toEqual({ ok: false, reason: 'no-ack' });
  });

  it('does not write a ring while deaf', async () => {
    const dir = workspace();
    expect(await opencodeRing(dir, clock()).inject(LINE)).toEqual({
      ok: false,
      reason: 'no-plugin',
    });
    expect(() => statSync(join(dir, '.musterd', 'idle-ring.json'))).toThrow();
  });

  it('injectAdapterFor picks it for opencode, in the binding dir', () => {
    const dir = workspace();
    const a = injectAdapterFor('opencode', {}, dir);
    expect(a.harness).toBe('opencode');
    expect(a.probe()).toEqual({ ready: false, reason: 'no-plugin' });
  });
});
