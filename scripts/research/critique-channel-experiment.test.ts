import { describe, expect, it } from 'vitest';
import {
  armFor,
  chatCritiques,
  claudeTurns,
  codexTurns,
  seatFromCwd,
  summarise,
  type Critique,
} from './critique-channel-experiment.js';

/**
 * ADR 476's channel experiment. This file guards the ways the comparison goes quietly unfair: a
 * critique counted in an arm its day did not assign, a tool result read as the human speaking, a
 * chat reply scored on narration instead of the answer, and an unanswered critique scored as
 * unverified.
 */
const day = (d: number, h = 12) => new Date(2026, 9, d, h).getTime(); // October, local time
const WS = '/Users/nick/musterd/revive/agents/dolly';

describe('armFor', () => {
  it('even local day → challenge, odd → chat', () => {
    expect(armFor(day(2))).toBe('challenge');
    expect(armFor(day(1))).toBe('chat');
    expect(armFor(day(3, 23))).toBe('chat');
  });
});

describe('seatFromCwd', () => {
  it('reads the seat from a team workspace path, or a directory inside one', () => {
    expect(seatFromCwd(WS, 'revive')).toBe('dolly');
    expect(seatFromCwd(`${WS}/`, 'revive')).toBe('dolly');
    expect(seatFromCwd(`${WS}/packages/cli`, 'revive')).toBe('dolly');
    expect(seatFromCwd('/Users/nick/agents-dolly', 'revive')).toBeNull();
    expect(seatFromCwd('/Users/nick/musterd/other/agents/dolly', 'revive')).toBeNull();
    expect(seatFromCwd(undefined, 'revive')).toBeNull();
  });
});

describe('summarise', () => {
  const c = (over: Partial<Critique>): Critique => ({
    arm: 'challenge',
    seat: 'dolly',
    ts: day(2),
    reply: 'ok',
    ...over,
  });

  it('scores both arms with the same namesCheck rule', () => {
    const r = summarise([
      c({ reply: 'checked: `pnpm test` passes' }),
      c({ reply: "You're right." }),
      c({ arm: 'chat', ts: day(1), reply: 'see http.ts:120' }),
    ]);
    expect(r.arms.challenge).toEqual({ named: 1, answered: 2, unanswered: 0 });
    expect(r.arms.chat).toEqual({ named: 1, answered: 1, unanswered: 0 });
  });

  it('an unanswered critique is unanswered, not unverified', () => {
    const r = summarise([c({ reply: null })]);
    expect(r.arms.challenge).toEqual({ named: 0, answered: 0, unanswered: 1 });
  });

  it('a critique sent in the wrong arm for its day is off-protocol and excluded', () => {
    const r = summarise([c({ ts: day(1) }), c({ arm: 'chat', ts: day(2) })]);
    expect(r.offProtocol).toBe(2);
    expect(r.arms.challenge.answered + r.arms.chat.answered).toBe(0);
    expect(r.bySeat).toEqual([]);
  });
});

describe('claudeTurns → chatCritiques', () => {
  const rec = (o: object) => JSON.stringify(o);
  const lines = [
    rec({
      type: 'user',
      timestamp: new Date(day(1)).toISOString(),
      cwd: WS,
      message: { content: 'crit: the cap is wrong' },
    }),
    rec({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Checking now.' }, { type: 'tool_use' }] },
    }),
    rec({
      type: 'user',
      cwd: WS,
      message: { content: [{ type: 'tool_result', content: 'crit: not the human' }] },
    }),
    rec({
      type: 'user',
      isMeta: true,
      cwd: WS,
      message: { content: 'crit: a hook, not the human' },
    }),
    rec({
      type: 'user',
      isSidechain: true,
      cwd: WS,
      message: { content: 'crit: a subagent prompt' },
    }),
    rec({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Verified in `cap.ts` — you are right.' }] },
    }),
    rec({
      type: 'user',
      timestamp: new Date(day(1, 13)).toISOString(),
      cwd: WS,
      message: { content: 'thanks' },
    }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'np' }] } }),
    'not json',
  ];

  it('pairs a crit: prompt with the last assistant text of its turn, skipping tool results and meta', () => {
    const got = chatCritiques(claudeTurns(lines), 'revive', day(1, 0), day(9, 0));
    expect(got).toEqual([
      { arm: 'chat', seat: 'dolly', ts: day(1), reply: 'Verified in `cap.ts` — you are right.' },
    ]);
  });

  it('drops prompts outside the window or outside a seat workspace', () => {
    expect(chatCritiques(claudeTurns(lines), 'revive', day(2, 0), day(9, 0))).toEqual([]);
    expect(chatCritiques(claudeTurns(lines), 'other', day(1, 0), day(9, 0))).toEqual([]);
  });

  it('falls back to the project-dir seat when the recorded cwd is not a workspace', () => {
    const old = lines.map((l) => l.replaceAll(WS, '/Users/nick/agents-dolly'));
    expect(chatCritiques(claudeTurns(old), 'revive', 0, day(9), 'dolly')[0]?.seat).toBe('dolly');
  });

  it('a crit: prompt whose turn produced no text is unanswered', () => {
    const got = chatCritiques(claudeTurns(lines.slice(0, 1)), 'revive', 0, day(9));
    expect(got[0]?.reply).toBeNull();
  });
});

describe('codexTurns → chatCritiques', () => {
  const rec = (o: object) => JSON.stringify(o);
  it('reads the cwd from turn context and pairs user/assistant messages', () => {
    const lines = [
      rec({ type: 'turn_context', payload: { cwd: WS } }),
      rec({
        type: 'response_item',
        timestamp: new Date(day(3)).toISOString(),
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'CRIT: wrong port' }],
        },
      }),
      rec({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Port is 4849 per #1790.' }],
        },
      }),
    ];
    expect(chatCritiques(codexTurns(lines), 'revive', 0, day(9))).toEqual([
      { arm: 'chat', seat: 'dolly', ts: day(3), reply: 'Port is 4849 per #1790.' },
    ]);
  });
});
