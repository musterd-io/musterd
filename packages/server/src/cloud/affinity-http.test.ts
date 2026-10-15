import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ownerFor } from './affinity.js';
import { bootCloud } from './testing.js';

/**
 * ADR 608 — on Cloud a team's requests and sockets are served by the machine that owns the team;
 * every other machine answers `fly-replay: instance=<owner>` and the proxy replays the request.
 */

function raw(
  url: string,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { host, ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

describe('ADR 608 — team affinity on Cloud', () => {
  afterEach(() => vi.unstubAllEnvs());
  const machines = ['m-a', 'm-b'];
  const owner = ownerFor('revive', machines)!;
  const other = machines.find((m) => m !== owner)!;

  it('a non-owner replays a team request and a team socket; serves global routes and replayed requests', async () => {
    const { s, url } = await bootCloud(
      {},
      { affinity: { self: other, machines: async () => machines } },
    );
    try {
      await new Promise((r) => setTimeout(r, 20));
      const team = await raw(url, '/teams/revive/messages', 'revive.musterd.test');
      expect(team.status).toBe(307);
      expect(team.headers['fly-replay']).toBe(`instance=${owner}`);

      // Already replayed once (the proxy stamps fly-replay-src): served here, whatever the list says.
      const again = await raw(url, '/teams/revive/messages', 'revive.musterd.test', {
        'fly-replay-src': `instance=${owner};state=;t=1`,
      });
      expect(again.headers['fly-replay']).toBeUndefined();
      expect(again.status).not.toBe(307);
      // A spoofed source (no such machine) does not bypass the owner.
      const spoof = await raw(url, '/teams/revive/messages', 'revive.musterd.test', {
        'fly-replay-src': 'instance=m-z;state=;t=1',
      });
      expect(spoof.status).toBe(307);

      // Global routes never move.
      const health = await raw(url, '/health', 'health.musterd.test');
      expect(health.headers['fly-replay']).toBeUndefined();
      expect([200, 503]).toContain(health.status);

      // The WebSocket upgrade for the team gets the same answer.
      const upgrade = await new Promise<{ status: number; replay: string | undefined }>(
        (resolve) => {
          const ws = new WebSocket(url.replace('http', 'ws') + '/ws', {
            headers: { host: 'revive.musterd.test' },
          });
          ws.on('unexpected-response', (_req, res) => {
            resolve({ status: res.statusCode ?? 0, replay: res.headers['fly-replay'] as string });
            res.resume();
          });
          ws.on('open', () => resolve({ status: 101, replay: undefined }));
          ws.on('error', () => undefined);
        },
      );
      expect(upgrade.status).toBe(307);
      expect(upgrade.replay).toBe(`instance=${owner}`);
    } finally {
      await s.close();
    }
  });

  it('the owner serves the team itself, and with affinity off everything is local', async () => {
    const own = await bootCloud({}, { affinity: { self: owner, machines: async () => machines } });
    try {
      await new Promise((r) => setTimeout(r, 20));
      const r = await raw(own.url, '/teams/revive/messages', 'revive.musterd.test');
      expect(r.headers['fly-replay']).toBeUndefined();
      expect(r.status).not.toBe(307);
    } finally {
      await own.s.close();
    }
    const off = await bootCloud({}, { affinity: { self: null, machines: async () => machines } });
    try {
      const r = await raw(off.url, '/teams/revive/messages', 'revive.musterd.test');
      expect(r.headers['fly-replay']).toBeUndefined();
    } finally {
      await off.s.close();
    }
  });
});
