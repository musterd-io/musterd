import * as SecureStore from 'expo-secure-store';
import type { Connection } from '../lib/api';

/**
 * Where the daemon is, which Team, and the Member's credential — all in the iOS Keychain (ADR 519
 * §4). Only the credential is secret, but keeping the three together means one place to read and
 * one place to clear. Nothing here is compiled in: the server URL is a setting (ADR 520 §5).
 */

const KEYS = {
  server: 'musterd.server',
  team: 'musterd.team',
  credential: 'musterd.credential',
} as const;

const opts: SecureStore.SecureStoreOptions = {
  // Readable after the first unlock, so a background refresh can sync; never synced to iCloud.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function loadConnection(): Promise<Connection | null> {
  const [server, team, credential] = await Promise.all([
    SecureStore.getItemAsync(KEYS.server, opts),
    SecureStore.getItemAsync(KEYS.team, opts),
    SecureStore.getItemAsync(KEYS.credential, opts),
  ]);
  if (!server || !team || !credential) return null;
  return { server, team, credential };
}

export async function saveConnection(conn: Connection): Promise<void> {
  await SecureStore.setItemAsync(KEYS.server, conn.server, opts);
  await SecureStore.setItemAsync(KEYS.team, conn.team, opts);
  await SecureStore.setItemAsync(KEYS.credential, conn.credential, opts);
}

export async function clearConnection(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k, opts)));
}
