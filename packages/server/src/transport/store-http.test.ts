import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { appendAudit } from '../store/audit.js';
import { createTeam } from '../store/teams.js';

/**
 * ADR 478 §4: the two operator store verbs over the wire. An in-memory daemon has no archive dir and
 * no file, so `prune` reports the skip and `compact` refuses — the shapes the CLI prints.
 */
describe('POST /store/prune and /store/compact', () => {
  let server: RunningServer;
  let base: string;

  beforeEach(async () => {
    const db = openTestDb(':memory:');
    const team = await createTeam(db, { slug: 'revive' });
    await appendAudit(db, team.id, {
      actor: 'dolly',
      action: 'presence.attached',
      target: 'dolly',
      result: 'allow',
    });
    db.prepare('UPDATE audit SET ts = ?').run(Date.now() - 40 * 24 * 60 * 60 * 1000);
    server = createServer({ db, port: 0 });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
  });
  afterEach(async () => {
    await server.close();
  });

  it('dry_run counts the prunable churn and touches nothing', async () => {
    const res = await fetch(`${base}/store/prune?dry_run=1`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dry_run: boolean;
      audit_churn: { rows: number };
      archive_dir: string | null;
      sync_log_rows: number;
    };
    expect(body.dry_run).toBe(true);
    expect(body.audit_churn.rows).toBe(1);
    expect(body.archive_dir).toBeNull();
    expect(body.sync_log_rows).toBe(0);
  });

  it('a real pass on an in-memory store is skipped (no archive dir), never a silent delete', async () => {
    const res = await fetch(`${base}/store/prune`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { audit_churn: { pruned: number; skipped?: string } };
    expect(body.audit_churn).toMatchObject({ pruned: 0, skipped: 'no_archive_dir' });
  });

  it('compact refuses an in-memory store with a conflict', async () => {
    const res = await fetch(`${base}/store/compact`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/in memory/);
  });

  it('GET is not a store verb', async () => {
    const res = await fetch(`${base}/store/prune`);
    expect(res.status).toBe(404);
  });
});
