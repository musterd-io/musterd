import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPENCODE_TRANSCRIPT_PARSER,
  opencodeDbPath,
  opencodeReadSql,
  opencodeReadSqlV2,
  readOpencodeRows,
  type OpencodeRow,
  parseOpencodeRows,
} from './opencode.js';

/** An assistant message and its parts, in the shapes opencode 1.18.32 stores (measured 2026-09-28). */
const message = (completed: number | null) =>
  JSON.stringify({
    role: 'assistant',
    modelID: 'gpt-6-luna',
    tokens: {
      total: 64123,
      input: 1334,
      output: 75,
      reasoning: 9,
      cache: { write: 0, read: 62705 },
    },
    time: { created: 1000, ...(completed !== null ? { completed } : {}) },
  });
const parts = [
  { type: 'step-start' },
  {
    type: 'reasoning',
    text: '',
    time: { start: 1100 },
    metadata: { openai: { reasoningEncryptedContent: 'x' } },
  },
  { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed' } },
  { type: 'tool', tool: 'read', callID: 'call_2', state: { status: 'completed' } },
  { type: 'text', text: 'done', time: { start: 1200 } },
  { type: 'step-finish', tokens: {} },
  { type: 'brand-new-part' },
];

describe('parseOpencodeRows', () => {
  it('one usage per completed message, tools counted from its parts, text and reasoning joined', () => {
    const rows: OpencodeRow[] = parts.map((p) => ({
      mid: 'msg_1',
      mt: 1000,
      md: message(1300),
      pd: JSON.stringify(p),
    }));
    expect(parseOpencodeRows(rows)).toEqual([
      {
        kind: 'reasoning',
        ts: 1100,
        tool_use_id: 'call_1',
        detail: { parser: OPENCODE_TRANSCRIPT_PARSER, reasoning_bytes: 0, encrypted: true },
      },
      {
        kind: 'assistant_text',
        ts: 1200,
        tool_use_id: 'call_1',
        detail: { parser: OPENCODE_TRANSCRIPT_PARSER, assistant_bytes: 4 },
        text: 'done',
      },
      {
        kind: 'usage',
        ts: 1300,
        tool_use_id: 'call_1',
        detail: {
          parser: OPENCODE_TRANSCRIPT_PARSER,
          model: 'gpt-6-luna',
          input_tokens: 1334,
          output_tokens: 75,
          reasoning_tokens: 9,
          cache_read_tokens: 62705,
          cache_creation_tokens: 0,
          total_tokens: 64123,
          tool_uses: 2,
          unknown_parts: 1,
        },
      },
    ]);
  });

  it('a message whose JSON does not parse is one `unknown`, never dropped', () => {
    const records = parseOpencodeRows([{ mid: 'm', mt: 1, md: '{nope', pd: null }]);
    expect(records).toEqual([
      {
        kind: 'unknown',
        detail: { parser: OPENCODE_TRANSCRIPT_PARSER, bytes: 5, parse_error: true },
      },
    ]);
  });
});

describe('opencodeDbPath', () => {
  it('follows XDG_DATA_HOME, else ~/.local/share', () => {
    expect(opencodeDbPath({ XDG_DATA_HOME: '/x' })).toBe(join('/x', 'opencode', 'opencode.db'));
    expect(opencodeDbPath({})).toMatch(/\.local\/share\/opencode\/opencode\.db$/);
  });
});

/** The read against a real store, through the same `sqlite3` CLI the tap uses. */
describe('opencodeReadSql', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const hasSqlite = (() => {
    try {
      execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasSqlite)(
    'reads completed assistant messages after the cursor, with their parts, oldest first',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'oc-db-'));
      const db = join(dir, 'opencode.db');
      const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
      const rows: string[] = [
        'CREATE TABLE message (id text, session_id text, time_created integer, time_updated integer, data text);',
        'CREATE TABLE part (id text, message_id text, session_id text, time_created integer, time_updated integer, data text);',
        `INSERT INTO message VALUES ('m1','s',100,0,${q(message(150))});`,
        `INSERT INTO message VALUES ('m2','s',200,0,${q(message(250))});`,
        `INSERT INTO message VALUES ('m3','s',300,0,${q(message(null))});`, // still streaming
        `INSERT INTO message VALUES ('u1','s',210,0,${q(JSON.stringify({ role: 'user' }))});`,
        `INSERT INTO message VALUES ('x1','other',220,0,${q(message(260))});`,
        `INSERT INTO part VALUES ('p1','m2','s',0,0,${q(JSON.stringify({ type: 'tool', callID: 'c' }))});`,
        `INSERT INTO part VALUES ('p2','m2','s',0,0,${q(JSON.stringify({ type: 'text', text: 'hi' }))});`,
      ];
      execFileSync('sqlite3', [db, rows.join('\n')]);
      const out = execFileSync(
        'sqlite3',
        ['-readonly', '-json', db, opencodeReadSql('s', 100, 10)],
        {
          encoding: 'utf8',
        },
      );
      const got = JSON.parse(out) as OpencodeRow[];
      expect(
        got.map((r) => [r.mid, r.mt, r.pd ? (JSON.parse(r.pd) as { type: string }).type : null]),
      ).toEqual([
        ['m2', 200, 'tool'],
        ['m2', 200, 'text'],
      ]);
      expect(parseOpencodeRows(got).find((r) => r.kind === 'usage')?.detail['tool_uses']).toBe(1);
    },
  );

  it.skipIf(!hasSqlite)('reads the 2.x session_message layout (OpenCode 2.2.2)', () => {
    dir = mkdtempSync(join(tmpdir(), 'oc-db-'));
    const db = join(dir, 'opencode.db');
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const v2 = (completed: number | null) =>
      JSON.stringify({ time: { created: 1, completed }, content: [{ type: 'text', text: 'hi' }] });
    execFileSync('sqlite3', [
      db,
      [
        'CREATE TABLE session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);',
        `INSERT INTO session_message VALUES ('m1','s','assistant',1,100,0,${q(v2(150))});`,
        `INSERT INTO session_message VALUES ('m2','s','assistant',2,200,0,${q(v2(250))});`,
        `INSERT INTO session_message VALUES ('m3','s','assistant',3,300,0,${q(v2(null))});`,
        `INSERT INTO session_message VALUES ('u1','s','user',4,210,0,${q('{}')});`,
        `INSERT INTO session_message VALUES ('x1','other','assistant',1,220,0,${q(v2(260))});`,
      ].join('\n'),
    ]);
    const out = execFileSync(
      'sqlite3',
      ['-readonly', '-json', db, opencodeReadSqlV2('s', 100, 10)],
      {
        encoding: 'utf8',
      },
    );
    expect((JSON.parse(out) as { mid: string }[]).map((r) => r.mid)).toEqual(['m2']);
  });
});

describe('readOpencodeRows (OpenCode 2.x store, lane 01M6C85RT9)', () => {
  const md = JSON.stringify({
    time: { created: 10, completed: 20 },
    model: { id: 'big-pickle', providerID: 'opencode' },
    finish: 'tool-calls',
    tokens: { input: 5, output: 7, reasoning: 0, cache: { read: 100, write: 0 } },
    content: [
      { type: 'text', text: 'Looking.' },
      {
        type: 'tool',
        id: 'call_1',
        name: 'shell',
        state: { input: { command: 'ls' } },
        time: { created: 12 },
      },
    ],
  });

  it('reads session_message first and yields v1-shaped rows the parser counts', async () => {
    const asked: string[] = [];
    const rows = await readOpencodeRows(
      async (_db, sql) => (asked.push(sql), JSON.stringify([{ mid: 'm1', mt: 10, md }])),
      '/db',
      'ses_1',
      0,
      400,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('FROM session_message');
    expect(rows).toHaveLength(2);
    const records = parseOpencodeRows(rows!);
    const usage = records.find((r) => r.kind === 'usage')!;
    expect(usage.tool_use_id).toBe('call_1');
    expect(usage.detail).toMatchObject({
      model: 'big-pickle',
      input_tokens: 5,
      output_tokens: 7,
      cache_read_tokens: 100,
      tool_uses: 1,
    });
    expect(records.find((r) => r.kind === 'assistant_text')?.text).toBe('Looking.');
  });

  it('falls back to the v1 tables when session_message is missing, and is null when neither reads', async () => {
    const v1 = JSON.stringify([{ mid: 'm1', mt: 3, md: '{}', pd: null }]);
    const fallback = await readOpencodeRows(
      async (_db, sql) => (sql.includes('session_message') ? null : v1),
      '/db',
      's',
      0,
      10,
    );
    expect(fallback).toEqual([{ mid: 'm1', mt: 3, md: '{}', pd: null }]);
    expect(await readOpencodeRows(async () => null, '/db', 's', 0, 10)).toBeNull();
  });
});
