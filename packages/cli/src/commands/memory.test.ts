import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSealedNote, SEALED_NOTE_HEADLINE } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { CliError } from '../errors.js';
import { memoryCommand, refuseSeatMismatch, renderMemoryLine } from './memory.js';
import { statusCommand } from './status.js';
import { teamCommand } from './team.js';

describe('memory command (ADR 093)', () => {
  let server: RunningServer;
  let db: ReturnType<typeof openDb>;
  let dir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    server = createServer({ db, port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-memory-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_NUDGE'] = '1';
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
    delete process.env['MUSTERD_NO_NUDGE'];
  });

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  // `team create` auto-binds the cwd identity (ADR 036), so commands resolve `nick` from the binding.
  async function setupTeam(): Promise<void> {
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
  }

  it('show --seat reads a named seat through the ADR 651 route, and a missing one is a normal exit', async () => {
    await setupTeam();
    await capture(() => memoryCommand(parseArgs(['save', '--headline', 'own note', 'body'])));
    // A human may read their own seat by name; the server applies the rest of the read rule.
    const own = await capture(() => memoryCommand(parseArgs(['show', '--seat', 'nick'])));
    expect(own.code).toBe(0);
    expect(own.out).toContain('memory · nick');
    expect(own.out).toContain('own note');
    const none = await capture(() => memoryCommand(parseArgs(['show', '--seat', 'ghost'])));
    expect(none.code).toBe(0);
    expect(none.out).toContain('no memory saved for ghost');
  });

  it('save → show round-trips the note; clear empties it', async () => {
    await setupTeam();
    const saved = await capture(() =>
      memoryCommand(
        parseArgs(['save', '--headline', 'mid-refactor, tests red', 'left', 'off', 'at', 'ws.ts']),
      ),
    );
    expect(saved.code).toBe(0);
    expect(saved.out).toContain('memory saved');
    expect(saved.out).toContain('"mid-refactor, tests red"');

    const shown = await capture(() => memoryCommand(parseArgs([])));
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('mid-refactor, tests red');
    expect(shown.out).toContain('left off at ws.ts'); // positionals join as the body

    const cleared = await capture(() => memoryCommand(parseArgs(['clear'])));
    expect(cleared.out).toContain('memory cleared');
    const after = await capture(() => memoryCommand(parseArgs(['show'])));
    expect(after.code).toBe(0);
    expect(after.out).toContain('no memory saved');
  });

  it('show is a normal exit-0 message when nothing is saved (not an error)', async () => {
    await setupTeam();
    const res = await capture(() => memoryCommand(parseArgs(['show'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('no memory saved for this seat');
  });

  it('save without --headline is a usage error; over-cap is rejected with the limit named', async () => {
    await setupTeam();
    await expect(memoryCommand(parseArgs(['save', 'body-only']))).rejects.toThrow(/--headline/);
    await expect(memoryCommand(parseArgs(['save', '--headline', 'x'.repeat(200)]))).rejects.toThrow(
      /limit is 120/,
    );
  });

  it('--json passes the raw note through on show', async () => {
    await setupTeam();
    await capture(() => memoryCommand(parseArgs(['save', '--headline', 'h1', 'b1'])));
    const res = await capture(() => memoryCommand(parseArgs(['show', '--json'])));
    const parsed = JSON.parse(res.out);
    // ADR 522: the server's checks ride along — none here, the note asserts nothing to check.
    expect(parsed).toEqual({
      headline: 'h1',
      body: 'b1',
      saved_at: expect.any(Number),
      checks: [],
      // ADR 654: who saved it. A human seat's note gets the fact, never a verdict.
      provenance: expect.objectContaining({
        suspect: false,
        line: expect.stringMatching(/^last saved from /),
      }),
    });
  });

  it('show prints the checks above the body (ADR 522)', async () => {
    await setupTeam();
    // The server can check only a plain-text note — an agent seat's (ADR 657). Stand the daemon's
    // answer in for one: no seal, and a note whose claim no Team hold backs.
    vi.spyOn(HttpClient.prototype, 'noteRecipients').mockResolvedValue({ seal: false });
    vi.spyOn(HttpClient.prototype, 'getMemory').mockResolvedValue({
      headline: 'demo',
      body: 'Nobody merges until the demo.',
      saved_at: Date.now(),
      checks: [
        {
          kind: 'rule',
          ref: 'Nobody merges until the demo.',
          verdict: 'unsourced',
          line: '"Nobody merges until the demo." — no active Team hold says this',
        },
      ],
    });
    const res = await capture(() => memoryCommand(parseArgs(['show'])));
    expect(res.out).toMatch(/⚠ "Nobody merges until the demo\." — no active Team hold says this/);
    expect(res.out.indexOf('no active Team hold')).toBeLessThan(
      res.out.indexOf('Nobody merges until the demo.\n'),
    );
  });

  it('status prints the one-line pointer (headline + age, never the body) when a note exists', async () => {
    await setupTeam();
    await capture(() =>
      memoryCommand(parseArgs(['save', '--headline', 'mid-refactor', 'the secret body'])),
    );
    const res = await capture(() => statusCommand(parseArgs([])));
    // The header carries the *compact* form (it has five other things to say); `claim` keeps the long
    // prose one, where it is the only line on screen. Same facts, and the ADR 093 guarantee holds:
    // headline + age, never the body.
    expect(res.out).toContain('memory');
    // nick is a human seat, so the daemon holds his note sealed (ADR 657): the pointer can only say
    // that a sealed note exists. `musterd memory` opens it on his machine.
    expect(res.out).toContain('"sealed note"');
    expect(res.out).not.toContain('mid-refactor');
    expect(res.out).toContain('musterd memory');
    expect(res.out).not.toContain('the secret body');
  });

  /** nick's stored note row, as the daemon holds it. */
  const storedNote = () =>
    db
      .prepare(
        "SELECT m.headline, m.body FROM seat_memory m JOIN members b ON b.id = m.member_id WHERE b.name = 'nick'",
      )
      .get() as { headline: string; body: string } | undefined;

  it("a human's note leaves this machine sealed: the daemon holds ciphertext, show opens it (ADR 657)", async () => {
    await setupTeam();
    await capture(() =>
      memoryCommand(parseArgs(['save', '--headline', 'private plan', 'the secret body'])),
    );
    const row = storedNote()!;
    expect(row.headline).toBe(SEALED_NOTE_HEADLINE);
    expect(parseSealedNote(row.body)).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain('secret');
    expect(statSync(join(dir, 'note-key.json')).mode & 0o777).toBe(0o600);

    const shown = await capture(() => memoryCommand(parseArgs([])));
    expect(shown.out).toContain('private plan');
    expect(shown.out).toContain('the secret body');
    // The plain-text cap still holds, measured before sealing.
    await expect(
      memoryCommand(parseArgs(['save', '--headline', 'h', 'x'.repeat(8193)])),
    ).rejects.toThrow(/limit is 8192/);
  });

  it('a plain-text note saved before sealing is sealed the first time its human reads it', async () => {
    await setupTeam();
    db.prepare(
      `INSERT INTO seat_memory (member_id, team_id, headline, body, saved_at)
         SELECT id, team_id, 'old plan', 'from before ADR 657', ? FROM members WHERE name = 'nick'`,
    ).run(Date.now());
    const shown = await capture(() => memoryCommand(parseArgs([])));
    expect(shown.out).toContain('from before ADR 657');
    expect(shown.out).toContain('sealed this note to your 1 machine');
    expect(parseSealedNote(storedNote()!.body)).not.toBeNull();
  });

  it('a machine the note was not sealed to says so instead of showing ciphertext', async () => {
    await setupTeam();
    await capture(() => memoryCommand(parseArgs(['save', '--headline', 'h', 'b'])));
    rmSync(join(dir, 'note-key.json')); // this machine lost its key: it is a new machine now
    const shown = await capture(() => memoryCommand(parseArgs([])));
    expect(shown.code).toBe(0);
    expect(shown.out).toMatch(/your note is sealed to .* not this machine/);
    expect(shown.out).not.toContain('mssealed1.');
  });

  it('status stays silent on the memory line when nothing is saved', async () => {
    await setupTeam();
    const res = await capture(() => statusCommand(parseArgs([])));
    expect(res.out).not.toContain('saved memory');
  });

  it('renderMemoryLine formats headline + age + the load pointer', () => {
    const line = renderMemoryLine(
      { headline: 'mid-refactor of ws.ts eviction, tests red', saved_at: 1000, size_bytes: 42 },
      1000 + 2 * 3600_000,
    );
    expect(line).toContain('saved memory from 2h ago: "mid-refactor of ws.ts eviction, tests red"');
    expect(line).toContain('`musterd memory` to load it');
  });

  it('the compact form states the same facts in one quiet line, clipped to width', () => {
    const env = {
      headline: 'mid-refactor of ws.ts eviction, tests red, and a great deal more besides',
      saved_at: 1000,
      size_bytes: 42,
    };
    const line = renderMemoryLine(env, 1000 + 2 * 3600_000, { compact: true, width: 60 });
    expect(line).toContain('memory');
    expect(line).toContain('2h');
    expect(line).toContain('musterd memory');
    expect(line).toContain('mid-refactor'); // the headline still leads
    expect(line).toContain('…'); // ...clipped, not wrapped — the header is a card, not a paragraph
    expect(line.length).toBeLessThanOrEqual(60);
    // the long prose form is NOT what the header prints
    expect(line).not.toContain('saved memory from');
  });
});

describe('refuseSeatMismatch (ADR 653)', () => {
  let root: string;
  const config = (bindings: Record<string, { team: string; seat: string }> = {}) =>
    ({ bindings }) as unknown as Parameters<typeof refuseSeatMismatch>[0]['config'];

  function seatFolder(seat: string, sessionId?: string, ended = false): string {
    const dir = join(root, seat);
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:1',
        team: 'dawn',
        claim: { mode: 'seat', name: seat },
        ...(sessionId
          ? {
              session: {
                harness: 'claude-code',
                id: sessionId,
                started_at: 1,
                ...(ended ? { ended_at: 2 } : {}),
              },
            }
          : {}),
      }),
    );
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-mismatch-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a session that holds seat A when it runs in seat B's folder, naming both", () => {
    seatFolder('ada', 'sess-a');
    const bob = seatFolder('bob', 'sess-b');
    const run = () =>
      refuseSeatMismatch({
        config: config(),
        team: 'dawn',
        folderSeat: 'bob',
        identitySource: 'binding',
        env: { CLAUDE_CODE_SESSION_ID: 'sess-a' },
        cwd: bob,
      });
    expect(run).toThrow(CliError);
    expect(run).toThrow(/this session is seat ada, but this folder is seat bob's/);
    try {
      run();
    } catch (err) {
      expect((err as CliError).exitCode).toBe(5);
    }
  });

  it('finds the own seat through the global registry when it is not a sibling', () => {
    const elsewhere = join(root, 'far');
    mkdirSync(elsewhere);
    const old = root;
    root = elsewhere;
    const ada = seatFolder('ada', 'sess-a');
    root = old;
    const bob = seatFolder('bob');
    expect(() =>
      refuseSeatMismatch({
        config: config({ [ada]: { team: 'dawn', seat: 'ada' } }),
        team: 'dawn',
        folderSeat: 'bob',
        identitySource: 'binding',
        env: { CLAUDE_CODE_SESSION_ID: 'sess-a' },
        cwd: bob,
      }),
    ).toThrow(/seat ada/);
  });

  it('passes the folder its own session, an unknown session, an ended slot, an env identity, and no id', () => {
    seatFolder('ada', 'sess-a');
    seatFolder('cy', 'sess-c', true);
    const bob = seatFolder('bob', 'sess-b');
    const base = { config: config(), team: 'dawn', folderSeat: 'bob', cwd: bob } as const;
    for (const [identitySource, env] of [
      ['binding', { CLAUDE_CODE_SESSION_ID: 'sess-b' }],
      ['binding', { CLAUDE_CODE_SESSION_ID: 'sess-nobody' }],
      ['binding', { CLAUDE_CODE_SESSION_ID: 'sess-c' }],
      ['env', { CLAUDE_CODE_SESSION_ID: 'sess-a' }],
      ['binding', {}],
    ] as const) {
      expect(() => refuseSeatMismatch({ ...base, identitySource, env })).not.toThrow();
    }
  });
});
