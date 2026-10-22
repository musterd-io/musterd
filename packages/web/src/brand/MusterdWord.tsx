import {
  CHIP_BG,
  CHIP_DOTS,
  CHIP_DOT_RADIUS,
  CHIP_FG,
  CHIP_GLYPH_PATH,
  CHIP_RADIUS,
  CHIP_RING,
  CHIP_SMALL_DOT_EXTRA,
  CHIP_SMALL_EXTRA,
  CHIP_STROKE,
  CHIP_VIEWBOX,
} from './chipMark';
import {
  WORDMARK_ASPECT,
  WORDMARK_BOX,
  WORDMARK_INK,
  WORDMARK_PATH,
  WORDMARK_PLATE,
  WORDMARK_RIM,
  WORDMARK_SEATS,
  WORDMARK_SEAT_RADIUS,
  WORDMARK_SPARK,
  WORDMARK_SPARKS,
  WORDMARK_SPARK_RADIUS,
  WORDMARK_STROKE,
} from './wordmarkMark';

type MusterdChipProps = {
  size?: number;
  className?: string;
};

/** Brand mark — a split m with a seat at each stem foot, in a white ring on a flat sand tile (ADR 702). Always the small cut: in-product renders are 13–18px, where the cuts between the stems would fill in, so the stroke and seats are thickened by a fixed amount. */
export function MusterdChip({ size = 16, className }: MusterdChipProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${CHIP_VIEWBOX} ${CHIP_VIEWBOX}`}
      width={size}
      height={size}
      className={className}
      aria-hidden
      role="img"
    >
      <rect width={CHIP_VIEWBOX} height={CHIP_VIEWBOX} rx={CHIP_RADIUS} fill={CHIP_BG} />
      <rect x="10" y="10" width="1004" height="1004" rx="302" fill="none" stroke="#785A0A" strokeOpacity=".4" strokeWidth="20" />
      <rect
        x={CHIP_RING.x}
        y={CHIP_RING.x}
        width={CHIP_RING.size}
        height={CHIP_RING.size}
        rx={CHIP_RING.radius}
        fill="none"
        stroke="#fff"
        strokeWidth={CHIP_RING.stroke}
      />
      <path
        d={CHIP_GLYPH_PATH}
        fill="none"
        stroke={CHIP_FG}
        strokeWidth={CHIP_STROKE + CHIP_SMALL_EXTRA}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {CHIP_DOTS.map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r={CHIP_DOT_RADIUS + CHIP_SMALL_DOT_EXTRA} fill={CHIP_FG} />
      ))}
    </svg>
  );
}

type MusterdWordmarkProps = {
  /** Height of the plate in px; the width follows from the nameplate's aspect. */
  height?: number;
  className?: string;
};

/**
 * The wordmark: the word drawn on a sand nameplate with a mustard edge (ADR 704). Every letter is
 * drawn, so it needs no font and reads the same on every ground: the plate is its own ground.
 * Not meant to be smaller than about 24px tall.
 */
export function MusterdWordmark({ height = 28, className }: MusterdWordmarkProps) {
  const { x, y, w, h } = WORDMARK_BOX;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${x} ${y} ${w} ${h}`}
      width={Math.round(height * WORDMARK_ASPECT)}
      height={height}
      className={className}
      role="img"
      aria-label="musterd"
    >
      <rect x={x} y={y} width={w} height={h} rx={160} fill={WORDMARK_PLATE} />
      <rect
        x={x + 11}
        y={y + 11}
        width={w - 22}
        height={h - 22}
        rx={149}
        fill="none"
        stroke={WORDMARK_RIM}
        strokeWidth={22}
      />
      <rect
        x={x + 46}
        y={y + 46}
        width={w - 92}
        height={h - 92}
        rx={116}
        fill="none"
        stroke="#fff"
        strokeWidth={30}
      />
      <path
        d={WORDMARK_PATH}
        fill="none"
        stroke={WORDMARK_INK}
        strokeWidth={WORDMARK_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {WORDMARK_SEATS.map(([cx, cy]) => (
        <circle key={cx} cx={cx} cy={cy} r={WORDMARK_SEAT_RADIUS} fill={WORDMARK_INK} />
      ))}
      {WORDMARK_SPARKS.map(([cx, cy]) => (
        <circle key={cx} cx={cx} cy={cy} r={WORDMARK_SPARK_RADIUS} fill={WORDMARK_SPARK} />
      ))}
    </svg>
  );
}

type MusterdWordProps = {
  className?: string;
  /** Sizes the plate: its height is 1.75 times this, so the old chip sizes still read the same. */
  chipSize?: number;
  /**
   * Render the lockup as the ADDRESS, `musterd.io`, rather than the bare product name.
   *
   * Opt-in, and it stays that way. On the site's own nav and footer the domain is where the reader
   * already is, so appending it is noise. The office mark is the opposite case: it is stamped on
   * every frame that leaves this app (a clip, a screenshot, the Twitch stream) for a viewer who
   * has no address bar to read, and for whom the mark is the only way back. Same lockup, one extra
   * fact, exactly where that fact is not already on screen.
   *
   * The suffix is its own span so it can be held a step quieter than the name: the brand is the
   * wordmark, the domain is how you reach it, and a `.io` at equal weight makes the lockup read as
   * a URL instead of a mark wearing one.
   */
  domain?: boolean;
};

/** Topbar lockup: the nameplate wordmark, optionally carrying the address after it. */
export function MusterdWord({
  className = 'lc__word',
  chipSize = 16,
  domain = false,
}: MusterdWordProps) {
  return (
    <span className={className}>
      <MusterdWordmark height={Math.round(chipSize * 1.75)} className="brand__chip" />
      {domain ? <span className="brand__tld">.io</span> : null}
    </span>
  );
}
