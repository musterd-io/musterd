import { describe, expect, it } from 'vitest';
import { registerSend } from './send.js';

/**
 * ADR 684: an ask that offers its options as prose reaches the human on /live as Approve / Deny. The
 * sender is told in the send reply, prose and structured, while it can still re-send as option lines.
 */
describe('team_send names a prose choice on the ask it sends', () => {
  const config = { team: 'dawn', member: 'Ada', surface: 'claude-code' };
  function send() {
    const handlers: Record<string, (a: any) => Promise<any>> = {};
    const server = {
      registerTool: (name: string, _s: unknown, h: (a: any) => Promise<any>) => {
        handlers[name] = h;
      },
    };
    const client: any = {
      joined: true,
      holdsSeat: true,
      member: 'Ada',
      markSeen: () => undefined,
      sendEnvelope: async () => undefined,
    };
    registerSend(server as any, client, config as any);
    return handlers['team_send']!;
  }
  const meta = { species: 'consult', tier: 'standard' };

  it('a choice written as one question gets the notice, in prose and structuredContent', async () => {
    const res = await send()({
      to: 'nick',
      act: 'ask',
      meta,
      body: 'Which account should hold the key: a new GCP project, an existing one you name, or AWS?',
    });
    expect(res.structuredContent.prose_choice_notice).toMatch(/Approve \/ Deny/);
    expect(res.content[0].text).toContain(res.structuredContent.prose_choice_notice);
  });

  it('options already on their own lines get no notice', async () => {
    const res = await send()({
      to: 'nick',
      act: 'ask',
      meta,
      body: 'Which account should hold the key?\nA. a new GCP project\nB. AWS',
    });
    expect(res.structuredContent.prose_choice_notice).toBeUndefined();
  });

  it('a message that reads like a choice is not an ask, so it gets nothing', async () => {
    const res = await send()({
      to: 'nick',
      act: 'message',
      body: 'Should I revert or patch forward?',
    });
    expect(res.structuredContent.prose_choice_notice).toBeUndefined();
  });
});
