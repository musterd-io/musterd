/**
 * Where a person lands after signing in (ADR 620 decision 8). Only a path from this allowlist —
 * compared after decoding, exactly — and anything else becomes `/`. No external origin, no `//`,
 * no backslash, no control character, no encoded variant of any of those can pass, because nothing
 * that is not literally on the list passes. Device approval and the team hand-back add their
 * paths here when their lanes land.
 */
export const RETURN_PATHS: readonly string[] = ['/', '/account'];

export function safeReturnPath(input: string | null | undefined): string {
  if (typeof input !== 'string' || input.length > 64) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return '/';
  }
  return RETURN_PATHS.includes(decoded) && decoded === input ? decoded : '/';
}
