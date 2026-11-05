import { POLL_LIMITS } from '@musterd/protocol';
import { expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import {
  closePoll,
  duePolls,
  isLive,
  issuePollToken,
  openPoll,
  openPollReply,
  reportCounts,
  reportLive,
} from './polls.js';
import { createTeam } from './teams.js';

const T = 1_800_000_000_000;
const SPEC = {
  question: 'What should revive work on next?',
  options: ['Camera', 'Ask the team'],
  minutes: 5,
};

withDrivers('polls-store', (open) => {
  async function seed() {
    const db = await open();
    const team = await createTeam(db, { slug: 'revive' });
    return { db, team };
  }
  const counts = (poll_id: string, c: number[], voters: number, live = true) => ({
    poll_id,
    counts: c,
    voters,
    live,
    post_failed: false,
  });

  it('opens only while Twitch reported the channel live within the grace', async () => {
    const { db, team } = await seed();
    await expect(openPoll(db, team.id, 'nick', SPEC, T)).rejects.toThrow(/not live/);
    await reportLive(db, team.id, true, T);
    expect(await isLive(db, team.id, T + POLL_LIMITS.offlineGraceMs - 1)).toBe(true);
    expect(await isLive(db, team.id, T + POLL_LIMITS.offlineGraceMs + 1)).toBe(false);
    await reportLive(db, team.id, false, T + 1000);
    expect(await isLive(db, team.id, T + 1000)).toBe(false);
  });

  it('holds one open poll per team', async () => {
    const { db, team } = await seed();
    await reportLive(db, team.id, true, T);
    const { poll } = await openPoll(db, team.id, 'nick', SPEC, T);
    expect(poll.closes_at).toBe(T + 5 * 60_000);
    expect(poll.counts).toEqual([0, 0]);
    await expect(openPoll(db, team.id, 'nick', SPEC, T + 1)).rejects.toThrow(/already open/);
  });

  it('gives the token to the broadcast seat alone, and a fresh one replaces the last', async () => {
    const { db, team } = await seed();
    await reportLive(db, team.id, true, T);
    const { poll } = await openPoll(db, team.id, 'nick', SPEC, T);
    expect((await openPollReply(db, team.id, { broadcast: false }, T)).poll).not.toHaveProperty(
      'poll_token',
    );
    const a = await issuePollToken(db, team.id, poll.id);
    const b = await issuePollToken(db, team.id, poll.id);
    expect(a).toMatch(/^mspoll_/);
    expect(await reportCounts(db, team.id, poll.id, a, counts(poll.id, [1, 0], 1), T + 1)).toBe(
      'bad_token',
    );
    expect(await reportCounts(db, team.id, poll.id, b, counts(poll.id, [1, 0], 1), T + 1)).toBe(
      'ok',
    );
    const reply = await openPollReply(db, team.id, { broadcast: true }, T + 2);
    expect(reply.poll?.poll_token).toMatch(/^mspoll_/);
    expect(reply.poll?.counts).toEqual([1, 0]);
  });

  it('refuses counts for another poll, out of shape, above the voters, or after close', async () => {
    const { db, team } = await seed();
    await reportLive(db, team.id, true, T);
    const { poll } = await openPoll(db, team.id, 'nick', SPEC, T);
    const tok = await issuePollToken(db, team.id, poll.id);
    expect(
      await reportCounts(
        db,
        team.id,
        'other-poll-id-0000',
        tok,
        counts('other-poll-id-0000', [1, 0], 1),
        T,
      ),
    ).toBe('bad_token');
    expect(await reportCounts(db, team.id, poll.id, tok, counts(poll.id, [1, 0, 0], 1), T)).toBe(
      'bad_counts',
    );
    expect(await reportCounts(db, team.id, poll.id, tok, counts(poll.id, [3, 2], 4), T)).toBe(
      'bad_counts',
    );
    await closePoll(db, team.id, poll.id, 'ended', T + 10);
    expect(await reportCounts(db, team.id, poll.id, tok, counts(poll.id, [1, 0], 1), T + 11)).toBe(
      'closed',
    );
  });

  it('closes with winners: one, a tie, none, and none when cancelled', async () => {
    const { db, team } = await seed();
    const run = async (c: number[], voters: number, end: 'deadline' | 'cancelled') => {
      await reportLive(db, team.id, true, T);
      const { poll } = await openPoll(
        db,
        team.id,
        'nick',
        { ...SPEC, options: ['a', 'b', 'c'] },
        T,
      );
      const tok = await issuePollToken(db, team.id, poll.id);
      await reportCounts(db, team.id, poll.id, tok, counts(poll.id, c, voters), T + 1);
      return closePoll(db, team.id, poll.id, end, T + 2);
    };
    expect((await run([1, 4, 2], 7, 'deadline'))?.winners).toEqual([1]);
    expect((await run([3, 3, 0], 6, 'deadline'))?.winners).toEqual([0, 1]);
    expect((await run([0, 0, 0], 0, 'deadline'))?.winners).toEqual([]);
    const cancelled = await run([5, 0, 0], 5, 'cancelled');
    expect(cancelled?.winners).toEqual([]);
    expect(cancelled).toMatchObject({
      state: 'closed',
      end: 'cancelled',
      counts: [5, 0, 0],
      voters: 5,
    });
  });

  it('is due at its deadline, or after 90 s of Twitch reporting offline', async () => {
    const { db, team } = await seed();
    await reportLive(db, team.id, true, T);
    const { poll } = await openPoll(db, team.id, 'nick', SPEC, T);
    expect(await duePolls(db, T + 60_000)).toEqual([]);
    expect(await duePolls(db, T + 5 * 60_000)).toEqual([
      { teamId: team.id, pollId: poll.id, end: 'deadline' },
    ]);
    await reportLive(db, team.id, false, T + 10_000);
    expect(await duePolls(db, T + 10_000 + POLL_LIMITS.offlineGraceMs - 1)).toEqual([]);
    expect(await duePolls(db, T + 10_000 + POLL_LIMITS.offlineGraceMs)).toEqual([
      { teamId: team.id, pollId: poll.id, end: 'interrupted' },
    ]);
    // A stream that comes back inside the grace clears it: a restart is not a drop.
    await reportLive(db, team.id, true, T + 30_000);
    expect(await duePolls(db, T + 10_000 + POLL_LIMITS.offlineGraceMs)).toEqual([]);
  });

  it('keeps the closed poll as `last` for five minutes, so the stream can post its result', async () => {
    const { db, team } = await seed();
    await reportLive(db, team.id, true, T);
    const { poll } = await openPoll(db, team.id, 'nick', SPEC, T);
    await closePoll(db, team.id, poll.id, 'ended', T + 1000);
    const soon = await openPollReply(db, team.id, { broadcast: true }, T + 2000);
    expect(soon.poll).toBeNull();
    expect(soon.last).toMatchObject({ id: poll.id, state: 'closed', end: 'ended' });
    const later = await openPollReply(
      db,
      team.id,
      { broadcast: true },
      T + 1000 + POLL_LIMITS.lastKeptMs + 1,
    );
    expect(later.last).toBeNull();
  });
});
