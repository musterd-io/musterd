import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { priceUsage, type UsageLike } from './prices.js';
import { SPEND_APPROVAL_WAKE_ENDED, type SpendApprovalVerdict } from './spendApproval.js';

/**
 * The metering gateway (ADR 583): a loopback, per-wake, pass-through HTTP proxy the host points a
 * woken harness at through the base-URL variable that harness documents. Every request is
 * forwarded to the real provider unchanged except OpenRouter POSTs, whose bounded JSON bodies are
 * augmented with a usage-reporting opt-in; every response is relayed unchanged (streaming
 * included). The gateway reads only the provider's usage block and model id as the bytes pass,
 * prices them from the host's table (OpenRouter supplies its actual cost in `usage.cost`), and
 * refuses the next call once the wake's `budget_usd` is
 * spent (§4) — a machine gate on a machine fact, never a model judgment.
 *
 * ADR 636: when the host passes `spendApprovalUsd`, a call that arrives with running cost at that
 * threshold is held. The host's callback is one blocking approve ask. Accept forwards this call
 * and every later call on the wake. Decline, or the wake ending during the hold, answers 402
 * `musterd_spend_approval_declined`. Those refusals do not set `budget_exhausted`. The request
 * stays paused until the decision, so Authorization and the body are unread while it is held.
 * `close` aborts the hold. The callback settles when that signal aborts; otherwise `close` waits.
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
  /** The variable the harness reads its base URL from. Absent for a provider a harness configures
   *  only by file (OpenCode's hosted providers, ADR 583 note 2026-10-19): the backend writes that
   *  file's override from {@link MeteringGateway.origin} instead. */
  envVar?: string;
}

/**
 * The providers the host's backends spawn today, as each harness reads its base URL
 * (lane 01M4VNFB7B research, 2026-10-13, primary docs):
 *
 * - Claude Code honours `ANTHROPIC_BASE_URL` for all inference, with a claude.ai login still the
 *   active credential (the gateway forwards `anthropic-beta`, which carries the OAuth capability).
 * - Grok Build honours `GROK_MODELS_BASE_URL` ("custom inference base URL"); with browser login
 *   its own default is `https://cli-chat-proxy.grok.com/v1`, with an API key `https://api.x.ai/v1`.
 * - Codex reads no base-URL variable, but takes `-c openai_base_url=…` per invocation. Its backend
 *   points a metered wake at `<origin>/chatgpt` under a ChatGPT login or `<origin>/openai` under an
 *   API key. Codex tries a WebSocket upgrade on `/responses` first; the gateway does not accept the
 *   upgrade, and Codex falls back to HTTP, which is metered (lane 01M4VQ3CMR, 2026-10-19).
 * - OpenCode reads base URLs only from config. Its backend runs every wake `--standalone` (ADR 768)
 *   and, on a metered wake, sets `OPENCODE_CONFIG_CONTENT` pointing its hosted providers (`opencode`,
 *   `opencode-go`) at `<origin>/<id>` (ADR 583 note 2026-10-19). Other OpenCode providers are not
 *   re-pointed.
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
    // OpenCode's hosted providers, as models.dev lists their `api` (2026-10-19). OpenCode reads no
    // base-URL variable; its backend points them here through OPENCODE_CONFIG_CONTENT.
    ...OPENCODE_HOSTED_UPSTREAMS,
    OPENCODE_OPENROUTER_UPSTREAM,
    CODEX_CHATGPT_UPSTREAM,
  ];
}

/** The backend Codex reaches under a ChatGPT login (not api.openai.com). Codex is pointed here by a
 *  `-c openai_base_url` override when `codex login status` says ChatGPT (lane 01M4VQ3CMR). */
export const CODEX_CHATGPT_UPSTREAM: GatewayUpstream = {
  name: 'chatgpt',
  url: 'https://chatgpt.com/backend-api/codex',
};

/** OpenCode's own hosted providers (Zen and Go), both OpenAI-compatible. The route name is the
 *  provider id OpenCode configures them under, so the backend's override is `<origin>/<id>`. */
export const OPENCODE_HOSTED_UPSTREAMS: GatewayUpstream[] = [
  { name: 'opencode', url: 'https://opencode.ai/inference/openai/v1' },
  { name: 'opencode-go', url: 'https://opencode.ai/inference/go/openai/v1' },
];

/** OpenRouter's OpenAI-compatible API. OpenCode's credential store supplies its bearer key. */
export const OPENCODE_OPENROUTER_UPSTREAM: GatewayUpstream = {
  name: 'openrouter',
  url: 'https://openrouter.ai/api/v1',
};

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
  /** Calls answered 402 because spend approval declined or the wake ended during the hold (ADR 636). */
  approval_refused: number;
  /** The wake closed while a provider call was held for spend approval. */
  approval_wake_ended: boolean;
}

export interface MeteringGatewayOptions {
  leaseId: string;
  budgetUsd?: number | undefined;
  upstreams?: GatewayUpstream[];
  /** Called as each metered call completes (the loop posts the `wake_turns` row). */
  onCall?: (call: MeteredCall) => void;
  /** ADR 636: per-wake approval threshold. Absent: the gateway does not hold for approval. */
  spendApprovalUsd?: number | undefined;
  /**
   * One ask for the wake, invoked the first time running cost has reached `spendApprovalUsd`
   * and `budget_usd` still allows the call. Lane id stays in the host closure.
   */
  onSpendApproval?: (req: {
    leaseId: string;
    spentUsd: number;
    thresholdUsd: number;
    signal: AbortSignal;
  }) => Promise<SpendApprovalVerdict>;
  price?: (model: string, usage: UsageLike) => number | undefined;
  log?: (line: string) => void;
  /** Bound on `close`'s wait for in-flight relays. Default 3s. */
  drainMs?: number;
}

export interface MeteringGateway {
  port: number;
  /** `http://127.0.0.1:<port>` — a file-configured harness builds `<origin>/<provider>` from it. */
  origin: string;
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
/** Bound the transient JSON rewrite that asks OpenRouter to include its authoritative usage cost. */
const OPENROUTER_REQUEST_LIMIT_BYTES = 16 * 1024 * 1024;
/** The field names an SSE stream can open with (WHATWG event stream), for the content-type sniff. */
const SSE_FIELDS = ['event:', 'data:', 'id:', 'retry:'];
/** How long `close` waits for a provider response already in flight. The body is on the wire;
 *  a hung upstream must not hold settle open. After this, metering freezes so a late `end`
 *  cannot post a turn the summary missed (lane 01M5JEKY6R). */
const DRAIN_MS = 3_000;

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
  cost_usd: number | undefined;
} {
  const candidates: Record<string, unknown>[] = [ev];
  for (const k of ['message', 'response']) {
    const inner = ev[k];
    if (inner && typeof inner === 'object') candidates.push(inner as Record<string, unknown>);
  }
  let usage: GatewayUsage | null = null;
  let model: string | null = null;
  let cost_usd: number | undefined;
  for (const c of candidates) {
    const rawUsage = c['usage'];
    const u = normaliseUsage(rawUsage);
    if (u) usage = u;
    if (rawUsage && typeof rawUsage === 'object') {
      const cost = (rawUsage as Record<string, unknown>)['cost'];
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
        cost_usd = Math.max(cost_usd ?? 0, cost);
    }
    if (typeof c['model'] === 'string') model = c['model'];
  }
  return { usage, model, cost_usd };
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
 *  most one line (SSE) or one bounded document (JSON) in memory, and nothing after `result()`.
 *
 *  `sse` undefined means the response named no content type, and the body decides: a stream opens
 *  with `event:`, `data:` or a `:` comment. The ChatGPT backend Codex reaches under a ChatGPT login
 *  streams SSE with no `content-type` at all (lane 01M4VQ3CMR, 2026-10-19). Read as JSON, every one
 *  of its calls was unmetered. */
export class UsageParser {
  private usage: GatewayUsage | null = null;
  private model: string | null = null;
  private cost_usd: number | undefined;
  private buf = '';
  private overflow = false;
  constructor(private sse: boolean | undefined) {}

  push(chunk: Buffer): void {
    if (this.overflow) return;
    this.buf += chunk.toString('utf8');
    if (this.sse === undefined) {
      const head = this.buf.trimStart();
      // Undecided until the head can only be one thing: `eve` may still become `event:`.
      if (!head || SSE_FIELDS.some((f) => f.length > head.length && f.startsWith(head))) return;
      this.sse = head.startsWith(':') || SSE_FIELDS.some((f) => head.startsWith(f));
    }
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
      const { usage, model, cost_usd } = usageIn(ev);
      if (usage) this.usage = foldUsage(this.usage, usage);
      if (model) this.model = model;
      if (cost_usd !== undefined) this.cost_usd = Math.max(this.cost_usd ?? 0, cost_usd);
    } catch {
      /* not JSON — a content line */
    }
  }

  result(): { usage: GatewayUsage | null; model: string | null; cost_usd: number | undefined } {
    if (!this.sse && this.buf) this.take(this.buf);
    this.buf = '';
    return { usage: this.usage, model: this.model, cost_usd: this.cost_usd };
  }
}

async function openRouterRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > OPENROUTER_REQUEST_LIMIT_BYTES) {
      throw Object.assign(new Error('request too large for metered OpenRouter usage'), {
        status: 413,
      });
    }
    chunks.push(chunk);
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('object required');
    body = parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('OpenRouter request must be a JSON object'), { status: 400 });
  }
  const usage = body['usage'];
  body['usage'] = {
    ...(usage && typeof usage === 'object' && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)
      : {}),
    include: true,
  };
  if (body['stream'] === true) {
    const streamOptions = body['stream_options'];
    body['stream_options'] = {
      ...(streamOptions && typeof streamOptions === 'object' && !Array.isArray(streamOptions)
        ? (streamOptions as Record<string, unknown>)
        : {}),
      include_usage: true,
    };
  }
  return Buffer.from(JSON.stringify(body));
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
  let unknownCostBudgetBlocked = false;
  let spent = 0;
  let budgetExhausted = false;
  type ApprovalDecision = 'forward' | 'decline' | 'wake_ended';
  let decided: ApprovalDecision | undefined;
  let gate: Promise<ApprovalDecision> | undefined;
  let approvalRefused = 0;
  let approvalWakeEnded = false;
  let approvalLogged = false;
  const approvalAbort = new AbortController();
  const approvalWrites: Promise<void>[] = [];
  let closePromise: Promise<void> | undefined;
  let closing = false;
  /** Set once `close` has snapshotted. A later `end` must not post a turn the summary missed. */
  let frozen = false;
  interface LiveRelay {
    done: Promise<void>;
    /** Record usage already parsed, once. No-op once recorded, frozen, or the body had no usage. */
    commitParsed: () => void;
  }
  const live: LiveRelay[] = [];

  const relay = (
    req: IncomingMessage,
    res: ServerResponse,
    up: GatewayUpstream,
    rest: string,
  ): void => {
    const target = new URL(up.url.replace(/\/$/, '') + rest);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers['host'] = target.host;
    const fn = target.protocol === 'https:' ? httpsRequest : httpRequest;

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let finished = false;
    let localResponse = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolveDone();
    };
    let recorded = false;
    let status = 0;
    let parser: UsageParser | undefined;
    const commit = (fromEnd: boolean): void => {
      if (recorded || frozen) return;
      const {
        usage,
        model,
        cost_usd: reportedCost,
      } = parser?.result() ?? {
        usage: null,
        model: null,
        cost_usd: undefined,
      };
      if (!usage || status >= 400) {
        // A GET (Codex's `/models` catalog) is no model call: relayed, never counted unmetered.
        // An abort with no usage is not "unmetered" — the response never finished.
        if (fromEnd && !usage && status < 400 && req.method !== 'GET') unmetered += 1;
        if (
          fromEnd &&
          up.name === OPENCODE_OPENROUTER_UPSTREAM.name &&
          status < 400 &&
          req.method !== 'GET' &&
          req.method !== 'HEAD' &&
          opts.budgetUsd !== undefined
        ) {
          unknownCostBudgetBlocked = true;
          budgetExhausted = true;
          log(
            `OpenRouter call on lease ${opts.leaseId} returned no usage cost — next model call refused under budget_usd`,
          );
        }
        if (fromEnd) recorded = true;
        return;
      }
      recorded = true;
      // OpenRouter reports the actual routed provider cost in usage.cost. Prefer that exact charge
      // over the table; when it is absent, keep the existing dated-table behavior for known models.
      // Unknown models with no reported cost stay unpriced and cannot make another budgeted call.
      const cost =
        up.name === OPENCODE_OPENROUTER_UPSTREAM.name
          ? (reportedCost ?? (model ? price(model, usage) : undefined))
          : model
            ? price(model, usage)
            : undefined;
      if (cost === undefined) unpriceable = true;
      else spent += cost;
      if (cost === undefined && up.name === OPENCODE_OPENROUTER_UPSTREAM.name) {
        if (opts.budgetUsd !== undefined) {
          unknownCostBudgetBlocked = true;
          budgetExhausted = true;
          log(
            `OpenRouter call on lease ${opts.leaseId} returned usage without cost — next model call refused under budget_usd`,
          );
        }
      }
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
    };
    live.push({ done, commitParsed: () => commit(false) });

    const upstream = fn(target, { method: req.method ?? 'POST', headers }, (upRes) => {
      status = upRes.statusCode ?? 0;
      const resHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding') continue;
        resHeaders[k] = v;
      }
      if (!res.destroyed && !res.headersSent) res.writeHead(status || 502, resHeaders);
      const contentType = upRes.headers['content-type'];
      parser = new UsageParser(
        contentType === undefined ? undefined : /text\/event-stream/i.test(String(contentType)),
      );
      upRes.on('data', (chunk: Buffer) => {
        parser?.push(chunk);
        if (!res.destroyed && !res.writableEnded) res.write(chunk);
      });
      upRes.on('end', () => {
        if (!res.destroyed && !res.writableEnded) res.end();
        commit(true);
        finish();
      });
      upRes.on('error', () => {
        // Usage already folded from earlier chunks still counts; `end` may never follow a destroy.
        commit(false);
        if (!res.destroyed) res.destroy();
        finish();
      });
      upRes.on('close', () => {
        if (finished) return;
        commit(false);
        finish();
      });
    });
    upstream.on('error', (err) => {
      if (localResponse) {
        if (!finished) finish();
        return;
      }
      if (!res.headersSent && !res.destroyed) {
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
      } else if (!res.destroyed) res.destroy();
      if (!finished && status === 0) finish();
    });
    req.on('aborted', () => upstream.destroy());
    if (
      up.name === OPENCODE_OPENROUTER_UPSTREAM.name &&
      req.method !== 'GET' &&
      req.method !== 'HEAD'
    ) {
      void openRouterRequestBody(req)
        .then((body) => {
          if (upstream.destroyed) return;
          upstream.setHeader('content-length', String(body.length));
          upstream.end(body);
        })
        .catch((err: unknown) => {
          localResponse = true;
          const statusCode =
            err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
              ? err.status
              : 400;
          if (!res.destroyed && !res.headersSent) {
            res.writeHead(statusCode, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  code: 'musterd_openrouter_request_invalid',
                  message:
                    statusCode === 413
                      ? 'musterd: OpenRouter request exceeds the metering gateway body limit'
                      : 'musterd: OpenRouter request must be a JSON object',
                },
              }),
            );
          }
          upstream.destroy();
        });
    } else {
      req.pipe(upstream);
    }
  };

  const writeApprovalRefusal = (
    req: IncomingMessage,
    res: ServerResponse,
    kind: 'decline' | 'wake_ended',
  ): void => {
    if (req.aborted || res.destroyed || res.writableEnded) {
      req.resume();
      return;
    }
    approvalRefused += 1;
    const threshold = opts.spendApprovalUsd ?? 0;
    const message =
      kind === 'wake_ended'
        ? `musterd: ${SPEND_APPROVAL_WAKE_ENDED} (lease ${opts.leaseId})`
        : `musterd: spend approval $${threshold.toFixed(4)} declined ` +
          `($${spent.toFixed(4)} spent, lease ${opts.leaseId})`;
    res.writeHead(402, { 'content-type': 'application/json' });
    const done = new Promise<void>((resolve) => {
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'musterd_spend_approval_declined',
            message,
          },
        }),
        () => resolve(),
      );
    });
    approvalWrites.push(done);
    req.resume();
    if (approvalLogged) return;
    approvalLogged = true;
    log(
      kind === 'wake_ended'
        ? `spend approval hold ended with the wake on lease ${opts.leaseId}`
        : `spend approval declined on lease ${opts.leaseId}: $${spent.toFixed(4)} ≥ $${threshold.toFixed(4)} — next model call refused`,
    );
  };

  const beginHold = (): Promise<ApprovalDecision> => {
    if (decided) return Promise.resolve(decided);
    if (!gate) {
      const spentAtHold = spent;
      const threshold = opts.spendApprovalUsd ?? 0;
      gate = (async (): Promise<ApprovalDecision> => {
        const signal = approvalAbort.signal;
        let result: SpendApprovalVerdict = 'decline';
        if (opts.onSpendApproval) {
          try {
            result = await opts.onSpendApproval({
              leaseId: opts.leaseId,
              spentUsd: spentAtHold,
              thresholdUsd: threshold,
              signal,
            });
          } catch {
            result = signal.aborted ? 'wake_ended' : 'decline';
          }
        }
        if (decided === 'forward' || decided === 'decline') return decided;
        const outcome: ApprovalDecision =
          signal.aborted || result === 'wake_ended'
            ? 'wake_ended'
            : result === 'accept'
              ? 'forward'
              : 'decline';
        decided = outcome;
        if (outcome === 'wake_ended') approvalWakeEnded = true;
        return outcome;
      })();
    }
    return gate;
  };

  const holdThen = (
    req: IncomingMessage,
    res: ServerResponse,
    up: GatewayUpstream,
    rest: string,
  ): Promise<void> =>
    beginHold()
      .then((outcome) => {
        if (outcome === 'forward') relay(req, res, up, rest);
        else writeApprovalRefusal(req, res, outcome);
      })
      .catch(() => {
        writeApprovalRefusal(req, res, approvalAbort.signal.aborted ? 'wake_ended' : 'decline');
      });

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (closing) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'musterd gateway: wake ended' },
        }),
      );
      req.resume();
      return;
    }
    const matched = /^\/([^/]+)(\/.*)?$/.exec(req.url ?? '');
    const upstream = matched ? upstreams.find((u) => u.name === matched[1]) : undefined;
    if (!matched || !upstream) {
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
    if (
      opts.budgetUsd !== undefined &&
      (spent >= opts.budgetUsd ||
        (unknownCostBudgetBlocked && req.method !== 'GET' && req.method !== 'HEAD'))
    ) {
      refused += 1;
      budgetExhausted = true;
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(
        unknownCostBudgetBlocked &&
          spent < opts.budgetUsd &&
          req.method !== 'GET' &&
          req.method !== 'HEAD'
          ? JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                code: 'musterd_budget_exhausted',
                message: `musterd: the previous OpenRouter call had no reported cost ($${spent.toFixed(4)} priced over ${String(calls.length)} calls, lease ${opts.leaseId}); no further model calls under budget_usd`,
              },
            })
          : budgetRefusal(opts.leaseId, opts.budgetUsd, spent, calls.length),
      );
      req.resume();
      if (refused === 1)
        log(
          `wake budget exhausted on lease ${opts.leaseId}: $${spent.toFixed(4)} ≥ $${opts.budgetUsd.toFixed(4)} — next model call refused`,
        );
      return;
    }
    const rest = matched[2] ?? '';
    if (opts.spendApprovalUsd !== undefined) {
      if (decided === 'decline' || decided === 'wake_ended') {
        writeApprovalRefusal(req, res, decided);
        return;
      }
      if (decided !== 'forward' && spent >= opts.spendApprovalUsd) {
        void holdThen(req, res, upstream, rest);
        return;
      }
    }
    relay(req, res, upstream, rest);
  };

  const server: Server = createServer(handle);
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
  const origin = `http://127.0.0.1:${String(port)}`;
  for (const u of upstreams) if (u.envVar) env[u.envVar] = `${origin}/${u.name}`;

  return {
    port,
    origin,
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
        approval_refused: approvalRefused,
        approval_wake_ended: approvalWakeEnded,
      };
    },
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        // A finished accept or decline stays. Abort must not turn it into wake_ended.
        closing = true;
        if (gate && decided !== 'forward' && decided !== 'decline') approvalWakeEnded = true;
        approvalAbort.abort();
        if (gate) await gate;
        // holdThen's continuation starts its relay or writes the 402 before we snapshot.
        await Promise.resolve();
        await Promise.all(approvalWrites);
        const pending = live.map((r) => r.done);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, opts.drainMs ?? DRAIN_MS);
          void Promise.all(pending).then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        // A body already parsed but not `end`ed (the client aborted, or the drain timed out)
        // still counts. Freeze before the sockets die, so that `end` cannot post a turn
        // `summary()` — called by the loop once `close` resolves — will not include.
        for (const r of live) r.commitParsed();
        frozen = true;
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      })();
      return closePromise;
    },
  };
}
