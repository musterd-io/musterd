import { handbackPath, parseHandbackShape } from './handback.js';

/**
 * Where a person lands after signing in (ADR 620 decision 8). Only a path from this allowlist —
 * compared after decoding, exactly — and anything else becomes `/`. No external origin, no `//`,
 * no backslash, no control character, no encoded variant of any of those can pass, because nothing
 * that is not literally on the list passes. Device approval adds its path here when its lane lands.
 * The team hand-back (ADR 722 §1) carries a query, so it is matched by shape instead: a path passes
 * only if it IS the one canonical spelling `handbackPath` gives for what it parses to.
 */
export const RETURN_PATHS: readonly string[] = ['/', '/account'];

export function safeReturnPath(input: string | null | undefined): string {
  if (typeof input === 'string' && input.length <= 512 && input.startsWith('/handback?')) {
    const h = parseHandbackShape(input);
    return h && handbackPath(h) === input ? input : '/';
  }
  if (typeof input !== 'string' || input.length > 64) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return '/';
  }
  return RETURN_PATHS.includes(decoded) && decoded === input ? decoded : '/';
}
