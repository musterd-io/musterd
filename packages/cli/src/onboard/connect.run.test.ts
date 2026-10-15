import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runConnect, seatNameFor } from './connect.js';

const h = vi.hoisted(() => ({
  multiQueue: [] as unknown[],
  multiCalls: [] as { options: { value: string; hint?: string }[]; initialValues: string[] }[],
  recents: [] as { dir: string; harnesses: string[]; lastUsed: number }[],
  provision: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  confirmQueue: [] as boolean[],
  selectQueue: [] as unknown[],
  selectCalls: [] as { message: string }[],
  textQueue: [] as unknown[],
  textCalls: [] as {
    message: string;
    initialValue?: string;
    validate: (v: string) => string | undefined;
  }[],
  notes: [] as string[],
}));

vi.mock('@clack/prompts', () => ({
  isCancel: (v: unknown) => typeof v === 'symbol',
  cancel: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn((body: string) => void h.notes.push(body)),
  log: { info: vi.fn(), warn: vi.fn(), step: vi.fn(), success: vi.fn(), message: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  confirm: vi.fn(async () => h.confirmQueue.shift()),
  select: vi.fn(async (o: { message: string }) => {
    h.selectCalls.push(o);
    return h.selectQueue.length ? h.selectQueue.shift() : 'accept';
  }),
  text: vi.fn(async (o: (typeof h.textCalls)[number]) => {
    h.textCalls.push(o);
    return h.textQueue.shift();
  }),
  multiselect: vi.fn(
    async (o: { options: { value: string; hint?: string }[]; initialValues: string[] }) => {
      h.multiCalls.push(o);
      return h.multiQueue.shift();
    },
  ),
}));
vi.mock('./harnesses/index.js', () => ({
  HARNESSES: [
    { id: 'claude-code', label: 'Claude Code', detect: async () => ({ installed: true }) },
    { id: 'cursor', label: 'Cursor', detect: async () => ({ installed: true }) },
    { id: 'codex', label: 'Codex', detect: async () => ({ installed: false }) },
  ],
  harnessAdapters: () => [
    { id: 'claude-code' },
    { id: 'cursor' },
    { id: 'codex' },
    { id: 'musterd' },
  ],
}));
// The tour handoff — mocked so a "yes" is observable without making a workspace or starting it.
vi.mock('./tourOffer.js', () => ({ startTourAsPerson: vi.fn(async () => 0) }));
vi.mock('./recents.js', () => ({ recentRepos: () => h.recents }));
vi.mock('./agentSeat.js', () => {
  h.provision = vi.fn();
  return { provisionAgentSeat: (...a: unknown[]) => h.provision(...a) };
});

const seat = (dir: string) => ({
  workspace: { dir, kind: 'here', created: false },
  reused: false,
  granted: true,
  wiring: {
    ok: true,
    results: [
      { harness: 'claude-code', result: 'applied' },
      { harness: 'cursor', result: 'applied' },
    ],
  },
  wiringError: null,
  seatFileUnpublished: null,
});

const http = { roster: vi.fn(async () => ({ members: [{ name: 'nick' }] })) } as never;
const input = (cwd: string, home = '/nonexistent-home') => ({
  team: 'revive',
  server: 'http://x',
  http,
  cwd,
  home,
});
const repo = () => realpathSync(mkdtempSync(join(tmpdir(), 'connect-run-')));

beforeEach(async () => {
  const { startTourAsPerson } = await import('./tourOffer.js');
  vi.mocked(startTourAsPerson).mockClear();
  h.confirmQueue.length = 0;
  h.multiQueue.length = 0;
  h.multiCalls.length = 0;
  h.selectQueue.length = 0;
  h.selectCalls.length = 0;
  h.textQueue.length = 0;
  h.textCalls.length = 0;
  h.notes.length = 0;
  h.provision.mockReset();
  h.provision.mockImplementation(async (i: { sourceDir: string }) => seat(i.sourceDir));
});

describe('runConnect', () => {
  it('preselects installed agents, offers this folder first, connects what is picked', async () => {
    const here = repo();
    const web = repo();
    h.recents = [{ dir: web, harnesses: ['cursor'], lastUsed: Date.now() - 2 * 3_600_000 }];
    h.multiQueue.push(['claude-code', 'cursor'], [here, web]);

    expect(await runConnect(input(here))).toBe(0);

    const [agents, repos] = h.multiCalls;
    expect(agents!.initialValues).toEqual(['claude-code', 'cursor']);
    expect(agents!.options.map((o) => o.value)).toEqual(['claude-code', 'cursor', 'codex']);
    expect(agents!.options.find((o) => o.value === 'codex')?.hint).toContain('pending');
    expect(repos!.options.map((o) => o.value)).toEqual([here, web]);
    expect(repos!.initialValues).toEqual([here]);
    expect(repos!.options[1]!.hint).toBe('Cursor · 2h ago');
    expect(h.provision.mock.calls.map(([c]) => [c.sourceDir, c.harnesses])).toEqual([
      [here, ['claude-code', 'cursor']],
      [web, ['claude-code', 'cursor']],
    ]);
  });

  it('refused cwd is not offered', async () => {
    const web = repo();
    h.recents = [{ dir: web, harnesses: ['cursor'], lastUsed: 1 }];
    h.multiQueue.push(['claude-code'], [web]);
    expect(await runConnect(input(homedir(), homedir()))).toBe(0);
    expect(h.multiCalls[1]!.options.map((o) => o.value)).toEqual([web]);
    expect(h.multiCalls[1]!.initialValues).toEqual([]);
  });

  it('no repos picked connects nothing', async () => {
    h.recents = [];
    h.multiQueue.push(['claude-code'], []);
    expect(await runConnect(input(repo()))).toBe(0);
    expect(h.provision).not.toHaveBeenCalled();
  });

  it('exits 1 when any repo failed', async () => {
    h.recents = [];
    h.provision.mockRejectedValueOnce(new Error('mint refused'));
    const here = repo();
    h.multiQueue.push(['claude-code'], [here]);
    expect(await runConnect(input(here))).toBe(1);
  });

  it('offers the tour once a seat is connected, and starts it as the person on yes', async () => {
    const { startTourAsPerson } = await import('./tourOffer.js');
    h.recents = [];
    const here = repo();
    h.multiQueue.push(['claude-code'], [here]);
    h.confirmQueue.push(true);
    expect(await runConnect({ ...input(here), driver: 'nick' })).toBe(0);
    expect(startTourAsPerson).toHaveBeenCalledWith('nick', 'revive');
  });

  it('declining the tour ends as before', async () => {
    const { startTourAsPerson } = await import('./tourOffer.js');
    h.recents = [];
    const here = repo();
    h.multiQueue.push(['claude-code'], [here]);
    h.confirmQueue.push(false);
    expect(await runConnect({ ...input(here), driver: 'nick' })).toBe(0);
    expect(startTourAsPerson).not.toHaveBeenCalled();
  });

  it('no tour offer without a driver or with no seat connected', async () => {
    const p = await import('@clack/prompts');
    vi.mocked(p.confirm).mockClear();
    h.recents = [];
    const here = repo();
    h.multiQueue.push(['claude-code'], [here]);
    expect(await runConnect(input(here))).toBe(0);
    h.provision.mockRejectedValueOnce(new Error('mint refused'));
    h.multiQueue.push(['claude-code'], [here]);
    expect(await runConnect({ ...input(here), driver: 'nick' })).toBe(1);
    expect(p.confirm).not.toHaveBeenCalled();
  });

  it('shows each repo with its seat name and connects with them on Enter', async () => {
    const here = repo();
    const web = repo();
    h.recents = [{ dir: web, harnesses: ['cursor'], lastUsed: 1 }];
    h.multiQueue.push(['claude-code'], [here, web]);

    expect(await runConnect(input(here))).toBe(0);

    expect(h.selectCalls).toHaveLength(1);
    expect(h.textCalls).toHaveLength(0);
    const names = h.notes[0]!;
    expect(names).toContain(seatNameFor(here, ['nick']));
    expect(names).toContain(seatNameFor(web, ['nick']));
    expect(h.provision.mock.calls.map(([c]) => c.name)).toEqual([
      seatNameFor(here, ['nick']),
      seatNameFor(web, ['nick']),
    ]);
  });

  it('flags a folder name that is taken, and says what it became', async () => {
    const here = repo();
    h.recents = [];
    vi.mocked(http as { roster: ReturnType<typeof vi.fn> }).roster.mockResolvedValueOnce({
      members: [{ name: 'nick' }, { name: seatNameFor(here, []) }],
    });
    h.multiQueue.push(['claude-code'], [here]);
    expect(await runConnect(input(here))).toBe(0);
    expect(h.notes[0]).toContain(`${seatNameFor(here, [])} is taken`);
    expect(h.provision.mock.calls[0]![0].name).toBe(`${seatNameFor(here, [])}-2`);
  });

  it('"Change names" asks once per repo, prefilled, and connects with what was typed', async () => {
    const here = repo();
    const web = repo();
    h.recents = [{ dir: web, harnesses: ['cursor'], lastUsed: 1 }];
    h.multiQueue.push(['claude-code'], [here, web]);
    h.selectQueue.push('edit');
    h.textQueue.push('backend', ' frontend ');

    expect(await runConnect(input(here))).toBe(0);

    expect(h.textCalls.map((c) => c.initialValue)).toEqual([
      seatNameFor(here, ['nick']),
      seatNameFor(web, ['nick']),
    ]);
    expect(h.provision.mock.calls.map(([c]) => c.name)).toEqual(['backend', 'frontend']);
  });

  it('the name prompt refuses a roster name and one already picked in this run', async () => {
    const here = repo();
    const web = repo();
    h.recents = [{ dir: web, harnesses: ['cursor'], lastUsed: 1 }];
    h.multiQueue.push(['claude-code'], [here, web]);
    h.selectQueue.push('edit');
    h.textQueue.push('backend', 'frontend');

    await runConnect(input(here));

    const [first, second] = h.textCalls;
    expect(first!.validate('Nick')).toMatch(/taken/);
    expect(first!.validate('has space')).toMatch(/letters/);
    expect(first!.validate('backend')).toBeUndefined();
    expect(second!.validate('backend')).toMatch(/taken/);
  });
});
