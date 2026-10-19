import type { QuietProvider } from './types.js';

/**
 * Providers Nick named that do not yet have a read in this package.
 * A quiet row carries a reason and never a number.
 */
export const QUIET: readonly QuietProvider[] = [
  { id: 'openai', name: 'OpenAI', state: 'quiet', reason: 'No window we can read yet.' },
  {
    id: 'claude',
    name: 'Claude',
    state: 'quiet',
    reason: 'The 5-hour and weekly windows have no public read yet.',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    state: 'quiet',
    reason: 'OpenCode spends other providers. It has no window of its own.',
  },
  { id: 'grok', name: 'Grok', state: 'quiet', reason: 'No window we can read yet.' },
  { id: 'muse', name: 'Muse', state: 'quiet', reason: 'No window we can read yet.' },
  { id: 'cursor', name: 'Cursor', state: 'quiet', reason: 'No window we can read yet.' },
  { id: 'hume', name: 'Hume', state: 'quiet', reason: 'No window we can read yet.' },
  { id: 'exa', name: 'Exa', state: 'quiet', reason: 'No window we can read yet.' },
];
