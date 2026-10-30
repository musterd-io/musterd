import { execFileSync } from 'node:child_process';
import {
  resolveAttestedModel,
  WAKE_TURN_TRANSCRIPT_MAX_BYTES,
  type AttestationSource,
  type Binding,
  type ResidencySteeredBody,
  type WakeTranscriptQuery,
  type WakeTranscriptResponse,
  type WakeTurnBody,
} from '@musterd/protocol';
import { resolveWorkspaceKey } from '@musterd/protocol/project';
import { HttpClient } from '../../client.js';
import { findBinding } from '../../config.js';
import { keychainLookup, seatKeyService } from '../../keychain.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type {
  ActuatorBackend,
  BackendContext,
  WakeActuation,
  WakeCompletion,
  WakeSpec,
} from '../backend.js';
import type { AgentLoopEngine, EngineTool, EngineTurn, SteerRead } from '../engine.js';
import { piEngine } from '../engines/pi.js';
import {
  bashPathOk,
  declaredScripts,
  preflightWorkingTool,
  workingTools,
} from '../engines/workingTools.js';
import { expectedProvenance } from '../pinnedBin.js';
import { holdWakeLease, peekYieldFile, type WakeLeaseDeps } from '../wakeLeaseFile.js';
import { openWakeWatchSpool, type WakeWatchSpool } from '../wakeWatchSpool.js';
import { nativeMcpConfig, openNativeBridge, type NativeBridge } from './nativeBridge.js';

/**
 * Backend #3: the native row (ADR 251 — ADR 131 §7's closing reference implementation). `wake()`
 * spawns no child process: it starts an agent loop inside the host process, driven through the
 * {@link AgentLoopEngine} seam, with the seat's own MCP surface bridged in-memory as its tool set.
 *
 * The invariants the CLI rows carry hold with no process at all:
 * - the prompt is the daemon-composed line, verbatim — no message bodies enter the loop;
 * - occupancy is earned, never granted (ADR 251 §5): the wake prompt tells the agent to check its
 *   inbox, the first real tool call autojoins (ADR 108), and `verifyOccupied` polls the roster
 *   with the ADR 241 lease binding — loop internals are NEVER a verification source (ADR 131 §1);
 * - the watchdog timeout is mandatory: it aborts the loop, and the host awaits `settled`, so the
 *   loop can never be orphaned;
 * - `outcome` resolves at verification, inside the lease TTL; `settled` resolves when the runner
 *   finishes or the watchdog kills it, carrying `duration_ms` and a `cost_usd` COMPUTED from the
 *   engine's per-turn usage (§6) — the first backend whose spend is measured by the harness rather
 *   than self-reported by a child.
 *
 * Two substrate rails ride every run (§7): each turn posts a `wake-turn` row (usage + transcript)
 * through the daemon — best-effort, a dead rail never aborts the loop. Since ADR 588 (amended)
 * those rows are also the resume substrate: before the loop starts, the seat's earlier captured
 * turns are read back and replayed into the engine's context, so a wake continues the seat's
 * record on whichever model this wake runs. The session axis stays `fresh` — no harness session
 * is resumed; the daemon's rows are.
 */

/** The resident seat's standing instruction (ADR 588 §1–§2): who it is and where it may work. The
 *  wake line that follows is the daemon's and carries the ask; this never does. */
export function residentSystemPrompt(seat: string, workspace: string, working: boolean): string {
  return [
    `You are ${seat}, a resident musterd seat: an always-on agent on this team, run by musterd itself (ADR 588).`,
    `Your musterd tools (team_*, lane_*) are your coordination surface — check your inbox first and report with status_update.`,
    working
      ? `Your working tools (read, write, edit, bash) act only inside your workspace at ${workspace}; anything outside it, any install, force-push or push to main is denied and the denial is recorded.`
      : `This wake is coordination-only: answer through your musterd tools; no working tools are available.`,
    `Keep messages short; use the acts, do not narrate.`,
  ].join('\n');
}

/** Beat before the post-run final roster read — presence lands async after the last tool call. */
const FINAL_READ_DELAY_MS = 2_000;

/** How often the loop looks for a yield marker (ADR 546) — the in-process stand-in for the deny a
 *  hooked harness gets at its next tool call, and for the launcher's 10 s hard stop. */
const YIELD_POLL_MS = 500;

/** ADR 101 env > binding, resolved by the backend so the engine can stay providerly dumb about
 *  ladders. Never defaults: an undeclared model defers the wake rather than guessing. */
export function resolveNativeModel(
  env: Record<string, string | undefined>,
  binding: Binding | null,
): { model: string | undefined; source: AttestationSource } {
  const fromEnv = resolveAttestedModel(env);
  if (fromEnv !== undefined) return { model: fromEnv, source: 'environment' };
  if (binding?.model !== undefined) return { model: binding.model, source: 'binding' };
  return { model: undefined, source: 'unknown' };
}

/** Cap a turn's transcript at the protocol bound; an oversized one becomes an honest marker
 *  rather than a rejected post (the capture row still prices the turn). */
export function boundTranscript(transcript: unknown): unknown {
  const bytes = JSON.stringify(transcript)?.length ?? 0;
  return bytes <= WAKE_TURN_TRANSCRIPT_MAX_BYTES ? transcript : { truncated: true, bytes };
}

/** The telemetry slice the backend posts through — injectable so tests never open a socket. */
export interface TurnTelemetry {
  wakeTurn(team: string, body: WakeTurnBody): Promise<{ ok: boolean; turn: number }>;
  /** ADR 588 amendment: the resume substrate read — the seat's earlier captured turns. */
  wakeTranscript(team: string, body: WakeTranscriptQuery): Promise<WakeTranscriptResponse>;
  /** ADR 588 §6: the in-process doorbell's receipt, one per raised act steered into the loop. */
  residencySteered(team: string, body: ResidencySteeredBody): Promise<{ ok: boolean }>;
}

/** Injectables so the scripted suite drives every path without a model, daemon, or socket. */
export interface NativeDeps {
  engine?: AgentLoopEngine;
  openBridge?: typeof openNativeBridge;
  readBinding?: (workspace: string) => Binding | null;
  readSession?: (workspace: string) => LocalSessionLiveness;
  telemetry?: (server: string, agentKey: string) => TurnTelemetry;
  env?: Record<string, string | undefined>;
  /** The Keychain read behind an unset key variable (ADR 605; tests never touch the Keychain). */
  keychain?: (service: string) => Promise<string | null>;
  finalReadDelayMs?: number;
  /** Lease-file seams (ADR 546; tests never touch disk). */
  lease?: WakeLeaseDeps;
  /** The watch spool (ADR 546; tests). */
  openSpool?: (workspace: string, leaseId: string) => WakeWatchSpool;
  /** True while a yield marker names this lease (ADR 546; tests). */
  yieldRequested?: (workspace: string, leaseId: string) => boolean;
  yieldPollMs?: number;
}

const defaultTelemetry = (server: string, agentKey: string): TurnTelemetry =>
  new HttpClient({ server, key: agentKey }).presenceNeutral();

const deferred = (reason: string): WakeActuation => ({
  outcome: { occupied: false, deferred: true, reason: reason.slice(0, 200) },
  settled: Promise.resolve(undefined),
});

export function nativeBackend(deps: NativeDeps = {}): ActuatorBackend {
  return {
    harness: 'musterd',

    async wake(spec: WakeSpec, ctx: BackendContext): Promise<WakeActuation> {
      const seat = spec.order.seat;
      const env = deps.env ?? process.env;

      // Machine-property gates first (ADR 221 posture: none of these burns attempt budget).
      const binding = (deps.readBinding ?? ((ws: string) => findBinding(ws, {})))(spec.workspace);
      if (!binding?.agent_key) {
        return deferred(`workspace ${spec.workspace} has no binding/agent key for the native loop`);
      }
      const { model, source: modelSource } = resolveNativeModel(env, binding);
      if (model === undefined) {
        return deferred(
          'no model declared for the native loop (ADR 101: set MUSTERD_MODEL or binding.model) — never defaulted',
        );
      }
      // ADR 588 §1: the operator's key, read from the NAMED variable at spawn. Only the name is
      // ever written anywhere (registry, this log line); the value goes to pi and the gateway.
      // ADR 605: an unset variable falls back to the Keychain item `musterd:<VAR>`, so the key
      // need not sit in launchd's user-wide environment where every other tool can pick it up.
      let apiKey = spec.key_env !== undefined ? env[spec.key_env] : undefined;
      if (spec.key_env !== undefined && !apiKey) {
        apiKey =
          (await (deps.keychain ?? keychainLookup)(seatKeyService(spec.key_env))) ?? undefined;
      }
      if (spec.key_env !== undefined && !apiKey) {
        return deferred(
          `API key variable ${spec.key_env} is unset on this host and no Keychain item ` +
            `${seatKeyService(spec.key_env)} — the resident seat cannot run (ADR 588/605)`,
        );
      }
      // The local-session guard, re-checked defensively like every backend: an in-process loop
      // occupying the seat would displace a live session working in this worktree (ADR 068).
      const liveness = (deps.readSession ?? localSessionLiveness)(spec.workspace);
      if (liveness.state === 'live' || liveness.slotState === 'live') {
        return deferred('local-session-live');
      }

      // The seat's own tool surface, in-process (ADR 251 §4). A bridge that cannot stand up is a
      // real failure — the enrollment said this workspace hosts a native seat and it does not.
      let bridge: NativeBridge;
      const config = nativeMcpConfig({
        binding,
        server: spec.server,
        team: spec.team,
        seat,
        workspace: spec.workspace,
        workspaceKey: resolveWorkspaceKey(process.env, spec.workspace),
        leaseId: spec.order.lease_id,
        model,
        modelSource,
      });
      try {
        bridge = await (deps.openBridge ?? openNativeBridge)(config);
      } catch (err) {
        return {
          outcome: {
            occupied: false,
            reason: `failed to open the MCP bridge: ${(err as Error).message}`.slice(0, 200),
          },
          settled: Promise.resolve(undefined),
        };
      }

      // ADR 395: the residency wake routes authenticate the HOST, so the capture rail and the
      // transcript read ride the host-scoped credential `residency on` minted — the same key the
      // loop polls with. `agent_key` is the seat's claim credential and those routes refuse it
      // (measured on the first resident wake, 2026-10-13: every wake-turn post 401, no rows, no
      // cost, no rehydration). Fallback for a binding enrolled before ADR 395.
      const telemetry = (deps.telemetry ?? defaultTelemetry)(
        spec.server,
        binding.host_key ?? binding.agent_key,
      );
      const startedAt = Date.now();
      const controller = new AbortController();
      // ADR 546: findable by `musterd <seat>` like every other wake — but the loop runs in THIS
      // process, so the lease names the host's pid, says so (`in_process`), and is never signalled.
      const lease = holdWakeLease(
        spec.workspace,
        {
          lease_id: spec.order.lease_id,
          harness: 'musterd',
          pid: process.pid,
          startedAt,
          timeoutMs: spec.bounds.timeout_ms,
          in_process: true,
          provenance: spec.order.derivation === 'dream' ? 'dream' : 'wake',
        },
        deps.lease,
      );
      const spool = (deps.openSpool ?? openWakeWatchSpool)(spec.workspace, spec.order.lease_id);
      // A person asked the wake to stop (ADR 546). Stop at a tool boundary, as hooked harnesses do:
      // abort at once when no tool is running, else when the running one returns.
      let toolsRunning = 0;
      let yielding = false;
      const stopIfIdle = (): void => {
        if (yielding && toolsRunning === 0) controller.abort();
      };
      const tools = bridge.tools.map((t) => ({
        ...t,
        run: async (input: unknown): Promise<string> => {
          toolsRunning += 1;
          try {
            return await t.run(input);
          } finally {
            toolsRunning -= 1;
            stopIfIdle();
          }
        },
      }));
      const yieldPoll = setInterval(() => {
        if (yielding) return;
        if ((deps.yieldRequested ?? peekYieldFile)(spec.workspace, spec.order.lease_id)) {
          yielding = true;
          stopIfIdle();
        }
      }, deps.yieldPollMs ?? YIELD_POLL_MS);
      yieldPoll.unref();
      let timedOut = false;
      // The mandatory watchdog (ADR 131 §6): aborts the in-process loop instead of killing a tree.
      const watchdog = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, spec.bounds.timeout_ms);
      watchdog.unref();

      let telemetryFailed = false;
      const postTurn = (turn: EngineTurn): void => {
        spool.turn((turn.transcript as { assistant?: unknown } | null)?.assistant, Date.now());
        // Fire-and-forget: the capture rail is best-effort by design; one narrator line on the
        // first failure, never per turn.
        void telemetry
          .wakeTurn(spec.team, {
            lease_id: spec.order.lease_id,
            turn: turn.index,
            usage: turn.usage,
            ...(turn.cost_usd !== undefined ? { cost_usd: turn.cost_usd } : {}),
            ...(turn.stop_reason !== null ? { stop_reason: turn.stop_reason } : {}),
            transcript: boundTranscript(turn.transcript),
          })
          .catch((err: Error) => {
            if (!telemetryFailed) ctx.log(`! wake-turn post failed for ${seat}: ${err.message}`);
            telemetryFailed = true;
          });
      };

      // ADR 588 §3–§4: a work order (`seat-policy`) gets the four jailed working tools beside the
      // seat's own surface; a reply wake stays coordination-only. The jail reads the repo's
      // declared scripts once per wake — what `pnpm <x>` may run is what package.json says.
      const working = spec.order.tool_policy === 'seat-policy';
      const jail = {
        workspace: spec.workspace,
        policy: {
          scripts: declaredScripts(spec.workspace),
          pathOk: bashPathOk(spec.workspace),
          // ADR 675 (review): the jail's `git push` may name only this branch — the checkout's
          // own, or the provisioned `agent/<seat>` when the checkout is detached or unreadable
          // (round 3: never unbound).
          branch: currentBranch(spec.workspace) ?? `agent/${spec.order.seat}`,
          // Round 4: the live checkout, read when a bare or HEAD push is judged.
          currentBranch: () => currentBranch(spec.workspace),
        },
      };
      const runTools: EngineTool[] = working
        ? [
            ...tools,
            ...workingTools({
              ...jail,
              env,
              ...(spec.gateway?.env ? { gatewayEnv: spec.gateway.env } : {}),
              secretEnvNames: spec.key_env !== undefined ? [spec.key_env] : [],
            }),
          ]
        : tools;

      // ADR 588 amendment: the next wake is rehydrated from the daemon's rows — the seat's earlier
      // captured turns, bounded server-side. A failed read is a fresh start, said once, never a
      // failed wake.
      let history: WakeTranscriptResponse['leases'] = [];
      try {
        const transcript = await telemetry.wakeTranscript(spec.team, {
          lease_id: spec.order.lease_id,
        });
        history = transcript.leases;
        if (history.length > 0 || transcript.omitted_leases > 0) {
          ctx.log(
            `native rehydrate for ${seat}: ${String(history.length)} earlier wake(s), ` +
              `${String(history.reduce((n, l) => n + l.turns.length, 0))} turn(s)` +
              (transcript.omitted_leases > 0
                ? `, ${String(transcript.omitted_leases)} older omitted (budget)`
                : ''),
          );
        }
      } catch (err) {
        ctx.log(
          `! wake-transcript read failed for ${seat}: ${(err as Error).message} — fresh context`,
        );
      }

      const engine =
        deps.engine ??
        piEngine({
          apiKey,
          gatewayEnv: spec.gateway?.env,
          history,
          systemPrompt: residentSystemPrompt(seat, spec.workspace, working),
          preflight: working ? (name, args) => preflightWorkingTool(jail, name, args) : undefined,
          onRehydrate: (t) => {
            if (t.skipped > 0 || t.patched > 0)
              ctx.log(
                `native rehydrate for ${seat}: replayed ${String(t.replayed)}, skipped ${String(t.skipped)} non-pi row(s), patched ${String(t.patched)} missing result(s)`,
              );
          },
        });
      // ADR 588 §6: the in-process doorbell. A raised act reaches the loop as its next user turn
      // through the bridge's socket, not only on a tool result; each delivery is a
      // `residency.steered` row (best-effort, one narrator line on the first failure). ADR 627: the
      // delivery carries the host's read of the act, so the seat answers without fetching it.
      let steeredPostFailed = false;
      const steer = {
        subscribe: (deliver: (line: string, read?: SteerRead) => void) =>
          bridge.onRaised((line, actId, read) => {
            deliver(line, read);
            ctx.log(
              `⚡ steered ${seat}: act ${actId} delivered into the running loop` +
                (read ? ' with the host read' : ''),
            );
            void telemetry
              .residencySteered(spec.team, {
                lease_id: spec.order.lease_id,
                act_id: actId,
                delivered_at: Date.now(),
              })
              .catch((err: Error) => {
                if (!steeredPostFailed)
                  ctx.log(`! steered post failed for ${seat}: ${err.message}`);
                steeredPostFailed = true;
              });
          }),
      };
      const runPromise = engine.run({
        model,
        prompt: spec.order.composed_recap_line ?? spec.order.composed_line,
        tools: runTools,
        maxTurns: spec.bounds.max_turns,
        signal: controller.signal,
        onTurn: postTurn,
        steer,
      });

      // `settled` resolves when the runner finishes or the watchdog aborts it — the host awaits
      // this, so the loop (and the bridge's presence) can never be orphaned.
      const settled: Promise<WakeCompletion | undefined> = runPromise.then(async (result) => {
        clearTimeout(watchdog);
        clearInterval(yieldPoll);
        await bridge.close();
        const yielded = lease.settle();
        spool.end(result.end === 'completed');
        const cost = result.cost_usd !== undefined ? ` cost=$${result.cost_usd.toFixed(4)}` : '';
        ctx.log(
          `native loop for ${seat} settled: end=${result.end} turns=${String(result.turns)}` +
            `${cost} wall=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        );
        return {
          ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
          duration_ms: Date.now() - startedAt,
          ...(yielded ? { yielded: true } : {}),
        };
      });

      // Verify from the roster, never from the loop. The second race arm handles a run that ended
      // before the windowed poller concluded (auth failure, instant error): give presence a beat,
      // then take one final read.
      const finalReadDelay = deps.finalReadDelayMs ?? FINAL_READ_DELAY_MS;
      const verified = await Promise.race([
        ctx.verifyOccupied(seat, undefined, startedAt),
        runPromise
          .then(() => new Promise((r) => setTimeout(r, finalReadDelay)))
          .then(() => ctx.verifyOccupied(seat, undefined, startedAt)),
      ]);

      // ADR 379: the in-process bridge always attests its lease, so `own_unattested` should never
      // fire here; honoured anyway so the five backends read the contract the same way.
      if (verified.occupied && (verified.lease_matched || verified.own_unattested)) {
        const wakeLatencyMs = Date.now() - startedAt;
        ctx.log(
          `⚡ woke ${seat}: invoke→roster ${(wakeLatencyMs / 1000).toFixed(1)}s, ` +
            `session=fresh provenance=${verified.provenance ?? 'unknown'} (native)`,
        );
        if (verified.provenance !== expectedProvenance(spec.order)) {
          ctx.log(
            `note: occupancy attests provenance "${verified.provenance ?? 'none'}", not ` +
              `"${expectedProvenance(spec.order)}" — ` +
              `unexpected for an in-process bridge (config drift?)`,
          );
        }
        // Outcome at verification; the loop runs on to actually answer, priced at settle.
        return { outcome: { occupied: true, session: 'fresh' }, settled };
      }

      if (verified.occupied && !verified.lease_matched && !verified.own_unattested) {
        // ADR 238/241: the seat is held by a session this wake did not create — defer, never
        // charge, and stop paying for a loop whose seat someone else owns.
        controller.abort();
        await runPromise;
        return {
          outcome: {
            occupied: false,
            deferred: true,
            session: 'fresh',
            reason: `the seat is held by another session (not lease ${spec.order.lease_id})`.slice(
              0,
              200,
            ),
          },
          settled,
        };
      }

      // No occupancy: the loop either already failed, or is still running without ever having
      // joined — either way it must not keep burning.
      controller.abort();
      const result = await runPromise;
      const completion = await settled;
      if (result.end === 'auth') {
        // Missing/invalid credentials are a property of this machine, not of the work — the same
        // budget-neutral posture as a missing CLI binary (ADR 221).
        return {
          outcome: {
            occupied: false,
            deferred: true,
            reason:
              `native engine credentials unavailable: ${result.reason ?? 'auth failed'}`.slice(
                0,
                200,
              ),
          },
          settled,
        };
      }
      const reason = timedOut
        ? `watchdog timeout (${String(spec.bounds.timeout_ms)}ms) before roster occupancy`
        : result.end === 'aborted'
          ? 'no roster occupancy within the verify window — native loop aborted'
          : `native loop ended (${result.end}${result.reason ? `: ${result.reason}` : ''}) without occupying the seat`;
      return {
        outcome: {
          occupied: false,
          session: 'fresh',
          reason: reason.slice(0, 200),
          // Fast-fail merge (increment 5 pattern): the run has settled — carry its summary on the
          // primary report so no supplement is needed.
          ...(completion?.cost_usd !== undefined ? { cost_usd: completion.cost_usd } : {}),
          ...(completion?.duration_ms !== undefined ? { duration_ms: completion.duration_ms } : {}),
        },
        settled,
      };
    },
  };
}

/** The workspace's checked-out branch, for the jail's push bound (ADR 675 review); undefined when
 *  detached or not a git checkout — then `git push` is bound to nothing beyond the allowlist. */
function currentBranch(workspace: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', workspace, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
