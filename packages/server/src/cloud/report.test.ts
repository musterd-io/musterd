import { afterEach, describe, expect, it, vi } from 'vitest';
import { addMember, mintCredential } from '../store/members.js';
import type { TeamRow } from '../store/rows.js';
import { createTeam } from '../store/teams.js';
import { bootCloud, hostRequest } from './testing.js';

/**
 * `GET /report` on Cloud (lane 01M3ZCTQ77). The 2026-10-03 load test (docs/perf/daemon-load-baseline.md)
 * found every viewer's refetch deriving the whole report inline through the pg pool — 1 346 full
 * derivations in 22 minutes — because the service that holds the cache was keyed by the request's
 * team-scoped handle, which Postgres mints fresh per request. On Cloud a team's viewers now share one
 * derivation per TTL, and each team's report is derived under that team's own scope.
 */

const viewer = async (
  seed: Parameters<typeof addMember>[0],
  team: TeamRow,
  name: string,
): Promise<string> => {
  const { row } = await addMember(seed, team, { name, kind: 'human', role: '' });
  return (await mintCredential(seed, row.id)).credential;
};

const report = async (url: string, slug: string, credential: string) => {
  const r = await hostRequest(url, `/teams/${slug}/report`, `${slug}.musterd.test`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  expect(r.status, r.body).toBe(200);
  return JSON.parse(r.body) as { team: string; generated_ts: number };
};

describe('cloud mode — GET /report is shared per team within its TTL (lane 01M3ZCTQ77)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("a team's viewers share one derivation, concurrent or sequential", async () => {
    const { s, seed, url } = await bootCloud();
    try {
      const alpha = await createTeam(seed!, { slug: 'alpha' });
      const ada = await viewer(seed!, alpha, 'ada');
      const bo = await viewer(seed!, alpha, 'bo');
      const burst = await Promise.all([
        report(url, 'alpha', ada),
        report(url, 'alpha', bo),
        report(url, 'alpha', ada),
      ]);
      await new Promise((r) => setTimeout(r, 25));
      const later = await report(url, 'alpha', bo);
      const stamps = new Set([...burst, later].map((x) => x.generated_ts));
      expect(stamps.size).toBe(1);
    } finally {
      await s.close();
    }
  });

  it("one team's cached report is never served to another team", async () => {
    const { s, seed, url } = await bootCloud();
    try {
      const alpha = await createTeam(seed!, { slug: 'alpha' });
      const beta = await createTeam(seed!, { slug: 'beta' });
      const a = await report(url, 'alpha', await viewer(seed!, alpha, 'ada'));
      const b = await report(url, 'beta', await viewer(seed!, beta, 'bea'));
      expect(a.team).toBe('alpha');
      expect(b.team).toBe('beta');
    } finally {
      await s.close();
    }
  });
});
