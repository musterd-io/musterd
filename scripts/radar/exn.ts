import { FETCH_RETRIES, FETCH_TIMEOUT_MS } from './config.ts';
import type { FetchFn } from './fetch.ts';

const EXN_SCRIPT_URL = 'https://ingest.sandrise.io/v1/episodes';
const EXN_MIN_REQUEST_INTERVAL_MS = 700;
const MAX_RESPONSE_BYTES = 2_000_000;

let lastScriptRequestAt = 0;
let scriptRequestQueue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function responseTextBounded(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Exploring Next script exceeds the configured response limit');
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
        throw new Error('Exploring Next script exceeds the configured response limit');
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

async function pacedFetch(url: string, init: RequestInit, fetchFn: FetchFn): Promise<Response> {
  const task = scriptRequestQueue.then(async () => {
    const waitMs = Math.max(0, EXN_MIN_REQUEST_INTERVAL_MS - (Date.now() - lastScriptRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    lastScriptRequestAt = Date.now();
    return fetchFn(url, init);
  });
  scriptRequestQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** Retrieve the complete ordered dialogue for an Exploring Next episode. */
export async function fetchEpisodeScript(
  episodeId: string,
  apiKey: string,
  fetchFn: FetchFn = fetch,
): Promise<{ url: string; text: string }> {
  if (!episodeId.trim()) throw new Error('Exploring Next episode ID is required');
  if (!apiKey.trim()) throw new Error('EXPLORING_API_KEY is required');
  const url = `${EXN_SCRIPT_URL}/${encodeURIComponent(episodeId)}/script`;

  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await pacedFetch(
        url,
        {
          method: 'GET',
          signal: controller.signal,
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        },
        fetchFn,
      );
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt === FETCH_RETRIES) break;
      await sleep(500 * (attempt + 1));
      continue;
    }

    try {
      if ((response.status === 429 || response.status >= 500) && attempt < FETCH_RETRIES) {
        const waitMs = retryAfterMs(response) ?? 500 * (attempt + 1);
        await response.body?.cancel();
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) throw new Error(`Exploring Next script returned ${response.status}`);
      let payload: unknown;
      try {
        payload = JSON.parse(await responseTextBounded(response));
      } catch (error) {
        if (error instanceof Error && error.message.includes('response limit')) throw error;
        throw new Error('Exploring Next script returned invalid JSON');
      }
      if (!payload || typeof payload !== 'object') {
        throw new Error('Exploring Next script returned an invalid payload');
      }
      const segments = (payload as { segments?: unknown }).segments;
      if (!Array.isArray(segments) || segments.length === 0) {
        throw new Error('Exploring Next script has no dialogue segments');
      }
      const lines: string[] = [];
      for (const segment of segments) {
        if (
          !segment ||
          typeof segment !== 'object' ||
          typeof (segment as { speaker?: unknown }).speaker !== 'string' ||
          typeof (segment as { text?: unknown }).text !== 'string' ||
          !(segment as { speaker: string }).speaker.trim() ||
          !(segment as { text: string }).text.trim()
        ) {
          throw new Error('Exploring Next script contains an invalid dialogue segment');
        }
        lines.push(
          `${(segment as { speaker: string }).speaker.trim()}: ${(segment as { text: string }).text.trim()}`,
        );
      }
      return { url, text: lines.join('\n\n') };
    } catch (error) {
      lastError = error;
      if (attempt === FETCH_RETRIES) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Exploring Next script request failed');
}
