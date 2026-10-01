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

/** Poll quickly while down (recovery is automatic, so the banner should clear soon after). */
export function healthPollMs(reason: string | null): number {
  return reason ? 5_000 : 30_000;
}

/** The current outage sentence, or null. A failed fetch is not an outage claim: it shows nothing. */
export function useServerHealth(): string | null {
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next: string | null = null;
      try {
        const r = await fetch('/health', { signal: AbortSignal.timeout(2500) });
        next = healthReason(r.status, await r.json().catch(() => null));
      } catch {
        next = null;
      }
      if (!alive) return;
      setReason(next);
      timer = setTimeout(() => void tick(), healthPollMs(next));
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return reason;
}
