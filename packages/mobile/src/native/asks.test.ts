import {
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { AppCallbackSchema } from '@musterd/protocol/app-channel';
import { canonicalJson } from '@musterd/protocol/approval';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAsks, markShown, requestRedelivery, settledRefs } from './asks';
import type { PairingPin } from './pairingPin';
import { phoneKeys } from './phoneKeys';
import type { PushRoute } from './push';

vi.mock('./phoneKeys', () => ({
  phoneKeys: {
    open: vi.fn(),
    verifyEd25519: vi.fn(),
    deliveredPushes: vi.fn(),
    clearDelivered: vi.fn(async () => undefined),
    knownAsks: vi.fn(() => []),
    markSeen: vi.fn(),
    forgetAsks: vi.fn(),
  },
  phoneKeysErrorCode: () => null,
}));

const identity = generateKeyPairSync('ed25519');
const PINNED = identity.publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(12)
  .toString('base64url');
const FAR = 4_102_444_800_000;

const pin: PairingPin = {
  v: 1,
  identity: PINNED,
  receive: 'C'.repeat(87),
  relay: 'https://relay.example',
  team: 'revive',
  binding: 'bind-1',
};

function route(ref: string, expires_at = FAR): PushRoute {
  return { team: 'revive', binding: 'bind-1', ref, expires_at };
}

function ask(ref: string, ts: number, expires_at = FAR, over: Record<string, unknown> = {}) {
  return {
    v: 1,
    kind: 'ask',
    team: 'revive',
    binding: 'bind-1',
    ask: {
      id: ref,
      from: 'slippy',
      from_kind: 'agent',
      body: `ask ${ref}`,
      tier: 'standard',
      species: null,
      action_class: 'advisory',
      ts,
    },
    token: `tok-${ref}`,
    nonce: `nonce-${ref}-000000000`,
    expires_at,
    ...over,
  };
}

/** A sealed body is the AAD itself here: the mocked `open` reads the route back out of it. */
function sealedFor(r: PushRoute) {
  return { v: 1 as const, enc: 'AA', ct: Buffer.from(canonicalJson(r)).toString('base64url') };
}

function inner(body: unknown, r: PushRoute): string {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const signed = Buffer.concat([
    Buffer.from(`musterd-app/v1 signed\n${canonicalJson(r)}\n`, 'utf8'),
    payload,
  ]);
  return JSON.stringify({
    p: payload.toString('base64url'),
    s: cryptoSign(null, signed, identity.privateKey).toString('base64url'),
  });
}

/** What the daemon has live, by ref; anything else fetches as 404. */
let live: Map<string, unknown>;
const bodies = new Map<string, unknown>();

function notification(id: string, r: PushRoute, deliveredAt: number, body?: unknown) {
  if (body) bodies.set(canonicalJson(r), body);
  return {
    id,
    deliveredAt,
    userInfo: JSON.stringify({
      musterd: { v: 1, ...r, ...(body ? { sealed: sealedFor(r) } : {}) },
    }),
  };
}

const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'POST') return new Response('accepted', { status: 202 });
  const ref = decodeURIComponent(String(url).split('/').pop()!);
  const body = live.get(ref);
  if (!body) return new Response('no', { status: 404 });
  const r = route(ref, (body as { expires_at: number }).expires_at);
  bodies.set(canonicalJson(r), body);
  return Response.json({ ...r, sealed: sealedFor(r) });
}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  live = new Map();
  bodies.clear();
  vi.mocked(phoneKeys.open).mockImplementation(async ({ sealed, aad }) => {
    if (sealed.ct !== aad) throw new Error('sealed-open-failed');
    const json = Buffer.from(aad, 'base64url').toString('utf8');
    const body = bodies.get(json);
    if (!body) throw new Error('sealed-open-failed');
    return inner(body, JSON.parse(json));
  });
  vi.mocked(phoneKeys.verifyEd25519).mockImplementation(async ({ publicKey, message, signature }) =>
    cryptoVerify(
      null,
      Buffer.from(message, 'base64url'),
      createPublicKey({
        key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(publicKey, 'base64url'),
        ]),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(signature, 'base64url'),
    ),
  );
});

describe('loadAsks', () => {
  it('lists only what the daemon still has live, newest first, one row per ask', async () => {
    live.set('a1', ask('a1', 10));
    live.set('a2', ask('a2', 20));
    vi.mocked(phoneKeys.deliveredPushes).mockResolvedValue([
      notification('n1', route('a1'), 1, ask('a1', 10)),
      notification('n2', route('a1'), 2, ask('a1', 10)),
      notification('n3', route('a2'), 3),
      // Answered on /live: its notification lingers, the daemon no longer has it.
      notification('n4', route('gone'), 4, ask('gone', 30)),
    ]);
    const view = await loadAsks({ pin, now: 1, fetchImpl });
    expect(view.asks.map((e) => e.delivery.ask.id)).toEqual(['a2', 'a1']);
    expect(view.held).toBeNull();
    // One fetch per ref, never two for the same ask.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // The settled ask leaves Notification Center and the phone's list; the live ones stay.
    expect(phoneKeys.clearDelivered).toHaveBeenCalledWith(['gone']);
    expect(phoneKeys.forgetAsks).toHaveBeenCalledWith(['gone']);
  });

  it('lists an ask from the phone’s own record once its notification is gone (ADR 772)', async () => {
    live.set('a1', ask('a1', 10));
    live.set('a2', ask('a2', 20));
    vi.mocked(phoneKeys.deliveredPushes).mockResolvedValue([notification('n1', route('a1'), 1)]);
    vi.mocked(phoneKeys.knownAsks).mockReturnValueOnce([
      { ...route('a1'), seen: true },
      // Tapped or cleared: no notification left, still open.
      { ...route('a2'), seen: true },
      // Another binding's record is not this phone's to list.
      { ...route('a3'), binding: 'other', seen: false },
    ]);
    const view = await loadAsks({ pin, now: 1, fetchImpl });
    expect(view.asks.map((e) => e.delivery.ask.id)).toEqual(['a2', 'a1']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the notifications of an ask it could not reach: it may still be open', async () => {
    live.set('a1', ask('a1', 10));
    vi.mocked(phoneKeys.deliveredPushes).mockResolvedValue([
      notification('n1', route('a1'), 1),
      notification('n2', route('asleep'), 2),
    ]);
    const asleep = vi.fn(async (url: string, init?: RequestInit) =>
      String(url).endsWith('/asleep') ? new Response('', { status: 503 }) : fetchImpl(url, init),
    ) as unknown as typeof fetch;
    const view = await loadAsks({ pin, now: 1, fetchImpl: asleep });
    expect(view.asks.map((e) => e.delivery.ask.id)).toEqual(['a1']);
    expect(phoneKeys.clearDelivered).not.toHaveBeenCalled();
  });

  it('shows the newest held summary inside its hour, and fetches nothing for it', async () => {
    const held = (count: number, until: number) => ({
      v: 1,
      kind: 'held',
      team: 'revive',
      binding: 'bind-1',
      count,
      until,
    });
    vi.mocked(phoneKeys.deliveredPushes).mockResolvedValue([
      notification('h1', route('held-1'), 1, held(2, 100)),
      notification('h2', route('held-2'), 2, held(3, 100)),
    ]);
    expect((await loadAsks({ pin, now: 50, fetchImpl })).held).toEqual({ count: 3, until: 100 });
    expect((await loadAsks({ pin, now: 100, fetchImpl })).held).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores notifications for another binding, and a body the daemon did not sign', async () => {
    live.set('a1', ask('a1', 10));
    vi.mocked(phoneKeys.deliveredPushes).mockResolvedValue([
      notification('n1', { ...route('x'), binding: 'other' }, 1),
      notification('n2', route('a1'), 2),
    ]);
    vi.mocked(phoneKeys.verifyEd25519).mockResolvedValue(false);
    expect((await loadAsks({ pin, now: 1, fetchImpl })).asks).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('drops a fetched ask whose id is not the ref it was fetched by', async () => {
    live.set('a1', ask('swapped', 10));
    vi.mocked(phoneKeys.deliveredPushes).mockResolvedValue([notification('n1', route('a1'), 1)]);
    expect((await loadAsks({ pin, now: 1, fetchImpl })).asks).toEqual([]);
  });
});

describe('markShown', () => {
  it('marks the shown asks seen and clears their notifications', async () => {
    await markShown(['a1', 'a2']);
    expect(phoneKeys.markSeen).toHaveBeenCalledWith(['a1', 'a2']);
    expect(phoneKeys.clearDelivered).toHaveBeenCalledWith(['a1', 'a2']);
  });

  it('does nothing for an empty list', async () => {
    await markShown([]);
    expect(phoneKeys.markSeen).not.toHaveBeenCalled();
  });
});

describe('settledRefs', () => {
  it('names only the refs the daemon called gone', () => {
    expect(
      settledRefs([
        { ref: 'a', got: { miss: 'gone' } },
        { ref: 'b', got: { miss: 'unreachable' } },
      ]),
    ).toEqual(['a']);
  });
});

describe('requestRedelivery', () => {
  it('posts the redeliver callback for this binding', async () => {
    expect(await requestRedelivery({ pin, fetchImpl })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://relay.example/app/revive/callback');
    expect(AppCallbackSchema.parse(JSON.parse(String(init?.body)))).toEqual({
      app: 1,
      kind: 'redeliver',
      binding: 'bind-1',
    });
  });

  it('sends nothing before the phone knows its binding', async () => {
    const { binding: _binding, ...unbound } = pin;
    expect(await requestRedelivery({ pin: unbound, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends one request a minute, because each re-pushes every pending ask', async () => {
    const at = 5_000_000_000_000;
    expect(await requestRedelivery({ pin, fetchImpl, now: at })).toBe(true);
    expect(await requestRedelivery({ pin, fetchImpl, now: at + 30_000 })).toBe(false);
    expect(await requestRedelivery({ pin, fetchImpl, now: at + 61_000 })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
