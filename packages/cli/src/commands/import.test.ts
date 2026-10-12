import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  describe('import github (spec 2026-10-11)', () => {
    type Issue = {
      number: number;
      title: string;
      state: 'open' | 'closed';
      milestone: { number: number; title: string } | null;
    };
    let issues: Issue[];
    let gh: Server;
    const TOKEN = 'ghp_TESTTOKEN_never_printed';
    const saved = { path: process.env['PATH'] };

    beforeEach(async () => {
      issues = [
        { number: 1, title: 'Login fails', state: 'open', milestone: { number: 1, title: 'v1' } },
        { number: 2, title: 'Install guide', state: 'open', milestone: { number: 1, title: 'v1' } },
        { number: 3, title: 'Dark mode', state: 'open', milestone: { number: 2, title: 'v2' } },
      ];
      const api = (i: Issue) => ({
        ...i,
        html_url: `https://github.com/acme/app/issues/${String(i.number)}`,
        repository_url: 'https://api.github.com/repos/acme/app',
        labels: [],
        body: null,
      });
      gh = createHttpServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401).end('{}');
          return;
        }
        const url = req.url ?? '';
        const one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(url);
        res.setHeader('content-type', 'application/json');
        if (one) {
          const i = issues.find((x) => x.number === Number(one[1]));
          if (!i) res.writeHead(404).end('{}');
          else res.end(JSON.stringify(api(i)));
          return;
        }
        res.end(JSON.stringify(issues.filter((i) => i.state === 'open').map(api)));
      });
      await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
      process.env['MUSTERD_GITHUB_API'] =
        `http://127.0.0.1:${String((gh.address() as AddressInfo).port)}`;
      process.env['GITHUB_TOKEN'] = TOKEN;
      // No `gh` on PATH: the token must come from GITHUB_TOKEN, never this machine's own login.
      process.env['PATH'] = dir;
    });
    afterEach(async () => {
      process.env['PATH'] = saved.path;
      delete process.env['MUSTERD_GITHUB_API'];
      delete process.env['GITHUB_TOKEN'];
      await new Promise<void>((r) => gh.close(() => r()));
    });

    const lanesByRef = async () => {
      const { lanes } = await board().laneBoard('dawn', { history: true });
      return new Map(lanes.filter((l) => l.source_ref).map((l) => [l.source_ref!, l]));
    };
    const stageId = (out: string) => /musterd import save (\S+)/.exec(out)![1]!;

    it('imports, then re-syncs renames, closes and new issues, leaving a held lane alone', async () => {
      const first = await capture(() => importCommand(parseArgs(['github', 'acme/app'])));
      expect(first.code).toBe(0);
      expect(first.out).toContain('new 3');
      expect(first.out).not.toContain(TOKEN);
      const id = stageId(first.out);
      expect(readFileSync(join(dir, '.musterd', 'imports', `${id}.json`), 'utf8')).not.toContain(
        TOKEN,
      );
      await capture(() => importCommand(parseArgs(['save', id])));
      let byRef = await lanesByRef();
      expect([...byRef.keys()].sort()).toEqual(['acme/app#1', 'acme/app#2', 'acme/app#3']);
      expect(byRef.get('acme/app#1')!.goal_id).toBe('v1');
      expect((await board().goals('dawn')).goals.map((g) => g.id).sort()).toEqual(['v1', 'v2']);

      issues[0]!.title = 'Login fails on Safari';
      issues[1]!.state = 'closed';
      issues[2]!.state = 'closed';
      issues.push({
        number: 4,
        title: 'Docs site',
        state: 'open',
        milestone: { number: 1, title: 'v1' },
      });
      await board().updateLane('dawn', byRef.get('acme/app#3')!.id, { owner_seat: 'nick' });

      const second = await capture(() => importCommand(parseArgs(['github', 'acme/app'])));
      expect(second.out).toContain('new 1 · renamed 1 · closed upstream: abandon 1 · 1 warning');
      expect(second.out).toContain('↻ renamed: "Login fails" → "Login fails on Safari"');
      expect(second.out).toContain('✕ abandon: Install guide');
      expect(second.out).toMatch(/acme\/app#3 closed upstream — lane \S+ held by nick, left alone/);
      await capture(() => importCommand(parseArgs(['save', stageId(second.out)])));
      byRef = await lanesByRef();
      expect(byRef.get('acme/app#1')!.title).toBe('Login fails on Safari');
      expect(byRef.get('acme/app#2')).toMatchObject({
        state: 'abandoned',
        abandon_reason: 'closed in GitHub (acme/app#2)',
      });
      expect(byRef.get('acme/app#4')).toMatchObject({ state: 'open', goal_id: 'v1' });
      expect(byRef.get('acme/app#3')).toMatchObject({ owner_seat: 'nick' });

      const third = await capture(() => importCommand(parseArgs(['github', 'acme/app'])));
      expect(third.out).not.toMatch(/new \d|abandon \d|renamed \d/);
    });

    it('a refused token stages nothing and exits 2 with the fix', async () => {
      process.env['GITHUB_TOKEN'] = 'wrong';
      await expect(capture(() => importCommand(parseArgs(['github', 'acme/app'])))).rejects.toThrow(
        /GitHub refused the credentials \(401\) — run `gh auth login`, or set GITHUB_TOKEN/,
      );
      expect(listStages(dir)).toEqual([]);
    });
  });

  describe('import linear (spec 2026-10-11)', () => {
    type Issue = { identifier: string; title: string; type: string };
    let issues: Issue[];
    let lin: Server;
    const KEY = 'lin_api_TESTKEY_never_printed';

    beforeEach(async () => {
      issues = [
        { identifier: 'ENG-1', title: 'Login fails', type: 'started' },
        { identifier: 'ENG-2', title: 'Install guide', type: 'backlog' },
      ];
      lin = createHttpServer((req, res) => {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('end', () => {
          res.setHeader('content-type', 'application/json');
          if (req.headers.authorization !== KEY) {
            res.writeHead(400).end(
              JSON.stringify({
                errors: [
                  {
                    message: 'Authentication required',
                    extensions: { code: 'AUTHENTICATION_ERROR' },
                  },
                ],
              }),
            );
            return;
          }
          const q = JSON.parse(raw) as { variables: { id?: string } };
          const node = (i: Issue) => ({
            identifier: i.identifier,
            title: i.title,
            url: `https://linear.app/acme/issue/${i.identifier}`,
            description: null,
            priority: 0,
            project: { id: 'p1', name: 'First release' },
            cycle: null,
          });
          if (q.variables.id) {
            const i = issues.find((x) => x.identifier === q.variables.id)!;
            res.end(
              JSON.stringify({
                data: {
                  issue: { identifier: i.identifier, archivedAt: null, state: { type: i.type } },
                },
              }),
            );
            return;
          }
          const open = issues.filter((i) => i.type !== 'completed' && i.type !== 'canceled');
          res.end(
            JSON.stringify({
              data: {
                issues: {
                  nodes: open.map(node),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }),
          );
        });
      });
      await new Promise<void>((r) => lin.listen(0, '127.0.0.1', r));
      process.env['MUSTERD_LINEAR_API'] =
        `http://127.0.0.1:${String((lin.address() as AddressInfo).port)}/graphql`;
      process.env['LINEAR_API_KEY'] = KEY;
    });
    afterEach(async () => {
      delete process.env['MUSTERD_LINEAR_API'];
      delete process.env['LINEAR_API_KEY'];
      await new Promise<void>((r) => lin.close(() => r()));
    });

    const stageId = (out: string) => /musterd import save (\S+)/.exec(out)![1]!;

    it('imports a team, then re-syncs a rename and a completed issue', async () => {
      const first = await capture(() => importCommand(parseArgs(['linear', 'ENG'])));
      expect(first.out).toContain('new 2');
      expect(first.out).not.toContain(KEY);
      await capture(() => importCommand(parseArgs(['save', stageId(first.out)])));

      issues[0]!.title = 'Login fails on Safari';
      issues[1]!.type = 'completed';
      const second = await capture(() => importCommand(parseArgs(['linear', 'ENG'])));
      expect(second.out).toContain('renamed 1 · closed upstream: abandon 1');
      await capture(() => importCommand(parseArgs(['save', stageId(second.out)])));
      const { lanes } = await board().laneBoard('dawn', { history: true });
      const byRef = new Map(lanes.map((l) => [l.source_ref, l]));
      expect(byRef.get('ENG-1')!.title).toBe('Login fails on Safari');
      expect(byRef.get('ENG-2')).toMatchObject({
        state: 'abandoned',
        abandon_reason: 'closed in Linear (ENG-2)',
      });
      expect(byRef.get('ENG-1')!.goal_id).toBe('first-release');
    });

    it('needs the team key, and a wrong key is exit 2', async () => {
      await expect(capture(() => importCommand(parseArgs(['linear'])))).rejects.toThrow(
        /musterd import linear <TEAM-KEY>/,
      );
      process.env['LINEAR_API_KEY'] = 'wrong';
      await expect(capture(() => importCommand(parseArgs(['linear', 'ENG'])))).rejects.toThrow(
        /^Linear refused the key/,
      );
      expect(listStages(dir)).toEqual([]);
    });
  });
});
