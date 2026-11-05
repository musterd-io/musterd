import type { OpenPollReply } from '@musterd/protocol/wire';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  draftSpec,
  EMPTY_DRAFT,
  lastLine,
  NEEDS_PASSKEY,
  NOT_LIVE,
  PollPanelView,
  refusalText,
  type PollDraft,
} from './PollPanel';

/** Twitch polls on /live (ADR 807, lane 01M6ME5EPX): start, end, cancel, and why a start is refused. */

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

const draft = (over: Partial<PollDraft> = {}): PollDraft => ({
  question: 'What next?',
  options: ['Camera', 'Ask the team'],
  minutes: '5',
  ...over,
});

const render = (reply: OpenPollReply | null, d: PollDraft = draft()) =>
  renderToStaticMarkup(
    createElement(PollPanelView, {
      reply,
      draft: d,
      busy: false,
      note: null,
      now: 60_000,
      onDraft: () => {},
      onStart: () => {},
      onClose: () => {},
    }),
  );

describe('PollPanel', () => {
  it('disables Start and says why while the stream is not live on Twitch', () => {
    const out = render({ live: false, poll: null });
    expect(out).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(out).toContain(NOT_LIVE);
    expect(out).toContain('not live');
  });

  it('enables Start once live with a valid draft', () => {
    const out = render({ live: true, poll: null });
    expect(out).not.toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(out).toContain('live on Twitch');
  });

  it('takes 2–4 options and 1–15 minutes, and drops blank options', () => {
    expect(draftSpec(draft())).toEqual({
      ok: true,
      spec: { question: 'What next?', options: ['Camera', 'Ask the team'], minutes: 5 },
    });
    expect(draftSpec(draft({ options: ['Camera', ' '] }))).toMatchObject({ ok: false });
    expect(draftSpec(draft({ options: ['a', 'b', 'c', 'd', 'e'] }))).toMatchObject({ ok: false });
    expect(draftSpec(draft({ minutes: '0' }))).toMatchObject({ ok: false });
    expect(draftSpec(draft({ minutes: '16' }))).toMatchObject({ ok: false });
    expect(draftSpec(draft({ minutes: '2.5' }))).toMatchObject({ ok: false });
    expect(draftSpec(draft({ options: ['Camera', 'camera'] }))).toMatchObject({ ok: false });
    expect(draftSpec(EMPTY_DRAFT)).toMatchObject({ ok: false, problem: 'Ask a question.' });
  });

  it('shows the open poll with its counts, End and Cancel, and no form', () => {
    const out = render({ live: true, poll: POLL });
    expect(out).toContain('What next?');
    expect(out).toContain('3 · 75%');
    expect(out).toContain('End now');
    expect(out).toContain('Cancel poll');
    expect(out).toContain('4:00 left');
    expect(out).not.toContain('Start poll');
  });

  it('says so when musterdbot could not post the poll', () => {
    expect(render({ live: true, poll: { ...POLL, post_failed: true } })).toContain(
      'musterdbot couldn’t post in chat',
    );
    expect(render({ live: true, poll: POLL })).not.toContain('couldn’t post');
  });

  it('reads a passkey refusal as what to do', () => {
    expect(refusalText('poll needs a passkey: enroll one before opening a poll (ADR 807)')).toBe(
      NEEDS_PASSKEY,
    );
    expect(refusalText('the stream is not live on Twitch, so a poll cannot open')).toBe(NOT_LIVE);
    expect(refusalText('a poll is already open on this team')).toBe('A poll is already running.');
    expect(refusalText('something else')).toBe('something else');
  });

  it('shows the last result above the form for a few minutes after a poll closes', () => {
    const out = render({
      live: true,
      poll: null,
      last: {
        state: 'closed',
        id: POLL.id,
        question: 'What next?',
        options: POLL.options,
        opened_by: 'nick',
        opened_at: 0,
        closes_at: 300_000,
        counts: [3, 1],
        voters: 4,
        end: 'deadline',
        winners: [0],
        closed_at: 55_000,
      },
    });
    expect(out).toContain('Last poll: What next? — Winner: 1 · Camera (4 votes)');
  });

  it('says a cancelled or interrupted last poll plainly', () => {
    const base = {
      state: 'closed' as const,
      id: POLL.id,
      question: 'What next?',
      options: POLL.options,
      opened_by: 'nick',
      opened_at: 0,
      closes_at: 300_000,
      counts: [3, 1],
      voters: 4,
      closed_at: 55_000,
    };
    expect(lastLine({ ...base, end: 'cancelled', winners: [] })).toBe(
      'Last poll cancelled: What next?',
    );
    expect(lastLine({ ...base, end: 'interrupted', winners: [0] })).toBe(
      'Last poll ended when the stream dropped: What next? (4 votes)',
    );
  });
});
