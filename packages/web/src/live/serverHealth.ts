import { useEffect, useState } from 'react';

/**
 * The server's own word on whether it can serve (cloud spec §5.5 / §7). A Cloud server answers
 * `/health` with `{ok:true}` or a 503 `{ok:false, reason}` whose reason is one STABLE SENTENCE
 * ("database unreachable"); `/live` shows that sentence, verbatim, until the server recovers.
 * Self-hosted daemons answer 200 with a detailed body, so they never raise the banner.
 */
export function healthReason(status: number, body: unknown): string | null {
  if (status !== 503 || typeof body !== 'object' || body === null) return null;
  const { ok, reason } = body as { ok?: unknown; reason?: unknown };
  return ok === false && typeof reason === 'string' && reason ? reason : null;
}

/**
 * When to ask `/health` again, or null to stop. Only a Cloud server can answer the outage shape,
 * and its body is exactly `{ok}` (+ `reason`). A self-hosted daemon answers a detailed body (`v`,
 * `db`, counts — and computing it is not free), so once one has answered there is nothing to watch
 * for: polling stops. Unknown (a network failure, a proxy page) keeps a slow poll. While down, poll
 * quickly so the banner clears soon after the automatic recovery.
 */
export function healthPollAfter(status: number, body: unknown): number | null {
  if (healthReason(status, body)) return 5_000;
  const selfHosted = status === 200 && typeof body === 'object' && body !== null && 'v' in body;
  return selfHosted ? null : 30_000;
}

/** The current outage sentence, or null. A failed fetch is not an outage claim: it shows nothing. */
export function useServerHealth(): string | null {
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let status = 0;
      let body: unknown = null;
      try {
        const r = await fetch('/health', { signal: AbortSignal.timeout(2500) });
        status = r.status;
        body = await r.json().catch(() => null);
      } catch {
        // a failed fetch is not an outage claim: it shows nothing and keeps a slow poll
      }
      if (!alive) return;
      setReason(healthReason(status, body));
      const after = healthPollAfter(status, body);
      if (after !== null) timer = setTimeout(() => void tick(), after);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return reason;
}
