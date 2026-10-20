import { SpanStatusCode, trace } from '@opentelemetry/api';

const SCOPE = 'musterd';

/**
 * Redact member-named and seat-named URL path segments before stamping `url.path` on an OTel span
 * (ADR 678 §4): `redactPath` in `log.ts` already strips credentials and `/mcp/*` tokens; this
 * additionally replaces the member/seat segment under `/members/<name>` (except the literal `me`
 * and `agents` sub-resource roots, while `/members/agents/<name>` redacts `<name>`),
 * `/trace/seats/<seat>`, and `/nodes/bindings/<seat>` with `[seat]`, so seat/member names are
 * never exported in HTTP span paths.
 */
export function redactSpanPath(path: string): string {
  return path
    .replace(/(\/members\/agents\/)[^/]+/g, '$1[seat]')
    .replace(/(\/members\/)(?!(?:me|agents)(?:\/|$))[^/]+/g, '$1[seat]')
    .replace(/(\/trace\/seats\/)[^/]+/g, '$1[seat]')
    .replace(/(\/nodes\/bindings\/)[^/]+/g, '$1[seat]');
}

/**
 * Cloud 6 HTTP request tracing + error tracking (ADR 678; spec §7 + §10).
 *
 * Wraps an HTTP request in a `musterd.http.request` span so every Cloud request produces a trace
 * carrying structural attributes only (`http.request.method`, `url.path` with credentials and
 * seat/member segments redacted via {@link redactSpanPath}, `musterd.team` when path-scoped,
 * `http.response.status_code`) — never message bodies, Act text, headers, query strings,
 * credentials, or seat names.
 *
 * When a route throws or answers 5xx, {@link recordHttpException} records the exception on the
 * active span (`exception.type`, `exception.message`, `exception.stacktrace`) and sets
 * `SpanStatusCode.ERROR`, so both the request trace and the thrown error are visible at the
 * configured OTLP vendor without a second error-tracking SDK. When telemetry is off (self-hosted
 * default), `@opentelemetry/api` calls are no-ops.
 */
export async function withHttpRequestSpan<T>(
  attrs: {
    method: string;
    path: string;
    team?: string | null;
    mode: 'self-hosted' | 'cloud';
  },
  getStatus: () => number,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(SCOPE);
  const safePath = redactSpanPath(attrs.path);
  return await tracer.startActiveSpan('musterd.http.request', async (span) => {
    span.setAttribute('http.request.method', attrs.method);
    span.setAttribute('url.path', safePath);
    span.setAttribute('musterd.mode', attrs.mode);
    if (attrs.team) span.setAttribute('musterd.team', attrs.team);
    try {
      const result = await fn();
      const status = getStatus();
      span.setAttribute('http.response.status_code', status);
      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      return result;
    } catch (err) {
      recordHttpException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Record an unhandled or 5xx error on the active span (ADR 678 §3). Safe when no span is active
 * (telemetry off) and when `err` is not an `Error` instance.
 */
export function recordHttpException(err: unknown, httpStatus = 500): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setAttribute('http.response.status_code', httpStatus);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}
