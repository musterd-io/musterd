/**
 * The claims-ledger hard gate (ADR 505 §7). In `format:check`.
 *
 *   pnpm ledger:check            — fail (exit 1) when this change falsifies a claim and mints no entry
 *   pnpm ledger:check --base X   — compare against another ref (default: merge-base with origin/main)
 *
 * The ledger (`docs/claims/`, ADR 294) is written by whoever makes a correction, riding the act they
 * are already performing — and it went quiet: 28 entries in August 2026, 2 in September, 0 in
 * October, while corrections kept landing as wiki rewrites and ADR notes. A reminder is what it
 * had. This gate looks at the three places a falsification is VISIBLE in a diff and refuses the
 * change unless the same diff mints an entry — or says, in so many words, that it is not one:
 *
 *   1. a wiki claim struck or rewritten — a line carrying `<!-- claim: … -->` at the base ref
 *      that is no longer in the page verbatim (wiki rule 4: corrections invalidate-date, so a
 *      claim that merely gains a dated note keeps its line and passes);
 *   2. an ADR `## Consequences` note that overturns a premise — an ADDED line in that section
 *      matching the overturn phrase list below (hand-kept, like `intents.ts`: a floor, not an
 *      inventory);
 *   3. a supersession — an ADR whose `Status:` becomes `superseded`, or a new `- Supersedes:` line.
 *
 * The escape hatch is one explicit line, `not-a-falsification: <why>`, in the PR body (read from
 * the pull_request event in CI) or in any commit message on the branch (what runs locally; a
 * squash-merge carries the PR body into the commit, so the line survives to `main` either way and
 * `git log --grep` can count them — the gate's own falsifier in ADR 505 is a month in which those
 * lines outnumber entries).
 *
 * A new entry is also checked for shape: the required frontmatter keys, and — the traceback ADR
 * 505 §7 adds — an optional `passed_by:` list whose rows name what let the claim through
 * (`acceptance`, `concession`, `dependency`), each with a reference.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adrStatus } from './adr-status.ts';
import { MARKER_RE, stripMarker } from './wiki-claim-marker.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

export const WIKI_PATH = /^docs\/wiki\/(?!INDEX\.md$|README\.md$).*\.md$/;
export const ADR_PATH = /^docs\/decisions\/\d{3}-.*\.md$/;
export const ENTRY_PATH = /^docs\/claims\/entries\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

/** An added Consequences line that says a decision's premise fell. Hand-kept; widen on a miss. */
export const OVERTURN_RE =
  /\b(?:overturn(?:ed|s)?|falsified|was wrong|were wrong|no longer holds?|does not hold|did not hold|reversed|retract(?:ed|s|ion)?|invalidat(?:ed|es)|turned out (?:to be )?(?:wrong|false)|the premise (?:was|is) (?:wrong|false))\b/i;

/** `not-a-falsification: <reason>` — the reason must carry a letter, not punctuation. */
export const ESCAPE_RE = /^\s*not-a-falsification:\s*(.+?)\s*$/im;

const REQUIRED_ENTRY_KEYS = [
  'claim',
  'claimant',
  'claim_ref',
  'claim_class',
  'claimed_at',
  'falsified_at',
  'detection_channel',
  'corrector',
  'correction_ref',
  'status',
  'falsifier',
] as const;

export const PASSED_BY_KINDS = ['acceptance', 'concession', 'dependency'] as const;

/** The claim lines of one wiki page: every line carrying a marker, marker stripped. */
export function claimLines(page: string): string[] {
  return page
    .split('\n')
    .filter((l) => MARKER_RE.test(l))
    .map((l) => stripMarker(l).trim());
}

/**
 * Trigger 1 — a claim present at base and no longer present verbatim. Only pages that exist on
 * both sides: a page deleted wholesale is archive work (docs/wiki/archive.md), not a correction.
 */
export function struckWikiClaims(base: Map<string, string>, head: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [name, before] of base) {
    const after = head.get(name);
    if (after === undefined) continue;
    const afterLines = new Set(after.split('\n').map((l) => stripMarker(l).trim()));
    for (const claim of claimLines(before)) {
      if (!afterLines.has(claim))
        out.push(`${name} — claim struck or rewritten: "${claim.slice(0, 90)}"`);
    }
  }
  return out;
}

/** Lines of the `## Consequences` section (up to the next `## `), or [] when there is none. */
export function consequencesLines(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Consequences\b/.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    out.push(line);
  }
  return out;
}

/** Trigger 2 — Consequences lines ADDED by this change that read as an overturn. */
export function overturningNotes(name: string, base: string | null, head: string): string[] {
  const before = new Set(base ? consequencesLines(base).map((l) => l.trim()) : []);
  const out: string[] = [];
  for (const line of consequencesLines(head)) {
    const t = line.trim();
    if (!t || before.has(t)) continue;
    if (OVERTURN_RE.test(t))
      out.push(`${name} — Consequences note overturns a premise: "${t.slice(0, 90)}"`);
  }
  return out;
}

/** Trigger 3 — a status that became `superseded`, or a `- Supersedes:` line that is new. */
export function supersessions(name: string, base: string | null, head: string): string[] {
  const out: string[] = [];
  const wasSuperseded = base !== null && adrStatus(base) === 'superseded';
  if (adrStatus(head) === 'superseded' && !wasSuperseded)
    out.push(`${name} — status became superseded`);
  const supersedesLine = (t: string) =>
    t.split('\n').find((l) => /^\s*[-*]?\s*\**Supersedes\**\s*:/i.test(l));
  if (supersedesLine(head) && !(base && supersedesLine(base)))
    out.push(`${name} — supersedes an earlier ADR`);
  return out;
}

/** The escape lines in a body of text (PR body or commit messages), reasons only. */
export function escapeReasons(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = ESCAPE_RE.exec(line);
    if (m && /\p{L}/u.test(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** Shape check for a NEW entry: required keys, and `passed_by` rows that name a kind and a ref. */
export function entryProblems(name: string, text: string): string[] {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return [`${name} — no YAML frontmatter`];
  const body = fm[1]!;
  const out: string[] = [];
  for (const key of REQUIRED_ENTRY_KEYS) {
    if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(body)) out.push(`${name} — missing \`${key}\``);
  }
  const pb = /^passed_by:\s*(.*)$/m.exec(body);
  if (pb) {
    const inline = pb[1]!.trim();
    const after = body.slice(pb.index + pb[0].length).split('\n');
    const rows: string[] = [];
    for (const l of after) {
      if (/^\s+-\s/.test(l)) rows.push(l.trim().replace(/^-\s*/, ''));
      else if (l.trim() === '') continue;
      else break;
    }
    if (inline && inline !== '[]' && rows.length === 0)
      out.push(`${name} — \`passed_by\` must be a list of rows`);
    for (const row of rows) {
      const kind = /^([a-z]+):\s*\S/.exec(row)?.[1];
      if (!kind || !(PASSED_BY_KINDS as readonly string[]).includes(kind)) {
        out.push(
          `${name} — \`passed_by\` row must be \`<acceptance|concession|dependency>: <ref>\`: "${row.slice(0, 60)}"`,
        );
      }
    }
  }
  return out;
}

export interface Verdict {
  triggers: string[];
  entries: string[];
  escapes: string[];
  problems: string[];
  ok: boolean;
}

/** The decision, given everything the diff showed. */
export function judge(
  triggers: string[],
  entries: string[],
  escapes: string[],
  problems: string[],
): Verdict {
  const ok =
    problems.length === 0 && (triggers.length === 0 || entries.length > 0 || escapes.length > 0);
  return { triggers, entries, escapes, problems, ok };
}

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fileAt(ref: string, path: string): string | null {
  try {
    return git('show', `${ref}:${path}`);
  } catch {
    return null;
  }
}

function resolveBase(): string {
  const flagIdx = process.argv.indexOf('--base');
  const requested =
    (flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined) ??
    process.env['LEDGER_BASE'] ??
    'origin/main';
  try {
    return git('merge-base', 'HEAD', requested).trim();
  } catch {
    process.stderr.write(
      `✗ ledger:check — cannot resolve base ref \`${requested}\` (fetch it, or pass --base)\n`,
    );
    process.exit(1);
  }
}

/** The PR body in CI (pull_request event), else nothing — commit messages cover the local run. */
function prBody(): string {
  const p = process.env['GITHUB_EVENT_PATH'];
  if (!p || !existsSync(p)) return '';
  try {
    const ev = JSON.parse(readFileSync(p, 'utf8')) as { pull_request?: { body?: string | null } };
    return ev.pull_request?.body ?? '';
  } catch {
    return '';
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = resolveBase();
  // Base → WORKING TREE, not base → HEAD: a seat runs the fast gates before it commits (AGENTS.md),
  // and a refusal that only fires after the commit is a refusal most seats meet in CI. The head
  // side of every file below is read from disk for the same reason. (`change-adr:check` diffs
  // HEAD; its rules are about commit history, these are about the files.)
  const changed = git('diff', '--name-status', '-M', base)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status ?? '', path: rest[rest.length - 1] ?? '' };
    })
    .filter((c) => c.path);

  const triggers: string[] = [];
  const wikiBase = new Map<string, string>();
  const wikiHead = new Map<string, string>();
  for (const c of changed) {
    if (WIKI_PATH.test(c.path) && c.status !== 'A' && c.status !== 'D') {
      const b = fileAt(base, c.path);
      if (b !== null && existsSync(join(repoRoot, c.path))) {
        wikiBase.set(c.path, b);
        wikiHead.set(c.path, readFileSync(join(repoRoot, c.path), 'utf8'));
      }
    }
    if (ADR_PATH.test(c.path) && c.status !== 'D' && existsSync(join(repoRoot, c.path))) {
      const head = readFileSync(join(repoRoot, c.path), 'utf8');
      const b = c.status === 'A' ? null : fileAt(base, c.path);
      triggers.push(...overturningNotes(c.path, b, head), ...supersessions(c.path, b, head));
    }
  }
  triggers.push(...struckWikiClaims(wikiBase, wikiHead));

  const entries = changed
    .filter((c) => c.status === 'A' && ENTRY_PATH.test(c.path))
    .map((c) => c.path);
  const problems = entries.flatMap((p) =>
    existsSync(join(repoRoot, p)) ? entryProblems(p, readFileSync(join(repoRoot, p), 'utf8')) : [],
  );
  const escapes = escapeReasons(`${prBody()}\n${git('log', '--format=%B', `${base}..HEAD`)}`);
  const v = judge(triggers, entries, escapes, problems);

  if (!v.ok) {
    for (const t of v.triggers) process.stderr.write(`✗ ${t}\n`);
    for (const p of v.problems) process.stderr.write(`✗ ${p}\n`);
    if (v.triggers.length > 0 && v.entries.length === 0 && v.escapes.length === 0) {
      process.stderr.write(
        `ledger:check — this change falsifies a claim and mints no ledger entry (ADR 505 §7). Either add ` +
          `docs/claims/entries/<YYYY-MM-DD>-<slug>.md in this PR (template: docs/claims/README.md; name who ` +
          `passed the claim under \`passed_by\`), or state in the PR body or a commit message: ` +
          `\`not-a-falsification: <why>\`.\n`,
      );
    }
    process.exit(1);
  }
  const how =
    v.triggers.length === 0
      ? 'no claim struck, overturned or superseded in this change'
      : v.entries.length > 0
        ? `${v.triggers.length} falsification(s), ${v.entries.length} entry(ies) minted`
        : `${v.triggers.length} trigger(s) waved through: ${v.escapes.map((e) => `"${e}"`).join('; ')}`;
  process.stdout.write(
    `✓ ledger:check — ${how}${v.entries.length ? ` (${v.entries.length} new entry shape-checked)` : ''}\n`,
  );
}
