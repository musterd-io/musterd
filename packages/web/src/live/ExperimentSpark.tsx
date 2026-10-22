import { useId } from 'react';
import {
  SPARK_H,
  SPARK_W,
  sparkline,
  type ExperimentMetric,
  type ExperimentSample,
} from './experimentReads';

/**
 * An experiment's sparkline (ADR 644 §6, ADR 701), in its own lazy chunk so /live's first paint does
 * not carry it (lane 01M5GE8AX4; `Experiments.tsx` shows the number while it loads). It draws from the
 * first point: one sample is the number with `· day 1`, a dotted trail fading in from the left and the
 * dot; more draw the line over a soft fill, landing on an end dot. Today's live point breathes, `now`
 * beside the number.
 */
export default function ExperimentSpark({
  metric,
  samples,
  read,
}: {
  metric: ExperimentMetric;
  samples: readonly ExperimentSample[];
  read: boolean;
}) {
  const spark = sparkline(metric, samples);
  const metricName = metric.name;
  // Gradient ids are document-wide, and a column shows several charts at once.
  const gid = useId().replace(/:/g, '');
  if (!spark) return null;
  const live = spark.now !== null;
  return (
    <span className={`lc-xp__spark${read ? ' is-read' : ''}`} title={metricName}>
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} aria-hidden="true">
        <defs>
          <linearGradient id={`${gid}a`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.26" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
          {/* In the chart's own units: a flat line has a zero-height box, which an objectBoundingBox
              gradient cannot paint at all. */}
          <linearGradient id={`${gid}l`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={SPARK_W} y2="0">
            <stop offset="0" stopColor="currentColor" stopOpacity="0" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <rect className="lc-xp__spark-zone" x="0" y={spark.zone.y} width={SPARK_W} height={spark.zone.h} />
        {spark.baselineY !== null && (
          <line className="lc-xp__spark-base" x1="0" x2={SPARK_W} y1={spark.baselineY} y2={spark.baselineY} />
        )}
        <line className="lc-xp__spark-target" x1="0" x2={SPARK_W} y1={spark.targetY} y2={spark.targetY} />
        {spark.area && <path className="lc-xp__spark-area" d={spark.area} fill={`url(#${gid}a)`} />}
        {spark.path && <path className="lc-xp__spark-line" d={spark.path} />}
        {/* Day one: a dotted trail fades in from the left to the first point — the line starts here. */}
        {spark.firstDay && (
          <line
            className="lc-xp__spark-lead"
            x1="0"
            x2={spark.end.x - 4}
            y1={spark.end.y}
            y2={spark.end.y}
            stroke={`url(#${gid}l)`}
          />
        )}
        {spark.points.slice(0, -1).map((p, i) => (
          <circle key={i} className="lc-xp__spark-pt" cx={p.x} cy={p.y} r="1.3" />
        ))}
        {!live && spark.path && <circle className="lc-xp__spark-halo" cx={spark.end.x} cy={spark.end.y} r="4.5" />}
        {/* ADR 701: today's point, live — it moves as the day's acts land. Otherwise the line's end. */}
        <circle
          className={live ? 'lc-xp__spark-now' : 'lc-xp__spark-dot'}
          cx={spark.end.x}
          cy={spark.end.y}
          r={live ? 2.5 : 2}
        />
      </svg>
      <span
        className={`lc-xp__spark-latest${live ? ' is-live' : ''}`}
        title={
          spark.now
            ? `today so far${spark.now.asOf ? `, as of ${new Date(spark.now.asOf).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`
            : spark.firstDay
              ? 'the first day of this chart: the line starts tomorrow'
              : undefined
        }
      >
        {spark.trend && <i className={`lc-xp__trend lc-xp__trend--${spark.trend}`} aria-hidden="true" />}
        {spark.latest}
        {spark.firstDay && <span className="lc-xp__spark-day"> · day 1</span>}
        {live && <span className="lc-xp__spark-live"> today</span>}
      </span>
    </span>
  );
}
