import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, isDaemonUnreachable } from './client.js';
import {
  CliError,
  RETRY_DELAYS_MS,
  connectionNeverEstablished,
  transportError,
  worthRetrying,
} from './errors.js';

/*
 * The CLI carries acts for hooks and humans over the same HTTP path the MCP adapter uses, so it needs
 * the same tolerance for the ~849ms daemon-bounce outage (lane 01KYR0D28Z). It also has the tighter
 * constraint: the harness invokes it in a fresh short-lived process at every tool boundary, so a read
 * must never pay the retry budget.
 */

/** Node's fetch shape: the useful code lives on `cause`, never in the message. */
function fetchError(code: string): TypeError {
  const err = new TypeError('fetch failed');
  (err as unknown as { cause: { code: string } }).cause = { code };
  return err;
}

const okResponse = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const client = () => new HttpClient({ server: 'http://x', key: 'mskey_team', seat: 'miley' });

/** A write (POST /inbox/cursor) — the class whose loss actually damages state. */
const write = () => client().markRead('revive', '01KYR0D28ZJEXTB7TM0N95191S');

describe('HttpClient retries a WRITE across a daemon bounce', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries a refused connection instead of reporting the daemon down', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(fetchError('ECONNREFUSED'))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fn);

    await expect(write()).resolves.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('NEVER retries a reset connection — it may already have been processed', async () => {
    const fn = vi.fn().mockRejectedValue(fetchError('ECONNRESET'));
    vi.stubGlobal('fetch', fn);

    await expect(write()).rejects.toThrow(/may or may not have happened/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still reports the friendly unreachable error once the budget is spent', async () => {
    const fn = vi.fn().mockRejectedValue(fetchError('ECONNREFUSED'));
    vi.stubGlobal('fetch', fn);

    // The retry must not swallow the diagnosis a human depends on when the daemon really is stopped.
    await expect(write()).rejects.toThrow(/is the daemon running/);
    expect(fn).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
  });
});

describe('an interrupted WRITE says its outcome is unknown, not that the daemon is down', () => {
  afterEach(() => vi.unstubAllGlobals());

  const failure = async (err: unknown) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    return (await write().catch((e: unknown) => e)) as CliError;
  };

  it('names the route and how to check, exit 7, for a reset connection', async () => {
    const err = await failure(fetchError('ECONNRESET'));
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).toBe(7);
    expect(err.message).toMatch(/^POST \/teams\/revive\/\S+ lost its connection to http:\/\/x/);
    expect(err.message).toContain('may or may not have happened');
    expect(err.message).toContain('Check before re-running it');
    expect(err.message).not.toMatch(/is the daemon running/);
    // An interrupted write is not an unreachable daemon: best-effort probes must not read it as one.
    expect(isDaemonUnreachable(err)).toBe(false);
  });

  it('treats a timed-out write the same way — a slow server may still have acted', async () => {
    const err = await failure(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );
    expect(err.message).toContain('may or may not have happened');
  });

  it('keeps the plain unreachable error for a write that never connected', async () => {
    const err = await failure(fetchError('ENOTFOUND'));
    expect(err.message).toMatch(/can't reach the daemon at http:\/\/x/);
    expect(isDaemonUnreachable(err)).toBe(true);
  });

  it('rethrows a failure that is not a transport error untouched', () => {
    const boom = new Error('boom');
    expect(transportError(boom, 'POST', 'http://x', '/a')).toBeUndefined();
  });

  it('names the path, never the query string', () => {
    const err = transportError(fetchError('ECONNRESET'), 'POST', 'http://x', '/a/b?token=t');
    expect(err?.message).toContain('POST /a/b lost');
    expect(err?.message).not.toContain('token');
  });
});

describe('a READ fails fast, so the tool-boundary hook stays instant', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not retry a refused GET', async () => {
    const fn = vi.fn().mockRejectedValue(fetchError('ECONNREFUSED'));
    vi.stubGlobal('fetch', fn);

    await expect(client().roster('revive')).rejects.toThrow(/can't reach the daemon/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('classifies the hot interrupt-check path as not-worth-retrying', () => {
    // `GET /inbox/interrupt-check` runs at every tool boundary (ADR 088) in its own process, so an
    // in-process circuit breaker cannot spare it — only excluding reads can.
    expect(worthRetrying('GET')).toBe(false);
    expect(worthRetrying('POST')).toBe(true);
  });
});

describe('connectionNeverEstablished is narrower than isConnRefused', () => {
  it('accepts a refusal and rejects a reset, which the message text cannot distinguish', () => {
    expect(connectionNeverEstablished(fetchError('ECONNREFUSED'))).toBe(true);
    expect(connectionNeverEstablished(fetchError('ECONNRESET'))).toBe(false);
    // Both carry the identical message, which is exactly why a text match is the wrong predicate.
    expect(fetchError('ECONNREFUSED').message).toBe(fetchError('ECONNRESET').message);
  });

  it('rejects a timeout abort — a slow server is not a missing one', () => {
    expect(connectionNeverEstablished(new DOMException('timed out', 'TimeoutError'))).toBe(false);
    expect(connectionNeverEstablished(undefined)).toBe(false);
  });
});

describe('HttpClient names a non-JSON reply instead of throwing a bare SyntaxError', () => {
  afterEach(() => vi.unstubAllGlobals());

  const htmlPage = (status: number) =>
    new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

  it('reports the method, route, status and content-type of an HTML error page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlPage(502)));
    const err = await write().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^POST \/teams\/revive\/.+ answered HTTP 502 with text\/html, not JSON/);
    expect(msg).toContain('in front of the team server at http://x');
    expect(msg).toContain('"<!DOCTYPE html>');
    expect(msg).not.toMatch(/Unexpected token/);
  });

  it('says so even when the page arrives with a 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlPage(200)));
    await expect(write()).rejects.toThrow(/answered HTTP 200 with text\/html, not JSON/);
  });
});
