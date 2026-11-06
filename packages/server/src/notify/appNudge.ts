import type { Envelope, RelayAppNudgeFrame } from '@musterd/protocol';
import { APP_CHANNEL } from '@musterd/protocol/app-channel';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import { appBindingEnded, appBindingKeys } from '../store/appPairing.js';
import { appendAudit } from '../store/audit.js';
import { listBindings } from '../store/channelBindings.js';
import { listMembers } from '../store/members.js';
import { relayLinkFor } from './relay.js';

/**
 * The live nudge (ADR 819 decisions 2–4): when a lane lands or a goal finishes, each paired phone
 * gets a content-free silent push that makes a foreground Now pull its roster at once. Nothing
 * about the moment rides it; the roster pull carries everything, through the usual read scope.
 */

/** Per binding, pushes inside this window after one that was sent are coalesced into it. */
export const APP_NUDGE_COALESCE_MS = 5_000;

/** A lane reaching `done` (by a resolve, or an acceptor's accept, ADR 202) or a goal outcome. */
export function isNudgeMoment(
  env: Envelope,
  laneVerdict?: { lane: string; state: string } | undefined,
): boolean {
  if (laneVerdict?.state === 'done') return true;
  const meta = (env.meta ?? {}) as Record<string, unknown>;
  const resolve = meta['lane_resolve'] as { state?: unknown } | undefined;
  if (resolve?.state === 'done') return true;
  return meta['goal_outcome'] !== undefined && meta['goal_outcome'] !== null;
}

/** The throttle, pure: the first call in a binding's window sends, later ones inside it do not. */
export class NudgeGate {
  private readonly last = new Map<string, number>();
  constructor(private readonly coalesceMs: number) {}

  shouldSend(bindingId: string, now: number): boolean {
    const prev = this.last.get(bindingId);
    if (prev !== undefined && now - prev < this.coalesceMs) return false;
    this.last.set(bindingId, now);
    if (this.last.size > 1_024) {
      for (const [k, t] of this.last) if (now - t >= this.coalesceMs) this.last.delete(k);
    }
    return true;
  }
}

const gates = new WeakMap<Ctx['config'], NudgeGate>();
function gateFor(ctx: Ctx): NudgeGate {
  let gate = gates.get(ctx.config);
  if (!gate) {
    gate = new NudgeGate(APP_NUDGE_COALESCE_MS);
    gates.set(ctx.config, gate);
  }
  return gate;
}

/**
 * Nudge every person's active app binding on the team. Detached by the caller; never throws.
 * Returns how many bindings a push was queued for.
 */
export async function nudgeAppsOnMoment(
  ctx: Ctx,
  team: { id: string; slug: string },
  env: Envelope,
  laneVerdict?: { lane: string; state: string },
  now: number = Date.now(),
): Promise<number> {
  try {
    if (!isNudgeMoment(env, laneVerdict)) return 0;
    const link = relayLinkFor(ctx, team.slug);
    if (!link) return 0;
    const gate = gateFor(ctx);
    let sent = 0;
    for (const person of (await listMembers(ctx.db, team.id)).filter((m) => m.kind === 'human')) {
      const binding = (await listBindings(ctx.db, team.id, person.id)).find(
        (b) => b.channel === APP_CHANNEL && b.status === 'active',
      );
      if (!binding) continue;
      if ((await appBindingEnded(ctx.db, team.id, binding.id)) === 'superseded') continue;
      const keys = await appBindingKeys(ctx.db, team.id, binding.id);
      if (!keys?.push_token) continue;
      const send = gate.shouldSend(`${team.id}:${binding.id}`, now);
      if (send) {
        const frame: RelayAppNudgeFrame = {
          protocol: 1,
          type: 'app_nudge',
          binding: binding.id,
          push: {
            token: keys.push_token,
            environment: keys.push_environment ?? keys.environment,
          },
          dedupe_id: `nudge:${binding.id}:${now}`,
        };
        if (link.send(frame)) sent += 1;
      }
      await appendAudit(ctx.db, team.id, {
        actor: null,
        action: 'app.nudge',
        target: person.name,
        result: 'allow',
        detail: { binding_id: binding.id, coalesced: !send },
      });
    }
    return sent;
  } catch (err) {
    log.warn({ msg: 'app_nudge_failed', team: team.slug, act: env.id, err: String(err) });
    return 0;
  }
}
