import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { priceUsage, type UsageLike } from './prices.js';

/**
 * The metering gateway (ADR 583): a loopback, per-wake, pass-through HTTP proxy the host points a
 * woken harness at through the base-URL variable that harness documents. Every request is
 * forwarded to the real provider unchanged and every response relayed unchanged (streaming
 * included); the gateway reads only the provider's usage block and model id as the bytes pass,
 * prices them from the host's table, and refuses the next call once the wake's `budget_usd` is
 * spent (§4) — a machine gate on a machine fact, never a model judgment.
 *
 * What it never does (§5, hard rule 5): read, keep or log an `Authorization` header, an API key
 * or an OAuth token; keep request or response bodies past the usage block; listen anywhere but
 * 127.0.0.1; outlive its wake. Headers pass byte-for-byte except the hop-by-hop set and
 * `accept-encoding` (dropped so the provider answers in identity encoding the parser can read).
 *
 * Routing: the child is handed `http://127.0.0.1:<port>/<provider>` as each provider's base URL;
 * `/<provider>/<rest>` forwards to that provider's upstream + `<rest>`. The upstream defaults to
 * the vendor endpoint and is overridden by the host's OWN base-URL variable when set, so an
 * operator already fronting a provider (Bedrock, an enterprise gateway) is chained, not bypassed.
 */

export interface GatewayUpstream {
  /** Path prefix the child addresses (`anthropic`, `openai`, `xai`). */
  name: string;
  /** The real base URL, including any `/v1` the vendor's env convention carries. */
  url: string;
  /** The variable the harness reads its base URL from. */
  envVar: string;
}

/**
 * The providers the host's backends spawn today, as each harness reads its base URL
 * (lane 01M4VNFB7B research, 2026-10-13, primary docs):
 *
 * - Claude Code honours `ANTHROPIC_BASE_URL` for all inference, with a claude.ai login still the
 *   active credential (the gateway forwards `anthropic-beta`, which carries the OAuth capability).
 * - Grok Build honours `GROK_MODELS_BASE_URL` ("custom inference base URL"); with browser login
 *   its own default is `https://cli-chat-proxy.grok.com/v1`, with an API key `https://api.x.ai/v1`.
 * - Codex reads no base-URL variable (`openai_base_url` lives in user-level config.toml and the
 *   built-in provider also speaks WebSocket); OpenCode reads only `opencode.json`. Both are
 *   handed `OPENAI_BASE_URL` here for a harness that does honour it, and otherwise stay priced by
 *   their own artifact (ADR 583 Decision 2) until their config paths get a lane of their own.
 *
 * The host's OWN setting of each variable becomes the upstream (chaining an operator's gateway,
 * Bedrock, or a pinned endpoint) instead of being bypassed.
 */
export function defaultUpstreams(env: NodeJS.ProcessEnv = process.env): GatewayUpstream[] {
  const xaiDefault = env['XAI_API_KEY']
    ? 'https://api.x.ai/v1'
    : 'https://cli-chat-proxy.grok.com/v1';
  return [
    {
      name: 'anthropic',
      url: env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com',
      envVar: 'ANTHROPIC_BASE_URL',
    },
    {
      name: 'openai',
      url: env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
      envVar: 'OPENAI_BASE_URL',
    },
    {
      name: 'xai',
      url: env['GROK_MODELS_BASE_URL'] ?? env['GROK_XAI_API_BASE_URL'] ?? xaiDefault,
      envVar: 'GROK_MODELS_BASE_URL',
    },
  ];
}

/** Usage in the `wake_turns` shape (ADR 251 §7): cached input is split OUT of `input_tokens` for
 *  every provider, so one price formula and one floor definition hold across vendors. */
export interface GatewayUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface MeteredCall {
  /** 1-based, in the order calls completed. */
  turn: number;
  provider: string;
  model: string | null;
  usage: GatewayUsage;
  /** Undefined when the model has no price row (the ledger records `no_price_row`). */
  cost_usd: number | undefined;
  status: number;
}

export interface GatewaySummary {
  calls: number;
  /** Calls refused on budget (§4). */
  refused: number;
  /** Calls whose response carried no usage block the parser recognised — relayed, not metered. */
  unmetered: number;
  usage: GatewayUsage;
  /** Sum of priced calls; undefined when any metered call had no price row. */
  cost_usd: number | undefined;
  /** The first metered call's prompt tokens (input + cache read + cache write): ADR 436's floor. */
  floor_tokens: number | null;
  models: string[];
  budget_exhausted: boolean;
}

export interface MeteringGatewayOptions {
  leaseId: string;
  budgetUsd?: number | undefined;
  upstreams?: GatewayUpstream[];
  /** Called as each metered call completes (the loop posts the `wake_turns` row). */
  onCall?: (call: MeteredCall) => void;
  price?: (model: string, usage: UsageLike) => number | undefined;
  log?: (line: string) => void;
}

export interface MeteringGateway {
  port: number;
  /** The variables to put in the child's environment. */
  env: Record<string, string>;
  summary(): GatewaySummary;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'accept-encoding',
  'content-length', // recomputed by node for the forwarded stream
]);

/** Longest one line of an SSE stream or one JSON body the parser will hold. Beyond it the call
 *  is relayed unmetered rather than buffered — the gateway holds no bodies by design. */
const PARSE_LIMIT_BYTES = 4 * 1024 * 1024;
const LINE_LIMIT_BYTES = 256 * 1024;

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Normalise one provider usage object to the gateway shape, or null when it is not one.
 *  Anthropic: `input_tokens` excludes the cache; OpenAI Responses / chat: `input_tokens` /
 *  `prompt_tokens` INCLUDE the cached prefix reported under `*_details.cached_tokens`. */
export function normaliseUsage(u: unknown): GatewayUsage | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  if ('prompt_tokens' in o || 'completion_tokens' in o) {
    const cached = n(
      (o['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens'],
    );
    return {
      input_tokens: Math.max(0, n(o['prompt_tokens']) - cached),
      output_tokens: n(o['completion_tokens']),
      ...(cached ? { cache_read_input_tokens: cached } : {}),
    };
  }
  if (!('input_tokens' in o) && !('output_tokens' in o)) return null;
  const details = o['input_tokens_details'] as Record<string, unknown> | undefined;
  if (details && typeof details === 'object') {
    const cached = n(details['cached_tokens']);
    return {
      input_tokens: Math.max(0, n(o['input_tokens']) - cached),
      output_tokens: n(o['output_tokens']),
      ...(cached ? { cache_read_input_tokens: cached } : {}),
    };
  }
  const read = n(o['cache_read_input_tokens']);
  const write = n(o['cache_creation_input_tokens']);
  return {
    input_tokens: n(o['input_tokens']),
    output_tokens: n(o['output_tokens']),
    ...(read ? { cache_read_input_tokens: read } : {}),
    ...(write ? { cache_creation_input_tokens: write } : {}),
  };
}

/** Where a provider event carries usage: top level (Anthropic `message_delta`, chat completions),
 *  `message.usage` (Anthropic `message_start`), `response.usage` (OpenAI Responses
 *  `response.completed`). The model id sits beside it at the same depth. */
function usageIn(ev: Record<string, unknown>): {
  usage: GatewayUsage | null;
  model: string | null;
} {
  const candidates: Record<string, unknown>[] = [ev];
  for (const k of ['message', 'response']) {
    const inner = ev[k];
    if (inner && typeof inner === 'object') candidates.push(inner as Record<string, unknown>);
  }
  let usage: GatewayUsage | null = null;
  let model: string | null = null;
  for (const c of candidates) {
    const u = normaliseUsage(c['usage']);
    if (u) usage = u;
    if (typeof c['model'] === 'string') model = c['model'];
  }
  return { usage, model };
}

/** Fold a stream of usage sightings into one record: Anthropic splits input (`message_start`)
 *  from output (`message_delta`, cumulative), so each field keeps its maximum. */
function foldUsage(acc: GatewayUsage | null, next: GatewayUsage): GatewayUsage {
  if (!acc) return next;
  const max = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : Math.max(a ?? 0, b ?? 0);
  const read = max(acc.cache_read_input_tokens, next.cache_read_input_tokens);
  const write = max(acc.cache_creation_input_tokens, next.cache_creation_input_tokens);
  return {
    input_tokens: Math.max(acc.input_tokens, next.input_tokens),
    output_tokens: Math.max(acc.output_tokens, next.output_tokens),
    ...(read !== undefined ? { cache_read_input_tokens: read } : {}),
    ...(write !== undefined ? { cache_creation_input_tokens: write } : {}),
  };
}

/** Incremental reader over a response body: SSE `data:` lines or one JSON document. Keeps at
 *  most one line (SSE) or one bounded document (JSON) in memory, and nothing after `result()`. */
export class UsageParser {
  private usage: GatewayUsage | null = null;
  private model: string | null = null;
  private buf = '';
  private overflow = false;
  constructor(private readonly sse: boolean) {}

  push(chunk: Buffer): void {
    if (this.overflow) return;
    this.buf += chunk.toString('utf8');
    if (this.sse) {
      let nl = this.buf.indexOf('\n');
      while (nl >= 0) {
        const line = this.buf.slice(0, nl).replace(/\r$/, '');
        this.buf = this.buf.slice(nl + 1);
        if (line.startsWith('data:')) this.take(line.slice(5).trim());
        nl = this.buf.indexOf('\n');
      }
      if (this.buf.length > LINE_LIMIT_BYTES) this.buf = ''; // a content line too long to matter
    } else if (this.buf.length > PARSE_LIMIT_BYTES) {
      this.overflow = true;
      this.buf = '';
    }
  }

  private take(json: string): void {
    if (!json || json === '[DONE]' || !json.includes('usage')) return;
    try {
      const ev = JSON.parse(json) as Record<string, unknown>;
      const { usage, model } = usageIn(ev);
      if (usage) this.usage = foldUsage(this.usage, usage);
      if (model) this.model = model;
    } catch {
      /* not JSON — a content line */
    }
  }

  result(): { usage: GatewayUsage | null; model: string | null } {
    if (!this.sse && this.buf) this.take(this.buf);
    this.buf = '';
    return { usage: this.usage, model: this.model };
  }
}

/** The error body a refused call answers with: the Anthropic error envelope, which the OpenAI
 *  SDKs also read (`error.message`, `error.type`). 402 is retried by no vendor SDK. */
export function budgetRefusal(
  leaseId: string,
  budgetUsd: number,
  spent: number,
  calls: number,
): string {
  return JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'musterd_budget_exhausted',
      message:
        `musterd: this wake's budget_usd ${budgetUsd.toFixed(4)} is spent ` +
        `($${spent.toFixed(4)} over ${String(calls)} calls, lease ${leaseId}) — no further model calls; ` +
        `finish with what you have and report`,
    },
  });
}

export async function startMeteringGateway(opts: MeteringGatewayOptions): Promise<MeteringGateway> {
  const upstreams = opts.upstreams ?? defaultUpstreams();
  const price = opts.price ?? priceUsage;
  const log = opts.log ?? (() => undefined);
  const calls: MeteredCall[] = [];
  let refused = 0;
  let unmetered = 0;
  let unpriceable = false;
  let spent = 0;
  let budgetExhausted = false;
  const sockets = new Set<Socket>();

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const m = /^\/([^/]+)(\/.*)?$/.exec(req.url ?? '');
    const up = m ? upstreams.find((u) => u.name === m[1]) : undefined;
    if (!up) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'not_found_error', message: 'musterd gateway: unknown provider prefix' },
        }),
      );
      req.resume();
      return;
    }
    if (opts.budgetUsd !== undefined && spent >= opts.budgetUsd) {
      refused += 1;
      budgetExhausted = true;
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(budgetRefusal(opts.leaseId, opts.budgetUsd, spent, calls.length));
      req.resume();
      if (refused === 1)
        log(
          `wake budget exhausted on lease ${opts.leaseId}: $${spent.toFixed(4)} ≥ $${opts.budgetUsd.toFixed(4)} — next model call refused`,
        );
      return;
    }
    const target = new URL(up.url.replace(/\/$/, '') + (m![2] ?? ''));
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers['host'] = target.host;
    const fn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = fn(target, { method: req.method ?? 'POST', headers }, (upRes) => {
      const resHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding') continue;
        resHeaders[k] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, resHeaders);
      const sse = /text\/event-stream/i.test(String(upRes.headers['content-type'] ?? ''));
      const parser = new UsageParser(sse);
      upRes.on('data', (chunk: Buffer) => {
        parser.push(chunk);
        res.write(chunk);
      });
      upRes.on('end', () => {
        res.end();
        const { usage, model } = parser.result();
        const status = upRes.statusCode ?? 0;
        if (!usage || status >= 400) {
          if (status < 400) unmetered += 1;
          return;
        }
        const cost = model ? price(model, usage) : undefined;
        if (cost === undefined) unpriceable = true;
        else spent += cost;
        const call: MeteredCall = {
          turn: calls.length + 1,
          provider: up.name,
          model,
          usage,
          cost_usd: cost,
          status,
        };
        calls.push(call);
        try {
          opts.onCall?.(call);
        } catch (err) {
          log(`! gateway onCall threw: ${(err as Error).message}`);
        }
      });
      upRes.on('error', () => res.destroy());
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: `musterd gateway: upstream unreachable (${err.message})`,
            },
          }),
        );
      } else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  };

  const server: Server = createServer(handle);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const env: Record<string, string> = {};
  for (const u of upstreams) env[u.envVar] = `http://127.0.0.1:${String(port)}/${u.name}`;

  return {
    port,
    env,
    summary: () => {
      const usage = calls.reduce<GatewayUsage>(
        (acc, c) => ({
          input_tokens: acc.input_tokens + c.usage.input_tokens,
          output_tokens: acc.output_tokens + c.usage.output_tokens,
          cache_read_input_tokens:
            (acc.cache_read_input_tokens ?? 0) + (c.usage.cache_read_input_tokens ?? 0),
          cache_creation_input_tokens:
            (acc.cache_creation_input_tokens ?? 0) + (c.usage.cache_creation_input_tokens ?? 0),
        }),
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      );
      const first = calls[0]?.usage;
      return {
        calls: calls.length,
        refused,
        unmetered,
        usage,
        cost_usd: calls.length > 0 && !unpriceable ? spent : undefined,
        floor_tokens: first
          ? first.input_tokens +
            (first.cache_read_input_tokens ?? 0) +
            (first.cache_creation_input_tokens ?? 0)
          : null,
        models: [...new Set(calls.flatMap((c) => (c.model ? [c.model] : [])))],
        budget_exhausted: budgetExhausted,
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
