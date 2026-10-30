import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope, NextBriefSchema } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig, rememberIdentity, saveConfig } from '../config.js';
import { bindTempWorkspace, claimAgentHttp } from '../test-auth.js';
import { doneCommand } from './done.js';
import { laneCommand, lanesCommand } from './lane.js';
import { nextCommand, renderNext } from './next.js';
import { sendCommand } from './send.js';
import { teamCommand } from './team.js';

/** The exact `cmd/next` frame (figma-brief-terminal.md, ADR 490) — no color, 80 columns. */
const FRAME =
  [
    'next — as Ada',
    '',
    'review promises — 1 you accepted, still open:',
    '  01REQ0000000000000000000001 for nick · accepted 2h ago',
    '    "please check the migration" · PR dawn/app#42',
    '    close: `musterd send --act resolve --thread 01REQ0000000000000000000001 "…"`',
    '',
    'reviews you asked for — 1 accepted, still open:',
    '  01REQ0000000000000000000002 Lin accepted 3d ago',
    '    "sanity-check the roster render" · lane 01ARZ3NDEKTSV4RRFFQ69G5FAV',
    '',
    'review closed for you — by someone else, 1:',
    '  01REQ0000000000000000000003 closed by nick 1h ago',
    '    resolve 01RES0000000000000000000003 — read your inbox and it is gone',
  ].join('\n') + '\n';

/** Covers the orientation pair: `musterd next` (the brief) and `musterd done` (close + chain). */
describe('next / done commands', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-orient-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
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

  async function lastLaneId(): Promise<string> {
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string }[] };
    return lanes[lanes.length - 1]!.id;
  }

  /**
   * The banner reached NO CLI seat through increments 1 and 2 — it was written into the MCP renderer
   * and never here, on the surface that most needs orientation. ADR 266 calls it "the cheapest,
   * highest-leverage piece" precisely because the measured waste was seats STARTING SESSIONS into a
   * shared red they assumed was theirs, and `musterd next` is where a CLI session starts.
   */
  it("next leads with an open incident, above the seat's own work", async () => {
    await capture(() => sendCommand(parseArgs(['--blocked-by', 'ci:gates/A11y contrast'])));
    await capture(() => teamCommand(parseArgs(['add', 'izzo', '--kind', 'agent'])));
    const cfg = loadConfig();
    const authority = await claimAgentHttp(
      serverUrl,
      'dawn',
      cfg.agentKeys['dawn'] as string,
      cfg.identities['dawn']!.key,
      'izzo',
    );
    rememberIdentity(cfg, {
      team: 'dawn',
      name: 'izzo',
      key: authority.key,
      surface: 'cli',
      sessionLease: authority.sessionLease,
    });
    saveConfig(cfg);
    // izzo reports from izzo's own Workspace — ADR 442 removed `--as`.
    vi.spyOn(process, 'cwd').mockReturnValue(bindTempWorkspace('dawn', 'izzo'));
    await capture(() => sendCommand(parseArgs(['--blocked-by', 'ci:gates/A11y contrast'])));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);

    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('incident: ci:gates/A11y contrast');
    expect(res.out).toMatch(/not yours/);
    // Above everything: it must come before the seat's own work, or they decide what they are
    // doing before learning the red is shared. (The incident lane ALSO shows under `up next` — it
    // is unowned and any seat may claim it, which is the design, so that is the anchor here.)
    expect(res.out.indexOf('incident:')).toBeLessThan(res.out.indexOf('up next'));
  });

  it('next renders the empty-brief hint when nothing is in flight', async () => {
    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('nothing in flight');
  });

  it('next renders carrying + up-next once lanes exist', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'carried', '--claim'])));
    await capture(() => laneCommand(parseArgs(['open', 'available'])));
    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.out).toContain('carrying');
    expect(res.out).toContain('carried');
    expect(res.out).toContain('up next');
  });

  it('next --json emits the raw brief', async () => {
    const res = await capture(() => nextCommand(parseArgs(['--json'])));
    const brief = JSON.parse(res.out) as { member: string; in_flight: unknown[] };
    expect(brief.member).toBe('nick');
    expect(Array.isArray(brief.in_flight)).toBe(true);
  });

  it('done auto-targets the caller single live lane and closes it', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'finish me', '--claim'])));
    const res = await capture(() => doneCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('done');
    expect(res.out).toContain('finish me');
  });

  it('done <id> closes a named lane', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'named', '--claim'])));
    const id = await lastLaneId();
    const res = await capture(() => doneCommand(parseArgs([id])));
    expect(res.out).toContain('done');
  });

  it('done errors when there is no live lane', async () => {
    await expect(doneCommand(parseArgs([]))).rejects.toThrow(/no live lane/);
  });

  it('done errors when the caller owns several live lanes', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'one', '--claim'])));
    await capture(() => laneCommand(parseArgs(['open', 'two', '--claim'])));
    await expect(doneCommand(parseArgs([]))).rejects.toThrow(/live lanes/);
  });

  it('done chains into up-next when other open lanes exist', async () => {
    // Another seat opens work so the brief has an up-next entry after we close ours.
    await new HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
    }).openLane('dawn', { title: 'downstream' });
    await capture(() => laneCommand(parseArgs(['open', 'mine', '--claim'])));
    const res = await capture(() => doneCommand(parseArgs([])));
    expect(res.out).toContain('up next');
    expect(res.out).toContain('downstream');
  });

  /**
   * ADR 490: an accepted typed review request stays in front of its owner and its requester until
   * the request's thread resolves. The daemon derives it; `next` is where a CLI seat reads it.
   */
  describe('review promises (ADR 490)', () => {
    const PR = { kind: 'pr', repo: 'org/repo', number: 42 } as const;

    /** nick asks izzo for a review and izzo accepts; returns both clients and izzo's Workspace. */
    async function promised() {
      await capture(() => teamCommand(parseArgs(['add', 'izzo', '--kind', 'agent'])));
      const cfg = loadConfig();
      const nickKey = cfg.identities['dawn']!.key;
      const authority = await claimAgentHttp(
        serverUrl,
        'dawn',
        cfg.agentKeys['dawn'] as string,
        nickKey,
        'izzo',
      );
      rememberIdentity(cfg, {
        team: 'dawn',
        name: 'izzo',
        key: authority.key,
        surface: 'cli',
        sessionLease: authority.sessionLease,
      });
      saveConfig(cfg);
      const nick = new HttpClient({ server: serverUrl, key: nickKey });
      const izzo = new HttpClient({
        server: serverUrl,
        key: authority.key,
        seat: 'izzo',
        sessionLease: authority.sessionLease,
      });
      await nick.send(
        'dawn',
        makeEnvelope({
          id: 'req1',
          team: 'dawn',
          from: 'nick',
          to: { kind: 'member', name: 'izzo' },
          act: 'request_help',
          body: 'please check the migration',
          meta: { review: PR },
        }),
      );
      await izzo.send(
        'dawn',
        makeEnvelope({
          id: 'ok1',
          team: 'dawn',
          from: 'izzo',
          to: { kind: 'member', name: 'nick' },
          act: 'accept',
          body: 'on it',
          meta: { in_reply_to: 'req1' },
        }),
      );
      return { nick, izzoDir: bindTempWorkspace('dawn', 'izzo') };
    }

    it('the owner sees what they accepted, with the context and the close command', async () => {
      const { izzoDir } = await promised();
      vi.spyOn(process, 'cwd').mockReturnValue(izzoDir);
      const res = await capture(() => nextCommand(parseArgs([])));
      expect(res.code).toBe(0);
      expect(res.out).toContain('review promises — 1 you accepted, still open:');
      expect(res.out).toContain('req1 for nick · accepted');
      expect(res.out).toContain('"please check the migration" · PR org/repo#42');
      expect(res.out).toContain('musterd send --act resolve --thread req1');
      expect(res.out).not.toContain('reviews you asked for');
    });

    it('the requester sees who accepted and how long ago', async () => {
      await promised();
      const res = await capture(() => nextCommand(parseArgs([])));
      expect(res.out).toContain('reviews you asked for — 1 accepted, still open:');
      expect(res.out).toMatch(/req1 izzo accepted \d+s ago/);
      expect(res.out).toContain('"please check the migration" · PR org/repo#42');
      expect(res.out).not.toContain('review promises —');
    });

    it('a close by someone other than the owner leaves the owner one notice', async () => {
      const { nick, izzoDir } = await promised();
      await nick.send(
        'dawn',
        makeEnvelope({
          id: 'done1',
          team: 'dawn',
          from: 'nick',
          to: { kind: 'team' },
          act: 'resolve',
          body: 'withdrawn',
          thread: 'req1',
        }),
      );
      const requester = await capture(() => nextCommand(parseArgs([])));
      expect(requester.out).not.toContain('reviews you asked for');
      expect(requester.out).not.toContain('review closed for you');
      vi.spyOn(process, 'cwd').mockReturnValue(izzoDir);
      const owner = await capture(() => nextCommand(parseArgs([])));
      expect(owner.out).not.toContain('review promises —');
      expect(owner.out).toContain('review closed for you — by someone else, 1:');
      expect(owner.out).toContain('req1 closed by nick');
      expect(owner.out).toContain('resolve done1');
    });

    /** The `cmd/next` frame (figma-brief-terminal.md): renderer and frame match character-for-character. */
    it('renders the cmd/next frame exactly, with the three sections and a fixed clock', async () => {
      const NOW = 1_790_000_000_000;
      const H = 3_600_000;
      const brief = NextBriefSchema.parse({
        member: 'Ada',
        in_flight: [],
        shipped: [],
        up_next: [],
        why: null,
        next_goal: null,
        review_debt_total: 0,
        incidents: [],
        request_reviews: [
          {
            request_id: '01REQ0000000000000000000001',
            requester: 'nick',
            owner: 'Ada',
            context: 'please check the migration',
            review: { kind: 'pr', repo: 'dawn/app', number: 42 },
            accepted_at: NOW - 2 * H,
          },
        ],
        requested_reviews: [
          {
            request_id: '01REQ0000000000000000000002',
            requester: 'Ada',
            owner: 'Lin',
            context: 'sanity-check the roster render',
            review: { kind: 'lane', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
            accepted_at: NOW - 3 * 24 * H,
          },
        ],
        review_closures: [
          {
            request_id: '01REQ0000000000000000000003',
            resolve_id: '01RES0000000000000000000003',
            closer: 'nick',
            resolved_at: NOW - H,
          },
        ],
      });
      const res = await capture(async () => {
        renderNext(brief, NOW);
        return 0;
      });
      expect(res.out).toBe(FRAME);
      for (const line of res.out.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    });

    /** ADR 536 §4.5 — the up-next window says how much it is a window on; same words as team_next. */
    it('says how many open lanes were claimable and how many wait on a dependency', async () => {
      const open = (id: string) => ({
        id,
        team: 'dawn',
        project: 'runtime',
        title: id,
        detail: null,
        kind: null,
        owner_seat: null,
        role: null,
        scope: [],
        depends_on: [],
        branch: null,
        goal_id: null,
        risk: [],
        stakes: 'normal',
        stakes_provenance: 'declared',
        merged: null,
        state: 'open',
        created_by: 'nick',
        created_at: 1,
        claimed_at: null,
        resolved_at: null,
        updated_at: 1,
      });
      const base = {
        member: 'Ada',
        in_flight: [],
        shipped: [],
        why: null,
        next_goal: null,
        incidents: [],
      };
      const render = async (brief: unknown) =>
        (
          await capture(async () => {
            renderNext(NextBriefSchema.parse(brief), 0);
            return 0;
          })
        ).out;
      expect(
        await render({
          ...base,
          up_next: [open('L1'), open('L2')],
          up_next_total: 30,
          up_next_blocked_total: 44,
        }),
      ).toContain(
        'up next — open lanes you could pick up (2 of 30 claimable · 44 more wait on a dependency):',
      );
      expect(
        await render({
          ...base,
          up_next: [open('L1')],
          up_next_total: 1,
          up_next_blocked_total: 0,
        }),
      ).toContain('up next — open lanes you could pick up (all 1 claimable):');
      // An older daemon sends neither count: the line is as it always was, not zero-filled.
      const old = await render({ ...base, up_next: [open('L1')] });
      expect(old).toContain('up next — open lanes you could pick up:');
      expect(old).not.toContain('claimable');
      // ADR 536 increment 2: the why tag trails the lane line; a tier-5 lane carries none.
      const why = await render({
        ...base,
        up_next: [open('L1'), open('L2')],
        up_next_why: [
          { lane: 'L1', tier: 1, reasons: ['nick pointed here', 'goal in flight'] },
          { lane: 'L2', tier: 5, reasons: [] },
        ],
      });
      expect(why.split('\n').find((l) => l.includes('nick pointed here'))).toMatch(
        /open · L1 — L1 · nick pointed here · goal in flight$/,
      );
      expect(why).not.toMatch(/L2 — L2 · nick/);
    });

    /** ADR 276 named this gap in its Consequences: `musterd next` rendered no review debt at all. */
    it('renders review debt like team_next does — owner, wait, no-reviewer and unlanded badges', async () => {
      const brief = NextBriefSchema.parse({
        member: 'Ada',
        in_flight: [],
        shipped: [],
        up_next: [],
        why: null,
        next_goal: null,
        review_debt_total: 5,
        incidents: [],
        review_debt: [
          { id: 'L1', title: 'stuck work', owner: 'June', waited_ms: 26 * 3_600_000 },
          {
            id: 'L2',
            title: 'nobody asked',
            owner: 'Lin',
            waited_ms: 3 * 3_600_000,
            no_candidate: true,
            empty_pool: { kind: 'no_live_member' },
          },
          { id: 'L3', title: 'never landed', owner: null, waited_ms: 3_600_000, unlanded: true },
        ],
      });
      const res = await capture(async () => {
        renderNext(brief, 0);
        return 0;
      });
      expect(res.out).toContain("review debt — waiting on any seat's acceptance (showing 3 of 5):");
      expect(res.out).toContain('"stuck work" — L1');
      expect(res.out).toContain('June · waiting 26h');
      expect(res.out).toContain(
        'Lin · waiting 3h — NO REVIEWER WAS ASKED (no other member is live)',
      );
      expect(res.out).toContain('waiting 1h — NO MERGE ATTESTATION');
      expect(res.out).not.toContain('nothing in flight');
    });

    it('absent arrays are an older daemon and say so; empty arrays are quiet', async () => {
      const base = {
        member: 'Ada',
        in_flight: [],
        shipped: [],
        up_next: [],
        why: null,
        next_goal: null,
        review_debt_total: 0,
        incidents: [],
      };
      const legacy = await capture(async () => {
        renderNext(NextBriefSchema.parse(base), 0);
        return 0;
      });
      expect(legacy.out).toContain('review promises: not reported by this daemon');
      expect(legacy.out).toContain('nothing in flight');
      const supported = await capture(async () => {
        renderNext(
          NextBriefSchema.parse({
            ...base,
            request_reviews: [],
            requested_reviews: [],
            review_closures: [],
          }),
          0,
        );
        return 0;
      });
      expect(supported.out).not.toContain('review');
      expect(supported.out).toContain('nothing in flight');
    });
  });

  /**
   * ADR 373 increment 4. The nine intentions the 2026-09-03 sweep found were all legible to a human
   * reading the file and invisible to every surface; `next` is where a CLI session starts, so this
   * is the surface that decides whether a captured intention is ever picked up.
   */
  it('leads the up-next section with recorded intentions, above the open lanes', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'a backlog item'])));
    const team = server.db.prepare("SELECT id FROM teams WHERE slug = 'dawn'").get() as {
      id: string;
    };
    const nick = server.db
      .prepare("SELECT id FROM members WHERE team_id = ? AND name = 'nick'")
      .get(team.id) as { id: string };
    server.db
      .prepare(
        `INSERT INTO seeds
           (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state, created_at, updated_at)
         VALUES ('01SEEDNEXT0000000000000000', ?, 'repo:docs/decisions/354-x.md#left-for-a-sibling-lane',
                 'repo', 'Left for a sibling lane; this ADR fixes the attestation.', 1, NULL, ?, 'open', 1, 1)`,
      )
      .run(team.id, nick.id);

    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('recorded intentions nobody has started');
    expect(res.out).toContain('docs/decisions/354-x.md#left-for-a-sibling-lane');
    expect(res.out).toContain('musterd seed claim 01SEEDNEXT0000000000000000');
    // Above the open lanes: a Seed is the same question one step earlier.
    expect(res.out.indexOf('recorded intentions')).toBeLessThan(
      res.out.indexOf('open lanes you could pick up'),
    );
  });
});
