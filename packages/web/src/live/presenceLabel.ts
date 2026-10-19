import type { LaneState } from '@musterd/protocol';

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

/** Glanceable model label — prefer family + version crumb over raw id. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  const raw = model.trim();
  if (!raw || raw.toLowerCase() === 'unknown') return '';
  const lower = raw.toLowerCase();
  // claude-opus-4-5 → opus 4.5 (Anthropic encodes the minor as a hyphen).
  // `fable` belongs in this list: without it, claude-fable-5 fell through to the generic fallback and
  // came out "claude fable" — the vendor prefix plus a family name, and no version at all. Any new
  // Claude family name has to be added here or it regresses the same way, silently.
  const anthropic = lower.match(/\b(opus|sonnet|haiku|fable)[- ]?(\d+)(?:[-.](\d+))?/);
  if (anthropic) {
    const ver = anthropic[3] ? `${anthropic[2]}.${anthropic[3]}` : anthropic[2]!;
    return `${anthropic[1]} ${ver}`;
  }
  // Everything else reads as its own words: family, version, and the named variant the lab gave it
  // ("gpt-6-luna" → "gpt 6 luna", "gemini-4-argon-contributor" → "gemini 4 argon"). Two things the
  // old rules lost (nick, 2026-10-19): a per-family rule kept family + version only, so GPT 6 Luna
  // read "gpt 6"; and the fallback kept the vendor prefix, so moonshotai/kimi-k3 read
  // "moonshotai/kimi k3". What is dropped is only what describes the route, not the model.
  const words = lower
    .slice(lower.lastIndexOf('/') + 1)
    .split(/[-_\s]+/)
    .filter((w) => w && !ROUTE_WORDS.has(w) && !/^\d{6,8}$/.test(w));
  const kept: string[] = [];
  for (const w of words) {
    if (kept.length && [...kept, w].join(' ').length > MAX_SHORT) break;
    kept.push(w);
  }
  return kept.join(' ');
}

/** The plate's width, in characters — whole words only, never a cut mid-word. */
const MAX_SHORT = 20;

/** Words about how a model was reached, not which one: price tier, programme, preview flag, the
 *  reasoning effort a harness appends. The raw id keeps them on hover. */
const ROUTE_WORDS = new Set([
  'free',
  'contributor',
  'preview',
  'latest',
  'exp',
  'experimental',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

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
