import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useEffect, useState } from 'react';
import { busyness, lastActLabel } from './busyness';

/**
 * The top bar's busyness meter (ADR 464, spec §5): the team's name, a heartbeat that pulses on
 * every act (its age on hover), and a sparkline of acts over what the page has loaded. It answers
 * the question a room asks first — "is anything happening?" — without a word from the presenter.
 * Who is working, and on what, is the Now card's (live-briefing spec, increment 4): a tally here
 * was the same counts a second time.
 */
export function TopMeter({
  teamName,
  envelopes,
  roster,
  now,
  loading = false,
  refreshing = false,
}: {
  /** Nothing loaded yet: a placeholder where the rate goes, not "0 acts · nothing loaded". */
  loading?: boolean;
  /** Showing the last snapshot while the daemon answers (liveCache). */
  refreshing?: boolean;
  teamName: string;
  envelopes: readonly Envelope[];
  roster: readonly MemberSummary[];
  /** The clock, for tests; the component ticks its own once a second when unset. */
  now?: number;
}) {
  const tick = useSecond(now === undefined);
  const at = now ?? tick;
  const b = busyness(envelopes, roster, at);
  const last = envelopes.length ? envelopes[envelopes.length - 1]!.id : 'none';
  const peak = Math.max(1, ...b.buckets);
  return (
    <div className="lc-meter" aria-label="Team activity">
      <span className="lc-meter__team">{teamName}</span>
      <span className="lc-meter__beat" title={lastActLabel(b.lastActAgeMs)}>
        {/* Keyed on the newest act so the pulse animation restarts on every envelope. */}
        <i
          key={last}
          className={`lc-meter__dot${b.lastActAgeMs === null ? ' is-quiet' : ''}`}
          aria-hidden="true"
        />
      </span>
      {loading ? (
        <i className="lc-skel" style={{ width: '7em' }} aria-label="Loading" />
      ) : (
      <span className="lc-meter__rate" title={`${envelopes.length} acts loaded · ${b.spanLabel}`}>
        <span className="lc-meter__n">{b.rateLabel}</span>
        <svg
          className="lc-meter__spark"
          viewBox={`0 0 ${Math.max(1, b.buckets.length) * 4} 12`}
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          {/* A hill of the day's acts, not a row of ticks: the filled ground under a soft line,
              so a busy hour reads as a rise and a quiet one as flat ground. */}
          <path className="lc-meter__area" d={sparkPath(b.buckets, peak, true)} />
          <path className="lc-meter__line" d={sparkPath(b.buckets, peak, false)} />
        </svg>
        <span className="lc-meter__span">{refreshing ? 'refreshing…' : b.spanLabel}</span>
      </span>
      )}
    </div>
  );
}

/** The sparkline's path through each bucket's middle, 4 units a bucket, 12 tall (1 is the floor, so
 *  an empty hour still draws ground). `area` closes it down to the baseline for the fill. */
export function sparkPath(buckets: readonly number[], peak: number, area: boolean): string {
  const pts = buckets.map((n, i) => [i * 4 + 2, 11.5 - (n / peak) * 10] as const);
  if (pts.length === 0) return '';
  if (pts.length === 1) pts.unshift([0, pts[0]![1]]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y.toFixed(1)}`).join(' ');
  if (!area) return line;
  return `${line} L${pts[pts.length - 1]![0]} 12 L${pts[0]![0]} 12 Z`;
}

/** A once-a-second clock, paused while the tab is hidden (a background dashboard costs nothing). */
function useSecond(on: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer === undefined && document.visibilityState === 'visible') {
        timer = setInterval(() => setT(Date.now()), 1000);
      }
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVis = () => (document.visibilityState === 'visible' ? start() : stop());
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [on]);
  return t;
}
