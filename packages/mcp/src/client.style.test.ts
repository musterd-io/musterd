import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { MusterdClient } from './client.js';

/**
 * ADR 514 inc 3: the adapter keeps the style envelope the `occupied` frame carries, attests its
 * epoch on the claim and the heartbeat, and can fetch a fresh one from `GET /style-block`.
 */

let http: Server | null = null;
let dir = '';
afterEach(() => {
  http?.close();
  http = null;
  rmSync(dir, { recursive: true, force: true });
});

const DIALS = {
  pushback: 'when-it-matters',
  bluntness: 'plain',
  length: 'normal',
  format: 'prose',
};
const envelope = (epoch: string, length = 'normal') => ({
  block: `Style (epoch ${epoch}) — how you talk here.\nFor nick (in chat, and in any act addressed to nick): pushback when it matters · plain · ${length} · prose.`,
  epoch,
  dials: { ...DIALS, length },
  driver: 'nick',
});

async function daemon(opts: { style: ReturnType<typeof envelope> | null | 'omit' }) {
  const claims: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/teams/dawn/style-block')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(envelope('ffffffff', 'thorough')));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (f['type'] !== 'claim') return;
      claims.push(f);
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
          ...(opts.style === 'omit' ? {} : { style: opts.style }),
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  http = server;
  const { port } = server.address() as { port: number };
  dir = mkdtempSync(join(tmpdir(), 'musterd-mcp-style-'));
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
    surface: 'musterd',
    provenance: 'session',
    workspace: 'agents@main',
    driver: 'nick',
    claim: { mode: 'seat', name: 'Ada' },
    bindingDir: dir,
  } as never);
  return { client, claims };
}

type Peek = { heartbeatFrame(): Record<string, unknown> };

describe('the style envelope on the adapter (ADR 514 inc 3)', () => {
  it('keeps the envelope occupied delivered and attests its epoch on the heartbeat', async () => {
    const { client } = await daemon({ style: envelope('a1b2c3d4') });
    await client.join(3000);
    expect(client.style?.epoch).toBe('a1b2c3d4');
    expect(client.style?.driver).toBe('nick');
    expect((client as unknown as Peek).heartbeatFrame()['style_epoch']).toBe('a1b2c3d4');
    client.close();
  });

  it('an older daemon that sends no envelope: nothing held, nothing attested (Focus 1)', async () => {
    const { client } = await daemon({ style: 'omit' });
    await client.join(3000);
    expect(client.style).toBeNull();
    expect((client as unknown as Peek).heartbeatFrame()).not.toHaveProperty('style_epoch');
    client.close();
  });

  it('refreshStyle fetches the new envelope from /style-block and the heartbeat follows', async () => {
    const { client } = await daemon({ style: envelope('a1b2c3d4') });
    await client.join(3000);
    const next = await client.refreshStyle();
    expect(next?.epoch).toBe('ffffffff');
    expect(next?.dials.length).toBe('thorough');
    expect(client.style?.epoch).toBe('ffffffff');
    expect((client as unknown as Peek).heartbeatFrame()['style_epoch']).toBe('ffffffff');
    client.close();
  });

  it('the first claim attests nothing; a claim made while holding an envelope attests its epoch', async () => {
    const { client, claims } = await daemon({ style: envelope('a1b2c3d4') });
    await client.join(3000);
    expect(claims[0]).not.toHaveProperty('style_epoch');
    expect(
      (client as unknown as { styleAttestation(): Record<string, unknown> }).styleAttestation()[
        'style_epoch'
      ],
    ).toBe('a1b2c3d4');
    client.close();
  });
});
