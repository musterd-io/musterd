import type { HubLink } from '@musterd/protocol';
import type { Ctx } from '../context.js';
import { diagnoseHubFailure, type RunTailscale } from './hubDiagnosis.js';

/**
 * ADR 738: this joiner's link to its hub, as its own pull ticks found it. The pull already asks the
 * hub every minute (`SYNC_PULL_INTERVAL_MS`), so this records what those asks said and adds no probe.
 * A failure carries the ADR 598 diagnosis (errno class, and Tailscale's state for a tailnet hub).
 *
 * In memory, keyed per daemon config like the hub stop (two daemons in one process must not share
 * it): a restart relearns the link on its first pull.
 */
const linksByConfig = new WeakMap<Ctx['config'], Map<string, HubLink>>();

function hostOf(hubUrl: string): string {
  try {
    return new URL(hubUrl).host;
  } catch {
    return 'the hub';
  }
}

function teamsOf(config: Ctx['config']): Map<string, HubLink> {
  let teams = linksByConfig.get(config);
  if (!teams) linksByConfig.set(config, (teams = new Map()));
  return teams;
}

/** A pull the hub answered: the link is up. */
export function noteHubLinkOk(ctx: Ctx, teamId: string, hubUrl: string, now = Date.now()): void {
  teamsOf(ctx.config).set(teamId, {
    hub: hostOf(hubUrl),
    last_ok_at: now,
    failing_since: null,
    failure: null,
  });
}

/**
 * A pull that could not reach the hub. Keeps the last good sync and the start of this run of
 * failures; the cause is the latest one. Never throws.
 */
export async function noteHubLinkFailure(
  ctx: Ctx,
  teamId: string,
  hubUrl: string,
  err: unknown,
  now = Date.now(),
  run?: RunTailscale,
): Promise<void> {
  const teams = teamsOf(ctx.config);
  const prev = teams.get(teamId);
  let failure: HubLink['failure'] = { kind: 'other', code: null, tailscale: null };
  try {
    const d = (await diagnoseHubFailure(hubUrl, err, run)).diagnosis;
    if (d) failure = { kind: d.kind, code: d.code, tailscale: d.tailscale };
  } catch {
    // The diagnosis is a courtesy; the failure is recorded without it.
  }
  teams.set(teamId, {
    hub: hostOf(hubUrl),
    last_ok_at: prev?.last_ok_at ?? null,
    failing_since: prev?.failing_since ?? now,
    failure,
  });
}

/** The link for the team, or null on the hub itself and on a machine that has no hub. */
export function readHubLink(config: Ctx['config'], teamId: string): HubLink | null {
  return linksByConfig.get(config)?.get(teamId) ?? null;
}
