import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { saveNodeEnrollment } from '../node/state.js';
import { addMember } from '../store/members.js';
import { localNodeForTeam } from '../store/messages.js';
import { bindSeatToNode, upsertForeignNode } from '../store/nodes.js';
import { createTeam } from '../store/teams.js';
import { routeEnvelope } from './route.js';

let openStore: () => Promise<Driver>;
let dir: string;

function stubCtx(db: Database): Ctx {
  return {
    db,
    rosterRoots: [],
    config: {} as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

/**
 * A daemon-composed act voiced as a seat bound to another node would be refused by the hub
 * (`bound_elsewhere`) and wedge the joiner's whole push (2026-10-17, twice). It is refused where it
 * is minted, on the one path every composer takes.
 */
withDrivers('route: no voice for a seat bound elsewhere', (o) => {
  beforeEach(() => {
    openStore = o;
    dir = mkdtempSync(join(tmpdir(), 'musterd-voice-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
  });
  afterEach(() => {
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(enroll: boolean) {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'dawn' });
    const { row: alfie } = await addMember(db, team, { name: 'alfie', kind: 'agent', role: '' });
    await addMember(db, team, { name: 'sloane', kind: 'agent', role: '' });
    const local = await localNodeForTeam(db, team.id);
    if (enroll)
      saveNodeEnrollment({
        team: team.slug,
        hub_url: 'http://hub.invalid:4849',
        node_id: local.id,
        credential: 'msnode_test',
        enrolled_at: 1,
      });
    await upsertForeignNode(db, team.id, { id: 'NODE-HUB', label: 'mac.lan', last_seen_at: null });
    return { db, team, alfie, local };
  }

  const nudge = (team: string) =>
    makeEnvelope({
      id: ulid(),
      team,
      from: 'alfie',
      to: { kind: 'member', name: 'sloane' },
      act: 'request_help',
      body: 'board held a continuation wake',
      meta: { dispatch_nudge: { lane: 'L1' } },
    });

  const messages = async (db: Driver) =>
    Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages'))?.n ?? 0);

  it('a joiner refuses a daemon-composed act voiced as a seat bound to another node, minting nothing', async () => {
    const { db, team, alfie } = await seed(true);
    await bindSeatToNode(db, team.id, alfie.id, 'NODE-HUB');
    await expect(
      routeEnvelope(
        stubCtx(db as unknown as Database),
        team,
        alfie,
        nudge(team.slug),
        undefined,
        true,
      ),
    ).rejects.toMatchObject({ code: 'bound_elsewhere' });
    expect(await messages(db)).toBe(0);
  });

  it('routes it for a seat bound to this node, and for a seat bound to no node', async () => {
    const { db, team, alfie, local } = await seed(true);
    await routeEnvelope(
      stubCtx(db as unknown as Database),
      team,
      alfie,
      nudge(team.slug),
      undefined,
      true,
    );
    expect(await messages(db)).toBe(1);
    await bindSeatToNode(db, team.id, alfie.id, local.id);
    await routeEnvelope(
      stubCtx(db as unknown as Database),
      team,
      alfie,
      nudge(team.slug),
      undefined,
      true,
    );
    expect(await messages(db)).toBe(2);
  });

  it('is a no-op on a hub (not enrolled), where a joiner-bound seat is voiced as the hub arbitrates', async () => {
    const { db, team, alfie } = await seed(false);
    await bindSeatToNode(db, team.id, alfie.id, 'NODE-HUB');
    await routeEnvelope(
      stubCtx(db as unknown as Database),
      team,
      alfie,
      nudge(team.slug),
      undefined,
      true,
    );
    expect(await messages(db)).toBe(1);
  });

  it('leaves a seat’s own act alone: only daemon-composed envelopes are refused', async () => {
    const { db, team, alfie } = await seed(true);
    await bindSeatToNode(db, team.id, alfie.id, 'NODE-HUB');
    await routeEnvelope(stubCtx(db as unknown as Database), team, alfie, nudge(team.slug));
    expect(await messages(db)).toBe(1);
  });
});
