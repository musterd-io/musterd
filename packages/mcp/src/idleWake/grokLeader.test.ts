import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grokLeader } from './grokLeader.js';
import { injectAdapterFor } from './inject.js';

let server: Server | undefined;
const openSockets = new Set<Socket>();

afterEach(async () => {
  for (const sock of openSockets) sock.destroy();
  openSockets.clear();
  const current = server;
  server = undefined;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
});

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function listen(
  onFrame: (frame: unknown, send: (value: unknown) => void, sock: Socket) => void,
): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), 'grok-ldr-')), 'leader.sock');
  server = createServer((sock) => {
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
    let buf = Buffer.alloc(0);
    const send = (value: unknown): void => {
      if (!sock.destroyed) sock.write(encodeFrame(value));
    };
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const raw = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as unknown;
        buf = Buffer.from(buf.subarray(4 + len));
        onFrame(raw, send, sock);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(path, () => resolve(path));
  });
}

function rpc(frame: unknown): { id?: number; method?: string; params?: Record<string, unknown> } {
  const wrapped = frame as { type?: string; payload?: unknown };
  if (wrapped.type !== 'acp' || typeof wrapped.payload !== 'string') return {};
  return JSON.parse(wrapped.payload) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };
}

function acp(id: number, result: unknown): { type: 'acp'; payload: string } {
  return { type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

describe('grok leader inject (ADR 558 §6)', () => {
  it('probe is deaf when the leader socket is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-'));
    expect(grokLeader({ GROK_HOME: home }, home).probe()).toEqual({
      ready: false,
      reason: 'no-leader-socket',
    });
    expect(grokLeader({ GROK_LEADER_SOCKET: join(home, 'missing.sock') }, home).probe()).toEqual({
      ready: false,
      reason: 'no-leader-socket',
    });
  });

  it('injectAdapterFor wires grok only when the socket exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-'));
    expect(injectAdapterFor('grok', { GROK_HOME: home }, home).probe()).toEqual({
      ready: false,
      reason: 'no-leader-socket',
    });
    const path = await listen(() => {});
    const adapter = injectAdapterFor('grok', { GROK_LEADER_SOCKET: path, GROK_HOME: home }, home);
    expect(adapter.harness).toBe('grok');
    expect(adapter.probe()).toEqual({ ready: true });
  });

  it('prompts the newest session whose cwd is the binding dir and returns before the turn ends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-cwd-'));
    const mine = join(root, 'mine');
    const other = join(root, 'other');
    mkdirSync(mine);
    mkdirSync(other);
    const seen: unknown[] = [];
    const path = await listen((frame, send) => {
      seen.push(frame);
      if (seen.length === 1) {
        send({ type: 'registered', client_id: 7, ready: true, leader_protocol_version: 1 });
        return;
      }
      if (seen.length === 2) {
        send({
          type: 'acp',
          payload: JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { secret: 'SUPERSECRET' },
          }),
        });
        send(acp(1, { protocolVersion: 1 }));
        return;
      }
      if (seen.length === 3) {
        send(
          acp(2, {
            sessions: [
              { sessionId: 'mine-old', cwd: mine, updatedAt: '2026-10-01T00:00:00.000Z' },
              { sessionId: 'elsewhere', cwd: other, updatedAt: '2026-10-20T00:00:00.000Z' },
              {
                sessionId: 'missing-cwd',
                cwd: join(root, 'gone'),
                updatedAt: '2026-10-21T00:00:00.000Z',
              },
              { sessionId: 'mine-new', cwd: mine, updatedAt: '2026-10-16T00:00:00.000Z' },
            ],
          }),
        );
        return;
      }
      send({
        type: 'acp',
        payload: JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { secret: 'SUPERSECRET' },
        }),
      });
    });
    const started = Date.now();
    const result = await grokLeader({ GROK_LEADER_SOCKET: path }, mine).inject(
      '⚡ musterd [revive]: steer from ryder',
    );
    expect(Date.now() - started).toBeLessThan(350);
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET');
    expect(seen[0]).toEqual({ type: 'register', mode: 'stdio', client_type: 'musterd' });
    expect(rpc(seen[1]).method).toBe('initialize');
    expect(rpc(seen[2]).method).toBe('session/list');
    const prompt = rpc(seen[3]);
    expect(prompt.method).toBe('session/prompt');
    expect(prompt.params).toEqual({
      sessionId: 'mine-new',
      prompt: [{ type: 'text', text: '⚡ musterd [revive]: steer from ryder' }],
    });
    expect(JSON.stringify(seen)).not.toContain('elsewhere');
  });

  it('does not prompt when no session cwd matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-cwd-'));
    const mine = join(root, 'mine');
    const other = join(root, 'other');
    mkdirSync(mine);
    mkdirSync(other);
    const seen: unknown[] = [];
    const path = await listen((frame, send) => {
      seen.push(frame);
      if (seen.length === 1) {
        send({ type: 'registered', ready: true });
        return;
      }
      if (seen.length === 2) {
        send(acp(1, { protocolVersion: 1 }));
        return;
      }
      send(
        acp(2, {
          sessions: [{ sessionId: 'elsewhere', cwd: other, updatedAt: '2026-10-16T00:00:00.000Z' }],
        }),
      );
    });
    const result = await grokLeader({ GROK_LEADER_SOCKET: path }, mine).inject('x');
    expect(result).toEqual({ ok: false, reason: 'no-session' });
    expect(seen.map((frame) => rpc(frame).method).filter(Boolean)).toEqual([
      'initialize',
      'session/list',
    ]);
  });

  it('a prompt error is prompt-rejected and the message stays out of the reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-cwd-'));
    const path = await listen((frame, send) => {
      const method = rpc(frame).method;
      if (!method) {
        send({ type: 'registered', ready: true });
        return;
      }
      if (method === 'initialize') {
        send(acp(1, { protocolVersion: 1 }));
        return;
      }
      if (method === 'session/list') {
        send(
          acp(2, {
            sessions: [{ sessionId: 's', cwd: root, updatedAt: '2026-10-16T00:00:00.000Z' }],
          }),
        );
        return;
      }
      send({
        type: 'acp',
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          error: { code: -32602, message: 'Invalid params SUPERSECRET' },
        }),
      });
    });
    const result = await grokLeader({ GROK_LEADER_SOCKET: path }, root).inject('x');
    expect(result).toEqual({ ok: false, reason: 'prompt-rejected' });
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(result)).not.toContain('Invalid params');
  });

  it('a closed socket during register is register-failed', async () => {
    const path = await listen((_frame, _send, sock) => sock.end());
    const result = await grokLeader({ GROK_LEADER_SOCKET: path }, tmpdir()).inject('x');
    expect(result).toEqual({ ok: false, reason: 'register-failed' });
  });

  it('a quiet socket after the prompt counts as accepted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-cwd-'));
    const path = await listen((frame, send) => {
      const method = rpc(frame).method;
      if (!method) {
        send({ type: 'registered', ready: true });
        return;
      }
      if (method === 'initialize') send(acp(1, { protocolVersion: 1 }));
      else if (method === 'session/list') {
        send(
          acp(2, {
            sessions: [{ sessionId: 's', cwd: root, updatedAt: '2026-10-16T00:00:00.000Z' }],
          }),
        );
      }
    });
    const started = Date.now();
    const result = await grokLeader({ GROK_LEADER_SOCKET: path }, root).inject('x');
    const elapsed = Date.now() - started;
    expect(result).toEqual({ ok: true });
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(1_500);
  });

  it('prompts the newest cwd match from a later page, not a stale row on the first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-cwd-'));
    const mine = join(root, 'mine');
    const other = join(root, 'other');
    mkdirSync(mine);
    mkdirSync(other);
    const seen: unknown[] = [];
    const path = await listen((frame, send) => {
      seen.push(frame);
      const call = rpc(frame);
      if (!call.method) {
        send({ type: 'registered', ready: true });
        return;
      }
      if (call.method === 'initialize') {
        send(acp(1, { protocolVersion: 1 }));
        return;
      }
      if (call.method !== 'session/list') return;
      const id = call.id ?? 2;
      if (!call.params?.['cursor']) {
        send(
          acp(id, {
            sessions: [
              { sessionId: 'mine-old', cwd: mine, updatedAt: '2026-10-01T00:00:00.000Z' },
              { sessionId: 'elsewhere', cwd: other, updatedAt: '2026-10-20T00:00:00.000Z' },
            ],
            nextCursor: 'page-2',
          }),
        );
        return;
      }
      send(
        acp(id, {
          sessions: [{ sessionId: 'mine-new', cwd: mine, updatedAt: '2026-10-16T00:00:00.000Z' }],
        }),
      );
    });
    const result = await grokLeader({ GROK_LEADER_SOCKET: path }, mine).inject('x');
    expect(result).toEqual({ ok: true });
    const lists = seen.map((frame) => rpc(frame)).filter((call) => call.method === 'session/list');
    expect(lists.map((call) => call.params)).toEqual([{}, { cursor: 'page-2' }]);
    const prompt = seen.map((frame) => rpc(frame)).find((call) => call.method === 'session/prompt');
    expect(prompt?.params).toEqual({
      sessionId: 'mine-new',
      prompt: [{ type: 'text', text: 'x' }],
    });
  });

  it('a rejected cursor is list-failed and prompts nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-cwd-'));
    const mine = join(root, 'mine');
    const other = join(root, 'other');
    mkdirSync(mine);
    mkdirSync(other);
    const seen: unknown[] = [];
    const path = await listen((frame, send) => {
      seen.push(frame);
      const call = rpc(frame);
      if (!call.method) {
        send({ type: 'registered', ready: true });
        return;
      }
      if (call.method === 'initialize') {
        send(acp(1, { protocolVersion: 1 }));
        return;
      }
      if (call.method !== 'session/list') return;
      const id = call.id ?? 2;
      if (!call.params?.['cursor']) {
        send(
          acp(id, {
            sessions: [
              { sessionId: 'elsewhere', cwd: other, updatedAt: '2026-10-20T00:00:00.000Z' },
            ],
            nextCursor: 'page-2',
          }),
        );
        return;
      }
      send({
        type: 'acp',
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'bad cursor SUPERSECRET' },
        }),
      });
    });
    const result = await grokLeader({ GROK_LEADER_SOCKET: path }, mine).inject('x');
    expect(result).toEqual({ ok: false, reason: 'list-failed' });
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET');
    expect(seen.map((frame) => rpc(frame).method).filter(Boolean)).toEqual([
      'initialize',
      'session/list',
      'session/list',
    ]);
  });

  it('stops after eight pages when every page names a new cursor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grok-cwd-'));
    const seen: unknown[] = [];
    const path = await listen((frame, send) => {
      seen.push(frame);
      const call = rpc(frame);
      if (!call.method) {
        send({ type: 'registered', ready: true });
        return;
      }
      if (call.method === 'initialize') {
        send(acp(1, { protocolVersion: 1 }));
        return;
      }
      if (call.method !== 'session/list') return;
      const page = seen.filter((item) => rpc(item).method === 'session/list').length;
      send(
        acp(call.id ?? 2, {
          sessions:
            page === 1
              ? [{ sessionId: 'mine', cwd: root, updatedAt: '2026-10-01T00:00:00.000Z' }]
              : [],
          nextCursor: `page-${page + 1}`,
        }),
      );
    });
    const result = await grokLeader({ GROK_LEADER_SOCKET: path }, root).inject('x');
    expect(result).toEqual({ ok: true });
    const lists = seen.map((frame) => rpc(frame)).filter((call) => call.method === 'session/list');
    expect(lists).toHaveLength(8);
    expect(lists[7]?.params).toEqual({ cursor: 'page-8' });
    const prompt = seen.map((frame) => rpc(frame)).find((call) => call.method === 'session/prompt');
    expect(prompt?.params?.['sessionId']).toBe('mine');
  });

  it('a path that exists and is not a socket names the errno only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-'));
    const path = join(home, 'leader.sock');
    writeFileSync(path, '');
    const result = await grokLeader({ GROK_LEADER_SOCKET: path }, home).inject('x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^connect:/);
    expect(JSON.stringify(result)).not.toContain(path);
  });
});
