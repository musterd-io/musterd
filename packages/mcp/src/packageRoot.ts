import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This package's root (the directory holding `packages/mcp/package.json`), found by walking up from
 * the caller's `import.meta.url` (ADR 574). A fixed count of `..` was right for exactly one layout:
 * the launched adapter is a bundle at `dist/index.js` and the library is `tsc` output under
 * `dist/lib/`, so one module sits at three different depths across `src/`, `dist/lib/` and the
 * bundle. The walk is depth-blind. `undefined` when no `package.json` is found within the bound.
 */
export function packageRoot(metaUrl: string): string | undefined {
  try {
    let dir = dirname(fileURLToPath(metaUrl));
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      const up = dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
