import { ACCOUNTS } from './catalog.js';
import { asClaude, claudeTokenFromEnv, readClaude } from './claude.js';
import { asCodex, codexSession, readCodex } from './codex.js';
import { asCursor, readCursor } from './cursor.js';
import { asLive, readElevenLabs } from './elevenlabs.js';
import type { Board, ProviderCard } from './types.js';

export interface ReadDeps {
  env: NodeJS.ProcessEnv;
  now: number;
  timeZone: string;
  fetchSub: typeof fetch;
  signal: AbortSignal;
  chosen: readonly string[];
  codexAuth: unknown;
  claudeCredential: unknown;
  cursorToken: string | null;
}

function held(
  id: string,
  name: string,
  read: { state: 'missing' | 'error'; reason: string },
): ProviderCard {
  return { id, name, state: read.state, reason: read.reason };
}

/** Read the accounts the user turned on. A token stays inside its fetch. */
export async function readBoard(deps: ReadDeps): Promise<Board> {
  const on = new Set(deps.chosen);
  const providers: ProviderCard[] = [];
  for (const account of ACCOUNTS) {
    if (!on.has(account.id)) continue;
    if (account.id === 'elevenlabs') {
      const read = await readElevenLabs(deps.env['ELEVENLABS_API_KEY'], deps.fetchSub, deps.signal);
      providers.push(
        read.state === 'live' ? asLive('ElevenLabs', read) : held('elevenlabs', 'ElevenLabs', read),
      );
      continue;
    }
    if (account.id === 'openai') {
      const read = await readCodex(codexSession(deps.codexAuth), deps.fetchSub, deps.signal);
      providers.push(read.state === 'live' ? asCodex(read) : held('openai', 'OpenAI', read));
      continue;
    }
    if (account.id === 'claude') {
      const read = await readClaude(
        claudeTokenFromEnv(deps.env, deps.claudeCredential),
        deps.fetchSub,
        deps.signal,
      );
      providers.push(read.state === 'live' ? asClaude(read) : held('claude', 'Claude', read));
      continue;
    }
    if (account.id === 'cursor') {
      const read = await readCursor(deps.cursorToken, deps.fetchSub, deps.signal);
      providers.push(read.state === 'live' ? asCursor(read) : held('cursor', 'Cursor', read));
      continue;
    }
    providers.push({ id: account.id, name: account.name, state: 'quiet', reason: account.reason });
  }
  return { readAt: deps.now, timeZone: deps.timeZone, chosen: [...deps.chosen], providers };
}
