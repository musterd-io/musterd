import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { createSlackInstallRequest, listSlackInstalls } from '../store/slackInstalls.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * Cloud-direct Slack (spec: Slack ingress §3; away channels 10, lane
 * 01M50ZQQW95YDYVWE2BTCMKKH7): the ingress forwards install records and callbacks
 * to a hosted team's server under its Ed25519 attestation. A forged, stale, or
 * unsigned dispatch must change nothing.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;

function attested(body: string, opts: { key?: typeof privateKey; ts?: number } = {}) {
  const ts = String(opts.ts ?? Date.now());
  const signature = cryptoSign(
    null,
    Buffer.from(`${ts}.${body}`, 'utf8'),
    opts.key ?? privateKey,
  ).toString('base64url');
  return {
    'content-type': 'application/json',
    'x-musterd-ingress-timestamp': ts,
    'x-musterd-ingress-signature': signature,
  };
}

withDrivers('slack ingress (cloud-direct)', (_open, kind) => {
  let server: RunningServer;
  let base: string;

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0, ingressPublicKey: publicPem });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const res = await fetch(base + '/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'dawn', creator: { name: 'nick', kind: 'human' } }),
    });
    expect(res.status).toBe(201);
  });

  afterEach(async () => {
    await server.close();
  });

  async function teamRow() {
    return (await getTeamBySlug(server.store, 'dawn'))!;
  }

  it('an attested install record lands against the minted state; a forged one does not', async () => {
    const team = await teamRow();
    const nick = (await getMemberByName(server.store, team.id, 'nick'))!;
    const { state } = await createSlackInstallRequest(server.store, {
      teamId: team.id,
      actor: nick.name,
    });
    const record = JSON.stringify({
      slack_team_id: 'T9',
      bot_token: 'xoxb-cloud',
      installer_slack_id: 'U9',
      state,
      installed_at: Date.now(),
    });
    const res = await fetch(base + '/teams/dawn/channels/slack/install-record', {
      method: 'POST',
      headers: attested(record),
      body: record,
    } as RequestInit);
    expect(res.status).toBe(201);
    expect(await listSlackInstalls(server.store, team.id)).toHaveLength(1);

    // Forged key: refused, nothing more recorded.
    const { publicKey: _otherPub, privateKey: otherKey } = generateKeyPairSync('ed25519');
    const forged = JSON.stringify({
      slack_team_id: 'T8',
      bot_token: 'xoxb-evil',
      installer_slack_id: 'U8',
      state,
      installed_at: Date.now(),
    });
    const bad = await fetch(base + '/teams/dawn/channels/slack/install-record', {
      method: 'POST',
      headers: attested(forged, { key: otherKey }),
      body: forged,
    } as RequestInit);
    expect(bad.status).toBe(403);
    // Stale timestamp: refused.
    const stale = await fetch(base + '/teams/dawn/channels/slack/install-record', {
      method: 'POST',
      headers: attested(record, { ts: Date.now() - 10 * 60_000 }),
      body: record,
    } as RequestInit);
    expect(stale.status).toBe(403);
    // No attestation at all: refused.
    const bare = await fetch(base + '/teams/dawn/channels/slack/install-record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: record,
    });
    expect(bare.status).toBe(403);
    expect(await listSlackInstalls(server.store, team.id)).toHaveLength(1);
  });

  it('an attested install record with no minted state is refused by the store check', async () => {
    const record = JSON.stringify({
      slack_team_id: 'T9',
      bot_token: 'xoxb-cloud',
      installer_slack_id: 'U9',
      state: 'a-state-this-daemon-never-minted',
      installed_at: Date.now(),
    });
    const res = await fetch(base + '/teams/dawn/channels/slack/install-record', {
      method: 'POST',
      headers: attested(record),
      body: record,
    } as RequestInit);
    expect(res.status).toBe(422);
    const team = await teamRow();
    expect(await listSlackInstalls(server.store, team.id)).toEqual([]);
  });
});
