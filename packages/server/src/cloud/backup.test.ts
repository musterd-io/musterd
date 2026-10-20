import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBackupLaunchdPlist,
  createR2Store,
  decryptDump,
  encryptDump,
  expiredBackupKeys,
  parseBackupKey,
  restoreSnapshot,
  runBackupPass,
} from '../../../../scripts/cloud/backup.mjs';
import { openTestDriver } from '../db/testing.js';
import { addMember } from '../store/members.js';
import { createTeam } from '../store/teams.js';
import { ingestTraceEvents } from '../store/trace.js';

describe('Cloud 3 encrypted R2 backups (ADR 679)', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('encrypts with AES-256-GCM + AAD and refuses wrong key, tampered bytes, or swapped key path', () => {
    const keyHex = randomBytes(32).toString('hex');
    const keyB64 = Buffer.from(keyHex, 'hex').toString('base64');
    expect(parseBackupKey(keyHex).equals(parseBackupKey(keyB64))).toBe(true);
    expect(() => parseBackupKey('short')).toThrow(/32 bytes/);

    const aad = 'teams/revive/coordination/2026-10-20.json.gz.enc';
    const plain = JSON.stringify({ hello: 'world', secret: 'never-in-plaintext' });
    const enc = encryptDump(plain, keyHex, aad);
    expect(enc.subarray(0, 4).toString('ascii')).toBe('MSB1');
    expect(enc.includes(Buffer.from('never-in-plaintext'))).toBe(false);

    const dec = decryptDump(enc, keyHex, aad).toString('utf8');
    expect(dec).toBe(plain);

    // Wrong AAD (e.g. an attacker swaps team A's object under team B's key) fails GCM auth.
    expect(() =>
      decryptDump(enc, keyHex, 'teams/other/coordination/2026-10-20.json.gz.enc'),
    ).toThrow();

    // Tampered ciphertext fails GCM auth.
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => decryptDump(tampered, keyHex, aad)).toThrow();
  });

  it('enforces 30-day retention for coordination/console dumps and 7-day retention for trace dumps (spec §4.8)', () => {
    const keys = [
      'teams/revive/coordination/2026-09-20.json.gz.enc', // 30d old on 2026-10-20 → expired
      'teams/revive/coordination/2026-09-21.json.gz.enc', // 29d old → kept
      'teams/revive/trace/2026-10-13.json.gz.enc', // 7d old on 2026-10-20 → expired
      'teams/revive/trace/2026-10-14.json.gz.enc', // 6d old → kept
      'console/2026-09-19.json.gz.enc', // 31d old → expired
      'console/2026-10-01.json.gz.enc', // 19d old → kept
      'pg_dump/trace/2026-10-10.dump.enc', // 10d old → expired
      'pg_dump/coordination/2026-10-10.dump.enc', // 10d old → kept
      'unrecognized/file.txt', // ignored
    ];
    expect(expiredBackupKeys(keys, '2026-10-20')).toEqual([
      'teams/revive/coordination/2026-09-20.json.gz.enc',
      'teams/revive/trace/2026-10-13.json.gz.enc',
      'console/2026-09-19.json.gz.enc',
      'pg_dump/trace/2026-10-10.dump.enc',
    ]);

    const plist = buildBackupLaunchdPlist({
      nodePath: '/opt/homebrew/bin/node',
      repoRoot: '/Users/nick/.musterd/runtime',
      logPath: '/Users/nick/.musterd/cloud/backup.log',
    });
    expect(plist).toContain('<string>studio.sandrise.musterd-cloud-backup</string>');
    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).toContain('<integer>3</integer>');
    expect(plist).toContain('<integer>17</integer>');
  });

  it('dumps per-team coordination + trace + console over SigV4 to an R2 endpoint, prunes expired keys, and restores onto a fresh Postgres database', async () => {
    // Stand up a local S3-compatible R2 double that verifies AWS4-HMAC-SHA256 headers exist.
    const objects = new Map<string, Buffer>();
    // Pre-seed an expired trace dump (8 days old) and a fresh coordination dump.
    objects.set('teams/revive/trace/2026-10-12.json.gz.enc', Buffer.from('old-trace'));
    objects.set('teams/revive/coordination/2026-10-19.json.gz.enc', Buffer.from('yesterday'));

    const r2Server = createServer((req, res) => {
      const auth = req.headers['authorization'] ?? '';
      if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=test-ak/')) {
        res.writeHead(403).end('missing SigV4');
        return;
      }
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      // Path is /<bucket>/<key...>
      const parts = u.pathname.replace(/^\/+/, '').split('/');
      const _bucket = parts.shift();
      const key = parts.map(decodeURIComponent).join('/');
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200).end();
        });
        return;
      }
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') ?? '';
        const items = [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => `<Contents><Key>${k}</Key></Contents>`)
          .join('');
        res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(
            `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`,
          );
        return;
      }
      if (req.method === 'GET') {
        const found = objects.get(key);
        if (!found) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200).end(found);
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });
    await new Promise<void>((r) => r2Server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => r2Server.close(() => r())));
    const port = (r2Server.address() as { port: number }).port;

    const mainDb = await openTestDriver('pglite', { store: 'main', instance: 1 });
    const traceDb = await openTestDriver('pglite', { store: 'trace', instance: 1 });
    cleanups.push(
      () => mainDb.close(),
      () => traceDb.close(),
    );

    const team = await createTeam(mainDb, { slug: 'revive', display: 'Revive' });
    await addMember(mainDb, team, { name: 'nick', kind: 'human' });
    await ingestTraceEvents(
      traceDb,
      team.id,
      'schmidt',
      [
        {
          harness: 'opencode',
          session_digest: 'a1b2c3d4',
          ts: 1_700_000_000_000,
          kind: 'PreToolUse',
          tool_name: 'Bash',
          content: { tool_input: 'echo secret', redactions: 0, truncated: false },
        },
      ],
      { writeContent: true },
    );

    // Wrap Driver as a minimal pg.Client-compatible `{ query(sql, params) }` for `runBackupPass`.
    const toClient = (d: typeof mainDb) => ({
      query: async (sql: string, params: unknown[] = []) => {
        // Convert $1, $2 placeholders to `?` for Driver.all, or run raw when no params.
        const q = sql.replace(/\$\d+/g, '?');
        if (/^\s*SELECT\b/i.test(q)) {
          const rows = await d.all<Record<string, unknown>>(q, params);
          return { rows, rowCount: rows.length };
        }
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET\s+LOCAL)\b/i.test(q)) {
          return { rows: [], rowCount: 0 };
        }
        const res = await d.run(q, params);
        return { rows: [], rowCount: res.changes };
      },
    });

    const store = createR2Store({
      accountId: 'acc',
      bucket: 'musterd-cloud-backups',
      accessKeyId: 'test-ak',
      secretAccessKey: 'test-sk',
      endpoint: `http://127.0.0.1:${port}`,
    });
    const backupKey = randomBytes(32);

    const result = await runBackupPass({
      mainClient: toClient(mainDb),
      traceClient: toClient(traceDb),
      store,
      encryptionKey: backupKey,
      date: '2026-10-20',
    });

    expect(result.teams).toBe(1);
    expect(result.uploaded.map((u: { key: string }) => u.key)).toEqual([
      'teams/revive/coordination/2026-10-20.json.gz.enc',
      'teams/revive/trace/2026-10-20.json.gz.enc',
    ]);
    // The 8-day-old trace dump was pruned; yesterday's coordination dump survived.
    expect(result.pruned).toEqual(['teams/revive/trace/2026-10-12.json.gz.enc']);
    expect(objects.has('teams/revive/trace/2026-10-12.json.gz.enc')).toBe(false);
    expect(objects.has('teams/revive/coordination/2026-10-19.json.gz.enc')).toBe(true);

    // Fetch the encrypted coordination dump from R2, decrypt it, and restore into a second fresh DB.
    const coordKey = 'teams/revive/coordination/2026-10-20.json.gz.enc';
    const rawCoord = await store.get(coordKey);
    const coordSnap = JSON.parse(decryptDump(rawCoord, backupKey, coordKey).toString('utf8'));
    expect(coordSnap.team_slug).toBe('revive');
    expect(coordSnap.tables.members).toHaveLength(1);

    const freshDb = await openTestDriver('pglite', { store: 'main', instance: 2 });
    cleanups.push(() => freshDb.close());
    await restoreSnapshot(toClient(freshDb), coordSnap);
    const restoredMembers = await freshDb.all<{ name: string }>(
      'SELECT name FROM members WHERE team_id = ?',
      [team.id],
    );
    expect(restoredMembers.map((m) => m.name)).toEqual(['nick']);
  });
});
