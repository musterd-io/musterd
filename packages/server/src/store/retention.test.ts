import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { appendAudit, type AuditAction, type AuditRow } from './audit.js';
import {
  AUDIT_CAPTURED_THROUGH_KEY,
  AUDIT_CHURN_ACTIONS,
  AUDIT_CHURN_MAX_AGE_MS,
  auditCapturedThrough,
  auditReadersOfChurnActions,
  pruneAuditChurn,
  storeSizes,
} from './retention.js';
import { createTeam } from './teams.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_790_000_000_000;

function seeded() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const put = (
    action: AuditAction,
    ageDays: number,
    target: string | null,
    origin?: [string, number],
  ) => {
    appendAudit(db, team.id, {
      actor: target,
      action,
      target,
      result: 'allow',
      detail: { ageDays },
    });
    const row = db.prepare<[], AuditRow>('SELECT * FROM audit ORDER BY rowid DESC LIMIT 1').get()!;
    db.prepare('UPDATE audit SET ts = ?, origin_node = ?, origin_seq = ? WHERE id = ?').run(
      NOW - ageDays * DAY,
      origin?.[0] ?? '',
      origin?.[1] ?? 0,
      row.id,
    );
    return row.id;
  };
  return { db, teamId: team.id, put };
}

const rows = (db: ReturnType<typeof openDb>) =>
  db
    .prepare<[], { action: string; target: string | null; ts: number }>(
      'SELECT action, target, ts FROM audit ORDER BY ts, rowid',
    )
    .all()
    .map((r) => [r.action, r.target, (NOW - r.ts) / DAY] as const);

describe('pruneAuditChurn (ADR 478)', () => {
  const dirs: string[] = [];
  const archiveDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'musterd-archive-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('prunes churn past the window, keeps decision-class rows of any age, archives what it prunes', () => {
    const { db, teamId, put } = seeded();
    put('presence.attached', 40, 'dolly');
    put('bootstrap_credential.used', 35, null);
    put('lane.claimed', 80, 'dolly'); // decision class: never pruned
    put('presence.detached', 3, 'dolly'); // churn, inside the window
    const dir = archiveDir();

    const r = pruneAuditChurn(db, { now: NOW, archiveDir: dir });
    expect(r).toMatchObject({
      pruned: 2,
      cutoff: NOW - AUDIT_CHURN_MAX_AGE_MS,
      capturedThrough: null,
      perTeam: { [teamId]: 2 },
    });
    expect(r.archivedBytes).toBeGreaterThan(0);
    expect(rows(db)).toEqual([
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
    expect(pruneAuditChurn(db, { now: NOW, archiveDir: dir }).pruned).toBe(0);
  });

  it('keeps the newest attestation per seat however old, and the per-origin high-water mark', () => {
    const { db, put } = seeded();
    put('occupancy.model_attested', 90, 'kimi'); // older attestation: prunable
    put('occupancy.model_attested', 60, 'kimi'); // newest for kimi: kept
    put('occupancy.model_attested', 45, 'izzo'); // only one for izzo: kept
    put('mcp.surface_rendered', 70, 'kimi'); // newest surface row for kimi: kept
    put('presence.attached', 50, 'kimi', ['nodeA', 7]);
    put('presence.detached', 49, 'kimi', ['nodeA', 8]); // MAX(origin_seq) for nodeA: kept
    put('presence.attached', 48, 'kimi', ['nodeB', 3]); // MAX for nodeB: kept

    const r = pruneAuditChurn(db, { now: NOW, archiveDir: archiveDir() });
    expect(r.pruned).toBe(2);
    expect(rows(db)).toEqual([
      ['mcp.surface_rendered', 'kimi', 70],
      ['occupancy.model_attested', 'kimi', 60],
      ['presence.detached', 'kimi', 49],
      ['presence.attached', 'kimi', 48],
      ['occupancy.model_attested', 'izzo', 45],
    ]);
  });

  it('on an archiving machine, never prunes above the corpus watermark', () => {
    const { db, put } = seeded();
    put('presence.attached', 40, 'dolly');
    put('presence.attached', 35, 'dolly');
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
      AUDIT_CAPTURED_THROUGH_KEY,
      String(NOW - 38 * DAY),
    );
    expect(auditCapturedThrough(db)).toBe(NOW - 38 * DAY);
    const dir = archiveDir();
    const r = pruneAuditChurn(db, { now: NOW, archiveDir: dir });
    expect(r).toMatchObject({ pruned: 1, cutoff: NOW - 38 * DAY });
    expect(rows(db)).toEqual([['presence.attached', 'dolly', 35]]);
  });

  it('with no archive dir (in-memory store) it prunes nothing and says so', () => {
    const { db, put } = seeded();
    put('presence.attached', 40, 'dolly');
    const r = pruneAuditChurn(db, { now: NOW, archiveDir: null });
    expect(r).toMatchObject({ pruned: 0, archivedBytes: 0, skipped: 'no_archive_dir' });
    expect(rows(db)).toHaveLength(1);
  });

  it('prunes in bounded batches and stops at the per-pass cap', () => {
    const { db, put } = seeded();
    for (let i = 0; i < 5; i++) put('presence.attached', 40 + i, 'dolly');
    const dir = archiveDir();
    expect(pruneAuditChurn(db, { now: NOW, archiveDir: dir, batch: 2, maxBatches: 1 }).pruned).toBe(
      2,
    );
    expect(pruneAuditChurn(db, { now: NOW, archiveDir: dir, batch: 2, maxBatches: 5 }).pruned).toBe(
      3,
    );
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

describe('storeSizes', () => {
  it('reports sync_log rows and bytes, and archive bytes when a dir exists', () => {
    const { db, teamId } = seeded();
    db.prepare(`INSERT INTO nodes (id, team_id, label) VALUES ('n1', ?, 'x')`).run(teamId);
    db.prepare(
      `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
       VALUES ('e1', ?, 'n1', 1, 1, '{"k":1}', ?)`,
    ).run(teamId, NOW);
    const s = storeSizes(db, ':memory:', null);
    expect(s.sync_log_rows).toBe(1);
    expect(s.sync_log_bytes).toBeGreaterThan(0);
    expect(s.db_bytes).toBeUndefined();
    expect(s.archive_bytes).toBeUndefined();
  });
});
