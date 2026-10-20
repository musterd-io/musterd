import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMainModule } from './isMain.js';

describe('isMainModule', () => {
  let dir: string;
  let real: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-ismain-'));
    real = join(dir, 'index.js');
    writeFileSync(real, '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is true when launched by the file itself', () => {
    expect(isMainModule(pathToFileURL(real).href, real)).toBe(true);
  });

  it('is true when launched through a bin symlink (npm i -g, npx)', () => {
    const bin = join(dir, 'musterd-mcp');
    symlinkSync(real, bin);
    expect(isMainModule(pathToFileURL(real).href, bin)).toBe(true);
  });

  it('is false when another file is the entry, or there is none', () => {
    const other = join(dir, 'bench.mjs');
    writeFileSync(other, '');
    expect(isMainModule(pathToFileURL(real).href, other)).toBe(false);
    expect(isMainModule(pathToFileURL(real).href, undefined)).toBe(false);
    expect(isMainModule(pathToFileURL(real).href, join(dir, 'missing.js'))).toBe(false);
  });
});
