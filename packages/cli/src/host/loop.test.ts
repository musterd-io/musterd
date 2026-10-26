import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeEnvelope,
  type Envelope,
  type MemberSummary,
  type WakeOrder,
  type WakeReportBody,
  type WakeTurnBody,
} from '@musterd/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { saveBinding } from '../config.js';
import type { ActuatorBackend, BackendContext, WakeSpec } from './backend.js';
import type {
  GatewaySummary,
  MeteredCall,
  MeteringGateway,
  MeteringGatewayOptions,
} from './gateway.js';
import {
  healBeforeWake,
  pollHostOnce,
  waitedClause,
  type HostPollDeps,
  type WakeClient,
} from './loop.js';
import type { HostRegistryEntry } from './registry.js';
import { SPEND_APPROVAL_WAKE_ENDED, type SpendApprovalSeat } from './spendApproval.js';

/**
 * The loop is exercised entirely through its injectables: no sockets, no spawns, no filesystem.
 * What matters here is the orchestration contract (ADR 131 §2): one lease poll per
 * (server, team, host-label) group, every order reported exactly once — including the orders no
 * backend can serve — and the backend fed the right workspace under the daemon's order.
 */

const order = (over: Partial<WakeOrder> = {}): WakeOrder => ({
  lease_id: 'L1',
  seat: 'scout',
  act_id: 'A1',
  act: 'request_help',
  sender: 'lin',
  lane: 'batched',
  composed_line: 'musterd wake — you are seat "scout" …',
  expires_at: Date.now() + 120_000,
  ...over,
});

const entryOf = (over: Partial<HostRegistryEntry> = {}): HostRegistryEntry => ({
  server: 'http://s1',
  team: 'dawn',
  seat: 'scout',
  workspace: '/ws/scout',
  harness: 'claude-code',
  host: 'mac.lan',
  updated_at: 1,
  ...over,
});

interface FakeCalls {
  leases: { team: string; host: string }[];
  reports: WakeReportBody[];
  progress: string[];
  turns: WakeTurnBody[];
  rosters: number;
}

function fakeClient(
  orders: WakeOrder[],
  members: MemberSummary[][] = [],
): {
  client: WakeClient;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { leases: [], reports: [], progress: [], turns: [], rosters: 0 };
  const client: WakeClient = {
    wakeLeases: async (team, host) => {
      calls.leases.push({ team, host });
      return { orders };
    },
    wakeReport: async (_team, body) => {
      calls.reports.push(body);
      return { ok: true };
    },
    wakeProgress: async (_team, leaseId) => {
      calls.progress.push(leaseId);
      return { ok: true };
    },
    wakeTurn: async (_team, body) => {
      calls.turns.push(body);
      return { ok: true, turn: body.turn };
    },
    roster: async () => {
      const page = members[Math.min(calls.rosters, members.length - 1)] ?? [];
      calls.rosters += 1;
      return { members: page };
    },
  };
  return { client, calls };
}

function fakeBackend(harness = 'claude-code'): { backend: ActuatorBackend; specs: WakeSpec[] } {
  const specs: WakeSpec[] = [];
  return {
    specs,
    backend: {
      harness,
      wake: async (spec) => {
        specs.push(spec);
        return {
          outcome: { occupied: true, session: 'fresh' },
          settled: Promise.resolve(undefined),
        };
      },
    },
  };
}

function deps(over: Partial<HostPollDeps> & Pick<HostPollDeps, 'backends'>): HostPollDeps {
  return {
    bounds: { timeout_ms: 60_000 },
    log: () => undefined,
    readAgentKey: () => 'mskey_test',
    // Deterministic guard state: default = no local session (the pre-capture world).
    liveness: () => ({ state: 'none' }),
    attendedProcess: () => null,
    // Never the real heal in a unit test: it would inspect (and could write) a real folder.
    heal: () => '',
    freshen: () => '',
    verifyWindowMs: 50,
    verifyPollMs: 5,
    // ADR 583: no real gateway in a unit test — the gateway suite covers it; the loop tests
    // below inject a fake to assert the env hand-off and the settle merge.
    gateway: false,
    ...over,
  };
}

describe('pollHostOnce (ADR 131 inc 3 — lease → actuate → report)', () => {
  it('actuates a registered seat: backend gets order + workspace, outcome is reported on the lease', async () => {
    const { client, calls } = fakeClient([order()]);
    const { backend, specs } = fakeBackend();
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(calls.leases).toEqual([{ team: 'dawn', host: 'mac.lan' }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.workspace).toBe('/ws/scout');
    expect(specs[0]!.order.lease_id).toBe('L1');
    // The primary at verification; ADR 436 clause 1 adds a host-stamped supplement at settle.
    expect(calls.reports[0]).toEqual({ lease_id: 'L1', occupied: true, session: 'fresh' });
    expect(result.orders).toBe(1);
    await Promise.all(result.settled);
  });

  it('policy bounds only TIGHTEN the operator ceiling: min(order, --timeout), knobs pass through', async () => {
    const { client } = fakeClient([
      order({ bounds: { timeout_ms: 30_000, max_turns: 9, budget_usd: 2 } }),
      order({ lease_id: 'L2', act_id: 'A2', bounds: { timeout_ms: 900_000 } }),
      order({ lease_id: 'L3', act_id: 'A3' }), // pre-inc-5 daemon: no bounds on the order
    ]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    // Wait — one lease per seat per poll server-side; here three orders exercise the same entry.
    expect(specs).toHaveLength(3);
    expect(specs[0]!.bounds).toEqual({ timeout_ms: 30_000, max_turns: 9, budget_usd: 2 });
    expect(specs[1]!.bounds.timeout_ms).toBe(60_000); // 900s policy clamped to the 60s flag
    expect(lines.join('\n')).toMatch(/clamped/);
    expect(specs[2]!.bounds.timeout_ms).toBe(60_000); // absent bounds ⇒ the operator flag
  });

  it('work_order derivation does not clamp below order.bounds.timeout_ms (ADR 199)', async () => {
    const { client } = fakeClient([
      order({
        lease_id: 'L-wo',
        act_id: 'H1',
        derivation: 'work_order',
        lane_id: 'lane1',
        bounds: { timeout_ms: 1_800_000 },
      }),
    ]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]!.bounds.timeout_ms).toBe(1_800_000);
    expect(lines.join('\n')).toMatch(/work_order using policy timeout/);
    expect(lines.join('\n')).not.toMatch(/clamped/);
  });

  // ADR 494: a dream re-reads the day and writes pages — a working session, timed like a work order.
  it('dream derivation uses the policy timeout without the reply-wake clamp (ADR 494)', async () => {
    const { client } = fakeClient([
      order({
        lease_id: 'L-dream',
        act_id: undefined,
        act: undefined,
        sender: undefined,
        derivation: 'dream',
        intended_delivery: 'fresh',
        bounds: { timeout_ms: 1_800_000 },
      }),
    ]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]!.bounds.timeout_ms).toBe(1_800_000);
    expect(lines.join('\n')).not.toMatch(/clamped/);
  });

  /**
   * Lane 01M1J2V4EJ (2026-09-02): a pre-actuation fault is a property of THIS MACHINE, not of the
   * act — nothing spawned, nothing was paid, and the operator's fix is local. Reported as a failure
   * it burned `attempt_cap` and `hourly_cap` (sloane: two "not in registry" rows in 46s spent 2 of
   * 2/h and 2 of the act's 3 attempts, on a diagnosis that named the wrong thing). ADR 221's line
   * applies: defer, budget-neutral, and stay loud in the host log.
   */
  it('an order for a seat this machine does not hold is DEFERRED (not failed) and stays loud', async () => {
    const { client, calls } = fakeClient([order({ seat: 'ghost', lease_id: 'L9' })]);
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map(),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    expect(calls.reports).toHaveLength(1);
    expect(calls.reports[0]).toMatchObject({
      lease_id: 'L9',
      occupied: false,
      deferred: true,
      wakeability: 'not_enrolled',
    });
    expect(calls.reports[0]!.reason).toMatch(/registered on another machine/);
    expect(lines.join('\n')).toMatch(/wake deferred: ghost.*registered on another machine/);
  });

  it('a hub seat deferred every tick logs once, still reports each time, and logs again when the reason changes (lane 01M41NQ05V)', async () => {
    const deferralsLogged = new Map<string, string>();
    const lines: string[] = [];
    let reports = 0;
    const poll = async (entries: ReturnType<typeof entryOf>[]) => {
      const { client, calls } = fakeClient([order({ seat: 'ghost', lease_id: `L${reports}` })]);
      await pollHostOnce(
        deps({
          backends: new Map(),
          loadRegistry: () => ({ entries }),
          readAgentKey: (ws) => (ws === '/ws/ghost' ? undefined : 'mskey_x'),
          clientFor: () => client,
          log: (l) => lines.push(l),
          deferralsLogged,
        }),
      );
      reports += calls.reports.length;
    };
    await poll([entryOf()]);
    await poll([entryOf()]);
    await poll([entryOf()]);
    expect(reports).toBe(3);
    expect(lines.filter((l) => l.startsWith('wake deferred: ghost'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('wake due: ghost'))).toHaveLength(1);
    // ADR 645 / lane 01M5WXYDQJ: a seat on the other machine behind this label is said to be there,
    // and no hint anywhere prints the retired `--as` (ADR 442).
    expect(lines.join('\n')).toMatch(/registered on another machine/);
    expect(lines.join('\n')).toMatch(/--seat ghost --workspace <its folder>/);
    expect(lines.join('\n')).not.toMatch(/--as/);
    // The seat gets registered here with a dead workspace: a different fault, so it is said.
    await poll([entryOf(), entryOf({ seat: 'ghost', workspace: '/ws/ghost' })]);
    expect(lines.filter((l) => l.startsWith('wake deferred: ghost'))).toHaveLength(2);
    expect(lines.at(-1)).toMatch(/missing or has no binding/);
    expect(lines.at(-1)).toMatch(
      /from an admin's own Workspace, re-run `musterd residency on --seat ghost/,
    );
    expect(lines.join('\n')).not.toMatch(/--as/);
  });

  it('a registered seat whose workspace is unreadable DEFERS as enrolled_dead_workspace (ADR 189)', async () => {
    const { client, calls } = fakeClient([order({ seat: 'ghost', lease_id: 'L8' })]);
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map(),
        // Registry knows the seat, but readAgentKey fails → not spawnable (dead workspace).
        loadRegistry: () => ({
          entries: [entryOf(), entryOf({ seat: 'ghost', workspace: '/ws/ghost' })],
        }),
        readAgentKey: (ws) => (ws === '/ws/ghost' ? undefined : 'mskey_x'),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    expect(calls.reports[0]).toMatchObject({
      lease_id: 'L8',
      occupied: false,
      deferred: true,
      wakeability: 'enrolled_dead_workspace',
    });
    expect(calls.reports[0]!.reason).toMatch(/missing or has no binding/);
    expect(lines.join('\n')).toMatch(/wake deferred: ghost.*missing or has no binding/);
  });

  /**
   * Lane 01M1J2V4EJ (2026-09-02): the poll groups entries by the daemon URL STRING. sloane's
   * binding said `http://localhost:4849` where every sibling said `http://127.0.0.1:4849` — the same
   * socket — so sloane polled alone, the siblings' group claimed its lease first, found no entry
   * for it in THEIR group, and reported "seat not in this machine's host registry" for a seat that
   * was registered and whose operator had already followed the advice. Two entries that differ only
   * in the spelling of the daemon must be one group: one poll, one claim, the right workspace.
   */
  it('entries whose server differs only in spelling (localhost vs 127.0.0.1) are ONE poll group', async () => {
    const { client, calls } = fakeClient([order({ seat: 'sloane', lease_id: 'L7' })]);
    const { backend, specs } = fakeBackend();
    const servers: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({
          entries: [
            entryOf({ server: 'http://127.0.0.1:4849' }),
            entryOf({ server: 'http://localhost:4849/', seat: 'sloane', workspace: '/ws/sloane' }),
          ],
        }),
        clientFor: (server) => {
          servers.push(server);
          return client;
        },
      }),
    );
    expect(calls.leases).toHaveLength(1); // one poll, not one per spelling
    expect(servers).toEqual(['http://127.0.0.1:4849']); // the canonical spelling is what gets dialled
    expect(specs).toHaveLength(1);
    expect(specs[0]!.workspace).toBe('/ws/sloane');
    expect(calls.reports[0]).toEqual({ lease_id: 'L7', occupied: true, session: 'fresh' });
  });

  it('an order for a harness with no backend is reported failed with the harness named', async () => {
    const { client, calls } = fakeClient([order()]);
    await pollHostOnce(
      deps({
        backends: new Map(), // no claude-code backend registered
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(calls.reports[0]).toMatchObject({ lease_id: 'L1', occupied: false });
    expect(calls.reports[0]!.reason).toMatch(/claude-code/);
  });

  it('groups by (server, team, host label): one lease poll covers all seats of a group', async () => {
    const { client, calls } = fakeClient([]);
    await pollHostOnce(
      deps({
        backends: new Map(),
        loadRegistry: () => ({
          entries: [entryOf(), entryOf({ seat: 'kai', workspace: '/ws/kai' })],
        }),
        clientFor: () => client,
      }),
    );
    expect(calls.leases).toEqual([{ team: 'dawn', host: 'mac.lan' }]);
  });

  it('polls once per distinct enrolled host label (hostname drift never silently derives nothing)', async () => {
    const { client, calls } = fakeClient([]);
    await pollHostOnce(
      deps({
        backends: new Map(),
        loadRegistry: () => ({
          entries: [entryOf(), entryOf({ seat: 'kai', host: 'mac.local' })],
        }),
        clientFor: () => client,
      }),
    );
    expect(calls.leases).toEqual([
      { team: 'dawn', host: 'mac.lan' },
      { team: 'dawn', host: 'mac.local' },
    ]);
  });

  it('no readable agent key: the group is skipped with a named warning, not a crash', async () => {
    const { client, calls } = fakeClient([]);
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map(),
        loadRegistry: () => ({ entries: [entryOf()] }),
        readAgentKey: () => undefined,
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    expect(calls.leases).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/no agent key/);
  });

  it('a MIXED group: the seat whose workspace is unreadable is reported, never spawned into', async () => {
    // The single-entry case above hides this bug, because an all-unreadable group is skipped whole.
    // With one healthy seat beside one whose worktree is gone, the group still has a readable key,
    // so the poll proceeds — and the dead seat's order must not reach a backend carrying a cwd that
    // does not exist. Measured on the dogfood machine 2026-07-30: izzo's registry entry named a
    // worktree deleted two weeks earlier, beside miley's and dolly's healthy ones.
    const { client, calls } = fakeClient([
      order({ lease_id: 'L-ok', seat: 'miley', act_id: 'A-ok' }),
      order({ lease_id: 'L-dead', seat: 'izzo', act_id: 'A-dead' }),
    ]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({
          entries: [
            entryOf({ seat: 'miley', workspace: '/ws/miley' }),
            entryOf({ seat: 'izzo', workspace: '/ws/gone' }),
          ],
        }),
        readAgentKey: (ws) => (ws === '/ws/gone' ? undefined : 'mskey_test'),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    // The healthy seat is unaffected — this must not become "skip the whole group".
    expect(specs.map((s) => s.workspace)).toEqual(['/ws/miley']);
    // The dead seat is reported (never dropped — the lease must settle) with a reason that names
    // the workspace, so the operator is not left reading an ENOENT attributed to a stale binary.
    const dead = calls.reports.find((r) => r.lease_id === 'L-dead');
    expect(dead?.occupied).toBe(false);
    expect(dead?.reason).toMatch(/workspace/i);
    expect(dead?.reason).toContain('/ws/gone');
    expect(dead?.deferred).toBe(true); // lane 01M1J2V4EJ: a dead workspace is this machine's fault
    expect(lines.join('\n')).toMatch(/wake deferred: izzo/);
  });

  it('roster verify: offline → live-with-wake-provenance resolves occupied with the provenance', async () => {
    const offline: MemberSummary[] = [
      {
        id: 'm1',
        team: 'dawn',
        name: 'scout',
        kind: 'agent',
        role: '',
        lifecycle: 'forever',
        presence: 'offline',
        presences: [],
        created_at: 1,
      },
    ];
    const woken: MemberSummary[] = [
      {
        ...offline[0]!,
        presence: 'online',
        presences: [
          {
            surface: 'claude-code',
            status: 'online',
            last_seen_at: Date.now() + 1_000, // fresh evidence — touched after the verify began
            provenance: 'wake',
            wake_lease: 'L1', // ADR 241: and attesting THIS lease — the order's `lease_id`
          },
        ],
      },
    ];
    const { client } = fakeClient([order()], [offline, woken]);
    let verified: { occupied: boolean; provenance?: string | null } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout');
        return { outcome: { occupied: verified.occupied }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'wake', lease_matched: true });
  });

  /**
   * ADR 238. A presence row belonging to ANOTHER live session is fresh by definition — whoever owns
   * it keeps touching it — so the debris bar below, which filters by time, cannot exclude it. Verify
   * used to return on the first fresh row of any provenance, so it judged the wake before the woken
   * adapter had claimed, and reported the other session's `session` row as this wake's outcome.
   * Measured live on 2026-08-05: the woken codex adapter's `wake` row appeared ~8s after spawn, well
   * inside the 90s window, behind a stale-but-live `session` row that answered instantly.
   */
  const memberWith = (
    presences: { provenance: string; last_seen_at: number; wake_lease?: string }[],
  ): MemberSummary[] => [
    {
      id: 'm1',
      team: 'dawn',
      name: 'scout',
      kind: 'agent',
      role: '',
      lifecycle: 'forever',
      presence: 'online',
      presences: presences.map((p) => ({
        surface: 'claude-code',
        status: 'online' as const,
        last_seen_at: p.last_seen_at,
        provenance: p.provenance,
        ...(p.wake_lease !== undefined ? { wake_lease: p.wake_lease } : {}),
      })),
      created_at: 1,
    },
  ];

  it('roster verify: waits past another live session for THIS wake, rather than crediting its row', async () => {
    const other = memberWith([{ provenance: 'session', last_seen_at: Date.now() + 1_000 }]);
    const bothRows = memberWith([
      { provenance: 'session', last_seen_at: Date.now() + 1_000 },
      { provenance: 'wake', last_seen_at: Date.now() + 2_000, wake_lease: 'L1' },
    ]);
    // Two polls: the other session answers first, our own adapter claims on the second.
    const { client } = fakeClient([order()], [other, bothRows]);
    let verified: { occupied: boolean; provenance?: string | null } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout');
        return { outcome: { occupied: verified.occupied }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'wake', lease_matched: true });
  });

  /**
   * ADR 241 — the regression gptbot's rejection of ADR 238 asked for, and the point of the whole
   * increment. Increment 1 accepted any fresh `provenance: 'wake'` row as this wake's evidence, but
   * `wake` describes a KIND of session: a PRIOR wake, still alive inside its 30-minute work-order
   * timeout, keeps its row fresh by working. So the later wake was credited to it on the first poll,
   * the act was reported delivered, and no session ever received it — a false SUCCESS, strictly
   * worse than the false failure increment 1 removed, because nothing retries it.
   *
   * The fixture is that exact shape: an old lease's wake row, fresh from the first poll, and this
   * wake's own row arriving later. Verified by mutation — relax the match in `verifyOccupied` back
   * to `p.provenance === 'wake'` and this test reports `lease_matched: true` against L-OLD's row on
   * poll one, which is the bug reproduced.
   */
  it('roster verify: a PRIOR live wake session does not satisfy a later wake (ADR 241)', async () => {
    const priorWake = memberWith([
      { provenance: 'wake', last_seen_at: Date.now() + 1_000, wake_lease: 'L-OLD' },
    ]);
    const ours = memberWith([
      { provenance: 'wake', last_seen_at: Date.now() + 1_000, wake_lease: 'L-OLD' },
      { provenance: 'wake', last_seen_at: Date.now() + 2_000, wake_lease: 'L1' },
    ]);
    const { client } = fakeClient([order()], [priorWake, ours]);
    const seen: { occupied: boolean; provenance?: string | null; lease_matched?: boolean }[] = [];
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        seen.push(await ctx.verifyOccupied('scout'));
        return { outcome: { occupied: true }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    // It waited past the prior wake's row and answered on OUR lease, not on the description it shares.
    expect(seen).toEqual([{ occupied: true, provenance: 'wake', lease_matched: true }]);
  });

  it('roster verify: a seat held ONLY by another wake defers rather than failing (ADR 241)', async () => {
    // The deadline case of the same condition, and the reason `lease_matched` had to replace the
    // provenance test rather than sit beside it: under ADR 238's rule this row read `wake`, so it
    // was NOT held-by-other, so it became a charged failure. The other session is alive and working;
    // this act should wait for it, not pay for it.
    const priorWake = memberWith([
      { provenance: 'wake', last_seen_at: Date.now() + 1_000, wake_lease: 'L-OLD' },
    ]);
    const { client } = fakeClient([order()], [priorWake]);
    let verified: { occupied: boolean; provenance?: string | null; lease_matched?: boolean } = {
      occupied: false,
    };
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout', 300);
        return { outcome: { occupied: false, reason: 'x' }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'wake', lease_matched: false });
  });

  it('roster verify: an UNTOKENED fresh wake row never matches — absence is not an assertion', async () => {
    // ADR 236's subject, restated on this surface: a row from a client that does not attest the
    // token (an older adapter dist) must read as "not mine", never as "close enough". The honest
    // consequence is a deferral until that workspace's dist catches up — ADR 241's rollout note.
    const untokened = memberWith([{ provenance: 'wake', last_seen_at: Date.now() + 1_000 }]);
    const { client } = fakeClient([order()], [untokened]);
    let verified: { occupied: boolean; lease_matched?: boolean } = { occupied: false };
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout', 300);
        return { outcome: { occupied: false, reason: 'x' }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified.lease_matched).toBe(false);
  });

  it('roster verify: a seat held only by a non-wake session resolves occupied with that provenance', async () => {
    // The deadline case of the same condition: nobody but the other session ever shows up. Verify
    // still reports honestly — occupied, provenance `session` — and the BACKEND decides that this is
    // a deferral (someone else holds the seat) rather than a failure of this wake.
    const other = memberWith([{ provenance: 'session', last_seen_at: Date.now() + 1_000 }]);
    const { client } = fakeClient([order()], [other]);
    let verified: { occupied: boolean; provenance?: string | null } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout', 300);
        return { outcome: { occupied: false, reason: 'x' }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'session', lease_matched: false });
  });

  it('roster verify: window expiry without presence resolves occupied=false', async () => {
    const { client } = fakeClient([order()], [[]]);
    let verified: { occupied: boolean } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout');
        return { outcome: { occupied: false, reason: 'x' }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: false, lease_matched: false });
  });

  it('roster verify: STALE presence (pre-spawn last_seen_at) never verifies — the debris bar', async () => {
    // The first live fallback rehearsal (2026-07-13): a presence row lingering from a previous
    // occupancy read non-offline and a dead resume child was reported woke. Only evidence touched
    // at-or-after the spawn counts.
    const stale: MemberSummary[] = [
      {
        id: 'm1',
        team: 'dawn',
        name: 'scout',
        kind: 'agent',
        role: '',
        lifecycle: 'forever',
        presence: 'online',
        presences: [
          {
            surface: 'claude-code',
            status: 'online',
            last_seen_at: Date.now() - 60_000, // a minute old — predates any spawn this tick
            provenance: 'session',
          },
        ],
        created_at: 1,
      },
    ];
    const { client } = fakeClient([order()], [stale]);
    let verified: { occupied: boolean } | undefined;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout', undefined, Date.now());
        return {
          outcome: { occupied: verified.occupied, reason: 'x' },
          settled: Promise.resolve(undefined),
        };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(verified).toEqual({ occupied: false, lease_matched: false });
  });

  it('the local-session guard (inc 4): a live local session defers — backend never called, lease settled', async () => {
    const { client, calls } = fakeClient([order()]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
        liveness: (workspace, harness) => {
          expect(workspace).toBe('/ws/scout'); // judged through the registry's workspace path
          expect(harness).toBe('claude-code');
          return {
            state: 'live',
            session: { harness: 'claude-code', id: 'cap-1', started_at: 1 },
          };
        },
      }),
    );
    expect(specs).toHaveLength(0); // no spawn beside a working session — the whole point
    expect(calls.reports).toEqual([
      { lease_id: 'L1', occupied: false, deferred: true, reason: 'local-session-live' },
    ]);
    expect(lines.join('\n')).toContain('wake deferred: scout');
  });

  it('self-heals the workspace BEFORE the spawn, logs its line, and never lets a heal block the wake (lane 01M3NMZ94D)', async () => {
    // OpenCode has no start hook and a Grok folder can be missing its own, so the SessionStart
    // probe's heal never ran there. The host runs it, for every harness, before spawning.
    const { client } = fakeClient([order()]);
    const order_: string[] = [];
    const { backend, specs } = fakeBackend();
    const wake = backend.wake.bind(backend);
    backend.wake = (spec, ctx) => (order_.push('wake'), wake(spec, ctx));
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
        heal: (workspace) => {
          order_.push(`heal ${workspace}`);
          return 'repaired 5 hooks.';
        },
      }),
    );
    expect(order_).toEqual(['heal /ws/scout', 'wake']);
    expect(lines).toContain('wake self-heal: scout — repaired 5 hooks.');
    expect(specs).toHaveLength(1);

    const { client: c2 } = fakeClient([order()]);
    const { backend: b2, specs: s2 } = fakeBackend();
    const lines2: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', b2]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => c2,
        log: (l) => lines2.push(l),
        heal: () => {
          throw new Error('EACCES');
        },
      }),
    );
    expect(s2).toHaveLength(1); // the wake still went ahead
    expect(lines2).toContain('wake self-heal: scout — skipped (EACCES)');
  });

  it('freshens the checkout before a DREAM wake only, and logs its line (lane 01M41G80VN)', async () => {
    const run = async (derivation: string) => {
      const { client } = fakeClient([order({ derivation } as Partial<WakeOrder>)]);
      const { backend, specs } = fakeBackend();
      const seen: string[] = [];
      const lines: string[] = [];
      await pollHostOnce(
        deps({
          backends: new Map([['claude-code', backend]]),
          loadRegistry: () => ({ entries: [entryOf()] }),
          clientFor: () => client,
          log: (l) => lines.push(l),
          freshen: (workspace) => (seen.push(workspace), 'checkout freshened: aaaaaaaa → bbbbbbbb'),
        }),
      );
      return { seen, lines, specs };
    };
    const dream = await run('dream');
    expect(dream.seen).toEqual(['/ws/scout']);
    expect(dream.lines).toContain(
      'wake dream checkout: scout — checkout freshened: aaaaaaaa → bbbbbbbb',
    );
    expect(dream.specs).toHaveLength(1);
    // A reply or a work order acts on the checkout the seat left — never moved.
    for (const d of ['immediate', 'work_order']) expect((await run(d)).seen).toEqual([]);
  });

  it('healBeforeWake posts the audit row as the seat, forces the drift cache, and returns the line', async () => {
    const posted: unknown[] = [];
    const refreshed: string[] = [];
    const report = {
      build: 'abcdef1',
      repaired: { guidance: 0, hooks: 5 },
      skipped: [],
      remaining: { guidance: 0, hooks: 0, permissions: 0 },
    };
    const line = healBeforeWake('/ws/grokbot', {
      selfHeal: () => ({ ran: true, report, line: 'musterd: repaired 5 hooks.' }),
      refreshDrift: (w) => refreshed.push(w),
      postRepair: async (w, body) => void posted.push([w, body]),
    });
    expect(line).toBe('repaired 5 hooks.');
    expect(posted).toEqual([['/ws/grokbot', report]]);
    expect(refreshed).toEqual(['/ws/grokbot']);
  });

  it('healBeforeWake: a clean folder posts nothing; a failing post never throws into the wake', async () => {
    const posted: unknown[] = [];
    expect(
      healBeforeWake('/ws/a', {
        selfHeal: () => ({ ran: false, report: null, line: '' }),
        refreshDrift: () => undefined,
        postRepair: async (w) => void posted.push(w),
      }),
    ).toBe('');
    expect(posted).toEqual([]);
    const report = {
      build: 'abcdef1',
      repaired: { guidance: 1, hooks: 0 },
      skipped: [],
      remaining: { guidance: 0, hooks: 0, permissions: 0 },
    };
    expect(() =>
      healBeforeWake('/ws/b', {
        selfHeal: () => ({ ran: true, report, line: 'musterd: repaired 1 guidance file.' }),
        refreshDrift: () => undefined,
        postRepair: () => Promise.reject(new Error('daemon down')),
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // the rejection settles without an unhandled error
  });

  it('does not heal a workspace whose wake is deferred — a live session owns the folder', async () => {
    const { client } = fakeClient([order()]);
    const { backend } = fakeBackend();
    let healed = 0;
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        liveness: () => ({
          state: 'live',
          session: { harness: 'claude-code', id: 'c', started_at: 1 },
        }),
        heal: () => (healed++, ''),
      }),
    );
    expect(healed).toBe(0);
  });

  it('defers when an attended session is open but idle — no fresh transcript (ADR 444 backstop)', async () => {
    // 2026-09-22: nick's dolly session was open in the workspace, its transcript idle for minutes,
    // and the daemon no longer saw its presence. The transcript guard passed and a wake ran 25 min
    // beside it. An open, non-headless harness process in the workspace is the attended session.
    const { client, calls } = fakeClient([order()]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
        liveness: () => ({ state: 'resumable' }),
        attendedProcess: (workspace, harness) => {
          expect(workspace).toBe('/ws/scout');
          expect(harness).toBe('claude-code');
          return { pid: 4242 };
        },
      }),
    );
    expect(specs).toHaveLength(0);
    expect(calls.reports).toEqual([
      { lease_id: 'L1', occupied: false, deferred: true, reason: 'attended-session-open' },
    ]);
    expect(lines.join('\n')).toContain('pid 4242');
  });

  it('spawns when the process check cannot tell (undefined) — cannot tell is not attended', async () => {
    const { client } = fakeClient([order()]);
    const { backend, specs } = fakeBackend();
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        attendedProcess: () => undefined,
      }),
    );
    expect(specs).toHaveLength(1);
  });

  it('the guard defers on a demoted conflict too — slot live, enumeration disagrees (ADR 166 inc 3)', async () => {
    // Every resolvable demoted case in the 2026-08-21 sweep inspection was a live session
    // enumeration could not see; the guard question resolves disagreement toward LIVE.
    const { client, calls } = fakeClient([order()]);
    const { backend, specs } = fakeBackend();
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        liveness: () => ({
          state: 'resumable',
          source: 'enumerated',
          slotState: 'live',
          disagreed: true,
          demoted: true,
          session: { harness: 'claude-code', id: 'cap-1', started_at: 1 },
        }),
      }),
    );
    expect(specs).toHaveLength(0);
    expect(calls.reports).toEqual([
      { lease_id: 'L1', occupied: false, deferred: true, reason: 'local-session-live' },
    ]);
  });

  it('passes a Codex registry harness to the local-session guard', async () => {
    const { client } = fakeClient([order()]);
    const { backend, specs } = fakeBackend('codex');
    let seen: string | undefined;
    await pollHostOnce(
      deps({
        backends: new Map([['codex', backend]]),
        loadRegistry: () => ({ entries: [entryOf({ harness: 'codex' })] }),
        clientFor: () => client,
        liveness: (_workspace, harness) => {
          seen = harness;
          return { state: 'none' };
        },
      }),
    );
    expect(seen).toBe('codex');
    expect(specs).toHaveLength(1);
  });

  it('a FAILED wake is loud in the host log — the reason, not a placid "polling"', async () => {
    // The dogfood silence (lane 01KYQ913P5): the reason reached the span and the daemon's audit row,
    // and nothing a human reads. Every wake died on ENOENT for hours while the log said "◉ polling".
    const { client } = fakeClient([order()]);
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([
          [
            'claude-code',
            {
              harness: 'claude-code',
              wake: async () => ({
                outcome: {
                  occupied: false,
                  session: 'fresh' as const,
                  reason: 'spawn failed: spawn /gone/claude ENOENT',
                },
                settled: Promise.resolve(undefined),
              }),
            },
          ],
        ]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
      }),
    );
    const log = lines.join('\n');
    expect(log).toContain('wake FAILED for scout');
    expect(log).toContain('ENOENT');
  });

  it('a DEFERRAL stays quiet — the local-session guard working as designed is not a failure', async () => {
    const { client } = fakeClient([order()]);
    const lines: string[] = [];
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', fakeBackend().backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
        liveness: () => ({
          state: 'live',
          session: { harness: 'claude-code', id: 'cap-1', started_at: 1 },
        }),
      }),
    );
    expect(lines.join('\n')).not.toContain('wake FAILED');
  });

  it('the guard passes resumable/ended/none states straight through to the backend', async () => {
    for (const state of ['resumable', 'gc-expired', 'none'] as const) {
      const { client, calls } = fakeClient([order()]);
      const { backend, specs } = fakeBackend();
      await pollHostOnce(
        deps({
          backends: new Map([['claude-code', backend]]),
          loadRegistry: () => ({ entries: [entryOf()] }),
          clientFor: () => client,
          liveness: () => ({ state }),
        }),
      );
      expect(specs).toHaveLength(1);
      expect(calls.reports[0]!.deferred).toBeUndefined();
    }
  });
});

describe('the supplementary wake-cost report (inc 5)', () => {
  it('posts a second report when the run settles with a summary the primary lacked', async () => {
    const { client, calls } = fakeClient([order()]);
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async () => ({
        outcome: { occupied: true, session: 'fresh' },
        settled: Promise.resolve({ cost_usd: 0.42, duration_ms: 34_000 }),
      }),
    };
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    await Promise.all(result.settled);
    expect(calls.reports).toEqual([
      { lease_id: 'L1', occupied: true, session: 'fresh' },
      { lease_id: 'L1', occupied: true, cost_usd: 0.42, duration_ms: 34_000 },
    ]);
  });

  it('a taken-over run posts one supplement that says yielded, with no cost or duration (ADR 546)', async () => {
    const { client, calls } = fakeClient([order()]);
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async () => ({
        outcome: { occupied: true, session: 'fresh' },
        settled: Promise.resolve({ yielded: true }),
      }),
    };
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    await Promise.all(result.settled);
    expect(calls.reports).toEqual([
      { lease_id: 'L1', occupied: true, session: 'fresh' },
      { lease_id: 'L1', occupied: true, yielded: true },
    ]);
  });

  it('a fast-fail whose primary already carried cost still posts wake_cost; a run with no summary does not', async () => {
    const { client, calls } = fakeClient([order(), order({ lease_id: 'L2', act_id: 'A2' })]);
    let call = 0;
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async () => {
        call += 1;
        return call === 1
          ? {
              // Fast-fail: the primary outcome already carries the summary. The cost ledger
              // is still the supplement — measure 5 joins wake_turns to residency.wake_cost.
              outcome: { occupied: false, session: 'fresh', reason: 'x', cost_usd: 0.05 },
              settled: Promise.resolve({ cost_usd: 0.05, duration_ms: 900 }),
            }
          : {
              // A run that surfaced no summary (hung, killed) — nothing to supplement.
              outcome: { occupied: false, session: 'fresh', reason: 'y' },
              settled: Promise.resolve(undefined),
            };
      },
    };
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    await Promise.all(result.settled);
    expect(calls.reports.filter((r) => r.lease_id === 'L1')).toEqual([
      { lease_id: 'L1', occupied: false, session: 'fresh', reason: 'x', cost_usd: 0.05 },
      { lease_id: 'L1', occupied: false, cost_usd: 0.05, duration_ms: 900 },
    ]);
    expect(calls.reports.filter((r) => r.lease_id === 'L2')).toEqual([
      { lease_id: 'L2', occupied: false, session: 'fresh', reason: 'y' },
    ]);
  });

  it('an OCCUPIED wake whose backend settles with nothing gets a host-stamped duration row (ADR 436 clause 1)', async () => {
    const { client, calls } = fakeClient([order()]);
    const backend: ActuatorBackend = {
      harness: 'grok',
      wake: async () => ({
        outcome: { occupied: true, session: 'fresh' },
        settled: Promise.resolve(undefined),
      }),
    };
    const result = await pollHostOnce(
      deps({
        backends: new Map([['grok', backend]]),
        loadRegistry: () => ({ entries: [entryOf({ harness: 'grok' })] }),
        clientFor: () => client,
      }),
    );
    await Promise.all(result.settled);
    expect(calls.reports).toHaveLength(2);
    const supplement = calls.reports[1]!;
    expect(supplement.lease_id).toBe('L1');
    expect(supplement.duration_ms).toBeTypeOf('number');
    expect(supplement.unpriced_reason).toBe('harness_prints_no_price');
    expect(supplement.cost_usd).toBeUndefined();
  });
});

describe('a wake that settled is over (ADR 436 clause 4)', () => {
  it('the LOOP stamps the claimed capture ended at settle, and never reports the claim', async () => {
    const { client, calls } = fakeClient([order()]);
    const claim = { harness: 'grok', ids: ['wake-L1', undefined], id: 'grok-real' };
    const backend: ActuatorBackend = {
      harness: 'grok',
      wake: async () => ({
        outcome: { occupied: true, session: 'fresh' },
        settled: Promise.resolve({ duration_ms: 900, captures: [claim] }),
      }),
    };
    const ended: { workspace: string; claim: unknown }[] = [];
    const result = await pollHostOnce(
      deps({
        backends: new Map([['grok', backend]]),
        loadRegistry: () => ({ entries: [entryOf({ harness: 'grok' })] }),
        clientFor: () => client,
        endCapture: (workspace, c) => {
          ended.push({ workspace, claim: c });
          return true;
        },
      }),
    );
    await Promise.all(result.settled);
    expect(ended).toEqual([{ workspace: '/ws/scout', claim }]);
    expect(calls.reports[1]).toEqual({ lease_id: 'L1', occupied: true, duration_ms: 900 });
  });
});

describe('pollHostOnce — wake-progress after spawn (ADR 262)', () => {
  it('posts wake-progress after a spawn, before the outcome report', async () => {
    const { client, calls } = fakeClient([order({ derivation: 'work_order', lane_id: 'L' })]);
    const { backend } = fakeBackend();
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(calls.progress).toEqual(['L1']);
    expect(calls.reports.length).toBeGreaterThan(0);
  });

  it('does not post progress on local-session defer or missing registry', async () => {
    const { client, calls } = fakeClient([order()]);
    const { backend } = fakeBackend();
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        liveness: () => ({
          state: 'live',
          session: { harness: 'claude-code', id: 'cap-1', started_at: 1 },
        }),
      }),
    );
    expect(calls.progress).toEqual([]);
    expect(calls.reports[0]?.deferred).toBe(true);

    const missing = fakeClient([order({ seat: 'ghost', lease_id: 'L9' })]);
    await pollHostOnce(
      deps({
        backends: new Map(),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => missing.client,
      }),
    );
    expect(missing.calls.progress).toEqual([]);
  });

  it('a failed wake-progress still reports the outcome', async () => {
    const { client, calls } = fakeClient([order()]);
    client.wakeProgress = async () => {
      calls.progress.push('threw');
      throw new Error('daemon old');
    };
    const { backend } = fakeBackend();
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    expect(calls.reports.length).toBeGreaterThan(0);
  });
});

/**
 * ADR 379 — the actuator spares the child it can identify as its own. The evidence is on the row:
 * `workspace` equal to the label the child attaches with from the spawn path, `attached_at` at or
 * after the spawn, and no `wake_lease`. Every term is positive; a missing `attached_at` (older
 * daemon) or a row created BEFORE the spawn (a human already in the worktree, ADR 068) stays foreign.
 */
describe('verifyOccupied — own child that could not attest its lease (ADR 379)', () => {
  const offline: MemberSummary[] = [
    {
      id: 'm1',
      name: 'scout',
      kind: 'agent',
      role: 'dev',
      presence: 'offline',
      presences: [],
      created_at: 1,
    } as unknown as MemberSummary,
  ];
  const row = (over: Record<string, unknown>) =>
    [
      {
        ...offline[0]!,
        presence: 'online',
        presences: [
          {
            surface: 'codex',
            status: 'online',
            last_seen_at: Date.now() + 1_000,
            provenance: 'session',
            ...over,
          },
        ],
      },
    ] as unknown as MemberSummary[];
  const probe = async (roster: MemberSummary[]) => {
    const { client } = fakeClient([order()], [offline, roster]);
    let verified: Awaited<ReturnType<BackendContext['verifyOccupied']>> | undefined;
    const backend: ActuatorBackend = {
      harness: 'codex',
      wake: async (_spec, ctx) => {
        verified = await ctx.verifyOccupied('scout', 300, Date.now());
        return { outcome: { occupied: verified.occupied }, settled: Promise.resolve(undefined) };
      },
    };
    await pollHostOnce(
      deps({
        backends: new Map([['codex', backend]]),
        // `/ws/scout` is no git repo, so the label the child would attest is the bare folder name.
        loadRegistry: () => ({ entries: [entryOf({ harness: 'codex' })] }),
        clientFor: () => client,
      }),
    );
    return verified!;
  };

  it("a lease-less row in the wake workspace, created after spawn, is the wake's own child", async () => {
    const verified = await probe(row({ workspace: 'scout', attached_at: Date.now() + 500 }));
    expect(verified).toEqual({
      occupied: true,
      provenance: 'session',
      lease_matched: false,
      own_unattested: true,
    });
  });

  it('the same row created BEFORE the spawn is a prior occupant — foreign, defer as before', async () => {
    const verified = await probe(row({ workspace: 'scout', attached_at: Date.now() - 60_000 }));
    expect(verified).toEqual({ occupied: true, provenance: 'session', lease_matched: false });
  });

  it('a row created after spawn in ANOTHER workspace is foreign', async () => {
    const verified = await probe(
      row({ workspace: 'elsewhere@main', attached_at: Date.now() + 500 }),
    );
    expect(verified).toEqual({ occupied: true, provenance: 'session', lease_matched: false });
  });

  it('an older daemon that sends no attached_at cannot qualify — absence is not "created after"', async () => {
    const verified = await probe(row({ workspace: 'scout' }));
    expect(verified).toEqual({ occupied: true, provenance: 'session', lease_matched: false });
  });

  it('a lease-attesting row still wins over an own-unattested one — the token is the stronger evidence', async () => {
    const both = [
      {
        ...offline[0]!,
        presence: 'online',
        presences: [
          {
            surface: 'codex',
            status: 'online',
            last_seen_at: Date.now() + 1_000,
            provenance: 'session',
            workspace: 'scout',
            attached_at: Date.now() + 200,
          },
          {
            surface: 'codex',
            status: 'online',
            last_seen_at: Date.now() + 1_000,
            provenance: 'wake',
            wake_lease: 'L1',
          },
        ],
      },
    ] as unknown as MemberSummary[];
    const verified = await probe(both);
    expect(verified).toEqual({ occupied: true, provenance: 'wake', lease_matched: true });
  });
});

describe('pollHostOnce — actuator credential (ADR 395)', () => {
  const prevConfig = process.env['MUSTERD_CONFIG'];
  afterEach(() => {
    if (prevConfig === undefined) delete process.env['MUSTERD_CONFIG'];
    else process.env['MUSTERD_CONFIG'] = prevConfig;
  });

  it('polls with host_key even when agent_key is a claim-scoped credential', async () => {
    // Production change that would make this fail: defaultReadAgentKey still reading agent_key.
    const dir = mkdtempSync(join(tmpdir(), 'musterd-hostkey-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    saveBinding(dir, {
      version: 2,
      server: 'http://s1',
      team: 'dawn',
      claim: { mode: 'seat', name: 'scout' },
      agent_key: 'mskey_claim_seat',
      host_key: 'mskey_host',
    });
    const { client, calls } = fakeClient([]);
    let used: string | undefined;
    await pollHostOnce({
      backends: new Map(),
      bounds: { timeout_ms: 60_000 },
      log: () => undefined,
      liveness: () => ({ state: 'none' }),
      verifyWindowMs: 50,
      verifyPollMs: 5,
      loadRegistry: () => ({ entries: [entryOf({ workspace: dir })] }),
      clientFor: (_server, key) => {
        used = key;
        return client;
      },
    });
    expect(used).toBe('mskey_host');
    expect(calls.leases).toEqual([{ team: 'dawn', host: 'mac.lan' }]);
  });
});

/** Lane 01M3QRYZM2: `launchctl kickstart -k` SIGTERMs the actuator mid-poll. */
describe('pollHostOnce — stopping mid-poll hands back what it has not started', () => {
  it('an order not yet actuated when the stop signal fires is reported deferred as actuator_restart', async () => {
    const stop = new AbortController();
    const { client, calls } = fakeClient([
      order({ lease_id: 'L1', seat: 'scout' }),
      order({ lease_id: 'L2', seat: 'ghost' }),
    ]);
    const spawned: string[] = [];
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async (spec) => {
        spawned.push(spec.order.lease_id);
        stop.abort(); // the restart lands while the first wake is being verified
        await new Promise((r) => setTimeout(r, 10));
        return {
          outcome: { occupied: true, session: 'fresh' },
          settled: Promise.resolve(undefined),
        };
      },
    };
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({
          entries: [entryOf(), entryOf({ seat: 'ghost', workspace: '/ws/ghost' })],
        }),
        clientFor: () => client,
        signal: stop.signal,
      }),
    );
    await Promise.all(result.settled);
    expect(spawned).toEqual(['L1']); // the wake in progress finishes
    const l2 = calls.reports.filter((r) => r.lease_id === 'L2');
    expect(l2).toHaveLength(1); // reported exactly once, never spawned
    expect(l2[0]).toMatchObject({ occupied: false, deferred: true, reason: 'actuator_restart' });
    // and it went out BEFORE the in-progress wake's report, not after the verify window
    expect(calls.reports.findIndex((r) => r.lease_id === 'L2')).toBeLessThan(
      calls.reports.findIndex((r) => r.lease_id === 'L1'),
    );
  });

  it('an already-stopped poll spawns nothing and hands back every order', async () => {
    const stop = new AbortController();
    stop.abort();
    const { client, calls } = fakeClient([order({ lease_id: 'L1' })]);
    const { backend, specs } = fakeBackend();
    await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        signal: stop.signal,
      }),
    );
    expect(specs).toHaveLength(0);
    expect(calls.reports).toEqual([
      { lease_id: 'L1', occupied: false, deferred: true, reason: 'actuator_restart' },
    ]);
  });
});

/** A backend whose wakes hold (spawned, verifying) until released; it records the peak in flight. */
function gatedBackend(): {
  backend: ActuatorBackend;
  started: string[];
  peak: () => number;
  releaseAll: () => void;
} {
  const started: string[] = [];
  const gates: (() => void)[] = [];
  let inFlight = 0;
  let peak = 0;
  let open = false;
  return {
    started,
    peak: () => peak,
    releaseAll: () => {
      open = true;
      for (const g of gates.splice(0)) g();
    },
    backend: {
      harness: 'claude-code',
      wake: async (spec) => {
        started.push(spec.order.lease_id);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        if (!open) await new Promise<void>((r) => gates.push(r));
        inFlight -= 1;
        return {
          outcome: { occupied: true, session: 'fresh' },
          settled: Promise.resolve(undefined),
        };
      },
    },
  };
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const cast = ['scout', 'ghost', 'dolly', 'wanderer'];

describe('pollHostOnce — a poll starts its due wakes together, bounded (lane 01M4HGY13Z)', () => {
  it("four seats' wakes are all spawned before any of them has verified", async () => {
    const { client, calls } = fakeClient(
      cast.map((seat, i) => order({ seat, lease_id: `L${String(i + 1)}` })),
    );
    const gated = gatedBackend();
    const poll = pollHostOnce(
      deps({
        backends: new Map([['claude-code', gated.backend]]),
        loadRegistry: () => ({
          entries: cast.map((seat) => entryOf({ seat, workspace: `/ws/${seat}` })),
        }),
        clientFor: () => client,
      }),
    );
    // One at a time, the second wake would wait out the first's verification: this never holds.
    await until(() => gated.started.length === 4);
    expect(gated.started).toEqual(['L1', 'L2', 'L3', 'L4']); // spawned in lease order
    gated.releaseAll();
    const result = await poll;
    await Promise.all(result.settled);
    expect(result.orders).toBe(4);
    expect(gated.peak()).toBe(4);
    // Each lease gets exactly one primary report (supplements carry no `session`).
    const primaries = calls.reports.filter((r) => r.session === 'fresh').map((r) => r.lease_id);
    expect(primaries.sort()).toEqual(['L1', 'L2', 'L3', 'L4']);
  });

  it('never has more wakes in flight than the bound', async () => {
    const { client } = fakeClient(
      cast.map((seat, i) => order({ seat, lease_id: `L${String(i)}` })),
    );
    const gated = gatedBackend();
    const poll = pollHostOnce(
      deps({
        backends: new Map([['claude-code', gated.backend]]),
        loadRegistry: () => ({
          entries: cast.map((seat) => entryOf({ seat, workspace: `/ws/${seat}` })),
        }),
        clientFor: () => client,
        maxConcurrentWakes: 2,
      }),
    );
    await until(() => gated.started.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(gated.started).toHaveLength(2); // the other two wait for a slot
    gated.releaseAll();
    await poll;
    expect(gated.started).toHaveLength(4);
    expect(gated.peak()).toBe(2);
  });

  it("two orders for one workspace stay serial: the second waits for the first's outcome", async () => {
    const { client, calls } = fakeClient([
      order({ lease_id: 'L1', seat: 'scout' }),
      order({ lease_id: 'L2', seat: 'scout' }),
    ]);
    const gated = gatedBackend();
    const poll = pollHostOnce(
      deps({
        backends: new Map([['claude-code', gated.backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
      }),
    );
    await until(() => gated.started.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(gated.started).toEqual(['L1']);
    gated.releaseAll();
    await poll;
    expect(gated.started).toEqual(['L1', 'L2']);
    const primaries = calls.reports.filter((r) => r.session === 'fresh').map((r) => r.lease_id);
    expect(primaries).toEqual(['L1', 'L2']);
  });

  it("a second host-label group is polled and woken while the first group's wake verifies", async () => {
    const { client, calls } = fakeClient([]);
    client.wakeLeases = async (team, host) => {
      calls.leases.push({ team, host });
      return {
        orders: [
          host === 'mac.lan'
            ? order({ lease_id: 'L1', seat: 'scout' })
            : order({ lease_id: 'L2', seat: 'kai' }),
        ],
      };
    };
    const gated = gatedBackend();
    const poll = pollHostOnce(
      deps({
        backends: new Map([['claude-code', gated.backend]]),
        loadRegistry: () => ({
          entries: [entryOf(), entryOf({ seat: 'kai', host: 'mac.local', workspace: '/ws/kai' })],
        }),
        clientFor: () => client,
      }),
    );
    await until(() => gated.started.length === 2);
    expect(calls.leases).toEqual([
      { team: 'dawn', host: 'mac.lan' },
      { team: 'dawn', host: 'mac.local' },
    ]);
    gated.releaseAll();
    await poll;
  });
});

describe('the metering gateway rides every wake (ADR 583)', () => {
  function fakeGateway(summary: Partial<GatewaySummary>, calls: MeteredCall[] = []) {
    const started: { leaseId: string; budgetUsd: number | undefined }[] = [];
    let closed = 0;
    const gateway = async (opts: {
      leaseId: string;
      budgetUsd?: number | undefined;
      onCall?: (c: MeteredCall) => void;
    }): Promise<MeteringGateway> => {
      started.push({ leaseId: opts.leaseId, budgetUsd: opts.budgetUsd });
      for (const c of calls) opts.onCall?.(c);
      return {
        port: 1,
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/anthropic' },
        summary: () => ({
          calls: calls.length,
          refused: 0,
          unmetered: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          cost_usd: undefined,
          floor_tokens: null,
          models: [],
          budget_exhausted: false,
          approval_refused: 0,
          approval_wake_ended: false,
          ...summary,
        }),
        close: async () => {
          closed += 1;
        },
      };
    };
    return { gateway, started, closed: () => closed };
  }

  it('hands the gateway env to the backend, posts a wake_turns row per metered call, and prices the supplement from the gateway', async () => {
    const { client, calls } = fakeClient([
      order({ bounds: { timeout_ms: 30_000, budget_usd: 1 } }),
    ]);
    const { backend, specs } = fakeBackend();
    const metered: MeteredCall = {
      turn: 1,
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 500 },
      cost_usd: 0.0002,
      status: 200,
    };
    const g = fakeGateway(
      {
        calls: 1,
        usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 500 },
        cost_usd: 0.0002,
        floor_tokens: 1500,
        models: ['claude-haiku-5-5'],
      },
      [metered],
    );
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        gateway: g.gateway,
      }),
    );
    await Promise.all(result.settled);
    expect(g.started).toEqual([{ leaseId: 'L1', budgetUsd: 1 }]);
    expect(specs[0]!.gateway).toEqual({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/anthropic' },
    });
    expect(calls.turns).toEqual([
      { lease_id: 'L1', turn: 1, usage: metered.usage, cost_usd: 0.0002 },
    ]);
    expect(g.closed()).toBe(1);
    const supplement = calls.reports[1]!;
    expect(supplement).toMatchObject({
      lease_id: 'L1',
      cost_usd: 0.0002,
      price_source: 'gateway',
      usage: { input_tokens: 1000, output_tokens: 10, cached_input_tokens: 500 },
    });
    expect(supplement.unpriced_reason).toBeUndefined();
    expect(supplement.duration_ms).toBeTypeOf('number');
  });

  it('a fast-fail whose primary already carried cost still posts the gateway summary as wake_cost', async () => {
    const { client, calls } = fakeClient([order()]);
    const backend: ActuatorBackend = {
      harness: 'claude-code',
      wake: async () => ({
        outcome: {
          occupied: false,
          session: 'fresh',
          reason: 'x',
          cost_usd: 0.05,
          duration_ms: 900,
        },
        settled: Promise.resolve({ cost_usd: 0.05, duration_ms: 900 }),
      }),
    };
    const g = fakeGateway(
      {
        calls: 1,
        usage: { input_tokens: 100, output_tokens: 10 },
        cost_usd: 0.02,
        models: ['claude-haiku-5-5'],
      },
      [
        {
          turn: 1,
          provider: 'anthropic',
          model: 'claude-haiku-5-5',
          usage: { input_tokens: 100, output_tokens: 10 },
          cost_usd: 0.02,
          status: 200,
        },
      ],
    );
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        gateway: g.gateway,
      }),
    );
    await Promise.all(result.settled);
    const supplement = calls.reports.find((r) => r.price_source === 'gateway');
    expect(supplement).toMatchObject({
      lease_id: 'L1',
      occupied: false,
      cost_usd: 0.02,
      price_source: 'gateway',
      harness_cost_usd: 0.05,
      duration_ms: 900,
    });
    expect(calls.reports.filter((r) => r.lease_id === 'L1')).toHaveLength(2);
  });

  it("a metered wake with no price row reports tokens and no_price_row; the harness's own figure rides as its claim", async () => {
    const { client, calls } = fakeClient([order()]);
    const backend: ActuatorBackend = {
      harness: 'grok',
      wake: async () => ({
        outcome: { occupied: true, session: 'fresh' },
        settled: Promise.resolve({ cost_usd: 0.9, duration_ms: 5_000 }),
      }),
    };
    const g = fakeGateway({
      calls: 2,
      usage: { input_tokens: 40, output_tokens: 4 },
      cost_usd: undefined,
      models: ['muse-spark-1.3'],
      budget_exhausted: true,
      refused: 1,
    });
    const result = await pollHostOnce(
      deps({
        backends: new Map([['grok', backend]]),
        loadRegistry: () => ({ entries: [entryOf({ harness: 'grok' })] }),
        clientFor: () => client,
        gateway: g.gateway,
      }),
    );
    await Promise.all(result.settled);
    const supplement = calls.reports[1]!;
    expect(supplement).toMatchObject({
      price_source: 'gateway',
      unpriced_reason: 'no_price_row',
      harness_cost_usd: 0.9,
      duration_ms: 5_000,
      budget_exhausted: true,
      usage: { input_tokens: 40, output_tokens: 4 },
    });
    expect(supplement.cost_usd).toBeUndefined();
  });

  it('a gateway that saw no calls leaves the harness artifact as the price source, named', async () => {
    const { client, calls } = fakeClient([order()]);
    const backend: ActuatorBackend = {
      harness: 'codex',
      wake: async () => ({
        outcome: { occupied: true, session: 'fresh' },
        settled: Promise.resolve({
          duration_ms: 900,
          usage: { input_tokens: 5, output_tokens: 1 },
          unpriced_reason: 'harness_prints_no_price',
        }),
      }),
    };
    const g = fakeGateway({ calls: 0 });
    const result = await pollHostOnce(
      deps({
        backends: new Map([['codex', backend]]),
        loadRegistry: () => ({ entries: [entryOf({ harness: 'codex' })] }),
        clientFor: () => client,
        gateway: g.gateway,
      }),
    );
    await Promise.all(result.settled);
    expect(g.closed()).toBe(1);
    expect(calls.turns).toEqual([]);
    expect(calls.reports[1]).toMatchObject({
      price_source: 'harness_artifact',
      unpriced_reason: 'harness_prints_no_price',
    });
  });

  it('a gateway that fails to start does not fail the wake: the spec carries no gateway env', async () => {
    const { client, calls } = fakeClient([order()]);
    const { backend, specs } = fakeBackend();
    const lines: string[] = [];
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        log: (l) => lines.push(l),
        gateway: async () => {
          throw new Error('EADDRINUSE');
        },
      }),
    );
    await Promise.all(result.settled);
    expect(specs[0]!.gateway).toBeUndefined();
    expect(calls.reports[0]).toMatchObject({ occupied: true });
    expect(lines.some((l) => l.includes('metering gateway failed to start'))).toBe(true);
  });
});

describe('spend approval is armed once per non-human wake (ADR 636)', () => {
  function acceptingSeat(): { seat: SpendApprovalSeat; sent: Envelope[] } {
    const sent: Envelope[] = [];
    const seat: SpendApprovalSeat = {
      send: async (envelope) => {
        sent.push(envelope);
        return {};
      },
      inbox: async () => {
        const ask = sent.find((e) => e.act === 'ask');
        if (!ask) return { messages: [] };
        return {
          messages: [
            makeEnvelope({
              id: 'acc1',
              team: 'dawn',
              from: 'nick',
              to: { kind: 'team' },
              act: 'accept',
              body: 'ok',
              meta: { in_reply_to: ask.id },
            }),
          ],
        };
      },
    };
    return { seat, sent };
  }

  async function wake(over: Partial<HostPollDeps>, ord: WakeOrder = order()) {
    const { client, calls } = fakeClient([ord]);
    const { backend } = fakeBackend();
    const lines: string[] = [];
    const started: MeteringGatewayOptions[] = [];
    const gateway = async (opts: MeteringGatewayOptions): Promise<MeteringGateway> => {
      started.push(opts);
      return {
        port: 1,
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/anthropic' },
        summary: () => ({
          calls: 0,
          refused: 0,
          unmetered: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          cost_usd: undefined,
          floor_tokens: null,
          models: [],
          budget_exhausted: false,
          approval_refused: 0,
          approval_wake_ended: false,
        }),
        close: async () => undefined,
      };
    };
    const result = await pollHostOnce(
      deps({
        backends: new Map([['claude-code', backend]]),
        loadRegistry: () => ({ entries: [entryOf()] }),
        clientFor: () => client,
        gateway,
        ...over,
        log: (l) => lines.push(l),
      }),
    );
    await Promise.all(result.settled);
    return { calls, lines, started };
  }

  it('an order without spend_approval_usd arms nothing and opens no seat client', async () => {
    let seats = 0;
    const { started, lines } = await wake({
      spendApprovalSeat: () => {
        seats += 1;
        throw new Error('seat opened');
      },
    });
    expect(seats).toBe(0);
    expect(started[0]?.spendApprovalUsd).toBeUndefined();
    expect(started[0]?.onSpendApproval).toBeUndefined();
    expect(lines.some((l) => l.includes('spend approval'))).toBe(false);
  });

  it('an agent wake asks once under its wake lease, names the lane, and leaves budget_usd unchanged', async () => {
    const { seat, sent } = acceptingSeat();
    const opened: string[] = [];
    const { started } = await wake(
      {
        spendApprovalSeat: (_workspace, _team, leaseId) => {
          opened.push(leaseId);
          return seat;
        },
      },
      order({
        lane_id: '01LANE',
        spend_approval_usd: 0.5,
        bounds: { timeout_ms: 30_000, budget_usd: 1 },
      }),
    );
    // ADR 672: the seat client acts for THIS wake's lease — no session lease, no claim.
    expect(opened).toEqual(['L1']);
    expect(started[0]?.budgetUsd).toBe(1);
    expect(started[0]?.spendApprovalUsd).toBe(0.5);
    const verdict = await started[0]!.onSpendApproval!({
      leaseId: 'L1',
      spentUsd: 0.5,
      thresholdUsd: 9,
      signal: new AbortController().signal,
    });
    expect(verdict).toBe('accept');
    const asks = sent.filter((e) => e.act === 'ask');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.meta).toMatchObject({ species: 'approve', tier: 'blocking' });
    expect(asks[0]!.body).toBe('scout lease L1 spent $0.5000, approval $0.5000, lane 01LANE');
    expect(asks[0]!.body.toLowerCase()).not.toContain('prompt');
    expect(started[0]?.budgetUsd).toBe(1);
  });

  it('a seat client that cannot open logs and starts the gateway without a threshold', async () => {
    const { lines, started } = await wake(
      {
        spendApprovalSeat: () => {
          throw new Error('no seat credential');
        },
      },
      order({ spend_approval_usd: 1 }),
    );
    expect(
      lines.some((l) =>
        l.includes('spend approval seat unavailable for scout: no seat credential'),
      ),
    ).toBe(true);
    expect(started[0]?.spendApprovalUsd).toBeUndefined();
    expect(started[0]?.onSpendApproval).toBeUndefined();
  });

  it('a bypassed gateway opens no seat client', async () => {
    let seats = 0;
    const { started } = await wake(
      {
        gateway: false,
        spendApprovalSeat: () => {
          seats += 1;
          throw new Error('seat opened');
        },
      },
      order({ spend_approval_usd: 1 }),
    );
    expect(seats).toBe(0);
    expect(started).toEqual([]);
  });

  it('a gateway that fails to start records no ask', async () => {
    const { seat, sent } = acceptingSeat();
    const { lines } = await wake(
      {
        spendApprovalSeat: () => seat,
        gateway: async () => {
          throw new Error('EADDRINUSE');
        },
      },
      order({ spend_approval_usd: 1 }),
    );
    expect(sent).toEqual([]);
    expect(lines.some((l) => l.includes('metering gateway failed to start'))).toBe(true);
    expect(lines.some((l) => l.includes('spend approval'))).toBe(false);
  });

  it('close before summary puts the wake-ended sentence on the supplement', async () => {
    let ended = false;
    const { calls, lines } = await wake({
      gateway: async () => ({
        port: 1,
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/anthropic' },
        summary: () => ({
          calls: 0,
          refused: 0,
          unmetered: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          cost_usd: undefined,
          floor_tokens: null,
          models: [],
          budget_exhausted: false,
          approval_refused: 1,
          approval_wake_ended: ended,
        }),
        close: async () => {
          ended = true;
        },
      }),
    });
    const supplement = calls.reports[1]!;
    expect(supplement.reason).toBe(SPEND_APPROVAL_WAKE_ENDED);
    expect(supplement.budget_exhausted).toBeUndefined();
    expect(lines.some((l) => l.includes(SPEND_APPROVAL_WAKE_ENDED))).toBe(true);
  });
});

describe('waitedClause (ADR 735)', () => {
  it('says how long the act waited, in the unit that fits, and nothing when the order names no act time', () => {
    const now = 1_700_000_000_000;
    expect(waitedClause(now - 7_000, now)).toBe(', waited 7s');
    expect(waitedClause(now - 432_000, now)).toBe(', waited 7m12s');
    expect(waitedClause(now - 2 * 3_600_000 - 5 * 60_000, now)).toBe(', waited 2h5m');
    expect(waitedClause(undefined, now)).toBe('');
    expect(waitedClause(now + 1_000, now)).toBe('');
  });
});
