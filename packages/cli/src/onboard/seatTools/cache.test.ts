import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeatToolsPolicySchema } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { FLOOR_DENIED_SKILLS, installSeatPermissions } from '../permissions.js';
import { memoryFs } from '../reconcile/context.js';
import { loadDeclaredSet, SEAT_TOOLS_CACHE_REL, seatToolsCacheDenies } from './cache.js';

const root = '/w/seat';
const cachePath = `${root}/${SEAT_TOOLS_CACHE_REL}`;
const policy = SeatToolsPolicySchema.parse({
  shared: { claude_plugins: ['github@claude-plugins-official'] },
  roles: { designer: { claude_plugins: ['figma@claude-plugins-official'] } },
});
const down = () => Promise.reject(new Error('ECONNREFUSED'));

describe('loadDeclaredSet (ADR 794 §1c — fail closed)', () => {
  it('a good read returns source server and writes the cache', async () => {
    const fs = memoryFs();
    const set = await loadDeclaredSet({
      worktreeRoot: root,
      fs,
      fetch: () => Promise.resolve(policy),
      roles: ['designer'],
      now: 1_000,
    });
    expect(set.source).toBe('server');
    expect(set.readAt).toBe(1_000);
    expect(set.claude_plugins).toEqual([
      'figma@claude-plugins-official',
      'github@claude-plugins-official',
    ]);
    expect(JSON.parse(fs.files.get(cachePath)!).claude_plugins).toEqual(set.claude_plugins);
  });

  it('a failed read returns the cached set with source cache', async () => {
    const fs = memoryFs();
    await loadDeclaredSet({
      worktreeRoot: root,
      fs,
      fetch: () => Promise.resolve(policy),
      roles: ['designer'],
      now: 1_000,
    });
    const set = await loadDeclaredSet({
      worktreeRoot: root,
      fs,
      fetch: down,
      roles: [],
      now: 2_000,
    });
    expect(set.source).toBe('cache');
    expect(set.readAt).toBe(1_000);
    expect(set.claude_plugins).toContain('figma@claude-plugins-official');
  });

  it('no cache and no daemon gives repo tools and the floor', async () => {
    const set = await loadDeclaredSet({
      worktreeRoot: root,
      fs: memoryFs(),
      fetch: down,
      roles: ['designer'],
      now: 1,
    });
    expect(set).toEqual({
      claude_plugins: [],
      codex_plugins: [],
      skills: [],
      mcp_servers: [],
      deniedSkills: [...FLOOR_DENIED_SKILLS],
      source: 'none',
      readAt: null,
    });
  });

  it('a corrupt cache reads as none, never as wider', async () => {
    for (const body of ['{not json', JSON.stringify({ claude_plugins: ['bad id'] })]) {
      const fs = memoryFs({ [cachePath]: body });
      const set = await loadDeclaredSet({ worktreeRoot: root, fs, fetch: down, roles: [], now: 1 });
      expect(set.source).toBe('none');
      expect(set.claude_plugins).toEqual([]);
    }
  });

  it('a cached set always carries the floor, whatever the file says', async () => {
    const fs = memoryFs({
      [cachePath]: JSON.stringify({
        claude_plugins: [],
        codex_plugins: [],
        skills: [],
        mcp_servers: [],
        deniedSkills: [],
        readAt: 5,
      }),
    });
    const set = await loadDeclaredSet({ worktreeRoot: root, fs, fetch: down, roles: [], now: 9 });
    expect(set.deniedSkills).toEqual([...FLOOR_DENIED_SKILLS]);
  });
});

describe("the cache is behind the seat's Edit/Write deny (Review Focus 4)", () => {
  it("cache path is in the seat's deny list", () => {
    expect(seatToolsCacheDenies()).toEqual([
      `Edit(/${SEAT_TOOLS_CACHE_REL})`,
      `Write(/${SEAT_TOOLS_CACHE_REL})`,
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'musterd-seattools-'));
    try {
      installSeatPermissions(dir, undefined, {});
      const deny = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))
        .permissions.deny as string[];
      for (const entry of seatToolsCacheDenies()) expect(deny).toContain(entry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
