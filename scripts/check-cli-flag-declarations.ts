/*
 * Check that every CLI command that DECLARES its flags declares all of them (lane
 * `01M5D907S74XVT5YECNWB5VW5A`).
 *
 *   pnpm cli-flags:check   — fail (exit 1) when a command reads a flag it did not declare
 *
 * Why a CHECKER and not a generator: the declaration is CODE — it sits next to the reads it
 * covers, and a command's shape is its own to know. What we enforce is the one relation that
 * cannot be left to memory: a command that reads `--urgent-reason` but forgot to declare it
 * would REFUSE a flag that used to work — the user is right and the CLI is wrong. So the check
 * fails at the moment of the change, not in the field.
 *
 * The convention: a command file declares its flags in an exported const whose name ends in
 * `_FLAGS` and whose value is an array of string literals. The global flags every command
 * inherits (the booleans, `args`, `server`, `team`, `as`, `meta`) are read out of
 * `packages/cli/src/args.ts` — the same list the CLI refuses against — so the check cannot
 * disagree with the parser about what is global.
 *
 * Coverage rule: only files that DECLARE are checked. A command that has not adopted the
 * declaration yet is simply not covered — adoption is incremental, and the check never fails
 * for a file that has opted out. A file that reads a flag DYNAMICALLY (`flags[name]`) cannot be
 * proven complete by a scan, so it is reported, not failed: the names it reads are the ones a
 * scan cannot see.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const CLI_SRC = join(repoRoot, 'packages', 'cli', 'src');
const ARGS_TS = join(CLI_SRC, 'args.ts');

/** Every `.ts` file under a directory, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The global flags every command inherits, read out of the parser's own source so the check
 * and the refusal cannot disagree. Throws if the source stops looking the way we expect —
 * a checker that cannot read its input must fail loudly, not pass quietly.
 */
function globalFlags(): Set<string> {
  const src = readFileSync(ARGS_TS, 'utf-8');
  const names = new Set<string>();
  const collect = (label: string): string[] => {
    const at = src.indexOf(label);
    if (at < 0)
      throw new Error(`cli-flags:check cannot find ${label} in args.ts — the shape changed`);
    const open = src.indexOf('[', at);
    const close = src.indexOf(']', open);
    if (open < 0 || close < 0)
      throw new Error(`cli-flags:check cannot read the list after ${label}`);
    return [...src.slice(open + 1, close).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!);
  };
  for (const n of collect('const BOOLEAN_FLAGS')) names.add(n);
  for (const n of collect('const DASH_VALUED_FLAGS')) names.add(n);
  for (const n of collect('export const GLOBAL_FLAGS')) names.add(n);
  return names;
}

/** The flags a file READS, by the shapes the CLI reads flags in. */
function readsFlags(src: string): Set<string> {
  const found = new Set<string>();
  const patterns = [
    /flagStr\(\s*[^,]+,\s*'([a-z0-9-]+)'/g,
    /flagBool\(\s*[^,]+,\s*'([a-z0-9-]+)'/g,
    /\.flags\['([a-z0-9-]+)'\]/g,
    /\.flags\.([a-z][a-zA-Z0-9]*)/g,
    /(?<![.\w])flags\['([a-z0-9-]+)'\]/g,
    /(?<![.\w])flags\.([a-z][a-zA-Z0-9]*)/g,
    // A helper that takes the flags and a name: `flagStr(flags, 'x')`, `list(parsed.flags, 'x')`.
    // The first argument is the flags and the second is the flag's name, whatever the helper is
    // called — a local `list(flags, name)` reads a flag exactly as `flagStr` does.
    /\.flags\s*,\s*'([a-z0-9-]+)'/g,
  ];
  for (const p of patterns) for (const m of src.matchAll(p)) found.add(m[1]!);
  return found;
}

/** The flags a file DECLARES: every exported `<NAME>_FLAGS` array of string literals. */
function declaresFlags(src: string): Set<string> {
  const found = new Set<string>();
  const decl = /export const [A-Z0-9_]*_FLAGS[^=]*=\s*\[([^\]]*)\]/g;
  for (const m of src.matchAll(decl)) {
    // A list of plain flag names, not a list of objects (the help catalog's GLOBAL_FLAGS is
    // objects — a different thing, and not a command's declaration).
    if (m[1]!.includes('{')) continue;
    for (const lit of m[1]!.matchAll(/'([a-z0-9-]+)'/g)) found.add(lit[1]!);
  }
  return found;
}

/** A file that reads a flag by a computed name: the scan cannot see what it reads. */
function readsDynamically(src: string): boolean {
  return /(?<![.\w])flags\[[^'"][^\]]*\]/.test(src) || /\.flags\[[^'"][^\]]*\]/.test(src);
}

const globals = globalFlags();
const problems: string[] = [];
const dynamic: string[] = [];
let declaredFiles = 0;
let declaredFlags = 0;

for (const file of walk(CLI_SRC)) {
  const rel = relative(repoRoot, file);
  if (rel.endsWith('.test.ts')) continue; // a test builds flags by hand; it is not a command
  if (file === ARGS_TS) continue; // the parser itself: it holds the global list, not a command's
  const src = readFileSync(file, 'utf-8');
  const declared = declaresFlags(src);
  if (declared.size === 0) continue;
  declaredFiles++;
  declaredFlags += declared.size;
  if (readsDynamically(src)) dynamic.push(rel);
  const read = readsFlags(src);
  for (const name of read) {
    if (declared.has(name) || globals.has(name)) continue;
    problems.push(`${rel}: reads --${name} but does not declare it`);
  }
}

if (problems.length) {
  console.error('✗ cli-flags:check — a command reads a flag it does not declare:');
  for (const p of problems) console.error(`    ${p}`);
  console.error('  (the refusal would break a flag that works today)');
  process.exit(1);
}

console.log(
  `✓ cli-flags:check — ${declaredFiles} command file(s) declare their flags, all complete`,
);
if (dynamic.length) {
  console.log(`  ⚠ read dynamically, so a scan cannot prove them complete: ${dynamic.join(', ')}`);
}
console.log(
  `  ${declaredFlags} declared flag(s); ${globals.size} global flag(s) inherited by every command`,
);
