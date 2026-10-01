/**
 * The Node ≥22 gate (ADR 156), split from `runtime.ts` so `bin.ts` can run it without loading
 * `@musterd/protocol`: `runtime.ts` imports the protocol root, which measured ~740 ms on a cold
 * import (ADR 491). `runtime.ts` re-exports these three, so its callers are unchanged.
 */

/** Matches monorepo `engines.node` and published package engines (ADR 156). */
export const MIN_NODE_MAJOR = 22;

/** One-line fix shown whenever we refuse Node &lt;22 (bin gate + service install). */
export function nodeUpgradeHint(): string {
  return `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && musterd <cmd>`;
}

/**
 * If `version` (default `process.version`) is below {@link MIN_NODE_MAJOR}, return a refusal
 * message; otherwise null.
 */
export function nodeVersionTooOld(version: string = process.version): string | null {
  const m = /^v(\d+)\./.exec(version);
  const major = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return (
    `musterd needs Node >=${MIN_NODE_MAJOR} (you are on ${version}). ` +
    `Put a matching node first on PATH, e.g.\n  ${nodeUpgradeHint()}`
  );
}
