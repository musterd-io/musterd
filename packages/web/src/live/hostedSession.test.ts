import { describe, expect, it, vi } from 'vitest';
import { probeHostedSession, refreshDelayMs, signOutHosted, SIGN_IN_PATH } from './hostedSession';

const NOW = 1_800_000_000_000;
const reply = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

describe('probeHostedSession (ADR 722 §3)', () => {
  it('asks POST /live/session/token, same-origin, with the cookie', async () => {
    const f = reply(401);
    await probeHostedSession(f as unknown as typeof fetch, () => NOW);
    expect(f).toHaveBeenCalledWith('/live/session/token', {
      method: 'POST',
      credentials: 'same-origin',
    });
  });

  it('a self-hosted daemon answers 404: today’s sign-in stays', async () => {
    expect(await probeHostedSession(reply(404) as unknown as typeof fetch)).toEqual({
      kind: 'self_hosted',
    });
  });

  it('an unreachable daemon is treated as self-hosted, never as signed out', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect(await probeHostedSession(f as unknown as typeof fetch)).toEqual({ kind: 'self_hosted' });
  });

  it('401 is a hosted team with no browser session', async () => {
    expect(await probeHostedSession(reply(401) as unknown as typeof fetch)).toEqual({
      kind: 'signed_out',
    });
  });

  it('200 is signed in, with the member and the token’s expiry', async () => {
    const f = reply(200, { as: 'ada', access_token: 'msat_x', expires_in: 900 });
    expect(await probeHostedSession(f as unknown as typeof fetch, () => NOW)).toEqual({
      kind: 'signed_in',
      as: 'ada',
      token: 'msat_x',
      expiresAt: NOW + 900_000,
    });
  });

  it('a 200 without a usable body is signed out, not a crash', async () => {
    for (const body of [{}, { as: 'ada' }, { as: 'ada', access_token: 'x', expires_in: 900 }, 'no'])
      expect(await probeHostedSession(reply(200, body) as unknown as typeof fetch)).toEqual({
        kind: 'signed_out',
      });
  });
});

describe('refreshDelayMs', () => {
  it('refreshes a minute before expiry, and at once when that has passed', () => {
    expect(refreshDelayMs({ expiresAt: NOW + 900_000 }, NOW)).toBe(840_000);
    expect(refreshDelayMs({ expiresAt: NOW + 30_000 }, NOW)).toBe(0);
  });
});

describe('signOutHosted', () => {
  it('POSTs /live/signout same-origin', async () => {
    const f = reply(204);
    await signOutHosted(f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith('/live/signout', { method: 'POST', credentials: 'same-origin' });
  });

  it('the sign-in button goes to the team’s own start route', () => {
    expect(SIGN_IN_PATH).toBe('/live/signin/start');
  });
});
