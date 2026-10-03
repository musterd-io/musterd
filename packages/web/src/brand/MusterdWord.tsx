import {
  CHIP_BG,
  CHIP_FG,
  CHIP_GLYPH_PATH,
  CHIP_RADIUS,
  CHIP_RING_PATH,
  CHIP_SMALL_STROKE,
  CHIP_VIEWBOX,
} from './chipMark';

type MusterdChipProps = {
  size?: number;
  className?: string;
};

/** Brand mark — the hand-drawn m in a white ring on mustard (ADR 497). Always the small cut: in-product renders are 13–18px, where the hairline outlines vanish, so the glyph is thickened instead. */
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
      <path fill="#fff" fillRule="evenodd" d={CHIP_RING_PATH} />
      <path
        fill={CHIP_FG}
        d={CHIP_GLYPH_PATH}
        stroke={CHIP_FG}
        strokeWidth={CHIP_SMALL_STROKE}
        strokeLinejoin="round"
      />
    </svg>
  );
}

type MusterdWordProps = {
  className?: string;
  chipSize?: number;
  /**
   * Render the lockup as the ADDRESS — `musterd.io` — rather than the bare product name.
   *
   * Opt-in, and it stays that way. On the site's own nav and footer the domain is where the reader
   * already is, so appending it is noise. The office mark is the opposite case: it is stamped on
   * every frame that leaves this app — a clip, a screenshot, the Twitch stream — for a viewer who
   * has no address bar to read, and for whom the mark is the only way back. Same lockup, one extra
   * fact, exactly where that fact is not already on screen.
   *
   * The suffix is its own span so it can be held a step quieter than the name: the brand is the
   * word, the domain is how you reach it, and a `.io` at equal weight makes the lockup read as a
   * URL instead of a mark wearing one.
   */
  domain?: boolean;
};

/** Topbar wordmark lockup: mark + lowercase musterd, optionally carrying the address. */
export function MusterdWord({
  className = 'lc__word',
  chipSize = 16,
  domain = false,
}: MusterdWordProps) {
  return (
    <span className={className}>
      <MusterdChip size={chipSize} className="brand__chip" />
      {/* With the domain, the word and its suffix are ONE flex item. The lockup is an inline-flex
          row with a gap between chip and word, and a bare text node beside a span makes two items —
          so `musterd` and `.io` came out reading "musterd .io" with the chip gap between them. The
          plain branch stays a bare text node so nothing that styles the existing lockup changes. */}
      {domain ? (
        <span className="brand__word">
          musterd<span className="brand__tld">.io</span>
        </span>
      ) : (
        'musterd'
      )}
    </span>
  );
}
