/*
 * The surfaces `intents:check` scans.
 *
 * Two corpora, on purpose. The phrase check reads ADR 373's three surfaces and no more: the open
 * ADR 373 watch (`docs/watches/2026-09-14-adr-373-follows-up-advances-successor.md`) voids if they
 * move inside its window. ADR 487's structural rule reads the wider set — specs, plans and design
 * docs are where increment tables live.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ForwardReference,
  type IncrementItem,
  findForwardReferences,
  findIncrementItems,
} from './intents.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..');

/** The scanned surfaces, in the order ADR 373 names them. */
const SURFACES = [
  { dir: join(repoRoot, 'docs', 'decisions'), ext: '.md' },
  { dir: join(repoRoot, 'docs', 'wiki'), ext: '.md' },
] as const;
const ROADMAP = join(repoRoot, 'content', 'roadmap.data.ts');

/** ADR 487 Decision 5: where a plan's Increments/Phases sections live. The roadmap is generated
 *  from typed data and has no headings, so it is not on this list. */
const INCREMENT_SURFACES = [
  join(repoRoot, 'docs', 'decisions'),
  join(repoRoot, 'docs', 'superpowers', 'specs'),
  join(repoRoot, 'docs', 'superpowers', 'plans'),
  join(repoRoot, 'docs', 'design'),
  join(repoRoot, 'docs', 'wiki'),
] as const;

function filesUnder(dir: string, ext: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, ext));
    else if (name.endsWith(ext)) out.push(full);
  }
  return out.sort();
}

export function collectForwardReferences(): ForwardReference[] {
  const refs: ForwardReference[] = [];
  for (const { dir, ext } of SURFACES) {
    for (const file of filesUnder(dir, ext)) {
      refs.push(...findForwardReferences(relative(repoRoot, file), readFileSync(file, 'utf8')));
    }
  }
  try {
    refs.push(...findForwardReferences(relative(repoRoot, ROADMAP), readFileSync(ROADMAP, 'utf8')));
  } catch {
    // The roadmap module is the one named file rather than a glob; if it moves, the arch-trees and
    // roadmap gates say so far more loudly than this one would.
  }
  return refs;
}

export function collectIncrementItems(): IncrementItem[] {
  const items: IncrementItem[] = [];
  for (const dir of INCREMENT_SURFACES) {
    for (const file of filesUnder(dir, '.md')) {
      items.push(...findIncrementItems(relative(repoRoot, file), readFileSync(file, 'utf8')));
    }
  }
  return items;
}
