/**
 * Allowance providers and window kinds as plain TypeScript — no zod (ADR 723).
 * `allowance.ts` builds the schemas from these tuples. `guards.ts` checks the roster against the
 * same tuples, so the browser bundle never pulls a validator in to read a what's-left line.
 */

/** Providers the roster can name. Quiet providers are omitted rather than listed. */
export const ALLOWANCE_PROVIDERS = ['claude', 'openai', 'cursor', 'elevenlabs'] as const;
export type AllowanceProvider = (typeof ALLOWANCE_PROVIDERS)[number];

/**
 * `percent` — `left` is the share remaining, and the card prints a percent.
 * `amount` — characters or dollars; the counts stay in the title, and the card prints no percent.
 */
export const ALLOWANCE_KINDS = ['percent', 'amount'] as const;
export type AllowanceKind = (typeof ALLOWANCE_KINDS)[number];
