import type { ErrorCode } from '@musterd/protocol';

/** CLI error carrying a process exit code. Maps protocol error codes per 04-cli.md. */
export class CliError extends Error {
  readonly exitCode: number;
  /** The originating protocol error code, when this wraps a server error — lets callers branch on the
   * failure kind (e.g. treat `conflict` as idempotent) instead of matching the message or exit code. */
  readonly code: ErrorCode | undefined;
  constructor(message: string, exitCode: number, code?: ErrorCode) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

const CODE_EXIT: Record<ErrorCode, number> = {
  server_error: 1,
  bad_request: 2,
  validation: 3,
  unauthorized: 4,
  forbidden: 5,
  not_found: 6,
  conflict: 9,
  member_busy: 10,
  superseded: 11,
  version_mismatch: 1,
  // ADR 078 (SPEC A.8): a seat occupied at claim time reuses the 409/conflict exit (9); an expired
  // grant is an auth refusal (5). The claim command that emits these lands in the P3.3 cutover.
  claim_conflict: 9,
  expired_grant: 5,
  // Federation 3c (ADR 355): the hub could not be asked to arbitrate a claim. Its own exit so a
  // script can tell "refused" (9) from "could not be decided" — retry later, never claim anyway.
  hub_unreachable: 12,
  // ADR 328 §4 (ADR 355 amendment): the seat lives on another machine. Not a conflict (9) and not
  // "could not be decided" (12): the fix is an admin unbind or claiming from where the seat lives.
  bound_elsewhere: 13,
  // ADR 446 (remote MCP): the OAuth endpoint's per-IP bucket is empty. Like hub_unreachable (12)
  // this means "retry later" — its own exit so a script can tell "refused" from "come back".
  rate_limited: 14,
  // ADR 446 decline 2: the request body exceeded the endpoint's byte cap — "send less".
  payload_too_large: 15,
  // ADR 729: the operation must run on a Surface attached to the authority hub.
  hub_local_required: 16,
};

export function exitForCode(code: ErrorCode): number {
  return CODE_EXIT[code];
}

/**
 * Connection failures (daemon down or timed out) → exit 7.
 *
 * Deliberately broad: for *reporting* "can't reach the daemon", every one of these means the same
 * thing to a human. It is therefore the WRONG predicate for deciding whether to retry — see
 * {@link connectionNeverEstablished}.
 */
export function isConnRefused(err: unknown): boolean {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET|timed out|aborted/i.test(msg);
}

/**
 * Retry schedule for a request whose connection was refused (§ {@link connectionNeverEstablished}).
 *
 * A daemon bounce is a routine hole in HTTP availability, measured 2026-07-29 at **849ms** against a
 * throwaway daemon killed and relaunched the way `service refresh` does it. The auto-refresher has
 * driven that bounce **116 times** on the dogfood machine, every one through live sessions — its
 * quiet-period guard has never once deferred, because on a 12-seat box "some seat is connected" is
 * the steady state. The sum covers the measured outage about twice over while a daemon that is
 * genuinely stopped still fails in under two seconds. Mirrors the MCP adapter's schedule.
 *
 * Applied to WRITES only (§ {@link worthRetrying}).
 */
export const RETRY_DELAYS_MS = [250, 500, 1000];

/**
 * Only a write earns a retry. Losing an act is the damage; a lost read costs nothing, because the next
 * poll fetches it again.
 *
 * This matters most in the CLI, which is what the harness hooks invoke: `GET
 * /inbox/interrupt-check` runs at every tool boundary (ADR 088) in a fresh short-lived process, so an
 * in-process circuit breaker cannot help it. Retrying reads would therefore add the full retry budget
 * to every tool call for as long as the daemon stayed stopped.
 */
export function worthRetrying(method: string): boolean {
  return method !== 'GET';
}

/**
 * True only when the TCP connection was never established — the one case where re-sending is provably
 * safe, because the request never reached the server and so cannot have been acted on once already.
 *
 * A **reset** connection is excluded on purpose: it was live, the daemon may have processed the body
 * before dying, and re-posting would duplicate the act (a second message, a second lane claim).
 * Node's fetch gives refusal and reset the *same* `TypeError: fetch failed` message and puts the real
 * code only on `cause.code`, so this reads the cause where {@link isConnRefused} reads text and
 * cannot tell them apart.
 */
export function connectionNeverEstablished(err: unknown): boolean {
  return (err as { cause?: { code?: string } } | null | undefined)?.cause?.code === 'ECONNREFUSED';
}

/** Connect-phase codes: the request never left this machine, so the server cannot have acted. */
const NEVER_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * The transport failure a request ended in, as the human should read it. A WRITE that lost its
 * connection after it was established (a reset, a timeout, a socket the daemon dropped mid-reply)
 * may already have been processed, so "can't reach the server" would be a lie that invites a
 * duplicate re-run: say the outcome is unknown and how to check before trying again. A read, or a
 * write that never connected, is the plain unreachable error. Exit 7 either way — the connection
 * class. Undefined when `err` is not a transport failure; the caller rethrows it. Only the route's
 * path is named, never its query or body.
 */
export function transportError(
  err: unknown,
  method: string,
  server: string,
  path: string,
): CliError | undefined {
  const code = (err as { cause?: { code?: string } } | null | undefined)?.cause?.code;
  const transport = isConnRefused(err) || code !== undefined;
  if (!transport) return undefined;
  if (worthRetrying(method) && !(code !== undefined && NEVER_SENT.has(code))) {
    const route = path.split('?')[0];
    return new CliError(
      `${method} ${route} lost its connection to ${server} before the reply — the write may or may not have happened. ` +
        'Check before re-running it: `musterd status`, `musterd inbox --all`, or `musterd lane show <id>`.',
      7,
    );
  }
  return new CliError(
    `can't reach team server at ${server} — is the daemon running? (musterd serve)`,
    7,
  );
}

/** The two builds a schema mismatch is judged against (ADR 135), each when it is known. */
export interface Builds {
  cli?: string | undefined;
  daemon?: string | undefined;
}

/** What the builds say about a mismatch: skew to fix, a real bug, or where to look. */
function buildContext(b: Builds): string {
  const short = (ref: string) => ref.slice(0, 7);
  const same = (a: string, d: string) => a.replace(/-dirty$/, '') === d.replace(/-dirty$/, '');
  if (b.cli && b.daemon) {
    return same(b.cli, b.daemon)
      ? ` — the CLI and the daemon both run ${short(b.daemon)}, so this is a bug, not skew`
      : ` — your CLI build (${short(b.cli)}) differs from the daemon (${short(b.daemon)}): rebuild your checkout (pnpm build) or match the daemon`;
  }
  if (b.cli)
    return ` — CLI build ${short(b.cli)}; \`musterd status\` names the daemon's when they differ`;
  return ' — `musterd --version` and `musterd status` name the builds';
}

/**
 * A server response did not match the protocol schema. Names the operation and, when available,
 * the first failing field path (safe — no values, no secrets), then the builds: a stale client or a
 * daemon skew is the usual cause, so the message says whether the CLI and the daemon differ and how
 * to fix it, or that they match and this is a bug. Exit 1: the read failed; the caller decides
 * whether to retry. The error comes first: `fn('lanes', …)` is the shape `cli-flags:check` reads as
 * a flag read, and would hand every operation name to its callers.
 */
export function schemaError(err: unknown, operation: string, builds: Builds = {}): CliError {
  let detail = '';
  if (
    err &&
    typeof err === 'object' &&
    'issues' in err &&
    Array.isArray((err as { issues: unknown }).issues)
  ) {
    const issues = (err as { issues: Array<{ path?: unknown[]; message?: string }> }).issues;
    const first = issues[0];
    if (first) {
      const path = Array.isArray(first.path) && first.path.length ? first.path.join('.') : '';
      const msg = first.message ? `: ${first.message}` : '';
      detail = path ? ` (field: ${path}${msg})` : msg;
    }
  }
  return new CliError(
    `${operation} response did not match the protocol schema${detail}${buildContext(builds)}`,
    1,
  );
}
