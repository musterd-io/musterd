import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { operatorCtx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { buildAppRoster, fetchPortrait } from '../notify/appQuickAction.js';
import type { ChannelBinding } from '../store/channelBindings.js';
import { portraitDigest } from '../store/portraits.js';
import { getTeamBySlug } from '../store/teams.js';
import { Hub } from './hub.js';
import { claimAgentHttp, type AgentHttpAuth } from './test-auth.js';

/** A real PNG: `w`×`h`, 8-bit RGBA, one flat colour, with `pad` extra bytes in a tEXt chunk. */
function png(w: number, h: number, pad = 0): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(h * (1 + w * 4), 0x80);
  for (let y = 0; y < h; y++) rows[y * (1 + w * 4)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(pad > 0 ? [chunk('tEXt', Buffer.alloc(pad, 0x61))] : []),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

withDrivers('portrait-http', (_o, kind) => {
  /** `PUT /teams/:slug/members/:name/portrait` (ADR 797). */
  let server: RunningServer;
  let base: string;
  let nick: string;
  let ada: AgentHttpAuth;

  async function put(name: string, auth: string | AgentHttpAuth, body: unknown) {
    const res = await fetch(`${base}/teams/dawn/members/${name}/portrait`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${typeof auth === 'string' ? auth : auth.key}`,
        ...(typeof auth === 'object'
          ? { 'x-musterd-session-lease': auth.sessionLease, 'x-musterd-seat': 'ada' }
          : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
    const res = await fetch(`${base}/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
    });
    const team = (await res.json()) as any;
    nick = team.human_credential;
    await fetch(`${base}/teams/dawn/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${nick}` },
      body: JSON.stringify({ name: 'ada', kind: 'agent' }),
    });
    ada = await claimAgentHttp(base, 'dawn', team.agent_key, nick, 'ada');
  });
  afterEach(async () => {
    await server.close();
  });

  it('a person stores an agent’s portrait; the roster names it and the phone can fetch it', async () => {
    const face = png(64, 64);
    const r = await put('ada', nick, { png: face.toString('base64url') });
    expect(r.status).toBe(200);
    expect(r.json.digest).toBe(portraitDigest(face));

    const ctx = operatorCtx({
      db: server.store,
      traceDb: server.traceStore,
      hub: new Hub(),
      config: server.config,
      rosterRoots: [],
    });
    const team = (await getTeamBySlug(ctx.db, 'dawn'))!;
    const binding = { id: 'b1' } as ChannelBinding;
    const roster = await buildAppRoster(ctx, team, binding, Date.now());
    expect(roster.seats.find((s) => s.seat === 'ada')?.portrait).toBe(r.json.digest);

    const fetched = fetchPortrait(ctx, team, binding, `portrait-${r.json.digest}`, Date.now());
    expect(fetched?.delivery).toMatchObject({ kind: 'portrait', digest: r.json.digest });
    expect(fetched && 'png' in fetched.delivery && fetched.delivery.png).toBe(
      face.toString('base64url'),
    );
    expect(fetchPortrait(ctx, team, binding, 'portrait-0000000000000000', Date.now())).toBeNull();
  });

  it('refuses bytes that are not a PNG', async () => {
    const r = await put('ada', nick, { png: Buffer.from('<html>hi</html>').toString('base64url') });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/not a PNG/);
  });

  it('refuses a PNG that is not 64×64', async () => {
    const r = await put('ada', nick, { png: png(65, 64).toString('base64url') });
    expect(r.status).toBe(400);
  });

  it('refuses an oversize upload before storing anything', async () => {
    const r = await put('ada', nick, { png: png(64, 64, 20_000).toString('base64url') });
    expect(r.status).toBe(413);
  });

  it('refuses an agent seat', async () => {
    const r = await put('ada', ada, { png: png(64, 64).toString('base64url') });
    expect(r.status).toBe(403);
  });

  it('refuses a member who is not on the team', async () => {
    const r = await put('ghost', nick, { png: png(64, 64).toString('base64url') });
    expect(r.status).toBe(404);
  });
});
