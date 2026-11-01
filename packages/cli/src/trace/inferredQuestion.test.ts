import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Binding, Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../client.js';
import { catchTurnEnd, readRaised } from './inferredQuestion.js';

const binding = {
  server: 'http://127.0.0.1:4849',
  team: 'revive',
  claim: { mode: 'seat', name: 'ryder' },
} as unknown as Binding;

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inferred-'));
  mkdirSync(join(dir, '.musterd'));
  return dir;
}

function fakeClient(refuse = false) {
  const sent: Envelope[] = [];
  const client = {
    send: async (_slug: string, env: Envelope) => {
      if (refuse) throw new Error('question_already_open');
      sent.push(env);
      return {};
    },
  } as unknown as HttpClient;
  return { client, sent };
}

const stop = (msg: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 's1',
    last_assistant_message: msg,
    ...extra,
  });

describe('catchTurnEnd (ADR 781)', () => {
  it('raises a turn that ends on a question as an inferred team question, and remembers it', async () => {
    const dir = workspace();
    const { client, sent } = fakeClient();
    await catchTurnEnd(stop('Merged.\n\nWant me to start on 3a?'), { binding, dir, client });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      act: 'ask',
      from: 'ryder',
      to: { kind: 'team' },
      body: 'Merged.\n\nWant me to start on 3a?',
      meta: {
        species: 'consult',
        question: {
          text: 'Want me to start on 3a?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          audience: 'team',
          blocking: false,
          inferred: true,
        },
      },
    });
    expect(readRaised(dir)).toEqual({ id: sent[0]!.id, session_id: 's1' });
  });

  it('the next prompt in that session withdraws it; another session leaves it', async () => {
    const dir = workspace();
    const { client, sent } = fakeClient();
    await catchTurnEnd(stop('Shall I deploy?'), { binding, dir, client });
    const qid = sent[0]!.id;
    const prompt = (session: string) =>
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'yes' });
    await catchTurnEnd(prompt('other'), { binding, dir, client });
    expect(sent).toHaveLength(1);
    await catchTurnEnd(prompt('s1'), { binding, dir, client });
    expect(sent[1]).toMatchObject({
      act: 'resolve',
      thread: qid,
      meta: { withdrawn: 'answered_in_session' },
    });
    expect(readRaised(dir)).toBeNull();
    await catchTurnEnd(prompt('s1'), { binding, dir, client });
    expect(sent).toHaveLength(2);
  });

  it('raises nothing for a statement, a re-entered Stop, a refusal, or no seat', async () => {
    const dir = workspace();
    const { client, sent } = fakeClient();
    await catchTurnEnd(stop('Done. Deployed.'), { binding, dir, client });
    await catchTurnEnd(stop('Want me to?', { stop_hook_active: true }), { binding, dir, client });
    const unseated = { ...binding, claim: undefined } as unknown as Binding;
    await catchTurnEnd(stop('Want me to start?'), { binding: unseated, dir, client });
    expect(sent).toHaveLength(0);
    // The daemon refusing (an explicit question is open) leaves nothing to withdraw later.
    const refusing = fakeClient(true);
    await catchTurnEnd(stop('Want me to start?'), { binding, dir, client: refusing.client });
    expect(readRaised(dir)).toBeNull();
  });
});
