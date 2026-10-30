import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.js';
import { schemaError } from './errors.js';

/*
 * A reply that does not match the protocol schema is most often skew — a stale CLI against a newer
 * daemon, or the reverse — so the error says which builds are in play and what to do about it
 * (ADR 135), not only "did not match the protocol schema".
 */

const issue = { issues: [{ path: ['members', 0, 'kind'], message: 'Invalid enum value' }] };

describe('schemaError names the builds', () => {
  it('different builds: names both and the fix', () => {
    const msg = schemaError(issue, 'roster', { cli: 'aaaaaaa1111', daemon: 'bbbbbbb2222' }).message;
    expect(msg).toContain(
      'roster response did not match the protocol schema (field: members.0.kind',
    );
    expect(msg).toContain('your CLI build (aaaaaaa) differs from the daemon (bbbbbbb)');
    expect(msg).toContain('rebuild your checkout (pnpm build)');
  });

  it('the same build, a -dirty marker aside: the builds agree', () => {
    const msg = schemaError(issue, 'roster', {
      cli: 'ccccccc3333-dirty',
      daemon: 'ccccccc3333',
    }).message;
    expect(msg).toContain('the CLI and the daemon both run ccccccc; the builds agree');
  });

  it('only the CLI build known: says where the daemon build is shown', () => {
    const msg = schemaError(issue, 'roster', { cli: 'ddddddd4444' }).message;
    expect(msg).toContain(
      "CLI build ddddddd; `musterd status` names the daemon's when they differ",
    );
  });

  it('neither known: names the commands that show them', () => {
    expect(schemaError(issue, 'roster').message).toContain(
      '`musterd --version` and `musterd status` name the builds',
    );
  });

  it('exit 1, and no response value ever reaches the message', () => {
    const err = schemaError({ issues: [{ path: ['token'], message: 'Expected string' }] }, 'grant');
    expect(err.exitCode).toBe(1);
    expect(err.message).not.toContain('mskey_');
  });
});

describe('HttpClient reads the daemon build back on a schema mismatch', () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it("puts the daemon's /health build in the message", async () => {
    const fn = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/health')
          ? json({ ok: true, v: '0', build: 'eeeeeee5555' })
          : json({ nope: 1 }),
      ),
    );
    vi.stubGlobal('fetch', fn);
    const client = new HttpClient({ server: 'http://x', key: 'mskey_team', seat: 'miley' });
    const err = (await client.next('revive').catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^next response did not match the protocol schema/);
    expect(err.message).toMatch(/eeeeeee/);
    expect(fn.mock.calls.some(([u]) => String(u).endsWith('/health'))).toBe(true);
  });

  it('still fails cleanly when /health cannot be read', async () => {
    const fn = vi.fn((url: string) =>
      url.endsWith('/health')
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(json({ nope: 1 })),
    );
    vi.stubGlobal('fetch', fn);
    const client = new HttpClient({ server: 'http://x', key: 'mskey_team', seat: 'miley' });
    const err = (await client.next('revive').catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^next response did not match the protocol schema/);
    expect(err.message).toMatch(/musterd status/);
  });
});
