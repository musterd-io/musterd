import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig, saveBinding } from '../config.js';
import { listStages } from '../import/stage.js';
import { claimAgentHttp } from '../test-auth.js';
import { importCommand } from './import.js';
import { teamCommand } from './team.js';

const CSV =
  'kind,key,title,goal,depends_on,stakes\n' +
  'goal,first-run,First run,,,\n' +
  'lane,a,Import command,first-run,,high\n' +
  'lane,b,Skill,first-run,a,\n';

describe('import command', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-import-cmd-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));

    const config = loadConfig();
    await board().addMember('dawn', { name: 'Ada', kind: 'agent' });
    const adaAuth = await claimAgentHttp(
      process.env['MUSTERD_SERVER']!,
      'dawn',
      config.agentKeys['dawn']!,
      config.identities['dawn']!.key,
      'Ada',
    );
    saveBinding(dir, {
      version: 2,
      server: process.env['MUSTERD_SERVER']!,
      team: 'dawn',
      agent_key: config.agentKeys['dawn']!,
      seat_credential: adaAuth.key,
      session_lease: adaAuth.sessionLease,
      claim: { mode: 'seat', name: 'Ada' },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

  /** nick's client, for reading the board and seeding it — the command under test acts as Ada. */
  function board(): HttpClient {
    return new HttpClient({
      server: process.env['MUSTERD_SERVER']!,
      key: loadConfig().identities['dawn']!.key,
      seat: 'nick',
    });
  }

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: never) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  it('previews and stages without creating anything, then saves goals and lanes', async () => {
    writeFileSync(join(dir, 'backlog.csv'), CSV);
    const preview = await capture(() => importCommand(parseArgs(['backlog.csv'])));
    expect(preview.code).toBe(0);
    expect(preview.out).toContain('1 goal, 2 lanes');
    const [stage] = listStages(dir);
    expect(preview.out).toContain(`next: musterd import save ${stage!.id}`);
    expect((await board().laneBoard('dawn')).lanes).toEqual([]);

    const saved = await capture(() => importCommand(parseArgs(['save', stage!.id])));
    expect(saved.code).toBe(0);
    expect(saved.out).toMatch(/✓ 1 goal, 2 lanes/);
    expect(saved.out).toContain('/live?team=dawn');
    const lanes = (await board().laneBoard('dawn')).lanes;
    const a = lanes.find((l) => l.title === 'Import command')!;
    const b = lanes.find((l) => l.title === 'Skill')!;
    expect(a).toMatchObject({
      state: 'open',
      owner_seat: null,
      goal_id: 'first-run',
      stakes: 'high',
    });
    expect(b.depends_on).toEqual([a.id]);
    expect((await board().goals('dawn')).goals.map((g) => g.id)).toContain('first-run');
  });

  it('exits 1 on errors and refuses to save that stage', async () => {
    writeFileSync(join(dir, 'bad.csv'), 'kind,title,goal\nlane,X,missing-goal\n');
    const preview = await capture(() => importCommand(parseArgs(['bad.csv'])));
    expect(preview.code).toBe(1);
    expect(preview.out).toContain('1 error');
    const [stage] = listStages(dir);
    await expect(importCommand(parseArgs(['save', stage!.id]))).rejects.toThrow(/1 error/);
    expect((await board().laneBoard('dawn')).lanes).toEqual([]);
  });

  it('links an existing goal without re-declaring it', async () => {
    await board().declareGoal('dawn', {
      id: 'first-run',
      title: 'Original title',
      story: 'Original story',
    });
    writeFileSync(
      join(dir, 'b.csv'),
      'kind,key,title,goal\ngoal,first-run,New title,\nlane,,L,first-run\n',
    );
    const preview = await capture(() => importCommand(parseArgs(['b.csv'])));
    expect(preview.out).toContain('linked, not re-declared');
    const [stage] = listStages(dir);
    await capture(() => importCommand(parseArgs(['save', stage!.id])));
    const goal = (await board().goals('dawn')).goals.find((g) => g.id === 'first-run')!;
    expect(goal.title).toBe('Original title');
    expect((await board().laneBoard('dawn')).lanes.map((l) => l.goal_id)).toEqual(['first-run']);
  });

  it('lists staged imports', async () => {
    writeFileSync(join(dir, 'backlog.csv'), CSV);
    await capture(() => importCommand(parseArgs(['backlog.csv'])));
    const out = await capture(() => importCommand(parseArgs(['list'])));
    expect(out.out).toMatch(/backlog\.csv · 1 goal, 2 lanes · ready to save/);
  });

  it('writes a blank sheet, refuses to overwrite it, and the preview flags its examples', async () => {
    const out = await capture(() => importCommand(parseArgs(['sheet'])));
    expect(out.code).toBe(0);
    const rel = out.out.match(/✓ wrote (\.musterd\/imports\/sheet-\d{8}\.csv)/)![1]!;
    expect(out.out).toContain(`then: musterd import ${rel}`);
    await expect(importCommand(parseArgs(['sheet']))).rejects.toThrow(/already exists/);

    const preview = await capture(() => importCommand(parseArgs([rel])));
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("still the sheet's example");
  });

  it('refuses a file it cannot read', async () => {
    await expect(importCommand(parseArgs(['nope.csv']))).rejects.toThrow(/cannot read nope\.csv/);
    // the imports folder ignores itself before anything else can fail, so a draft the skill
    // wrote there is never committed (review finding)
    expect(readFileSync(join(dir, '.musterd', 'imports', '.gitignore'), 'utf8')).toBe('*\n');
  });
});
