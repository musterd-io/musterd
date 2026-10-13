import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  budgetRefusal,
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
afterEach(async () => {
  await gw?.close();
  gw = undefined;
  await new Promise<void>((r) => (up ? up.close(() => r()) : r()));
  up = undefined;
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
    const f = await fakeUpstream(() => ({ body: anthropicJson(10, 10, 'muse-spark-1.3') }));
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

  it('budgetRefusal names the lease, the spend and the budget without any credential', () => {
    const body = JSON.parse(budgetRefusal('L9', 1, 1.5, 3)) as { error: { message: string } };
    expect(body.error.message).toContain('lease L9');
    expect(body.error.message).toContain('1.5000');
  });
});
