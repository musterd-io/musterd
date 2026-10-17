import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessContext } from '../reconcile/context.js';
import { codexAdapter } from './codex.js';
import { grokAdapter } from './grok.js';
import { opencodeAdapter } from './opencode.js';

// ADR 643: a harness is available only when its binary runs. A config dir an uninstall left
// behind used to read as an install, so the pickers offered a CLI the machine did not have.
const cases = [
  { adapter: codexAdapter, bin: 'codex', dirs: [['.codex']] },
  {
    adapter: opencodeAdapter,
    bin: 'opencode',
    dirs: [
      ['.config', 'opencode'],
      ['.local', 'share', 'opencode'],
    ],
  },
  { adapter: grokAdapter, bin: 'grok', dirs: [['.grok']] },
];

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'musterd-avail-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function ctxWith(runs: (cmd: string) => boolean): HarnessContext {
  return {
    env: { HOME: home },
    exec: { run: async (cmd: string) => ({ ok: runs(cmd), out: '' }) },
  } as unknown as HarnessContext;
}

describe('harness availability reads the binary, not a leftover config dir', () => {
  for (const { adapter, bin, dirs } of cases) {
    it(`${bin}: config dir present, no binary → not available`, async () => {
      for (const d of dirs) mkdirSync(join(home, ...d), { recursive: true });
      const a = await adapter.availability(ctxWith(() => false));
      expect(a).toEqual({ available: false, detail: `${bin} install not found` });
    });

    it(`${bin}: binary on PATH → available, whatever the config dir`, async () => {
      const a = await adapter.availability(ctxWith((cmd) => cmd === bin));
      expect(a).toEqual({ available: true, detail: `${bin} on PATH (${bin})` });
    });
  }
});
