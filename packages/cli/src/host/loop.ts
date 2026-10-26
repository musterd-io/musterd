import {
  wakeabilityFromFacts,
  type MemberSummary,
  type PullAnnouncement,
  type PullPollResponse,
  type WakeLeasesResponse,
  type WakeOrder,
  type WakeReportBody,
  type WakeTurnBody,
  type WakeUsage,
  type WorkspaceRepairBody,
} from '@musterd/protocol';
import { resolveWorkspace } from '@musterd/protocol/project';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { HttpClient } from '../client.js';
import { findBinding } from '../config.js';
import { refreshWorkspaceDrift } from '../onboard/doctor.js';
import { describeMirror, mirrorRepoServers, type MirrorResult } from '../onboard/repoServers.js';
import {
  defaultSelfHealDeps,
  selfHealWorkspace,
  type SelfHealOutcome,
} from '../onboard/selfHeal.js';
import { attendedHarnessProcess } from '../session/attendedProcess.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../session/liveness.js';
import { cliBuild } from '../version.js';
import type {
  ActuatorBackend,
  VerifyResult,
  WakeBounds,
  WakeCompletion,
  WakeOutcome,
} from './backend.js';
import { freshenForDream } from './dreamCheckout.js';
import {
  startMeteringGateway,
  type GatewaySummary,
  type MeteringGateway,
  type MeteringGatewayOptions,
} from './gateway.js';
import { canonicalServer, loadHostRegistry, type HostRegistryEntry } from './registry.js';
import {
  SPEND_APPROVAL_WAKE_ENDED,
  armSpendApproval,
  awaitSpendApproval,
  type SpendApprovalSeat,
} from './spendApproval.js';
import { endWakeCapture } from './wakeCapture.js';

export interface HealBeforeWakeDeps {
  selfHeal: (workspace: string) => SelfHealOutcome;
  refreshDrift: (workspace: string) => void;
  /** Best-effort; a rejection is swallowed here and never reaches the wake. */
  postRepair: (workspace: string, body: WorkspaceRepairBody) => Promise<void>;
}

/**
 * The `workspace.repaired` audit row for a host-run heal (lane 01M3T7J6BE). The route takes the
 * seat's own credential with no lease (ADR 408: "the credential hash proves whose workspace it
 * was"), and the host already reads its keys from this same binding — so the row names the seat
 * whose folder was repaired, exactly as the SessionStart probe's row does. A binding with no seat
 * credential is skipped: an agent key names no seat, and a row attributed to nobody is not one.
 */
async function postRepairAsSeat(workspace: string, body: WorkspaceRepairBody): Promise<void> {
  const binding = findBinding(workspace, {});
  if (!binding?.seat_credential || !binding.team || !binding.server) return;
  const http = new HttpClient({ server: binding.server, key: binding.seat_credential });
  await http.presenceNeutral().workspaceRepair(binding.team, body);
}

const realHealDeps = (): HealBeforeWakeDeps => ({
  selfHeal: (w) => selfHealWorkspace(w, defaultSelfHealDeps(cliBuild() ?? 'unstamped')),
  refreshDrift: (w) => refreshWorkspaceDrift(w, undefined, { force: true }),
  postRepair: postRepairAsSeat,
});

/**
 * The real pre-wake heal: the same inspect → repair → re-inspect the SessionStart probe runs, its
 * audit row posted as the seat (fire-and-forget: a dead daemon never delays the spawn), then a
 * forced drift-cache write so the woken session's interrupt checks read what REMAINS (ADR 408
 * inc 4). Returns the one line for the host log, or '' when there was nothing to do.
 */
export function healBeforeWake(workspace: string, d: HealBeforeWakeDeps = realHealDeps()): string {
  const out = d.selfHeal(workspace);
  if (out.ran && out.report) void d.postRepair(workspace, out.report).catch(() => undefined);
  d.refreshDrift(workspace);
  return out.ran ? out.line.replace(/^musterd: /, '') : '';
}

/**
 * The host poll loop (ADR 131 §1) — the actuator half of harness residency, in the `musterd notify`
 * resident-client shape: poll, presence-neutral, best-effort. Each tick reloads the machine-local
 * registry (so `residency on` takes effect without a restart), claims wake leases per
 * (server, team, enrolled-host-label), hands each order to its harness's {@link ActuatorBackend},
 * and reports the outcome inside the lease TTL.
 *
 * Credentials: the loop authenticates with `binding.host_key` (a host-scoped bootstrap credential
 * minted at `residency on`, ADR 395), falling back to `agent_key` when the field is absent. The
 * host is harness-side infrastructure, not a seat, and holds nothing centrally (ADR 131 §1).
 * Claim paths may rewrite `agent_key`; they cannot rewrite `host_key` (saveBinding merge-guard).
 * The woken session occupies via the standing grant in its own binding; the loop never touches it.
 *
 * Telemetry carve-out (ADR 131 O&E): narrator lines per *actuation* only — a quiet tick logs
 * nothing, ever.
 */

/** Roster polling cadence during verification. */
const VERIFY_POLL_MS = 2_000;
/** How long a spawn may take to appear on the roster. Under the 120s lease TTL with margin to
 *  report; a run that hasn't authenticated in this window is a failed wake. */
const VERIFY_WINDOW_MS = 90_000;

/** The slice of {@link HttpClient} the loop drives — injectable so tests never open a socket. */
export interface WakeClient {
  wakeLeases(team: string, host: string): Promise<WakeLeasesResponse>;
  wakeReport(team: string, body: WakeReportBody): Promise<unknown>;
  wakeProgress(team: string, leaseId: string): Promise<unknown>;
  /** ADR 583: one `wake_turns` row per metered model call (the ADR 251 §7 rail, every backend). */
  wakeTurn(team: string, body: WakeTurnBody): Promise<unknown>;
  roster(team: string): Promise<{ members: MemberSummary[] }>;
  /** ADR 645: the band-2 poll. Optional so a test client that never pulls stays a WakeClient. */
  pullPoll?(team: string, host: string): Promise<PullPollResponse>;
}

export interface HostPollDeps {
  /** Backends by harness class. Inc 3 ships `claude-code`; the native loop is inc 6. */
  backends: Map<string, ActuatorBackend>;
  bounds: WakeBounds;
  log: (line: string) => void;
  /** Override every entry's enrolled host label (the `--host` flag). */
  hostLabel?: string;
  // ── injectables (tests) ──
  loadRegistry?: () => { entries: HostRegistryEntry[] };
  readAgentKey?: (workspace: string) => string | undefined;
  clientFor?: (server: string, agentKey: string) => WakeClient;
  liveness?: (workspace: string, harness?: string) => LocalSessionLiveness;
  /** ADR 444 backstop: an open, non-headless harness process in the workspace. */
  attendedProcess?: (workspace: string, harness?: string) => { pid: number } | null | undefined;
  /** ADR 436 clause 4: stamp a settled wake's claimed capture ended. */
  endCapture?: typeof endWakeCapture;
  /** ADR 583: the per-wake metering gateway. `false` runs wakes without one (the `--no-gateway`
   *  flag, and tests that assert the bare spawn); undefined starts the real one per actuation. */
  gateway?: ((opts: MeteringGatewayOptions) => Promise<MeteringGateway>) | false;
  /** ADR 636/672: the seat-credential client that sends the one approve ask and reads the reply,
   *  acting for `leaseId` (sent as the wake lease in place of a session lease). */
  spendApprovalSeat?: (workspace: string, team: string, leaseId: string) => SpendApprovalSeat;
  /** ADR 408 before a wake: repair the workspace; returns the one line to log, or '' when clean. */
  heal?: (workspace: string) => string;
  /** The repo-server mirror run before a spawn (ADR 529; tests). */
  mirror?: (workspace: string) => Promise<MirrorResult>;
  /** Before a DREAM wake only: move a clean, detached workspace to origin/main (lane 01M41G80VN). */
  freshen?: (workspace: string) => string;
  verifyWindowMs?: number;
  verifyPollMs?: number;
  /**
   * Lane 01M3QRYZM2: aborted when the actuator is told to stop (SIGTERM from `launchctl kickstart
   * -k`, SIGINT). A stop mid-poll used to strand every order queued behind the ones being
   * verified: never spawned, never reported, expiring at the lease TTL and then snoozing its seat.
   * On abort each order not yet started is handed back at once as a budget-neutral deferral
   * (`actuator_restart`, which the daemon does not snooze on); orders in progress are left to
   * finish and report as usual.
   */
  signal?: AbortSignal;
  /** Lane 01M4HGY13Z: how many wakes one poll may have spawning and verifying at once (default
   *  {@link HOST_WAKE_CONCURRENCY}). 1 restores the old one-at-a-time actuation. */
  maxConcurrentWakes?: number;
  /**
   * Lane 01M41NQ05V: seat → the deferral reason last logged for it, kept across polls by the
   * actuator. A joiner is handed every hub seat's due wake and defers each — correctly (ADR 393) —
   * but logged `wake due` + `wake deferred` for all of them every tick, burying the one line about
   * a seat that lives here (second-machine run 2026-10-03, finding 4). With this map a repeat of the
   * same deferral is silent; a new reason, or the seat becoming spawnable here, logs again. The
   * daemon still gets every report. Absent (tests): every deferral logs, as before.
   */
  deferralsLogged?: Map<string, string>;
}

/**
 * Lane 01M4HGY13Z: a poll's due wakes start together, at most this many at a time. Actuated one at
 * a time, nick's one message to four seats (2026-10-09) started them one after another over about
 * a minute: each wake held the loop through its spawn and roster verification (~13-40 s for a
 * resumed session), and a second host-label group was not even polled until the first group's
 * wakes had verified. Four covers the cast on one machine without letting a burst of orders spawn
 * an unbounded number of harnesses at once.
 */
export const HOST_WAKE_CONCURRENCY = 4;

/** A FIFO counting semaphore. `acquire` resolves to a release that is safe to call twice. */
export function semaphore(slots: number): { acquire(): Promise<() => void> } {
  let free = Math.max(1, Math.floor(slots));
  const waiters: (() => void)[] = [];
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else free += 1;
  };
  return {
    async acquire() {
      if (free > 0) free -= 1;
      else await new Promise<void>((resolve) => waiters.push(resolve));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    },
  };
}

/** Await every task, then rethrow the first failure — a concurrent poll fails as the serial one
 *  did, but never while a sibling wake is still spawning or reporting. */
async function settleAll(tasks: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/** The deferral reason an actuator sends for an order it was stopped before starting. */
export const ACTUATOR_RESTART_REASON = 'actuator_restart';

/** ADR 583 §2: fold the gateway's summary into the settled completion. The harness's own figure,
 *  when it printed one, rides as `harness_cost_usd` (its claim, ADR 364) beside the metered one. */
export function gatewayCompletion(
  g: GatewaySummary,
  backend: WakeCompletion | undefined,
  actuatedAt: number,
): WakeCompletion {
  const usage: WakeUsage = {
    input_tokens: g.usage.input_tokens,
    output_tokens: g.usage.output_tokens,
    ...(g.usage.cache_read_input_tokens
      ? { cached_input_tokens: g.usage.cache_read_input_tokens }
      : {}),
    ...(g.usage.cache_creation_input_tokens
      ? { cache_write_input_tokens: g.usage.cache_creation_input_tokens }
      : {}),
  };
  const { cost_usd: harnessCost, unpriced_reason: _dropped, ...rest } = backend ?? {};
  return {
    ...rest,
    duration_ms: backend?.duration_ms ?? Date.now() - actuatedAt,
    usage,
    price_source: 'gateway',
    ...(g.cost_usd !== undefined ? { cost_usd: g.cost_usd } : { unpriced_reason: 'no_price_row' }),
    ...(harnessCost !== undefined ? { harness_cost_usd: harnessCost } : {}),
    ...(g.budget_exhausted ? { budget_exhausted: true } : {}),
    ...(g.approval_wake_ended ? { reason: SPEND_APPROVAL_WAKE_ENDED } : {}),
  };
}

/**
 * The seat client the approve ask is sent as. Inbox is peeked and limited to the newest page.
 * ADR 672: it carries the wake lease, not a session lease — the host never claims the seat its
 * wake is occupying; the daemon accepts the credential while that wake's session is live.
 */
export function openSpendApprovalSeat(
  workspace: string,
  team: string,
  leaseId: string,
): SpendApprovalSeat {
  const http = seatHttp(workspace, leaseId);
  return {
    send: (envelope) => http.send(team, envelope),
    inbox: async () => {
      const page = await http.inbox(team, { limit: 50, peek: true });
      return { messages: page.messages };
    },
  };
}

function seatHttp(workspace: string, wakeLease: string): HttpClient {
  const binding = findBinding(workspace, {});
  if (!binding?.seat_credential || !binding.server) throw new Error('no seat credential');
  return new HttpClient({
    server: binding.server,
    key: binding.seat_credential,
    wakeLease,
  }).presenceNeutral();
}

/** One tick's result: how many orders were claimed, and the in-flight actuations (`host --once`
 *  awaits them so the mandatory watchdog is never orphaned by a short-lived host process). */
export interface HostPollResult {
  registered: number;
  orders: number;
  settled: Promise<void>[];
}

export const defaultReadAgentKey = (workspace: string): string | undefined => {
  // Empty env on purpose: a `MUSTERD_BINDING` override in the host's own shell must not shadow
  // the *target workspace's* binding. Prefer host_key (ADR 395): agent_key is the claim
  // authenticator and a woken session may rewrite it.
  const binding = findBinding(workspace, {});
  return binding?.host_key ?? binding?.agent_key;
};

const defaultClientFor = (server: string, agentKey: string): WakeClient => {
  const http = new HttpClient({ server, key: agentKey }).presenceNeutral();
  return {
    wakeLeases: (team, host) => http.wakeLeases(team, host),
    wakeReport: (team, body) => http.wakeReport(team, body),
    wakeProgress: (team, leaseId) => http.wakeProgress(team, { lease_id: leaseId }),
    wakeTurn: (team, body) => http.wakeTurn(team, body),
    roster: (team) => http.roster(team),
    pullPoll: (team, host) => http.pullPoll(team, host),
  };
};

/**
 * ADR 645 §4.3 step 3: redeem a granted pull AS the seat, under the seat's own credential from its
 * workspace binding (enrollment check 3) — never the agent key the poll rode on. The daemon re-runs
 * the ordinary claim checks; a refusal is logged and the hub declines the grant on its TTL.
 */
export async function redeemPullGrant(
  server: string,
  team: string,
  workspace: string,
  offer: PullAnnouncement,
  deps: { log: (line: string) => void; claim?: (key: string) => Promise<unknown> },
): Promise<boolean> {
  const binding = findBinding(workspace, {});
  const key = binding?.seat_credential;
  if (!key) {
    deps.log(
      `! pull ${offer.lane} for ${offer.seat}: no seat credential in ${workspace} — not claimed`,
    );
    return false;
  }
  const claim =
    deps.claim ??
    ((k: string) =>
      new HttpClient({ server, key: k }).presenceNeutral().updateLane(team, offer.lane, {
        owner_seat: offer.seat,
        pick: {
          via: 'pull',
          requested_by: offer.announced_by,
          attested: false,
          ask: offer.ask,
          at: Date.now(),
        },
      }));
  try {
    await claim(key);
    deps.log(`pulled: ${offer.seat} claimed lane ${offer.lane} (announcement ${offer.id})`);
    return true;
  } catch (err) {
    deps.log(`! pull claim refused for ${offer.seat} on ${offer.lane}: ${(err as Error).message}`);
    return false;
  }
}

/** Clock slack for the freshness bar: `last_seen_at` is daemon-stamped, `sinceTs` host-stamped —
 *  same machine today, but a couple of seconds of skew must not reject honest evidence. */
const VERIFY_FRESHNESS_SLACK_MS = 2_000;

/**
 * Roster-derived wake verification (never stdout): occupied when the seat shows presence touched
 * at-or-after `sinceTs` (the spawn) — live, or `reclaimable` (a run so fast the session already
 * exited; its presence row still carries a post-spawn `last_seen_at`). The freshness bar is
 * load-bearing (first live fallback rehearsal, 2026-07-13): a presence row lingering from a
 * PREVIOUS occupancy reads non-offline for minutes after the daemon's lease-eligibility read went
 * offline, and crediting it reported a dead resume child as `woke {session:resumed}` while the act
 * went unanswered. Returns the attested provenance so the backend can flag an adapter that isn't
 * stamping `wake` yet.
 *
 * ADR 241: the evidence bar is IDENTITY, not description. `leaseId` is this wake's own lease, which
 * the actuator handed to the child through `MUSTERD_WAKE_LEASE`; only a row attesting that exact
 * value is this wake's evidence. Descriptions cannot do this job — a prior wake session still inside
 * its 30-minute work-order timeout keeps a fresh `provenance: 'wake'` row, so accepting provenance
 * alone credits the old session instantly and reports a wake that never happened as delivered.
 * `lease_matched` carries the answer out: the backend distinguishes "someone else holds the seat"
 * (defer, budget-neutral) from "nobody occupied" (a real failure that burns).
 */
async function verifyOccupied(
  client: WakeClient,
  team: string,
  seat: string,
  windowMs: number,
  pollMs: number,
  sinceTs: number,
  leaseId: string,
  ownWorkspace?: string,
): Promise<VerifyResult> {
  const deadline = Date.now() + windowMs;
  const freshBar = sinceTs - VERIFY_FRESHNESS_SLACK_MS;
  // ADR 238: the newest occupancy that is not ours, seen so far. Held, not returned — see below.
  let otherOccupancy: { occupied: boolean; provenance?: string | null } | null = null;
  // ADR 379: among the unattested fresh rows, one the actuator can identify as its own child —
  // created in the workspace it spawned into, after it spawned. Held to the deadline like the rest:
  // a lease-attesting row is still the answer if one arrives inside the window.
  let ownUnattested: { provenance?: string | null } | null = null;
  for (;;) {
    const roster = await client.roster(team).catch(() => null);
    const me = roster?.members.find((m) => m.name === seat);
    if (me) {
      const fresh = me.presences.filter((p) => p.last_seen_at >= freshBar);
      if (fresh.length > 0 && (me.presence !== 'offline' || me.reclaimable)) {
        // ADR 241: `p.wake_lease === leaseId` and nothing weaker. An absent token never matches —
        // absence is not an assertion (ADR 236), and reading it as one is the error this whole
        // lane is a chain of.
        const attested = fresh.find((p) => p.wake_lease === leaseId);
        if (attested)
          return { occupied: true, provenance: attested.provenance ?? null, lease_matched: true };
        // ADR 238: a row belonging to ANOTHER live session is fresh by definition — its owner keeps
        // touching it — so the freshness bar above, which filters by time, cannot exclude it.
        // Returning here credited that row to this wake and judged the wake before our own adapter
        // had claimed: measured 2026-08-05, the codex adapter's `wake` row landed ~8s after spawn,
        // behind a `session` row that answered instantly. Keep waiting for OUR evidence; only when
        // the window is spent does the other session's occupancy become the answer — which the
        // backend reads as "someone else holds the seat" and defers on, never as this wake failing.
        otherOccupancy = { occupied: true, provenance: fresh[0]?.provenance ?? null };
        // ADR 379: the actuator spawned into `ownWorkspace` at `sinceTs`. A row with no lease, in
        // that workspace, created at-or-after the spawn is the child it is about to kill for
        // "not attesting" — the codex env-sanitisation class (ADR 354) and any adapter dist that
        // predates the lease token. Every term is a positive fact on the row (ADR 236): absent
        // `attached_at` or `workspace` never qualifies. A row created BEFORE the spawn in the same
        // workspace is a genuine prior occupant (a human in the worktree, ADR 068) and stays foreign.
        const own = ownWorkspace
          ? fresh.find(
              (p) =>
                !p.wake_lease &&
                p.workspace === ownWorkspace &&
                typeof p.attached_at === 'number' &&
                p.attached_at >= freshBar,
            )
          : undefined;
        if (own) ownUnattested = { provenance: own.provenance ?? null };
      }
    }
    if (Date.now() >= deadline) {
      if (ownUnattested)
        return {
          occupied: true,
          provenance: ownUnattested.provenance ?? null,
          lease_matched: false,
          own_unattested: true,
        };
      return otherOccupancy
        ? { ...otherOccupancy, lease_matched: false }
        : { occupied: false, lease_matched: false };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** The `workspace` label a session attaches with from this path (ADR 014 ladder), computed on the
 *  actuator's side so the verifier can recognise its own child's row (ADR 379). Env is deliberately
 *  empty: a `MUSTERD_WORKSPACE` in the HOST's environment describes the host, not the child. Best
 *  effort — a path that cannot be labelled simply disables the own-child match. */
function ownWorkspaceLabel(workspacePath: string): string | undefined {
  try {
    return resolveWorkspace({}, workspacePath);
  } catch {
    return undefined;
  }
}

/** The registry entries one lease poll covers: one (server, team, host-label) tuple. */
export interface PollGroup {
  server: string;
  team: string;
  host: string;
  entries: HostRegistryEntry[];
}

/** Group registry entries by the (server, team, host-label) tuple one lease poll covers. */
export function pollGroups(
  entries: HostRegistryEntry[],
  hostLabel?: string,
): Map<string, PollGroup> {
  const groups = new Map<string, PollGroup>();
  for (const entry of entries) {
    const host = hostLabel ?? entry.host;
    // Lane 01M1J2V4EJ: group on the DAEMON, not on the spelling a binding happened to carry.
    // `localhost` and `127.0.0.1` in two entries put one seat in a group of its own; the other
    // group's poll claimed its lease first and reported the seat unregistered. Entries written
    // before the registry normalised on write are still on disk, so the fold happens here too.
    const server = canonicalServer(entry.server);
    const key = `${server}\u0000${entry.team}\u0000${host}`;
    const group = groups.get(key) ?? { server, team: entry.team, host, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return groups;
}

/**
 * One poll tick: lease → actuate → report, per group. Best-effort throughout — a failed group
 * (unreachable daemon, missing key) is logged and skipped, never fatal to the resident loop.
 *
 * Lane 01M4HGY13Z: every group is polled at once, and the due wakes of all groups share
 * {@link HOST_WAKE_CONCURRENCY} slots, so N seats cost about one spawn-to-roster time, not N.
 * Three things stay serial on purpose:
 * - the preparation before a spawn (guards, heal, mirror, dream checkout, gateway), one order at a
 *   time in lease order: worktrees of one repo share a `.git`, and two dream checkouts fetching at
 *   once can fail on its ref locks. The lock is released once the backend has spawned, so it costs
 *   milliseconds, never a verify window.
 * - two orders for one workspace: the second waits for the first's verified outcome, so its
 *   local-session guard sees the session the first one started, exactly as the serial loop did.
 * - each order's own lease → progress → report sequence, and its verification, unchanged.
 */
export async function pollHostOnce(deps: HostPollDeps): Promise<HostPollResult> {
  const registry = (deps.loadRegistry ?? loadHostRegistry)();
  const readAgentKey = deps.readAgentKey ?? defaultReadAgentKey;
  const clientFor = deps.clientFor ?? defaultClientFor;
  const settled: Promise<void>[] = [];
  let orders = 0;
  const wakeSlots = semaphore(deps.maxConcurrentWakes ?? HOST_WAKE_CONCURRENCY);
  const prepLock = semaphore(1);

  const pollGroup = async (group: PollGroup): Promise<void> => {
    const keyed = group.entries
      .map((e) => ({ entry: e, key: readAgentKey(e.workspace) }))
      .filter((e): e is { entry: HostRegistryEntry; key: string } => e.key !== undefined);
    // `keyed` is not only how the group's auth key is picked — it is the set of entries whose
    // workspace is actually READABLE, which is a precondition for spawning into it at all. Dispatch
    // below resolves seats through this map rather than through `group.entries`, because a MIXED
    // group (one healthy seat, one whose worktree was deleted) keeps `keyed` non-empty and would
    // otherwise sail past the guard above and spawn with a `cwd` that does not exist.
    const spawnable = new Map(keyed.map((k) => [k.entry.seat, k.entry]));
    if (keyed.length === 0) {
      deps.log(
        `! no agent key readable for ${group.team} on ${group.server} — ` +
          `re-run \`musterd residency on\` in a seat's workspace`,
      );
      return;
    }
    const client = clientFor(group.server, keyed[0]!.key);

    let response: WakeLeasesResponse;
    try {
      response = await client.wakeLeases(group.team, group.host);
    } catch (err) {
      deps.log(`! wake-lease poll failed for ${group.team}: ${(err as Error).message}`);
      return;
    }

    // ADR 645: the band-2 pull rides the same tick. Best-effort and quiet: the poll's answer is
    // an announcement in flight (nothing to do), a grant (claim as the seat now), or idle.
    if (client.pullPoll && !deps.signal?.aborted) {
      try {
        const { offer } = await client.pullPoll(group.team, group.host);
        if (offer?.state === 'granted') {
          const entry = spawnable.get(offer.seat);
          if (entry) await redeemPullGrant(group.server, group.team, entry.workspace, offer, deps);
          else deps.log(`! pull granted to ${offer.seat} but its workspace is not readable here`);
        }
      } catch (err) {
        deps.log(`! pull poll failed for ${group.team}: ${(err as Error).message}`);
      }
    }

    // Orders this poll has not started yet. On a stop, whatever is still here is handed back.
    const pending = new Set(response.orders);
    const handBack = () => {
      for (const o of [...pending]) {
        pending.delete(o);
        orders += 1;
        deps.log(`wake handed back: ${o.seat} — actuator stopping (lease ${o.lease_id})`);
        settled.push(
          client
            .wakeReport(group.team, {
              lease_id: o.lease_id,
              occupied: false,
              deferred: true,
              reason: ACTUATOR_RESTART_REASON,
            })
            .then(
              () => undefined,
              (err: Error) =>
                deps.log(`! wake-report failed for lease ${o.lease_id}: ${err.message}`),
            ),
        );
      }
    };
    if (deps.signal?.aborted) handBack();
    else deps.signal?.addEventListener('abort', handBack, { once: true });

    // One order, start to report. `releasePrep` frees the preparation lock for the next order; it
    // is called once this order's backend has spawned (or once it settles without one).
    const actuateOrder = async (order: WakeOrder, releasePrep: () => void): Promise<void> => {
      if (!pending.delete(order)) return; // already handed back by a stop
      orders += 1;
      const entry = spawnable.get(order.seat);
      // Not spawnable here: the deferral reason, decided now so a repeat of a logged one is quiet.
      const registered = entry ? undefined : group.entries.find((e) => e.seat === order.seat);
      const deferral = entry
        ? null
        : registered
          ? `workspace ${registered.workspace} is missing or has no binding — the registry entry ` +
            `outlived it; re-run \`musterd residency on --as <admin>\` in the seat's real workspace`
          : 'seat not in this machine’s host registry — re-run `musterd residency on` in its workspace';
      const repeat = deferral !== null && deps.deferralsLogged?.get(order.seat) === deferral;
      if (entry) deps.deferralsLogged?.delete(order.seat);
      if (!repeat)
        deps.log(
          `wake due: ${order.seat} [${order.lane}] — ${order.act ?? 'work_order'} from ${order.sender ?? 'board'}` +
            waitedClause(order.act_ts, Date.now()) +
            ` (lease ${order.lease_id})`,
        );
      // Every failed wake is loud HERE, in the one place every outcome funnels through, rather than
      // only on the actuation path. The pre-actuation branches below (no registry entry, dead
      // workspace, no backend) settle the lease and `continue` — before this, they did so with the
      // host log showing nothing but a placid "wake due", which is the exact failure mode ADR 179's
      // gate forbids ("a dead rail must be loud within one poll cycle"). A deferral is not a failure
      // and stays quiet: that is the local-session guard working as designed.
      const report = (outcome: WakeOutcome) => {
        if (!outcome.occupied && !outcome.deferred)
          deps.log(
            `! wake FAILED for ${order.seat} (${order.lane}): ` +
              `${outcome.reason ?? 'no reason reported'}`,
          );
        return client
          .wakeReport(group.team, { lease_id: order.lease_id, ...outcome })
          .catch((err: Error) =>
            deps.log(`! wake-report failed for lease ${order.lease_id}: ${err.message}`),
          );
      };

      if (!entry) {
        // Two distinct faults, told apart because the operator's next move differs. Registered but
        // unreadable is the stale-pointer case: an enrollment outlives the worktree it named (a
        // worktree created in the wrong place and later deleted, say), and the registry never
        // notices. Spawning anyway costs an attempt, fails ENOENT, and — because the only ENOENT
        // heal on the path is the one written for a moved `claude` binary — gets reported as a
        // stale binary. Three of those exhaust the act on a diagnosis that names the wrong thing.
        // ADR 189: same enum the wake pool marks with — dead workspace vs not on this host's
        // registry (cross-machine / never-registered mismatch).
        const wakeability = registered
          ? wakeabilityFromFacts({ enrolled: true, workspace_readable: false })
          : wakeabilityFromFacts({ enrolled: false });
        const reason = deferral!;
        // DEFERRED, not failed (lane 01M1J2V4EJ, 2026-09-02; ADR 221's line). Both faults are
        // properties of this machine's bookkeeping — nothing spawned, nothing was paid, and the fix
        // is a local command. Reported as failures they charged `attempt_cap` and `hourly_cap`:
        // two "not in registry" rows 46s apart spent sloane's 2/h and 2 of the act's 3 attempts,
        // on a diagnosis that named the wrong thing. A deferral keeps the act due and the seat's
        // budget whole; the explicit log line below keeps the rail loud (`report` is quiet on
        // deferrals by design — that silence is for the local-session guard, not for this).
        if (!repeat) deps.log(`wake deferred: ${order.seat} — ${reason}`);
        deps.deferralsLogged?.set(order.seat, reason);
        await report({ occupied: false, deferred: true, wakeability, reason });
        return;
      }
      const backend = deps.backends.get(entry.harness);
      if (!backend) {
        await report({
          occupied: false,
          reason: `no "${entry.harness}" backend on this host (increment 3 ships claude-code)`,
        });
        return;
      }

      // The resident-loop telemetry carve-out (ADR 131 O&E): one `musterd.residency.wake` span per
      // ACTUATION — never per tick. A no-op tracer when telemetry is off (opt-in, ADR 115 shape).
      const span = trace.getTracer('musterd-host').startSpan('musterd.residency.wake', {
        attributes: {
          'musterd.seat': order.seat,
          'musterd.lane': order.lane,
          'musterd.act': order.act ?? 'work_order',
          'musterd.lease_id': order.lease_id,
          'musterd.harness': entry.harness,
        },
      });

      // The local-session guard (ADR 131 §5, increment 4): roster-offline ≠ workspace-idle. The
      // daemon leased on presence it can see; only this machine can see a session actively working
      // in the worktree (a daemon bounce dropped the WS once and the wake spawned a CONCURRENT
      // session beside a live human). A live capture ⇒ defer: settle the lease with
      // `deferred: true` — audited as `residency.wake_deferred`, burning no attempt/rate budget —
      // and let the daemon's snooze keep the seat un-leased while the session works.
      const live = deps.liveness
        ? deps.liveness(entry.workspace, entry.harness)
        : localSessionLiveness(entry.workspace, Date.now(), undefined, entry.harness);
      // ADR 166 increment 3: the guard resolves disagreement toward LIVE — a demoted slot
      // (slotState live, enumeration disagreeing) still defers, because the slot only reads live
      // while its own transcript is being written right now.
      if (live.state === 'live' || live.slotState === 'live') {
        deps.log(
          `wake deferred: ${order.seat} — a live local session holds ${entry.workspace} ` +
            `(transcript active); the act stays due`,
        );
        span.setAttribute('musterd.deferred', true);
        span.setStatus({ code: SpanStatusCode.OK });
        await report({ occupied: false, deferred: true, reason: 'local-session-live' });
        span.end();
        return;
      }
      // ADR 444 backstop: the transcript guard cannot see a session that is open but idle — its
      // person stepped away, so nothing is being written. 2026-09-22: that session had also lost its
      // presence, the daemon leased a wake, and the wake ran 25 min beside it. An open, non-headless
      // harness process in the worktree is that session; a wake child is headless and never counts.
      // "Cannot tell" (`undefined`) does not defer: the transcript guard above already ran.
      const attended = (deps.attendedProcess ?? attendedHarnessProcess)(
        entry.workspace,
        entry.harness,
      );
      if (attended) {
        deps.log(
          `wake deferred: ${order.seat} — an attended ${entry.harness} session (pid ${attended.pid}) ` +
            `is open in ${entry.workspace}, idle but not closed; the act stays due`,
        );
        span.setAttribute('musterd.deferred', true);
        span.setStatus({ code: SpanStatusCode.OK });
        await report({ occupied: false, deferred: true, reason: 'attended-session-open' });
        span.end();
        return;
      }
      // ADR 408 self-heal, run by the host before it spawns (lane 01M3NMZ94D). The SessionStart
      // probe heals from INSIDE the harness's own hooks, so it cannot reach a harness that has no
      // start hook (OpenCode's plugin), nor re-install a start hook that is itself missing (a Grok
      // folder with no .grok/hooks/musterd.json). Running it here reaches every harness, and a
      // folder the probe will also heal costs one clean inspection. Never a gate: a heal that
      // throws is logged and the wake goes ahead.
      try {
        const healed = (deps.heal ?? healBeforeWake)(entry.workspace);
        if (healed) deps.log(`wake self-heal: ${order.seat} — ${healed}`);
        // A woken seat gets the repo's MCP servers in its harness too (ADR 529), before the
        // harness starts and reads its config. A failure is logged with the heal's, never a gate.
        const mirrored = describeMirror(
          await (deps.mirror ?? mirrorRepoServers)(entry.workspace),
        ).replace(/^musterd: /, '');
        if (mirrored) deps.log(`wake mirror: ${order.seat} — ${mirrored}`);
      } catch (e) {
        deps.log(`wake self-heal: ${order.seat} — skipped (${(e as Error).message})`);
      }
      // A dream follows a skill on disk (ADR 494), and a seat resting detached days behind main
      // dreams without it (ghost, grokbot, wanderer, 2026-10-03). Only a dream: a reply or a work
      // order acts on the checkout the seat left, and moving it would change what that work saw.
      if (order.derivation === 'dream') {
        const freshened = (deps.freshen ?? freshenForDream)(entry.workspace);
        if (freshened) deps.log(`wake dream checkout: ${order.seat} — ${freshened}`);
      }
      // Effective bounds (increment 5 / ADR 199): reply wakes only tighten the operator
      // `--timeout` ceiling. Work-orders use the seat's `work_timeout_ms` without that clamp —
      // a coding session under a 5m host flag must not silently die at 5m. A dream (ADR 494) is
      // a working session too: it re-reads the day and writes pages, so it is timed the same way.
      const policyTimeout = order.bounds?.timeout_ms;
      const isWorkOrder = order.derivation === 'work_order' || order.derivation === 'dream';
      const timeoutMs =
        policyTimeout !== undefined
          ? isWorkOrder
            ? policyTimeout
            : Math.min(policyTimeout, deps.bounds.timeout_ms)
          : deps.bounds.timeout_ms;
      if (policyTimeout !== undefined && policyTimeout > deps.bounds.timeout_ms && !isWorkOrder)
        deps.log(
          `wake bounds: ${order.seat} policy timeout ${policyTimeout}ms clamped to the ` +
            `host's --timeout ${deps.bounds.timeout_ms}ms ceiling`,
        );
      if (isWorkOrder && policyTimeout !== undefined && policyTimeout > deps.bounds.timeout_ms)
        deps.log(
          `wake bounds: ${order.seat} work_order using policy timeout ${policyTimeout}ms ` +
            `(host --timeout ${deps.bounds.timeout_ms}ms is not a ceiling for work_orders)`,
        );
      // ADR 583: the metering gateway, one per wake, dies with it (closed at settle below). Every
      // metered call lands as a `wake_turns` row at once — fire-and-forget like the native row's
      // rail, one narrator line on the first failure.
      // ADR 636: arm spend approval once, before the gateway listens. ADR 672: the threshold is
      // the order's own `spend_approval_usd` — the daemon sets it for agent and service seats
      // only, so a human wake or an unset policy carries none and arms nothing. The host reads
      // no roster and no report for it; a seat client it cannot open leaves today's path.
      let spendApprovalUsd: number | undefined;
      let onSpendApproval: MeteringGatewayOptions['onSpendApproval'];
      if (deps.gateway !== false) {
        const thresholdUsd = armSpendApproval(order.spend_approval_usd);
        if (thresholdUsd !== undefined) {
          try {
            const seatClient = (deps.spendApprovalSeat ?? openSpendApprovalSeat)(
              entry.workspace,
              group.team,
              order.lease_id,
            );
            spendApprovalUsd = thresholdUsd;
            onSpendApproval = (req) =>
              awaitSpendApproval({
                team: group.team,
                from: order.seat,
                seat: order.seat,
                leaseId: order.lease_id,
                spentUsd: req.spentUsd,
                thresholdUsd,
                laneId: order.lane_id,
                signal: req.signal,
                seatClient,
                log: deps.log,
              });
          } catch (err) {
            deps.log(
              `spend approval seat unavailable for ${order.seat}: ${(err as Error).message}`,
            );
          }
        }
      }
      let turnPostFailed = false;
      const gateway =
        deps.gateway === false
          ? undefined
          : await (deps.gateway ?? startMeteringGateway)({
              leaseId: order.lease_id,
              budgetUsd: order.bounds?.budget_usd,
              ...(spendApprovalUsd !== undefined && onSpendApproval !== undefined
                ? { spendApprovalUsd, onSpendApproval }
                : {}),
              log: deps.log,
              onCall: (call) => {
                void client
                  .wakeTurn(group.team, {
                    lease_id: order.lease_id,
                    turn: call.turn,
                    usage: call.usage,
                    ...(call.cost_usd !== undefined ? { cost_usd: call.cost_usd } : {}),
                  })
                  .catch((err: Error) => {
                    if (!turnPostFailed)
                      deps.log(`! wake-turn post failed for ${order.seat}: ${err.message}`);
                    turnPostFailed = true;
                  });
              },
            }).catch((err: Error) => {
              deps.log(
                `! metering gateway failed to start for ${order.seat}: ${err.message} — wake runs unmetered`,
              );
              return undefined;
            });
      const spawning = backend.wake(
        {
          order,
          team: group.team,
          server: group.server,
          workspace: entry.workspace,
          bounds: {
            timeout_ms: timeoutMs,
            ...(order.bounds?.max_turns !== undefined ? { max_turns: order.bounds.max_turns } : {}),
            ...(order.bounds?.budget_usd !== undefined
              ? { budget_usd: order.bounds.budget_usd }
              : {}),
          },
          ...(gateway ? { gateway: { env: gateway.env, origin: gateway.origin } } : {}),
          ...(entry.key_env !== undefined ? { key_env: entry.key_env } : {}),
        },
        {
          verifyOccupied: (seat, windowMs, sinceTs) =>
            verifyOccupied(
              client,
              group.team,
              seat,
              windowMs ?? deps.verifyWindowMs ?? VERIFY_WINDOW_MS,
              deps.verifyPollMs ?? VERIFY_POLL_MS,
              sinceTs ?? Date.now(),
              // ADR 241: bound HERE, from the order the loop is actuating — never passed in by the
              // backend. A backend cannot name a lease other than the one it was handed.
              order.lease_id,
              // ADR 379: the label the child will attest for THIS workspace — the same resolver the
              // adapter runs in its cwd, with the host's own env kept out of it.
              ownWorkspaceLabel(entry.workspace),
            ),
          log: deps.log,
        },
      );
      // The backend has spawned (its synchronous start has run); the next order may prepare while
      // this one waits out its verification.
      releasePrep();
      const actuation = await spawning;
      span.setAttribute('musterd.occupied', actuation.outcome.occupied);
      if (actuation.outcome.reason) span.setAttribute('musterd.reason', actuation.outcome.reason);
      span.setStatus({
        code: actuation.outcome.occupied ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      });
      if (!actuation.outcome.deferred) {
        await client
          .wakeProgress(group.team, order.lease_id)
          .catch((err: Error) =>
            deps.log(`! wake-progress failed for lease ${order.lease_id}: ${err.message}`),
          );
      }
      // The loud-failure log for this outcome lives in `report` above, so every branch that settles
      // a lease — actuation and the pre-actuation bail-outs alike — is equally loud. It was here
      // alone until 2026-07-31, which is why a dead registry entry could fail three times in silence.
      await report(actuation.outcome);
      span.end();
      // The supplementary cost report (increment 5): harness-attested cost exists only at run
      // exit, long after the primary report settled the lease at verification — so the settled
      // completion posts a second report and the daemon records `residency.wake_cost`. The
      // primary may already carry that summary (fast-fail merge). Spend readers prefer the
      // `wake_cost` row, and a turn sum has nothing to reconcile against when it was never
      // written (lane 01M5JEKY6R).
      const actuatedAt = Date.now();
      settled.push(
        actuation.settled.then(async (settledWith) => {
          // ADR 436 clause 1: an occupied wake whose backend settles with nothing still gets a
          // row — host-stamped duration from actuation to settle, priced as "prints no price".
          // Until 2026-09-21 a backend could make a wake vanish from the ledger this way (grok).
          // ADR 436 clause 4: a wake that settled is over. Stamp the capture(s) the run claims
          // ended, so a finished wake's still-warm session file cannot read `local-session-live`
          // and defer the next wake for LOCAL_SESSION_LIVE_MS. Host-local: never reported.
          const { captures, ...cost } = settledWith ?? {};
          for (const claim of captures ?? [])
            if ((deps.endCapture ?? endWakeCapture)(entry.workspace, claim))
              deps.log(`${order.seat}'s wake session marked ended (${claim.harness})`);
          let completion: WakeCompletion | undefined = settledWith ? cost : undefined;
          // ADR 583 §2: the gateway's metered calls are the price source when it saw any; the
          // harness's own artifact is the fallback, named as such. Tokens come from the provider's
          // usage block; dollars only from the host's table (`no_price_row` otherwise).
          if (gateway) {
            // Close first: a hold still open becomes wake_ended and the summary then carries it.
            await gateway.close();
            const g = gateway.summary();
            if (g.calls > 0 || g.approval_wake_ended) {
              completion = gatewayCompletion(g, completion, actuatedAt);
              const cost =
                g.cost_usd !== undefined ? ` $${g.cost_usd.toFixed(4)}` : ' (no price row)';
              const budget = g.budget_exhausted
                ? ` — budget exhausted, ${String(g.refused)} refused`
                : '';
              const approval = g.approval_wake_ended
                ? ` — ${SPEND_APPROVAL_WAKE_ENDED}, ${String(g.approval_refused)} refused`
                : g.approval_refused > 0
                  ? ` — spend approval declined, ${String(g.approval_refused)} refused`
                  : '';
              deps.log(
                `${order.seat}'s wake metered by the gateway: ${String(g.calls)} call(s)${cost}${budget}${approval}`,
              );
            } else if (completion?.cost_usd !== undefined || completion?.usage) {
              completion = { ...completion, price_source: 'harness_artifact' };
            }
          }
          if (!completion && actuation.outcome.occupied) {
            completion = {
              duration_ms: Date.now() - actuatedAt,
              unpriced_reason: 'harness_prints_no_price',
            };
            deps.log(
              `! ${order.seat}'s backend settled without a completion — host-stamped duration only`,
            );
          }
          if (!completion) return;
          if (
            completion.cost_usd === undefined &&
            completion.duration_ms === undefined &&
            completion.yielded !== true
          )
            return;
          await client
            .wakeReport(group.team, {
              lease_id: order.lease_id,
              occupied: actuation.outcome.occupied,
              ...(actuation.outcome.delivery_outcome
                ? { delivery_outcome: actuation.outcome.delivery_outcome }
                : {}),
              ...(actuation.outcome.transcript_bytes !== undefined
                ? { transcript_bytes: actuation.outcome.transcript_bytes }
                : {}),
              ...(actuation.outcome.resume_weight_bytes !== undefined
                ? { resume_weight_bytes: actuation.outcome.resume_weight_bytes }
                : {}),
              ...(actuation.outcome.transcript_age_ms !== undefined
                ? { transcript_age_ms: actuation.outcome.transcript_age_ms }
                : {}),
              ...completion,
            })
            .then(() =>
              deps.log(
                `wake cost recorded for ${order.seat}: ` +
                  `$${completion.cost_usd?.toFixed(4) ?? '—'} (lease ${order.lease_id})`,
              ),
            )
            .catch((err: Error) =>
              deps.log(`! wake-cost report failed for lease ${order.lease_id}: ${err.message}`),
            );
        }),
      );
    };

    // Start every order now: each waits, in lease order, for its workspace's previous order, then a
    // wake slot, then the preparation lock. An order still waiting when a stop lands is in
    // `pending` and is handed back unstarted.
    const workspaceTail = new Map<string, Promise<void>>();
    const tasks = response.orders.map((order) => {
      const key = spawnable.get(order.seat)?.workspace ?? `seat:${order.seat}`;
      const task = (workspaceTail.get(key) ?? Promise.resolve()).then(async () => {
        const releaseSlot = await wakeSlots.acquire();
        const releasePrep = await prepLock.acquire();
        try {
          await actuateOrder(order, releasePrep);
        } finally {
          releasePrep();
          releaseSlot();
        }
      });
      workspaceTail.set(
        key,
        task.catch(() => undefined),
      );
      return task;
    });
    try {
      await settleAll(tasks);
    } finally {
      deps.signal?.removeEventListener('abort', handBack);
    }
  };

  await settleAll([...pollGroups(registry.entries, deps.hostLabel).values()].map(pollGroup));
  return { registered: registry.entries.length, orders, settled };
}

/**
 * ADR 735: how long the triggering act waited for this wake, for the `wake due` line — the act lane's
 * one measurement, read off the host's own log. `''` when the order names no act time (board
 * continuation, an older daemon) or the clock disagrees.
 */
export function waitedClause(actTs: number | undefined, now: number): string {
  if (actTs === undefined || !Number.isFinite(actTs) || now < actTs) return '';
  const s = Math.round((now - actTs) / 1000);
  const text =
    s < 60
      ? `${s}s`
      : s < 3600
        ? `${Math.floor(s / 60)}m${s % 60}s`
        : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `, waited ${text}`;
}
