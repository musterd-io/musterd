import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { doneCommand } from './done.js';
import { laneCommand, lanesCommand } from './lane.js';
import { teamCommand } from './team.js';

/**
 * `done` says what it records (surface survey 2026-09-03, collision 2): a bare close is an
 * unconfirmed self-close and says so; a merge attestation routes through submit; a lane already
 * awaiting acceptance is refused rather than silently overridden.
 */
describe('done tells the truth about the close it records', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-done-'));
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

  async function claimedLane(extra: string[] = []): Promise<string> {
    await capture(() => laneCommand(parseArgs(['open', 'the work', '--claim', ...extra])));
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string }[] };
    return lanes[lanes.length - 1]!.id;
  }

  it('a bare done closes the lane and says the close is unconfirmed', async () => {
    const id = await claimedLane();
    const res = await capture(() => doneCommand(parseArgs([id])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('✓ done');
    expect(res.out).toContain('unconfirmed close recorded');
    expect(res.out).toContain('musterd done --pr <n> --sha <sha>');
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string; state: string }[] };
    expect(lanes.find((l) => l.id === id)?.state).toBe('done');
  });

  it('done with a merge attestation is a submit: awaiting_acceptance plus the routing report', async () => {
    const id = await claimedLane();
    const res = await capture(() => doneCommand(parseArgs([id, '--pr', '7', '--sha', 'deadbeef'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('submitted for acceptance');
    expect(res.out).not.toContain('unconfirmed close recorded');
    // Nobody else is on the team: the report names the sanctioned self-close, as `lane submit` does.
    expect(res.out).toMatch(/acceptor|self-close|acceptance/);
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string; state: string }[] };
    expect(lanes.find((l) => l.id === id)?.state).toBe('awaiting_acceptance');
  });

  it('refuses to close a lane that is already awaiting acceptance', async () => {
    const id = await claimedLane();
    await capture(() => laneCommand(parseArgs(['submit', id, '--pr', '7', '--sha', 'deadbeef'])));
    await expect(doneCommand(parseArgs([id]))).rejects.toThrow(/already awaiting acceptance/);
  });

  it('auto-targets the single live lane the caller owns', async () => {
    const id = await claimedLane();
    const res = await capture(() => doneCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain(id);
  });

  it('closes a named lane even when the full board cannot be parsed', async () => {
    const id = await claimedLane();
    vi.spyOn(HttpClient.prototype, 'laneBoard').mockRejectedValue(new Error('invalid board'));
    const res = await capture(() => doneCommand(parseArgs([id])));
    expect(res.code).toBe(0);
    const shown = await capture(() => laneCommand(parseArgs(['show', id, '--json'])));
    expect(JSON.parse(shown.out).lane.state).toBe('done');
  });

  it('resolves a short lane ID before closing', async () => {
    const id = await claimedLane();
    const res = await capture(() => doneCommand(parseArgs([id.slice(0, 10)])));
    expect(res.code).toBe(0);
    expect(res.out).toContain(id);
  });

  it('reports success when the lane closes but the optional next lookup fails', async () => {
    const id = await claimedLane();
    vi.spyOn(HttpClient.prototype, 'next').mockRejectedValue(new Error('offline'));
    const res = await capture(() => doneCommand(parseArgs([id])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('✓ done');
    expect(res.out).toContain('musterd next');
    const shown = await capture(() => laneCommand(parseArgs(['show', id, '--json'])));
    expect(JSON.parse(shown.out).lane.state).toBe('done');
  });

  it('keeps the acceptance receipt when next is unavailable after submit', async () => {
    const id = await claimedLane();
    vi.spyOn(HttpClient.prototype, 'next').mockRejectedValue(new Error('offline'));
    const res = await capture(() => doneCommand(parseArgs([id, '--pr', '7', '--sha', 'deadbeef'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('submitted for acceptance');
    expect(res.out).toContain('musterd next');
    const shown = await capture(() => laneCommand(parseArgs(['show', id, '--json'])));
    expect(JSON.parse(shown.out).lane.state).toBe('awaiting_acceptance');
  });

  it('collects the named human’s approval over the exact submitted merge', async () => {
    const id = await claimedLane();
    const shown = await capture(() => laneCommand(parseArgs(['show', id, '--json'])));
    const lane = JSON.parse(shown.out).lane;
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
    const update = vi
      .spyOn(HttpClient.prototype, 'updateLane')
      .mockResolvedValue({ lane, warnings: [] } as Awaited<ReturnType<HttpClient['updateLane']>>);
    expect(
      (
        await capture(() =>
          doneCommand(parseArgs([id, '--pr', '17', '--sha', 'abcdef1', '--authorized-by', 'nick'])),
        )
      ).code,
    ).toBe(0);
    expect(descriptorCall).toHaveBeenCalledWith('dawn', {
      act: 'set_authorized_by',
      target: id,
      actor: 'nick',
      payload: { lane: id, authorized_by: 'nick', pr: 17, sha: 'abcdef1' },
    });
    expect(update).toHaveBeenCalledWith('dawn', id, expect.objectContaining({ approval: proof }));
  });

  it('tells a different authorizer to submit from their own seat', async () => {
    const id = await claimedLane();
    await expect(
      doneCommand(parseArgs([id, '--pr', '17', '--sha', 'abcdef1', '--authorized-by', 'alice'])),
    ).rejects.toThrow(/named human.*alice/);
  });
});
