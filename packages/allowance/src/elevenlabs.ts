import type { LiveProvider, Window } from './types.js';

const URL = 'https://api.elevenlabs.io/v1/user/subscription';

export interface ElevenRead {
  state: 'live';
  detail: string | null;
  windows: Window[];
}

export interface ElevenMiss {
  state: 'missing' | 'error';
  reason: string;
}

const NOTABLE_STATUS: Record<string, string> = {
  incomplete: 'incomplete',
  past_due: 'past due',
  free_disabled: 'free, disabled',
};

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function windowOf(
  id: string,
  unit: string,
  used: number,
  limit: number,
  resetsAt: number | null,
): Window {
  return { id, unit, used, limit, resetsAt };
}

/** Turn a subscription body into windows. The body is never copied onto the result. */
export function parseElevenLabs(body: unknown): ElevenRead | ElevenMiss {
  if (body === null || typeof body !== 'object') {
    return { state: 'error', reason: 'ElevenLabs sent something we could not read.' };
  }
  const row = body as Record<string, unknown>;
  const used = integer(row['character_count']);
  const limit = integer(row['character_limit']);
  if (used === null || limit === null) {
    return { state: 'error', reason: 'ElevenLabs left out the character window.' };
  }
  const reset = row['next_character_count_reset_unix'];
  const resetsAt =
    typeof reset === 'number' && Number.isInteger(reset) && reset > 0 ? reset * 1000 : null;
  const windows = [windowOf('characters', 'characters', used, limit, resetsAt)];
  const voicesUsed = integer(row['voice_slots_used']);
  const voicesLimit = integer(row['voice_limit']);
  if (voicesUsed !== null && voicesLimit !== null && voicesLimit > 0) {
    windows.push(windowOf('voices', 'voice slots', voicesUsed, voicesLimit, null));
  }
  const tier = typeof row['tier'] === 'string' ? row['tier'].trim().slice(0, 40) : '';
  const status = typeof row['status'] === 'string' ? NOTABLE_STATUS[row['status']] : undefined;
  const detail = [tier, status].filter((part) => part !== undefined && part !== '').join(' · ');
  return { state: 'live', detail: detail === '' ? null : detail, windows };
}

export async function readElevenLabs(
  key: string | undefined,
  fetchSub: typeof fetch,
  signal: AbortSignal,
): Promise<ElevenRead | ElevenMiss> {
  const trimmed = key?.trim() ?? '';
  if (trimmed === '') return { state: 'missing', reason: 'Set ELEVENLABS_API_KEY, then refresh.' };
  let response: Response;
  try {
    response = await fetchSub(URL, {
      headers: { 'xi-api-key': trimmed },
      redirect: 'error',
      signal,
    });
  } catch {
    return { state: 'error', reason: 'ElevenLabs did not answer.' };
  }
  if (response.status === 401 || response.status === 403) {
    return { state: 'error', reason: 'ElevenLabs refused the key.' };
  }
  if (!response.ok) return { state: 'error', reason: 'ElevenLabs did not answer.' };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: 'error', reason: 'ElevenLabs sent something we could not read.' };
  }
  return parseElevenLabs(body);
}

export function asLive(name: string, read: ElevenRead): LiveProvider {
  return { id: 'elevenlabs', name, state: 'live', detail: read.detail, windows: read.windows };
}
