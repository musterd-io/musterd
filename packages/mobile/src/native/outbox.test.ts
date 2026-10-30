import { describe, expect, it, vi } from 'vitest';
import { flushOutbox, sendOrKeep, type Outgoing, type OutboxStorage } from './outbox';

function memory(initial: Outgoing[] = []): OutboxStorage & { value: () => Outgoing[] } {
  let raw: string | null = JSON.stringify(initial);
  return {
    get: async () => raw,
    set: async (v) => {
      raw = v;
    },
    value: () => JSON.parse(raw ?? '[]') as Outgoing[],
  };
}

const item = (ref: string, expires_at = 10_000): Outgoing => ({
  url: 'https://relay.example/app/revive/callback',
  body: `{"ref":"${ref}"}`,
  ref,
  expires_at,
});

const status = (...codes: number[]) => {
  const queue = [...codes];
  return vi.fn(
    async () => new Response('', { status: queue.shift() ?? 500 }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
};

describe('sendOrKeep', () => {
  it('sends on the first try and keeps nothing', async () => {
    const storage = memory();
    expect(await sendOrKeep(item('a'), { fetchImpl: status(202), storage, pauseMs: 0 })).toBe(true);
    expect(storage.value()).toEqual([]);
  });

  it('tries a second time before giving up', async () => {
    const storage = memory();
    const fetchImpl = status(503, 202);
    expect(await sendOrKeep(item('a'), { fetchImpl, storage, pauseMs: 0 })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(storage.value()).toEqual([]);
  });

  it('keeps the sealed body when both tries fail, once per ask', async () => {
    const storage = memory([item('a')]);
    expect(await sendOrKeep(item('a'), { fetchImpl: status(503, 503), storage, pauseMs: 0 })).toBe(
      false,
    );
    expect(storage.value()).toEqual([item('a')]);
  });
});

describe('flushOutbox', () => {
  it('re-sends what waits, drops what the relay took and what expired', async () => {
    const storage = memory([item('sent'), item('still'), item('old', 50)]);
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response('', { status: String(init?.body).includes('sent') ? 202 : 503 }),
    ) as unknown as typeof fetch;
    expect(await flushOutbox({ fetchImpl, storage, now: 100 })).toBe(1);
    expect(storage.value().map((o) => o.ref)).toEqual(['still']);
  });

  it('says nothing waits when the outbox is empty', async () => {
    expect(await flushOutbox({ fetchImpl: status(), storage: memory(), now: 100 })).toBe(0);
  });
});
