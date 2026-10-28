import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { saveNodeEnrollment } from '../node/state.js';
import {
  getProvision,
  insertProvision,
  PROVISION_PENDING_TTL_MS,
} from '../store/hostProvisions.js';
import { addMember } from '../store/members.js';
import { localNodeForTeam } from '../store/messages.js';
import { createSponsoredAgent } from '../store/sponsoredAgents.js';
import { createTeam } from '../store/teams.js';
import { sweepProvisionsPass } from './sponsoredAgentMint.js';

/**
 * Settling a provision is the hub's decision: a joiner that swept one settled it as seats bound to the
 * hub, the hub refused the push `bound_elsewhere`, and every later push from the machine wedged behind
 * it (revive, 2026-10-28). An enrolled joiner skips the team.
 */
let openStore: () => Promise<Driver>;
let dir: string;
let prior: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provision-sweep-'));
  prior = process.env['MUSTERD_NODE_STATE'];
  process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');
});
afterEach(() => {
  if (prior === undefined) delete process.env['MUSTERD_NODE_STATE'];
  else process.env['MUSTERD_NODE_STATE'] = prior;
  rmSync(dir, { recursive: true, force: true });
});

withDrivers('provision sweep on a joiner', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function stale() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const { row: nick } = await addMember(db, team, { name: 'nick', kind: 'human' });
    const now = Date.now();
    const { member } = await createSponsoredAgent(db, team, nick, { name: 'delta-2' }, now);
    const row = await insertProvision(
      db,
      team.id,
      member.id,
      nick.id,
      now - PROVISION_PENDING_TTL_MS - 5,
    );
    return { db, team, row, now };
  }

  it('an enrolled joiner settles nothing for the team; the hub sweeps it', async () => {
    const { db, team, row, now } = await stale();
    const node = await localNodeForTeam(db, team.id);
    saveNodeEnrollment({
      team: 'revive',
      hub_url: 'http://hub',
      credential: 'x',
      node_id: node.id,
      enrolled_at: now,
    });
    expect(await sweepProvisionsPass({ db } as unknown as Ctx, now)).toBe(0);
    expect((await getProvision(db, team.id, row.id))?.state).toBe('pending');
  });
  // A daemon that is not a joiner still sweeps: `sweepProvisions` without `except`, hostProvisions.test.ts.
});
