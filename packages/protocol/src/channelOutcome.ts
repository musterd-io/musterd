/**
 * What became of the last ask on a human's away channel, in the one sentence both `musterd notify
 * channels` and the /live Away channels block print (lane 01M64DSKT3). The daemon records the
 * outcome as `channel.ask_outcome`; this only words it.
 */

export type AskSkipReason =
  | 'delivery_off'
  | 'below_tier_floor'
  | 'present'
  | 'no_binding'
  | 'relay_not_connected';

export interface LastAskOutcome {
  at: number;
  ask: string;
  outcome: 'sent' | 'skipped' | 'failed';
  reason: AskSkipReason | null;
}

const WHY: Record<AskSkipReason, string> = {
  delivery_off: 'delivery is off',
  below_tier_floor: 'it was below your tier floor',
  present: "you were at your desk (Only while I'm away)",
  no_binding: 'no phone is paired',
  relay_not_connected: 'the relay was not connected',
};

function ago(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** "last ask 2m ago: not sent — you were at your desk (Only while I'm away)", or null. */
export function lastAskLine(last: LastAskOutcome | null | undefined, now: number): string | null {
  if (!last) return null;
  const when = `last ask ${ago(now - last.at)}`;
  if (last.outcome === 'sent') return `${when}: sent`;
  return `${when}: not sent — ${WHY[last.reason ?? 'relay_not_connected']}`;
}
