import { QUIET } from './catalog.js';
import { asLive, readElevenLabs } from './elevenlabs.js';
import type { ActiveProvider, Board } from './types.js';

export interface ReadDeps {
  env: NodeJS.ProcessEnv;
  now: number;
  timeZone: string;
  fetchSub: typeof fetch;
  signal: AbortSignal;
}

/** Read every provider this package knows. The key stays in the fetch header. */
export async function readBoard(deps: ReadDeps): Promise<Board> {
  const read = await readElevenLabs(deps.env['ELEVENLABS_API_KEY'], deps.fetchSub, deps.signal);
  const eleven: ActiveProvider =
    read.state === 'live'
      ? asLive('ElevenLabs', read)
      : { id: 'elevenlabs', name: 'ElevenLabs', state: read.state, reason: read.reason };
  return {
    readAt: deps.now,
    timeZone: deps.timeZone,
    active: [eleven],
    quiet: [...QUIET],
  };
}
