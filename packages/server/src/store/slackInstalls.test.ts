import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember } from './members.js';
import {
  cloudDestinationFrom,
  createSlackInstallRequest,
  getSlackInstallBotToken,
  listLiveInstallStateHashes,
  listLiveInstallStates,
  listSlackInstalls,
  recordSlackInstall,
  revokeSlackInstall,
} from './slackInstalls.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('slack installs (ADR 668 decision 2, increment 9)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function teamWithHuman() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    return { db, team, nick };
  }

  const record = (db: Driver, teamId: string, state: string, extra: Record<string, unknown> = {}) =>
    recordSlackInstall(db, {
      teamId,
      actor: 'relay',
      slackTeamId: 'T1',
      botToken: 'xoxb-secret-token',
      installerSlackId: 'U1',
      state,
      installedAt: 1_000,
      ...extra,
    });

  it('a record the daemon never minted a state for installs nothing', async () => {
    const { db, team } = await teamWithHuman();
    const refused = await record(db, team.id, 'a-state-nobody-minted-here');
    expect(refused).toEqual({ ok: false, reason: 'no_live_request' });
    expect(await getSlackInstallBotToken(db, team.id)).toBeNull();
    expect(await listSlackInstalls(db, team.id)).toEqual([]);
  });

  it('a minted state records the install once; listings never carry the token', async () => {
    const { db, team, nick } = await teamWithHuman();
    const { state } = await createSlackInstallRequest(db, { teamId: team.id, actor: nick.name });
    const done = await record(db, team.id, state);
    expect(done.ok).toBe(true);
    expect(await getSlackInstallBotToken(db, team.id)).toEqual({
      slackTeamId: 'T1',
      botToken: 'xoxb-secret-token',
    });
    const listed = await listSlackInstalls(db, team.id);
    expect(listed).toEqual([
      { slackTeamId: 'T1', installerSlackId: 'U1', installedAt: 1_000, revokedAt: null },
    ]);
    expect(JSON.stringify(listed)).not.toContain('xoxb-secret-token');
    // The state is consumed: replaying the same record installs nothing new.
    const replay = await record(db, team.id, state, { slackTeamId: 'T2' });
    expect(replay).toEqual({ ok: false, reason: 'no_live_request' });
    // An expired state (minted 11 minutes ago) is refused too.
    const stale = await createSlackInstallRequest(db, {
      teamId: team.id,
      actor: nick.name,
      now: Date.now() - 11 * 60_000,
    });
    const expired = await record(db, team.id, stale.state, { slackTeamId: 'T3' });
    expect(expired).toEqual({ ok: false, reason: 'no_live_request' });
  });

  it("one team's state cannot record another team's install", async () => {
    const { db, team, nick } = await teamWithHuman();
    const other = await createTeam(db, { slug: 'other' });
    const { state } = await createSlackInstallRequest(db, { teamId: team.id, actor: nick.name });
    const refused = await record(db, other.id, state);
    expect(refused).toEqual({ ok: false, reason: 'no_live_request' });
    expect(await getSlackInstallBotToken(db, other.id)).toBeNull();
  });

  it('lists only this team’s live state hashes for relay registration', async () => {
    const { db, team, nick } = await teamWithHuman();
    const other = await createTeam(db, { slug: 'other' });
    const { createHash } = await import('node:crypto');
    const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');
    const mine = await createSlackInstallRequest(db, { teamId: team.id, actor: nick.name });
    await createSlackInstallRequest(db, { teamId: other.id, actor: nick.name });
    const stale = await createSlackInstallRequest(db, {
      teamId: team.id,
      actor: nick.name,
      now: Date.now() - 11 * 60_000,
    });
    void stale;
    const hashes = await listLiveInstallStateHashes(db, team.id);
    expect(hashes).toEqual([hashOf(mine.state)]);
  });

  it('the destination registered at mint round-trips, normalized to an https origin', async () => {
    const { db, team, nick } = await teamWithHuman();
    const { createHash } = await import('node:crypto');
    const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');
    const hosted = await createSlackInstallRequest(db, {
      teamId: team.id,
      actor: nick.name,
      destination: 'https://cloud.example',
    });
    const laptop = await createSlackInstallRequest(db, { teamId: team.id, actor: nick.name });
    const states = await listLiveInstallStates(db, team.id);
    expect(states).toContainEqual({
      stateHash: hashOf(hosted.state),
      destination: 'https://cloud.example',
    });
    expect(states).toContainEqual({ stateHash: hashOf(laptop.state), destination: null });
    expect(cloudDestinationFrom('http://cloud.example')).toBeNull();
    expect(cloudDestinationFrom('https://cloud.example/path')).toBeNull();
    expect(cloudDestinationFrom('https://user@cloud.example')).toBeNull();
  });

  it('a revoked install stops yielding a token and stays listed as revoked', async () => {
    const { db, team, nick } = await teamWithHuman();
    const { state } = await createSlackInstallRequest(db, { teamId: team.id, actor: nick.name });
    await record(db, team.id, state);
    expect(
      await revokeSlackInstall(db, { teamId: team.id, actor: nick.name, slackTeamId: 'T1' }),
    ).toBe(true);
    expect(await getSlackInstallBotToken(db, team.id)).toBeNull();
    expect((await listSlackInstalls(db, team.id))[0]?.revokedAt).not.toBeNull();
    expect(
      await revokeSlackInstall(db, { teamId: team.id, actor: nick.name, slackTeamId: 'T1' }),
    ).toBe(false);
  });
});
