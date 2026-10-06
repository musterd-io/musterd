import {
  CalendarDeleteResponseSchema,
  CalendarListSchema,
  CalendarWriteResponseSchema,
  type CalendarEntryInput,
  type CalendarList,
  type CalendarWriteResponse,
} from '@musterd/protocol/calendar';
import { ErrorBodySchema } from '@musterd/protocol/errors';

/**
 * The phone's wire client for the Team's calendar (ADR 519 §3, SPEC A.16). The same four routes
 * `musterd calendar` uses, the same bearer credential shape (a human's `mscr_`, ADR 446), and every
 * response parsed through the protocol's schemas at the boundary (hard rule 4).
 */

/** Where the daemon is and who is asking. The server URL is a setting, never compiled in (ADR 520 §5). */
export interface Connection {
  /** e.g. `http://laptop.tailnet.ts.net:4849` — no trailing slash. */
  server: string;
  team: string;
  /** The Member's `mscr_` credential, read from the Keychain. */
  credential: string;
}

/** A refusal the daemon answered (`status` > 0) or a request that never reached it (`status` 0). */
export class CalendarApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when the daemon could not be reached. */
    readonly status: number,
    /** The protocol error code when the daemon sent one. */
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'CalendarApiError';
  }

  /** True when the daemon was never reached — the phone is offline or the laptop asleep. */
  get unreachable(): boolean {
    return this.status === 0;
  }
}

/** Trim, drop trailing slashes, and refuse anything that is not an http(s) origin. */
export function normalizeServerUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(s)) {
    throw new Error('server must be an http(s) address like http://laptop.tailnet.ts.net:4849');
  }
  return s;
}

export interface CalendarApi {
  list(since?: number): Promise<CalendarList>;
  create(body: CalendarEntryInput): Promise<CalendarWriteResponse>;
  replace(id: string, body: CalendarEntryInput): Promise<CalendarWriteResponse>;
  remove(id: string): Promise<void>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function createCalendarApi(conn: Connection, fetchImpl: Fetch = fetch): CalendarApi {
  const base = `${normalizeServerUrl(conn.server)}/teams/${encodeURIComponent(conn.team)}/calendar`;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${conn.credential}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new CalendarApiError(
        `could not reach ${conn.server} (${err instanceof Error ? err.message : String(err)})`,
        0,
        null,
      );
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      // A non-JSON body (a proxy's HTML page, say) falls through to the status-only error below.
    }
    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(json);
      if (parsed.success) {
        throw new CalendarApiError(parsed.data.error.message, res.status, parsed.data.error.code);
      }
      throw new CalendarApiError(`the daemon answered ${res.status}`, res.status, null);
    }
    return json;
  }

  return {
    async list(since) {
      return CalendarListSchema.parse(
        await request('GET', since === undefined ? '' : `?since=${since}`),
      );
    },
    async create(body) {
      return CalendarWriteResponseSchema.parse(await request('POST', '', body));
    },
    async replace(id, body) {
      return CalendarWriteResponseSchema.parse(
        await request('PUT', `/${encodeURIComponent(id)}`, body),
      );
    },
    async remove(id) {
      CalendarDeleteResponseSchema.parse(await request('DELETE', `/${encodeURIComponent(id)}`));
    },
  };
}
