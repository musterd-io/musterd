import { STATUS_LINE_TTL_MS } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { addMember, getMemberById } from './members.js';
import { toMember } from './rows.js';
import { clearStatusLine, setStatusLine } from './statusLine.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('statusLine', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  /** ADR 721: a human's own status line — set, read back, lapsed after an hour, humans only. */
  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { kind: 'human', name: 'nick', role: '' })).row;
    const miley = (await addMember(db, team, { kind: 'agent', name: 'miley', role: '' })).row;
    return { db, team, nick, miley };
  }

  describe('status line (ADR 721)', () => {
    it('sets a line that lasts an hour, and the member carries it', async () => {
      const { db, nick } = await seed();
      const line = await setStatusLine(db, nick, 'assembling a new dresser for the nursery', 1_000);
      expect(line).toEqual({
        text: 'assembling a new dresser for the nursery',
        set_at: 1_000,
        expires_at: 1_000 + STATUS_LINE_TTL_MS,
      });
      const row = (await getMemberById(db, nick.id))!;
      expect(toMember(row, 'revive', 1_000 + 60_000).status_line).toEqual(line);
    });

    it('is gone from the member the moment it lapses', async () => {
      const { db, nick } = await seed();
      await setStatusLine(db, nick, 'back soon', 1_000);
      const row = (await getMemberById(db, nick.id))!;
      expect(toMember(row, 'revive', 1_000 + STATUS_LINE_TTL_MS - 1).status_line).not.toBeNull();
      expect(toMember(row, 'revive', 1_000 + STATUS_LINE_TTL_MS).status_line).toBeNull();
    });

    it('setting it again starts a new hour', async () => {
      const { db, nick } = await seed();
      await setStatusLine(db, nick, 'first', 1_000);
      const again = await setStatusLine(db, nick, 'second', 50_000);
      expect(again.expires_at).toBe(50_000 + STATUS_LINE_TTL_MS);
    });

    it('clears', async () => {
      const { db, nick } = await seed();
      await setStatusLine(db, nick, 'here a while', 1_000);
      await clearStatusLine(db, nick);
      expect(toMember((await getMemberById(db, nick.id))!, 'revive', 2_000).status_line).toBeNull();
    });

    it('an agent never has one: the store refuses it', async () => {
      const { db, miley } = await seed();
      await expect(setStatusLine(db, miley, 'thinking', 1_000)).rejects.toThrow(/humans/);
    });

    it('refuses 49 characters and counts an emoji as one', async () => {
      const { db, nick } = await seed();
      await expect(setStatusLine(db, nick, 'x'.repeat(49), 1_000)).rejects.toThrow(/48/);
      await expect(setStatusLine(db, nick, '🛠'.repeat(48), 1_000)).resolves.toMatchObject({
        text: '🛠'.repeat(48),
      });
    });
  });
});
