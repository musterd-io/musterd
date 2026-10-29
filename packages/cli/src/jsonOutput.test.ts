import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from './commandTable.js';
import { jsonRefusal, NO_JSON_COMMANDS, NO_JSON_SUBCOMMANDS } from './jsonOutput.js';

/** The module a command word loads, read off commandTable.ts's lazy import. */
function moduleSource(word: string): string {
  const table = readFileSync(new URL('./commandTable.ts', import.meta.url), 'utf8');
  const line = table
    .split('\n')
    .find((l) => l.trimStart().startsWith(`${word}:`) || l.includes(`'${word}':`));
  const mod = /import\('\.\/commands\/([\w-]+)\.js'\)/.exec(line ?? '')?.[1];
  if (!mod) throw new Error(`no module for ${word}`);
  return readFileSync(new URL(`./commands/${mod}.ts`, import.meta.url), 'utf8');
}

const READS_JSON = /flags\.json|flags\[['"]json['"]\]/;

describe('--json refusals (ADR 758)', () => {
  it('names only real command words', () => {
    for (const word of [...NO_JSON_COMMANDS, ...Object.keys(NO_JSON_SUBCOMMANDS)]) {
      expect(Object.hasOwn(COMMANDS, word), word).toBe(true);
    }
  });

  it('refuses a whole command only while its module never reads --json', () => {
    // When a command learns --json, this fails until its entry is removed.
    for (const word of NO_JSON_COMMANDS)
      expect(READS_JSON.test(moduleSource(word)), word).toBe(false);
  });

  it('refuses the listed commands and subcommands, and nothing else', () => {
    expect(jsonRefusal('board', [])).toMatch(/musterd board` has no JSON output/);
    expect(jsonRefusal('goal', ['declare', 'x'])).toMatch(/musterd goal declare` has no JSON/);
    expect(jsonRefusal('goal', ['list'])).toBeNull();
    expect(jsonRefusal('lane', ['open', 'x'])).toBeNull();
    expect(jsonRefusal('status', [])).toBeNull();
  });
});
