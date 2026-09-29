import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  CimdResolverCapacityError,
  createCimdResolver,
  createPinnedHttpsRequest,
  isCimdClientId,
} from './cimd.js';

const clientId = 'https://chatgpt.com/oauth/client.json';
const metadata = {
  client_id: clientId,
  client_name: 'ChatGPT',
  redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
};

function dependencies(input?: {
  answers?: Array<{ address: string; family: 4 | 6 }>;
  response?: { statusCode: number; contentType: string; body: string };
}) {
  const lookup = vi.fn(async () => input?.answers ?? [{ address: '8.8.8.8', family: 4 as const }]);
  const request = vi.fn(
    async () =>
      input?.response ?? {
        statusCode: 200,
        contentType: 'application/json',
        body: JSON.stringify(metadata),
      },
  );
  return {
    deps: { lookup, request, now: () => 1_000 },
    lookup,
    request,
  };
}

describe('CIMD URL and address boundary (ADR 470)', () => {
  it('accepts the published ChatGPT client URL shape and rejects unsafe URL syntax before DNS', async () => {
    expect(isCimdClientId(clientId)).toBe(true);
    const invalid = [
      `https://client.example/${'x'.repeat(2_050)}`,
      'http://client.example/oauth/client.json',
      'https://client.example',
      'https://client.example/./client.json',
      'https://client.example/%2e%2e/client.json',
      'https://client.example/%2E/client.json',
      'https://user:password@client.example/oauth/client.json',
      'https://client.example:444/oauth/client.json',
      'https://client.example/oauth/client.json?',
      'https://client.example/oauth/client.json#',
    ];

    for (const url of invalid) {
      const { deps, lookup, request } = dependencies();
      expect(isCimdClientId(url)).toBe(false);
      await expect(createCimdResolver(deps)(url)).rejects.toThrow();
      expect(lookup).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('rejects a DNS answer set containing any non-public or special-use address', async () => {
    const unsafe = [
      '0.1.2.3',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '240.0.0.1',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '2001:db8::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
    ];

    for (const address of unsafe) {
      const family = address.includes(':') ? 6 : 4;
      const { deps, request } = dependencies({ answers: [{ address, family }] });
      await expect(createCimdResolver(deps)(clientId)).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    }

    const mixed = dependencies({
      answers: [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.2', family: 4 },
      ],
    });
    await expect(createCimdResolver(mixed.deps)(clientId)).rejects.toThrow();
    expect(mixed.request).not.toHaveBeenCalled();
  });

  it('pins the validated public DNS address and bounds the metadata response', async () => {
    const { deps, request } = dependencies({
      answers: [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ],
    });
    const resolved = await createCimdResolver(deps)(clientId);

    expect(resolved.client_name).toBe('ChatGPT');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.objectContaining({ hostname: 'chatgpt.com' }),
        address: '8.8.8.8',
        timeoutMs: 3_000,
        maxBytes: 5_120,
      }),
    );
  });

  it('pins the real HTTPS lookup callback and preserves hostname for TLS and Host', async () => {
    const body = JSON.stringify(metadata);
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-store',
      },
      destroy: vi.fn(),
    });
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(() => {
        callback?.(response as never);
        response.emit('data', body);
        response.emit('end');
      }),
    });
    let callback: ((response: unknown) => void) | undefined;
    let options: Record<string, unknown> | undefined;
    const requestImpl = vi.fn((_url: URL, requestOptions: unknown, onResponse: unknown) => {
      options = requestOptions as Record<string, unknown>;
      callback = onResponse as (response: unknown) => void;
      return request;
    });
    const pinnedRequest = createPinnedHttpsRequest(requestImpl as never);

    await expect(
      pinnedRequest({
        url: new URL(clientId),
        address: '8.8.8.8',
        timeoutMs: 3_000,
        maxBytes: 5_120,
      }),
    ).resolves.toMatchObject({ statusCode: 200, contentType: 'application/json' });

    expect(requestImpl).toHaveBeenCalledTimes(1);
    expect(options?.servername).toBe('chatgpt.com');
    expect((options?.headers as Record<string, string>).host).toBe('chatgpt.com');
    const lookup = options?.lookup as (
      hostname: string,
      options: unknown,
      callback: (err: Error | null, address: string, family: number) => void,
    ) => void;
    const pinned = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup('chatgpt.com', {}, (err, address, family) =>
        err ? reject(err) : resolve({ address, family }),
      );
    });
    expect(pinned).toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('rejects non-200, non-JSON, oversized, invalid JSON, and mismatched metadata', async () => {
    const badResponses = [
      { statusCode: 302, contentType: 'application/json', body: JSON.stringify(metadata) },
      { statusCode: 200, contentType: 'text/html', body: JSON.stringify(metadata) },
      { statusCode: 200, contentType: 'application/json', body: 'not json' },
      {
        statusCode: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...metadata, client_id: 'https://other.example/client.json' }),
      },
    ];
    for (const response of badResponses) {
      const { deps } = dependencies({ response });
      await expect(createCimdResolver(deps)(clientId)).rejects.toThrow();
    }

    const oversized = dependencies({
      response: {
        statusCode: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...metadata, extra: 'x'.repeat(5_200) }),
      },
    });
    await expect(createCimdResolver(oversized.deps)(clientId)).rejects.toThrow();
  });

  it('honors max-age and Age, uses exact URL keys, and does not reuse no-cache responses', async () => {
    let now = 1_000;
    const request = vi.fn(async ({ url }: { url: URL }) => ({
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...metadata, client_id: url.href }),
      cacheControl: 'public, max-age=10',
      age: '5',
    }));
    const resolver = createCimdResolver({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      request,
      now: () => now,
    });

    await resolver(clientId);
    now += 4_999;
    await resolver(clientId);
    expect(request).toHaveBeenCalledTimes(1);
    now += 1;
    await resolver(clientId);
    expect(request).toHaveBeenCalledTimes(2);

    await resolver('https://chatgpt.com/oauth/other-client.json');
    expect(request).toHaveBeenCalledTimes(3);

    const noCacheRequest = vi.fn(async () => ({
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify(metadata),
      cacheControl: 'no-cache',
    }));
    const noCacheResolver = createCimdResolver({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      request: noCacheRequest,
      now: () => now,
    });
    await noCacheResolver(clientId);
    await noCacheResolver(clientId);
    expect(noCacheRequest).toHaveBeenCalledTimes(2);

    const noStoreRequest = vi.fn(async () => ({
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify(metadata),
      cacheControl: 'no-store, max-age=300',
    }));
    const noStoreResolver = createCimdResolver({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      request: noStoreRequest,
      now: () => now,
    });
    await noStoreResolver(clientId);
    await noStoreResolver(clientId);
    expect(noStoreRequest).toHaveBeenCalledTimes(2);
  });

  it('coalesces same-URL misses and caps unique in-flight fetches at sixteen', async () => {
    type Response = {
      statusCode: number;
      contentType: string;
      body: string;
    };
    const pending = new Map<string, (response: Response) => void>();
    const request = vi.fn(
      ({ url }: { url: URL }) => new Promise<Response>((resolve) => pending.set(url.href, resolve)),
    );
    const resolver = createCimdResolver({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      request,
      now: () => 1_000,
    });

    const one = resolver(clientId);
    const two = resolver(clientId);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const release = (id: string) =>
      pending.get(id)?.({
        statusCode: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...metadata, client_id: id }),
      });
    release(clientId);
    await expect(Promise.all([one, two])).resolves.toHaveLength(2);

    const ids = Array.from({ length: 16 }, (_, i) => `https://client.example/${i}.json`);
    const active = ids.map((id) => resolver(id));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(17));
    await expect(resolver('https://client.example/overflow.json')).rejects.toBeInstanceOf(
      CimdResolverCapacityError,
    );
    ids.forEach(release);
    await Promise.all(active);
    const overflow = resolver('https://client.example/overflow.json');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(18));
    release('https://client.example/overflow.json');
    await overflow;
    expect(request).toHaveBeenCalledTimes(18);
  });

  it('evicts least-recently-used documents at the 256-entry bound', async () => {
    const request = vi.fn(async ({ url }: { url: URL }) => ({
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...metadata, client_id: url.href }),
    }));
    const resolver = createCimdResolver({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      request,
      now: () => 1_000,
    });
    const ids = Array.from({ length: 257 }, (_, i) => `https://client.example/${i}.json`);
    for (const id of ids) await resolver(id);
    await resolver(ids[1]); // Promote the second entry before the next insertion evicts the first.
    await resolver('https://client.example/257.json');
    await resolver(ids[0]);
    expect(request).toHaveBeenCalledTimes(259);
  });
});
