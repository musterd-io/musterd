import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { DREAMING_SKILL_PATH, dreamCommand, dreamingSkill } from './dream.js';
import { teamCommand } from './team.js';

describe('dream command (goal dreaming, lane 2)', () => {
  let server: RunningServer;
  let dir: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    previousEnv = {
      MUSTERD_SERVER: process.env['MUSTERD_SERVER'],
      MUSTERD_CONFIG: process.env['MUSTERD_CONFIG'],
      MUSTERD_NO_NUDGE: process.env['MUSTERD_NO_NUDGE'],
    };
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-dream-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_NUDGE'] = '1';
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function capture(fn: () => Promise<number>): Promise<string> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: never) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await fn();
      return chunks.join('');
    } finally {
      spy.mockRestore();
    }
  }

  it("prints the caller's own packet as JSON and rejects a non-numeric --since", async () => {
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
    const out = await capture(() => dreamCommand(parseArgs(['--since', '0'])));
    const built = JSON.parse(out);
    expect(built).toMatchObject({ packet: { seat: 'nick', since: 0 }, truncated: false });
    expect(built.used_bytes).toBeGreaterThan(0);
    // Lane 01M44B3C5Q: the skill rides the packet, read from this build — not the cwd's workspace.
    expect(built.skill?.path).toMatch(/\.agents\/skills\/dreaming\/SKILL\.md$/);
    expect(built.skill?.path.startsWith(dir)).toBe(false);
    await expect(dreamCommand(parseArgs(['--since', 'yesterday']))).rejects.toThrow(
      /--since <epoch-ms>/,
    );
  });
});

// Lane 01M44B3C5Q: the skill comes from the running build's checkout, never the seat's workspace.
describe('dreamingSkill', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-dream-skill-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds the skill at the build's checkout root, walking up from the module", () => {
    mkdirSync(join(root, '.agents/skills/dreaming'), { recursive: true });
    writeFileSync(join(root, DREAMING_SKILL_PATH), '# Dreaming\n');
    const from = join(root, 'packages/cli/dist/commands/dream.js');
    expect(dreamingSkill(from)).toEqual({
      path: join(root, DREAMING_SKILL_PATH),
      text: '# Dreaming\n',
    });
  });

  it('is null for a build that is not a checkout (a published package ships dist only)', () => {
    expect(
      dreamingSkill(join(root, 'node_modules/@musterd/cli/dist/commands/dream.js')),
    ).toBeNull();
  });

  it('this repo’s own build carries it', () => {
    expect(dreamingSkill()?.text).toContain('dream');
  });
});
