import { describe, expect, it } from 'vitest';
import {
  claimLines,
  consequencesLines,
  entryProblems,
  escapeReasons,
  judge,
  overturningNotes,
  struckWikiClaims,
  supersessions,
} from './check-ledger.ts';

const CLAIM =
  '**Seats never hold against a rejection (2026-10-04; falsify: a hold).** <!-- claim: defect -->';

describe('trigger 1 — a wiki claim struck or rewritten', () => {
  it('reads claim lines marker-stripped', () => {
    expect(claimLines(`# P\n\n${CLAIM}\n\nprose\n`)).toEqual([
      '**Seats never hold against a rejection (2026-10-04; falsify: a hold).**',
    ]);
  });

  it('fires when a claim line is gone or reworded, not when a dated note is added beside it', () => {
    const before = new Map([['p.md', `# P\n\n${CLAIM}\n`]]);
    expect(
      struckWikiClaims(before, new Map([['p.md', '# P\n\nreworded. <!-- claim: defect -->\n']])),
    ).toHaveLength(1);
    expect(struckWikiClaims(before, new Map([['p.md', '# P\n\nnothing here\n']]))).toHaveLength(1);
    // Wiki rule 4: the correction is a dated note under the claim; the claim line stays.
    expect(
      struckWikiClaims(
        before,
        new Map([['p.md', `# P\n\n${CLAIM}\n\n**Corrected 2026-10-05:** a hold happened.\n`]]),
      ),
    ).toEqual([]);
    // A page deleted wholesale is archive work, not this gate's.
    expect(struckWikiClaims(before, new Map())).toEqual([]);
  });
});

describe('trigger 2 — an ADR Consequences note that overturns a premise', () => {
  const adr = (cons: string) =>
    `# 1 — x\n\n- Status: accepted\n\n## Decision\n\nd\n\n## Consequences\n\n${cons}\n\n## Observability\n\nn/a`;

  it('slices the Consequences section only', () => {
    expect(consequencesLines(adr('- a\n- b')).filter(Boolean)).toEqual(['- a', '- b']);
    expect(consequencesLines('# no sections')).toEqual([]);
  });

  it('fires on an ADDED overturning line, not on one that was already there, not on a plain note', () => {
    const base = adr('- 2026-09-01 — the premise was wrong (old).');
    expect(
      overturningNotes(
        'a.md',
        base,
        adr('- 2026-09-01 — the premise was wrong (old).\n- 2026-10-05 — increment 2 landed.'),
      ),
    ).toEqual([]);
    expect(
      overturningNotes(
        'a.md',
        base,
        adr(
          '- 2026-09-01 — the premise was wrong (old).\n- 2026-10-05 — §3 no longer holds: measured 0 of 65.',
        ),
      ),
    ).toHaveLength(1);
    // A new ADR whose Consequences already overturn something is a trigger too (base null).
    expect(
      overturningNotes('a.md', null, adr('- the earlier measurement turned out to be false.')),
    ).toHaveLength(1);
  });
});

describe('trigger 3 — supersession', () => {
  it('fires when status becomes superseded or a Supersedes line appears', () => {
    const accepted = '# 1\n\n- Status: accepted\n';
    expect(supersessions('a.md', accepted, '# 1\n\n- Status: superseded by ADR 9\n')).toHaveLength(
      1,
    );
    expect(
      supersessions('a.md', '# 1\n\n- Status: superseded\n', '# 1\n\n- Status: superseded\n\nnote'),
    ).toEqual([]);
    expect(
      supersessions('b.md', null, '# 9\n\n- Status: accepted\n- Supersedes: [ADR 1](1.md)\n'),
    ).toHaveLength(1);
    expect(
      supersessions(
        'b.md',
        '# 9\n\n- Supersedes: [ADR 1](1.md)\n',
        '# 9\n\n- Supersedes: [ADR 1](1.md)\n',
      ),
    ).toEqual([]);
  });
});

describe('the escape hatch and the verdict', () => {
  it('reads `not-a-falsification: <why>` lines and demands a reason with letters', () => {
    expect(
      escapeReasons('fix typo\n\nnot-a-falsification: wording only, the number is unchanged\n'),
    ).toEqual(['wording only, the number is unchanged']);
    expect(escapeReasons('Not-A-Falsification: ---')).toEqual([]);
    expect(escapeReasons('no line')).toEqual([]);
  });

  it('passes with no trigger, with an entry, or with an escape; fails with a trigger and neither', () => {
    expect(judge([], [], [], []).ok).toBe(true);
    expect(judge(['t'], ['docs/claims/entries/2026-10-05-x.md'], [], []).ok).toBe(true);
    expect(judge(['t'], [], ['why'], []).ok).toBe(true);
    expect(judge(['t'], [], [], []).ok).toBe(false);
    // A malformed new entry fails on its own, trigger or not.
    expect(judge([], ['e'], [], ['e — missing `falsifier`']).ok).toBe(false);
  });
});

describe('a new entry is shape-checked, including the ADR 505 traceback', () => {
  const entry = (extra = '') =>
    `---\nclaim: "x"\nclaimant: a\nclaim_ref: m1\nclaim_class: absence\nclaimed_at: 2026-10-01\nfalsified_at: 2026-10-05\ndetection_channel: collision\ncorrector: b\ncorrection_ref: PR #1\nstatus: falsified\nfalsifier: "y"\n${extra}---\n\nbody\n`;

  it('accepts the template and a well-formed passed_by list', () => {
    expect(entryProblems('e.md', entry())).toEqual([]);
    expect(
      entryProblems(
        'e.md',
        entry(
          'passed_by:\n  - acceptance: ask 01M (ryder, 2026-10-02)\n  - dependency: lane 01N built on it\n',
        ),
      ),
    ).toEqual([]);
    expect(entryProblems('e.md', entry('passed_by: []\n'))).toEqual([]);
    // A ONE-row list: `\s*` after `passed_by:` used to swallow the newline, read the row as an
    // inline value, and refuse the entry as "not a list" (izzo, 2026-10-05).
    expect(
      entryProblems(
        'e.md',
        entry('passed_by:\n  - acceptance: ghost 01M (lane 01N, 2026-10-05)\n'),
      ),
    ).toEqual([]);
  });

  it('names a missing key and a malformed passed_by row', () => {
    expect(entryProblems('e.md', entry().replace('falsifier: "y"\n', ''))).toEqual([
      'e.md — missing `falsifier`',
    ]);
    expect(entryProblems('e.md', entry('passed_by:\n  - ryder waved it\n'))).toHaveLength(1);
    expect(entryProblems('e.md', 'no frontmatter')).toEqual(['e.md — no YAML frontmatter']);
  });
});
