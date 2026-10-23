/**
 * The 28px what's-left line (ADR 723). One line per account. Local types only — this file does not
 * import the protocol barrel, so zod stays out of /live.
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
  /** Percent of the window that is left, 0–100. The bar is this wide. */
  bar: number;
  warn: boolean;
  quiet: boolean;
}

function percent(left: number): number {
  return Math.max(0, Math.min(100, Math.round(left * 100)));
}

function amount(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function sentence(account: AllowanceLineAccount, window: AllowanceLineWindow): string {
  if (window.kind === 'percent') {
    return `${account.label} has ${percent(window.left)}% of the ${window.name} window left.`;
  }
  const used = window.used ?? 0;
  const limit = window.limit ?? 0;
  const unit = window.unit ?? '';
  return `${account.label} ${window.name}: ${amount(Math.max(0, limit - used))} ${unit} left of ${amount(limit)}.`;
}

function lineFor(account: AllowanceLineAccount, now: number): AllowanceLine | null {
  const ordered = [...account.windows].sort((a, b) => {
    if (a.left !== b.left) return a.left - b.left;
    return (a.resetsAt ?? Number.POSITIVE_INFINITY) - (b.resetsAt ?? Number.POSITIVE_INFINITY);
  });
  const top = ordered[0];
  if (!top) return null;
  const n = percent(top.left);
  return {
    text: top.kind === 'percent' ? `${account.label} ${n}% left` : account.label,
    suffixes: ordered.slice(1).map((window) =>
      window.kind === 'percent' ? `${window.name} ${percent(window.left)}%` : window.name,
    ),
    title: ordered.map((window) => sentence(account, window)).join(' '),
    bar: n,
    warn: top.left < 0.15,
    quiet: now - account.readAt > ALLOWANCE_QUIET_MS,
  };
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
