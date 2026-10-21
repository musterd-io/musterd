import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { readNodeState } from '../node/state.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { getTeamBySlug } from '../store/teams.js';
import { pullTeam } from '../sync/pull.js';
import { Hub } from './hub.js';

withDrivers('node-enroll-http', (_o, kind) => {
  /**
   * `POST /node/enroll` (ADR 328 §2) — the local half of enrollment, and the first place in this
   * build where two daemons actually talk.
   *
   * The joiner's daemon holds the v47 `nodes` row whose id must be presented, and it is what will
   * hold the credential, so it makes the call to the hub and writes `node.json` itself. The CLI only
   * asks. This test stands up a real hub and a real joiner on two ports to exercise that.
   */

  let hub: RunningServer;
  let joiner: RunningServer;
  let hubBase: string;
  let joinerBase: string;
  let nickCredential: string;
  let joinerCredential: string;
  let dir: string;

  async function post(base: string, path: string, body?: unknown, auth?: string) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as any) : null };
  }

  /** Give a daemon its own local node row for the team, the way a live one gets it — by writing. */
  async function mintLocalRow(server: RunningServer, slug: string, id: string) {
    const team = (await getTeamBySlug(server.store, slug))!;
    const member = await server.store.get('SELECT id FROM members WHERE team_id = ? LIMIT 1', [
      team.id,
    ])!;
    await insertMessage(
      server.store,
      team.id,
      member.id,
      null,
      makeEnvelope({
        id,
        team: slug,
        from: 'nick',
        to: { kind: 'team' as const },
        act: 'message',
        body: 'hi',
        ts: 1000,
        meta: null,
      }),
    );
    return (await server.store.get('SELECT node_id FROM local_node WHERE team_id = ?', [team.id]))!
      .node_id;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-enroll-'));
    process.env['MUSTERD_NODE_STATE'] = join(dir, 'node.json');

    hub = createServer({ db: await openTestDriver(kind), port: 0 });
    hubBase = `http://127.0.0.1:${(await hub.listen()).port}`;
    // Two daemons on one machine: the joiner gets its own PGlite (one instance would share tables).
    joiner = createServer({ db: await openTestDriver(kind, { instance: 'b' }), port: 0 });
    joinerBase = `http://127.0.0.1:${(await joiner.listen()).port}`;

    // The same team exists on both daemons — roster identity replicates via git (ADR 058), so this
    // is what two machines hosting one team actually look like.
    const created = await post(hubBase, '/teams', {
      slug: 'bravo',
      creator: { name: 'nick', kind: 'human' },
    });
    nickCredential = created.json.human_credential;
    joinerCredential = (
      await post(joinerBase, '/teams', { slug: 'bravo', creator: { name: 'nick', kind: 'human' } })
    ).json.human_credential;
  });

  afterEach(async () => {
    await hub.close();
    await joiner.close();
    delete process.env['MUSTERD_NODE_STATE'];
    rmSync(dir, { recursive: true, force: true });
  });

  describe('POST /node/enroll — the joiner daemon enrolls itself at a hub', () => {
    it('presents its OWN node id and writes the credential to node.json', async () => {
      const joinerNodeId = await mintLocalRow(joiner, 'bravo', 'm-joiner');
      const { json: minted } = await post(
        hubBase,
        '/teams/bravo/nodes/invite',
        { label: 'joiner laptop' },
        nickCredential,
      );

      const res = await post(joinerBase, '/node/enroll', {
        hub_url: hubBase,
        code: minted.invite,
        team: 'bravo',
      });

      expect(res.status).toBe(200);
      // The id the hub bound is the one the joiner already had — no second identity was minted, which
      // is the whole of ADR 331 §Decision 1.
      expect(res.json.node_id).toBe(joinerNodeId);

      const saved = readNodeState().nodes['bravo'];
      expect(saved?.credential).toMatch(/^msnode_/);
      expect(saved?.node_id).toBe(joinerNodeId);
      expect(saved?.hub_url).toBe(hubBase);

      // And the hub now knows it, under the id the joiner presented.
      const hubTeam = (await getTeamBySlug(hub.store, 'bravo'))!;
      const row = await hub.store.get(
        'SELECT label FROM nodes WHERE team_id = ? AND id = ? AND credential_hash IS NOT NULL',
        [hubTeam.id, joinerNodeId],
      );
      expect(row).toBeDefined();
    });

    it('does not return the credential to the caller — it went to disk, not to the CLI', async () => {
      await mintLocalRow(joiner, 'bravo', 'm-joiner');
      const { json: minted } = await post(
        hubBase,
        '/teams/bravo/nodes/invite',
        { label: 'laptop' },
        nickCredential,
      );

      const res = await post(joinerBase, '/node/enroll', {
        hub_url: hubBase,
        code: minted.invite,
        team: 'bravo',
      });

      expect(JSON.stringify(res.json)).not.toContain('msnode_');
      expect(readNodeState().nodes['bravo']?.credential).toMatch(/^msnode_/);
    });

    it("relays the hub's refusal rather than inventing success", async () => {
      await mintLocalRow(joiner, 'bravo', 'm-joiner');

      const res = await post(joinerBase, '/node/enroll', {
        hub_url: hubBase,
        code: 'msinv_never-minted',
        team: 'bravo',
      });

      expect(res.status).toBe(409);
      // Nothing was written — a failed enrollment must not leave a half-credential behind.
      expect(readNodeState().nodes['bravo']).toBeUndefined();
    });

    // ADR 689 (cloud agents 2b-4): a joiner that has never written to its own log — a cloud agent
    // machine on first boot — mints its node row at enrolment instead of being told to "send
    // something first", which on a machine with no human on it meant creating one.
    it('a daemon with the team but no node row mints one at enrolment and enrols', async () => {
      const { json: minted } = await post(
        hubBase,
        '/teams/bravo/nodes/invite',
        { label: 'laptop' },
        nickCredential,
      );

      const res = await post(joinerBase, '/node/enroll', {
        hub_url: hubBase,
        code: minted.invite,
        team: 'bravo',
      });

      expect(res.status).toBe(200);
      const team = (await getTeamBySlug(joiner.store, 'bravo'))!;
      const local = await joiner.store.get<{ node_id: string }>(
        'SELECT node_id FROM local_node WHERE team_id = ?',
        [team.id],
      );
      expect(local?.node_id).toBe(res.json.node_id);
    });

    it('a fresh daemon with no team row at all enrols: node join creates the bare team row, and the hub`s roster arrives by fold', async () => {
      const fresh = createServer({ db: await openTestDriver(kind, { instance: 'c' }), port: 0 });
      const freshBase = `http://127.0.0.1:${(await fresh.listen()).port}`;
      const freshState = join(dir, 'node-fresh.json');
      const previous = process.env['MUSTERD_NODE_STATE'];
      process.env['MUSTERD_NODE_STATE'] = freshState;
      try {
        expect(await getTeamBySlug(fresh.store, 'bravo')).toBeUndefined();
        const { json: minted } = await post(
          hubBase,
          '/teams/bravo/nodes/invite',
          { label: 'cloud agent machine' },
          nickCredential,
        );
        const res = await post(freshBase, '/node/enroll', {
          hub_url: hubBase,
          code: minted.invite,
          team: 'bravo',
        });
        expect(res.status).toBe(200);
        const team = (await getTeamBySlug(fresh.store, 'bravo'))!;
        expect(team).toBeDefined();
        // No human was minted here: the bare row holds no member. The roster travels by git
        // (ADR 058) — addMember stands in for the roster root here — and events by sync: a
        // first pull against the hub completes with the team row the enrolment created.
        expect(
          await fresh.store.get('SELECT id FROM members WHERE team_id = ? LIMIT 1', [team.id]),
        ).toBeUndefined();
        await addMember(fresh.store, team, { name: 'nick', kind: 'human' });
        const ctx: Ctx = {
          db: fresh.store,
          hub: new Hub(),
          config: resolveConfig(),
          rosterRoots: [],
        };
        await expect(pullTeam(ctx, team)).resolves.toBeDefined();
        expect(readNodeState().nodes['bravo']?.node_id).toBe(res.json.node_id);
      } finally {
        process.env['MUSTERD_NODE_STATE'] = previous;
        await fresh.close();
      }
    });

    it('refuses an off-machine caller — enrolling this machine is not remotely initiable', async () => {
      // `trustProxy` is how the suite models a non-local peer while still binding on loopback (the
      // pattern integration.test.ts and secured-bind.test.ts use for the same ADR 040 predicate).
      // Without this case the localhost gate is untested: every other request here comes from
      // 127.0.0.1, so deleting the gate entirely would leave the suite green.
      const proxied = createServer({ db: await openTestDriver(kind), port: 0, trustProxy: true });
      const proxiedBase = `http://127.0.0.1:${(await proxied.listen()).port}`;
      await post(proxiedBase, '/teams', {
        slug: 'bravo',
        creator: { name: 'nick', kind: 'human' },
      });
      await mintLocalRow(proxied, 'bravo', 'm-proxied');

      try {
        const res = await post(proxiedBase, '/node/enroll', {
          hub_url: hubBase,
          code: 'msinv_abc',
          team: 'bravo',
        });
        expect(res.status).toBe(403);
        expect(readNodeState().nodes['bravo']).toBeUndefined();
      } finally {
        await proxied.close();
      }
    });

    it('rejects a hub_url that is not a url before any secret leaves the machine', async () => {
      await mintLocalRow(joiner, 'bravo', 'm-joiner');
      const res = await post(joinerBase, '/node/enroll', {
        hub_url: 'hub.example',
        code: 'msinv_abc',
        team: 'bravo',
      });
      // 400 rather than 422: the daemon's own `parseOrBadRequest` maps a schema failure to
      // bad_request, and this route follows the convention every other body-parsing route uses.
      expect(res.status).toBe(400);
    });
  });

  describe('the hub is the machine the team was created on (ADR 376)', () => {
    async function enrolled() {
      await mintLocalRow(joiner, 'bravo', 'm-joiner');
      const { json: minted } = await post(
        hubBase,
        '/teams/bravo/nodes/invite',
        { label: 'joiner laptop' },
        nickCredential,
      );
      const res = await post(joinerBase, '/node/enroll', {
        hub_url: hubBase,
        code: minted.invite,
        team: 'bravo',
      });
      expect(res.status).toBe(200);
    }

    it('an enrolled joiner cannot mint an invite — the refusal names the hub to mint from (§2)', async () => {
      await enrolled();
      // The joiner's own admin credential, minted when its copy of the team was created.
      const before = (await joiner.store.get('SELECT COUNT(*) AS n FROM node_invites')) as {
        n: number;
      };
      const res = await post(
        joinerBase,
        '/teams/bravo/nodes/invite',
        { label: 'a third machine' },
        joinerCredential,
      );
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('conflict');
      expect(res.json.error.message).toContain(hubBase);
      expect(await joiner.store.get('SELECT COUNT(*) AS n FROM node_invites')).toEqual(before);
    });

    it('a hub cannot enroll — refused before any request leaves the machine (§3)', async () => {
      await enrolled();
      await mintLocalRow(hub, 'bravo', 'm-hub');
      // Point the hub at a URL nothing listens on: if the refusal came AFTER the outbound call, this
      // would be a connection error, not a 409.
      const res = await post(hubBase, '/node/enroll', {
        hub_url: 'http://127.0.0.1:9',
        code: 'msinv_irrelevant',
        team: 'bravo',
      });
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('conflict');
      expect(res.json.error.message).toMatch(/is the hub/);
      expect(readNodeState().nodes['bravo']?.hub_url).toBe(hubBase); // the joiner's record, untouched
    });
  });
});
