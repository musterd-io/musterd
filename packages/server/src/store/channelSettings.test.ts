import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { listAudit } from './audit.js';
import {
  answerAllowed,
  deliverAllowed,
  getChannelSettings,
  setChannelSettings,
} from './channelSettings.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('channel settings (away channels 6)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  it('nothing is on by default: no row means no delivery and no answer authority', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const s = await getChannelSettings(db, team.id, nick.id, 'slack');
    expect(s).toEqual({
      channel: 'slack',
      deliver: false,
      answer: false,
      presenceGating: true,
      tierFloor: null,
    });
    expect(deliverAllowed(s, 'blocking')).toBe(false);
    expect(answerAllowed(s)).toBe(false);
  });

  it('answer off keeps delivery; delivery off removes answer authority too', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const notifyOnly = await setChannelSettings(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      settings: {
        channel: 'slack',
        deliver: true,
        answer: false,
        presenceGating: true,
        tierFloor: null,
      },
    });
    expect(deliverAllowed(notifyOnly, 'standard')).toBe(true);
    expect(answerAllowed(notifyOnly)).toBe(false);
    const off = await setChannelSettings(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      settings: {
        channel: 'slack',
        deliver: false,
        answer: true,
        presenceGating: true,
        tierFloor: null,
      },
    });
    expect(deliverAllowed(off, 'standard')).toBe(false);
    expect(answerAllowed(off)).toBe(false);
  });

  it('the tier floor delivers only asks at or above it', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const s = await setChannelSettings(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      settings: {
        channel: 'slack',
        deliver: true,
        answer: true,
        presenceGating: false,
        tierFloor: 'standard',
      },
    });
    expect(deliverAllowed(s, 'advisory')).toBe(false);
    expect(deliverAllowed(s, 'standard')).toBe(true);
    expect(deliverAllowed(s, 'blocking')).toBe(true);
    const audit = (await listAudit(db, team.id)).filter(
      (r) => r.action === 'channel.settings.changed',
    );
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail!)).toMatchObject({
      channel: 'slack',
      tier_floor: 'standard',
    });
  });
});
