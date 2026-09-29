import type { Envelope, MemberSummary } from '@musterd/protocol';
import { useEffect, useState } from 'react';
import { busyness, lastActLabel } from './busyness';

/**
 * The top bar's busyness meter (ADR 464, spec §5): the team's name, a heartbeat that pulses on
 * every act, a sparkline of acts over what the page has loaded, and who is working. It answers
 * the question a room asks first — "is anything happening?" — without a word from the presenter.
 */
export function TopMeter({
  teamName,
  envelopes,
  roster,
  now,
}: {
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
  const { working, between, humans } = b.counts;
  const who = [
    `${working} working`,
    between > 0 ? `${between} between tasks` : null,
    humans > 0 ? `${humans} human${humans === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
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
        <span className="lc-meter__last">{lastActLabel(b.lastActAgeMs)}</span>
      </span>
      <span className="lc-meter__rate" title={`${envelopes.length} acts loaded · ${b.spanLabel}`}>
        <span className="lc-meter__n">{b.rateLabel}</span>
        <svg
          className="lc-meter__spark"
          viewBox={`0 0 ${Math.max(1, b.buckets.length) * 4} 12`}
          aria-hidden="true"
          preserveAspectRatio="none"
        >
          {b.buckets.map((n, i) => {
            const h = Math.max(1, Math.round((n / peak) * 12));
            return <rect key={i} x={i * 4} y={12 - h} width={3} height={h} />;
          })}
        </svg>
        <span className="lc-meter__span">{b.spanLabel}</span>
      </span>
      <span className="lc-meter__who">{who}</span>
    </div>
  );
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
