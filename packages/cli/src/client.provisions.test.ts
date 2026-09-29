import type { HostProvision } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.js';
import { CliError } from './errors.js';

/** ADR 463 §2 — the host's two provision routes, typed and parsed at the boundary. */
const provision: HostProvision = {
  id: '01PROV',
  team: 'acme',
  agent: 'dana-scout',
  sponsor: 'dana',
  host: 'dana-mbp',
  state: 'claimed',
  claimed_by: 'dana-mbp',
  claimed_at: 1000,
  ready_at: null,
  failed_reason: null,
  created_at: 900,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HttpClient provisions (ADR 463 §2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('claims by host label and parses the response', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ provisions: [provision] }));
    vi.stubGlobal('fetch', fetchFn);
    const r = await new HttpClient({ server: 'http://x' }).claimProvisions('acme', 'dana-mbp');
    expect(r.provisions).toEqual([provision]);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://x/teams/acme/host/provisions');
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse((fetchFn.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      host: 'dana-mbp',
    });
  });

  it('reports ready and failed to the provision’s own route', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ provision: { ...provision, state: 'ready', ready_at: 2000 } }))
      .mockResolvedValueOnce(
        json({ provision: { ...provision, state: 'failed', failed_reason: 'worktree' } }),
      );
    vi.stubGlobal('fetch', fetchFn);
    const client = new HttpClient({ server: 'http://x' });
    expect(
      (await client.reportProvision('acme', '01PROV', { state: 'ready' })).provision.state,
    ).toBe('ready');
    await client.reportProvision('acme', '01PROV', { state: 'failed', reason: 'worktree' });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://x/teams/acme/host/provisions/01PROV/report');
    expect(JSON.parse((fetchFn.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      state: 'failed',
      reason: 'worktree',
    });
  });

  it('refuses a response that does not match the protocol schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ provisions: [{ id: 1 }] })));
    await expect(
      new HttpClient({ server: 'http://x' }).claimProvisions('acme', 'h'),
    ).rejects.toBeInstanceOf(CliError);
  });
});
