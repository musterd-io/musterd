// packages/server/src/store/cursors.ts (85 lines on 2026-09-29) ported to the async Driver.
// Diff against the original is the per-module conversion cost for Q4. `appendReplicatedEvent`
// (store/audit.ts) is inlined as one insert so the port stays inside one file.

export async function migrate(d) {
  await d.exec(
    `CREATE TABLE messages (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  );
  await d.exec(
    `CREATE TABLE inbox_cursors (member_id TEXT PRIMARY KEY, last_read_message_id TEXT, last_read_ts INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  await d.exec(
    `CREATE TABLE audit (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, verb TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  );
}

export async function getCursor(d, memberId) {
  const row = await d.get('SELECT * FROM inbox_cursors WHERE member_id = ?', [memberId]);
  return row
    ? { ...row, last_read_ts: Number(row.last_read_ts), updated_at: Number(row.updated_at) }
    : { member_id: memberId, last_read_message_id: null, last_read_ts: 0, updated_at: 0 };
}

async function appendReplicatedEvent(d, teamId, verb, detail) {
  await d.run('INSERT INTO audit (id, team_id, verb, detail, created_at) VALUES (?, ?, ?, ?, ?)', [
    `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    teamId,
    verb,
    JSON.stringify(detail),
    Date.now(),
  ]);
}

export async function setCursor(d, memberId, lastReadMessageId) {
  return d.tx(async (t) => {
    const row = await t.get('SELECT team_id, created_at FROM messages WHERE id = ?', [
      lastReadMessageId,
    ]);
    if (!row) throw new Error(`setCursor: unknown message id ${lastReadMessageId}`);
    const now = Date.now();
    await t.run(
      `INSERT INTO inbox_cursors (member_id, last_read_message_id, last_read_ts, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (member_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id, last_read_ts = excluded.last_read_ts, updated_at = excluded.updated_at`,
      [memberId, lastReadMessageId, Number(row.created_at), now],
    );
    await appendReplicatedEvent(t, row.team_id, 'inbox.cursor', {
      member_id: memberId,
      last_read_message_id: lastReadMessageId,
    });
    return getCursor(t, memberId);
  });
}
