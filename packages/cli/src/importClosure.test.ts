import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

/** `import … from '…'` / `export … from '…'`, skipping `import type` / `export type`. */
const FROM_RE = /^\s*(?:import|export)\s+(?!type[\s{])[^'";]*?\sfrom\s*['"]([^'"]+)['"]/gm;
/** `import '…'` (side effect). A dynamic `import('…')` matches neither — it is not static. */
const SIDE_EFFECT_RE = /^\s*import\s*['"]([^'"]+)['"]/gm;

/**
 * The static import closure of a source file (ADR 491): every local `.ts` file it loads before
 * its first line runs, and every bare package. `node:` builtins are ignored. `@musterd/*` keeps
 * its subpath, because a subpath like `@musterd/protocol/build-stamp` is light where the root is not.
 */
export function staticClosure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, 'utf8');
    const specs = [...text.matchAll(FROM_RE), ...text.matchAll(SIDE_EFFECT_RE)].map((m) => m[1]!);
    for (const spec of specs) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec).replace(/\.js$/, '.ts');
        if (!existsSync(target)) throw new Error(`${file}: unresolved import ${spec}`);
        queue.push(target);
        continue;
      }
      const parts = spec.split('/');
      packages.add(
        spec.startsWith('@musterd/')
          ? spec
          : spec.startsWith('@')
            ? parts.slice(0, 2).join('/')
            : parts[0]!,
      );
    }
  }
  return { files, packages };
}

const rel = (files: Set<string>) => [...files].map((f) => f.slice(SRC.length + 1)).sort();

describe('static import closures (ADR 491)', () => {
  it('bin.ts loads no command, client, config, telemetry or protocol root before it runs', () => {
    const { files, packages } = staticClosure(join(SRC, 'bin.ts'));
    expect(rel(files).filter((f) => f.startsWith('commands/'))).toEqual([]);
    expect(rel(files)).not.toContain('client.ts');
    expect(rel(files)).not.toContain('config.ts');
    expect([...packages].sort()).toEqual(['@musterd/protocol/build-stamp', 'picocolors']);
  });
});
