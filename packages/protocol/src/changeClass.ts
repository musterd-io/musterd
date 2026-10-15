/**
 * ADR 612 — the change class: what kind of landing an acceptor is about to judge, derived from the
 * paths the squash commit touched. Validator-free and shared, so the MCP adapter's `lane_submit`
 * and the CLI's `lane submit` cannot classify the same diff two ways (the same reason the claim
 * verdict rule lives here, ADR 585).
 *
 * A label, not a route: the daemon records it on the ready row and opens the acceptance ask with
 * it; nothing picks an acceptor by it until a second ADR's eval says it should (ADR 612 §3).
 */

/** Ordered as ADR 612 §1 lists them; `code` is everything else. */
export const CHANGE_CLASSES = ['docs', 'tests', 'web', 'protocol', 'server', 'code'] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

/** Three counts — never the path list (ADR 612 §Rejected: the PR already carries it). */
export interface ChangedCounts {
  docs: number;
  tests: number;
  code: number;
}

export interface ChangeLabel {
  change_class: ChangeClass;
  changed: ChangedCounts;
}

function isDocPath(p: string): boolean {
  return p.startsWith('docs/') || (!p.includes('/') && p.toLowerCase().endsWith('.md'));
}

function isTestPath(p: string): boolean {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(p) || p.includes('/__fixtures__/') || p.startsWith('__fixtures__/')
  );
}

/**
 * Classify a landed diff by its paths. `docs` and `tests` are exclusive classes — every path must
 * be one — so a test-only change is `tests` wherever the tests live. Any other diff takes the first
 * of `web`, `protocol`, `server` that any path reaches, which is how a schema change plus its ADR
 * reads as `protocol`, and falls back to `code`. `null` for an empty diff: nothing to label.
 */
export function classifyChange(paths: readonly string[]): ChangeLabel | null {
  const files = paths.map((p) => p.trim()).filter((p) => p.length > 0);
  if (files.length === 0) return null;
  const changed: ChangedCounts = { docs: 0, tests: 0, code: 0 };
  for (const p of files) {
    if (isDocPath(p)) changed.docs++;
    else if (isTestPath(p)) changed.tests++;
    else changed.code++;
  }
  const any = (prefixes: string[]) => files.some((p) => prefixes.some((x) => p.startsWith(x)));
  const change_class: ChangeClass =
    changed.docs === files.length
      ? 'docs'
      : changed.tests === files.length
        ? 'tests'
        : any(['packages/web/', 'packages/mobile/'])
          ? 'web'
          : any(['packages/protocol/src/'])
            ? 'protocol'
            : any(['packages/server/src/'])
              ? 'server'
              : 'code';
  return { change_class, changed };
}

/** The ask's opening label, e.g. `docs-only, 3 files` or `server, 12 files`. */
export function changeLabelText(label: {
  change_class?: string | undefined;
  changed?: Partial<ChangedCounts> | undefined;
}): string | null {
  // The class is the submitting seat's attestation and this text lands in another seat's ask:
  // print only a class this build knows, never the raw string.
  if (!(CHANGE_CLASSES as readonly string[]).includes(label.change_class ?? '')) return null;
  const kind =
    label.change_class === 'docs' || label.change_class === 'tests'
      ? `${label.change_class}-only`
      : label.change_class;
  const c = label.changed;
  const n = c ? (c.docs ?? 0) + (c.tests ?? 0) + (c.code ?? 0) : 0;
  if (!Number.isSafeInteger(n) || n < 0) return kind;
  return n > 0 ? `${kind}, ${n} file${n === 1 ? '' : 's'}` : kind;
}
