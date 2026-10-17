import { homedir } from 'node:os';
import {
  CLASSIFIED_DETAIL,
  type FragmentInspection,
  type ReconcileResult,
} from '../onboard/reconcile/engine.js';
import { theme } from '../render/theme.js';

/**
 * Frame 9 glyphs (docs/design/figma-brief-terminal.md §8-9). `harness status`, `harness configure`,
 * and `wire` all render a classified failure through here, so a result cannot grow a second wording.
 * A configure/wire success is a receipt of the action that just ran (`✓ applied`), which is a
 * different moment from status's plan glyph (`→ needs wire`).
 */

function bad(body: string): string {
  return `${theme.err('✗')} ${body}`;
}

/** The brief's exact failure line for one classified state. */
function classifiedFailure(
  result: 'conflict' | 'release-blocked' | 'repair-needed' | 'invalid-container' | 'busy',
  drifted = false,
): string {
  switch (result) {
    case 'conflict':
      return drifted
        ? bad(CLASSIFIED_DETAIL.drifted)
        : bad(`conflict — ${CLASSIFIED_DETAIL.unmanaged}`);
    case 'release-blocked':
      return bad(`release blocked — ${CLASSIFIED_DETAIL.releaseBlocked}`);
    case 'repair-needed':
      return bad(CLASSIFIED_DETAIL.repair);
    case 'invalid-container':
      return bad(CLASSIFIED_DETAIL.unreadable);
    case 'busy':
      return '⏳ busy — another reconciler holds this';
  }
}

/** Status inspection. Journal and lock outrank the plan, matching frame 9. */
export function verdictOf(f: FragmentInspection): string {
  if (f.journal === 'invalid' || f.lock === 'invalid') return bad(CLASSIFIED_DETAIL.unreadable);
  if (f.journal === 'pending') return 'journal pending — re-run musterd wire';
  if (f.lock === 'held') return classifiedFailure('busy');
  switch (f.planned) {
    case 'unchanged':
      return f.desired ? `${theme.ok('✓')} in place` : `${theme.ok('✓')} released`;
    case 'satisfied-unmanaged':
      return `${theme.ok('✓')} satisfied (unmanaged)`;
    case 'applied':
      return '→ needs wire';
    case 'conflict':
      return classifiedFailure('conflict', f.observation === 'owned-drifted');
    case 'release-blocked':
    case 'repair-needed':
    case 'invalid-container':
      return classifiedFailure(f.planned);
    case 'pending':
      return 'journal pending — re-run musterd wire';
    case 'busy':
      return classifiedFailure('busy');
    case 'failed':
      return f.planned;
  }
}

/** Configure and wire receipt. Classified failures use {@link verdictOf}'s strings. */
export function receiptVerdict(r: ReconcileResult): string {
  switch (r.result) {
    case 'applied':
    case 'unchanged':
      return `${theme.ok('✓')} ${r.result}`;
    case 'satisfied-unmanaged':
      return `${theme.ok('✓')} satisfied (unmanaged)`;
    case 'pending':
      return `· pending (${r.detail ?? 'not installed here'})`;
    case 'busy':
      return classifiedFailure('busy');
    case 'conflict':
      if (r.detail === CLASSIFIED_DETAIL.drifted) return classifiedFailure('conflict', true);
      if (r.detail === undefined || r.detail === CLASSIFIED_DETAIL.unmanaged) {
        return classifiedFailure('conflict', false);
      }
      // A journal recovery conflict carries its own evidence line. It is not a classified state.
      return bad(`conflict — ${r.detail}`);
    case 'release-blocked':
    case 'repair-needed':
    case 'invalid-container':
      return classifiedFailure(r.result);
    case 'failed':
      return bad(r.detail ? `failed — ${r.detail}` : 'failed');
  }
}

interface ResourceRow {
  harness: string;
  fragmentKey: string;
  resourceKey: string;
}

/**
 * When one harness prints the same fragment key twice, name the row's repository or folder path
 * (ADR 638). A unique key returns null, so the one-row frame stays character-compatible. Paths
 * that match fall back to the registration id.
 */
export function fragmentDisambiguator(
  row: ResourceRow,
  peers: readonly ResourceRow[],
  home: string = homedir(),
): string | null {
  if (!row.fragmentKey) return null;
  const same = peers.filter((p) => p.harness === row.harness && p.fragmentKey === row.fragmentKey);
  if (same.length < 2) return null;
  const located = same.map((p) => locateResource(p.resourceKey));
  const mine = locateResource(row.resourceKey);
  const roots = new Set(located.map((l) => l.root ?? `\0${l.scope}`));
  if (roots.size > 1) return mine.root ? shrinkHome(mine.root, home) : mine.scope;
  const regs = new Set(located.map((l) => l.registration).filter((r): r is string => r !== null));
  if (regs.size > 1 && mine.registration) return mine.registration;
  return null;
}

function locateResource(resourceKey: string): {
  scope: string;
  root: string | null;
  registration: string | null;
} {
  const parts = resourceKey.split('\u0000');
  const scope = parts[0] ?? '';
  if (scope === 'repo-shared') {
    return { scope, root: parts[1] || null, registration: parts[2] || null };
  }
  if (scope === 'folder') return { scope, root: parts[1] || null, registration: null };
  return { scope: scope || 'resource', root: null, registration: null };
}

function shrinkHome(path: string, home: string): string {
  if (home !== '' && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Status row. Columns stay fragment key, scope, verdict; a collision adds a dim path after. */
export function statusFragmentLine(
  f: FragmentInspection,
  peers: readonly FragmentInspection[],
): string {
  const where = fragmentDisambiguator(f, peers);
  const suffix = where ? `  ${theme.meta(where)}` : '';
  return `  ${f.fragmentKey.padEnd(13)} ${f.scope.padEnd(12)} ${verdictOf(f)}${suffix}`;
}

function targetOf(r: ReconcileResult, peers: readonly ReconcileResult[]): string {
  const where = fragmentDisambiguator(r, peers);
  if (!where) return r.fragmentKey ? `${r.harness} (${r.fragmentKey})` : r.harness;
  if (!r.fragmentKey) return `${r.harness} @ ${where}`;
  return `${r.harness} (${r.fragmentKey} @ ${where})`;
}

function actionOf(r: ReconcileResult): string {
  return r.action === 'none' ? '' : `(${r.action}) `;
}

/** Configure's historical two-space receipt. One fragment, no column. */
export function renderConfigureReceipt(
  r: ReconcileResult,
  peers: readonly ReconcileResult[] = [r],
): string {
  return `  ${targetOf(r, peers)}  ${actionOf(r)}${receiptVerdict(r)}`;
}

/** Wire rows. Every target pads to the widest label in this report, then one space, then the verdict. */
export function renderWireReceipts(results: ReconcileResult[]): string[] {
  const width = results.reduce((n, r) => Math.max(n, targetOf(r, results).length), 0);
  return results.map(
    (r) => `  ${targetOf(r, results).padEnd(width)} ${actionOf(r)}${receiptVerdict(r)}`,
  );
}
