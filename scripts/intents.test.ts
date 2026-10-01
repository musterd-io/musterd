import { describe, expect, it } from 'vitest';
import { INCREMENTS_BASELINE } from './intents-increments-baseline.ts';
import {
  baselineKey,
  citesDisposition,
  DISPOSITION_WINDOW,
  FALSE_POSITIVE_BASELINE,
  failures,
  findForwardReferences,
  FORWARD_BASELINE,
  findIncrementItems,
  incrementBaselineRot,
  incrementFailures,
  measureCoverage,
  parseDisposition,
} from './intents.ts';

const f = (text: string) => findForwardReferences('docs/decisions/999-x.md', text);

describe('findForwardReferences — the shapes this corpus actually uses (ADR 373)', () => {
  it('catches the sentence this gate exists for, verbatim from ADR 354', () => {
    const refs = f(
      'kill. Left for a sibling lane; this ADR fixes the attestation, not the judgement.',
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.phrase.toLowerCase()).toBe('left for a sibling lane');
    expect(refs[0]!.disposition).toBeNull();
  });

  it('catches the other harvested shapes', () => {
    for (const line of [
      'That is a separate defect from this one, and it wants its own lane.',
      'what remains is M4–M5 — the weekly digest emit',
      'Platform services increment 3 will auto-provision.',
      '**Follow-ups not yet built:** a dedicated command',
    ]) {
      expect(f(line), line).toHaveLength(1);
    }
  });

  it('never treats a disposition line as a forward reference — otherwise it demands one for itself', () => {
    // The line matches `a separate lane` AND is a Follows-up. Without the guard the gate would
    // report the answer as a new question, forever.
    expect(f('Follows-up: deferred — until a separate lane needs it (2026-09-03)')).toHaveLength(0);
  });
});

describe('the structural rule — a roadmap `building:` string is a promise by definition', () => {
  it('flags a building: string whose words match no phrase in the list', () => {
    // The real miss this rule exists for: `ledger-seats.building` opens "increments 3–5 — remaining
    // platform services…" and matches nothing in FORWARD_RE. Widening the list to catch it would
    // have matched every incidental mention of an increment in the corpus.
    const refs = findForwardReferences(
      'content/roadmap.data.ts',
      "    building:\n      'increments 3-5 - remaining platform services + install auto-provisioning',",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.disposition).toBeNull();
  });

  it('applies the rule only to the roadmap genre, not to any line saying "building"', () => {
    expect(findForwardReferences('docs/wiki/x.md', 'we are building the thing')).toHaveLength(0);
  });

  it('accepts a disposition on the line ABOVE — the only position a multi-line string allows', () => {
    const refs = findForwardReferences(
      'content/roadmap.data.ts',
      "    // Follows-up: 01M1MMK3339B06Q328HYWXARJF\n    building:\n      'increments 3-5',",
    );
    expect(refs[0]!.disposition).toEqual({
      kind: 'lane',
      lane: '01M1MMK3339B06Q328HYWXARJF',
    });
  });
});

describe('parseDisposition — three legal answers, and silence with a prefix is not one', () => {
  it('accepts a bare lane id, backticked or not', () => {
    expect(parseDisposition('01M1MMHJP3PQY1QWNJCHV3XEMA')).toEqual({
      kind: 'lane',
      lane: '01M1MMHJP3PQY1QWNJCHV3XEMA',
    });
    expect(parseDisposition('`01M1MMHJP3PQY1QWNJCHV3XEMA`').kind).toBe('lane');
  });

  it('accepts a deferral and a none ONLY with both a reason and a date', () => {
    expect(parseDisposition('deferred — until a second human joins (2026-09-03)').kind).toBe(
      'deferred',
    );
    expect(parseDisposition('none — the premise moved (2026-09-03)').kind).toBe('none');
  });

  it('refuses a deferral or none that carries a DATE but no reason (gptbot, lane 01M1MNTTNC)', () => {
    // The decline that sent increment 1 back: `REASONED_RE` used `.*` between the keyword and the
    // date, and `.*` matches the empty string — so a deferral with no reopen trigger passed while
    // the comment beside it claimed both were required. A deferral without a trigger is
    // indistinguishable from forgetting, which is the condition ADR 373 exists to refuse, so the
    // gate was stamping its own failure mode as compliant.
    for (const bare of ['deferred (2026-09-03)', 'none (2026-09-03)', 'deferred  (2026-09-03)']) {
      expect(parseDisposition(bare).kind, bare).toBe('malformed');
    }
  });

  it('accepts a reason in any punctuation the corpus uses, so long as there are words in it', () => {
    for (const ok of [
      'deferred — a second seat relabels the noise set (2026-09-03)',
      'deferred until the role-query trigger fires (2026-09-03)',
      'none - the premise moved (2026-09-03)',
    ]) {
      expect(parseDisposition(ok).kind, ok).not.toBe('malformed');
    }
  });

  it('refuses punctuation standing in for a reason — an em dash is not a trigger', () => {
    expect(parseDisposition('deferred — (2026-09-03)').kind).toBe('malformed');
  });

  it('refuses a deferral with no date — that is the shape it exists to prevent', () => {
    // A deferral without a trigger and a date is indistinguishable from forgetting, which is the
    // whole finding (ADR 272 §5 is the model: a NAMED, measurable trigger).
    const d = parseDisposition('deferred — later');
    expect(d.kind).toBe('malformed');
    expect(d.kind === 'malformed' && d.why).toContain('reopen trigger');
  });

  it('refuses anything else, including a prose gesture at a lane', () => {
    expect(parseDisposition('someone should open a lane for this').kind).toBe('malformed');
    expect(parseDisposition('').kind).toBe('malformed');
  });
});

describe('the disposition window', () => {
  it('attaches a Follows-up within the window and ignores one beyond it', () => {
    const near = f(`left for a sibling lane\n\nFollows-up: 01M1MMHJP3PQY1QWNJCHV3XEMA`);
    expect(near[0]!.disposition?.kind).toBe('lane');

    const far = f(
      `left for a sibling lane${'\n'.repeat(DISPOSITION_WINDOW + 2)}Follows-up: 01M1MMHJP3PQY1QWNJCHV3XEMA`,
    );
    // Three paragraphs away is not attached to anything a reader would connect it to.
    expect(far[0]!.disposition).toBeNull();
  });
});

describe('the baseline is a burn-down, and its key survives ordinary editing', () => {
  it('keys on the line text, not the line number — inserting above must not un-baseline', () => {
    const one = f('That is a separate lane.')[0]!;
    const two = f('preamble\npreamble\nThat is a separate lane.')[0]!;
    expect(two.line).not.toBe(one.line);
    expect(baselineKey(two)).toBe(baselineKey(one));
  });

  it('keys apart two references in one file — ADR 173 carries "its own lane" twice', () => {
    const refs = f(
      'Filed as its own lane because a correction is\nand tracked as its own lane. The filter',
    );
    expect(refs).toHaveLength(2);
    expect(baselineKey(refs[0]!)).not.toBe(baselineKey(refs[1]!));
  });

  it('a baselined reference does not fail; an unbaselined one does', () => {
    const refs = f('That is a separate lane.');
    expect(failures(refs, new Set(), new Set())).toHaveLength(1);
    expect(failures(refs, new Set([baselineKey(refs[0]!)]), new Set())).toHaveLength(0);
  });

  it('reports a stale baseline entry as rot — an exemption protecting nothing', () => {
    const cov = measureCoverage([], new Set(['docs/decisions/999-x.md::gone']), new Set());
    expect(cov.rot).toEqual(['docs/decisions/999-x.md::gone']);
  });
});

describe('the meter separates debt from the instrument’s own noise', () => {
  it('counts noise apart, so precision is measurable rather than felt', () => {
    const refs = f('That is a separate lane.\nbecame its own lane (already opened)');
    const cov = measureCoverage(refs, new Set(), new Set([baselineKey(refs[1]!)]));
    expect(cov.matched).toBe(2);
    expect(cov.noise).toBe(1);
  });

  it('the two shipped baselines are disjoint — a line is debt or noise, never both', () => {
    for (const k of FORWARD_BASELINE) expect(FALSE_POSITIVE_BASELINE.has(k)).toBe(false);
  });
});

const inc = (text: string) => findIncrementItems('docs/superpowers/specs/x.md', text);

describe('findIncrementItems — an Increments/Phases section is checked row by row (ADR 487)', () => {
  it('checks every data row of a table, never the header or the separator', () => {
    const items = inc(
      [
        '## 7. Increments',
        '',
        '| # | Lane | Touches |',
        '| --- | --- | --- |',
        '| 1 | `01M3T8MJK8H4M86DZJEBMW6KM8` — this spec | docs |',
        '| 2 | the docs gate | scripts |',
      ].join('\n'),
    );
    expect(items.map((i) => [i.line, i.cited])).toEqual([
      [5, true],
      [6, false],
    ]);
    expect(items[1]!.section).toBe('7. Increments');
  });

  it('accepts the three dispositions and nothing else', () => {
    expect(citesDisposition('1. ship it — lane 01M3TAKF3Y')).toBe(true);
    expect(citesDisposition('2. the gate — parked `01M3TAM9XH`')).toBe(true);
    expect(citesDisposition('3. host move — dropped — superseded by ADR 475')).toBe(true);
    expect(citesDisposition('4. host move — dropped')).toBe(false);
    expect(citesDisposition('5. later, maybe its own lane')).toBe(false);
    expect(citesDisposition('6. see ADR 487 (2026-09-30)')).toBe(false);
  });

  it('a list item owns its indented continuation, so a citation on line two counts', () => {
    const items = inc(
      [
        '## Increments',
        '1. **The ladder** — a pure judgement over the binding,',
        '   shipped as lane 01KZAEGF2KXXXXXXXXXXXXXXXX.',
        '2. **The audit row** — needs a client to server path.',
        '   - a sub-bullet is part of item 2, not an increment',
      ].join('\n'),
    );
    expect(items.map((i) => i.cited)).toEqual([true, false]);
  });

  it('a section ends at the next heading of its level; deeper headings stay inside', () => {
    const items = inc(
      [
        '## Increments',
        '### Increment 1 detail',
        '- one',
        '## Consequences',
        '- not an increment',
      ].join('\n'),
    );
    expect(items.map((i) => i.text)).toEqual(['- one']);
  });

  it('names the plural only: one phase as a heading is that phase, and H1 is the title', () => {
    expect(inc('## Phase 2 — build\n- step')).toEqual([]);
    expect(inc("# 487 — a plan's increments are lanes\n- not a section")).toEqual([]);
    expect(inc('## The five phases\n- P0')).toHaveLength(1);
  });

  it('skips fenced code — an example table is not a plan', () => {
    expect(inc('## Increments\n```\n| a | b |\n|---|---|\n| 1 | x |\n```')).toEqual([]);
  });

  it('prose paragraphs in the section are not items', () => {
    expect(inc('## Increments\nEach lands alone, in order.\n')).toEqual([]);
  });
});

describe('the increments baseline is a burn-down', () => {
  const items = inc('## Increments\n1. old, undisposed\n2. new, undisposed');
  const old = new Set([baselineKey(items[0]!)]);

  it('fails only what the baseline does not cover', () => {
    expect(incrementFailures(items, old).map((i) => i.line)).toEqual([3]);
  });

  it('reports an entry whose item now cites a lane, or is gone, as rot', () => {
    const disposed = inc('## Increments\n1. old, undisposed — 01M3TAKF3Y');
    expect(incrementBaselineRot(disposed, old)).toEqual([...old]);
    expect(incrementBaselineRot(items, old)).toEqual([]);
  });

  it('every committed entry is keyed the way baselineKey keys an item', () => {
    for (const key of INCREMENTS_BASELINE) expect(key).toMatch(/^docs\/[^:]+\.md::.+/);
  });
});
