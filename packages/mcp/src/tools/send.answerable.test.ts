import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { answerableFor } from './send.js';

/**
 * Lane 01M3TB3DA2 — parity with the CLI: an un-named `accept` from an agent must never bind to a
 * team-addressed to-human ask (ADR 147). An ask is answerable by me when it is directed to me, its
 * eligible set names me, or it is team-addressed and I am an admin.
 */
const env = (over: Partial<Envelope> & { id: string }): Envelope =>
  ({
    team: 'dawn',
    from: 'nick',
    to: { kind: 'team' },
    act: 'ask',
    body: '',
    ts: 1,
    thread: null,
    meta: { species: 'approve', tier: 'standard' },
    ...over,
  }) as Envelope;

describe('answerableFor (MCP auto-target candidates)', () => {
  it('an agent never sees a team-addressed ask as its own', () => {
    expect(answerableFor([env({ id: 'a1' })], 'dolly', false)).toEqual([]);
  });

  it('an admin does', () => {
    expect(answerableFor([env({ id: 'a1' })], 'nick', true).map((m) => m.id)).toEqual(['a1']);
  });

  it('a directed ask and an eligible-set ask reach the named seat whatever its rank', () => {
    const rows = [
      env({ id: 'd1', to: { kind: 'member', name: 'dolly' } }),
      env({
        id: 'e1',
        meta: { species: 'consult', tier: 'advisory', eligible: ['dolly', 'izzo'] },
      }),
      env({ id: 'e2', meta: { species: 'consult', tier: 'advisory', eligible: ['izzo'] } }),
    ];
    expect(
      answerableFor(rows, 'dolly', false)
        .map((m) => m.id)
        .sort(),
    ).toEqual(['d1', 'e1']);
  });

  it('request_help stays open to anyone, and a directed handoff to its addressee', () => {
    const rows = [
      env({ id: 'h1', act: 'request_help', meta: null }),
      env({ id: 'h2', act: 'handoff', to: { kind: 'member', name: 'dolly' }, meta: null }),
      env({ id: 'h3', act: 'handoff', to: { kind: 'member', name: 'izzo' }, meta: null }),
    ];
    expect(
      answerableFor(rows, 'dolly', false)
        .map((m) => m.id)
        .sort(),
    ).toEqual(['h1', 'h2']);
  });
});
