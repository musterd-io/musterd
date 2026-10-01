import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIALECT_SOURCE_LINE_BUDGET, DialectError, toPostgres } from './dialect.js';

describe('toPostgres', () => {
  it('renumbers ? placeholders outside string literals', () => {
    expect(toPostgres("SELECT ? AS a, 'why?' AS b, ? AS c")).toBe(
      "SELECT $1 AS a, 'why?' AS b, $2 AS c",
    );
  });
  it('flat json_extract → ->>', () => {
    expect(toPostgres("SELECT json_extract(meta, '$.lane') FROM m")).toBe(
      "SELECT (meta::jsonb ->> 'lane') FROM m",
    );
  });
  it('nested json_extract → #>> with an array path', () => {
    expect(toPostgres("WHERE json_extract(detail, '$.gate.fingerprint') = ?")).toBe(
      "WHERE (detail::jsonb #>> '{gate,fingerprint}') = $1",
    );
  });
  it('an ordering comparison against a numeric literal casts the extracted text', () => {
    expect(toPostgres("WHERE json_extract(meta, '$.n') > 1")).toBe(
      "WHERE ((meta::jsonb ->> 'n')::numeric > 1)",
    );
    expect(toPostgres("WHERE json_extract(d, '$.a.b') >= 10")).toBe(
      "WHERE ((d::jsonb #>> '{a,b}')::numeric >= 10)",
    );
  });
  it('a placeholder comparison does NOT cast (the param decides)', () => {
    expect(toPostgres("WHERE json_extract(meta, '$.lane') = ?")).toBe(
      "WHERE (meta::jsonb ->> 'lane') = $1",
    );
  });
  it('a 0/1 literal against json_extract compares as jsonb, so JSON true/false qualify too', () => {
    expect(toPostgres("WHERE json_extract(meta, '$.urgent') = 1")).toBe(
      "WHERE ((meta::jsonb -> 'urgent') IN ('1'::jsonb, 'true'::jsonb))",
    );
    expect(toPostgres("WHERE json_extract(d, '$.a.b') <> 0")).toBe(
      "WHERE ((d::jsonb #> '{a,b}') NOT IN ('0'::jsonb, 'false'::jsonb))",
    );
  });
  it('instr → strpos; two-argument MAX/MIN → GREATEST/LEAST', () => {
    expect(toPostgres('WHERE instr(body, ?) > 0')).toBe('WHERE strpos(body, $1) > 0');
    expect(toPostgres('SET seen_at = MAX(t.seen_at, excluded.seen_at)')).toBe(
      'SET seen_at = GREATEST(t.seen_at, excluded.seen_at)',
    );
    expect(toPostgres('SELECT MIN(a, b), MAX(ts) FROM x')).toBe(
      'SELECT LEAST(a, b), MAX(ts) FROM x',
    );
  });
  it('two-argument MAX/MIN with nested calls and a rewritten json_extract still become GREATEST/LEAST', () => {
    expect(
      toPostgres(
        "SUM(MAX(0, MIN(json_extract(detail, '$.to'), ?) - MAX(json_extract(detail, '$.from'), ?)))",
      ),
    ).toBe(
      "SUM(GREATEST(0, LEAST((detail::jsonb ->> 'to'), $1) - GREATEST((detail::jsonb ->> 'from'), $2)))",
    );
    expect(toPostgres('SELECT MAX(ts), MAX(COALESCE(a, 0), b) FROM x')).toBe(
      'SELECT MAX(ts), GREATEST(COALESCE(a, 0), b) FROM x',
    );
  });
  it('LIKE becomes ILIKE', () => {
    expect(toPostgres('WHERE name LIKE ?')).toBe('WHERE name ILIKE $1');
  });
  it('INSERT OR IGNORE → ON CONFLICT DO NOTHING, before RETURNING when present', () => {
    expect(toPostgres('INSERT OR IGNORE INTO t (a) VALUES (?)')).toBe(
      'INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING',
    );
    expect(toPostgres('INSERT OR IGNORE INTO t (a) VALUES (?) RETURNING id')).toBe(
      'INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id',
    );
  });
  it('refuses the SQLite-only constructs the inventory found none of', () => {
    for (const sql of [
      'INSERT OR REPLACE INTO t VALUES (1)',
      "SELECT datetime('now')",
      "SELECT strftime('%s','now')",
      'SELECT last_insert_rowid()',
      "SELECT 1 WHERE a GLOB 'x*'",
      'SELECT iif(1,2,3)',
      'SELECT a COLLATE NOCASE',
    ]) {
      expect(() => toPostgres(sql), sql).toThrow(DialectError);
    }
  });
  it('passes Postgres-shaped text through and memoises', () => {
    const sql =
      'INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET b = excluded.b RETURNING id';
    const out = toPostgres(sql);
    expect(out).toBe(
      'INSERT INTO t (a) VALUES ($1) ON CONFLICT (a) DO UPDATE SET b = excluded.b RETURNING id',
    );
    expect(toPostgres(sql)).toBe(out);
  });
  it('stays under the ADR 479 §4 line budget', () => {
    const lines = readFileSync(new URL('./dialect.ts', import.meta.url), 'utf8').split('\n').length;
    expect(lines).toBeLessThan(DIALECT_SOURCE_LINE_BUDGET);
  });

  it('CAST(… AS INTEGER) becomes BIGINT — a 64-bit epoch-millis cast overflows Postgres INTEGER', () => {
    expect(toPostgres("SELECT CAST(json_extract(detail, '$.to') AS INTEGER) AS t FROM audit")).toBe(
      "SELECT CAST((detail::jsonb ->> 'to') AS BIGINT) AS t FROM audit",
    );
    // Only the type name, never a literal that happens to contain the word.
    expect(toPostgres("SELECT 'AS INTEGER' AS s")).toBe("SELECT 'AS INTEGER' AS s");
  });

  it('null-safe IS / IS NOT against a bound value become IS [NOT] DISTINCT FROM', () => {
    expect(toPostgres('SELECT 1 FROM m WHERE from_member IS NOT ? AND to_member IS ?')).toBe(
      'SELECT 1 FROM m WHERE from_member IS DISTINCT FROM $1 AND to_member IS NOT DISTINCT FROM $2',
    );
    expect(toPostgres('SELECT 1 WHERE x IS NOT NULL')).toBe('SELECT 1 WHERE x IS NOT NULL');
  });
});
