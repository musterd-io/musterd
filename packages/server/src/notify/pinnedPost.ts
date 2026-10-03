import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { isGlobalUnicastAddress } from '../transport/cimd.js';

/**
 * The one way an off-machine doorbell sink is reached (ADR 443 §5, closed). `PUT` checks the
 * literal host, which a public name resolving to a private address walks straight past. So the send
 * resolves the name itself, refuses the whole answer set if ANY address is not global unicast, and
 * pins the TLS connection to the address it checked — `node:https` with a `lookup` override, the
 * same shape the CIMD resolver uses (`transport/cimd.ts`), because `fetch` cannot pin. Redirects
 * are not followed: a 3xx is a status, never a second connection. Never throws.
 */

export type SinkResult = { ok: boolean; status?: number };
export type SinkPost = (url: string, body: string, timeoutMs: number) => Promise<SinkResult>;

export type PinnedPostDeps = {
  lookup(hostname: string): Promise<{ address: string; family: number }[]>;
  request: typeof httpsRequest;
};

const defaultDeps: PinnedPostDeps = {
  lookup: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  request: httpsRequest,
};

let override: SinkPost | null = null;

/** Tests replace the transport here (integration tests cannot reach a real sink); `null` restores it. */
export function setSinkPostForTests(fn: SinkPost | null): void {
  override = fn;
}

/** The checked address to connect to, or null when the name may not be reached. */
async function pinnedAddress(
  hostname: string,
  deps: PinnedPostDeps,
): Promise<{ address: string; family: 4 | 6 } | null> {
  const literal = isIP(hostname);
  if (literal === 4 || literal === 6) {
    return isGlobalUnicastAddress(hostname, literal)
      ? { address: hostname, family: literal }
      : null;
  }
  let answers: { address: string; family: number }[];
  try {
    answers = await deps.lookup(hostname);
  } catch {
    return null;
  }
  if (answers.length === 0) return null;
  for (const a of answers) {
    if ((a.family !== 4 && a.family !== 6) || !isGlobalUnicastAddress(a.address, a.family))
      return null;
  }
  const first = answers[0]!;
  return { address: first.address, family: first.family as 4 | 6 };
}

export async function postJsonPinned(
  rawUrl: string,
  body: string,
  timeoutMs: number,
  deps: PinnedPostDeps = defaultDeps,
): Promise<SinkResult> {
  if (override) return override(rawUrl, body, timeoutMs);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'https:') return { ok: false };
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const pin = await pinnedAddress(hostname, deps);
  if (!pin) return { ok: false };

  return new Promise<SinkResult>((resolve) => {
    let settled = false;
    let request: ReturnType<typeof httpsRequest> | undefined;
    const settle = (result: SinkResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      request?.destroy();
      settle({ ok: false });
    }, timeoutMs);
    timer.unref();
    const lookup: NonNullable<RequestOptions['lookup']> = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address: pin.address, family: pin.family }]);
      else callback(null, pin.address, pin.family);
    };
    const payload = Buffer.from(body);
    try {
      request = deps.request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.byteLength),
            host: url.host,
          },
          lookup,
          ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          response.on('end', () => settle({ ok: status >= 200 && status < 300, status }));
          response.on('error', () => settle({ ok: false }));
        },
      );
    } catch {
      settle({ ok: false });
      return;
    }
    request.on('error', () => settle({ ok: false }));
    request.end(payload);
  });
}
