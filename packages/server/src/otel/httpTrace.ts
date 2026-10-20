import { SpanStatusCode, trace } from '@opentelemetry/api';

const SCOPE = 'musterd';

/**
 * Cloud 6 HTTP request tracing + error tracking (ADR 678; spec §7 + §10).
 *
 * Wraps an HTTP request in a `musterd.http.request` span so every Cloud request produces a trace
 * carrying structural attributes only (`http.request.method`, `url.path` redacted, `musterd.team`
 * when path-scoped, `http.response.status_code`) — never message bodies, Act text, headers, query
 * strings or credentials.
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
  return await tracer.startActiveSpan('musterd.http.request', async (span) => {
    span.setAttribute('http.request.method', attrs.method);
    span.setAttribute('url.path', attrs.path);
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
