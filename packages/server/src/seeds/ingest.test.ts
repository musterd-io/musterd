import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RelaySeed } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { saveNodeEnrollment } from '../node/state.js';
import { listLanes } from '../store/lanes.js';
import { addMember } from '../store/members.js';
import { localNodeForTeam } from '../store/messages.js';
import { listSeeds } from '../store/seeds.js';
import { createTeam, setPolicy } from '../store/teams.js';
import { Hub } from '../transport/hub.js';
import { ingestTeamSeeds } from './ingest.js';

let openStore: () => Promise<Driver>;

withDrivers('ingest', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  async function relaySeed(overrides: Partial<RelaySeed> = {}): Promise<RelaySeed> {
    return {
      id: '00001785979000000-aaaa',
      body: 'try a seeds relay',
      ts: 1_785_979_000_000,
      source: 'slack',
      meta: { user: 'U123' },
      ...overrides,
    };
  }

  describe('ingestTeamSeeds (through the DB)', () => {
    let db: Database;
    let ctx: Ctx;

    beforeEach(async () => {
      db = await openStore();
      ctx = { db: db, hub: new Hub(), config: resolveConfig(), rosterRoots: [] };
    });

    afterEach(() => {
      vi.restoreAllMocks();
      db.close();
    });

    async function seedTeam(withPolicy = true) {
      const team = await createTeam(db, { slug: 'bravo' });
      await addMember(db, team, { name: 'nick', kind: 'human', slackUserId: 'U123' });
      await addMember(db, team, { name: 'stanley', kind: 'agent' });
      if (withPolicy) {
        await setPolicy(db, team.id, {
          seeds_relay_url: 'https://relay.example',
          seeds_relay_token: 'tok',
        });
      }
      return team;
    }

    async function mockRelay(batches: unknown[][]) {
      let call = 0;
      return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        const seeds = batches[Math.min(call, batches.length - 1)] ?? [];
        call += 1;
        return Promise.resolve(new Response(JSON.stringify({ seeds }), { status: 200 }));
      });
    }

    it('creates one shared Seed per Slack record, opens no Lane, and advances the cursor', async () => {
      const team = await seedTeam();
      const fetchSpy = await mockRelay([
        [
          await relaySeed({ id: '00001-a', body: 'first idea' }),
          await relaySeed({ id: '00002-b', body: 'second idea' }),
        ],
        [],
      ]);

      expect(await ingestTeamSeeds(ctx, team)).toBe(2);
      expect(
        (await listSeeds(db, team.id)).sort((a, b) => a.relay_id.localeCompare(b.relay_id)),
      ).toMatchObject([
        { relay_id: '00001-a', submitted_by: 'nick', state: 'open' },
        { relay_id: '00002-b', submitted_by: 'nick', state: 'open' },
      ]);
      expect(await listLanes(db, team.id, team.slug)).toEqual([]);

      // Second pass: the daemon presents its cursor and the relay's empty answer opens nothing —
      // the second consumer's case (a re-pull after a crash/restart) instantiated, not assumed.
      expect(await ingestTeamSeeds(ctx, team)).toBe(0);
      expect(await listSeeds(db, team.id)).toHaveLength(2);
      const secondUrl = new URL(String(fetchSpy.mock.calls[1]![0]));
      expect(secondUrl.searchParams.get('after')).toBe('00002-b');
    });

    it('does nothing when policy has no relay configured — no outbound call ever', async () => {
      const team = await seedTeam(false);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      expect(await ingestTeamSeeds(ctx, team)).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('on an enrolled joiner does nothing — the relay is hub-only (ADR 399), no outbound call', async () => {
      const team = await seedTeam();
      const { id: node_id } = await localNodeForTeam(db, team.id);
      const dir = mkdtempSync(join(tmpdir(), 'musterd-seeds-joiner-'));
      const prior = process.env['MUSTERD_NODE_STATE'];
      process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
      try {
        saveNodeEnrollment({
          team: team.slug,
          hub_url: 'http://hub',
          credential: 'x',
          node_id,
          enrolled_at: 1,
        });
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        expect(await ingestTeamSeeds(ctx, team)).toBe(0);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await listSeeds(db, team.id)).toEqual([]);
      } finally {
        if (prior === undefined) delete process.env['MUSTERD_NODE_STATE'];
        else process.env['MUSTERD_NODE_STATE'] = prior;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('records accepted Seed provenance without recording its body', async () => {
      const team = await seedTeam();
      await mockRelay([[await relaySeed({ id: '00003-c', body: 'audited idea' })], []]);
      await ingestTeamSeeds(ctx, team);
      const rows = await db.all(
        "SELECT action, detail FROM audit WHERE team_id = ? AND action = 'seed.ingested'",
        [team.id],
      );
      expect(rows).toHaveLength(1);
      const detail = JSON.parse(rows[0]!.detail) as Record<string, unknown>;
      expect(detail.seed_id).toBe('00003-c');
      expect(detail.source).toBe('slack');
      expect(rows[0]!.detail).not.toContain('audited idea');
      expect(rows[0]!.detail).not.toContain('U123');
    });

    it('acknowledges an unknown Slack submitter without creating a Seed or logging identity', async () => {
      const team = await seedTeam();
      const fetchSpy = await mockRelay([
        [await relaySeed({ id: '00004-d', meta: { user: 'U999' } })],
        [],
      ]);

      expect(await ingestTeamSeeds(ctx, team)).toBe(0);
      expect(await listSeeds(db, team.id)).toEqual([]);
      const audit = await db.get(
        "SELECT result, detail FROM audit WHERE team_id = ? AND action = 'seed.ingested'",
        [team.id],
      )!;
      expect(audit.result).toBe('deny');
      expect(JSON.parse(audit.detail)).toMatchObject({
        seed_id: '00004-d',
        source: 'slack',
        reason: 'unknown_submitter',
      });
      expect(audit.detail).not.toContain('U999');
      expect(await ingestTeamSeeds(ctx, team)).toBe(0);
      expect(new URL(String(fetchSpy.mock.calls[1]![0])).searchParams.get('after')).toBe('00004-d');
    });

    it('rejects an unsupported source without advancing the cursor', async () => {
      const team = await seedTeam();
      const fetchSpy = await mockRelay([
        [{ id: '00005-e', body: 'sms idea', ts: 1, source: 'sms', meta: {} }],
        [],
      ]);

      await expect(ingestTeamSeeds(ctx, team)).rejects.toThrow();
      expect(await listSeeds(db, team.id)).toEqual([]);
      expect(await listLanes(db, team.id, team.slug)).toEqual([]);
      await ingestTeamSeeds(ctx, team);
      expect(new URL(String(fetchSpy.mock.calls[1]![0])).searchParams.get('after')).toBeNull();
    });

    it('a relay failure opens nothing and leaves the cursor where it was', async () => {
      const team = await seedTeam();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
      await expect(ingestTeamSeeds(ctx, team)).rejects.toThrow('relay responded 500');
      expect(await listSeeds(db, team.id)).toHaveLength(0);
    });
  });
});
