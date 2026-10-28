/**
 * The CLI's shared render toolkit — small layout primitives every command composes, built only on the
 * `theme` color seam (no new deps, 16-color-safe per brand.md §2 + docs/design/figma-brief-terminal.md).
 *
 * The design north star is the web's warm isometric office (DESIGN.md): warmth comes from the mustard
 * accent, generous structure, and cozy microcopy — not from new hues. Delight is reserved for moments
 * (a `✓` settle, an incoming `⚑`), so these primitives stay quiet and let the content breathe.
 */
import { theme } from './theme.js';

/**
 * The canonical glyph vocabulary, mirrored from the web act-glyph set (Stream.tsx / office-scene) and
 * kept to characters every 16-color terminal can render. Use these instead of inlining literals so the
 * CLI speaks one visual language.
 */
export const sym = {
  ok: '✓',
  err: '✗',
  warn: '⚠',
  flag: '⚑',
  pending: '⧖',
  arrow: '→',
  handoff: '↦',
  steer: '↪',
  online: '●',
  offline: '○',
  goal: '◆',
  branch: '⎇',
  unread: '▌',
  dot: '·',
  bullet: '•',
  more: '…',
} as const;

/** Matches SGR color/style escapes so width math counts visible characters only. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** East Asian Width: is this code point a wide (2-cell) character? Covers the ranges that actually
 *  occur in terminal text — CJK, hangul, fullwidth forms, common emoji. Anything not listed is
 *  treated as narrow (1 cell), which is correct for the CLI's ASCII + single-width glyph set and
 *  for the vast majority of Latin-script content. No runtime dependency (brand.md §2 / ADR 001). */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) || // CJK radicals / symbols
    (cp >= 0x3300 && cp <= 0x4dbf) || // CJK compat ideographs
    (cp >= 0x4e00 && cp <= 0xa4c6) || // CJK unified ideographs + Yi
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xac00 && cp <= 0xd7fb) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
    (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b001) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext + supplementary
  );
}

/** The visible display width of a single code point (0 for combining/zero-width, 2 for wide). */
function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  // Combining / zero-width.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x2060 ||
    cp === 0xfeff
  )
    return 0;
  if (isWideCodePoint(cp)) return 2;
  return 1;
}

/** The visible display width of a possibly-colorized string (ANSI escapes stripped). */
export function visibleLen(s: string): number {
  const stripped = s.replace(ANSI, '');
  let width = 0;
  for (const ch of stripped) width += codePointWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** Pad a (possibly colorized) string to `width` visible columns, always leaving ≥1 trailing space. */
export function padEndVisible(s: string, width: number): string {
  const extra = Math.max(1, width - visibleLen(s));
  return s + ' '.repeat(extra);
}

/**
 * The usable line width: the real terminal columns, clamped to a comfortable range. Non-TTY / piped
 * output has no `columns` (→ 80), which also keeps tests deterministic (they run under `pool: 'forks'`,
 * so `process.stdout.columns` is undefined and this returns 80 — the width the render tests assume).
 */
export function termWidth(max = 100): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(max, cols));
}

/** Greedy word-wrap to `width` visible columns. Returns `['']` for empty input so callers can always join.
 *  Width is measured in display cells, so CJK/wide glyphs and ANSI escapes (already stripped by
 *  callers) do not overflow the line. A token wider than `width` is hard-broken. */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let lineWidth = 0;
  for (const w of words) {
    const wWidth = visibleLen(w);
    if (line && lineWidth + wWidth + 1 > width) {
      lines.push(line);
      line = '';
      lineWidth = 0;
    }
    if (!line) {
      // Hard-break a token that is wider than the whole line.
      if (wWidth > width) {
        let chunk = '';
        let chunkWidth = 0;
        for (const ch of w) {
          const cw = codePointWidth(ch.codePointAt(0) ?? 0);
          if (chunk && chunkWidth + cw > width) {
            lines.push(chunk);
            chunk = ch;
            chunkWidth = cw;
          } else {
            chunk += ch;
            chunkWidth += cw;
          }
        }
        if (chunk) {
          line = chunk;
          lineWidth = chunkWidth;
        }
      } else {
        line = w;
        lineWidth = wWidth;
      }
    } else {
      line = `${line} ${w}`;
      lineWidth += 1 + wWidth;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** A mustard section heading — uppercased so groups read like signposted rooms on the floor. */
export function heading(s: string): string {
  return theme.accent(s.toUpperCase());
}

/** A quieter, bold subheading for within a section. */
export function subhead(s: string): string {
  return theme.bold(s);
}

/** A dim horizontal rule spanning the current width (used sparingly, e.g. the help footer). */
export function rule(width = termWidth()): string {
  return theme.meta('─'.repeat(width));
}

/** Dim/muted text — the replacement for scattered `pc.dim` / `pc.gray` calls. */
export function dim(s: string): string {
  return theme.dim(s);
}

/** A muted follow-on hint line: `→ do this next`. */
export function hint(s: string): string {
  return theme.meta(`${sym.arrow} ${s}`);
}

/**
 * Key tokens a footer leads a clause with. Longer tokens first so `any key` and `⌃R` win.
 * A lone `w` is the wake-menu watch key; it only matches when a space or the end follows.
 */
const KEY_TOKEN = /^(any key|letters|⌃R|⌃C|⌃P|⌃N|↑↓|⏎|⇥|→|←|esc|w)(?=\s|$)/;

/**
 * A footer whose leading key is accent and the rest is meta: `⏎ launch · esc quit`.
 * With color off every role is the identity, so this returns `line` unchanged and the
 * no-color frames stay exact.
 */
export function paintKeys(line: string): string {
  const lead = /^\s*/.exec(line)?.[0] ?? '';
  const parts = line.slice(lead.length).split(' · ');
  const painted = parts
    .map((part) => {
      const key = KEY_TOKEN.exec(part)?.[1];
      if (!key) return theme.meta(part);
      return theme.accent(key) + theme.meta(part.slice(key.length));
    })
    .join(theme.meta(' · '));
  return lead + painted;
}

/**
 * A success confirmation with the signature `✓`, and — the delight-in-moments touch — an optional dim
 * `next:` line so a command never dead-ends: it names the obvious next move.
 */
export function success(msg: string, opts: { next?: string } = {}): string {
  const head = `${theme.ok(sym.ok)} ${msg}`;
  return opts.next ? `${head}\n  ${theme.meta(`next: ${opts.next}`)}` : head;
}

export interface DefRow {
  term: string;
  desc: string;
}

/**
 * One aligned two-column row: `term` padded so `desc` starts at visible column `gap`, then `desc`
 * wrapped with a hanging indent to that same column. Alignment is computed on visible length, so it
 * holds whether or not color is on.
 */
export function defRow(row: DefRow, gap: number, opts: { width?: number } = {}): string {
  const width = opts.width ?? termWidth();
  // At very narrow widths the term column must not eat the whole line: clamp the gap so the
  // description always gets at least a usable slice.
  const effectiveGap = Math.min(gap, Math.max(1, width - 20));
  const descWidth = Math.max(20, width - effectiveGap);
  const wrapped = wrapText(row.desc, descWidth);
  // When the term is wider than its column, render it on its own line(s) first so the
  // description never overflows the width (the 40-column case in the brief).
  if (visibleLen(row.term) > effectiveGap) {
    const indent = ' '.repeat(Math.min(effectiveGap, width));
    const descLines = wrapped.map((l) => indent + theme.meta(l));
    return [row.term, ...descLines].join('\n');
  }
  const first = padEndVisible(row.term, effectiveGap) + theme.meta(wrapped[0] ?? '');
  if (wrapped.length === 1) return first;
  const indent = ' '.repeat(effectiveGap);
  const rest = wrapped.slice(1).map((l) => indent + theme.meta(l));
  return [first, ...rest].join('\n');
}

/**
 * An aligned definition list: every `desc` starts at one shared column (widest term + a 2-space
 * gutter), so a group of commands lines up cleanly. `paint` colorizes the term (default: mustard
 * `musterd <name>` style).
 */
export function defList(
  rows: DefRow[],
  opts: { paint?: (term: string) => string; width?: number } = {},
): string {
  const paint = opts.paint ?? theme.accent;
  const gap = Math.max(0, ...rows.map((r) => visibleLen(r.term))) + 2;
  const rowOpts = opts.width !== undefined ? { width: opts.width } : {};
  return rows.map((r) => defRow({ term: paint(r.term), desc: r.desc }, gap, rowOpts)).join('\n');
}
