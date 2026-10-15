import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openDriver } from '../db/open.js';
import type { SqliteDriver } from '../db/sqliteDriver.js';
import { withDrivers } from '../db/testing.js';
import { saveNodeEnrollment } from '../node/state.js';
import { appendAudit, type AuditAction } from './audit.js';
import { localNodeForTeam } from './messages.js';
import {
  AUDIT_CAPTURED_THROUGH_KEY,
  AUDIT_CHURN_ACTIONS,
  AUDIT_CHURN_MAX_AGE_MS,
  auditCapturedThrough,
  auditReadersOfChurnActions,
  compactStore,
  countPrunableAuditChurn,
  pruneAuditChurn,
  storeSizes,
} from './retention.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('retention', (o, kind) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_790_000_000_000;

  async function seeded() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const put = async (
      action: AuditAction,
      ageDays: number,
      target: string | null,
      origin?: [string, number],
    ) => {
      await appendAudit(db, team.id, {
        actor: target,
        action,
        target,
        result: 'allow',
        detail: { ageDays },
      });
      const row = await db.get('SELECT * FROM audit ORDER BY id DESC LIMIT 1')!;
      await db.run('UPDATE audit SET ts = ?, origin_node = ?, origin_seq = ? WHERE id = ?', [
        NOW - ageDays * DAY,
        origin?.[0] ?? '',
        origin?.[1] ?? 0,
        row.id,
      ]);
      return row.id;
    };
    return { db, teamId: team.id, put };
  }

  const rows = async (db: Driver) =>
    (await db.all('SELECT action, target, ts FROM audit ORDER BY ts, id')).map(
      (r) => [r.action, r.target, (NOW - r.ts) / DAY] as const,
    );

  describe('pruneAuditChurn (ADR 478)', async () => {
    const dirs: string[] = [];
    const archiveDir = () => {
      const d = mkdtempSync(join(tmpdir(), 'musterd-archive-'));
      dirs.push(d);
      return d;
    };
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    it('prunes churn past the window, keeps decision-class rows of any age, archives what it prunes', async () => {
      const { db, teamId, put } = await seeded();
      await put('presence.attached', 40, 'dolly');
      await put('bootstrap_credential.used', 35, null);
      await put('lane.claimed', 80, 'dolly'); // decision class: never pruned
      await put('presence.detached', 3, 'dolly'); // churn, inside the window
      const dir = archiveDir();

      const r = await pruneAuditChurn(db, { now: NOW, archiveDir: dir });
      expect(r).toMatchObject({
        pruned: 2,
        cutoff: NOW - AUDIT_CHURN_MAX_AGE_MS,
        capturedThrough: null,
        perTeam: { [teamId]: 2 },
      });
      expect(r.archivedBytes).toBeGreaterThan(0);
      expect(await rows(db)).toEqual([
        ['lane.claimed', 'dolly', 80],
        ['presence.detached', 'dolly', 3],
      ]);

      // The archive is one gzip member per batch, appended: gunzip reads all of them back as JSONL.
      const files = readdirSync(dir).sort();
      expect(files).toEqual([expect.stringMatching(/^audit-\d{4}-\d{2}\.jsonl\.gz$/)]);
      const lines = gunzipSync(readFileSync(join(dir, files[0]!)))
        .toString('utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { action: string; detail: string });
      expect(lines.map((l) => l.action).sort()).toEqual([
        'bootstrap_credential.used',
        'presence.attached',
      ]);
      // idempotent
      expect((await pruneAuditChurn(db, { now: NOW, archiveDir: dir })).pruned).toBe(0);
    });

    it('keeps the newest attestation per seat however old, and the per-origin high-water mark', async () => {
      const { db, put } = await seeded();
      await put('occupancy.model_attested', 90, 'kimi'); // older attestation: prunable
      await put('occupancy.model_attested', 60, 'kimi'); // newest for kimi: kept
      await put('occupancy.model_attested', 45, 'izzo'); // only one for izzo: kept
      await put('mcp.surface_rendered', 70, 'kimi'); // newest surface row for kimi: kept
      await put('presence.attached', 50, 'kimi', ['nodeA', 7]);
      await put('presence.detached', 49, 'kimi', ['nodeA', 8]); // MAX(origin_seq) for nodeA: kept
      await put('presence.attached', 48, 'kimi', ['nodeB', 3]); // MAX for nodeB: kept

      const r = await pruneAuditChurn(db, { now: NOW, archiveDir: archiveDir() });
      expect(r.pruned).toBe(2);
      expect(await rows(db)).toEqual([
        ['mcp.surface_rendered', 'kimi', 70],
        ['occupancy.model_attested', 'kimi', 60],
        ['presence.detached', 'kimi', 49],
        ['presence.attached', 'kimi', 48],
        ['occupancy.model_attested', 'izzo', 45],
      ]);
    });

    it('on an enrolled joiner, never prunes its own rows the hub has not acked (lane 01M3ZBT9VY)', async () => {
      const { db, teamId, put } = await seeded();
      const { id: node } = await localNodeForTeam(db, teamId);
      await db.run(
        'INSERT INTO sync_push_cursor (team_id, node_id, last_seq, updated_at) VALUES (?, ?, ?, ?)',
        [teamId, node, 2, NOW],
      );
      await put('presence.attached', 9, 'kimi', [node, 1]); // acked: prunable
      await put('presence.attached', 8, 'kimi', [node, 2]); // acked: prunable
      await put('presence.detached', 7, 'kimi', [node, 3]); // unpushed: kept
      await put('presence.attached', 6, 'kimi', [node, 4]); // high-water mark: kept
      await put('presence.attached', 8, 'kimi', ['nodeOther', 1]); // someone else's: prunable
      await put('presence.attached', 7, 'kimi', ['nodeOther', 2]); // its high-water mark: kept

      const prior = process.env['MUSTERD_NODE_STATE'];
      process.env['MUSTERD_NODE_STATE'] = join(archiveDir(), 'node.json');
      try {
        saveNodeEnrollment({
          team: 'revive',
          hub_url: 'http://hub',
          credential: 'x',
          node_id: node,
          enrolled_at: NOW,
        });
        expect((await countPrunableAuditChurn(db, { now: NOW })).rows).toBe(3);
        expect((await pruneAuditChurn(db, { now: NOW, archiveDir: archiveDir() })).pruned).toBe(3);
        expect(await rows(db)).toEqual([
          ['presence.detached', 'kimi', 7],
          ['presence.attached', 'kimi', 7],
          ['presence.attached', 'kimi', 6],
        ]);
      } finally {
        if (prior === undefined) delete process.env['MUSTERD_NODE_STATE'];
        else process.env['MUSTERD_NODE_STATE'] = prior;
      }
    });

    it('on an archiving machine, never prunes above the corpus watermark', async () => {
      const { db, put } = await seeded();
      await put('presence.attached', 40, 'dolly');
      await put('presence.attached', 35, 'dolly');
      await db.run('INSERT INTO schema_meta (key, value) VALUES (?, ?)', [
        AUDIT_CAPTURED_THROUGH_KEY,
        String(NOW - 38 * DAY),
      ]);
      expect(await auditCapturedThrough(db)).toBe(NOW - 38 * DAY);
      const dir = archiveDir();
      const r = await pruneAuditChurn(db, { now: NOW, archiveDir: dir });
      expect(r).toMatchObject({ pruned: 1, cutoff: NOW - 38 * DAY });
      expect(await rows(db)).toEqual([['presence.attached', 'dolly', 35]]);
    });

    it('archiveTable (Cloud): archives into audit_archive per team and month, then prunes', async () => {
      const { db, teamId, put } = await seeded();
      const other = await createTeam(db, { slug: 'other' });
      await put('presence.attached', 40, 'dolly');
      await put('bootstrap_credential.used', 35, null);
      await put('lane.claimed', 80, 'dolly'); // decision class: never pruned
      await put('presence.detached', 3, 'dolly'); // churn, inside the window
      await appendAudit(db, other.id, {
        actor: 'kimi',
        action: 'presence.attached',
        target: 'kimi',
        result: 'allow',
        detail: { ageDays: 50 },
      });
      await db.run('UPDATE audit SET ts = ? WHERE team_id = ?', [NOW - 50 * DAY, other.id]);

      // No archive dir: Cloud has no disk to archive beside, and the table is where the rows go.
      const r = await pruneAuditChurn(db, { now: NOW, archiveDir: null, archiveTable: true });
      expect(r).toMatchObject({ pruned: 3, perTeam: { [teamId]: 2, [other.id]: 1 } });
      expect(r.skipped).toBeUndefined();
      expect(r.archivedBytes).toBeGreaterThan(0);
      expect(await rows(db)).toEqual([
        ['lane.claimed', 'dolly', 80],
        ['presence.detached', 'dolly', 3],
      ]);

      // One archive row per (team, month); its body is base64 of the same gzipped JSONL a local
      // archive member holds.
      const archived = await db.all<{
        team_id: string;
        month: string;
        row_count: number;
        from_ts: number;
        to_ts: number;
        body: string;
      }>('SELECT team_id, month, row_count, from_ts, to_ts, body FROM audit_archive');
      expect(archived).toHaveLength(2);
      const byTeam = new Map(archived.map((a) => [a.team_id, a]));
      const mine = byTeam.get(teamId)!;
      expect(mine).toMatchObject({ month: '2026-08' });
      expect(Number(mine.row_count)).toBe(2);
      expect(Number(mine.from_ts)).toBe(NOW - 40 * DAY);
      expect(Number(mine.to_ts)).toBe(NOW - 35 * DAY);
      const lines = gunzipSync(Buffer.from(mine.body, 'base64'))
        .toString('utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { action: string; team_id: string });
      expect(lines.map((l) => l.action).sort()).toEqual([
        'bootstrap_credential.used',
        'presence.attached',
      ]);
      expect(lines.every((l) => l.team_id === teamId)).toBe(true);
      expect(Number(byTeam.get(other.id)!.row_count)).toBe(1);

      // idempotent
      const again = await pruneAuditChurn(db, { now: NOW, archiveDir: null, archiveTable: true });
      expect(again.pruned).toBe(0);
      expect(await db.all('SELECT id FROM audit_archive')).toHaveLength(2);
    });

    it('archiveTable: a failed archive insert prunes nothing (one transaction)', async () => {
      const { db, put } = await seeded();
      await put('presence.attached', 40, 'dolly');
      // The table missing makes the insert throw; the delete beside it must roll back with it.
      await db.exec('ALTER TABLE audit_archive RENAME TO audit_archive_away');
      try {
        await expect(
          pruneAuditChurn(db, { now: NOW, archiveDir: null, archiveTable: true }),
        ).rejects.toThrow();
      } finally {
        await db.exec('ALTER TABLE audit_archive_away RENAME TO audit_archive');
      }
      expect(await rows(db)).toHaveLength(1);
    });

    it('with no archive dir (in-memory store) it prunes nothing and says so', async () => {
      const { db, put } = await seeded();
      await put('presence.attached', 40, 'dolly');
      const r = await pruneAuditChurn(db, { now: NOW, archiveDir: null });
      expect(r).toMatchObject({ pruned: 0, archivedBytes: 0, skipped: 'no_archive_dir' });
      expect(await rows(db)).toHaveLength(1);
    });

    it('prunes in bounded batches and stops at the per-pass cap', async () => {
      const { db, put } = await seeded();
      for (let i = 0; i < 5; i++) await put('presence.attached', 40 + i, 'dolly');
      const dir = archiveDir();
      expect(
        (await pruneAuditChurn(db, { now: NOW, archiveDir: dir, batch: 2, maxBatches: 1 })).pruned,
      ).toBe(2);
      expect(
        (await pruneAuditChurn(db, { now: NOW, archiveDir: dir, batch: 2, maxBatches: 5 })).pruned,
      ).toBe(3);
    });

    it('the churn allow-list is read back by exactly the two latest-per-seat readers', () => {
      // A new daemon query that names a churn action fails here rather than on a seat whose row
      // aged out (ADR 478 §Consequences). Add the reader to the pin only if it keeps working with
      // the rows of the last 30 days plus the newest row per seat.
      expect(auditReadersOfChurnActions()).toEqual({
        'mcp.surface_rendered': ['store/toolCalls.ts'],
        'occupancy.model_attested': ['store/review.ts'],
      });
      expect(AUDIT_CHURN_ACTIONS.has('lane.claimed' as AuditAction)).toBe(false);
    });
  });

  describe('countPrunableAuditChurn', async () => {
    it('counts exactly what a pass would take, and takes nothing', async () => {
      const { db, put } = await seeded();
      await put('presence.attached', 40, 'dolly');
      await put('occupancy.model_attested', 60, 'kimi'); // newest per seat: kept, so not counted
      await put('lane.claimed', 80, 'dolly');
      expect(await countPrunableAuditChurn(db, { now: NOW })).toEqual({
        rows: 1,
        cutoff: NOW - AUDIT_CHURN_MAX_AGE_MS,
        capturedThrough: null,
      });
      expect(await rows(db)).toHaveLength(3);
    });
  });

  describe('compactStore', async () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    // VACUUM, WAL and auto_vacuum are SQLite's; compactStore on Postgres refuses (`in_memory` shape).
    it.runIf(kind === 'sqlite')(
      'refuses an in-memory store, refuses without 1.2× the file free, and otherwise vacuums',
      async () => {
        expect(await compactStore(await openStore(), ':memory:')).toEqual({
          ok: false,
          reason: 'in_memory',
        });

        const dir = mkdtempSync(join(tmpdir(), 'musterd-compact-'));
        dirs.push(dir);
        const path = join(dir, 'musterd.db');
        const db = openDriver(path);
        const raw = (db as SqliteDriver).raw;
        const team = await createTeam(db, { slug: 'revive' });
        for (let i = 0; i < 2000; i++) {
          await appendAudit(db, team.id, {
            actor: 'dolly',
            action: 'presence.attached',
            target: 'dolly',
            result: 'allow',
            detail: { pad: 'x'.repeat(200), i },
          });
        }
        await db.exec('DELETE FROM audit');
        raw.pragma('wal_checkpoint(TRUNCATE)');
        const before = statSync(path).size;

        const tight = await compactStore(db, path, { freeBytes: () => before });
        expect(tight).toMatchObject({ ok: false, reason: 'insufficient_disk', free_bytes: before });
        expect(statSync(path).size).toBe(before);

        const r = await compactStore(db, path, { freeBytes: () => before * 10 });
        expect(r).toMatchObject({ ok: true, before_bytes: before, auto_vacuum: 'incremental' });
        if (r.ok) expect(r.after_bytes).toBeLessThan(before);
        expect(raw.pragma('auto_vacuum', { simple: true })).toBe(2); // 2 = INCREMENTAL
        await db.close();
      },
    );
  });

  describe('prunable-set cost at scale (the 2026-09-29 stall)', async () => {
    // A raw 200k-row SQLite fixture: the stall was measured on the SQLite store, and the CTE form
    // is what the assertion times; the Postgres side runs the same SQL in the tests above.
    it.runIf(kind === 'sqlite')(
      'counts 200k churn rows in well under the daemon-stall range',
      async () => {
        const { db, teamId } = await seeded();
        const raw = (db as SqliteDriver).raw;
        const ins = raw.prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
       VALUES (?, ?, ?, ?, ?, ?, 'allow', '{}', ?, ?, ?)`,
        );
        const actions = [
          'presence.attached',
          'presence.detached',
          'bootstrap_credential.used',
          'occupancy.model_attested',
        ];
        raw.transaction(() => {
          for (let i = 0; i < 200_000; i++) {
            const seat = `seat${i % 40}`;
            ins.run(
              `id${String(i).padStart(7, '0')}`,
              teamId,
              NOW - (i % 60) * DAY,
              seat,
              actions[i % actions.length],
              seat,
              NOW,
              i % 3 === 0 ? '' : `node${i % 5}`,
              i % 3 === 0 ? 0 : i,
            );
          }
        })();
        const t0 = performance.now();
        const r = await countPrunableAuditChurn(db, { now: NOW });
        const ms = performance.now() - t0;
        expect(r.rows).toBeGreaterThan(100_000);
        // The correlated form took >280 s for a 5,000-row batch on a table this size; the CTE form
        // counts everything in ~1 s here and ~4 s on the 300 MB live store. 15 s is the tripwire.
        expect(ms).toBeLessThan(15_000);
      },
    );
  });

  describe('storeSizes', async () => {
    it('reports sync_log rows and bytes, and archive bytes when a dir exists', async () => {
      const { db, teamId } = await seeded();
      await db.run(`INSERT INTO nodes (id, team_id, label) VALUES ('n1', ?, 'x')`, [teamId]);
      await db.run(
        `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
       VALUES ('e1', ?, 'n1', 1, 1, '{"k":1}', ?)`,
        [teamId, NOW],
      );
      const s = await storeSizes(db, ':memory:', null);
      expect(s.sync_log_rows).toBe(1);
      expect(s.sync_log_bytes).toBeGreaterThan(0);
      expect(s.db_bytes).toBeUndefined();
      expect(s.archive_bytes).toBeUndefined();
    });
  });
});
