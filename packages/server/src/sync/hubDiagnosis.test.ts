import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyFailure,
  diagnoseHubFailure,
  failureCode,
  isTailnetHost,
  parseTailscaleState,
  resetTailscaleCache,
  tailscaleState,
  type RunTailscale,
} from './hubDiagnosis.js';

const enoent = () => Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
const fetchFailed = (code: string) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

const stopped: RunTailscale = async () => ({
  stdout: '{"BackendState":"Stopped"}',
  failed: false,
  text: '',
});
const running: RunTailscale = async () => ({
  stdout: '{"BackendState":"Running"}',
  failed: false,
  text: '',
});

beforeEach(() => resetTailscaleCache());

describe('failureCode and classifyFailure', () => {
  it('reads the errno undici puts one level down', () => {
    expect(failureCode(fetchFailed('ECONNREFUSED'))).toBe('ECONNREFUSED');
    expect(classifyFailure('ECONNREFUSED', '')).toBe('refused');
  });

  it('names an AbortSignal timeout', () => {
    expect(failureCode(timeout())).toBe('TimeoutError');
    expect(classifyFailure('TimeoutError', '')).toBe('timeout');
  });

  it('sorts unroutable and DNS failures', () => {
    expect(classifyFailure('EHOSTUNREACH', '')).toBe('unroutable');
    expect(classifyFailure('ENETUNREACH', '')).toBe('unroutable');
    expect(classifyFailure('ENOTFOUND', '')).toBe('dns');
    expect(classifyFailure(null, 'TypeError: fetch failed')).toBe('other');
  });
});

describe('isTailnetHost', () => {
  it('is a CGNAT 100.64/10 address or a ts.net name', () => {
    expect(isTailnetHost('http://100.100.246.14:4849')).toBe(true);
    expect(isTailnetHost('http://hub.tail1234.ts.net:4849')).toBe(true);
    expect(isTailnetHost('http://100.63.0.1:4849')).toBe(false);
    expect(isTailnetHost('http://192.168.1.4:4849')).toBe(false);
    expect(isTailnetHost('http://hub.test:4849')).toBe(false);
  });
});

describe('tailscale state', () => {
  it('reads BackendState, and the stopped text when the command fails', () => {
    expect(
      parseTailscaleState({ stdout: '{"BackendState":"Running"}', failed: false, text: '' }),
    ).toBe('running');
    expect(
      parseTailscaleState({ stdout: '{"BackendState":"Stopped"}', failed: false, text: '' }),
    ).toBe('stopped');
    expect(parseTailscaleState({ stdout: '', failed: true, text: 'Tailscale is stopped.' })).toBe(
      'stopped',
    );
    expect(parseTailscaleState({ stdout: '', failed: true, text: 'something else' })).toBe(
      'unknown',
    );
  });

  it('is absent when no candidate exists, and is cached', async () => {
    const run = vi.fn<RunTailscale>(async () => {
      throw enoent();
    });
    let t = 1_000;
    expect(await tailscaleState(run, () => t)).toBe('absent');
    const calls = run.mock.calls.length;
    t += 5_000;
    expect(await tailscaleState(run, () => t)).toBe('absent');
    expect(run.mock.calls.length).toBe(calls);
  });

  it('tries the macOS app bundle when tailscale is not on PATH', async () => {
    const run: RunTailscale = async (bin) => {
      if (!bin.includes('Tailscale.app')) throw enoent();
      return { stdout: '{"BackendState":"Running"}', failed: false, text: '' };
    };
    expect(await tailscaleState(run)).toBe('running');
  });
});

describe('diagnoseHubFailure', () => {
  const tailnetHub = 'http://100.100.246.14:4849';

  it('a timeout to a tailnet hub with Tailscale stopped names it, and drops "may have received"', async () => {
    const msg = (await diagnoseHubFailure(tailnetHub, timeout(), stopped)).message;
    expect(msg).toContain('did not answer in time');
    expect(msg).toContain('Tailscale is stopped on this machine');
    expect(msg).toContain('tailscale up');
    expect(msg).toContain('nothing was recorded here');
    expect(msg).not.toContain('may have received');
  });

  it('a timeout with Tailscale running keeps the ADR 598 wording', async () => {
    const msg = (await diagnoseHubFailure(tailnetHub, timeout(), running)).message;
    expect(msg).not.toContain('Tailscale');
    expect(msg).toContain('read the board before retrying');
  });

  it('a tailnet hub with no tailscale command says so', async () => {
    const msg = (
      await diagnoseHubFailure(tailnetHub, timeout(), async () => {
        throw enoent();
      })
    ).message;
    expect(msg).toContain('no `tailscale` command was found');
  });

  it('never asks Tailscale for a hub that is not on a tailnet', async () => {
    const run = vi.fn<RunTailscale>(stopped);
    const err = await diagnoseHubFailure('http://hub.test:4849', fetchFailed('ECONNREFUSED'), run);
    expect(run).not.toHaveBeenCalled();
    expect(err.diagnosis).toEqual({ kind: 'refused', code: 'ECONNREFUSED', tailscale: null });
    expect(err.message).toContain('could not be reached');
    expect(err.message).toContain('is its daemon running?');
  });

  it('names an unroutable hub and a name that did not resolve', async () => {
    expect(
      (await diagnoseHubFailure('http://10.0.0.9:4849', fetchFailed('EHOSTUNREACH'))).message,
    ).toContain('no route to the hub (EHOSTUNREACH)');
    expect(
      (await diagnoseHubFailure('http://hub.test:4849', fetchFailed('ENOTFOUND'))).message,
    ).toContain('name did not resolve (ENOTFOUND)');
  });
});
