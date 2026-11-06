import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { passkeyApprovePage, passkeyEnrollPage } from './authorityPages.js';

/**
 * A browser stand-in just wide enough for the two ceremony pages: elements with textContent,
 * className and disabled; a fetch whose answers resolve in the order the test chooses; and a
 * window that is, or is not, a secure context. No DOM library (hard rule 6).
 */
interface El {
  textContent: string;
  className: string;
  disabled: boolean;
  value: string;
  handlers: Record<string, () => Promise<void> | void>;
  addEventListener(name: string, fn: () => Promise<void> | void): void;
}
function el(): El {
  const e: El = {
    textContent: '',
    className: '',
    disabled: false,
    value: '',
    handlers: {},
    addEventListener(name, fn) {
      e.handlers[name] = fn;
    },
  };
  return e;
}
type Deferred = { resolve: (body: unknown) => void; reject: (e: Error) => void };

function boot(page: string, opts: { secure: boolean; origin: string; search: string }) {
  const script = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
  const els: Record<string, El> = {};
  const byId = (id: string) => (els[id] ??= el());
  const pending = new Map<string, Deferred>();
  const fetchImpl = (url: string) =>
    new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((resolve, reject) => {
      pending.set(url, {
        resolve: (body) => resolve({ ok: true, status: 200, json: async () => body }),
        reject,
      });
    });
  const sandbox = {
    window: { isSecureContext: opts.secure },
    navigator: opts.secure ? { credentials: { get: () => {}, create: () => {} } } : {},
    location: {
      origin: opts.origin,
      pathname: '/authority/approve',
      search: opts.search,
      hash: '',
    },
    document: {
      getElementById: byId,
      querySelectorAll: () => [byId('go')],
    },
    fetch: fetchImpl,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    Uint8Array,
    Date,
    console,
  };
  runInNewContext(script, sandbox);
  const answer = async (url: string, body: unknown, fail = false) => {
    const d = pending.get(url);
    if (!d) throw new Error(`no request for ${url}`);
    pending.delete(url);
    if (fail) d.reject(new Error('down'));
    else d.resolve(body);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { els, byId, pending, answer };
}

const DESCRIPTOR = '/teams/revive/authority/descriptors/n1';
const GUIDANCE =
  'Passkeys only work on https or localhost, and this page is on http://100.115.152.1:4849.';
const SEARCH = '?team=revive&nonce=n1';

describe('passkey pages on a non-secure origin (lane 01M6Q1X9J0)', () => {
  it('approve: guidance shows at once and the button is off before any response', () => {
    const b = boot(passkeyApprovePage, {
      secure: false,
      origin: 'http://100.115.152.1:4849',
      search: SEARCH,
    });
    expect(b.byId('out').textContent).toContain(GUIDANCE);
    expect(b.byId('out').className).toBe('err');
    expect(b.byId('go').disabled).toBe(true);
    expect(b.pending.has('/health')).toBe(true);
    expect(b.pending.has(DESCRIPTOR)).toBe(true);
  });

  it('approve: /health first, then a descriptor failure — the https link stays', async () => {
    const b = boot(passkeyApprovePage, {
      secure: false,
      origin: 'http://100.115.152.1:4849',
      search: SEARCH,
    });
    await b.answer('/health', { browser_origin: 'https://hub.tail.ts.net' });
    expect(b.byId('out').textContent).toContain(
      'https://hub.tail.ts.net/authority/approve?team=revive&nonce=n1',
    );
    await b.answer(DESCRIPTOR, null, true);
    expect(b.byId('out').textContent).toContain('https://hub.tail.ts.net/authority/approve');
    expect(b.byId('go').disabled).toBe(true);
  });

  it('approve: descriptor with no passkeys first, then /health — the https link still appears', async () => {
    const b = boot(passkeyApprovePage, {
      secure: false,
      origin: 'http://100.115.152.1:4849',
      search: SEARCH,
    });
    await b.answer(DESCRIPTOR, {
      descriptor: { actor: 'nick', act: 'admin.roster', target: 't', expiry: 0 },
      passkeys: [],
    });
    expect(b.byId('out').textContent).toContain(GUIDANCE);
    expect(b.byId('out').textContent).not.toContain('No passkey is enrolled');
    await b.answer('/health', { browser_origin: 'https://hub.tail.ts.net' });
    expect(b.byId('out').textContent).toContain('https://hub.tail.ts.net/authority/approve');
    expect(b.byId('go').disabled).toBe(true);
  });

  it('approve: descriptor with passkeys cannot re-enable the button, and /health down keeps the plain guidance', async () => {
    const b = boot(passkeyApprovePage, {
      secure: false,
      origin: 'http://100.115.152.1:4849',
      search: SEARCH,
    });
    await b.answer(DESCRIPTOR, {
      descriptor: { actor: 'nick', act: 'admin.roster', target: 't', expiry: 0 },
      passkeys: [{ credential_id: 'AAAA' }],
    });
    expect(b.byId('go').disabled).toBe(true);
    await b.answer('/health', null, true);
    expect(b.byId('out').textContent).toContain("hub's https address, or on http://localhost");
    await b.byId('go').handlers['click']?.();
    expect(b.byId('out').textContent).toContain(GUIDANCE);
  });

  it('enroll: same guard, button off, click is a no-op', async () => {
    const b = boot(passkeyEnrollPage, {
      secure: false,
      origin: 'http://100.115.152.1:4849',
      search: '?team=revive&member=nick',
    });
    expect(b.byId('out').textContent).toContain(GUIDANCE);
    expect(b.byId('go').disabled).toBe(true);
    await b.byId('go').handlers['click']?.();
    expect(b.pending.size).toBe(1); // only /health — no enrollment call
  });

  it('secure origin: no guidance, the descriptor path runs as before', async () => {
    const b = boot(passkeyApprovePage, {
      secure: true,
      origin: 'https://hub.tail.ts.net',
      search: SEARCH,
    });
    expect(b.byId('out').textContent).toBe('');
    expect(b.pending.has('/health')).toBe(false);
    await b.answer(DESCRIPTOR, {
      descriptor: { actor: 'nick', act: 'admin.roster', target: 't', expiry: 0 },
      passkeys: [{ credential_id: 'AAAA' }],
    });
    expect(b.byId('go').disabled).toBe(false);
    expect(b.byId('descriptor').textContent).toContain('actor:  nick');
  });
});
