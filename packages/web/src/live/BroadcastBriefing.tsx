import { useEffect, useState } from 'react';
import type { Briefing, NeedsItem } from './briefing';
import { stillMode } from './stillMode';

/**
 * The stream's briefing (live-briefing spec): the team's one-sentence state in large type at the
 * top of the column, and under it one bucket at a time. A stranger arriving mid-stream reads the
 * sentence and then whichever bucket is up.
 *
 * What it adds to the frame, on purpose: the room's own banner already carries the freshest ask and
 * the cards already say who is on what, so "in progress" is NOT a rotating bucket here — the cards
 * are that list, by person, and repeating it would be the same fact twice. What neither shows is
 * what is **blocked or waiting on a human** (held in place until it clears, never rotated away),
 * what is **in review**, and what **shipped**.
 *
 * A public surface, so two walls against a seat claim: the caller builds the briefing without
 * `requests`, and `publicNeeds` drops the `seat-request` kind even if one arrived. A stream does not
 * announce who is knocking (spec, decision 3).
 */

/** One bucket for this long; long enough to read three rows, short enough to see all of them. */
export const ROTATE_MS = 12_000;
/** A lower-third is read from across a room, and sits in the room's empty corner: two rows is what
 *  fits there without covering the floor (measured at the 1080 stage, 2026-10-09); then how many more. */
export const BROADCAST_ROWS = 2;

export type BroadcastBucket = 'needs' | 'inReview' | 'shipped';

/** The Needs-a-human items a public surface may show — never a seat request. */
export const publicNeeds = (brief: Briefing): NeedsItem[] =>
  brief.needsHuman.filter((n) => n.kind !== 'seat-request');

/**
 * Which bucket is up on tick `tick`. Needs a human holds the frame for as long as anything is in
 * it; otherwise the non-empty buckets take turns. `null` when there is nothing to show but the
 * sentence.
 */
export function pickBucket(brief: Briefing, tick: number): BroadcastBucket | null {
  if (publicNeeds(brief).length > 0) return 'needs';
  const turns: BroadcastBucket[] = [];
  if (brief.inReview.length > 0) turns.push('inReview');
  if (brief.shipped.length > 0) turns.push('shipped');
  return turns.length > 0 ? turns[tick % turns.length]! : null;
}

const HEAD: Record<BroadcastBucket, string> = {
  needs: 'Needs a human',
  inReview: 'In review',
  shipped: 'Shipped today',
};

interface Row {
  id: string;
  title: string;
  owner: string | null;
  kind?: string;
}

function rowsOf(brief: Briefing, bucket: BroadcastBucket): Row[] {
  if (bucket === 'needs') {
    return publicNeeds(brief).map((n) => ({
      id: n.id,
      title: n.title,
      owner: n.owner,
      kind: n.kind,
    }));
  }
  if (bucket === 'inReview') {
    return brief.inReview.map((w) => ({ id: w.id, title: w.title, owner: w.owner }));
  }
  return brief.shipped.map((s) => ({ id: s.id, title: s.title, owner: s.by }));
}

/**
 * The tick that turns the buckets. Stops while the tab is hidden and does not start at all in
 * `?still` measurement mode — the animation rule in packages/web/AGENTS.md: idle cost is paid by
 * every viewer, and a measurement must keep what it is showing.
 */
function useRotation(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (stillMode()) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer === undefined && document.visibilityState === 'visible') {
        timer = setInterval(() => setTick((t) => t + 1), ROTATE_MS);
      }
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return tick;
}

export function BroadcastBriefing({ brief }: { brief: Briefing }) {
  const tick = useRotation();
  return <BriefingView brief={brief} tick={tick} />;
}

/** The markup, separate from the clock so a test can name the tick. */
export function BriefingView({ brief, tick }: { brief: Briefing; tick: number }) {
  const bucket = pickBucket(brief, tick);
  const rows = bucket ? rowsOf(brief, bucket) : [];
  return (
    <section className="bb" aria-label="Team briefing">
      <p className="bb__headline">{brief.headline}</p>
      {bucket && (
        <div key={bucket} className={`bb__bucket bb__bucket--${bucket}`}>
          <h2 className="bb__h">
            {HEAD[bucket]} <b>{rows.length}</b>
          </h2>
          <ul className="bb__list">
            {rows.slice(0, BROADCAST_ROWS).map((r) => (
              <li key={r.id} className="bb__row">
                {r.kind && <span className="bb__kind">{r.kind}</span>}
                <span className="bb__title">{r.title}</span>
                {r.owner && <span className="bb__owner">{r.owner}</span>}
              </li>
            ))}
          </ul>
          {rows.length > BROADCAST_ROWS && (
            <p className="bb__more">+{rows.length - BROADCAST_ROWS} more</p>
          )}
        </div>
      )}
    </section>
  );
}
