import type { request as httpsRequest, RequestOptions } from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPinned,
  postJsonPinned,
  setPinnedGetForTests,
  setSinkPostForTests,
  type PinnedPostDeps,
} from './pinnedPost.js';

type Captured = {
  url: URL;
  options: RequestOptions;
  body: string;
  pinned: { address: string; family: number } | null;
};

/** A fake https.request: records the call, answers `status`, or errors / hangs on demand. */
function fakeRequest(
  behaviour: { status?: number; error?: string; hang?: boolean } = { status: 204 },
): { request: typeof httpsRequest; calls: Captured[] } {
  const calls: Captured[] = [];
  const request = ((url: URL, options: RequestOptions, cb: (res: unknown) => void) => {
    const call: Captured = { url, options, body: '', pinned: null };
    calls.push(call);
    // Exercise the pin exactly as net.connect would: ask the lookup for this hostname.
    options.lookup?.(
      url.hostname,
      { all: false } as never,
      ((_err: unknown, address: string, family: number) => {
        call.pinned = { address, family };
      }) as never,
    );
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const req = {
      on(ev: string, fn: (arg?: unknown) => void) {
        handlers[ev] = fn;
        return req;
      },
      end(chunk?: string | Buffer) {
        call.body = chunk === undefined ? '' : String(chunk);
        if (behaviour.hang) return;
        if (behaviour.error) {
          setImmediate(() => handlers['error']?.(new Error(behaviour.error)));
          return;
        }
        const resHandlers: Record<string, () => void> = {};
        setImmediate(() =>
          cb({
            statusCode: behaviour.status,
            headers: {},
            resume() {},
            on(ev: string, fn: () => void) {
              resHandlers[ev] = fn;
              if (ev === 'end') setImmediate(fn);
            },
          }),
        );
      },
      destroy() {
        handlers['error']?.(new Error('destroyed'));
      },
    };
    return req;
  }) as unknown as typeof httpsRequest;
  return { request, calls };
}

const deps = (
  answers: { address: string; family: 4 | 6 }[] | Error,
  req = fakeRequest(),
): PinnedPostDeps & { calls: Captured[] } => ({
  lookup: async () => {
    if (answers instanceof Error) throw answers;
    return answers;
  },
  request: req.request,
  calls: req.calls,
});

describe('postJsonPinned — resolve, refuse private, pin (ADR 443 §5 closed)', () => {
  afterEach(() => setSinkPostForTests(null));

  it('resolves the name, pins the connection to the checked public address, and POSTs the body', async () => {
    const d = deps([{ address: '93.184.216.34', family: 4 }]);
    const out = await postJsonPinned('https://ntfy.example/t', '{"a":1}', 1000, d);
    expect(out).toEqual({ ok: true, status: 204 });
    expect(d.calls).toHaveLength(1);
    const call = d.calls[0]!;
    expect(call.pinned).toEqual({ address: '93.184.216.34', family: 4 });
    expect(call.options.method).toBe('POST');
    expect(call.options.servername).toBe('ntfy.example');
    expect((call.options.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    expect(call.body).toBe('{"a":1}');
  });

  it('a public name that resolves to a private address never reaches the network', async () => {
    for (const address of ['10.0.0.8', '127.0.0.1', '169.254.1.1', '192.168.1.1', '100.64.0.1']) {
      const d = deps([{ address, family: 4 }]);
      expect(await postJsonPinned('https://evil.example/x', '{}', 1000, d)).toEqual({ ok: false });
      expect(d.calls).toHaveLength(0);
    }
    const v6 = deps([{ address: 'fd00::1', family: 6 }]);
    expect(await postJsonPinned('https://evil.example/x', '{}', 1000, v6)).toEqual({ ok: false });
    expect(v6.calls).toHaveLength(0);
  });

  it('one private answer among public ones refuses the whole send — no answer may be the one that connects', async () => {
    const d = deps([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]);
    expect(await postJsonPinned('https://evil.example/x', '{}', 1000, d)).toEqual({ ok: false });
    expect(d.calls).toHaveLength(0);
  });

  it('an IP-literal host is checked without a lookup, private refused and public pinned as-is', async () => {
    const priv = deps(new Error('lookup must not be called'));
    expect(await postJsonPinned('https://10.0.0.8/x', '{}', 1000, priv)).toEqual({ ok: false });
    expect(priv.calls).toHaveLength(0);
    const pub = deps(new Error('lookup must not be called'));
    expect(await postJsonPinned('https://93.184.216.34/x', '{}', 1000, pub)).toEqual({
      ok: true,
      status: 204,
    });
    expect(pub.calls[0]!.pinned).toEqual({ address: '93.184.216.34', family: 4 });
    expect(pub.calls[0]!.options.servername).toBeUndefined();
  });

  it('an unresolvable name, a non-https URL and a malformed URL are ok:false, never thrown', async () => {
    expect(
      await postJsonPinned('https://nx.example/x', '{}', 1000, deps(new Error('ENOTFOUND'))),
    ).toEqual({ ok: false });
    const d = deps([{ address: '93.184.216.34', family: 4 }]);
    expect(await postJsonPinned('http://ntfy.example/t', '{}', 1000, d)).toEqual({ ok: false });
    expect(await postJsonPinned('not a url', '{}', 1000, d)).toEqual({ ok: false });
    expect(d.calls).toHaveLength(0);
  });

  it('a 3xx is reported, not followed — one request, ok:false with its status', async () => {
    const d = deps([{ address: '93.184.216.34', family: 4 }], fakeRequest({ status: 302 }));
    expect(await postJsonPinned('https://ntfy.example/t', '{}', 1000, d)).toEqual({
      ok: false,
      status: 302,
    });
    expect(d.calls).toHaveLength(1);
  });

  it('a network error is ok:false with no status; a hang gives up at the timeout', async () => {
    const err = deps(
      [{ address: '93.184.216.34', family: 4 }],
      fakeRequest({ error: 'ECONNRESET' }),
    );
    expect(await postJsonPinned('https://ntfy.example/t', '{}', 1000, err)).toEqual({ ok: false });
    const hang = deps([{ address: '93.184.216.34', family: 4 }], fakeRequest({ hang: true }));
    const started = Date.now();
    expect(await postJsonPinned('https://ntfy.example/t', '{}', 30, hang)).toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('the test seam replaces the transport wholesale', async () => {
    setSinkPostForTests(async (url, body) => ({ ok: true, status: url.length + body.length }));
    expect(await postJsonPinned('https://x.example/', 'ab', 1000)).toEqual({
      ok: true,
      status: 20,
    });
  });
});

/** A fake https.request for GET: records the call and the pin, answers `status` with `chunks`. */
function fakeGet(
  status: number,
  chunks: string[] = [],
): { request: typeof httpsRequest; calls: Captured[] } {
  const calls: Captured[] = [];
  const request = ((url: URL, options: RequestOptions, cb: (res: unknown) => void) => {
    const call: Captured = { url, options, body: '', pinned: null };
    calls.push(call);
    options.lookup?.(
      url.hostname,
      { all: false } as never,
      ((_err: unknown, address: string, family: number) => {
        call.pinned = { address, family };
      }) as never,
    );
    const req = {
      on() {
        return req;
      },
      end() {
        const handlers: Record<string, (arg?: unknown) => void> = {};
        setImmediate(() => {
          cb({
            statusCode: status,
            headers: {},
            resume() {},
            on(ev: string, fn: (arg?: unknown) => void) {
              handlers[ev] = fn;
            },
          });
          for (const chunk of chunks) handlers['data']?.(Buffer.from(chunk));
          handlers['end']?.();
        });
      },
      destroy() {},
    };
    return req;
  }) as unknown as typeof httpsRequest;
  return { request, calls };
}

describe('getPinned — the seeds relay pull takes the same rule (lane 01M3W815KR)', () => {
  afterEach(() => setPinnedGetForTests(null));

  it('GETs through the pin with the given headers and returns the body on a 2xx', async () => {
    const d = deps([{ address: '93.184.216.34', family: 4 }], fakeGet(200, ['{"seeds"', ':[]}']));
    const out = await getPinned(
      'https://relay.example/seeds',
      { authorization: 'Bearer t' },
      1000,
      1024,
      d,
    );
    expect(out).toEqual({ ok: true, status: 200, body: '{"seeds":[]}' });
    const call = d.calls[0]!;
    expect(call.pinned).toEqual({ address: '93.184.216.34', family: 4 });
    expect(call.options.method).toBe('GET');
    expect(call.options.servername).toBe('relay.example');
    expect((call.options.headers as Record<string, string>)['authorization']).toBe('Bearer t');
  });

  it('a name resolving to a private, loopback, link-local or ULA address is refused unconnected', async () => {
    const answers: { address: string; family: 4 | 6 }[] = [
      { address: '10.0.0.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
      { address: 'fdaa::3', family: 6 },
      { address: 'fe80::1', family: 6 },
    ];
    for (const answer of answers) {
      const d = deps([answer], fakeGet(200, ['{}']));
      expect(await getPinned('https://relay.example/seeds', {}, 1000, 1024, d)).toEqual({
        ok: false,
        refused: true,
      });
      expect(d.calls).toHaveLength(0);
    }
  });

  it('http, a malformed URL and an unresolvable name are refused; a 3xx is a status, not followed', async () => {
    const d = deps([{ address: '93.184.216.34', family: 4 }], fakeGet(200));
    expect(await getPinned('http://relay.example/seeds', {}, 1000, 1024, d)).toEqual({
      ok: false,
      refused: true,
    });
    expect(await getPinned('not a url', {}, 1000, 1024, d)).toEqual({ ok: false, refused: true });
    expect(d.calls).toHaveLength(0);
    const nx = deps(new Error('ENOTFOUND'));
    expect(await getPinned('https://nx.example/seeds', {}, 1000, 1024, nx)).toEqual({
      ok: false,
      refused: true,
    });
    const moved = deps([{ address: '93.184.216.34', family: 4 }], fakeGet(302));
    expect(await getPinned('https://relay.example/seeds', {}, 1000, 1024, moved)).toEqual({
      ok: false,
      status: 302,
    });
    expect(moved.calls).toHaveLength(1);
  });

  it('a body past maxBytes is dropped, not returned', async () => {
    const d = deps([{ address: '93.184.216.34', family: 4 }], fakeGet(200, ['x'.repeat(8)]));
    expect(await getPinned('https://relay.example/seeds', {}, 1000, 4, d)).toEqual({
      ok: false,
      status: 200,
    });
  });
});
