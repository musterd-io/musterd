import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsMusterdCredential } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { seatsCommand } from './seats.js';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-seats-')));
  const dir = join(home, 'musterd', 'acme', 'proj', 'ada');
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:9',
      team: 'acme',
      claim: { mode: 'seat', name: 'ada' },
      agent_key: 'mskey_SECRET',
    }),
  );
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function capture(fn: () => Promise<number>) {
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

describe('musterd seats (ADR 491)', () => {
  const offline = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  it('--json lists every seat, secret-free', async () => {
    const { code, out } = await capture(() =>
      seatsCommand(parseArgs(['--json']), { home, fetch: offline }),
    );
    expect(code).toBe(0);
    const json = JSON.parse(out);
    expect(json.seats.map((s: { address: string }) => s.address)).toEqual(['acme/proj/ada']);
    expect(json.seats[0]).toMatchObject({ live: null, last_used: null });
    expect(containsMusterdCredential(out)).toBe(false);
  });

  it('--json carries the roster-first rows with where/can when the roster answers (ADR 503)', async () => {
    const page = {
      node: { id: 'n-hub', label: 'mac' },
      members: [
        {
          id: 'm-ada',
          team: 'acme',
          name: 'ada',
          kind: 'agent',
          created_at: 1,
          presence: 'offline',
          presences: [],
          residence: { node: 'n-hub', node_label: 'mac', kind: 'node' },
          wakeable: true,
        },
        {
          id: 'm-bo',
          team: 'acme',
          name: 'bo',
          kind: 'agent',
          created_at: 1,
          presence: 'offline',
          presences: [],
          residence: { node: 'n-air', node_label: 'air-2', kind: 'node' },
          wakeable: true,
        },
      ],
    };
    const answering = (async () =>
      new Response(JSON.stringify(page), { status: 200 })) as unknown as typeof fetch;
    const { out } = await capture(() =>
      seatsCommand(parseArgs(['--json']), { home, fetch: answering }),
    );
    const json = JSON.parse(out);
    expect(json.members).toEqual([
      {
        team: 'acme',
        member: 'ada',
        kind: 'agent',
        address: 'acme/proj/ada',
        where: 'here',
        node: 'n-hub',
        where_label: null,
        can: 'launch',
      },
      {
        team: 'acme',
        member: 'bo',
        kind: 'agent',
        address: null,
        where: 'node',
        node: 'n-air',
        where_label: 'air-2',
        can: 'none',
      },
    ]);
    expect(json.roster_missing).toEqual([]);
  });

  it('names the teams whose roster did not answer — the list is folder-only for them', async () => {
    const { out } = await capture(() =>
      seatsCommand(parseArgs(['--json']), { home, fetch: offline }),
    );
    expect(JSON.parse(out)).toMatchObject({ members: [], roster_missing: ['acme'] });
  });

  it('cmd/seats — the grouped list with the team block (figma-brief-terminal.md frame 18)', async () => {
    const page = {
      node: { id: 'n-hub', label: 'mac' },
      members: [
        {
          id: 'm-ada',
          team: 'acme',
          name: 'ada',
          kind: 'agent',
          created_at: 1,
          presence: 'offline',
          presences: [],
          residence: { node: 'n-hub', node_label: 'mac', kind: 'node' },
          wakeable: true,
        },
        {
          id: 'm-bo',
          team: 'acme',
          name: 'bo',
          kind: 'agent',
          created_at: 1,
          presence: 'offline',
          presences: [],
          residence: { node: 'n-air', node_label: 'air-2', kind: 'node' },
          wakeable: true,
          sponsored_by: 'm-nick',
        },
        {
          id: 'm-cy',
          team: 'acme',
          name: 'cy',
          kind: 'agent',
          created_at: 1,
          presence: 'offline',
          presences: [],
          residence: { node: 'n-air', node_label: 'air-2', kind: 'node' },
          wakeable: true,
        },
        {
          id: 'm-nick',
          team: 'acme',
          name: 'nick',
          kind: 'human',
          created_at: 1,
          presence: 'offline',
          presences: [],
          roles: [],
        },
      ],
    };
    const answering = (async () =>
      new Response(JSON.stringify(page), { status: 200 })) as unknown as typeof fetch;
    const nick = join(home, 'musterd', 'acme', 'proj', 'nick');
    mkdirSync(join(nick, '.musterd'), { recursive: true });
    writeFileSync(
      join(nick, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:9',
        team: 'acme',
        claim: { mode: 'seat', name: 'nick' },
        agent_key: 'mscr_SECRET',
      }),
    );
    const { out } = await capture(() => seatsCommand(parseArgs([]), { home, fetch: answering }));
    expect(out).toBe(
      [
        'seats on this machine · 2',
        '',
        'acme/proj',
        '  ada   claude   ○ idle',
        '  nick  human    ○ idle',
        '',
        'acme · on the team',
        '  bo  on air-2  wake',
        '  cy  on air-2',
        '',
      ].join('\n'),
    );
  });

  it('prints the grouped list', async () => {
    const { out } = await capture(() => seatsCommand(parseArgs([]), { home, fetch: offline }));
    expect(out).toBe(
      "seats on this machine · 1\n\nacme/proj\n  ada  claude   ○ idle\n\nacme: roster unavailable — this machine's folders only\n",
    );
  });
});
