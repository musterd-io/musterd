import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index.js';

/**
 * The callback route's missing-config refusals (ADR 668 §1/§2): a Slack-shaped callback is
 * forwarded only with a verified signature and a mapping. Each test stops before the Durable
 * Object when refused; the forwarded case uses a stub namespace that records the call.
 */

function slackBody(teamId = 'T1'): string {
  return `payload=${encodeURIComponent(
    JSON.stringify({
      team: { id: teamId },
      user: { id: 'U1' },
      actions: [{ action_id: 'musterd_approve', value: 'tok' }],
    }),
  )}`;
}

async function sign(secret: string, body: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${body}`));
  return 'v0=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function env(partial: Partial<Env>): { env: Env; forwarded: ReturnType<typeof vi.fn> } {
  const forwarded = vi.fn(async () => new Response('forwarded', { status: 200 }));
  const full = {
    AWAY_RELAY: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: forwarded }),
    },
    ...partial,
  } as unknown as Env;
  return { env: full, forwarded };
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://relay.example/callback/revive/ask-1', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
}

describe('away-relay callback route: Slack fails closed (ADR 668)', () => {
  it('rejects an unconfigured callback format', async () => {
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }),
    });
    const res = await worker.fetch(post(JSON.stringify({ token: 'tok', decision: 'approve' })), e);
    expect(res.status).toBe(400);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('refuses a Slack callback when the signing secret is unset — never forwards it', async () => {
    const { env: e, forwarded } = env({ SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }) });
    const res = await worker.fetch(post(slackBody()), e);
    expect(res.status).toBe(503);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('refuses a signed Slack callback when the team map is unset', async () => {
    const body = slackBody();
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({ SLACK_SIGNING_SECRET: 'sekret' });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(503);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('refuses a Slack callback whose team maps to a different slug', async () => {
    const body = slackBody('T2');
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive', T2: 'other' }),
    });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(403);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('forwards a signed, mapped Slack callback to the team object', async () => {
    const body = slackBody();
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }),
    });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });

  it('verifies a Slack form payload after another form field', async () => {
    const body = `extra=x&${slackBody()}`;
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }),
    });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });

  it('treats a Slack signature header as a Slack signal even for a non-form body', async () => {
    const body = JSON.stringify({ token: 'tok', decision: 'approve' });
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }),
    });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(403);
    expect(forwarded).not.toHaveBeenCalled();
  });
});
