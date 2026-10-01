import { describe, expect, it } from 'vitest';
import { COMMANDS, isCommand } from './commandTable.js';
import { CATALOG } from './help/catalog.js';

/** Dispatched but deliberately uncatalogued: hook and plumbing entry points nobody types. */
const UNCATALOGUED = ['codex-hook', 'gate', 'nudge'];

describe('command table (ADR 491)', () => {
  it('has a loader for every catalogued command', () => {
    for (const c of CATALOG) expect(Object.hasOwn(COMMANDS, c.name), c.name).toBe(true);
  });

  it('dispatches nothing the catalog does not name, except the plumbing entry points', () => {
    const extra = Object.keys(COMMANDS)
      .filter((name) => !CATALOG.some((c) => c.name === name))
      .sort();
    expect(extra).toEqual(UNCATALOGUED);
  });

  it('every loader resolves to the command function', async () => {
    for (const [name, load] of Object.entries(COMMANDS)) {
      expect(typeof (await load()), name).toBe('function');
    }
  }, 120_000);

  it('isCommand answers own keys only — never a prototype member or a seat name', () => {
    expect(isCommand('status')).toBe(true);
    expect(isCommand('wake-context')).toBe(true);
    expect(isCommand('toString')).toBe(false);
    expect(isCommand('stanley')).toBe(false);
    expect(isCommand(undefined)).toBe(false);
  });
});
