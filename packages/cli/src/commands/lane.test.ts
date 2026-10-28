import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { LANE_REQUESTED_NUDGE, type Lane } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig } from '../config.js';
import { laneCommand, lanesCommand, renderLane } from './lane.js';
import { claimSeams } from './laneClaims.js';
import { teamCommand } from './team.js';

/** A rail result saying this SHA is on origin/main — what makes a close "landed" (lane 01M5G8VTK0). */
function landedClaim(sha: string) {
  return {
    kind: 'commit_landed' as const,
    ref: sha,
    verdict: 'confirmed' as const,
    checked_by: 'nick',
    checked_at: 1,
    evidence: 'reachable from origin/main',
  };
}

describe('lane commands', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-lane-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    // ADR 585: the rail's checkers shell out to git and gh; the temp dir is no clone.
    claimSeams.check = async () => [];
    claimSeams.label = async () => null;
    // `team create` mints nick as creator-admin and auto-binds this folder, so lane commands
    // resolve nick from the binding without an explicit --as (the acting-identity requirement).
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

  /** Open a lane and return its id (parsed out of the `--json` payload). */
  async function openLane(args: string[]): Promise<string> {
    const res = await capture(() => laneCommand(parseArgs(['open', ...args, '--json'])));
    // `lane open` doesn't honour --json (it always renders), so read the board back instead.
    void res;
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string }[] };
    return lanes[lanes.length - 1]!.id;
  }

  it('lane show prints one lane in full by a short id — brief and history (ADR 582 §4)', async () => {
    const id = await openLane(['show me', '--detail', 'the brief\nsecond line', '--claim']);
    const res = await capture(() => laneCommand(parseArgs(['show', id.slice(0, 10)])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('"show me"');
    expect(res.out).toContain('brief: the brief\nsecond line');
    expect(res.out).toContain('history:');
    expect(res.out).toMatch(/nick opened/);
    expect(res.out).toMatch(/nick claimed by nick/);
    const json = await capture(() => laneCommand(parseArgs(['show', id, '--json'])));
    const d = JSON.parse(json.out) as { lane: { id: string }; acceptance_ask: unknown };
    expect(d.lane.id).toBe(id);
    expect(d.acceptance_ask).toBeNull();
  });

  /**
   * ADR 582 §1: the board answers one query — bare words over the title and the detail, keyed terms
   * for the fields, repeats of a key OR'd. `musterd lanes` takes it as positional text.
   */
  it('lanes takes a query — bare words, keyed terms, and a lone id', async () => {
    await capture(() =>
      laneCommand(
        parseArgs([
          'open',
          'the seat pulse',
          '--surface',
          'packages/web/src/**',
          '--risk',
          'user-facing',
          '--claim',
        ]),
      ),
    );
    await capture(() =>
      laneCommand(
        parseArgs(['open', 'the away relay', '--surface', 'packages/protocol/src/**', '--claim']),
      ),
    );

    const byWord = await capture(() => lanesCommand(parseArgs(['pulse', '--json'])));
    const words = JSON.parse(byWord.out) as { lanes: Lane[] };
    expect(words.lanes).toHaveLength(1);
    expect(words.lanes[0]!.title).toBe('the seat pulse');

    const byArea = await capture(() => lanesCommand(parseArgs(['area:ui', '--json'])));
    const areas = JSON.parse(byArea.out) as { lanes: Lane[] };
    expect(areas.lanes.map((l) => l.title)).toEqual(['the seat pulse']);

    const byPath = await capture(() =>
      lanesCommand(parseArgs(['path:packages/protocol/src/lanes.ts', '--json'])),
    );
    const paths = JSON.parse(byPath.out) as { lanes: Lane[] };
    expect(paths.lanes.map((l) => l.title)).toEqual(['the away relay']);

    const both = await capture(() => lanesCommand(parseArgs(['the', '--json'])));
    const all = JSON.parse(both.out) as { lanes: Lane[] };
    expect(all.lanes).toHaveLength(2);

    const none = await capture(() => lanesCommand(parseArgs(['absent'])));
    expect(none.out).toContain('no lanes match "absent"');

    // A lone id answers with that lane in full, the same as `musterd lane show`.
    const id = all.lanes[0]!.id;
    const lone = await capture(() => lanesCommand(parseArgs([id.slice(0, 10)])));
    expect(lone.out).toContain('history:');
  });

  it('opens a lane and renders it with a checkmark', async () => {
    const res = await capture(() =>
      laneCommand(parseArgs(['open', 'wire the thing', '--surface', 'src/a.ts,src/b.ts'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('lane opened');
    expect(res.out).toContain('wire the thing');
    expect(res.out).toContain('src/a.ts');
  });

  /**
   * The derivation (design doc §7): `project` is stamped client-side, because the daemon's cwd is
   * the daemon's. A non-git folder — every other test here — stays on the `'default'` floor.
   */
  it('open derives project from the repo, MUSTERD_PROJECT overrides, --project wins', async () => {
    const board = async () => {
      const out = await capture(() => lanesCommand(parseArgs(['--json'])));
      const { lanes } = JSON.parse(out.out) as { lanes: { title: string; project: string }[] };
      return (t: string) => lanes.find((l) => l.title === t)!.project;
    };

    await capture(() => laneCommand(parseArgs(['open', 'no-git'])));
    expect((await board())('no-git')).toBe('default');

    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    await capture(() => laneCommand(parseArgs(['open', 'in-repo'])));
    expect((await board())('in-repo')).toBe(basename(dir));

    process.env['MUSTERD_PROJECT'] = 'declared';
    await capture(() => laneCommand(parseArgs(['open', 'via-env'])));
    await capture(() => laneCommand(parseArgs(['open', 'via-flag', '--project', 'explicit'])));
    delete process.env['MUSTERD_PROJECT'];
    const at = await board();
    expect(at('via-env')).toBe('declared');
    expect(at('via-flag')).toBe('explicit');
  });

  it('open --claim assigns the lane to the caller', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'mine', '--claim'])));
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { title: string; owner_seat: string }[] };
    expect(lanes.find((l) => l.title === 'mine')?.owner_seat).toBe('nick');
  });

  it('open threads goal/branch/depends/detail/project/role through', async () => {
    const res = await capture(() =>
      laneCommand(
        parseArgs([
          'open',
          'rich',
          '--goal',
          'g1',
          '--branch',
          'feat/x',
          '--depends',
          'a,b',
          '--detail',
          'notes',
          '--project',
          'p',
          '--role',
          'dev',
        ]),
      ),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('feat/x');
    expect(res.out).toContain('g1');
  });

  it('open refuses a human-visible scope with no explicit risk, and accepts --risk none', async () => {
    // A scope that reaches a rendered surface must declare its acceptance risk — the empty default
    // would silently skip the ADR 188 human gate even when Feel is the whole question.
    await expect(
      capture(() =>
        laneCommand(parseArgs(['open', 'board polish', '--surface', 'packages/web/src/live'])),
      ),
    ).rejects.toThrow(/[Dd]eclare its acceptance risk/);

    const ok = await capture(() =>
      laneCommand(
        parseArgs(['open', 'board polish', '--surface', 'packages/web/src/live', '--risk', 'none']),
      ),
    );
    expect(ok.code).toBe(0);
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { title: string; risk: string[] }[] };
    expect(lanes.find((l) => l.title === 'board polish')?.risk).toEqual([]);
  });

  it('open with a human-visible scope and --risk tags records them', async () => {
    const ok = await capture(() =>
      laneCommand(
        parseArgs([
          'open',
          'launch page',
          '--surface',
          'packages/web/**',
          '--risk',
          'user-facing,cost',
        ]),
      ),
    );
    expect(ok.code).toBe(0);
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { title: string; risk: string[] }[] };
    expect(lanes.find((l) => l.title === 'launch page')?.risk).toEqual(['user-facing', 'cost']);
  });

  it('open with no human-visible surface does not prompt for risk', async () => {
    const ok = await capture(() =>
      laneCommand(parseArgs(['open', 'schema work', '--surface', 'packages/server/src/store'])),
    );
    expect(ok.code).toBe(0);
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { title: string; risk: string[] }[] };
    expect(lanes.find((l) => l.title === 'schema work')?.risk).toEqual([]);
  });

  it('claim --goal links the lane in the same call (value-layer design)', async () => {
    const id = await openLane(['linkable']);
    const claimed = await capture(() => laneCommand(parseArgs(['claim', id, '--goal', 'g1'])));
    expect(claimed.out).toContain('lane claimed');
    expect(claimed.out).toContain('g1');
  });

  it('claim then resolve moves a lane to done', async () => {
    const id = await openLane(['claimable']);
    const claimed = await capture(() => laneCommand(parseArgs(['claim', id])));
    expect(claimed.out).toContain('lane claimed');
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).toContain('lane done');
    expect(resolved.out).toContain('done');
  });

  it('submit moves a lane to awaiting_acceptance, keeps the attestation, and reports the routing (ADR 192)', async () => {
    const id = await openLane(['reviewable', '--claim', '--branch', 'feat/review']);
    const ready = await capture(() =>
      laneCommand(parseArgs(['submit', id, '--pr', '7', '--sha', 'deadbeef'])),
    );
    expect(ready.code).toBe(0);
    expect(ready.out).toContain('lane submitted for acceptance');
    expect(ready.out).toContain('awaiting_acceptance');
    // Solo team: no eligible acceptor → self-close sanctioned, spelled out.
    expect(ready.out).toContain('self-close sanctioned');
    expect(ready.out).toContain('no other member is live');
    // The degradation path stays open: the owner can still resolve, nudged as unconfirmed.
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).toContain('lane done');
    expect(resolved.out).toContain('unconfirmed close recorded');
  });

  it('collects an A2 proof over the exact merge-authority tuple and sends it with the submit', async () => {
    const id = await openLane(['signed submit', '--claim']);
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const lane = (JSON.parse(board.out) as { lanes: Lane[] }).lanes.find((item) => item.id === id)!;
    const descriptor = {
      actor: 'nick',
      act: 'set_authorized_by',
      target: id,
      payload_digest: 'digest',
      audience: 'dawn',
      expiry: Date.now() + 60_000,
      nonce: '1234567890123456',
    };
    const proof = { key_id: 'key-1', nonce: descriptor.nonce, signature: 'signature' };
    const descriptorCall = vi
      .spyOn(HttpClient.prototype, 'createAuthorityDescriptor')
      .mockResolvedValue({ descriptor });
    vi.spyOn(HttpClient.prototype, 'getParkedApproval').mockResolvedValue({ proof });
    const updateCall = vi.spyOn(HttpClient.prototype, 'updateLane').mockResolvedValue({
      lane,
      warnings: [],
    } as Awaited<ReturnType<HttpClient['updateLane']>>);

    const submitted = await capture(() =>
      laneCommand(
        parseArgs(['submit', id, '--pr', '17', '--sha', 'abcdef1', '--authorized-by', 'nick']),
      ),
    );

    expect(submitted.code).toBe(0);
    expect(descriptorCall).toHaveBeenCalledWith('dawn', {
      act: 'set_authorized_by',
      target: id,
      actor: 'nick',
      payload: { lane: id, authorized_by: 'nick', pr: 17, sha: 'abcdef1' },
    });
    expect(updateCall).toHaveBeenCalledWith(
      'dawn',
      id,
      expect.objectContaining({
        approval: proof,
        merged: expect.objectContaining({ pr: 17, sha: 'abcdef1', authorized_by: 'nick' }),
      }),
    );
  });

  it('does not collect or submit authority for a different human', async () => {
    const id = await openLane(['other authorizer']);
    const descriptorCall = vi.spyOn(HttpClient.prototype, 'createAuthorityDescriptor');
    await expect(
      capture(() => laneCommand(parseArgs(['submit', id, '--authorized-by', 'someone-else']))),
    ).rejects.toThrow(/run lane submit as someone-else/i);
    expect(descriptorCall).not.toHaveBeenCalled();
  });

  // ADR 083: the acceptor should receive the work as an artifact, not a description. Submit hands
  // the lane over and was the one edge that could not name the branch — so a lane opened before the
  // branch existed (the common order: open, then cut the branch) reached its acceptor pointing at
  // nothing. Measured 2026-08-05: 184 of 362 terminal-or-awaiting lanes carried branch=null.
  // ADR 585: the verification rail at submit.
  it('files the claims this clone checked, the daemon stamps the checker, and the report shows them', async () => {
    claimSeams.check = async (refs, _cwd, by) => [
      {
        kind: 'commit_landed',
        ref: refs.sha!,
        verdict: 'confirmed',
        checked_by: 'forged',
        checked_at: 1,
        evidence: 'reachable from origin/main',
      },
      {
        kind: 'pr_merged',
        ref: String(refs.pr),
        verdict: 'unverifiable',
        checked_by: by,
        checked_at: 1,
        evidence: 'gh unavailable',
      },
    ];
    // ADR 612: the commit verified as landed, so the submit carries its change class.
    const labelled: string[] = [];
    claimSeams.label = async (sha) => {
      labelled.push(sha);
      return { change_class: 'server', changed: { docs: 1, tests: 2, code: 3 } };
    };
    const { out: opened } = await capture(() => laneCommand(parseArgs(['open', 'rail'])));
    const id = /\b(01[0-9A-Z]{24})\b/.exec(opened)![1]!;
    await capture(() => laneCommand(parseArgs(['claim', id])));
    const submitted = await capture(() =>
      laneCommand(parseArgs(['submit', id, '--pr', '7', '--sha', 'deadbeef'])),
    );
    expect(labelled).toEqual(['deadbeef']);
    expect(submitted.out).toContain('claims: commit_landed ✓ · pr_merged ?');
    expect(submitted.out).toContain('(checked by nick)');
    const { out: json } = await capture(() => lanesCommand(parseArgs(['--json'])));
    const lane = (JSON.parse(json) as { lanes: Lane[] }).lanes.find((l) => l.id === id)!;
    expect(lane.claims?.map((c) => [c.kind, c.verdict, c.checked_by])).toEqual([
      ['commit_landed', 'confirmed', 'nick'],
      ['pr_merged', 'unverifiable', 'nick'],
    ]);
    expect(lane.merged).toMatchObject({
      change_class: 'server',
      changed: { docs: 1, tests: 2, code: 3 },
    });
  });

  it('submit records the branch the work landed on, for a lane opened without one', async () => {
    const id = await openLane(['no branch at open', '--claim']);
    const submitted = await capture(() =>
      laneCommand(parseArgs(['submit', id, '--pr', '7', '--branch', 'izzo/the-work'])),
    );
    expect(submitted.code).toBe(0);
    expect(submitted.out).toContain('⎇ izzo/the-work');
    // And it PERSISTED, rather than only being echoed back: a later command reads it off the lane
    // (the cleanup hint needs a landed merge, so the resolve attests one — lane 01M5G8VTK0).
    claimSeams.check = async (refs) => [landedClaim(refs.sha!)];
    const resolved = await capture(() =>
      laneCommand(parseArgs(['resolve', id, '--sha', 'deadbeef'])),
    );
    expect(resolved.out).toContain('git branch -D izzo/the-work');
  });

  // The solo-team submit above is the measured case: no eligible acceptor, so the daemon sanctions
  // a self-close and the ledger records `verified: false` even when a second seat DID review the
  // work out of band. `--to` gives that routing a door — the named seat gets a real acceptance ask,
  // which is the only thing an `accept` can bind to.
  it('submit --to routes the acceptance to the named seat instead of sanctioning self-close', async () => {
    await capture(() => teamCommand(parseArgs(['add', 'ghost', '--kind', 'agent'])));
    const id = await openLane(['routed by hand', '--claim', '--branch', 'nick/routed']);
    const submitted = await capture(() =>
      laneCommand(parseArgs(['submit', id, '--pr', '9', '--to', 'ghost'])),
    );
    expect(submitted.code).toBe(0);
    expect(submitted.out).toContain('lane submitted for acceptance');
    expect(submitted.out).toContain('ghost');
    // The whole point: this lane is NOT told to close itself.
    expect(submitted.out).not.toContain('self-close sanctioned');
    // Named, never dressed up as one of the picker's routes.
    expect(submitted.out).toContain('named');
  });

  it('submit --to refuses a seat that is not on the team, and says which name', async () => {
    const id = await openLane(['bad routing', '--claim']);
    await expect(
      capture(() => laneCommand(parseArgs(['submit', id, '--pr', '9', '--to', 'nobody']))),
    ).rejects.toThrow(/no such seat "nobody"/);
  });

  it('submit without --branch leaves the branch the lane already carried', async () => {
    // Never clears: a repeat submit recording a merge SHA must not blank the pointer.
    const id = await openLane(['already pointed', '--claim', '--branch', 'feat/kept']);
    const submitted = await capture(() => laneCommand(parseArgs(['submit', id, '--pr', '8'])));
    expect(submitted.out).toContain('⎇ feat/kept');
  });

  it('resolve prints the local-branch cleanup hint when the lane carries a branch and its merge landed', async () => {
    const id = await openLane(['landed', '--claim', '--branch', 'feat/landed']);
    claimSeams.check = async (refs) => [landedClaim(refs.sha!)];
    const resolved = await capture(() =>
      laneCommand(parseArgs(['resolve', id, '--sha', 'deadbeef'])),
    );
    expect(resolved.out).toContain('clear the local branch');
    expect(resolved.out).toContain('git branch -D feat/landed');
    expect(resolved.out).toContain('git switch --detach origin/main');
  });

  // lane 01M5G8VTK0: the line is this repo's squash-merge cleanup. Printed on every close with a
  // branch, it told a CooperBench agent — no merge, another workflow — to `-D` its unmerged work.
  it('resolve omits the cleanup hint when nothing verifiably landed', async () => {
    const id = await openLane(['not landed', '--claim', '--branch', 'agent1']);
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).toContain('lane done');
    expect(resolved.out).not.toContain('branch -D');
    expect(resolved.out).not.toContain('clear the local branch');
  });

  it('resolve omits the cleanup hint for a lane with no branch', async () => {
    const id = await openLane(['branchless']);
    const resolved = await capture(() => laneCommand(parseArgs(['resolve', id])));
    expect(resolved.out).not.toContain('clear the local branch');
  });

  it('resolve --pr/--sha/--authorized-by attests the merge to the audit log (ADR 109)', async () => {
    const id = await openLane(['attested', '--claim', '--branch', 'feat/attested']);
    const descriptor = {
      actor: 'nick',
      act: 'set_authorized_by',
      target: id,
      payload_digest: 'digest',
      audience: 'dawn',
      expiry: Date.now() + 60_000,
      nonce: '1234567890123456',
    };
    const proof = { key_id: 'key-1', nonce: descriptor.nonce, signature: 'signature' };
    const descriptorCall = vi
      .spyOn(HttpClient.prototype, 'createAuthorityDescriptor')
      .mockResolvedValue({ descriptor });
    vi.spyOn(HttpClient.prototype, 'getParkedApproval').mockResolvedValue({ proof });
    const resolved = await capture(() =>
      laneCommand(
        parseArgs(['resolve', id, '--pr', '167', '--sha', 'abc123', '--authorized-by', 'nick']),
      ),
    );
    expect(resolved.code).toBe(0);
    expect(resolved.out).toContain('lane done');
    expect(descriptorCall).toHaveBeenCalledWith('dawn', {
      act: 'set_authorized_by',
      target: id,
      actor: 'nick',
      payload: { lane: id, authorized_by: 'nick', pr: 167, sha: 'abc123' },
    });
    const { auditCommand } = await import('./audit.js');
    const audit = await capture(() => auditCommand(parseArgs(['--json'])));
    const rows = JSON.parse(audit.out) as { action: string; detail: unknown }[];
    const row = rows.find((r) => r.action === 'git.pr_merged');
    expect(row).toBeDefined();
    expect(row!.detail).toMatchObject({ pr: 167, sha: 'abc123', authorized_by: 'nick' });
  });

  it('resolve rejects a non-integer --pr with usage', async () => {
    const id = await openLane(['badpr', '--claim']);
    await expect(laneCommand(parseArgs(['resolve', id, '--pr', 'nope']))).rejects.toThrow(/usage/);
  });

  it('claim does not print the branch-cleanup hint', async () => {
    const id = await openLane(['nohint', '--branch', 'feat/nohint']);
    const claimed = await capture(() => laneCommand(parseArgs(['claim', id])));
    expect(claimed.out).not.toContain('clear the local branch');
  });

  it('release hands a claimed lane back to the board as unowned', async () => {
    const id = await openLane(['parkme', '--claim']);
    const res = await capture(() => laneCommand(parseArgs(['release', id])));
    expect(res.out).toContain('lane released');
    expect(res.out).toContain('open');
    expect(res.out).toContain('unowned'); // renderLane's null-owner rendering
  });

  it('handoff reassigns to another seat with a branch', async () => {
    await new (await import('../client.js')).HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
    }).addMember('dawn', { name: 'Ada', kind: 'agent' });
    const id = await openLane(['handme', '--claim']);
    const res = await capture(() =>
      laneCommand(parseArgs(['handoff', id, '--to', 'Ada', '--branch', 'feat/y'])),
    );
    expect(res.out).toContain('handed to Ada');
    expect(res.out).toContain('feat/y');
  });

  it('update sets state/detail/surface', async () => {
    const id = await openLane(['upd']);
    const res = await capture(() =>
      laneCommand(parseArgs(['update', id, '--state', 'active', '--surface', 'src/c.ts'])),
    );
    expect(res.out).toContain('lane updated');
    expect(res.out).toContain('active');
    expect(res.out).toContain('src/c.ts');
  });

  it('--card moves the card on the wall board, and refuses a place outside the cell', async () => {
    const id = await openLane(['card']);
    const moved = await capture(() => laneCommand(parseArgs(['update', id, '--card', '0.25,0.7'])));
    expect(moved.out).toContain('lane updated');
    await expect(laneCommand(parseArgs(['update', id, '--card', '1.5,0.2']))).rejects.toThrow(
      /--card takes <x>,<y>/,
    );
    await expect(laneCommand(parseArgs(['update', id, '--card', '0.5']))).rejects.toThrow(
      /--card takes <x>,<y>/,
    );
  });

  // ADR 701: a dated read with no metric says its chart is one flag away; declaring one quiets it,
  // and --metric-harness scopes a derived source to one harness's seats.
  it('a read with no metric is nudged toward a chart; --metric-harness rides the metric', async () => {
    const id = await openLane(['xp']);
    const dated = await capture(() =>
      laneCommand(parseArgs(['update', id, '--reads-on', '2026-12-01'])),
    );
    expect(dated.out).toContain('this read has no metric, so /live draws no chart');
    expect(dated.out).toContain('--metric-harness');
    const charted = await capture(() =>
      laneCommand(
        parseArgs([
          'update',
          id,
          '--metric',
          'codex wake p50',
          '--unit',
          'ms',
          '--target',
          '5000',
          '--direction',
          'down',
          '--metric-source',
          'wake_latency_p50_ms',
          '--metric-harness',
          'codex',
        ]),
      ),
    );
    expect(charted.code).toBe(0);
    expect(charted.out).not.toContain('this read has no metric');
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as {
      lanes: { id: string; metric?: { source: string; harness?: string } }[];
    };
    expect(lanes.find((l) => l.id === id)?.metric).toMatchObject({
      source: 'wake_latency_p50_ms',
      harness: 'codex',
    });
  });

  // ADR 256's no_goal warning names `lane_update {goal_id}` / `musterd lane update --goal`.
  // Open already takes --goal; update did not, so a goal-less lane had no CLI repair.
  it('update --goal links a goal-less lane', async () => {
    const id = await openLane(['unlinked']);
    const res = await capture(() =>
      laneCommand(parseArgs(['update', id, '--goal', 'goals-front-door'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('lane updated');
    expect(res.out).toContain('goals-front-door');
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string; goal_id: string | null }[] };
    expect(lanes.find((l) => l.id === id)?.goal_id).toBe('goals-front-door');
  });

  it('open and update carry --source-ref; a second live lane on the ref is refused (ADR 561)', async () => {
    const res = await capture(() =>
      laneCommand(parseArgs(['open', 'from github', '--source-ref', 'acme/app#3'])),
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('⌁ acme/app#3');
    await expect(
      capture(() => laneCommand(parseArgs(['open', 'again', '--source-ref', 'acme/app#3']))),
    ).rejects.toThrow(/source_ref "acme\/app#3" already belongs to lane/);
    const id = await openLane(['plain']);
    const upd = await capture(() =>
      laneCommand(parseArgs(['update', id, '--source-ref', 'ENG-42'])),
    );
    expect(upd.out).toContain('⌁ ENG-42');
  });

  it('open with nobody named still opens and says how to record who asked (ADR 629)', async () => {
    const res = await capture(() => laneCommand(parseArgs(['open', 'unnamed'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('lane opened');
    expect(res.out).toContain(LANE_REQUESTED_NUDGE);
    expect(res.out).not.toContain('asked:');
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { title: string; requested?: unknown }[] };
    expect(lanes.find((l) => l.title === 'unnamed')?.requested).toBeUndefined();
  });

  it('open --self records the caller; --by on a later update states someone else', async () => {
    const res = await capture(() => laneCommand(parseArgs(['open', 'mine to ask', '--self'])));
    expect(res.code).toBe(0);
    expect(res.out).not.toContain(LANE_REQUESTED_NUDGE);
    expect(res.out).toContain('asked:nick (self)');
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as {
      lanes: { id: string; title: string; requested?: { by: string; basis: string } }[];
    };
    const mine = lanes.find((l) => l.title === 'mine to ask');
    expect(mine?.requested).toEqual({ by: 'nick', basis: 'self' });
    const shown = await capture(() => laneCommand(parseArgs(['show', mine!.id])));
    expect(shown.out).toContain('asked: nick (self)');
    expect(shown.out).toContain('chain:');
    expect(shown.out).toContain('nick  verified');

    const id = await openLane(['later']);
    const upd = await capture(() => laneCommand(parseArgs(['update', id, '--by', 'ada'])));
    expect(upd.code).toBe(0);
    expect(upd.out).toContain('asked:ada (stated)');
    await expect(
      capture(() => laneCommand(parseArgs(['open', 'both', '--self', '--by', 'ada']))),
    ).rejects.toThrow(/one of --self, --by, --act, or --seed/);
  });

  it('renderLane strips control characters from a stored source_ref', () => {
    const out = renderLane({
      id: 'L1',
      team: 'dawn',
      project: 'p',
      title: 't',
      detail: null,
      owner_seat: null,
      role: null,
      scope: [],
      depends_on: [],
      branch: null,
      goal_id: null,
      risk: [],
      stakes: 'normal',
      merged: null,
      state: 'open',
      created_by: 'nick',
      created_at: 1,
      claimed_at: null,
      resolved_at: null,
      updated_at: 1,
      // Stored by a replicated fold, which carries and never judges (ADR 561).
      source_ref: 'x\u001b]0;pwned\u0007y',
    } as Lane);
    expect(out).toContain('⌁ xy');
    expect(out).not.toContain('\u001b');
  });

  it('lanes renders an empty board hint', async () => {
    const res = await capture(() => lanesCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('no lanes');
  });

  it('lanes lists lanes and honours --mine/--open filters', async () => {
    await openLane(['a', '--claim']);
    await openLane(['b']);
    const all = await capture(() => lanesCommand(parseArgs([])));
    expect(all.out).toContain('lanes — dawn');
    expect(all.out).toContain('"a"');
    const open = await capture(() => lanesCommand(parseArgs(['--open', '--json'])));
    const { lanes } = JSON.parse(open.out) as { lanes: { title: string }[] };
    expect(lanes.some((l) => l.title === 'b')).toBe(true);
    expect(lanes.some((l) => l.title === 'a')).toBe(false);
  });

  // ADR 234 increment 1. A typo in --stakes must FAIL rather than fall back to the default: the
  // phase exists to measure declarations, and a misspelling that quietly recorded `normal` would
  // put a lane the worker meant to mark `low` into the very bucket it was being distinguished from
  // — corrupting the measurement in the direction that HIDES the effect being tested.
  it('refuses an unrecognised --stakes instead of silently defaulting it', async () => {
    await expect(
      laneCommand(parseArgs(['open', 'typo lane', '--stakes', 'trivial'])),
    ).rejects.toThrow(/--stakes must be one of low \| normal \| high/);
    // Nothing was opened — the refusal is before the write, not after it.
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { title: string }[] };
    expect(lanes.some((l) => l.title === 'typo lane')).toBe(false);
  });

  it('carries a declared --stakes through open and update', async () => {
    const id = await openLane(['staked', '--stakes', 'low', '--claim']);
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string; stakes: string }[] };
    expect(lanes.find((l) => l.id === id)?.stakes).toBe('low');

    await capture(() => laneCommand(parseArgs(['update', id, '--stakes', 'high'])));
    const after = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes: l2 } = JSON.parse(after.out) as { lanes: { id: string; stakes: string }[] };
    expect(l2.find((l) => l.id === id)?.stakes).toBe('high');
  });

  it('derives areas from --surface and supports declared --area overrides and clearing (ADR 582 §3)', async () => {
    const id = await openLane(['derived', '--surface', 'packages/server/src/store/lanes.ts']);
    const b1 = JSON.parse((await capture(() => lanesCommand(parseArgs(['--json'])))).out) as {
      lanes: { id: string; areas: string[]; declared_areas?: string[] }[];
    };
    const l1 = b1.lanes.find((l) => l.id === id)!;
    expect(l1.areas).toEqual(['server']);
    expect(l1.declared_areas).toBeUndefined();

    // Declared override replaces derived areas
    const upd = await capture(() => laneCommand(parseArgs(['update', id, '--area', 'ui,docs'])));
    expect(upd.out).toContain('· ui, docs');
    const b2 = JSON.parse((await capture(() => lanesCommand(parseArgs(['--json'])))).out) as {
      lanes: { id: string; areas: string[]; declared_areas?: string[] }[];
    };
    const l2 = b2.lanes.find((l) => l.id === id)!;
    expect(l2.areas).toEqual(['ui', 'docs']);
    expect(l2.declared_areas).toEqual(['ui', 'docs']);

    // Clearing with `--area none` restores derived areas
    await capture(() => laneCommand(parseArgs(['update', id, '--area', 'none'])));
    const b3 = JSON.parse((await capture(() => lanesCommand(parseArgs(['--json'])))).out) as {
      lanes: { id: string; areas: string[]; declared_areas?: string[] }[];
    };
    const l3 = b3.lanes.find((l) => l.id === id)!;
    expect(l3.areas).toEqual(['server']);
    expect(l3.declared_areas).toBeUndefined();
  });

  it('a lane that reads on a day is refused done until it has a verdict (ADR 644)', async () => {
    const id = await openLane(['dated read', '--claim', '--reads-on', '2001-01-01']);
    const shown = await capture(() => laneCommand(parseArgs(['show', id])));
    expect(shown.out).toContain('reads:2001-01-01 (overdue)');
    expect(shown.out).toContain('reads on: 2001-01-01 (overdue)');

    // Silence is the only shape refused: the daemon names the day and the flags that fix it.
    await expect(laneCommand(parseArgs(['resolve', id]))).rejects.toThrow(
      /reads on 2001-01-01: give read_verdict/,
    );

    // The verdict can ride the close itself, and the lane then shows as read.
    const closed = await capture(() =>
      laneCommand(
        parseArgs(['resolve', id, '--read-verdict', 'missed', '--read-note', 'below baseline']),
      ),
    );
    expect(closed.code).toBe(0);
    const after = await capture(() => laneCommand(parseArgs(['show', id])));
    expect(after.out).toContain('reads on: 2001-01-01 (read)');
    expect(after.out).toContain('read verdict: missed — below baseline (nick)');
  });

  it('--reads-on none clears the day, and the verdict flags must come as a pair', async () => {
    const id = await openLane(['to clear', '--claim', '--reads-on', '2999-01-01']);
    const cleared = await capture(() =>
      laneCommand(parseArgs(['update', id, '--reads-on', 'none'])),
    );
    expect(cleared.out).not.toContain('reads:');
    await expect(laneCommand(parseArgs(['update', id, '--read-verdict', 'met']))).rejects.toThrow(
      /needs both/,
    );
    await expect(
      laneCommand(parseArgs(['update', id, '--read-verdict', 'later', '--read-note', 'x'])),
    ).rejects.toThrow(/met, missed or inconclusive/);
  });

  it('rejects malformed subcommands and missing args with usage', async () => {
    await expect(laneCommand(parseArgs([]))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['open']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['claim']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['release']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['handoff', 'x']))).rejects.toThrow(/usage/);
    await expect(laneCommand(parseArgs(['update']))).rejects.toThrow(/usage/);
  });
});
