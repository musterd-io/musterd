import { existsSync, realpathSync } from 'node:fs';
import { Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { InjectAdapter, InjectResult } from './inject.js';

/**
 * Grok's leader socket (ADR 558 §6). A TUI started with `--leader` listens; a default TUI does
 * not, and probe stays `no-leader-socket` (Grok 1.0.52 on 2026-10-13, rechecked on 1.0.62 on
 * 2026-10-16). One frame is a big-endian u32 length, then one JSON object. Register is
 * `{type:"register", mode:"stdio", client_type:"musterd"}`. 1.0.62 closes a register that omits
 * `client_type`. ACP is `{"type":"acp","payload":"<json-rpc string>"}`.
 *
 * `session/list` on a leader returns sessions that leader did not create. On grok 1.0.70
 * (2026-10-26) the list is paged: the result carries `nextCursor`, and the next page is
 * `{cursor: <that value>}`. The client follows that cursor, and prompts only a row whose
 * resolved cwd is this binding directory — the newest `updatedAt` across the pages.
 *
 * The prompt's JSON-RPC result arrives when the turn stops (1.0.52: `stopReason` about 2 s later).
 * `inject` returns once the prompt is accepted — a later frame, or a short quiet with the socket
 * still open — and leaves the socket up until that result. Closing at the moment of accept was not
 * measured. Reasons are stable codes. ACP payloads are never logged and never copied into a reason:
 * a notification on 1.0.62 carried local MCP environment values.
 */
const HANDSHAKE_MS = 5_000;
const ACCEPT_QUIET_MS = 400;
const MAX_FRAME = 4 * 1024 * 1024;
const INIT_ID = 1;
const LIST_ID = 2;
const PROMPT_ID = 3;
/** Eight pages of the measured 30-row page. A repeated cursor stops the walk sooner. */
const MAX_LIST_PAGES = 8;

const Registered = z
  .object({
    type: z.literal('registered'),
    ready: z.boolean(),
  })
  .passthrough();

const AcpFrame = z
  .object({
    type: z.literal('acp'),
    payload: z.string(),
  })
  .passthrough();

const Rpc = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    error: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const SessionRow = z
  .object({
    sessionId: z.string().min(1),
    cwd: z.string().min(1),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const SessionList = z
  .object({
    sessions: z.array(z.unknown()),
  })
  .passthrough();

interface RpcView {
  id?: number | string;
  error: boolean;
  result?: unknown;
}

export function grokLeaderSocketPath(env: NodeJS.ProcessEnv): string {
  const override = env['GROK_LEADER_SOCKET'];
  if (override) return override;
  const root = env['GROK_HOME'] ?? join(homedir(), '.grok');
  return join(root, 'leader.sock');
}

export function grokLeader(env: NodeJS.ProcessEnv, dir: string): InjectAdapter {
  const socketPath = grokLeaderSocketPath(env);
  return {
    harness: 'grok',
    probe: () =>
      existsSync(socketPath) ? { ready: true } : { ready: false, reason: 'no-leader-socket' },
    inject: (line) => injectLine(socketPath, dir, line),
  };
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function writeFrame(sock: Socket, value: unknown): void {
  if (!sock.destroyed) sock.write(encodeFrame(value));
}

function acp(id: number, method: string, params: unknown): { type: 'acp'; payload: string } {
  return { type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id, method, params }) };
}

function sameId(id: number | string | undefined, want: number): boolean {
  return id === want || id === String(want);
}

function readRpc(frame: unknown): RpcView | undefined {
  const acpFrame = AcpFrame.safeParse(frame);
  if (!acpFrame.success) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(acpFrame.data.payload);
  } catch {
    return undefined;
  }
  const rpc = Rpc.safeParse(raw);
  if (!rpc.success) return undefined;
  const view: RpcView = { error: rpc.data.error !== undefined };
  if (rpc.data.id !== undefined) view.id = rpc.data.id;
  if (rpc.data.result !== undefined) view.result = rpc.data.result;
  return view;
}

interface ListedSession {
  sessionId: string;
  updatedAt: string;
}

/** Cwd matches on one page. `'bad'` means the list did not parse. A missing directory is a miss. */
function pageMatches(result: unknown, dir: string): ListedSession[] | 'bad' {
  const parsed = SessionList.safeParse(result);
  if (!parsed.success) return 'bad';
  let want: string;
  try {
    want = realpathSync(dir);
  } catch {
    return [];
  }
  const matches: ListedSession[] = [];
  for (const row of parsed.data.sessions) {
    const session = SessionRow.safeParse(row);
    if (!session.success) continue;
    let cwd: string;
    try {
      cwd = realpathSync(session.data.cwd);
    } catch {
      continue;
    }
    if (cwd !== want) continue;
    matches.push({ sessionId: session.data.sessionId, updatedAt: session.data.updatedAt ?? '' });
  }
  return matches;
}

function newestSession(matches: readonly ListedSession[]): string | undefined {
  const sorted = [...matches].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
  return sorted[0]?.sessionId;
}

/** grok 1.0.70 names the next page `nextCursor`. The following request sends it as `cursor`. */
function nextCursorOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const cursor = (result as { nextCursor?: unknown }).nextCursor;
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

function injectLine(socketPath: string, dir: string, line: string): Promise<InjectResult> {
  if (!existsSync(socketPath)) return Promise.resolve({ ok: false, reason: 'no-leader-socket' });
  return new Promise<InjectResult>((resolve) => {
    let settled = false;
    let connected = false;
    let stage: 'register' | 'initialize' | 'list' | 'prompt' | 'drain' = 'register';
    let buf = Buffer.alloc(0);
    let listId = LIST_ID;
    let promptId = PROMPT_ID;
    let listPages = 0;
    const found: ListedSession[] = [];
    const followed = new Set<string>();
    const sock = new Socket();
    let acceptTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: InjectResult, keep = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      clearTimeout(acceptTimer);
      if (keep) {
        stage = 'drain';
        sock.unref();
      } else {
        sock.destroy();
      }
      resolve(result);
    };

    const handshakeTimer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), HANDSHAKE_MS);

    const armAccept = (): void => {
      clearTimeout(handshakeTimer);
      acceptTimer = setTimeout(() => {
        if (stage === 'prompt') finish({ ok: true }, true);
      }, ACCEPT_QUIET_MS);
    };

    const handle = (raw: unknown): void => {
      if (stage === 'register') {
        const registered = Registered.safeParse(raw);
        if (!registered.success) return;
        if (!registered.data.ready) {
          finish({ ok: false, reason: 'register-failed' });
          return;
        }
        stage = 'initialize';
        writeFrame(
          sock,
          acp(INIT_ID, 'initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'musterd', version: '0' },
          }),
        );
        return;
      }
      const rpc = readRpc(raw);
      if (!rpc) return;
      if (stage === 'initialize') {
        if (!sameId(rpc.id, INIT_ID)) return;
        if (rpc.error) {
          finish({ ok: false, reason: 'initialize-failed' });
          return;
        }
        stage = 'list';
        writeFrame(sock, acp(LIST_ID, 'session/list', {}));
        return;
      }
      if (stage === 'list') {
        if (!sameId(rpc.id, listId)) return;
        if (rpc.error) {
          finish({ ok: false, reason: 'list-failed' });
          return;
        }
        listPages += 1;
        const page = pageMatches(rpc.result, dir);
        if (page === 'bad') {
          finish({ ok: false, reason: 'list-failed' });
          return;
        }
        found.push(...page);
        const cursor = nextCursorOf(rpc.result);
        if (cursor && !followed.has(cursor) && listPages < MAX_LIST_PAGES) {
          followed.add(cursor);
          listId += 1;
          promptId = listId + 1;
          writeFrame(sock, acp(listId, 'session/list', { cursor }));
          return;
        }
        const picked = newestSession(found);
        if (!picked) {
          finish({ ok: false, reason: 'no-session' });
          return;
        }
        stage = 'prompt';
        writeFrame(
          sock,
          acp(promptId, 'session/prompt', {
            sessionId: picked,
            prompt: [{ type: 'text', text: line }],
          }),
        );
        armAccept();
        return;
      }
      if (stage === 'prompt') {
        if (rpc.id === undefined) {
          finish({ ok: true }, true);
          return;
        }
        if (!sameId(rpc.id, promptId)) return;
        if (rpc.error) finish({ ok: false, reason: 'prompt-rejected' });
        else finish({ ok: true });
      }
    };

    const pump = (): void => {
      while (!settled || stage === 'drain') {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len > MAX_FRAME) {
          buf = Buffer.alloc(0);
          if (!settled) finish({ ok: false, reason: 'frame-too-large' });
          else sock.destroy();
          return;
        }
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len);
        buf = Buffer.from(buf.subarray(4 + len));
        let raw: unknown;
        try {
          raw = JSON.parse(body.toString('utf8'));
        } catch {
          continue;
        }
        if (stage === 'drain') {
          const rpc = readRpc(raw);
          if (rpc && sameId(rpc.id, promptId)) sock.destroy();
          continue;
        }
        handle(raw);
      }
    };

    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      finish({ ok: false, reason: connected ? 'socket-closed' : `connect:${err.code ?? 'error'}` });
    });
    sock.on('connect', () => {
      connected = true;
      sock.setNoDelay(true);
      writeFrame(sock, { type: 'register', mode: 'stdio', client_type: 'musterd' });
    });
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      pump();
    });
    sock.on('end', () => {
      if (settled) return;
      const reason =
        stage === 'register'
          ? 'register-failed'
          : stage === 'initialize'
            ? 'initialize-failed'
            : stage === 'list'
              ? 'list-failed'
              : 'socket-closed';
      finish({ ok: false, reason });
    });
    sock.connect(socketPath);
  });
}
