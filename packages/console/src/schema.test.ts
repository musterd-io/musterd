import { describe, expect, it } from 'vitest';
import { assertSchema, schemaVersion } from './db.js';
import { migrate, SCHEMA_VERSION } from './schema.js';
import { pglite } from './testing.js';

async function migrated() {
  const { db, q } = await pglite();
  await db.exec('CREATE ROLE console_app NOLOGIN');
  await migrate(q, 'console_app');
  return { db, q };
}

describe('console schema (ADR 615)', () => {
  it('migrates a fresh database to SCHEMA_VERSION, idempotently', async () => {
    const { q } = await migrated();
    expect(await schemaVersion(q)).toBe(SCHEMA_VERSION);
    await migrate(q, 'console_app');
    expect(await schemaVersion(q)).toBe(SCHEMA_VERSION);
  });

  it('boot refuses a schema that is not exactly its own', async () => {
    const { q } = await migrated();
    await expect(assertSchema(q, SCHEMA_VERSION)).resolves.toBeUndefined();
    await q.query("UPDATE console_meta SET value = $1 WHERE key = 'schema_version'", [
      String(SCHEMA_VERSION + 1),
    ]);
    await expect(assertSchema(q, SCHEMA_VERSION)).rejects.toThrow(/schema newer than this build/);
    // Older: the same database, version rewound — one PGlite per test keeps this inside the
    // timeout on a loaded machine (a second fresh instance pushed it past 30 s).
    await q.query("UPDATE console_meta SET value = '0' WHERE key = 'schema_version'", []);
    await expect(assertSchema(q, SCHEMA_VERSION)).rejects.toThrow(/schema older than this build/);
    await q.query('DROP TABLE console_meta', []);
    await expect(assertSchema(q, SCHEMA_VERSION)).rejects.toThrow(/schema older than this build/);
  });

  it('migrate refuses a database newer than this build', async () => {
    const { q } = await migrated();
    await q.query("UPDATE console_meta SET value = '99' WHERE key = 'schema_version'", []);
    await expect(migrate(q, 'console_app')).rejects.toThrow(/schema newer than this build/);
  });

  it('one identity per (provider, subject); several per account', async () => {
    const { q } = await migrated();
    await q.query('INSERT INTO accounts (id, created_at) VALUES ($1, $2)', ['acc_1', 1]);
    await q.query(
      'INSERT INTO identities (provider, subject, account_id, created_at) VALUES ($1,$2,$3,$4)',
      ['github', '42', 'acc_1', 1],
    );
    await q.query(
      'INSERT INTO identities (provider, subject, account_id, created_at) VALUES ($1,$2,$3,$4)',
      ['google', '42', 'acc_1', 1],
    );
    await expect(
      q.query(
        'INSERT INTO identities (provider, subject, account_id, created_at) VALUES ($1,$2,$3,$4)',
        ['github', '42', 'acc_1', 2],
      ),
    ).rejects.toThrow();
  });

  describe('the runtime role (big-body, 2026-10-15)', () => {
    const asRuntime = async (
      q: Awaited<ReturnType<typeof migrated>>['q'],
      sql: string,
      params: unknown[] = [],
    ) => {
      await q.query('SET ROLE console_app');
      try {
        return await q.query(sql, params);
      } finally {
        await q.query('RESET ROLE');
      }
    };

    it('can do DML on accounts and identities, and INSERT on audit', async () => {
      const { q } = await migrated();
      await asRuntime(q, 'INSERT INTO accounts (id, created_at) VALUES ($1, $2)', ['acc_9', 1]);
      await asRuntime(q, 'UPDATE accounts SET disabled_at = $1 WHERE id = $2', [2, 'acc_9']);
      await asRuntime(
        q,
        'INSERT INTO identities (provider, subject, account_id, created_at) VALUES ($1,$2,$3,$4)',
        ['email', 'a@b.test', 'acc_9', 1],
      );
      await asRuntime(q, "INSERT INTO audit (id, ts, action) VALUES ('a1', 1, 'test')");
      const rows = await asRuntime(q, 'SELECT id FROM accounts WHERE id = $1', ['acc_9']);
      expect(rows.rows).toHaveLength(1);
    });

    it('cannot read, change or remove the audit record', async () => {
      const { q } = await migrated();
      await asRuntime(q, "INSERT INTO audit (id, ts, action) VALUES ('a1', 1, 'test')");
      for (const sql of [
        'SELECT * FROM audit',
        "UPDATE audit SET action = 'forged'",
        'DELETE FROM audit',
        'TRUNCATE audit',
      ])
        await expect(asRuntime(q, sql), sql).rejects.toThrow(/permission denied/);
    });

    it('can issue and revoke sessions but never delete one, nor a sign-in transaction', async () => {
      const { q } = await migrated();
      await q.query('INSERT INTO accounts (id, created_at) VALUES ($1, $2)', ['acc_s', 1]);
      await asRuntime(
        q,
        `INSERT INTO sessions (id_hash, account_id, generation, created_at, last_activity_at,
           idle_expires_at, absolute_expires_at, authenticated_at, method, identity_provider,
           identity_subject) VALUES ('h1','acc_s',0,1,1,2,3,1,'github','github','42')`,
      );
      await asRuntime(q, "UPDATE sessions SET revoked_at = 5 WHERE id_hash = 'h1'");
      for (const sql of [
        "DELETE FROM sessions WHERE id_hash = 'h1'",
        'DELETE FROM auth_transactions',
      ])
        await expect(asRuntime(q, sql), sql).rejects.toThrow(/permission denied/);
    });

    it('cannot change the schema or the version row, and is not the owner', async () => {
      const { q } = await migrated();
      for (const sql of [
        'CREATE TABLE sneak (x int)',
        "UPDATE console_meta SET value = '0'",
        'DROP TABLE accounts',
      ])
        await expect(asRuntime(q, sql), sql).rejects.toThrow(/permission denied|must be owner/);
      const member = await q.query<{ m: boolean }>(
        "SELECT pg_has_role('console_app', current_user, 'MEMBER') AS m",
      );
      expect(member.rows[0]?.m).toBe(false);
    });
  });
});
