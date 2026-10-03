import { describe, expect, it } from 'vitest';
import {
  askConcernsMe,
  chooseAutoTarget,
  CLI_REPLY_TO_STYLE,
  threadHintFor,
  type AutoTargetable,
} from './autoTarget.js';

/**
 * The rule that decides what an un-threaded `accept`/`decline` answers.
 *
 * WHY THIS FILE EXISTS AT ALL. The refusal it guards was written twice — once in
 * `packages/mcp/src/tools/send.ts` and once in `packages/cli/src/commands/send.ts` — and tested
 * neither time. Both copies carried a comment stating the correct invariant ("'newest open ask' is
 * never a safe guess") above a condition that did not implement it: they asked whether the GUESS
 * happened to be a lane acceptance, not whether the ACT being sent was a verdict that must not be
 * guessed. So the guard fired only when the newest open ask was itself a lane acceptance, and
 * stayed silent in every other arrangement of the same ambiguity.
 *
 * Measured on 2026-08-15, clearing a five-lane review queue: four accepts bound to guardian
 * `daemon_down` asks. Two of those lanes had a correct acceptance ask waiting and it was passed
 * over. Four guardian outage asks now read as answered by verdicts about unrelated pull requests,
 * and not one of the four lanes left `awaiting_acceptance`.
 */
const ask = (id: string, over: Partial<AutoTargetable> = {}): AutoTargetable => ({
  id,
  act: 'ask',
  from: 'guardian',
  ts: Number(id.slice(-4)),
  meta: null,
  ...over,
});
const laneAsk = (id: string, lane: string, over: Partial<AutoTargetable> = {}): AutoTargetable =>
  ask(id, { from: 'wanderer', meta: { lane_review: { lane } }, ...over });

/** Newest first, the order every caller hands in. */
const newestFirst = (...m: AutoTargetable[]): AutoTargetable[] =>
  [...m].sort((a, b) => b.ts - a.ts);

describe('chooseAutoTarget', () => {
  it('refuses when there is nothing open — and says how to name one', () => {
    const got = chooseAutoTarget([], 'accept');
    expect(got.kind).toBe('none');
    if (got.kind === 'none') expect(got.message).toMatch(/reply_to/);
  });

  it('binds the single open ask — ADR 067 convenience is the whole point, and it survives', () => {
    const only = ask('0001');
    const got = chooseAutoTarget([only], 'accept');
    expect(got.kind).toBe('target');
    if (got.kind === 'target') expect(got.target.id).toBe('0001');
  });

  it('binds a single open ask even when it IS a lane acceptance — one candidate is not a guess', () => {
    const got = chooseAutoTarget([laneAsk('0002', 'LANE-A')], 'accept');
    expect(got.kind).toBe('target');
  });

  // THE LANE'S DECLARED FALSIFIER. Two or more open asks, the newest NOT a lane acceptance.
  // Before this fix the accept bound silently to the newest; it must refuse and name the choices.
  it('REFUSES when several are open and the newest is not a lane acceptance (the live defect)', () => {
    const open = newestFirst(ask('0009'), laneAsk('0003', 'LANE-A'));
    const got = chooseAutoTarget(open, 'accept');
    expect(got.kind).toBe('refuse');
    if (got.kind === 'refuse') {
      // The correct target must be offered, not buried: it is the one the seat actually reviewed.
      expect(got.message).toContain('reply_to:0003');
      expect(got.message).toContain('LANE-A');
    }
  });

  it('still refuses when several are open and the newest IS a lane acceptance (no regression)', () => {
    const open = newestFirst(laneAsk('0009', 'LANE-B'), ask('0003'));
    expect(chooseAutoTarget(open, 'accept').kind).toBe('refuse');
  });

  it('KEEPS ADR 067 convenience when no lane acceptance is open at all', () => {
    // Deliberate, and load-bearing: answering the wrong request_help is recoverable, so the
    // convenience earns its place where nothing unrecoverable is at stake. This is the line the
    // first draft of this fix crossed — it refused on any ambiguity, and the adapter's own tests
    // caught it. The trigger is an unrecoverable candidate, not ambiguity as such.
    const open = newestFirst(ask('0009'), ask('0003'));
    const got = chooseAutoTarget(open, 'accept');
    expect(got.kind).toBe('target');
    if (got.kind === 'target') expect(got.target.id).toBe('0009');
  });

  it('refuses a `decline` on the same terms — a refusal lands on a named artifact too', () => {
    const open = newestFirst(ask('0009'), laneAsk('0003', 'LANE-A'));
    expect(chooseAutoTarget(open, 'decline').kind).toBe('refuse');
  });

  it("speaks each surface's own flag syntax — one rule, two conventions", () => {
    const open = newestFirst(ask('0009'), laneAsk('0003', 'LANE-A'));
    const cli = chooseAutoTarget(open, 'accept', CLI_REPLY_TO_STYLE);
    expect(cli.kind).toBe('refuse');
    if (cli.kind === 'refuse') {
      expect(cli.message).toContain('--reply-to 0003');
      expect(cli.message).not.toContain('reply_to:');
    }
    const none = chooseAutoTarget([], 'accept', CLI_REPLY_TO_STYLE);
    if (none.kind === 'none') expect(none.message).toContain('musterd inbox');
  });

  it('caps the offered list so a seat with a deep queue still gets a readable refusal', () => {
    const many = newestFirst(
      laneAsk('0500', 'LANE-Z'),
      ...Array.from({ length: 19 }, (_, i) => ask(String(1000 + i))),
    );
    const got = chooseAutoTarget(many, 'accept');
    expect(got.kind).toBe('refuse');
    if (got.kind === 'refuse') {
      expect(got.message.split('\n').length).toBeLessThanOrEqual(7);
      // …but the count is honest about how many there really are.
      expect(got.message).toContain('20');
    }
  });
});

/**
 * Lane 01M3TB3DA2 (ADR 276:75 follow-up): whose action an `ask` is. Before this, every seat
 * treated every ask as its own — so an un-named `accept` from any agent could bind to a
 * team-addressed to-human ask (ADR 147) and close it. An ask concerns me when it is directed to me,
 * when its eligible set names me (ADR 254), or when it is team-addressed AND I am an admin — and
 * agents are never admins, so the third arm is the ADR 147 admin path and nothing wider.
 */
describe('askConcernsMe', () => {
  const ask = (to: { kind: string; name?: string }, meta: Record<string, unknown> | null = null) =>
    ({ act: 'ask', to, meta }) as never;

  it('a directed ask concerns its addressee and nobody else', () => {
    expect(askConcernsMe(ask({ kind: 'member', name: 'nick' }), { name: 'nick' })).toBe(true);
    expect(askConcernsMe(ask({ kind: 'member', name: 'nick' }), { name: 'dolly' })).toBe(false);
    expect(
      askConcernsMe(ask({ kind: 'member', name: 'nick' }), { name: 'dolly', admin: true }),
    ).toBe(false);
  });

  it('an eligible-set ask concerns each named seat', () => {
    const env = ask({ kind: 'team' }, { eligible: ['dolly', 'izzo'] });
    expect(askConcernsMe(env, { name: 'dolly' })).toBe(true);
    expect(askConcernsMe(env, { name: 'ryder' })).toBe(false);
  });

  it('a team-addressed ask concerns admins only — never a non-admin, never by default', () => {
    const env = ask({ kind: 'team' });
    expect(askConcernsMe(env, { name: 'nick', admin: true })).toBe(true);
    expect(askConcernsMe(env, { name: 'dana', admin: false })).toBe(false);
    expect(askConcernsMe(env, { name: 'dolly' })).toBe(false);
  });

  it('a non-ask is not its business', () => {
    expect(
      askConcernsMe({ act: 'request_help', to: { kind: 'team' }, meta: null } as never, {
        name: 'x',
        admin: true,
      }),
    ).toBe(false);
  });
});

/**
 * Lane 01M3TB3C0D: a root `message` to a member who has an open directed act waiting on the sender
 * leaves that act open and unjoinable (97% of agent→member prose is a root, measured 2026-10-03).
 * The send ack suggests the thread — warn, never block.
 */
describe('threadHintFor', () => {
  const open = (over: Record<string, unknown>) =>
    ({
      id: 'x',
      act: 'ask',
      from: 'nick',
      to: { kind: 'member', name: 'dolly' },
      ts: 1,
      thread: null,
      ...over,
    }) as never;

  it('names the newest open act FROM the recipient as the thread to reply in', () => {
    const hint = threadHintFor(
      [open({ id: 'a2', ts: 2, act: 'request_help' }), open({ id: 'a1', ts: 1 })],
      'nick',
    );
    expect(hint).toEqual({ id: 'a2', act: 'request_help', thread: 'a2' });
  });

  it("uses the act's own thread root when it is a reply", () => {
    expect(threadHintFor([open({ id: 'a3', ts: 3, thread: 'root1' })], 'nick')).toEqual({
      id: 'a3',
      act: 'ask',
      thread: 'root1',
    });
  });

  it('is silent when nothing open is from that member', () => {
    expect(threadHintFor([open({ from: 'izzo' })], 'nick')).toBeNull();
    expect(threadHintFor([], 'nick')).toBeNull();
  });
});
