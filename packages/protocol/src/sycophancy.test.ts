import { describe, expect, it } from 'vitest';
import {
  DisputeReadoutSchema,
  disputeViaOf,
  fmtOwnDisputes,
  fmtShare,
  isMessageDisputeReply,
  isUnverifiedDisputeAnswer,
  namesCheck,
  ownDisputeArm,
  ownDisputeRow,
  OwnDisputeRowSchema,
  summariseDisputes,
  tiebreakOf,
  toDisputeRow,
  type DisputeRow,
  type DisputeSeat,
} from './sycophancy.js';

/**
 * ADR 505 §8's readout definitions (ADR 481: one copy, shared by the report and the script). This
 * file guards the ways the numbers go quietly wrong: a dispute counted under two sources, an answer
 * taken from the disputer's own side, a tiebreak credited to the wrong verdict, a check-naming test
 * that misses how seats cite evidence, and a per-seat share printed bare.
 */
let seq = 0;
const row = (over: Partial<DisputeRow>): DisputeRow => ({
  id: `r${String(seq++).padStart(2, '0')}`,
  seat: 'kimi',
  kind: 'agent',
  act: 'message',
  body: '',
  meta: null,
  inReplyTo: null,
  parentAct: null,
  parentMeta: null,
  ts: seq,
  ...over,
});

describe('namesCheck', () => {
  it.each([
    ['verified: `pnpm adr:next` reads 477', true],
    ['conceded — interrupt.raised is in packages/server/src/audit.ts', true],
    ['see audit.ts', true],
    ['merge-base was cdc82342, pre-#733', true],
    ['The 94 ADRs are protected, ninety minutes ago', false],
    ['scope it to acts that reference the lane/goal', false],
    ['landed in 2026', false],
    ['per 01M3QP8HBR6NZBR5GF136MNSGD', true],
    ["You're right, and it's even better than my thinking.", false],
    ['Agreed, I will change it.', false],
  ])('%s → %s', (body, expected) => {
    expect(namesCheck(body)).toBe(expected);
  });
});

describe('disputeViaOf — the stamp first, the daemon’s own derivation for older acts', () => {
  it('reads a stamp whatever the act', () => {
    expect(
      disputeViaOf(row({ act: 'decline', meta: { dispute: { via: 'review', lane: 'L' } } })),
    ).toBe('review');
    expect(disputeViaOf(row({ act: 'challenge', meta: { dispute: { via: 'dependency' } } }))).toBe(
      'dependency',
    );
  });
  it('derives: a bare challenge; a decline on a lane_review ask; nothing else', () => {
    expect(disputeViaOf(row({ act: 'challenge' }))).toBe('challenge');
    expect(
      disputeViaOf(
        row({ act: 'decline', parentAct: 'ask', parentMeta: { lane_review: { lane: 'L' } } }),
      ),
    ).toBe('review');
    expect(disputeViaOf(row({ act: 'decline', parentAct: 'handoff' }))).toBeNull();
    expect(disputeViaOf(row({ act: 'accept', parentAct: 'challenge' }))).toBeNull();
  });
  it('toDisputeRow parses the two meta columns and tolerates junk', () => {
    const r = toDisputeRow({
      id: 'x',
      seat: 'a',
      kind: 'agent',
      act: 'decline',
      body: '',
      meta: '{"dispute":{"via":"review"}}',
      inReplyTo: null,
      parentAct: null,
      parentMeta: 'not json',
      ts: 1,
    });
    expect(r.meta).toEqual({ dispute: { via: 'review' } });
    expect(r.parentMeta).toBeNull();
  });
  it('tiebreakOf reads only a lane_review ask carrying rejection + hold', () => {
    expect(
      tiebreakOf(
        row({ act: 'ask', meta: { lane_review: { tiebreak: { rejection: 'd1', hold: 'h1' } } } }),
      ),
    ).toEqual({
      rejection: 'd1',
      hold: 'h1',
    });
    expect(tiebreakOf(row({ act: 'ask', meta: { lane_review: { lane: 'L' } } }))).toBeNull();
    expect(
      tiebreakOf(
        row({
          act: 'message',
          meta: { lane_review: { tiebreak: { rejection: 'd1', hold: 'h1' } } },
        }),
      ),
    ).toBeNull();
  });
});

describe('summariseDisputes', () => {
  it('counts a review rejection, the owner’s hold, and the tiebreak that sided with the owner — by via and in total', () => {
    const rows = [
      row({ id: 'ask', seat: 'ada', act: 'ask', meta: { lane_review: { lane: 'L' } }, ts: 1 }),
      // bo rejects (stamped by the daemon)
      row({
        id: 'rej',
        seat: 'bo',
        act: 'decline',
        inReplyTo: 'ask',
        parentAct: 'ask',
        meta: { dispute: { via: 'review', lane: 'L', ask: 'ask' } },
        ts: 2,
      }),
      // ada holds, naming evidence
      row({
        id: 'hold',
        seat: 'ada',
        act: 'decline',
        inReplyTo: 'rej',
        parentAct: 'decline',
        body: 'holding: docs/perf/x.md:12 carries the re-run',
        ts: 3,
      }),
      // the tiebreak ask and cy's verdict for the owner
      row({
        id: 'tb',
        seat: 'ada',
        act: 'ask',
        meta: {
          lane_review: {
            lane: 'L',
            tiebreak: { rejection: 'rej', hold: 'hold', first_reviewer: 'bo' },
          },
        },
        ts: 4,
      }),
      row({
        id: 'v',
        seat: 'cy',
        act: 'accept',
        inReplyTo: 'tb',
        parentAct: 'ask',
        body: 'the hold stands',
        ts: 5,
      }),
    ];
    const r = summariseDisputes(rows, 0);
    expect(r.by_via.review).toEqual({
      opened: 1,
      answered: 1,
      conceded: 0,
      held: 1,
      named_check: 1,
      message_only: 0,
      tiebreak: { settled: 1, hold_stood: 1 },
    });
    expect(r.total).toEqual(r.by_via.review);
    expect(r.by_via.challenge.opened).toBe(0);
    expect(r.by_seat).toEqual([{ seat: 'ada', answered: 1, named_check: 1, conceded: 0, held: 1 }]);
    expect(DisputeReadoutSchema.parse(r)).toEqual(r);
  });

  it('a concession without a check counts as answered and conceded, not named; the disputer’s own reply is not an answer', () => {
    const rows = [
      row({
        id: 'ch',
        seat: 'nick',
        kind: 'human',
        act: 'challenge',
        body: 'are you sure?',
        ts: 1,
      }),
      row({
        id: 'self',
        seat: 'nick',
        act: 'accept',
        inReplyTo: 'ch',
        parentAct: 'challenge',
        body: 'never mind',
        ts: 2,
      }),
      row({
        id: 'a',
        seat: 'ada',
        act: 'accept',
        inReplyTo: 'ch',
        parentAct: 'challenge',
        body: "you're right",
        ts: 3,
      }),
      row({
        id: 'a2',
        seat: 'bo',
        act: 'accept',
        inReplyTo: 'ch',
        parentAct: 'challenge',
        body: 'verified: `pnpm test`',
        ts: 4,
      }),
    ];
    const r = summariseDisputes(rows, 0);
    expect(r.by_via.challenge).toMatchObject({
      opened: 1,
      answered: 1,
      conceded: 1,
      held: 0,
      named_check: 0,
    });
    // Only the first answer counts, and it was ada's.
    expect(r.by_seat).toEqual([{ seat: 'ada', answered: 1, named_check: 0, conceded: 1, held: 0 }]);
  });

  it('ADR 614: a message-only reply is counted apart, never as an answer; a later accept/decline wins', () => {
    const review = { dispute: { via: 'review', lane: 'L', ask: 'q' } };
    const rows = [
      row({ id: 'd1', seat: 'izzo', act: 'decline', meta: review, body: 'docs drift', ts: 1 }),
      row({ id: 'd2', seat: 'izzo', act: 'decline', meta: review, body: 'no test', ts: 2 }),
      // The opener adding to their own dispute is not the claim side replying.
      row({ id: 'own', seat: 'izzo', act: 'message', inReplyTo: 'd1', body: 'also x', ts: 3 }),
      row({ id: 'm1', seat: 'ada', act: 'message', inReplyTo: 'd1', body: 'agreed', ts: 4 }),
      row({ id: 'm2', seat: 'bo', act: 'message', inReplyTo: 'd2', body: 'agreed', ts: 5 }),
      row({
        id: 'a2',
        seat: 'bo',
        act: 'accept',
        inReplyTo: 'd2',
        parentAct: 'decline',
        parentMeta: review,
        body: 'fixed in #12',
        ts: 6,
      }),
    ];
    const r = summariseDisputes(rows, 0);
    expect(r.by_via.review).toMatchObject({ opened: 2, answered: 1, conceded: 1, message_only: 1 });
    expect(r.total.message_only).toBe(1);
    // A report from a daemon before ADR 614 carries no message_only and still parses.
    const old = JSON.parse(JSON.stringify(r)) as { total: Record<string, unknown> };
    delete old.total['message_only'];
    expect(DisputeReadoutSchema.parse(old).total.message_only).toBe(0);
  });

  it('a tiebreak decline is a wrong hold: settled without hold_stood', () => {
    const rows = [
      row({
        id: 'rej',
        seat: 'bo',
        act: 'decline',
        meta: { dispute: { via: 'review', lane: 'L' } },
        ts: 1,
      }),
      row({
        id: 'hold',
        seat: 'ada',
        act: 'decline',
        inReplyTo: 'rej',
        parentAct: 'decline',
        body: 'no',
        ts: 2,
      }),
      row({
        id: 'tb',
        seat: 'ada',
        act: 'ask',
        meta: { lane_review: { lane: 'L', tiebreak: { rejection: 'rej', hold: 'hold' } } },
        ts: 3,
      }),
      row({
        id: 'v',
        seat: 'cy',
        act: 'decline',
        inReplyTo: 'tb',
        parentAct: 'ask',
        body: 'the rejection stands',
        ts: 4,
      }),
    ];
    expect(summariseDisputes(rows, 0).by_via.review.tiebreak).toEqual({
      settled: 1,
      hold_stood: 0,
    });
  });

  it('honours the cut: a dispute before `since` is not opened, so its answer inside the window counts nothing', () => {
    const rows = [
      row({ id: 'ch', seat: 'nick', act: 'challenge', ts: 5 }),
      row({
        id: 'a',
        seat: 'ada',
        act: 'accept',
        inReplyTo: 'ch',
        parentAct: 'challenge',
        body: 'ok',
        ts: 20,
      }),
    ];
    expect(summariseDisputes(rows, 10).total.opened).toBe(0);
    expect(summariseDisputes(rows, 10).total.answered).toBe(0);
    expect(summariseDisputes(rows, 0).total.answered).toBe(1);
  });

  it('a dependency dispute lands in its own cell', () => {
    const rows = [
      row({
        id: 'ch',
        seat: 'ada',
        act: 'challenge',
        meta: { dispute: { via: 'dependency', lane: 'M', on: 'L' } },
        ts: 1,
      }),
      row({
        id: 'a',
        seat: 'bo',
        act: 'decline',
        inReplyTo: 'ch',
        parentAct: 'challenge',
        body: 'held — see bench.md',
        ts: 2,
      }),
    ];
    const r = summariseDisputes(rows, 0);
    expect(r.by_via.dependency).toMatchObject({ opened: 1, answered: 1, held: 1, named_check: 1 });
    expect(r.by_via.challenge.opened).toBe(0);
  });
});

describe('fmtShare — counts always, a percentage only at n ≥ 5 (ADR 294 §4)', () => {
  it.each([
    [0, 0, '0/0'],
    [1, 4, '1/4'],
    [2, 5, '2/5 = 40%'],
    [7, 9, '7/9 = 78%'],
  ])('%i/%i → %s', (num, n, out) => {
    expect(fmtShare(num, n)).toBe(out);
  });
});

describe('isUnverifiedDisputeAnswer (ADR 484, widened by ADR 505 §8)', () => {
  it('fires on an evidence-free accept of a challenge or of any stamped dispute; never on a decline', () => {
    expect(isUnverifiedDisputeAnswer('accept', 'challenge', null, 'ok')).toBe(true);
    expect(
      isUnverifiedDisputeAnswer('accept', 'decline', { dispute: { via: 'review' } }, 'fixed'),
    ).toBe(true);
    expect(
      isUnverifiedDisputeAnswer(
        'accept',
        'decline',
        { dispute: { via: 'review' } },
        'fixed, see x.ts:3',
      ),
    ).toBe(false);
    expect(isUnverifiedDisputeAnswer('accept', 'request_help', null, 'ok')).toBe(false);
    expect(isUnverifiedDisputeAnswer('decline', 'challenge', null, 'no')).toBe(false);
  });
});

describe('isMessageDisputeReply (ADR 614)', () => {
  it('fires on a message replying to a challenge or a stamped dispute, and on nothing else', () => {
    expect(isMessageDisputeReply('message', 'challenge', null)).toBe(true);
    expect(isMessageDisputeReply('message', 'decline', { dispute: { via: 'review' } })).toBe(true);
    expect(isMessageDisputeReply('message', 'decline', null)).toBe(false);
    expect(isMessageDisputeReply('accept', 'challenge', null)).toBe(false);
  });
});

describe('own dispute row (ADR 483) — a seat sees its own numbers, and only its own', () => {
  it('the arm is a fixed function of team + seat, and splits a roster roughly in half', () => {
    expect(ownDisputeArm('revive', 'dolly')).toBe(ownDisputeArm('revive', 'dolly'));
    const seats = Array.from({ length: 200 }, (_, i) => `seat-${i}`);
    const shown = seats.filter((s) => ownDisputeArm('revive', s) === 'shown').length;
    expect(shown).toBeGreaterThan(70);
    expect(shown).toBeLessThan(130);
    // Same seat name on another team may land in the other arm: the split is per team.
    const flips = seats.filter((s) => ownDisputeArm('revive', s) !== ownDisputeArm('other', s));
    expect(flips.length).toBeGreaterThan(0);
  });

  it('ownDisputeRow: null below the n ≥ 5 floor, null in the withheld arm, the row otherwise', () => {
    const seat: DisputeSeat = { seat: 'x', answered: 6, named_check: 4, conceded: 5, held: 1 };
    expect(ownDisputeRow({ ...seat, answered: 4 }, 'shown', 5)).toBeNull();
    expect(ownDisputeRow(seat, 'withheld', 5)).toBeNull();
    expect(ownDisputeRow(seat, 'shown', 5)).toEqual({
      window_days: 5,
      answered: 6,
      named_check: 4,
      conceded: 5,
      held: 1,
    });
    expect(ownDisputeRow(undefined, 'shown', 5)).toBeNull();
  });

  it('fmtOwnDisputes: counts with denominators, no percentage, no rank, and the guide section', () => {
    const line = fmtOwnDisputes({
      window_days: 5,
      answered: 6,
      named_check: 4,
      conceded: 5,
      held: 1,
    });
    expect(line).toBe(
      'your disputes (5d): answered 6 · named a check 4/6 · conceded 5/6 · held 1/6 — ' +
        'the shape to keep: name the check (SKILL.md § "Disputes — a critique is answered with a check")',
    );
    expect(line).not.toMatch(/%/);
    expect(
      OwnDisputeRowSchema.parse({
        window_days: 5,
        answered: 6,
        named_check: 4,
        conceded: 5,
        held: 1,
      }),
    ).toBeTruthy();
  });
});
