import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { MusterdClient } from './client.js';
import type { IdleWake } from './idleWake/decider.js';

/*
 * ADR 558: the client is the idle-wake core's only source of events — every delivered act, every
 * (re)connect — and its heartbeat is how the daemon learns the session's `hearing`. The idle seam
 * reads the daemon's reply strictly: no `seam` echo is an older daemon, which is silence.
 */

let http: Server | null = null;
afterEach(() => {
  http?.close();
  http = null;
});

async function daemon(answer: Record<string, unknown> = { raised: false, seam: 'idle' }) {
  const sockets: WebSocket[] = [];
  const requests: { url: string; headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url?.includes('interrupt-check') ? answer : { ok: true }));
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (f['type'] !== 'claim') return;
      ws.send(
        JSON.stringify({
          type: 'occupied',
          seat: {
            id: 'm1',
            team: 'dawn',
            name: 'Ada',
            role: 'backend',
            kind: 'agent',
            roles: [],
            lifecycle: 'forever',
            created_at: 0,
            presence: 'online',
            presences: [],
          },
          presence_id: 'p1',
          server_time: Date.now(),
          seat_credential: 'msac_ada',
          session_lease: 'msls_live',
          memory: null,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  http = server;
  const { port } = server.address() as { port: number };
  const dir = mkdtempSync(join(tmpdir(), 'musterd-mcp-idle-'));
  mkdirSync(join(dir, '.musterd'));
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: `http://127.0.0.1:${port}`,
      team: 'dawn',
      agent_key: 'mskey_team',
      claim: { mode: 'seat', name: 'Ada' },
    }),
  );
  const client = new MusterdClient({
    server: `http://127.0.0.1:${port}`,
    team: 'dawn',
    agent_key: 'mskey_team',
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'agents@main',
    claim: { mode: 'seat', name: 'Ada' },
    bindingDir: dir,
  } as never);
  return { client, sockets, requests };
}

function stub() {
  return {
    onDeliver: vi.fn(),
    onConnected: vi.fn(),
    hearing: vi.fn(() => ({ hearing: 'deaf', reason: 'no-messaging-socket' })),
    armed: vi.fn(() => false),
  };
}

type Peek = { heartbeatFrame(): Record<string, unknown> };

describe('the client feeds the idle-wake core (ADR 558)', () => {
  it('occupied calls onConnected; a deliver calls onDeliver once per act; the heartbeat carries hearing', async () => {
    const { client, sockets } = await daemon();
    const iw = stub();
    client.attachIdleWake(iw as unknown as IdleWake);
    await client.join(3000);
    expect(iw.onConnected).toHaveBeenCalledTimes(1);
    const envelope = {
      v: 1,
      id: 'A1',
      team: 'dawn',
      from: 'nick',
      to: { kind: 'member', name: 'Ada' },
      act: 'steer',
      body: 'x',
      thread: null,
      meta: null,
      ts: 1,
    };
    sockets[0]!.send(JSON.stringify({ type: 'deliver', envelope }));
    sockets[0]!.send(JSON.stringify({ type: 'deliver', envelope }));
    await vi.waitFor(() => expect(iw.onDeliver).toHaveBeenCalledTimes(1));
    expect(iw.onDeliver.mock.calls[0]![0]).toMatchObject({ id: 'A1', act: 'steer' });
    expect((client as unknown as Peek).heartbeatFrame()).toMatchObject({
      hearing: 'deaf',
      hearing_reason: 'no-messaging-socket',
    });
    client.close();
  });

  it('without a core the heartbeat carries no hearing at all', async () => {
    const { client } = await daemon();
    await client.join(3000);
    expect((client as unknown as Peek).heartbeatFrame()).not.toHaveProperty('hearing');
    client.close();
  });

  it('the idle check asks seam=idle presence-neutrally and maps the reply', async () => {
    const { client, requests } = await daemon({
      raised: true,
      seam: 'idle',
      line: '⚡ line',
      count: 1,
      act: { id: 'A1', from: 'nick', act: 'steer' },
    });
    await client.join(3000);
    expect(await client.idleInterruptCheck('claude-code')).toEqual({
      line: '⚡ line',
      act: 'A1',
      from: 'nick',
    });
    const req = requests.find((r) => r.url.includes('interrupt-check'))!;
    expect(req.url).toContain('seam=idle');
    expect(req.url).toContain('rail=claude-code');
    expect(req.headers['x-musterd-no-touch']).toBe('1');
    client.close();
  });

  it('a daemon that predates the seam (no echo) is silence, and the switch off is { off: true }', async () => {
    const old = await daemon({ raised: true, line: 'l', act: { id: 'A1', from: 'nick' } });
    await old.client.join(3000);
    expect(await old.client.idleInterruptCheck(undefined)).toBeNull();
    old.client.close();
    http?.close();
    const off = await daemon({ raised: false, idle_wake: false, seam: 'idle' });
    await off.client.join(3000);
    expect(await off.client.idleInterruptCheck(undefined)).toEqual({ off: true });
    off.client.close();
  });

  it('reportIdleWake posts the report presence-neutrally and never throws', async () => {
    const { client, requests } = await daemon();
    await client.join(3000);
    client.reportIdleWake({ act: 'A1', outcome: 'injected', harness: 'claude-code' });
    await vi.waitFor(() =>
      expect(requests.some((r) => r.url.endsWith('/inbox/idle-wake'))).toBe(true),
    );
    const req = requests.find((r) => r.url.endsWith('/inbox/idle-wake'))!;
    expect(JSON.parse(req.body)).toEqual({
      act: 'A1',
      outcome: 'injected',
      harness: 'claude-code',
    });
    expect(req.headers['x-musterd-no-touch']).toBe('1');
    client.close();
  });
});
