import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { knownIds } from './catalog.js';

const DEFAULT = ['elevenlabs'];

/** The ids in a config file. Null when the file is not a selection. */
export function parseConfig(text: string): string[] | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object') return null;
  const accounts = (body as Record<string, unknown>)['accounts'];
  if (!Array.isArray(accounts) || accounts.some((id) => typeof id !== 'string')) return null;
  return knownIds(accounts);
}

/** Ids checked on the form. Unknown ids are dropped. */
export function selectionFromForm(body: string): string[] {
  return knownIds(new URLSearchParams(body).getAll('account'));
}

export function configText(ids: readonly string[]): string {
  return `${JSON.stringify({ accounts: knownIds(ids) }, null, 2)}\n`;
}

/**
 * The saved selection, or ElevenLabs when the file is not there yet.
 * A file that is not a selection also falls back, and is not rewritten here.
 */
export async function loadSelection(path: string): Promise<string[]> {
  try {
    const parsed = parseConfig(await readFile(path, 'utf8'));
    return parsed ?? [...DEFAULT];
  } catch {
    return [...DEFAULT];
  }
}

/** Write the selection. The file holds ids only, mode 0600. */
export async function saveSelection(path: string, ids: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, configText(ids), { mode: 0o600 });
  await chmod(path, 0o600);
}
