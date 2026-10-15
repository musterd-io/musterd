import { describe, expect, it } from 'vitest';
import {
  CLASSIFIED_DETAIL,
  type FragmentInspection,
  type ReconcileResult,
} from '../onboard/reconcile/engine.js';
import {
  receiptVerdict,
  renderConfigureReceipt,
  renderWireReceipts,
  verdictOf,
} from './harnessVerdict.js';

function inspection(over: Partial<FragmentInspection>): FragmentInspection {
  return {
    harness: 'cursor',
    resourceKey: 'k',
    fragmentKey: 'guidance',
    scope: 'folder',
    desired: true,
    observation: 'unmanaged-conflict',
    owners: [],
    ownedHere: false,
    plan: 'none',
    planned: 'conflict',
    journal: 'none',
    lock: 'free',
    ...over,
  };
}

function receipt(over: Partial<ReconcileResult>): ReconcileResult {
  return {
    harness: 'cursor',
    resourceKey: 'k',
    fragmentKey: 'guidance',
    scope: 'folder',
    action: 'none',
    result: 'conflict',
    recovery: 'none',
    ...over,
  };
}

describe('frame-9 glyphs, one mapper for status and receipts', () => {
  it('prints the brief failure strings, not the result enum', () => {
    const cases: Array<[FragmentInspection, ReconcileResult, string]> = [
      [
        inspection({}),
        receipt({ detail: CLASSIFIED_DETAIL.unmanaged }),
        "✗ conflict — not musterd's to overwrite",
      ],
      [
        inspection({ observation: 'owned-drifted', planned: 'conflict' }),
        receipt({ detail: CLASSIFIED_DETAIL.drifted }),
        '✗ drifted — evidence retained',
      ],
      [
        inspection({ planned: 'release-blocked' }),
        receipt({ result: 'release-blocked', detail: CLASSIFIED_DETAIL.releaseBlocked }),
        '✗ release blocked — drifted while deselected',
      ],
      [
        inspection({ planned: 'repair-needed' }),
        receipt({ result: 'repair-needed', detail: CLASSIFIED_DETAIL.repair }),
        '✗ pre-ADR-286 registration — run musterd harness configure',
      ],
      [
        inspection({ planned: 'invalid-container', observation: 'invalid-container' }),
        receipt({ result: 'invalid-container', detail: 'not a directory' }),
        '✗ container unreadable',
      ],
    ];
    for (const [seen, done, glyph] of cases) {
      expect(verdictOf(seen)).toBe(glyph);
      expect(receiptVerdict(done)).toBe(glyph);
    }
  });

  it("keeps a journal-recovery conflict's own evidence line", () => {
    const line = receiptVerdict(
      receipt({ detail: 'prepared journal matches neither fingerprint — evidence preserved' }),
    );
    expect(line).toBe(
      '✗ conflict — prepared journal matches neither fingerprint — evidence preserved',
    );
  });

  it('a busy receipt uses the brief hourglass, and a write still says applied', () => {
    expect(receiptVerdict(receipt({ result: 'busy' }))).toBe(
      '⏳ busy — another reconciler holds this',
    );
    expect(verdictOf(inspection({ lock: 'held', planned: 'unchanged' }))).toBe(
      '⏳ busy — another reconciler holds this',
    );
    expect(renderConfigureReceipt(receipt({ result: 'applied', action: 'create' }))).toBe(
      '  cursor (guidance)  (create) ✓ applied',
    );
  });

  it('pads wire rows to the widest target so the verdicts share a column', () => {
    const lines = renderWireReceipts([
      receipt({ harness: 'cursor', fragmentKey: 'hooks', result: 'unchanged' }),
      receipt({
        harness: 'claude-code',
        fragmentKey: 'mcp.musterd',
        result: 'unchanged',
      }),
    ]);
    const mark = (line: string) => line.indexOf('✓');
    expect(mark(lines[0]!)).toBe(mark(lines[1]!));
    expect(mark(lines[0]!)).toBeGreaterThan('  claude-code (mcp.musterd)'.length);
  });
});
