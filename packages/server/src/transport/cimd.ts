import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { OAuthClientMetadataSchema, type OAuthClientMetadata } from '@musterd/protocol';

const MAX_CLIENT_ID_CHARACTERS = 2_048;
const MAX_DOCUMENT_BYTES = 5_120;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_CACHE_AGE_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_IN_FLIGHT = 16;

type Address = { address: string; family: 4 | 6 };

type MetadataResponse = {
  statusCode: number;
  contentType: string | null;
  body: string | Uint8Array;
  cacheControl?: string | null;
  age?: string | null;
  expires?: string | null;
};

type FetchInput = {
  url: URL;
  address: string;
  timeoutMs: number;
  maxBytes: number;
};

export type CimdResolverDependencies = {
  lookup(hostname: string): Promise<Address[]>;
  request(input: FetchInput): Promise<MetadataResponse>;
  now(): number;
};

/** Safe failure used for every remote metadata, URL, DNS, TLS, and parsing error. */
export class CimdResolutionError extends Error {
  constructor() {
    super('invalid client metadata');
    this.name = 'CimdResolutionError';
  }
}

/** Retryable failure when the process-wide bound on unique metadata fetches is full. */
export class CimdResolverCapacityError extends Error {
  constructor() {
    super('client metadata fetch capacity reached');
    this.name = 'CimdResolverCapacityError';
  }
}

/** True only for the URL syntax and local policy that permits a CIMD lookup. */
export function isCimdClientId(clientId: string): boolean {
  if (
    Array.from(clientId).length > MAX_CLIENT_ID_CHARACTERS ||
    clientId.includes('\\') ||
    Array.from(clientId).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  )
    return false;
  if (clientId.includes('?') || clientId.includes('#')) return false;

  const schemeSeparator = clientId.indexOf('://');
  if (schemeSeparator < 0 || clientId.slice(0, schemeSeparator).toLowerCase() !== 'https')
    return false;
  const authorityStart = schemeSeparator + 3;
  const authorityBoundary = clientId.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = authorityBoundary < 0 ? clientId.length : authorityStart + authorityBoundary;
  const rawAuthority = clientId.slice(authorityStart, authorityEnd);
  if (!rawAuthority || rawAuthority.includes('@')) return false;

  const rawSuffix = clientId.slice(authorityEnd);
  const rawPathEnd = rawSuffix.search(/[?#]/);
  const rawPath = rawPathEnd < 0 ? rawSuffix : rawSuffix.slice(0, rawPathEnd);
  if (!rawPath.startsWith('/') || rawPath.length === 1) return false;
  for (const segment of rawPath.split('/').slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    while (decoded.includes('%')) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        break;
      }
      if (next === decoded) break;
      decoded = next;
    }
    if (decoded === '.' || decoded === '..') return false;
  }

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    !url.hostname ||
    url.search !== '' ||
    url.hash !== ''
  )
    return false;
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) === 6) return false;
  return true;
}

/** A conservative global-unicast check for resolver answers. */
function isGlobalUnicastAddress(address: string, family: 4 | 6): boolean {
  if (isIP(address) !== family) return false;
  return family === 4 ? isGlobalIpv4(address) : isGlobalIpv6(address);
}

function isGlobalIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space 100.64/10
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // documentation
  if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay anycast
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255 && b === 255 && c === 255) return false;
  return true;
}

function ipv6Groups(address: string): number[] | null {
  let source = address.toLowerCase();
  if (source.includes('.')) {
    const lastColon = source.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = source
      .slice(lastColon + 1)
      .split('.')
      .map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = v4 as [number, number, number, number];
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    source = `${source.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const zeros = 8 - left.length - right.length;
  if ((halves.length === 1 && zeros !== 0) || (halves.length === 2 && zeros < 1)) return null;
  const groups = [...left, ...Array(zeros).fill('0'), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 &&
    groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

function isGlobalIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;
  // IPv4-mapped addresses are special-use, even when their embedded address is public.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5]! === 0xffff) return false;
  // Global unicast is 2000::/3. This excludes unspecified, loopback, ULA, link-local,
  // multicast, NAT64, IPv4-compatible, and other non-global ranges by default.
  if ((groups[0]! & 0xe000) !== 0x2000) return false;
  if (groups[0] === 0x2001 && groups[1]! <= 0x01ff) return false; // IETF protocol assignments
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  if (groups[0] === 0x2002) return false; // 6to4
  if (groups[0] === 0x3fff && (groups[1]! & 0xf000) === 0) return false; // documentation
  return true;
}

function responseHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value.join(', ') || null : (value ?? null);
}

export function createPinnedHttpsRequest(
  requestImpl: typeof httpsRequest = httpsRequest,
): (input: FetchInput) => Promise<MetadataResponse> {
  return (input) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const hostname = input.url.hostname.replace(/^\[|\]$/g, '');
      const family = isIP(input.address);
      if (family !== 4 && family !== 6) {
        reject(new CimdResolutionError());
        return;
      }
      let request: ReturnType<typeof httpsRequest> | undefined;
      const cleanup = () => clearTimeout(timer);
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new CimdResolutionError());
      };
      const succeed = (response: MetadataResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      const timer = setTimeout(() => {
        request?.destroy();
        fail();
      }, input.timeoutMs);
      timer.unref();
      const lookup: NonNullable<RequestOptions['lookup']> = (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: input.address, family }]);
        else callback(null, input.address, family);
      };

      try {
        request = requestImpl(
          input.url,
          {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'accept-encoding': 'identity',
              host: input.url.host,
            },
            lookup,
            ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
          },
          (response) => {
            const contentType = responseHeader(response.headers['content-type']);
            if (
              response.statusCode !== 200 ||
              !contentType ||
              contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json'
            ) {
              response.destroy();
              fail();
              return;
            }
            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
              response.destroy();
              fail();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer | string) => {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += buffer.byteLength;
              if (bytes > input.maxBytes) {
                response.destroy();
                fail();
                return;
              }
              chunks.push(buffer);
            });
            response.on('end', () => {
              succeed({
                statusCode: 200,
                contentType,
                body: Buffer.concat(chunks),
                cacheControl: responseHeader(response.headers['cache-control']),
                age: responseHeader(response.headers.age),
                expires: responseHeader(response.headers.expires),
              });
            });
            response.on('error', fail);
          },
        );
      } catch {
        fail();
        return;
      }
      request.on('error', fail);
      request.end();
    });
}

const requestPinnedDocument = createPinnedHttpsRequest();

async function lookupPublicAddresses(hostname: string): Promise<Address[]> {
  const dnsHost = hostname.replace(/^\[|\]$/g, '');
  try {
    const answers = await dnsLookup(dnsHost, { all: true, verbatim: true });
    if (
      answers.length === 0 ||
      answers.some(
        (answer) =>
          (answer.family !== 4 && answer.family !== 6) ||
          !isGlobalUnicastAddress(answer.address, answer.family),
      )
    )
      throw new CimdResolutionError();
    return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  } catch {
    throw new CimdResolutionError();
  }
}

function cacheLifetimeMs(response: MetadataResponse, now: number): number {
  const directives = new Map<string, string | true>();
  for (const part of (response.cacheControl ?? '').split(',')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) continue;
    const value = rest.join('=').trim().replace(/^"|"$/g, '');
    directives.set(name.toLowerCase(), rest.length === 0 ? true : value);
  }
  if (directives.has('no-store') || directives.has('no-cache')) return 0;

  const ageHeader = response.age?.trim();
  const ageSeconds = ageHeader === undefined || ageHeader === '' ? 0 : Number(ageHeader);
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 0;
  const maxAge = directives.get('s-maxage') ?? directives.get('max-age');
  if (maxAge !== undefined) {
    if (maxAge === true || !/^\d+$/.test(maxAge)) return 0;
    return Math.max(0, Math.min(MAX_CACHE_AGE_MS, Number(maxAge) * 1_000 - ageSeconds * 1_000));
  }

  if (response.expires) {
    const expiresAt = Date.parse(response.expires);
    if (!Number.isFinite(expiresAt)) return 0;
    return Math.max(0, Math.min(MAX_CACHE_AGE_MS, expiresAt - now - ageSeconds * 1_000));
  }
  return Math.max(0, Math.min(MAX_CACHE_AGE_MS, MAX_CACHE_AGE_MS - ageSeconds * 1_000));
}

function cloneMetadata(metadata: OAuthClientMetadata): OAuthClientMetadata {
  return {
    ...metadata,
    redirect_uris: [...metadata.redirect_uris],
    grant_types: [...metadata.grant_types],
    response_types: [...metadata.response_types],
    ...(metadata.token_endpoint_auth_methods_supported
      ? {
          token_endpoint_auth_methods_supported: [
            ...metadata.token_endpoint_auth_methods_supported,
          ],
        }
      : {}),
  };
}

/** Create an isolated bounded resolver; injected dependencies keep tests hermetic. */
export function createCimdResolver(
  deps: CimdResolverDependencies,
): (clientId: string) => Promise<OAuthClientMetadata> {
  const cache = new Map<string, { metadata: OAuthClientMetadata; expiresAt: number }>();
  const inFlight = new Map<string, Promise<OAuthClientMetadata>>();

  async function fetch(
    clientId: string,
    deadlineAt: number,
  ): Promise<{ metadata: OAuthClientMetadata; ttlMs: number }> {
    if (!isCimdClientId(clientId)) throw new CimdResolutionError();
    const url = new URL(clientId);
    const answers = await deps.lookup(url.hostname).catch(() => {
      throw new CimdResolutionError();
    });
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new CimdResolutionError();
    if (
      answers.length === 0 ||
      answers.some((answer) => !isGlobalUnicastAddress(answer.address, answer.family))
    )
      throw new CimdResolutionError();
    const address = answers[0];
    if (!address) throw new CimdResolutionError();
    const response = await deps
      .request({
        url,
        address: address.address,
        timeoutMs: remainingMs,
        maxBytes: MAX_DOCUMENT_BYTES,
      })
      .catch(() => {
        throw new CimdResolutionError();
      });
    if (Date.now() >= deadlineAt) throw new CimdResolutionError();
    if (
      response.statusCode !== 200 ||
      !response.contentType ||
      response.contentType.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json'
    )
      throw new CimdResolutionError();
    const body =
      typeof response.body === 'string'
        ? Buffer.from(response.body, 'utf8')
        : Buffer.from(response.body);
    if (body.byteLength > MAX_DOCUMENT_BYTES) throw new CimdResolutionError();
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      throw new CimdResolutionError();
    }
    const parsed = OAuthClientMetadataSchema.safeParse(raw);
    if (!parsed.success || parsed.data.client_id !== clientId) throw new CimdResolutionError();
    return { metadata: parsed.data, ttlMs: cacheLifetimeMs(response, deps.now()) };
  }

  return async (clientId: string): Promise<OAuthClientMetadata> => {
    if (!isCimdClientId(clientId)) throw new CimdResolutionError();
    const now = deps.now();
    const cached = cache.get(clientId);
    if (cached && cached.expiresAt > now) {
      cache.delete(clientId);
      cache.set(clientId, cached);
      return cloneMetadata(cached.metadata);
    }
    if (cached) cache.delete(clientId);

    const shared = inFlight.get(clientId);
    if (shared) return cloneMetadata(await shared);
    if (inFlight.size >= MAX_IN_FLIGHT) throw new CimdResolverCapacityError();

    const deadlineAt = Date.now() + REQUEST_TIMEOUT_MS;
    const work = fetch(clientId, deadlineAt)
      .then(({ metadata, ttlMs }) => {
        if (ttlMs > 0) {
          cache.delete(clientId);
          cache.set(clientId, { metadata: cloneMetadata(metadata), expiresAt: deps.now() + ttlMs });
          while (cache.size > MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        }
        return metadata;
      })
      .finally(() => {
        // DNS promises cannot be cancelled. Keep timed-out DNS work counted against the bound
        // until it really settles, so a slow resolver cannot create unlimited orphan lookups.
        if (inFlight.get(clientId) === pending) inFlight.delete(clientId);
      });
    let deadlineTimer: NodeJS.Timeout;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => reject(new CimdResolutionError()), REQUEST_TIMEOUT_MS);
      deadlineTimer.unref();
    });
    const pending = Promise.race([work, deadline]).finally(() => clearTimeout(deadlineTimer));
    inFlight.set(clientId, pending);
    return cloneMetadata(await pending);
  };
}

const productionResolver = await createCimdResolver({
  lookup: lookupPublicAddresses,
  request: requestPinnedDocument,
  now: Date.now,
});

/** Production resolver used by both authorization legs; never called by the token route. */
export const resolveCimdClient = productionResolver;
