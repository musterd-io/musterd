/**
 * Answers that did not leave (nick, 2026-10-30: a lock-screen approval was lost to a relay that
 * answered nothing). An answer is signed and sealed once; if its callback POST fails, the sealed
 * callback waits here and is POSTed again each time the app opens, until the relay takes it (202)
 * or its token expires. A resend is the same sealed body, so it needs no second Face ID; the
 * daemon spends the token on the first copy that reaches it and refuses any later copy.
 *
 * Stored in expo-secure-store (the app's keychain): the sealed callback and its route only, never
 * the plaintext answer.
 */

/** One answer waiting to leave. `body` is the callback JSON exactly as first POSTed. */
export interface Outgoing {
  url: string;
  body: string;
  ref: string;
  expires_at: number;
}

/** Where the outbox lives; the default is expo-secure-store, a test passes a map. */
export interface OutboxStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

const KEY = 'answer-outbox';

/** The relay answered nothing: try once more after this pause before keeping it for later. */
export const RETRY_MS = 1_200;

async function secureStore(): Promise<OutboxStorage> {
  const SecureStore = await import('expo-secure-store');
  return {
    get: () => SecureStore.getItemAsync(KEY),
    set: (value) => SecureStore.setItemAsync(KEY, value),
  };
}

async function read(storage: OutboxStorage): Promise<Outgoing[]> {
  try {
    const raw = await storage.get();
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Outgoing[]) : [];
  } catch {
    return [];
  }
}

/** POST one callback; true when the relay took it. */
export async function post(item: Outgoing, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(item.url, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: item.body,
    });
    return response.status === 202;
  } catch {
    return false;
  }
}

/**
 * Send now: twice, a moment apart. If both fail, keep it for the next open and say so (false).
 */
export async function sendOrKeep(
  item: Outgoing,
  opts: { fetchImpl?: typeof fetch; storage?: OutboxStorage; pauseMs?: number } = {},
): Promise<boolean> {
  if (await post(item, opts.fetchImpl)) return true;
  await new Promise((resolve) => setTimeout(resolve, opts.pauseMs ?? RETRY_MS));
  if (await post(item, opts.fetchImpl)) return true;
  try {
    const storage = opts.storage ?? (await secureStore());
    const kept = (await read(storage)).filter((o) => o.ref !== item.ref);
    await storage.set(JSON.stringify([...kept, item]));
  } catch {
    // Nowhere to keep it: the outcome is still `undelivered`, and the ask stays open.
  }
  return false;
}

/**
 * POST every kept answer whose token is still live; drop the ones the relay took and the ones that
 * expired. Returns how many still wait.
 */
export async function flushOutbox(
  opts: { fetchImpl?: typeof fetch; storage?: OutboxStorage; now?: number } = {},
): Promise<number> {
  let storage: OutboxStorage;
  try {
    storage = opts.storage ?? (await secureStore());
  } catch {
    return 0;
  }
  const now = opts.now ?? Date.now();
  const waiting = (await read(storage)).filter((o) => o.expires_at > now);
  const still: Outgoing[] = [];
  for (const item of waiting) if (!(await post(item, opts.fetchImpl))) still.push(item);
  try {
    await storage.set(JSON.stringify(still));
  } catch {
    // Left as it was: the next open tries again.
  }
  return still.length;
}
