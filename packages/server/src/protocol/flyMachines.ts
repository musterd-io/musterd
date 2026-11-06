/**
 * The Fly Machines API client the fly watch spends (ADR 816) — three calls, one fixed origin.
 *
 * Kept apart from `flyWatch.ts` so the watch's decisions are testable against a fake of this
 * interface and the wire shape has exactly one home. The token is the ADR 816 rule-2 credential:
 * it is passed in per client, sent only as a bearer header to `api.machines.dev`, and never
 * logged — errors carry the HTTP status and Fly's error string, never headers.
 */

export interface FlyMachines {
  /** The machine's state (`started`, `stopped`, …), or null when Fly does not know it (404). */
  machineState(app: string, machine: string): Promise<string | null>;
  startMachine(app: string, machine: string): Promise<void>;
  stopMachine(app: string, machine: string): Promise<void>;
}

/** A failed Fly call. `status` is the HTTP status, or 0 when no response arrived. */
export class FlyApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FlyApiError';
    this.status = status;
  }
}

const FLY_API = 'https://api.machines.dev/v1';

export function flyMachinesClient(token: string, fetchImpl: typeof fetch = fetch): FlyMachines {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  async function call(app: string, machine: string, method: string, path: string) {
    let res: Response;
    try {
      res = await fetchImpl(`${FLY_API}/apps/${app}/machines/${machine}${path}`, {
        method,
        headers,
      });
    } catch (e) {
      throw new FlyApiError(0, e instanceof Error ? e.message : String(e));
    }
    const body = (await res.json().catch(() => ({}))) as { state?: unknown; error?: unknown };
    if (!res.ok) {
      throw new FlyApiError(
        res.status,
        `fly ${method} ${app}/${machine}${path} → ${res.status} ${typeof body.error === 'string' ? body.error : ''}`.trim(),
      );
    }
    return body;
  }
  return {
    async machineState(app, machine) {
      try {
        const body = await call(app, machine, 'GET', '');
        return typeof body.state === 'string' ? body.state : null;
      } catch (e) {
        if (e instanceof FlyApiError && e.status === 404) return null;
        throw e;
      }
    },
    async startMachine(app, machine) {
      await call(app, machine, 'POST', '/start');
    },
    async stopMachine(app, machine) {
      await call(app, machine, 'POST', '/stop');
    },
  };
}
