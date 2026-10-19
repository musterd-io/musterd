/*
 * Render the README's install section from content/install.data.ts (ADR 669 §3.3).
 *   pnpm install:gen    — rewrite the block between the GENERATED INSTALL markers in README.md
 *   pnpm install:check  — exit 1 if that block is out of date
 * The site reads the same module at its build-prep (packages/web/scripts/gen-site-content.ts), so
 * the README and musterd.io cannot disagree about how to install.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMarkdown } from '../content/install.data.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(root, 'README.md');
export const BEGIN =
  '<!-- GENERATED INSTALL: edit content/install.data.ts, then pnpm install:gen -->';
export const END = '<!-- /GENERATED INSTALL -->';

/** README with its install block replaced by the current render. Throws if the markers are missing. */
export function renderReadme(readme: string): string {
  const a = readme.indexOf(BEGIN);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error(`README.md must carry the ${BEGIN} … ${END} markers`);
  return `${readme.slice(0, a + BEGIN.length)}\n${installMarkdown()}\n${readme.slice(b)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const current = readFileSync(README, 'utf8');
  const next = renderReadme(current);
  if (process.argv.includes('--check')) {
    if (current !== next) {
      process.stderr.write(
        'install:check — README.md install block is stale; run pnpm install:gen\n',
      );
      process.exit(1);
    }
    process.stdout.write(
      '✓ install:check — README.md install block matches content/install.data.ts\n',
    );
  } else {
    writeFileSync(README, next);
    process.stdout.write('install:gen — README.md install block written\n');
  }
}
