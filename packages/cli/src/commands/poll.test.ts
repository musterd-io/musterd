import { describe, expect, it, vi } from 'vitest';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { openPollSigned, pollCommand, renderPollStatus, startSpec } from './poll.js';

/** ADR 807 — `musterd poll` as a human admin. The daemon decides; this pins the words and the order. */

const POLL = {
  id: '01M6POLL0000000000000000AA',
  question: 'What next?',
  options: ['Camera', 'Ask the team'],
  minutes: 5,
  opened_by: 'nick',
  opened_at: 0,
  closes_at: 300_000,
  counts: [3, 1],
  voters: 4,
  post_failed: false,
};

const h = vi.hoisted(() => ({
  server: 'http://localhost:4849',
  getOpenPoll: vi.fn(),
  openPoll: vi.fn(),
  closePoll: vi.fn(),
  createAuthorityDescriptor: vi.fn(async () => ({
    descriptor: {
      v: 1,
      actor: 'nick',
      act: 'credential_mint',
      target: 'revive',
      payload_digest: 'a'.repeat(64),
      audience: 'revive',
      expiry: 9999999999999,
      nonce: 'nonce-at-least-16-chars',
    },
  })),
  getParkedApproval: vi.fn(async () => ({
    proof: { key_id: 'key-1', nonce: 'nonce-at-least-16-chars', signature: 'sig' },
  })),
}));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'revive',
    identity: { name: 'nick' },
    http: {
      server: h.server,
      getOpenPoll: h.getOpenPoll,
      openPoll: h.openPoll,
      closePoll: h.closePoll,
      createAuthorityDescriptor: h.createAuthorityDescriptor,
      getParkedApproval: h.getParkedApproval,
    },
  }),
}));

const parsed = (positionals: string[], flags: Parsed['flags'] = {}): Parsed =>
  ({ positionals, flags, metaPairs: [] }) as Parsed;

async function capture(fn: () => Promise<number>) {
  const out: string[] = [];
  const o = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((c: never) => (out.push(String(c)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return { code: await fn(), out: out.join('') };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

describe('musterd poll (ADR 807)', () => {
  it('refuses a flag it does not take', async () => {
    await expect(pollCommand(parsed(['status'], { option: 'Camera' }))).rejects.toThrow(
      /musterd help poll/,
    );
  });

  it('needs 2–4 options, and 1–15 whole minutes', () => {
    expect(() => startSpec(['What next?', 'Camera'], undefined)).toThrow(
      /a poll needs 2–4 options/,
    );
    expect(() => startSpec(['Q', 'a', 'b', 'c', 'd', 'e'], undefined)).toThrow(/2–4 options/);
    expect(() => startSpec(['Q', 'a', 'b'], '0')).toThrow(/--minutes/);
    expect(() => startSpec(['Q', 'a', 'b'], '2.5')).toThrow(/--minutes/);
    expect(() => startSpec([], undefined)).toThrow(/which question/);
    try {
      startSpec(['What next?', 'Camera'], undefined);
    } catch (e) {
      expect((e as CliError).exitCode).toBe(2);
    }
    // The spec carries minutes explicitly: the passkey signs exactly what the daemon stores.
    expect(startSpec(['What next?', ' Camera ', 'Ask the team'], undefined)).toEqual({
      question: 'What next?',
      options: ['Camera', 'Ask the team'],
      minutes: 5,
    });
  });

  it('opens unsigned first, then on no_signature approves poll_open over the exact spec and resends', async () => {
    const spec = startSpec(['What next?', 'Camera', 'Ask the team'], '3');
    h.openPoll
      .mockRejectedValueOnce(
        new CliError(
          'authority refused (no_signature): opening a poll requires an A2 device signature (ADR 807)',
          5,
          'forbidden',
        ),
      )
      .mockResolvedValueOnce({ poll: POLL });
    const e = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(openPollSigned(h as never, 'revive', spec)).resolves.toEqual({ poll: POLL });
    } finally {
      e.mockRestore();
    }
    expect(h.openPoll).toHaveBeenNthCalledWith(1, 'revive', spec);
    expect(h.createAuthorityDescriptor).toHaveBeenCalledWith('revive', {
      act: 'credential_mint',
      target: 'revive',
      payload: { action: 'poll_open', spec },
    });
    expect(h.openPoll).toHaveBeenLastCalledWith('revive', spec, {
      key_id: 'key-1',
      nonce: 'nonce-at-least-16-chars',
      signature: 'sig',
    });
  });

  it('says what to do when the daemon refuses an unenrolled admin or a stream that is not live', async () => {
    h.openPoll.mockRejectedValueOnce(
      new CliError(
        'poll needs a passkey: enroll one before opening a poll (ADR 807)',
        5,
        'forbidden',
      ),
    );
    await expect(
      openPollSigned(h as never, 'revive', startSpec(['Q', 'a', 'b'], undefined)),
    ).rejects.toThrow(/musterd authority enroll/);
    h.openPoll.mockRejectedValueOnce(
      new CliError('the stream is not live on Twitch, so a poll cannot open', 9, 'conflict'),
    );
    await expect(
      openPollSigned(h as never, 'revive', startSpec(['Q', 'a', 'b'], undefined)),
    ).rejects.toThrow(/live on Twitch/);
  });

  it('status prints the question, each option with its count and share, and the time left', () => {
    const text = renderPollStatus({ live: true, poll: POLL }, 60_000).replace(
      // eslint-disable-next-line no-control-regex
      /\u001b\[[0-9;]*m/g,
      '',
    );
    expect(text).toContain('live on Twitch');
    expect(text).toContain('What next?');
    expect(text).toContain('!vote 1  Camera  3 · 75%');
    expect(text).toContain('!vote 2  Ask the team  1 · 25%');
    expect(text).toContain('4 votes · 4:00 left · opened by nick');
  });

  it('status with no poll says so, with the last result', () => {
    const text = renderPollStatus(
      {
        live: false,
        poll: null,
        last: { ...POLL, state: 'closed', end: 'deadline', winners: [0], closed_at: 300_000 },
      },
      301_000,
    );
    expect(text).toContain('not live on Twitch');
    expect(text).toContain('no poll open');
    expect(text).toContain('last poll: What next? — winner 1 · Camera (4 votes)');
  });

  it('end closes the open poll with the votes so far', async () => {
    h.getOpenPoll.mockResolvedValueOnce({ live: true, poll: POLL });
    h.closePoll.mockResolvedValueOnce({
      poll: { ...POLL, state: 'closed', end: 'ended', winners: [0], closed_at: 100_000 },
    });
    const r = await capture(() => pollCommand(parsed(['end'])));
    expect(r.code).toBe(0);
    expect(h.closePoll).toHaveBeenCalledWith('revive', POLL.id, 'end');
    expect(r.out).toContain('winner 1 · Camera (4 votes)');
    h.getOpenPoll.mockResolvedValueOnce({ live: true, poll: null });
    await expect(pollCommand(parsed(['cancel']))).rejects.toThrow(/no poll is open/);
  });
});
