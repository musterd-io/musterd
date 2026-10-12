import { CliError } from '../../errors.js';

/**
 * The one HTTP path every tracker source uses (spec 2026-10-11 §2, "Errors"): Node's built-in fetch,
 * one retry on 429/5xx, credentials refused as exit 2. A token travels only in `init.headers`, and no
 * message built here reads a header — so none can carry one.
 */
export interface TrackerHttp {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export const defaultHttp: TrackerHttp = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Missing or refused tracker credentials: exit 2 with the one-line fix. */
export class TrackerAuthError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'TrackerAuthError';
  }
}

export interface TrackerRequest {
  headers: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

export interface TrackerResponse {
  status: number;
  /** null for a 404/410 — whether that is "gone" or an error is the caller's call. */
  json: unknown;
  headers: Headers;
}

const RETRY_DEFAULT_MS = 2000;
const RETRY_CAP_MS = 30_000;

export async function getJson(
  http: TrackerHttp,
  url: string,
  init: TrackerRequest,
  ctx: { tracker: string; authFix: string },
): Promise<TrackerResponse> {
  let res = await send(http, url, init);
  if (retryable(res.status)) {
    await http.sleep(retryAfterMs(res.headers.get('retry-after')));
    res = await send(http, url, init);
    if (retryable(res.status))
      throw new CliError(
        `${ctx.tracker} answered ${String(res.status)} twice — try again in a minute`,
        1,
      );
  }
  if (res.status === 401 || res.status === 403)
    throw new TrackerAuthError(
      `${ctx.tracker} refused the credentials (${String(res.status)}) — ${ctx.authFix}`,
    );
  if (res.status === 404 || res.status === 410)
    return { status: res.status, json: null, headers: res.headers };
  if (!res.ok)
    throw new CliError(`${ctx.tracker} answered ${String(res.status)} for ${pathOf(url)}`, 1);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new CliError(`${ctx.tracker} sent a response that is not JSON (${pathOf(url)})`, 1);
  }
  return { status: res.status, json, headers: res.headers };
}

async function send(http: TrackerHttp, url: string, init: TrackerRequest): Promise<Response> {
  try {
    return await http.fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message;
    throw new CliError(`cannot reach ${new URL(url).host}: ${cause}`, 1);
  }
}

const retryable = (status: number) => status === 429 || status >= 500;

function retryAfterMs(header: string | null): number {
  const s = header === null ? NaN : Number(header);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, RETRY_CAP_MS) : RETRY_DEFAULT_MS;
}

/** The URL without its query: a query can carry a JQL or a cursor, never needed in an error. */
function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname}`;
}
