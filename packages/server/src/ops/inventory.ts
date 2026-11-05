import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

/**
 * The hub inventory (ADR 796): what a store holds, table by table, so a move can prove that the
 * new hub holds everything the old one did and name anything only the box's replica held.
 *
 * Read-only by construction, and free of relative imports, so `scripts/hub/inventory.ts` can run
 * it from source on a machine with no build (node's type stripping cannot resolve this package's
 * `.js` import specifiers).
 */

export interface TableInventory {
  table: string;
  rows: number;
  /** sha256 over every row's JSON in primary-key order: equal rows in any physical order match. */
  digest: string;
  pk: string[];
}

export interface Inventory {
  taken_at: number;
  tables: TableInventory[];
  sync: { hub_seq: number; origins: Record<string, number> };
  /** Events this store stamped with its own origin and has not pushed (`next_seq - 1 - last_seq`). */
  outbox_pending: number;
}

export interface Mismatch {
  table: string;
  kind: 'count' | 'digest' | 'missing_table';
  a: unknown;
  b: unknown;
}

/**
 * Node-local by design (docs/wiki/federation-data-census.md, `01-data-model.md`): rebuilt on the new
 * machine, never compared. `nodes.last_seen_at` and `nodes.next_seq` are liveness, not data, and are
 * left out of the `nodes` digest.
 */
export const EPHEMERAL_TABLES: readonly string[] = [
  'presence',
  'wake_leases',
  'schema_meta',
  'sync_push_cursor',
  'sync_pull_cursor',
  'pull_announcements',
];
const EPHEMERAL_PREFIXES = ['footprint_', 'sqlite_'];

/**
 * Node-local by design (census residence 3): the new hub writes its own, so the replica-only check
 * never lists them. They still count in the copy compare, which reads one machine's store twice.
 */
export const NODE_LOCAL_TABLES: readonly string[] = ['local_node', 'host_liveness'];

/**
 * How the replica-only check names a row when the table's own id is minted per machine (rehearsal 1,
 * lane 01M6MG78J7). Every machine projects the roster (teams, members) under its own ids, and rows
 * that point at them inherit those ids, so a joiner's replica holds the hub's team and seats under
 * different keys. Tables not listed are keyed by their primary key. Either way `team_id` reads as the
 * team's slug and a member column as the member's name (`slug/name`), so the same row on two
 * machines has the same key.
 */
export const NATURAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  teams: ['slug'],
  members: ['team_id', 'name'],
  residency: ['team_id', 'member_id', 'host', 'harness'],
  seeds: ['team_id', 'relay_id'],
  grants: ['team_id', 'token_hash'],
  agent_bootstrap_credentials: ['team_id', 'key_hash'],
};
const MEMBER_COLUMNS = new Set(['member_id', 'migration_target_member_id']);

/** The row names this store gives a table's keys: team ids as slugs, member ids as `slug/name`. */
function namedKeys(db: Database.Database, table: string): unknown[][] {
  const cols = NATURAL_KEYS[table] ?? primaryKey(db, table);
  const slugs = new Map(
    (db.prepare('SELECT id, slug FROM teams').raw().all() as [string, string][]).map(
      ([id, slug]) => [id, slug],
    ),
  );
  const names = new Map(
    (
      db.prepare('SELECT id, team_id, name FROM members').raw().all() as [string, string, string][]
    ).map(([id, team, name]) => [id, `${slugs.get(team) ?? team}/${name}`]),
  );
  const rows = db
    .prepare(`SELECT ${cols.map(q).join(', ')} FROM ${q(table)}`)
    .raw()
    .all() as unknown[][];
  return rows.map((row) =>
    row.map((v, i) => {
      const col = cols[i]!;
      if (col === 'team_id') return slugs.get(v as string) ?? v;
      if (MEMBER_COLUMNS.has(col)) return names.get(v as string) ?? v;
      return v;
    }),
  );
}
const VOLATILE_COLUMNS: Record<string, readonly string[]> = { nodes: ['last_seen_at', 'next_seq'] };

/** Open a store file read-only; the inventory never writes. */
export function openReadOnly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function tables(db: Database.Database): string[] {
  return db
    .prepare<
      [],
      string
    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all();
}

const q = (id: string) => `"${id.replaceAll('"', '""')}"`;

function primaryKey(db: Database.Database, table: string): string[] {
  const cols = db
    .prepare<[string], { name: string; pk: number }>('SELECT name, pk FROM pragma_table_info(?)')
    .all(table);
  const pk = cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return pk.length > 0 ? pk : ['rowid'];
}

function columns(db: Database.Database, table: string): string[] {
  const volatile = VOLATILE_COLUMNS[table] ?? [];
  return db
    .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)')
    .all(table)
    .map((c) => c.name)
    .filter((c) => !volatile.includes(c));
}

function isEphemeral(table: string): boolean {
  return EPHEMERAL_TABLES.includes(table) || EPHEMERAL_PREFIXES.some((p) => table.startsWith(p));
}

export function takeInventory(db: Database.Database, now: number = Date.now()): Inventory {
  const out: TableInventory[] = [];
  for (const table of tables(db)) {
    const pk = primaryKey(db, table);
    const cols = columns(db, table);
    const hash = createHash('sha256');
    let rows = 0;
    const select = `SELECT ${cols.map(q).join(', ')} FROM ${q(table)} ORDER BY ${pk.map(q).join(', ')}`;
    for (const row of db.prepare(select).raw().iterate()) {
      hash.update(JSON.stringify(row));
      hash.update('\n');
      rows++;
    }
    out.push({ table, rows, digest: hash.digest('hex'), pk });
  }
  const has = (t: string) => out.some((x) => x.table === t);
  const hubSeq = has('sync_log')
    ? (db.prepare<[], number | null>('SELECT MAX(hub_seq) FROM sync_log').pluck().get() ?? 0)
    : 0;
  const origins: Record<string, number> = {};
  if (has('sync_log')) {
    for (const r of db
      .prepare<
        [],
        { origin_node: string; high: number }
      >('SELECT origin_node, MAX(origin_seq) AS high FROM sync_log GROUP BY origin_node ORDER BY origin_node')
      .all())
      origins[r.origin_node] = r.high;
  }
  // Unpushed = stamped beyond what this store's own log or its push cursor already carries. Only a
  // node that takes part in sync counts: a single-machine team's events have nowhere to go.
  let pending = 0;
  if (has('local_node') && has('nodes')) {
    for (const r of db
      .prepare<[], { stamped: number; pushed: number | null; logged: number | null }>(
        `SELECT n.next_seq - 1 AS stamped,
                (SELECT c.last_seq FROM sync_push_cursor c WHERE c.team_id = l.team_id AND c.node_id = l.node_id) AS pushed,
                (SELECT MAX(s.origin_seq) FROM sync_log s WHERE s.origin_node = l.node_id) AS logged
           FROM local_node l JOIN nodes n ON n.id = l.node_id`,
      )
      .all()) {
      if (r.pushed === null && r.logged === null) continue;
      pending += Math.max(0, r.stamped - Math.max(r.pushed ?? 0, r.logged ?? 0));
    }
  }
  return {
    taken_at: now,
    tables: out,
    sync: { hub_seq: hubSeq, origins },
    outbox_pending: pending,
  };
}

/** Every difference between two inventories, by table, outside `ignore` and the ephemeral set. */
export function compareInventories(
  a: Inventory,
  b: Inventory,
  opts: { ignore?: readonly string[] } = {},
): Mismatch[] {
  const skip = (t: string) => isEphemeral(t) || (opts.ignore ?? []).includes(t);
  const byB = new Map(b.tables.map((t) => [t.table, t]));
  const out: Mismatch[] = [];
  const seen = new Set<string>();
  for (const ta of a.tables) {
    seen.add(ta.table);
    if (skip(ta.table)) continue;
    const tb = byB.get(ta.table);
    if (!tb) out.push({ table: ta.table, kind: 'missing_table', a: ta.rows, b: null });
    else if (ta.rows !== tb.rows)
      out.push({ table: ta.table, kind: 'count', a: ta.rows, b: tb.rows });
    else if (ta.digest !== tb.digest)
      out.push({ table: ta.table, kind: 'digest', a: ta.digest, b: tb.digest });
  }
  for (const tb of b.tables)
    if (!seen.has(tb.table) && !skip(tb.table))
      out.push({ table: tb.table, kind: 'missing_table', a: null, b: tb.rows });
  return out;
}

/**
 * Primary keys of the rows `a` holds and `b` does not, for one table. Used both ways: the box's
 * replica against the hub's copy (rows only the box held), and the old hub against the running new
 * one (rows lost).
 */
export function rowsOnlyIn(a: Database.Database, b: Database.Database, table: string): unknown[][] {
  const inB = new Set(namedKeys(b, table).map((k) => JSON.stringify(k)));
  return namedKeys(a, table).filter((k) => !inB.has(JSON.stringify(k)));
}

/** Non-ephemeral tables of `a` that hold rows `b` does not, each with those rows' keys — including
 *  every row of a table `b` lacks entirely. */
export function rowsOnlyInAny(
  a: Database.Database,
  b: Database.Database,
): Array<{ table: string; keys: unknown[][] }> {
  const inB = new Set(tables(b));
  const out: Array<{ table: string; keys: unknown[][] }> = [];
  for (const table of tables(a)) {
    if (isEphemeral(table) || NODE_LOCAL_TABLES.includes(table)) continue;
    // A table `b` does not have at all: every row of it is held only by `a` (big-body, 2026-11-03).
    const keys = inB.has(table) ? rowsOnlyIn(a, b, table) : namedKeys(a, table);
    if (keys.length > 0) out.push({ table, keys });
  }
  return out;
}
