import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PGlite is a test double, never a runtime dependency (ADR 479 §1). The built server may carry ONE
 * lazy `import('@electric-sql/pglite')` — inside `db/pgliteDriver.js`, reached only by tests and
 * plan-1B tooling — and no static import or require of the package anywhere.
 */
describe('the built server never imports pglite', () => {
  const dist = new URL('../../dist', import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
    );

  it('no dist file statically imports or requires @electric-sql/pglite', () => {
    if (!existsSync(dist)) return; // a test-only checkout; the CI leaf builds first
    const offenders = walk(dist).filter((f) =>
      /(^|\n)\s*import\b[^;]*from\s+['"]@electric-sql\/pglite['"]|require\(\s*['"]@electric-sql\/pglite['"]\s*\)/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('the only lazy import of pglite is the test double itself', () => {
    if (!existsSync(dist)) return;
    const lazy = walk(dist)
      .filter((f) => /import\(\s*['"]@electric-sql\/pglite['"]\s*\)/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(dist, f));
    expect(lazy).toEqual([join('db', 'pgliteDriver.js')]);
  });
});
