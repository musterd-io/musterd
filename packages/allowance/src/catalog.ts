/**
 * Every account the page knows how to offer.
 * A reason is what we say when the account is on and there is no read.
 * An empty reason means this package has a reader for it.
 */
export interface Account {
  id: string;
  name: string;
  reason: string;
}

export const ACCOUNTS: readonly Account[] = [
  { id: 'elevenlabs', name: 'ElevenLabs', reason: '' },
  { id: 'openai', name: 'OpenAI', reason: '' },
  { id: 'claude', name: 'Claude', reason: '' },
  {
    id: 'opencode',
    name: 'OpenCode',
    reason: 'OpenCode spends other providers. It has no window of its own.',
  },
  {
    id: 'grok',
    name: 'Grok',
    reason: 'xAI shows spend in the console. It does not report a remaining window.',
  },
  { id: 'muse', name: 'Muse', reason: '' },
  { id: 'cursor', name: 'Cursor', reason: '' },
  { id: 'hume', name: 'Hume', reason: 'Hume does not report remaining included usage.' },
  { id: 'exa', name: 'Exa', reason: 'Exa reports spend, not a remaining balance.' },
];

const READERS = new Set(['elevenlabs', 'openai', 'claude', 'cursor', 'muse']);

/** Accounts with no read. A quiet row carries a reason and never a number. */
export const QUIET: readonly Account[] = ACCOUNTS.filter((account) => !READERS.has(account.id));

export function accountById(id: string): Account | undefined {
  return ACCOUNTS.find((account) => account.id === id);
}

/** Keep known ids, in catalog order, once each. */
export function knownIds(ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return ACCOUNTS.filter((account) => wanted.has(account.id)).map((account) => account.id);
}
