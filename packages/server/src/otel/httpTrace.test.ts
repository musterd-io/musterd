import { parseOtlpHeaders, resolveOtlpEndpoint } from '@musterd/telemetry';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordHttpException, withHttpRequestSpan } from './httpTrace.js';

describe('Cloud 6 OTel request tracing + error tracking (ADR 678)', () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(() => {
    context.disable();
    trace.disable();
  });

  it('resolves MUSTERD_OTLP_ENDPOINT and MUSTERD_OTLP_HEADERS while staying off when unset', () => {
    expect(resolveOtlpEndpoint({ MUSTERD_CONFIG: '/nonexistent/config.json' })).toBeUndefined();
    expect(
      resolveOtlpEndpoint({
        MUSTERD_OTLP_ENDPOINT: 'https://otlp.example.com',
        MUSTERD_OTLP_HEADERS: 'Authorization=Bearer tok,x-team=cloud',
      }),
    ).toEqual({
      endpoint: 'https://otlp.example.com',
      source: 'env',
      headers: { Authorization: 'Bearer tok', 'x-team': 'cloud' },
    });
    expect(parseOtlpHeaders(undefined)).toBeUndefined();
    expect(parseOtlpHeaders('   ')).toBeUndefined();
  });

  it('records a request span with method, redacted path, team, and status (never bodies)', async () => {
    let status = 200;
    const out = await withHttpRequestSpan(
      { method: 'GET', path: '/teams/revive/lanes', team: 'revive', mode: 'cloud' },
      () => status,
      async () => {
        status = 200;
        return 'ok';
      },
    );
    expect(out).toBe('ok');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('musterd.http.request');
    expect(span.attributes['http.request.method']).toBe('GET');
    expect(span.attributes['url.path']).toBe('/teams/revive/lanes');
    expect(span.attributes['musterd.team']).toBe('revive');
    expect(span.attributes['musterd.mode']).toBe('cloud');
    expect(span.attributes['http.response.status_code']).toBe(200);
    expect(span.status.code).toBe(1); // SpanStatusCode.OK
  });

  it('records a 5xx error as an exception event on the request span', async () => {
    let status = 500;
    await withHttpRequestSpan(
      { method: 'POST', path: '/teams/revive/messages', team: 'revive', mode: 'cloud' },
      () => status,
      async () => {
        recordHttpException(new Error('database pool exhausted'), 503);
        status = 503;
      },
    );
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.attributes['http.response.status_code']).toBe(503);
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
    const exc = span.events.find((e) => e.name === 'exception')!;
    expect(exc.attributes?.['exception.message']).toBe('database pool exhausted');
  });
});
