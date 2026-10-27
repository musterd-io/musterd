import {
  createServer,
  get as httpGet,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  budgetRefusal,
  defaultUpstreams,
  normaliseUsage,
  startMeteringGateway,
  UsageParser,
  type MeteredCall,
  type MeteringGateway,
} from './gateway.js';

/**
 * ADR 583: the gateway relays bytes unchanged, reads only the usage block, prices from the table,
 * refuses on budget, and keeps no credential. A fake upstream on loopback plays the provider.
 */

interface Seen {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

function fakeUpstream(
  reply: (seen: Seen) => {
    status?: number;
    headers?: Record<string, string>;
    body: string | string[];
  },
): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      const s = { path: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status ?? 200, r.headers ?? { 'content-type': 'application/json' });
      if (Array.isArray(r.body)) {
        for (const chunk of r.body) res.write(chunk);
        res.end();
      } else res.end(r.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${String(port)}`, seen });
    });
  });
}

function post(
  base: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = request(
      u,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (d: Buffer) => (data += d.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const anthropicJson = (input: number, output: number, model = 'claude-haiku-5-5') =>
  JSON.stringify({
    id: 'msg_1',
    type: 'message',
    model,
    content: [{ type: 'text', text: 'hi' }],
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });

const anthropicSse = (model = 'claude-haiku-5-5') => [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 } } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'usage is a word in content' } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } })}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];

let gw: MeteringGateway | undefined;
let up: Server | undefined;
let extraUps: Server[] = [];
afterEach(async () => {
  await gw?.close();
  gw = undefined;
  await new Promise<void>((r) => (up ? up.close(() => r()) : r()));
  up = undefined;
  await Promise.all(extraUps.map((server) => new Promise<void>((r) => server.close(() => r()))));
  extraUps = [];
});

describe('normaliseUsage — one shape across vendors', () => {
  it('Anthropic: input excludes the cache; cache fields carried', () => {
    expect(
      normaliseUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 2,
      }),
    ).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 2,
    });
  });
  it('OpenAI Responses: cached tokens are split OUT of input_tokens', () => {
    expect(
      normaliseUsage({
        input_tokens: 100,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 60 },
      }),
    ).toEqual({ input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 60 });
  });
  it('chat completions: prompt/completion naming, cached split out', () => {
    expect(
      normaliseUsage({
        prompt_tokens: 100,
        completion_tokens: 9,
        prompt_tokens_details: { cached_tokens: 30 },
      }),
    ).toEqual({ input_tokens: 70, output_tokens: 9, cache_read_input_tokens: 30 });
  });
  it('not a usage object → null', () => {
    expect(normaliseUsage({ foo: 1 })).toBeNull();
    expect(normaliseUsage('x')).toBeNull();
  });
});

describe('UsageParser', () => {
  it('folds an Anthropic SSE stream: input from message_start, output from message_delta', () => {
    const p = new UsageParser(true);
    for (const chunk of anthropicSse()) p.push(Buffer.from(chunk));
    expect(p.result()).toEqual({
      usage: {
        input_tokens: 1000,
        output_tokens: 50,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 100,
      },
      model: 'claude-haiku-5-5',
    });
  });
  it('survives a chunk boundary inside a data line', () => {
    const whole = anthropicSse().join('');
    const p = new UsageParser(true);
    for (let i = 0; i < whole.length; i += 7) p.push(Buffer.from(whole.slice(i, i + 7)));
    expect(p.result().usage?.output_tokens).toBe(50);
  });
  it('reads an OpenAI Responses stream from response.completed', () => {
    const p = new UsageParser(true);
    p.push(
      Buffer.from(
        `data: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-5.6-luna', usage: { input_tokens: 300, output_tokens: 20, input_tokens_details: { cached_tokens: 100 } } } })}\n\n`,
      ),
    );
    expect(p.result()).toEqual({
      usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 100 },
      model: 'gpt-5.6-luna',
    });
  });
  it('with no content type, sniffs SSE from the body, across a chunk boundary (lane 01M4VQ3CMR)', () => {
    const completed = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6-luna', usage: { input_tokens: 14226, output_tokens: 5, input_tokens_details: { cached_tokens: 12288 } } } })}\n\n`;
    const p = new UsageParser(undefined);
    p.push(Buffer.from('\n'));
    p.push(Buffer.from(completed.slice(0, 3)));
    p.push(Buffer.from(completed.slice(3)));
    expect(p.result()).toEqual({
      usage: { input_tokens: 1938, output_tokens: 5, cache_read_input_tokens: 12288 },
      model: 'gpt-6-luna',
    });
    const j = new UsageParser(undefined);
    j.push(Buffer.from(anthropicJson(12, 3)));
    expect(j.result().usage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });
  it('reads a JSON body at result()', () => {
    const p = new UsageParser(false);
    p.push(Buffer.from(anthropicJson(12, 3)));
    expect(p.result()).toEqual({
      usage: { input_tokens: 12, output_tokens: 3 },
      model: 'claude-haiku-5-5',
    });
  });
});

describe('startMeteringGateway (ADR 583)', () => {
  it('includes the OpenRouter upstream for wake-scoped OpenCode routing', () => {
    expect(defaultUpstreams().find((upstream) => upstream.name === 'openrouter')).toMatchObject({
      url: 'https://openrouter.ai/api/v1',
    });
  });

  it('meters an SSE stream the upstream sends with no content-type (ChatGPT backend, lane 01M4VQ3CMR)', async () => {
    const f = await fakeUpstream(() => ({
      headers: {},
      body: [
        'event: response.created\ndata: {"type":"response.created"}\n\n',
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-6-luna', usage: { input_tokens: 300, output_tokens: 20 } } })}\n\n`,
      ],
    }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L1',
      upstreams: [{ name: 'openai', url: f.url, envVar: 'OPENAI_BASE_URL' }],
    });
    const r = await post(gw.env['OPENAI_BASE_URL']!, '/responses', '{}');
    expect(r.status).toBe(200);
    expect(gw.summary()).toMatchObject({ calls: 1, unmetered: 0, models: ['gpt-6-luna'] });
  });

  it('relays a GET catalog read without counting it unmetered', async () => {
    const f = await fakeUpstream(() => ({ body: '{"models":[]}' }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L1',
      upstreams: [{ name: 'chatgpt', url: f.url }],
    });
    const r = await new Promise<number>((resolve) => {
      httpGet(`${gw!.origin}/chatgpt/models?client_version=1`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
    });
    expect(r).toBe(200);
    expect(gw.summary()).toMatchObject({ calls: 0, unmetered: 0 });
  });

  it('routes and meters a file-configured provider by origin, and puts no variable for it in env', async () => {
    const f = await fakeUpstream(() => ({
      body: JSON.stringify({
        model: 'minimax-m3.1-flash-free',
        usage: { prompt_tokens: 700, completion_tokens: 3 },
      }),
      headers: { 'content-type': 'application/json' },
    }));
    up = f.server;
    const calls: MeteredCall[] = [];
    gw = await startMeteringGateway({
      leaseId: 'L1',
      upstreams: [{ name: 'opencode-go', url: f.url }],
      onCall: (c) => calls.push(c),
    });
    expect(gw.env).toEqual({});
    expect(gw.origin).toBe(`http://127.0.0.1:${String(gw.port)}`);
    const r = await post(`${gw.origin}/opencode-go`, '/chat/completions', '{}');
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: 'opencode-go', model: 'minimax-m3.1-flash-free' });
    expect(calls[0]!.usage.input_tokens).toBe(700);
  });

  it('routes OpenRouter calls with usage enabled and accounts the reported cost', async () => {
    const f = await fakeUpstream(() => ({
      body: JSON.stringify({
        model: 'vendor/model-unknown-to-musterd',
        usage: { prompt_tokens: 1_000, completion_tokens: 100, cost: 0.2 },
      }),
      headers: { 'content-type': 'application/json' },
    }));
    up = f.server;
    const calls: MeteredCall[] = [];
    const logs: string[] = [];
    gw = await startMeteringGateway({
      leaseId: 'L-openrouter',
      budgetUsd: 0.1,
      upstreams: [{ name: 'openrouter', url: f.url }],
      onCall: (call) => calls.push(call),
      log: (line) => logs.push(line),
    });

    const first = await post(
      `${gw.origin}/openrouter`,
      '/chat/completions',
      JSON.stringify({
        model: 'vendor/model-unknown-to-musterd',
        messages: [],
        stream: true,
        stream_options: { vendor_option: 'keep' },
      }),
      { authorization: 'Bearer sk-or-secret' },
    );
    expect(first.status).toBe(200);
    expect(JSON.parse(f.seen[0]!.body)).toMatchObject({
      usage: { include: true },
      stream_options: { include_usage: true, vendor_option: 'keep' },
    });
    expect(f.seen[0]!.headers['authorization']).toBe('Bearer sk-or-secret');
    expect(calls).toMatchObject([
      {
        provider: 'openrouter',
        model: 'vendor/model-unknown-to-musterd',
        cost_usd: 0.2,
      },
    ]);

    const next = await post(
      `${gw.origin}/openrouter`,
      '/chat/completions',
      JSON.stringify({ model: 'vendor/model-unknown-to-musterd', messages: [] }),
      { authorization: 'Bearer sk-or-secret' },
    );
    expect(next.status).toBe(402);
    expect(f.seen).toHaveLength(1);
    expect(gw.summary()).toMatchObject({ calls: 1, cost_usd: 0.2, budget_exhausted: true });
    expect(logs.join('\n')).not.toContain('sk-or-secret');
  });

  it('uses the dated price table for a known OpenRouter model when usage.cost is absent', async () => {
    const f = await fakeUpstream(() => ({
      body: JSON.stringify({
        model: 'muse-spark-1.3',
        usage: { prompt_tokens: 1_000, completion_tokens: 100 },
      }),
      headers: { 'content-type': 'application/json' },
    }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L-openrouter-table-fallback',
      budgetUsd: 0.01,
      upstreams: [{ name: 'openrouter', url: f.url }],
    });

    const response = await post(
      `${gw.origin}/openrouter`,
      '/chat/completions',
      JSON.stringify({ model: 'muse-spark-1.3', messages: [] }),
    );
    expect(response.status).toBe(200);
    expect(gw.summary()).toMatchObject({ calls: 1, cost_usd: 0.001675, budget_exhausted: false });
  });

  it('blocks further budgeted OpenRouter calls when upstream omits cost and no price row exists', async () => {
    const f = await fakeUpstream(() => ({
      body: JSON.stringify({
        model: 'vendor/model-unknown-to-musterd',
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L-openrouter-unpriced',
      budgetUsd: 1,
      upstreams: [{ name: 'openrouter', url: f.url }],
    });
    const body = JSON.stringify({ model: 'vendor/model-unknown-to-musterd', messages: [] });
    expect((await post(`${gw.origin}/openrouter`, '/chat/completions', body)).status).toBe(200);
    expect(gw.summary().budget_exhausted).toBe(true);
    expect((await post(`${gw.origin}/openrouter`, '/chat/completions', body)).status).toBe(402);
    expect(f.seen).toHaveLength(1);
    expect(gw.summary()).toMatchObject({ calls: 1, cost_usd: undefined, budget_exhausted: true });
  });

  it('blocks every model route after an unpriced OpenRouter call exhausts a wake budget', async () => {
    const router = await fakeUpstream(() => ({
      body: JSON.stringify({
        model: 'vendor/model-unknown-to-musterd',
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    }));
    const anthropic = await fakeUpstream(() => ({ body: anthropicJson(1, 1) }));
    up = router.server;
    extraUps.push(anthropic.server);
    const calls: MeteredCall[] = [];
    gw = await startMeteringGateway({
      leaseId: 'L-openrouter-unpriced-cross-provider',
      budgetUsd: 1,
      upstreams: [
        { name: 'openrouter', url: router.url },
        { name: 'anthropic', url: anthropic.url },
      ],
      onCall: (call) => calls.push(call),
    });
    const openRouterBody = JSON.stringify({
      model: 'vendor/model-unknown-to-musterd',
      messages: [],
    });
    expect(
      (await post(`${gw.origin}/openrouter`, '/chat/completions', openRouterBody)).status,
    ).toBe(200);
    expect((await post(`${gw.origin}/anthropic`, '/v1/messages', '{}')).status).toBe(402);
    expect(router.seen).toHaveLength(1);
    expect(anthropic.seen).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('does not exhaust the budget for an OpenRouter catalog GET without usage', async () => {
    const f = await fakeUpstream(() => ({ body: '{}' }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L-openrouter-catalog',
      budgetUsd: 1,
      upstreams: [{ name: 'openrouter', url: f.url }],
    });
    const response = await new Promise<number>((resolve, reject) => {
      const request = httpGet(`${gw!.origin}/openrouter/models`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      request.on('error', reject);
    });
    expect(response).toBe(200);
    expect(gw.summary().budget_exhausted).toBe(false);
  });

  it('reads OpenRouter reported cost from the final SSE usage chunk', async () => {
    const model = 'vendor/model-from-router';
    const f = await fakeUpstream(() => ({
      headers: { 'content-type': 'text/event-stream' },
      body: [
        `data: ${JSON.stringify({ model, choices: [{ delta: { content: 'done' } }] })}\n\n`,
        `data: ${JSON.stringify({ model, usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.004 } })}\n\n`,
        'data: [DONE]\n\n',
      ],
    }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L-openrouter-sse',
      upstreams: [{ name: 'openrouter', url: f.url }],
    });
    const response = await post(
      `${gw.origin}/openrouter`,
      '/chat/completions',
      JSON.stringify({ model, messages: [], stream: true }),
    );
    expect(response.status).toBe(200);
    expect(gw.summary()).toMatchObject({
      calls: 1,
      models: [model],
      usage: { input_tokens: 12, output_tokens: 3 },
      cost_usd: 0.004,
    });
  });

  it('rejects a non-JSON OpenRouter request before it reaches the provider', async () => {
    const f = await fakeUpstream(() => ({ body: '{}' }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L-openrouter-invalid',
      upstreams: [{ name: 'openrouter', url: f.url }],
    });
    const response = await post(`${gw.origin}/openrouter`, '/chat/completions', '{bad json');
    expect(response.status).toBe(400);
    expect(f.seen).toHaveLength(0);
  });

  it('relays a JSON call unchanged, forwards headers byte-for-byte, meters and prices it', async () => {
    const f = await fakeUpstream(() => ({
      body: anthropicJson(1000, 100),
      headers: { 'content-type': 'application/json', 'x-upstream': 'yes' },
    }));
    up = f.server;
    const calls: MeteredCall[] = [];
    gw = await startMeteringGateway({
      leaseId: 'L1',
      upstreams: [{ name: 'anthropic', url: f.url, envVar: 'ANTHROPIC_BASE_URL' }],
      onCall: (c) => calls.push(c),
    });
    expect(gw.env).toEqual({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(gw.port)}/anthropic` });
    const r = await post(
      gw.env['ANTHROPIC_BASE_URL']!,
      '/v1/messages',
      '{"model":"claude-haiku-5-5"}',
      {
        authorization: 'Bearer sk-ant-oat-SECRET',
        'x-api-key': 'sk-ant-SECRET',
        'anthropic-version': '2023-06-01',
      },
    );
    expect(r.status).toBe(200);
    expect(r.body).toBe(anthropicJson(1000, 100));
    expect(r.headers['x-upstream']).toBe('yes');
    const seen = f.seen[0]!;
    expect(seen.path).toBe('/v1/messages');
    expect(seen.body).toBe('{"model":"claude-haiku-5-5"}');
    // Credentials pass through untouched — and are never read into the gateway's own state.
    expect(seen.headers['authorization']).toBe('Bearer sk-ant-oat-SECRET');
    expect(seen.headers['x-api-key']).toBe('sk-ant-SECRET');
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen.headers['accept-encoding']).toBeUndefined();
    expect(calls).toEqual([
      {
        turn: 1,
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        usage: { input_tokens: 1000, output_tokens: 100 },
        cost_usd: (1000 * 0.1 + 100 * 0.5) / 1e6,
        status: 200,
      },
    ]);
    const s = gw.summary();
    expect(s.calls).toBe(1);
    expect(s.cost_usd).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6, 9);
    expect(s.floor_tokens).toBe(1000);
    expect(s.models).toEqual(['claude-haiku-5-5']);
    expect(JSON.stringify(s)).not.toContain('SECRET');
  });

  it('relays an SSE stream chunk-for-chunk and meters it from message_start + message_delta', async () => {
    const f = await fakeUpstream(() => ({
      body: anthropicSse(),
      headers: { 'content-type': 'text/event-stream' },
    }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L2',
      upstreams: [{ name: 'anthropic', url: f.url, envVar: 'ANTHROPIC_BASE_URL' }],
    });
    const r = await post(gw.env['ANTHROPIC_BASE_URL']!, '/v1/messages', '{}');
    expect(r.body).toBe(anthropicSse().join(''));
    const s = gw.summary();
    expect(s.usage).toEqual({
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 100,
    });
    expect(s.floor_tokens).toBe(1500);
  });

  it('a model with no price row is metered but not priced: summary cost undefined', async () => {
    const f = await fakeUpstream(() => ({ body: anthropicJson(10, 10, 'muse-spark-9-9') }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L3',
      upstreams: [{ name: 'xai', url: f.url, envVar: 'XAI_BASE_URL' }],
    });
    await post(gw.env['XAI_BASE_URL']!, '/responses', '{}');
    const s = gw.summary();
    expect(s.calls).toBe(1);
    expect(s.cost_usd).toBeUndefined();
    expect(s.usage.input_tokens).toBe(10);
  });

  it('refuses the NEXT call once spend reaches budget_usd (402, no retry shape), never the one in flight', async () => {
    const f = await fakeUpstream(() => ({ body: anthropicJson(1_000_000, 0) })); // $0.10 per call on haiku-5-5
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L4',
      budgetUsd: 0.15,
      upstreams: [{ name: 'anthropic', url: f.url, envVar: 'ANTHROPIC_BASE_URL' }],
    });
    const base = gw.env['ANTHROPIC_BASE_URL']!;
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200); // spent 0.10 < 0.15
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200); // spent 0.20 ≥ 0.15 after
    const refused = await post(base, '/v1/messages', '{}');
    expect(refused.status).toBe(402);
    expect(JSON.parse(refused.body)).toMatchObject({
      type: 'error',
      error: { code: 'musterd_budget_exhausted' },
    });
    expect(f.seen).toHaveLength(2); // the refused call never reached the provider
    const s = gw.summary();
    expect(s.calls).toBe(2);
    expect(s.refused).toBe(1);
    expect(s.budget_exhausted).toBe(true);
    expect(s.cost_usd).toBeCloseTo(0.2, 9);
  });

  it('an unknown provider prefix answers 404 and meters nothing', async () => {
    gw = await startMeteringGateway({ leaseId: 'L5', upstreams: [] });
    const r = await post(`http://127.0.0.1:${String(gw.port)}`, '/nope/v1/messages', '{}');
    expect(r.status).toBe(404);
    expect(gw.summary().calls).toBe(0);
  });

  it('an error status is relayed and not metered; an unreachable upstream answers 502', async () => {
    const f = await fakeUpstream(() => ({
      status: 429,
      body: '{"type":"error","error":{"type":"rate_limit_error"}}',
    }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L6',
      upstreams: [
        { name: 'anthropic', url: f.url, envVar: 'ANTHROPIC_BASE_URL' },
        { name: 'openai', url: 'http://127.0.0.1:1', envVar: 'OPENAI_BASE_URL' },
      ],
    });
    expect((await post(gw.env['ANTHROPIC_BASE_URL']!, '/v1/messages', '{}')).status).toBe(429);
    expect((await post(gw.env['OPENAI_BASE_URL']!, '/responses', '{}')).status).toBe(502);
    expect(gw.summary().calls).toBe(0);
  });

  it('close waits for a response still in flight, and summary counts that call once', async () => {
    let release: () => void = () => undefined;
    const seen = new Promise<void>((resolve) => {
      up = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(anthropicSse().slice(0, 3).join(''));
        release = () => res.end();
        resolve();
      });
    });
    await new Promise<void>((resolve) => up!.listen(0, '127.0.0.1', () => resolve()));
    const addr = up!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const calls: MeteredCall[] = [];
    gw = await startMeteringGateway({
      leaseId: 'L-drain',
      drainMs: 2_000,
      upstreams: [
        {
          name: 'anthropic',
          url: `http://127.0.0.1:${String(port)}`,
          envVar: 'ANTHROPIC_BASE_URL',
        },
      ],
      onCall: (c) => calls.push(c),
    });
    const pending = post(gw.env['ANTHROPIC_BASE_URL']!, '/v1/messages', '{}');
    await seen;
    const closing = gw.close();
    release();
    await closing;
    await pending;
    expect(gw.summary().calls).toBe(1);
    expect(gw.summary().usage).toEqual({
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 100,
    });
    expect(gw.summary().cost_usd).toBeTypeOf('number');
    expect(calls).toHaveLength(1);
    await gw.close();
    expect(gw.summary().calls).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('close meters usage already parsed when the upstream never ends, once', async () => {
    let inbound: ServerResponse | undefined;
    const seen = new Promise<void>((resolve) => {
      up = createServer((req, res) => {
        inbound = res;
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(anthropicSse().slice(0, 3).join(''));
        resolve();
      });
    });
    await new Promise<void>((resolve) => up!.listen(0, '127.0.0.1', () => resolve()));
    const addr = up!.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const calls: MeteredCall[] = [];
    gw = await startMeteringGateway({
      leaseId: 'L-sweep',
      drainMs: 200,
      upstreams: [
        {
          name: 'anthropic',
          url: `http://127.0.0.1:${String(port)}`,
          envVar: 'ANTHROPIC_BASE_URL',
        },
      ],
      onCall: (c) => calls.push(c),
    });
    let got = false;
    const req = request(
      gw.env['ANTHROPIC_BASE_URL']! + '/v1/messages',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.on('data', () => {
          got = true;
        });
        res.on('error', () => undefined);
      },
    );
    req.on('error', () => undefined);
    req.end('{}');
    await seen;
    const deadline = Date.now() + 1_000;
    while (!got && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(got).toBe(true);
    await gw.close();
    inbound?.destroy();
    expect(gw.summary().calls).toBe(1);
    expect(gw.summary().usage.output_tokens).toBe(50);
    expect(calls).toHaveLength(1);
    await gw.close();
    expect(calls).toHaveLength(1);
  });

  it('budgetRefusal names the lease, the spend and the budget without any credential', () => {
    const body = JSON.parse(budgetRefusal('L9', 1, 1.5, 3)) as { error: { message: string } };
    expect(body.error.message).toContain('lease L9');
    expect(body.error.message).toContain('1.5000');
  });
});

describe('spend approval hold (ADR 636)', () => {
  async function until(cond: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async function boot(over: {
    budgetUsd?: number;
    spendApprovalUsd?: number;
    onSpendApproval?: (req: {
      leaseId: string;
      spentUsd: number;
      thresholdUsd: number;
      signal: AbortSignal;
    }) => Promise<'accept' | 'decline' | 'wake_ended'>;
    log?: (line: string) => void;
  }) {
    const f = await fakeUpstream(() => ({ body: anthropicJson(10, 0) }));
    up = f.server;
    gw = await startMeteringGateway({
      leaseId: 'L9',
      price: () => 0.1,
      upstreams: [{ name: 'anthropic', url: f.url, envVar: 'ANTHROPIC_BASE_URL' }],
      ...over,
    });
    return { f, base: gw.env['ANTHROPIC_BASE_URL']! };
  }

  it('forwards under the threshold and does not ask', async () => {
    let asked = 0;
    const { base } = await boot({
      spendApprovalUsd: 0.2,
      onSpendApproval: () => {
        asked += 1;
        return Promise.resolve('decline');
      },
    });
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200);
    expect(asked).toBe(0);
    expect(gw!.summary().approval_refused).toBe(0);
  });

  it('holds the next call at the threshold, asks once, and forwards it on accept', async () => {
    let asked = 0;
    let resolve: (v: 'accept') => void = () => undefined;
    const pending = new Promise<'accept'>((r) => {
      resolve = r;
    });
    const { f, base } = await boot({
      spendApprovalUsd: 0.1,
      onSpendApproval: (req) => {
        asked += 1;
        expect(req.spentUsd).toBeCloseTo(0.1, 9);
        expect(req.thresholdUsd).toBe(0.1);
        expect(req.leaseId).toBe('L9');
        return pending;
      },
    });
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200);
    const held = post(base, '/v1/messages', '{}', { authorization: 'Bearer sk-ant-oat-SECRET' });
    await until(() => asked === 1);
    expect(f.seen).toHaveLength(1);
    resolve('accept');
    const forwarded = await held;
    expect(forwarded.status).toBe(200);
    expect(f.seen).toHaveLength(2);
    expect(f.seen[1]!.headers['authorization']).toBe('Bearer sk-ant-oat-SECRET');
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200);
    expect(f.seen).toHaveLength(3);
    expect(asked).toBe(1);
    const s = gw!.summary();
    expect(s.budget_exhausted).toBe(false);
    expect(s.approval_refused).toBe(0);
    expect(s.refused).toBe(0);
    expect(JSON.stringify(s)).not.toContain('SECRET');
  });

  it('two calls waiting on the same threshold share one ask', async () => {
    let asked = 0;
    let resolve: (v: 'accept') => void = () => undefined;
    const pending = new Promise<'accept'>((r) => {
      resolve = r;
    });
    const { f, base } = await boot({
      spendApprovalUsd: 0.1,
      onSpendApproval: () => {
        asked += 1;
        return pending;
      },
    });
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200);
    const a = post(base, '/v1/messages', '{}');
    const b = post(base, '/v1/messages', '{}');
    await until(() => asked === 1);
    expect(f.seen).toHaveLength(1);
    resolve('accept');
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect(asked).toBe(1);
    expect(f.seen).toHaveLength(3);
  });

  it('decline answers 402 musterd_spend_approval_declined and forwards nothing further', async () => {
    let asked = 0;
    const lines: string[] = [];
    const { f, base } = await boot({
      spendApprovalUsd: 0.1,
      log: (line) => lines.push(line),
      onSpendApproval: () => {
        asked += 1;
        return Promise.resolve('decline');
      },
    });
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200);
    const first = await post(base, '/v1/messages', '{}');
    const second = await post(base, '/v1/messages', '{}');
    for (const refused of [first, second]) {
      expect(refused.status).toBe(402);
      expect(JSON.parse(refused.body)).toMatchObject({
        error: { code: 'musterd_spend_approval_declined' },
      });
      expect(refused.body).toContain('lease L9');
      expect(refused.body).toContain('0.1000');
    }
    expect(f.seen).toHaveLength(1);
    expect(asked).toBe(1);
    const s = gw!.summary();
    expect(s.approval_refused).toBe(2);
    expect(s.refused).toBe(0);
    expect(s.budget_exhausted).toBe(false);
    expect(lines.filter((l) => l.includes('spend approval declined'))).toHaveLength(1);
  });

  it('silence leaves the call held and does not forward it', async () => {
    let asked = 0;
    let release: (v: 'decline') => void = () => undefined;
    const pending = new Promise<'decline'>((r) => {
      release = r;
    });
    const { f, base } = await boot({
      spendApprovalUsd: 0.1,
      onSpendApproval: (req) => {
        asked += 1;
        req.signal.addEventListener('abort', () => release('decline'), { once: true });
        return pending;
      },
    });
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200);
    const held = post(base, '/v1/messages', '{}');
    await until(() => asked === 1);
    const raced = await Promise.race([
      held.then(() => 'settled' as const),
      new Promise<'held'>((r) => setTimeout(() => r('held'), 40)),
    ]);
    expect(raced).toBe('held');
    expect(f.seen).toHaveLength(1);
    expect(asked).toBe(1);
    release('decline');
    expect((await held).status).toBe(402);
  });

  it('close during the hold answers 402 and records that the wake ended', async () => {
    let asked = 0;
    const { f, base } = await boot({
      spendApprovalUsd: 0.1,
      onSpendApproval: (req) =>
        new Promise((resolve) => {
          asked += 1;
          req.signal.addEventListener('abort', () => resolve('wake_ended'), { once: true });
        }),
    });
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200);
    const held = post(base, '/v1/messages', '{}');
    await until(() => asked === 1);
    expect(f.seen).toHaveLength(1);
    await gw!.close();
    const body = await held;
    expect(body.status).toBe(402);
    expect(body.body).toContain('wake ended');
    expect(body.body).toContain('musterd_spend_approval_declined');
    const s = gw!.summary();
    expect(s.approval_wake_ended).toBe(true);
    expect(s.budget_exhausted).toBe(false);
    expect(s.refused).toBe(0);
    expect(s.approval_refused).toBe(1);
  });

  it('a thrown callback declines, and a threshold with no callback declines', async () => {
    const thrown = await boot({
      spendApprovalUsd: 0.1,
      onSpendApproval: () => Promise.reject(new Error('boom')),
    });
    expect((await post(thrown.base, '/v1/messages', '{}')).status).toBe(200);
    const refused = await post(thrown.base, '/v1/messages', '{}');
    expect(refused.status).toBe(402);
    expect(JSON.parse(refused.body).error.code).toBe('musterd_spend_approval_declined');
    expect(gw!.summary().budget_exhausted).toBe(false);
    await gw!.close();
    gw = undefined;
    await new Promise<void>((r) => thrown.f.server.close(() => r()));
    up = undefined;

    const bare = await boot({ spendApprovalUsd: 0.1 });
    expect((await post(bare.base, '/v1/messages', '{}')).status).toBe(200);
    const again = await post(bare.base, '/v1/messages', '{}');
    expect(again.status).toBe(402);
    expect(JSON.parse(again.body).error.code).toBe('musterd_spend_approval_declined');
  });

  it('the budget gate refuses before spend approval is asked', async () => {
    let asked = 0;
    const { f, base } = await boot({
      budgetUsd: 0.05,
      spendApprovalUsd: 0.1,
      onSpendApproval: () => {
        asked += 1;
        return Promise.resolve('accept');
      },
    });
    expect((await post(base, '/v1/messages', '{}')).status).toBe(200);
    const refused = await post(base, '/v1/messages', '{}');
    expect(refused.status).toBe(402);
    expect(JSON.parse(refused.body).error.code).toBe('musterd_budget_exhausted');
    expect(asked).toBe(0);
    expect(f.seen).toHaveLength(1);
    expect(gw!.summary().budget_exhausted).toBe(true);
    expect(gw!.summary().approval_refused).toBe(0);
  });
});
