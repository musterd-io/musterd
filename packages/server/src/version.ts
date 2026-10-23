import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This daemon's release version: `@musterd/server`'s own `package.json`, found by walking up from this
 * module (the bundle at `dist/index.js` and `src/` under vitest sit at different depths, the same
 * reason the MCP adapter walks). The CLI, adapter, protocol and server share one number, so this is
 * the number a viewer calls "the musterd version". `undefined` when no package.json is found —
 * observability never crashes the daemon.
 */
export const RELEASE_VERSION: string | undefined = (() => {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const file = join(dir, 'package.json');
      if (existsSync(file)) {
        const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
        return typeof v === 'string' && v ? v : undefined;
      }
      const up = dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
    return undefined;
  } catch {
    return undefined;
  }
})();
