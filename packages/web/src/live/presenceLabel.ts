import type { LaneState } from '@musterd/protocol';
import { shortModel } from '@musterd/protocol/model';

/** Glanceable model label — moved to protocol so the daemon labels a model as /live does (ADR 814). */
export { shortModel };

/** Friendly harness labels — never collapse `claude-code` to bare `claude` (reads as the model family). */
const SURFACE_SHORT: Record<string, string> = {
  'claude-code': 'claude code',
  cursor: 'cursor',
  codex: 'codex',
  opencode: 'opencode',
  grok: 'grok',
  cli: 'cli',
  web: 'web',
  ios: 'ios',
  slack: 'slack',
  other: 'other',
};

export function shortSurface(surface: string | null | undefined): string {
  if (!surface) return '';
  return SURFACE_SHORT[surface] ?? surface;
}

/**
 * Short model label for the nameplate. Collapsed `/live` shows the provider icon instead; broadcast
 * and the expanded detail line still use this text. Full surface / raw model id stay on hover via
 * {@link identityMeta}'s `title`.
 */
export function plateModel(model: string | null | undefined): string | null {
  const short = shortModel(model);
  return short ? short : null;
}

export type PlateDetailKind = 'model' | 'harness' | 'role';

/** Typed segments for the expanded plate, in display order: model → harness → role. */
export function plateDetailParts(opts: {
  surface?: string | null;
  model?: string | null;
  role?: string | null;
}): Array<{ kind: PlateDetailKind; text: string }> {
  const parts: Array<{ kind: PlateDetailKind; text: string }> = [];
  const mod = plateModel(opts.model);
  if (mod) parts.push({ kind: 'model', text: mod });
  const surf = shortSurface(opts.surface);
  if (surf) parts.push({ kind: 'harness', text: surf });
  const role = opts.role?.trim() ?? '';
  if (role) parts.push({ kind: 'role', text: role });
  return parts;
}

/** Text segments for the expanded plate, in display order: model → harness → role. */
export function plateDetailSegments(opts: {
  surface?: string | null;
  model?: string | null;
  role?: string | null;
}): string[] {
  return plateDetailParts(opts).map((p) => p.text);
}

export function identityMeta(opts: {
  surface?: string | null;
  model?: string | null;
  role?: string | null;
}): { line: string | null; title: string } {
  const surf = shortSurface(opts.surface);
  const mod = shortModel(opts.model);
  const role = opts.role?.trim() ?? '';
  const parts = [surf, mod].filter(Boolean);
  let line: string | null = parts.length ? parts.join(' · ') : null;
  if (role) line = line ? `${line} · ${role}` : role;
  const titleParts = [
    opts.surface ?? null,
    opts.model && opts.model !== 'unknown' ? opts.model : null,
    role || null,
  ].filter(Boolean);
  return { line, title: titleParts.join(' · ') };
}

/**
 * A glanceable work cue: the first few *whole* words of a lane/status title.
 * Never cuts mid-word — a truncated "Office presence chrome (namepla…" is worse than silence.
 */
export function shortWorkTitle(title: string, maxWords = 4): string {
  const words = title
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return '';
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

/** @deprecated Prefer {@link shortWorkTitle} — character ellipsis cuts mid-word. */
export function truncateWork(title: string, maxChars = 32): string {
  const t = title.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function shortLaneState(state: LaneState | null | undefined): string | null {
  switch (state) {
    case 'claimed':
      return 'claimed';
    case 'active':
      return 'active';
    case 'blocked':
      return 'blocked';
    case 'awaiting_acceptance':
    case 'ready_for_review':
      return 'acceptance';
    case 'open':
    case 'done':
    case 'abandoned':
    case 'parked':
    case undefined:
    case null:
      return null;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
