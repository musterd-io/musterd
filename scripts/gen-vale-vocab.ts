/*
 * Generate Vale's vocabulary for musterd from the glossary, docs/glossary/terms.ts (ADR 579
 * decision 1). The glossary stays the single source; these two files are its rendering for Vale.
 *
 *   pnpm prose-vocab:gen     — rewrite accept.txt and reject.txt
 *   pnpm prose-vocab:check   — fail (exit 1) if either file is out of date
 *
 * accept.txt: `musterd` as written (lowercase, brand.md §1), and every canonical term, any case.
 * reject.txt: the banned terms only. ADR 579 decision 1 put the whole Not column here; its trial
 * found 1 of 50 sampled hits was a real misuse, because the Not column bans a word in one sense
 * ("session" meaning a Presence) and Vale matches the word in every sense. The Not column stays
 * a review check (brand.md §5).
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOSSARY } from '../docs/glossary/terms.ts';

const here = dirname(fileURLToPath(import.meta.url));
const VOCAB_DIR = join(here, '..', '.github', 'styles', 'config', 'vocabularies', 'musterd');

export function vocab(): { accept: string[]; reject: string[] } {
  const canonical = GLOSSARY.filter((t) => t.status === 'canonical').map((t) => t.term);
  const accept = ['musterd', ...canonical.map((t) => `(?i)${t}`)];
  const reject = GLOSSARY.filter((t) => t.status === 'banned')
    .map((t) => t.term)
    .sort();
  return { accept, reject };
}

function render(lines: string[]): string {
  // Vale reads every line as an entry, so the files carry no header; the README beside them says
  // they are generated.
  return lines.join('\n') + '\n';
}

const { accept, reject } = vocab();
const files: Array<[string, string]> = [
  [join(VOCAB_DIR, 'accept.txt'), render(accept)],
  [join(VOCAB_DIR, 'reject.txt'), render(reject)],
  [
    join(VOCAB_DIR, 'README.md'),
    '# The musterd vocabulary for Vale\n\n`accept.txt` and `reject.txt` are generated from `docs/glossary/terms.ts` by\n' +
      '`scripts/gen-vale-vocab.ts` (ADR 579). Edit the glossary, then run `pnpm prose-vocab:gen`.\n',
  ],
];

if (process.argv.includes('--check')) {
  const stale = files.filter(([path, want]) => {
    try {
      return readFileSync(path, 'utf8') !== want;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    for (const [path] of stale)
      console.error(`✗ ${path} is out of date with docs/glossary/terms.ts`);
    console.error('  run: pnpm prose-vocab:gen');
    process.exit(1);
  }
  console.log('✓ prose-vocab:check — Vale vocabulary matches docs/glossary/terms.ts');
} else {
  mkdirSync(VOCAB_DIR, { recursive: true });
  for (const [path, body] of files) writeFileSync(path, body);
  console.log(`wrote ${files.length} files to ${VOCAB_DIR}`);
}
