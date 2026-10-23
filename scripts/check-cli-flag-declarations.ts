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
 * A command's known flags are its OWN reads and the reads of the HELPERS it calls: `musterd
 * team --prose` is read inside `commands/policy.ts`, not in `commands/team.ts`. So the check
 * follows the command's own imports, one level. (Transitive closure would pull in the whole
 * client and over-accept; one level is where a command's flag vocabulary actually lives.)
 *
 * Coverage rule: only files that DECLARE are checked. A command that has not adopted the
 * declaration yet is simply not covered — adoption is incremental, and the check never fails
 * for a file that has not opted out. A file that reads a flag DYNAMICALLY (`flags[name]`) cannot
 * be proven complete by a scan, so it is reported, not failed: the names it reads are the ones a
 * scan cannot see.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
export function globalFlags(): Set<string> {
  const src = readFileSync(ARGS_TS, 'utf-8');
  const names = new Set<string>();
  const collect = (label: string): string[] => {
    const at = src.indexOf(label);
    if (at < 0)
      throw new Error(`cli-flags:check cannot find ${label} in args.ts — the shape changed`);
    // The '=' first: a type annotation carries its own brackets (`readonly string[]`), and
    // reading from the label would take that one instead of the array's.
    const eq = src.indexOf('=', at);
    const open = src.indexOf('[', eq);
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
export function readsFlags(src: string): Set<string> {
  const found = new Set<string>();
  const patterns = [
    // A flag helper takes the flags and a name: `flagStr(flags, 'x')`, `flagHue(flags, 'x')`.
    /flag[A-Za-z]*\(\s*[^,]+,\s*'([a-z0-9-]+)'/g,
    // A helper that takes the flags and a name: `flagStr(flags, 'x')`, `list(parsed.flags, 'x')`.
    // The first argument is the flags and the second is the flag's name, whatever the helper is
    // called — a local `list(flags, name)` reads a flag exactly as `flagStr` does.
    /\.flags\s*,\s*'([a-z0-9-]+)'/g,
    // A helper that takes the whole parsed object and a name: `parseSeconds(parsed, 'settle')`.
    /\b\w+\(\s*parsed\s*,\s*'([a-z0-9-]+)'/g,
    // A helper that takes ONLY the name, because it closes over the flags: `intFlag('uses')`,
    // `onOff('deliver', current)`.
    /\b\w+\(\s*'([a-z0-9-]+)'\s*[,)]/g,
    // A list of names, read in a loop: `['title', 'date', 'kind'] as const`.
    /\[\s*'([a-z0-9-]+)'(?:\s*,\s*'([a-z0-9-]+)')*\s*\]/g,
    /\.flags\['([a-z0-9-]+)'\]/g,
    /\.flags\.([a-z][a-zA-Z0-9]*)/g,
    /(?<![.\w])flags\['([a-z0-9-]+)'\]/g,
    /(?<![.\w])flags\.([a-z][a-zA-Z0-9]*)/g,
  ];
  for (const p of patterns) {
    for (const m of src.matchAll(p)) {
      found.add(m[1]!);
      if (m[2]) found.add(m[2]!);
    }
  }
  return found;
}

/** The flags a file DECLARES: every exported `<NAME>_FLAGS` array of string literals. */
export function declaresFlags(src: string): Set<string> {
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

/** The modules a file imports, relative to the CLI source tree. */
function imports(file: string): string[] {
  const src = readFileSync(file, 'utf-8');
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = resolve(dirname(file), m[1]!).replace(/\.js$/, '.ts');
    if (target.startsWith(CLI_SRC) && statSync(target).isFile()) out.push(target);
  }
  return out;
}

/** The names a file imports from its own modules. */
function importedNames(file: string): string[] {
  const src = readFileSync(file, 'utf-8');
  const out: string[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.[^']+'/g)) {
    for (const part of m[1]!.split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * The body of one exported function in a file: from its opening brace to the next top-level
 * `}`. A heuristic, and it is honest about being one — it is used to answer "which flags does
 * the helper I call read", and a helper's own local helpers are followed one more level.
 */
export function functionBody(src: string, name: string): string {
  const brace = bodyBrace(src, name);
  if (brace < 0) return '';
  const end = src.indexOf('\n}', brace);
  return end < 0 ? src.slice(brace) : src.slice(brace, end);
}

/** The index of the brace that opens a function's BODY — not a default value's braces. */
export function bodyBrace(src: string, name: string): number {
  const decl = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(|(?:export\\s+)?const\\s+${name}\\s*=`,
  );
  const at = src.search(decl);
  if (at < 0) return -1;
  // The parameters' closing ')' — balanced, so a default value with brackets does not fool it.
  let depth = 0;
  let i = src.indexOf('(', at);
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  // A return type may carry its own braces (`): { read_verdict?: … } {`), so walk it out by
  // depth before taking the brace that starts the BODY.
  let j = i + 1;
  while (j < src.length && /\s/.test(src[j]!)) j++;
  if (src[j] === ':') {
    j++;
    while (j < src.length && /\s/.test(src[j]!)) j++;
    if (src[j] === '{') {
      // The return type is an object type: walk to ITS closing brace, not the body's.
      let braces = 0;
      for (; j < src.length; j++) {
        const ch = src[j]!;
        if (ch === '{') braces++;
        else if (ch === '}') {
          braces--;
          if (braces === 0) {
            j++;
            break;
          }
        }
      }
    }
    while (j < src.length && /[\s=>]/.test(src[j]!)) j++;
  }
  const brace = src.indexOf('{', j);
  if (brace < 0 || brace < j - 1) return -1;
  return brace;
}

/**
 * The flags a command reads through the helpers it CALLS: `musterd team --prose` is read
 * inside `commands/policy.ts`, not in `commands/team.ts`.
 *
 * The follow is by FUNCTION, not by file: a command that calls one helper from a module
 * inherits that helper's flags, not the whole module's vocabulary. The helper's own local
 * helpers are followed one level more, because a local helper reads a flag exactly as the
 * exported one does.
 */
export function followFlags(file: string): Set<string> {
  const out = new Set<string>();
  for (const helper of imports(file)) {
    const hsrc = readFileSync(helper, 'utf-8');
    const names = importedNames(file).filter((n) => new RegExp(`\\b${n}\\b`).test(hsrc));
    for (const name of names) {
      const body = functionBody(hsrc, name);
      for (const flag of readsFlags(body)) out.add(flag);
      // The helper's local helpers: a local `list(flags, name)` reads a flag as the exported
      // function does, and the call is inside the body.
      for (const call of body.matchAll(/(?<![.\w])([a-z][a-zA-Z0-9]*)\s*\(/g)) {
        const local = call[1]!;
        if (names.includes(local)) continue;
        const localBody = functionBody(hsrc, local);
        if (!localBody) continue;
        for (const flag of readsFlags(localBody)) out.add(flag);
      }
    }
  }
  return out;
}

/**
 * Whether a caller hands its shared Parsed argv to an exported command. Ordinary helper calls
 * can contain words such as `usage` or `stream` in data without transferring CLI vocabulary.
 */
export function forwardsParsedCommand(caller: string, callee: string, name: string): boolean {
  const calledWithParsed = new RegExp(`(?<![.\\w])${name}\\s*\\(\\s*parsed\\s*(?=,|\\))`).test(
    caller,
  );
  if (!calledWithParsed) return false;

  const functionDeclaration = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)`,
  ).exec(callee);
  const constDeclaration = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)`,
  ).exec(callee);
  const params = functionDeclaration?.[1] ?? constDeclaration?.[1];
  return params !== undefined && /^\s*parsed\s*:\s*Parsed\b/.test(params);
}

/** The flags a file's whole module reads — the follow, at file granularity. */
export function moduleFlags(file: string): Set<string> {
  const out = new Set<string>();
  for (const helper of imports(file)) {
    for (const flag of readsFlags(readFileSync(helper, 'utf-8'))) out.add(flag);
  }
  return out;
}

export const globals = globalFlags();

/**
 * The flags each declaring command MUST know, to a fixpoint.
 *
 * A command's own vocabulary is its reads plus the helpers it calls. But one command can hand
 * the SAME parsed flags to another command's entry — `musterd inbox --waiting` calls
 * `waitingCommand`, which calls `nudgeCommand`, whose refusal would reject `--waiting` if
 * nudge did not know it. So for every edge "F calls something G exports", G must know F's
 * flags too. The fixpoint runs until the sets stop growing.
 */
export function requiredByFile(): Map<string, Set<string>> {
  const files = walk(CLI_SRC).filter((f) => !f.endsWith('.test.ts') && f !== ARGS_TS);
  const srcs = new Map<string, string>();
  for (const f of files) srcs.set(f, readFileSync(f, 'utf-8'));
  const required = new Map<string, Set<string>>();
  // Every command file, declaring or not: a file that has not adopted the declaration yet can
  // still hand its flags to one that has, and the fixpoint must see that edge.
  for (const f of files) {
    const src = srcs.get(f)!;
    const set = new Set<string>();
    for (const n of readsFlags(src)) if (!globals.has(n)) set.add(n);
    for (const n of followFlags(f)) if (!globals.has(n)) set.add(n);
    required.set(f, set);
  }
  // Edges: F imports G (both declare) and forwards its Parsed argv to G's command.
  const exportsOf = (src: string): string[] =>
    [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)].map((m) => m[1]!);
  const edges: Array<[string, string]> = [];
  for (const f of required.keys()) {
    const src = srcs.get(f)!;
    for (const g of imports(f)) {
      if (!required.has(g) || g === f) continue;
      const gExports = exportsOf(srcs.get(g)!);
      for (const name of importedNames(f)) {
        if (gExports.includes(name) && forwardsParsedCommand(src, srcs.get(g)!, name))
          edges.push([f, g]);
      }
    }
  }
  for (let round = 0; round < 20; round++) {
    let changed = false;
    for (const [f, g] of edges) {
      for (const n of required.get(f)!) {
        const rg = required.get(g)!;
        if (!rg.has(n)) {
          rg.add(n);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return required;
}

/** The check itself: run when this file is invoked, not when it is imported. */
export function checkCliFlagDeclarations(): void {
  const problems: string[] = [];
  const dynamic: string[] = [];
  const loose: string[] = [];
  let declaredFiles = 0;
  let declaredFlags = 0;
  const required = requiredByFile();

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
    // A command's known flags: its own reads, the helpers it calls, and every command that can
    // hand it the same parsed flags (requiredByFile's fixpoint).
    const read = required.get(file) ?? new Set<string>();
    const extra = new Set<string>();
    for (const name of moduleFlags(file)) {
      if (!read.has(name) && !declared.has(name) && !globals.has(name)) extra.add(name);
    }
    if (extra.size) {
      // The follow is by function, so a module's OTHER functions' flags are not this command's.
      // They are reported rather than required: a human reads the list and says yes or no.
      loose.push(
        `${rel}: not required (another function in a module it calls reads it): ${[...extra].sort().join(' ')}`,
      );
    }
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
    console.log(
      `  ⚠ read dynamically, so a scan cannot prove them complete: ${dynamic.join(', ')}`,
    );
  }
  if (loose.length) {
    console.log('  ⚠ read by ANOTHER function in a module this command calls — not required here:');
    for (const l of loose) console.log(`      ${l}`);
  }
  console.log(
    `  ${declaredFlags} declared flag(s); ${globals.size} global flag(s) inherited by every command`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkCliFlagDeclarations();
}
