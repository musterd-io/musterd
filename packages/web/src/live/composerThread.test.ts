import type { Envelope, MemberSummary } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import {
  answeredLine,
  askAnswer,
  castOf,
  composerThread,
  latestThreadRoot,
  seatState,
  sentenceOf,
  THREAD_RECENT_MS,
} from './composerThread';
import { deriveAsks, SPECIES_VERB_YOU } from './asks';
import { VERB_YOU } from './ComposerReplies';
import { promptAct, REPLY_FOOTER } from './promptAct';

const T = 1_791_600_000_000;
const env = (over: Partial<Envelope> & Pick<Envelope, 'id' | 'from'>): Envelope =>
  ({ team: 'revive', to: { kind: 'member', name: 'nick' }, act: 'message', body: 'x', thread: null, meta: null, ts: T, ...over }) as Envelope;
const huddle = (id: string, ts = T, extra: Partial<Envelope> = {}) => {
  const p = promptAct('Plan the first ten minutes', ['dolly', 'ghost', 'wanderer'], 'room')!;
  return env({ id, from: 'nick', to: p.to, act: p.act, body: p.body, meta: p.meta, ts, ...extra });
};
const member = (name: string, presence: string, provenance?: string) =>
  ({ name, kind: 'agent', presence, presences: provenance ? [{ status: 'online', provenance }] : [] }) as unknown as MemberSummary;

describe('which thread the panel shows', () => {
  it('is the viewer’s newest huddle, from the composer or the CLI', () => {
    const a = huddle('a', T);
    const b = huddle('b', T + 1000);
    const other = huddle('c', T + 2000, { from: 'alfie' });
    expect(latestThreadRoot([a, b, other], 'nick', T + 5000)?.id).toBe('b');
  });
  it('ages out, and stays hidden once hidden', () => {
    const a = huddle('a', T);
    expect(latestThreadRoot([a], 'nick', T + THREAD_RECENT_MS + 1)).toBeNull();
    expect(latestThreadRoot([a], 'nick', T + 1000, new Set(['a']))).toBeNull();
  });
  it('is never a plain message', () => {
    expect(latestThreadRoot([env({ id: 'm', from: 'nick', to: { kind: 'team' } })], 'nick', T)).toBeNull();
  });
});

describe('the fold', () => {
  const root = huddle('root');
  it('reads the cast from the eligible set, or the one seat addressed', () => {
    expect(castOf(root)).toEqual(['dolly', 'ghost', 'wanderer']);
    const one = promptAct('hi', ['ghost'], 'r')!;
    expect(castOf(env({ id: 'o', from: 'nick', to: one.to, meta: one.meta }))).toEqual(['ghost']);
  });

  it('counts ghost’s in_reply_to-only reply (rehearsal 1)', () => {
    const t = composerThread(
      [
        root,
        env({ id: 'd', from: 'dolly', thread: 'root', ts: T + 5 }),
        env({ id: 'g', from: 'ghost', meta: { in_reply_to: 'root' }, ts: T + 54_000 }),
      ],
      root,
      'nick',
    );
    expect([...t.answered].sort()).toEqual(['dolly', 'ghost']);
    expect(answeredLine(t)).toBe('2 of 3 have answered');
  });

  it('keeps a direct reply to the viewer while the thread is open, and marks it', () => {
    const t = composerThread([root, env({ id: 'w', from: 'wanderer', ts: T + 10 })], root, 'nick');
    expect(t.lines.map((l) => [l.env.id, l.direct])).toEqual([['w', true]]);
    expect(t.answered.has('wanderer')).toBe(true);
  });

  it('does not count a status ping as an answer, nor take mail from before the thread', () => {
    const t = composerThread(
      [
        env({ id: 'old', from: 'dolly', ts: T - 10 }),
        root,
        env({ id: 's', from: 'ghost', act: 'status_update', thread: 'root', ts: T + 5 }),
      ],
      root,
      'nick',
    );
    expect(t.answered.size).toBe(0);
    expect(t.lines).toEqual([]);
  });

  it('closes on a resolve, and stops gathering direct mail after it', () => {
    const t = composerThread(
      [
        root,
        env({ id: 'r', from: 'nick', act: 'resolve', thread: 'root', ts: T + 5 }),
        env({ id: 'late', from: 'dolly', ts: T + 10 }),
      ],
      root,
      'nick',
    );
    expect(t.closed).toBe(true);
    expect(t.lines).toEqual([]);
  });

  it('gathers asks on the thread with their state, and answers them the asks strip’s way', () => {
    const ask = env({ id: 'q', from: 'dolly', act: 'ask', thread: 'root', ts: T + 5, meta: { species: 'approve', tier: 'standard' } });
    const t = composerThread([root, ask], root, 'nick', deriveAsks([root, ask]));
    expect(t.asks.map((a) => [a.env.id, a.state])).toEqual([['q', 'open']]);
    expect(t.answered.has('dolly')).toBe(true);
    expect(askAnswer(t.asks[0]!, 'accept')).toEqual({
      act: 'accept',
      to: { kind: 'member', name: 'dolly' },
      thread: 'root',
      meta: { in_reply_to: 'q' },
    });
    const all = [root, ask, env({ id: 'y', from: 'nick', act: 'accept', to: { kind: 'member', name: 'dolly' }, thread: 'root', ts: T + 9, meta: { in_reply_to: 'q' } })];
    const answered = composerThread(all, root, 'nick', deriveAsks(all));
    expect(answered.asks[0]!.state).toBe('accepted');
    expect(answered.lines).toEqual([]); // the answer act is not a line of conversation
  });

  it('shows the sentence without the routing footer', () => {
    expect(sentenceOf(`Plan it\n\n${REPLY_FOOTER}`)).toBe('Plan it');
    expect(sentenceOf('From the CLI')).toBe('From the CLI');
  });
});

describe('what the avatar stack says', () => {
  const open = { answered: new Set(['dolly']), closed: false };
  it('ticks who answered', () => {
    expect(seatState('dolly', open, member('dolly', 'offline'))).toBe('replied');
  });
  it('says waking for an asleep seat, or one a wake just brought in', () => {
    expect(seatState('ghost', open, member('ghost', 'offline'))).toBe('waking');
    expect(seatState('ghost', open, member('ghost', 'online', 'wake'))).toBe('waking');
  });
  it('says nothing for a seat that is simply here, or once the thread closed', () => {
    expect(seatState('ghost', open, member('ghost', 'online', 'session'))).toBe('here');
    expect(seatState('ghost', { ...open, closed: true }, member('ghost', 'offline'))).toBe('here');
  });
});

describe('the inline ask card speaks the asks strip’s words', () => {
  it('has the same second-person verbs as asks.ts (copied only to keep asks.ts out of the eager graph)', () => {
    expect(VERB_YOU).toEqual(SPECIES_VERB_YOU);
  });
});
