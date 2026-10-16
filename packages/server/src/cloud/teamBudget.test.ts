import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openTestDriver, testCloudPools } from '../db/testing.js';
import { createServer } from '../index.js';
import {
  CLOUD_TEAM_BUDGET_PER_MIN,
  TEAM_BUDGET_MAX_KEYS,
  TEAM_BUDGET_MESSAGE,
  TEAM_BUDGET_WINDOW_MS,
  __resetTeamBudgetForTest,
  __teamBudgetSizeForTest,
  takeTeamRequest,
} from './teamBudget.js';
import { stubCloudEnv } from './testing.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

beforeEach(() => __resetTeamBudgetForTest());
afterEach(() => {
  __resetTeamBudgetForTest();
  vi.unstubAllEnvs();
});

describe('takeTeamRequest', () => {
  it('admits a second team after the first is over its budget', () => {
    expect(takeTeamRequest('alpha', 1, 0)).toBe(true);
    expect(takeTeamRequest('alpha', 1, 1)).toBe(false);
    expect(takeTeamRequest('bravo', 1, 1)).toBe(true);
  });

  it('folds the slug and does not spend a slot on a denial', () => {
    expect(takeTeamRequest('Alpha', 1, 0)).toBe(true);
    expect(takeTeamRequest('alpha', 1, 1)).toBe(false);
    expect(takeTeamRequest('alpha', 1, 2)).toBe(false);
    expect(takeTeamRequest('alpha', 1, TEAM_BUDGET_WINDOW_MS + 1)).toBe(true);
    expect(takeTeamRequest('alpha', 1, TEAM_BUDGET_WINDOW_MS + 2)).toBe(false);
  });

  it('keeps at most TEAM_BUDGET_MAX_KEYS keys, and the newest team stays admitted', () => {
    for (let i = 0; i < TEAM_BUDGET_MAX_KEYS; i++)
      expect(takeTeamRequest(`t${i}`, 1, 1_000)).toBe(true);
    expect(__teamBudgetSizeForTest()).toBe(TEAM_BUDGET_MAX_KEYS);
    expect(takeTeamRequest('overflow', 1, 1_000)).toBe(true);
    expect(__teamBudgetSizeForTest()).toBeLessThanOrEqual(TEAM_BUDGET_MAX_KEYS);
    expect(takeTeamRequest('overflow', 1, 1_001)).toBe(false);
  });
});

interface Reply {
  status: number;
  body: string;
  retryAfter: string | undefined;
}

function ask(url: string, path: string, host: string): Promise<Reply> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { host } },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            retryAfter: res.headers['retry-after'] as string | undefined,
          }),
        );
      },
    );
    r.on('error', reject);
    r.end();
  });
}

function upgrade(port: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) }, () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    const finish = () => {
      sock.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    sock.on('data', (c: Buffer) => {
      chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      if (
        text.includes('\r\n\r\n') &&
        (text.startsWith('HTTP/1.1 101') || text.includes('rate_limited'))
      )
        finish();
    });
    sock.setTimeout(1_000, finish);
    sock.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ECONNRESET') reject(e);
    });
  });
}

describe('one team over budget does not hold the pool', () => {
  it('returns 429 while an in-budget checkout is still pending, and the other team reaches connect', async () => {
    stubCloudEnv({ MUSTERD_CLOUD_TEAM_BUDGET_PER_MIN: '2' });
    await openTestDriver('pglite');
    await openTestDriver('pglite', { store: 'trace' });
    const pools = (await testCloudPools()).factories;
    let hang = false;
    let connects = 0;
    const hung: Array<(err: Error) => void> = [];
    const main = (u: string) => {
      const p = pools.main(u);
      return {
        connect: () => {
          connects += 1;
          if (!hang) return p.connect();
          return new Promise<never>((_resolve, reject) => {
            hung.push(reject);
          });
        },
        end: () => p.end(),
      };
    };
    const s = createServer({ cloudPools: { ...pools, main }, rosterRoots: [], port: 0 });
    const inflight: Promise<unknown>[] = [];
    const track = (p: Promise<unknown>) => {
      inflight.push(
        p.then(
          () => undefined,
          () => undefined,
        ),
      );
    };
    try {
      await s.listen();
      const url = `http://127.0.0.1:${s.port}`;
      // A global route on a team-shaped host is not charged.
      expect((await ask(url, '/health', 'alpha.musterd.test')).status).toBe(200);
      hang = true;
      const baseline = connects;

      track(ask(url, '/teams/alpha/members', 'alpha.musterd.test'));
      await vi.waitFor(() => expect(connects).toBe(baseline + 1));
      track(ask(url, '/teams/alpha/members', 'alpha.musterd.test'));
      await vi.waitFor(() => expect(connects).toBe(baseline + 2));

      const started = Date.now();
      const denied = await ask(url, '/teams/alpha/members', 'alpha.musterd.test');
      expect(Date.now() - started).toBeLessThan(200);
      expect(denied.status).toBe(429);
      expect(denied.retryAfter).toBe('60');
      expect(JSON.parse(denied.body)).toEqual({
        error: { code: 'rate_limited', message: TEAM_BUDGET_MESSAGE },
      });
      expect(denied.body).not.toContain('alpha');
      expect(connects).toBe(baseline + 2);

      track(ask(url, '/teams/bravo/members', 'bravo.musterd.test'));
      await vi.waitFor(() => expect(connects).toBe(baseline + 3));

      const wsAlpha = await upgrade(String(s.port), 'alpha.musterd.test');
      expect(wsAlpha).toContain('429');
      expect(wsAlpha).toContain('Retry-After: 60');
      expect(wsAlpha).toContain(TEAM_BUDGET_MESSAGE);
      expect(connects).toBe(baseline + 3);

      const wsBravo = await upgrade(String(s.port), 'bravo.musterd.test');
      expect(wsBravo.startsWith('HTTP/1.1 101')).toBe(true);
    } finally {
      for (const reject of hung) reject(new Error('closed'));
      await Promise.all(inflight);
      await s.close();
    }
  });
});

describe('edge rule', () => {
  it('matches the server budget and keys the team host, with the mandatory colo characteristic', () => {
    const rule = JSON.parse(
      readFileSync(join(repoRoot, 'deploy/cloud/per-team-rate-limit.json'), 'utf8'),
    ) as {
      expression: string;
      action: string;
      ratelimit: {
        characteristics: string[];
        period: number;
        requests_per_period: number;
        mitigation_timeout: number;
      };
      action_parameters: {
        response: { status_code: number; content_type: string; content: string };
      };
    };
    const fly = readFileSync(join(repoRoot, 'deploy/cloud/fly.toml'), 'utf8');
    const suffix = /MUSTERD_CLOUD_HOST_SUFFIX = "([^"]+)"/.exec(fly)?.[1];
    expect(suffix).toBe('musterd.dev');
    expect(CLOUD_TEAM_BUDGET_PER_MIN).toBe(600);
    expect(rule.ratelimit.requests_per_period).toBe(CLOUD_TEAM_BUDGET_PER_MIN);
    expect(rule.ratelimit.period).toBe(60);
    expect(rule.ratelimit.mitigation_timeout).toBe(60);
    expect(rule.ratelimit.characteristics).toEqual(['cf.colo.id', 'http.host']);
    expect(rule.ratelimit.characteristics).not.toContain('ip.src');
    // The rules language treats `.` as any character, so the suffix's dot is escaped.
    expect(rule.expression).toContain((suffix ?? '').replaceAll('.', String.raw`\.`));
    expect(rule.expression).not.toContain('cf.colo.id');
    expect(rule.expression).not.toContain('ip.src');
    expect(rule.action).toBe('block');
    expect(rule.action_parameters.response.status_code).toBe(429);
    expect(rule.action_parameters.response.content_type).toBe('application/json');
    expect(JSON.parse(rule.action_parameters.response.content)).toEqual({
      error: { code: 'rate_limited', message: TEAM_BUDGET_MESSAGE },
    });
  });
});
