import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { getMemberByName } from '../store/members.js';
import { localNodeForTeam } from '../store/messages.js';
import { bindSeatToNode, revokeNode } from '../store/nodes.js';
import { getTeamBySlug } from '../store/teams.js';

withDrivers('residence on the roster (ADR 503 Decision 5)', (_o, kind) => {
  /**
   * `GET /teams/:slug/members` states WHERE an enrolled seat lives — from its node binding, never
   * from the hostname string the enrolment declared. Covers the lane's done-means: on a two-node
   * team every enrolled seat carries a residence, an unenrolled one reads null, and a seat whose
   * only binding is revoked reads null (enrolled, nowhere bound).
   */
  let server: RunningServer;
  let base: string;
  let nickCred: string;

  async function post(path: string, body: unknown, auth?: string) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }
  let lastNode: { id: string; label: string } | null = null;
  async function roster(): Promise<Map<string, any>> {
    const res = await fetch(base + '/teams/dawn/members');
    const json = (await res.json()) as {
      members: any[];
      node: { id: string; label: string } | null;
    };
    lastNode = json.node;
    return new Map(json.members.map((m) => [m.name, m]));
  }
  async function enroll(seat: string, host: string): Promise<void> {
    const r = await post(
      '/teams/dawn/residency/enroll',
      { seat, harness: 'claude-code', host },
      nickCred,
    );
    expect(r.status).toBe(201);
  }
  async function joinNode(id: string, label: string): Promise<void> {
    const inv = await post('/teams/dawn/nodes/invite', { label }, nickCred);
    expect(inv.status).toBe(200);
    const joined = await post('/teams/dawn/nodes/join', {
      code: inv.json.invite,
      node_id: id,
      label,
    });
    expect(joined.status).toBe(200);
  }
  async function bind(seat: string, nodeId: string): Promise<void> {
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    const member = (await getMemberByName(server.store, team.id, seat))!;
    const r = await bindSeatToNode(server.store, team.id, member.id, nodeId);
    expect(r.bound).toBe(true);
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0 });
    const { port } = await server.listen();
    base = `http://127.0.0.1:${port}`;
    const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
    nickCred = team.json.human_credential;
    for (const name of ['ada', 'bob', 'cy']) {
      await post('/teams/dawn/members', { name, kind: 'agent' }, nickCred);
    }
  });

  afterEach(async () => {
    await server.close();
  });

  it('names the bound node for every enrolled seat on a two-node team, null otherwise', async () => {
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    const hub = (await localNodeForTeam(server.store, team.id)).id;
    await joinNode('node-air2', 'macbook-air-2.lan');

    // ada: enrolled on the hub. bob: enrolled, declared host says "mac.lan", but BOUND to Air 2 —
    // the binding wins, the stale hostname string does not. cy: never enrolled.
    await enroll('ada', 'mac.lan');
    await bind('ada', hub);
    await enroll('bob', 'mac.lan');
    await bind('bob', 'node-air2');

    const r = await roster();
    expect(r.get('ada').residence).toMatchObject({ node: hub, kind: 'node' });
    expect(r.get('bob').residence).toEqual({
      node: 'node-air2',
      node_label: 'macbook-air-2.lan',
      kind: 'node',
    });
    expect(r.get('cy').wakeable).toBe(false);
    expect(r.get('cy').residence).toBeNull();
    expect(r.get('nick').residence).toBeNull();
    // ADR 503 §4: the page names the answering daemon's own node, so a launcher can tell `here`.
    expect(lastNode).toMatchObject({ id: hub });
  });

  it('reads null for an enrolled seat with no unrevoked binding — enrolled, nowhere bound', async () => {
    const team = (await getTeamBySlug(server.store, 'dawn'))!;
    await enroll('ada', 'laptop.local');
    const before = await roster();
    expect(before.get('ada').wakeable).toBe(true);
    expect(before.get('ada').residence).toBeNull();

    await joinNode('node-gone', 'old laptop');
    await bind('ada', 'node-gone');
    expect((await roster()).get('ada').residence?.node).toBe('node-gone');
    await revokeNode(server.store, team.id, 'node-gone', Date.now());
    expect((await roster()).get('ada').residence).toBeNull();
  });
});
