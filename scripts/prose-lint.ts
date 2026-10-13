/*
 * Prose linting with Vale (ADR 579 decision 1).
 *
 *   pnpm prose:lint                 — lint README.md, docs/wiki and docs/design
 *   pnpm prose:lint <paths…>        — lint the paths given (files or folders)
 *
 * Vale is a per-machine binary, never a dependency (`brew install vale`). Without it this prints
 * the install line and exits 0, so a missing binary never blocks anyone. The packages are pinned in
 * .vale.ini and synced into .github/styles on first use. Not part of CI: whether CI runs it is
 * decided by the trial recorded in ADR 579's Consequences.
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PINNED = '3.24.0';
const DEFAULT_PATHS = ['README.md', 'docs/wiki', 'docs/design'];

const version = spawnSync('vale', ['--version'], { cwd: root, encoding: 'utf8' });
if (version.error) {
  console.log(`prose:lint — Vale is not installed, so nothing was linted.`);
  console.log(`  Install it (ADR 579 pins ${PINNED}): brew install vale`);
  console.log('  Other platforms: https://vale.sh/docs/install');
  process.exit(0);
}
const found = /(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1];
if (found !== PINNED) {
  console.log(
    `prose:lint — Vale ${found ?? '(unknown)'} found; ADR 579 pins ${PINNED}. Results may differ.`,
  );
}

if (!existsSync(join(root, '.github', 'styles', 'A11y'))) {
  const sync = spawnSync('vale', ['sync'], { cwd: root, stdio: 'inherit' });
  if (sync.status !== 0) process.exit(sync.status ?? 1);
}

const args = process.argv.slice(2);
const run = spawnSync('vale', args.length ? args : DEFAULT_PATHS, { cwd: root, stdio: 'inherit' });
process.exit(run.status ?? 1);
