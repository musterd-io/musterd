import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusterdClient, type McpConfig } from '@musterd/mcp';
import { makeEnvelope, type WakeOrder } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { HttpClient } from '../../packages/cli/src/client.js';
import { findBinding } from '../../packages/cli/src/config.js';
import type { ActuatorBackend, WakeSpec } from '../../packages/cli/src/host/backend.js';
import { pollHostOnce } from '../../packages/cli/src/host/loop.js';
import { provisionOnce } from '../../packages/cli/src/host/provisioner.js';
import { loadHostRegistry } from '../../packages/cli/src/host/registry.js';
import type { Harness } from '../../packages/cli/src/onboard/harness.js';
import { provisionWorkspace } from '../../packages/cli/src/onboard/workspace.js';

/**
 * Scenario E — a sponsor's host runs the agent they created (ADR 463, 06-testing.md).
 *
 * dana (non-admin human) creates `dana-scout`. Her own machine — her host key, her checkout — stands
 * it up, enrolls it, and wakes it once; it greets her. Only the parts that need a real model or a
 * real harness CLI are faked: the harness's MCP wiring, and the woken "session", which is a real
 * MusterdClient claiming the seat with exactly the credentials the provisioner wrote into the
 * seat's binding. Everything else is real: the daemon, the routes, real git, the real provisioner,
 * the real wake loop.
 */

const TEAM = 'sd-t';
let server: RunningServer;
let base: string;
let nick: string;
let dana: string;
let root: string;
let repo: string;
let home: string;
let clients: MusterdClient[] = [];
const savedReg = process.env['MUSTERD_HOST_REGISTRY'];

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-scenario-d-')));
  repo = join(root, 'dana-checkout');
  home = join(root, 'home');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'root'], { cwd: repo });
  process.env['MUSTERD_HOST_REGISTRY'] = join(root, 'host-registry.json');
  writeFileSync(process.env['MUSTERD_HOST_REGISTRY'], JSON.stringify({ entries: [] }));

  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const created = await api('POST', '/teams', {
    slug: TEAM,
    creator: { name: 'nick', kind: 'human', role: 'lead' },
  });
  nick = created.json.human_credential;
  const member = await api('POST', `/teams/${TEAM}/members`, { name: 'dana', kind: 'human' }, nick);
  dana = member.json.human_credential;
  // The team's hosted-agent budget (ADR 463 §2): without it a claimed row fails `no_budget`.
  const policy = await api(
    'POST',
    `/teams/${TEAM}/policy`,
    { agent_host: { policy: { budget_usd: 2 } } },
    nick,
  );
  expect(policy.status).toBe(200);
});

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await server.close();
  rmSync(root, { recursive: true, force: true });
  if (savedReg === undefined) delete process.env['MUSTERD_HOST_REGISTRY'];
  else process.env['MUSTERD_HOST_REGISTRY'] = savedReg;
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Scenario E — a sponsor’s host runs the agent they created', () => {
  it('creates, provisions, wakes once, greets the sponsor, is unconnectable, and dies with its sponsor', async () => {
    const t0 = Date.now();

    // 1–2. dana's machine: a host key for her label (scoped to her seats), and its first poll —
    // the heartbeat a mint looks for.
    const hk = await api(
      'POST',
      `/teams/${TEAM}/agent-bootstrap-credentials`,
      { use: 'host', target: 'dana-mbp' },
      dana,
    );
    expect(hk.status).toBe(201);
    const hostKey: string = hk.json.agent_key;
    const hostClient = new HttpClient({ server: base, key: hostKey }).presenceNeutral();
    expect((await hostClient.claimProvisions(TEAM, 'dana-mbp')).provisions).toEqual([]);

    // 3. dana creates the agent (the `team_agent_create` path): her host is live, so it is hosted there.
    const made = await api('POST', `/teams/${TEAM}/members/agents`, { name: 'dana-scout' }, dana);
    expect(made.status).toBe(201);
    expect(made.json.hosting).toBe('sponsor_host');
    expect(made.json.host).toBe('dana-mbp');

    // 4. The host's provisioner: real git workspace, real provisionSeat (credential, grant, binding),
    // real enrollment. Only the harness's own MCP registration is faked.
    const harness = {
      id: 'claude-code',
      label: 'Claude Code',
      configure: vi.fn(async () => ({ target: 'fake', activation: '' })),
    } as unknown as Harness;
    const log: string[] = [];
    const danaHttp = new HttpClient({ server: base, key: dana });
    const tick = await provisionOnce({
      client: hostClient,
      sponsor: danaHttp,
      team: TEAM,
      server: base,
      host: 'dana-mbp',
      hostKey,
      harness,
      repoRoot: repo,
      clone: false,
      log: (l) => log.push(l),
      // the real one, with the layout's `~` pointed at a tmp home
      provisionWorkspace: (name, opts) => provisionWorkspace(name, { ...opts, home }),
    });
    expect(tick).toEqual({ claimed: 1, ready: 1, failed: 0 });

    const entry = loadHostRegistry().entries.find((e) => e.seat === 'dana-scout')!;
    expect(entry).toMatchObject({ team: TEAM, host: 'dana-mbp', harness: 'claude-code' });
    expect(existsSync(join(entry.workspace, '.musterd', 'binding.json'))).toBe(true);
    const binding = findBinding(entry.workspace, {})!;
    expect(binding).toMatchObject({
      claim: { mode: 'seat', name: 'dana-scout' },
      host_key: hostKey,
    });
    expect(binding.grant).toBeTruthy();
    expect(harness.configure).toHaveBeenCalledTimes(1);
    const provisions = await api(
      'GET',
      `/teams/${TEAM}/host/provisions?host=dana-mbp`,
      undefined,
      hostKey,
    );
    expect(provisions.json.provisions.map((p: any) => [p.agent, p.state])).toEqual([
      ['dana-scout', 'ready'],
    ]);

    // 5. The wake loop: exactly one `provisioned` order; the "session" claims the seat with the
    // binding's own credentials and greets dana.
    const specs: WakeSpec[] = [];
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (spec) => {
        specs.push(spec);
        const b = findBinding(spec.workspace, {})!;
        const cfg: McpConfig = {
          server: spec.server,
          team: spec.team,
          agent_key: b.agent_key!,
          grant: b.grant!,
          surface: 'claude-code',
          bindingDir: mkdtempSync(join(root, 'session-')),
          claim: { mode: 'seat', name: 'dana-scout' },
          provenance: 'wake',
          workspace: 'dana-scout-ws',
          connId: 'conn-dana-scout-1',
          claimCode: 'CC01',
        };
        const session = new MusterdClient(cfg);
        clients.push(session);
        await session.join();
        const env = makeEnvelope({
          id: ulid(),
          team: TEAM,
          from: 'dana-scout',
          to: { kind: 'member', name: 'dana' },
          act: 'message',
          body: 'hi dana — I was just created; what should we build?',
          ts: Date.now(),
        });
        await session.sendEnvelope(env);
        return {
          outcome: { occupied: true, session: 'fresh' },
          settled: Promise.resolve(undefined),
        };
      },
    };
    const orders: WakeOrder[] = [];
    const poll = async () => {
      const r = await pollHostOnce({
        backends: new Map([['claude-code', backend]]),
        bounds: { timeout_ms: 60_000 },
        log: (l) => log.push(l),
        liveness: () => ({ state: 'none' }),
        attendedProcess: () => null,
        verifyWindowMs: 50,
        verifyPollMs: 5,
      });
      await Promise.allSettled(r.settled);
      return r;
    };
    const first = await poll();
    expect(first.orders).toBe(1);
    expect(specs).toHaveLength(1);
    orders.push(specs[0]!.order);
    expect(orders[0]).toMatchObject({
      seat: 'dana-scout',
      reason: 'provisioned',
      lane: 'immediate',
    });
    expect(orders[0]!.act_id).toBeUndefined();
    expect(orders[0]!.composed_line).toContain('dana');
    expect(orders[0]!.bounds?.budget_usd).toBe(2); // the team's agent_host budget reached the wake
    expect(realpathSync(specs[0]!.workspace)).toBe(realpathSync(entry.workspace));

    // …and never a second one: the first wake was the seat's only `provisioned` derivation.
    await delay(50);
    const second = await poll();
    expect(second.orders).toBe(0);

    // 6. dana hears from her agent, well inside the acceptance bound.
    const inbox = await api('GET', `/teams/${TEAM}/inbox`, undefined, dana);
    const greeting = inbox.json.messages.find((m: any) => m.from === 'dana-scout');
    expect(greeting?.body).toContain('what should we build');
    expect(Date.now() - t0).toBeLessThan(10_000);

    // 7. A hosted agent is never connectable over OAuth (ADR 463 §4.1) — by anyone.
    const connect = await api(
      'POST',
      `/teams/${TEAM}/members/agents/dana-scout/connect`,
      undefined,
      dana,
    );
    expect(connect.status).toBe(409);
    expect(JSON.stringify(connect.json)).toMatch(/hosted/);

    // 8. Losing its sponsor takes the agent with it: disabled, its residency gone, no more wakes —
    // and the sponsor's host key stops working with her.
    const removed = await api('POST', `/teams/${TEAM}/members/dana/remove`, undefined, nick);
    expect(removed.status).toBe(200);
    const roster = await api('GET', `/teams/${TEAM}/members`, undefined, nick);
    const scout = roster.json.members.find((m: any) => m.name === 'dana-scout');
    expect(scout.account_status).toBe('disabled');
    const residency = await api('GET', `/teams/${TEAM}/residency`, undefined, nick);
    expect(residency.json.residency.filter((r: any) => r.seat === 'dana-scout')).toEqual([]);
    const after = await poll();
    expect(after.orders).toBe(0);
    expect(
      (await api('POST', `/teams/${TEAM}/host/provisions`, { host: 'dana-mbp' }, hostKey)).status,
    ).toBe(401);
    // the seat file survives; only the standing was revoked
    expect(readFileSync(join(entry.workspace, '.musterd', 'binding.json'), 'utf8')).toContain(
      'dana-scout',
    );
  });
});
