import type { DoorbellRecord } from '@musterd/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { setSinkPostForTests } from './pinnedPost.js';
import { postDoorbellWebhook, WEBHOOK_POST_TIMEOUT_MS } from './webhook.js';

const record: DoorbellRecord = {
  team: 'revive',
  from: 'dolly',
  act: 'ask',
  species: 'approve',
  tier: 'blocking',
  act_id: '01X',
  answer_path: '/live?act=01X',
};

describe('postDoorbellWebhook (ADR 443)', () => {
  afterEach(() => setSinkPostForTests(null));

  it('POSTs the record as-is through the pinned transport, with the sink timeout', async () => {
    const seen: { url: string; body: string; timeoutMs: number }[] = [];
    setSinkPostForTests(async (url, body, timeoutMs) => {
      seen.push({ url, body, timeoutMs });
      return { ok: true, status: 204 };
    });
    expect(await postDoorbellWebhook('https://ntfy.sh/t', record)).toEqual({
      ok: true,
      status: 204,
    });
    expect(seen[0]!.url).toBe('https://ntfy.sh/t');
    expect(JSON.parse(seen[0]!.body)).toEqual(record);
    expect(seen[0]!.timeoutMs).toBe(WEBHOOK_POST_TIMEOUT_MS);
  });

  it('passes the transport result through: a non-2xx is ok:false with its status, a failure has none', async () => {
    setSinkPostForTests(async () => ({ ok: false, status: 302 }));
    expect(await postDoorbellWebhook('https://ntfy.sh/t', record)).toEqual({
      ok: false,
      status: 302,
    });
    setSinkPostForTests(async () => ({ ok: false }));
    expect(await postDoorbellWebhook('https://ntfy.sh/t', record)).toEqual({ ok: false });
  });
});
