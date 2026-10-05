import type { Hold } from '@musterd/protocol';
import { describeHoldLine } from '@musterd/protocol/wire';

/**
 * ADR 516: the Team's active holds above the room. Loaded lazily by `/live` and only once a hold is
 * in force — the line formatter lives in `@musterd/protocol/wire`, and keeping that chunk out of the
 * eager graph is what keeps /live inside its initial-JS budget on the (usual) day nothing is paused.
 */
export function HoldsBanner({ holds, now = Date.now() }: { holds: Hold[]; now?: number }) {
  const live = holds.filter((h) => h.lifted_at === null && h.expires_at > now);
  if (live.length === 0) return null;
  return (
    <div className="lc-holds" role="status">
      {live.map((h) => (
        <div key={h.id}>⏸ {describeHoldLine(h, now)}</div>
      ))}
    </div>
  );
}
