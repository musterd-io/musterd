import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from './packageRoot.js';

/**
 * The adapter's own package version, read from `package.json` at load so MCP `serverInfo.version`
 * can never drift from the published package (ADR 175 — a hardcoded literal sat at 0.2.0 while the
 * package shipped 0.3.1). Found by walking up to the package root (ADR 574), which works from `src/`
 * under vitest, from the `dist/lib/` library and from the `dist/index.js` bundle alike. Degrades
 * to '0.0.0' rather than throw: version reporting is observability, and observability never
 * crashes the adapter (the ADR 135 posture).
 */
export const ADAPTER_VERSION: string = (() => {
  try {
    const root = packageRoot(import.meta.url);
    if (!root) return '0.0.0';
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
