import { isIP } from 'node:net';
import { FETCH_RETRIES, FETCH_TIMEOUT_MS } from './config.ts';
import type { FetchFn } from './fetch.ts';

const EXA_CONTENTS_URL = 'https://api.exa.ai/contents';
const MAX_RESPONSE_BYTES = 2_000_000;

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase();
  // Only accept globally routable unicast (2000::/3). This also rejects mapped IPv4,
  // unspecified, loopback, ULA, link-local, multicast, and documentation ranges.
  const first = Number.parseInt(value.split(':', 1)[0] || '0', 16);
  return !Number.isFinite(first) || first < 0x2000 || first > 0x3fff;
}

/** Reject URL forms that could target local or non-public network destinations. */
export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^\[|\]$/g, '');
    if (
      !host ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.test') ||
      host.endsWith('.invalid')
    )
      return false;
    const ipVersion = isIP(host);
    if (ipVersion === 4) return !isPrivateIpv4(host);
    if (ipVersion === 6) return !isPrivateIpv6(host);
    return ipVersion === 0;
  } catch {
    return false;
  }
}

async function responseTextBounded(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Exa response exceeds the configured size limit');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Exa response exceeds the configured size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Retrieve the full extracted page text for one already-known public HTTPS URL. */
export async function fetchArticleText(
  url: string,
  apiKey: string,
  fetchFn: FetchFn = fetch,
): Promise<{ url: string; text: string }> {
  if (!isPublicHttpsUrl(url)) throw new Error('Article URL must be a public HTTPS URL');
  if (!apiKey.trim()) throw new Error('EXA_API_KEY is required');

  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchFn(EXA_CONTENTS_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ urls: [url], text: true }),
      });
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === FETCH_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }

    try {
      if ((response.status === 429 || response.status >= 500) && attempt < FETCH_RETRIES) {
        const wait = retryAfterMs(response) ?? 500 * (attempt + 1);
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      if (!response.ok) throw new Error(`Exa Contents returned ${response.status}`);
      const raw = await responseTextBounded(response);
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error('Exa Contents returned invalid JSON');
      }
      if (!data || typeof data !== 'object')
        throw new Error('Exa Contents returned an invalid payload');
      const payload = data as {
        results?: Array<{ id?: unknown; url?: unknown; text?: unknown }>;
        statuses?: Array<{ id?: unknown; status?: unknown }>;
      };
      const result = payload.results?.find((item) => item.url === url || item.id === url);
      const status = payload.statuses?.find((item) => item.id === url);
      if (status?.status !== 'success') {
        throw new Error(`Exa Contents status was ${String(status?.status ?? 'missing')}`);
      }
      if (!result || typeof result.url !== 'string' || !isPublicHttpsUrl(result.url)) {
        throw new Error('Exa Contents returned an unsafe or missing URL');
      }
      if (typeof result.text !== 'string' || !result.text.trim()) {
        throw new Error('Exa Contents returned empty article text');
      }
      return { url: result.url, text: result.text };
    } catch (error) {
      lastError = error;
      if (attempt === FETCH_RETRIES) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Exa Contents request failed');
}
