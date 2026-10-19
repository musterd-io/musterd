import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configText,
  loadSelection,
  parseConfig,
  saveSelection,
  selectionFromForm,
} from './config.js';

describe('parseConfig', () => {
  it('keeps known ids in catalog order, once', () => {
    expect(parseConfig('{"accounts":["exa","elevenlabs","exa","nope"]}')).toEqual([
      'elevenlabs',
      'exa',
    ]);
    expect(parseConfig('{"accounts":[]}')).toEqual([]);
  });

  it('rejects a file that is not a selection', () => {
    expect(parseConfig('{')).toBeNull();
    expect(parseConfig('{"accounts":[1]}')).toBeNull();
    expect(parseConfig('[]')).toBeNull();
  });
});

describe('selectionFromForm', () => {
  it('reads checked accounts and drops the rest', () => {
    expect(selectionFromForm('account=claude&account=nope&account=openai')).toEqual([
      'openai',
      'claude',
    ]);
    expect(selectionFromForm('')).toEqual([]);
  });
});

describe('saveSelection', () => {
  it('writes ids only, mode 0600, and reads them back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'allowance-'));
    const path = join(dir, 'config.json');
    expect(await loadSelection(path)).toEqual(['elevenlabs']);
    await saveSelection(path, ['cursor', 'muse', 'cursor']);
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe(configText(['muse', 'cursor']));
    expect(await loadSelection(path)).toEqual(['muse', 'cursor']);
    expect(await readFile(path, 'utf8')).not.toContain('key');
  });
});
