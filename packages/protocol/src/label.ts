/**
 * Seat session labels (ADR 160 → ADR 468) — the shared grammar for marking a harness session as
 * belonging to a musterd seat, wherever a title can be written (an app sidebar, a terminal tab).
 *
 * Pure string functions only: this file is exported from the browser-safe barrel, so it must never
 * import node builtins (see build-stamp.ts for the incident that rule comes from).
 */

/**
 * The musterd chip as a title prefix. ADR 154 makes the brand mark a flat rounded mustard block
 * (`#E1AD01`); a warm diamond is the closest a plain-text title can get, and titles are plain text
 * everywhere we write them — app sidebars render no images, and a terminal tab is characters only.
 *
 * Since ADR 468 the chip is the *terminal* and *statusline* mark only: a sidebar row lists seat
 * sessions by name, and the chip in front of every one of them said nothing a reader could use.
 */
export const SEAT_CHIP = '\u{1F536}'; // 🔶 large orange diamond

/** The divider between the fields of a session label (ADR 468): a spaced middle dot. */
export const LABEL_DIVIDER = ' · ';

/** Six days in milliseconds — the boundary between weekday-style and date-style timestamps. */
const WEEKDAY_WINDOW_MS = 6 * 86_400_000;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A session's start moment, compact enough for a sidebar row: `Fri 3p` while the weekday is still
 * unambiguous (within six days of `nowMs`), `Jul 18 3p` beyond that. Minutes are deliberately
 * dropped — the label answers "which of these sessions is which", not "when exactly".
 *
 * Local time by design: the label is read on the machine that wrote it.
 */
export function formatLabelWhen(createdMs: number, nowMs: number): string {
  const d = new Date(createdMs);
  const hour12 = d.getHours() % 12 || 12;
  const clock = `${hour12}${d.getHours() < 12 ? 'a' : 'p'}`;
  if (nowMs - createdMs < WEEKDAY_WINDOW_MS) return `${WEEKDAYS[d.getDay()]} ${clock}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${clock}`;
}

/**
 * The sidebar label (ADR 468): `dolly · Mon 1p · revive · Daemon refresh` — seat, session start,
 * team, then the host's own auto-summarized title carried through verbatim. Lowercase seat, as
 * the CLI's roster and statusline already spell it. Write-once per session: the timestamp is the
 * session's start, fixed at creation, so a labeled title never needs re-dating.
 *
 * The seat labels ONLY its own session with this (ADR 442 / 467): Claude Code Desktop
 * `set_session_title {session_id: "self"}`, Cursor `rename_chat`. Nothing sweeps.
 */
export function renderSessionLabel(
  seat: string,
  createdMs: number,
  team: string,
  subject: string,
  nowMs: number,
): string {
  const stem = [seat, formatLabelWhen(createdMs, nowMs), team].join(LABEL_DIVIDER);
  // A title that was nothing but the seat name leaves no subject to carry; a dangling divider
  // reads as a truncated title, so drop it rather than render one.
  return subject.trim() ? `${stem}${LABEL_DIVIDER}${subject.trim()}` : stem;
}

/**
 * The terminal-tab title: `🔶 stanley · agents-stanley`. No timestamp — a tab is live, not a
 * history row, and it is re-asserted on every CLI command rather than written once. The seat stays
 * lowercase here to match the CLI's own voice (prompts, roster) rather than the sidebar's.
 */
export function renderTerminalTitle(seat: string, subject?: string): string {
  return subject ? `${SEAT_CHIP} ${seat} · ${subject}` : `${SEAT_CHIP} ${seat}`;
}

/** Escape a seat name for use inside a RegExp — seats are free-form strings from a binding. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The idempotency helper for a self-label: the host's own words behind any label a previous
 * orient already put on this session. Strips the ADR 468 stem (`dolly · Mon 1p · revive · `) and
 * the pre-468 sweep grammar (`🔶 Dolly (Fri 3p) - `, with or without chip or stamp), so a seat that
 * re-orients renders `seat · time · team · <subject>` once, never `dolly · … · dolly · … · x`.
 *
 * A title that does not open with this seat's name is returned untouched: another seat's label, or
 * a human's own words, are not this seat's to rewrite. Seat match is case-insensitive because
 * bindings are lowercase and the old grammar capitalized.
 */
export function stripSessionLabel(title: string, seat: string): string {
  const chipped = title.startsWith(SEAT_CHIP);
  const bare = chipped ? title.slice(SEAT_CHIP.length).replace(/^\s+/, '') : title;
  const time = '(?:[A-Z][a-z]{2} (?:\\d{1,2} )?\\d{1,2}[ap])';
  const m = new RegExp(
    `^${escapeRe(seat)}(?=$|[\\s\\-–—(·:])` +
      // ADR 468 stem: ` · <time> · <team>` — team is one field, up to the next divider.
      `(?:${LABEL_DIVIDER}${time}${LABEL_DIVIDER}[^·]*)?` +
      // pre-468 stamp: ` (<time>)`.
      `\\s*(?:\\(([^)]*)\\)\\s*)?` +
      `(?:\\s*[-–—·:]\\s*)?(.*)$`,
    'i',
  ).exec(bare);
  if (!m) return title;
  return (m[2] ?? '').trim();
}
