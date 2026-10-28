/**
 * One line per account (ADR 723, painted per ADR 744 and ADR 745). A percent window is shown as
 * what has been used. Local types only — this file does not import the protocol barrel, so zod
 * stays out of /live.
 */

export const ALLOWANCE_QUIET_MS = 2 * 60 * 1000;

export interface AllowanceLineWindow {
  name: string;
  left: number;
  resetsAt: number | null;
  kind: 'percent' | 'amount';
  used?: number;
  limit?: number;
  unit?: string;
}

export interface AllowanceLineAccount {
  label: string;
  readAt: number;
  windows: AllowanceLineWindow[];
}

export interface AllowanceLineView {
  readAt: number;
  accounts: AllowanceLineAccount[];
}

export interface AllowanceLine {
  text: string;
  suffixes: string[];
  title: string;
  /**
   * How full the bar is, 0–100. A percent window fills with the share used; an amount window
   * fills with the share left.
   */
  bar: number;
  warn: boolean;
  quiet: boolean;
  /** The top window's raw share left and reset, so lines from several accounts can be ranked. */
  left: number;
  resetsAt: number | null;
}

function percent(left: number): number {
  return Math.max(0, Math.min(100, Math.round(left * 100)));
}

/** Share used, as a whole percent. The stored window stays `left`. */
function usedPercent(left: number): number {
  return Math.max(0, Math.min(100, Math.round((1 - left) * 100)));
}

function amount(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function amountLeft(window: AllowanceLineWindow): { left: string; unit: string } | null {
  if (typeof window.used !== 'number' || typeof window.limit !== 'number') return null;
  if (!Number.isFinite(window.used) || !Number.isFinite(window.limit)) return null;
  return {
    left: amount(Math.max(0, window.limit - window.used)),
    unit: window.unit?.trim() ?? '',
  };
}

function sentence(account: AllowanceLineAccount, window: AllowanceLineWindow): string {
  if (window.kind === 'percent') {
    return `${account.label} has ${usedPercent(window.left)}% of the ${window.name} window used.`;
  }
  const count = amountLeft(window);
  if (!count) return `${account.label} ${window.name}.`;
  const unit = count.unit === '' ? '' : ` ${count.unit}`;
  return `${account.label} ${window.name}: ${count.left}${unit} left of ${amount(window.limit ?? 0)}.`;
}

function lineFor(account: AllowanceLineAccount, now: number): AllowanceLine | null {
  const ordered = [...account.windows].sort((a, b) => {
    if (a.left !== b.left) return a.left - b.left;
    return (a.resetsAt ?? Number.POSITIVE_INFINITY) - (b.resetsAt ?? Number.POSITIVE_INFINITY);
  });
  const top = ordered[0];
  if (!top) return null;
  const used = usedPercent(top.left);
  const count = top.kind === 'amount' ? amountLeft(top) : null;
  return {
    text:
      top.kind === 'percent'
        ? `${account.label} ${used}% used`
        : count
          ? `${account.label} ${count.left}${count.unit === '' ? '' : ` ${count.unit}`} left`
          : account.label,
    suffixes: ordered.slice(1).map((window) => {
      if (window.kind === 'percent') return `${window.name} ${usedPercent(window.left)}%`;
      const more = amountLeft(window);
      if (!more) return window.name;
      if (more.unit === '' || more.unit === window.name) return `${window.name} ${more.left}`;
      return `${window.name} ${more.left} ${more.unit}`;
    }),
    title: ordered.map((window) => sentence(account, window)).join(' '),
    bar: top.kind === 'percent' ? used : percent(top.left),
    warn: top.left < 0.15,
    quiet: now - account.readAt > ALLOWANCE_QUIET_MS,
    left: top.left,
    resetsAt: top.resetsAt,
  };
}

function byTightest(a: AllowanceLine, b: AllowanceLine): number {
  if (a.left !== b.left) return a.left - b.left;
  return (a.resetsAt ?? Number.POSITIVE_INFINITY) - (b.resetsAt ?? Number.POSITIVE_INFINITY);
}

/** One line per account. No accounts, no line. */
export function allowanceLines(
  view: AllowanceLineView | null | undefined,
  now: number,
): AllowanceLine[] {
  if (!view) return [];
  return view.accounts.flatMap((account) => {
    const line = lineFor(account, now);
    return line ? [line] : [];
  });
}

/** How old a reading is, in the card's words (alfie's copy, lane 01M5ZFNPKA). */
export function readingAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface AllowanceChipMember {
  name: string;
  kind: string;
  presence?: string | null | undefined;
  allowance?: AllowanceLineView | null | undefined;
}

/** One human's chip in the /live header (ADR 744, ADR 745): every account is named, most used first. */
export interface AllowanceChip {
  name: string;
  /** Every account, most used first. The chip names each of them. `lines[0]` sets the chip's tone. */
  lines: AllowanceLine[];
  offline: boolean;
  /** "last read 3h ago", with "offline · " in front for an offline human; null while fresh. */
  note: string | null;
  label: string;
}

/**
 * The header's chips: humans only, one per human with a reading, offline humans included. An
 * agent's reading stays on the roster and is not painted (ADR 744). Every account is named on the
 * chip, most used first (ADR 745). The signed-in viewer comes first, then online humans, then
 * offline ones, by name within each.
 */
export function allowanceChips(
  roster: readonly AllowanceChipMember[],
  now: number,
  you: string | null = null,
): AllowanceChip[] {
  const chips = roster.flatMap((member) => {
    if (member.kind !== 'human' || !member.allowance) return [];
    const lines = allowanceLines(member.allowance, now).sort(byTightest);
    const top = lines[0];
    if (!top) return [];
    const offline = member.presence === 'offline';
    const age = now - member.allowance.readAt;
    const stale = age > ALLOWANCE_QUIET_MS;
    const read = `last read ${readingAge(age)}`;
    const note = stale ? (offline ? `offline · ${read}` : read) : null;
    const label = [
      `${member.name}'s allowance: ${lines.map((line) => line.text).join(', ')}`,
      stale && offline ? 'offline' : null,
      stale ? read : null,
    ]
      .filter(Boolean)
      .join(', ');
    return [{ name: member.name, lines, offline, note, label }];
  });
  const rank = (chip: AllowanceChip) => (chip.name === you ? 0 : chip.offline ? 2 : 1);
  return chips.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
