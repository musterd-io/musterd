/*
 * Enforce the standing-context byte budgets (spec 2026-08-03).
 *
 *   pnpm context:check   — fail (exit 1) when any injected surface exceeds docs/perf/context-budgets.json
 *
 * The standing context is every byte musterd injects into a seat's context window: the tools/list
 * render (per role), the AGENTS.md primer block, and the hook nudge texts. ADR 144 measured and
 * trimmed the first; nothing gated the rest, and per-turn text (the UserPromptSubmit nudge)
 * multiplies exactly like tool schemas do. This gate is the ADR 151 pattern applied to context:
 * budgets with headroom, a raise protocol (changing a budget requires replacing its
 * `justification`), loud failure, no skipped line items.
 *
 * Static by design: everything here is measured from source-of-truth exports — the in-memory
 * tools/list render (`measureToolSurface`), the rendered primer, and the exported hook text
 * constants. Dynamic hook output (init-check, label nudge) is report-only:
 * `node scripts/context/report.mjs`.
 *
 * Needs `pnpm build` first (imports the workspace dists; same trap as typecheck/perf:check).
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Composition, coherenceFailures } from './budgetCoherence.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

interface BudgetItem {
  budget: number;
  justification: string;
}
interface Budgets {
  note: string;
  items: Record<string, BudgetItem>;
}

const budgetsPath = join(repoRoot, 'docs', 'perf', 'context-budgets.json');
const budgets: Budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));

const distUrl = (rel: string) => pathToFileURL(join(repoRoot, rel)).href;

// Workspace dists — resolved as file URLs because the repo root has no workspace dependencies.
let measureToolSurface: (caps?: unknown) => Promise<{ bytes: number }>;
let renderRepositoryPrimer: (opts: { team: string }) => string;
let renderRuntimePrimer: (opts: { member?: string; team: string }) => string;
let GENERALIST_CAPABILITIES: Record<string, unknown>;
let HOOK_NUDGE_TEXTS: Record<string, string>;
try {
  // Straight at the measurement module, not the package root: it pulls a devDependency, so keeping
  // it out of `dist/index.js`'s runtime graph is what makes the published package loadable. The
  // library's modules live under dist/lib/ (ADR 574).
  ({ measureToolSurface } = await import(distUrl('packages/mcp/dist/lib/surfaceMeasure.js')));
  ({ renderRepositoryPrimer, renderRuntimePrimer, GENERALIST_CAPABILITIES } = await import(
    distUrl('packages/protocol/dist/index.js')
  ));
  ({ HOOK_NUDGE_TEXTS } = await import(
    distUrl('packages/cli/dist/onboard/harnesses/claudeCode.js')
  ));
} catch (err) {
  console.error(
    `context:check: failed to import the workspace dists — run \`pnpm build\` first (dist/ is gitignored, same as the typecheck trap).\n${String(err)}`,
  );
  process.exit(1);
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

const toolsDefault = (await measureToolSurface(GENERALIST_CAPABILITIES)).bytes;
const toolsMuted = (await measureToolSurface({ ...GENERALIST_CAPABILITIES, can_message: 'none' }))
  .bytes;
// A session receives the repository or runtime delivery (and some harnesses may surface both). Keep
// the existing single-primer budget honest by measuring the larger variant rather than whichever
// delivery happened to exist when the gate was introduced.
const primer = Math.max(
  bytes(renderRepositoryPrimer({ team: 'team' })),
  bytes(renderRuntimePrimer({ member: 'seat', team: 'team' })),
);
const sessionStart =
  bytes(HOOK_NUDGE_TEXTS['orientation_joined'] ?? '') +
  bytes(HOOK_NUDGE_TEXTS['orientation_wire_fix'] ?? '') +
  bytes(HOOK_NUDGE_TEXTS['orientation_init_fix'] ?? '');
// The per-prompt nudge was a part until lane 01M5N3VG2D removed it (ADR 726): the UserPromptSubmit
// hook now prints only the due-gated orient nudge, which is quiet once a session is oriented.
if (sessionStart === 0 || primer === 0 || toolsDefault === 0) {
  console.error(
    'context:check: a surface measured 0 bytes — a source of truth moved; failing loud.',
  );
  process.exit(1);
}

const parts: Record<string, number> = {
  toolsListDefaultBytes: toolsDefault,
  toolsListMutedBytes: toolsMuted,
  primerBytes: primer,
  sessionStartNudgesBytes: sessionStart,
};

/*
 * What each headline is made of, declared instead of hand-summed.
 *
 * It used to be arithmetic written out twice — once here as `toolsDefault + promptSubmit +
 * labelNudge`, and once implicitly in the budget file, where a human had to keep the composite's
 * number consistent with its parts'. They drifted, silently and in the direction that hurts: on
 * 2026-08-19 the component budgets were re-baselined and the composites were deliberately left on
 * their 2026-08-12 baseline (`perSessionTotalBytes`'s justification records the reasoning — perTurn
 * "still fit ... and per the minimal-raise precedent was not raised"). The result was a gate that
 * could not be satisfied by obeying its own per-item guidance: every component exactly at budget
 * summed to 795 B OVER the perTurn budget and 2 B over perSession. Whoever added the next word to
 * any tool description would have failed a gate that was already unsatisfiable, and read the
 * failure as their own doing.
 *
 * Declaring the composition fixes both halves: the measured total can no longer disagree with the
 * parts it claims to sum, and `coherence` below refuses a budget set where it could happen again.
 */
const COMPOSITES: Composition = {
  // The headline: what multiplies on EVERY turn of every seat session. (The due-gated label nudge
  // was a part until ADR 468 removed it with the sweep it announced; the per-prompt nudge until
  // ADR 726 made the roster read a claimed lane.)
  perTurnTotalBytes: ['toolsListDefaultBytes'],
  perSessionTotalBytes: ['toolsListDefaultBytes', 'primerBytes', 'sessionStartNudgesBytes'],
};

const sumOf = (item: string, of: Record<string, number>): number =>
  COMPOSITES[item]!.reduce((n, part) => n + (of[part] ?? 0), 0);

const measured: Record<string, number> = {
  ...parts,
  ...Object.fromEntries(Object.keys(COMPOSITES).map((c) => [c, sumOf(c, parts)])),
};

const failures: string[] = [];
const rows: string[] = [];
for (const [item, value] of Object.entries(measured)) {
  const entry = budgets.items[item];
  if (!entry) {
    failures.push(
      `${item}: measured ${value} B but no budget line in ${relative(repoRoot, budgetsPath)}`,
    );
    continue;
  }
  const est = Math.round(value / 4);
  const headroom = entry.budget - value;
  rows.push(
    `${item.padEnd(26)} ${String(value).padStart(7)} B  ~${String(est).padStart(6)} tok  budget ${String(entry.budget).padStart(7)} B  headroom ${headroom} B`,
  );
  if (value > entry.budget) {
    failures.push(
      `${item}: ${value} B exceeds budget ${entry.budget} B (+${value - entry.budget}). Trim it, or raise the budget WITH a new justification (currently: "${entry.justification}").`,
    );
  }
}
for (const item of Object.keys(budgets.items)) {
  if (!(item in measured))
    failures.push(`${item}: budgeted but never measured — stale budget line.`);
}

/*
 * The budget set must be internally satisfiable — see `budgetCoherence.ts` for why this is checked
 * against the budgets rather than the measurements.
 */
failures.push(...coherenceFailures(budgets.items, COMPOSITES));

console.log('standing-context budgets (spec 2026-08-03)\n');
console.log(rows.join('\n'));
if (failures.length > 0) {
  console.error('\ncontext:check FAILED:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('\ncontext:check OK');
