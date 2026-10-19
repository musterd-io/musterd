import type { Lane, NextBrief } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { fmtNext } from './lanes.js';

function brief(why: NextBrief['why']): NextBrief {
  return { member: 'miley', in_flight: [], up_next: [], shipped: [], next_goal: null, why };
}

describe('fmtNext — the `why` slot carries its age (ADR 264)', () => {
  // The CLI has always dated this line; the MCP rendering did not, so a seat reading `team_next`
  // through the harness saw a handoff with no way to tell a live instruction from a month-old one.
  // Every stale-why incident so far was found by someone noticing the CONTENT was dead — the age is
  // what lets the reader notice first.
  it('renders the handoff age alongside its author', () => {
    const out = fmtNext(
      brief({
        from: 'stanley',
        body: 'packages/web a11y is now uncovered',
        ts: Date.now() - 15 * 24 * 60 * 60 * 1000,
        goal_id: null,
      }),
    );
    expect(out).toContain('why — handoff from stanley');
    expect(out).toContain('15d ago');
  });

  it('keeps the goal when the handoff names one', () => {
    const out = fmtNext(
      brief({ from: 'nick', body: 'pick up the spine', ts: Date.now(), goal_id: 'orientation' }),
    );
    expect(out).toContain('goal=orientation');
  });
});

describe('fmtNext — incident banner leads (spec 2026-08-14 inc 1)', () => {
  it('renders an unclaimed incident first, above everything', () => {
    const b = brief(null);
    b.incidents = [
      {
        lane: '01LANE',
        gate: 'ci:gates/A11y contrast',
        owner_seat: null,
        opened_at: Date.now() - 2 * 60 * 60 * 1000,
      },
    ];
    const out = fmtNext(b);
    const lines = out.split('\n');
    expect(lines[1]).toContain(
      '⚠ incident: ci:gates/A11y contrast — UNCLAIMED (lane 01LANE, open 2h)',
    );
    expect(lines[2]).toContain('park behind it');
  });

  it('renders the owner when claimed, and nothing without incidents (daemon skew tolerated)', () => {
    const owned = brief(null);
    owned.incidents = [{ lane: '01LANE', gate: 'g', owner_seat: 'miley', opened_at: Date.now() }];
    expect(fmtNext(owned)).toContain('owned by miley');
    const skew = brief(null);
    delete (skew as Partial<NextBrief>).incidents;
    expect(fmtNext(skew)).not.toContain('incident');
  });
});

/**
 * The falsifier of ADR 283: a seat reading its brief can tell a lane nobody was asked to review
 * from one whose reviewer went silent — without writing SQL.
 *
 * `unconfirmed` is the word both situations printed before this, and the correct response to each
 * is the response the other one wastes. This is the surface the falsifier names, so it is the
 * surface that has to prove it.
 */
describe('fmtNext — an unconfirmed close says WHY (ADR 283)', () => {
  function shippedBrief(lane: Partial<Lane>): NextBrief {
    const b = brief(null);
    b.shipped = [
      {
        id: '01LANE',
        team: 'revive',
        project: 'agents',
        title: 'the lane',
        detail: '',
        kind: null,
        owner_seat: 'izzo',
        role: null,
        scope: [],
        depends_on: [],
        branch: null,
        goal_id: null,
        risk: [],
        stakes: 'normal',
        stakes_provenance: 'declared',
        merged: null,
        state: 'done',
        created_by: 'izzo',
        created_at: 0,
        claimed_at: null,
        resolved_at: null,
        updated_at: 0,
        ...lane,
      } as Lane,
    ];
    return b;
  }

  it('sends the reader to the ROSTER when no counterpart existed', () => {
    const out = fmtNext(shippedBrief({ verified: false, close_reason: 'no_candidate' }));
    expect(out).toContain('unconfirmed');
    expect(out).toContain('nobody was asked — no eligible counterpart');
  });

  it('sends the reader to a PERSON when one was asked and went silent', () => {
    const out = fmtNext(shippedBrief({ verified: false, close_reason: 'review_timeout' }));
    expect(out).toContain('unconfirmed');
    expect(out).toContain('asked, and the wait ran out');
  });

  it('stays quiet on an accepted close — the reason would only repeat the chip', () => {
    const out = fmtNext(shippedBrief({ verified: true, close_reason: 'counterpart_confirm' }));
    expect(out).not.toContain('unconfirmed');
    expect(out).not.toContain('(');
  });

  it('renders exactly as before when the close recorded no reason (daemon skew)', () => {
    const out = fmtNext(shippedBrief({ verified: false }));
    expect(out).toContain('unconfirmed');
    // No parenthetical invented for a close that said nothing.
    expect(out).not.toContain('nobody was asked');
  });
});

describe('fmtNext — review_debt empty_pool (ADR 404)', () => {
  it('names why nobody was asked when the daemon sent empty_pool', () => {
    const b = brief(null);
    b.review_debt = [
      {
        id: 'L1',
        title: 'stuck',
        owner: 'dolly',
        waited_ms: 60_000,
        no_candidate: true,
        empty_pool: { kind: 'no_live_member' },
        unlanded: false,
      },
    ];
    expect(fmtNext(b)).toContain('NO REVIEWER WAS ASKED (no other member is live)');
  });

  it('keeps the historical parenthetical when the daemon omitted the field', () => {
    const b = brief(null);
    b.review_debt = [
      {
        id: 'L2',
        title: 'legacy',
        owner: 'dolly',
        waited_ms: 60_000,
        no_candidate: true,
        unlanded: false,
      },
    ];
    expect(fmtNext(b)).toContain('NO REVIEWER WAS ASKED (no eligible counterpart at submit)');
  });
});

describe('fmtNext — review_debt unlanded badge (merge-verified submit)', () => {
  it('badges an unlanded entry so an acceptor never holds for an unmerged lane', () => {
    const b = brief(null);
    b.review_debt = [
      {
        id: 'L1',
        title: 'no attestation',
        owner: 'dolly',
        waited_ms: 60_000,
        no_candidate: false,
        unlanded: true,
      },
      {
        id: 'L2',
        title: 'landed',
        owner: 'dolly',
        waited_ms: 60_000,
        no_candidate: false,
        unlanded: false,
      },
    ];
    const out = fmtNext(b);
    const lines = out.split('\n');
    expect(lines.find((l) => l.includes('L1'))).toContain('NO MERGE ATTESTATION');
    expect(lines.find((l) => l.includes('L2'))).not.toContain('NO MERGE ATTESTATION');
  });
});

describe('fmtNext — recorded intentions lead the up-next section (ADR 373 increment 4)', () => {
  const seeds: NextBrief['up_next_seeds'] = [
    {
      id: '01SEED1',
      source: 'repo',
      ref: 'docs/decisions/354-x.md#left-for-a-sibling-lane',
      summary: 'Left for a sibling lane; this ADR fixes the attestation.',
      submitted_by: 'nick',
      captured_at: 1_788_000_000_000,
    },
  ];

  it('renders the ref as the source tag and says how to take it', () => {
    const b = brief(null);
    b.up_next_seeds = seeds;
    b.up_next_seeds_total = 31;
    const out = fmtNext(b);
    expect(out).toContain('recorded intentions nobody has started (1 of 31)');
    expect(out).toContain('docs/decisions/354-x.md#left-for-a-sibling-lane');
    expect(out).toContain('team_seed_update {action:"claim", id:"01SEED1"}');
  });

  it('names the submitter when there is no document — a relay Seed came from a person', () => {
    const b = brief(null);
    b.up_next_seeds = [{ ...seeds[0]!, ref: null }];
    b.up_next_seeds_total = 1;
    const out = fmtNext(b);
    expect(out).toContain('from nick');
    expect(out).not.toContain('of 1)');
  });

  it('a brief with only Seeds is not "nothing in flight"', () => {
    const b = brief(null);
    b.up_next_seeds = seeds;
    b.up_next_seeds_total = 1;
    expect(fmtNext(b)).not.toContain('nothing in flight');
    expect(fmtNext(brief(null))).toContain('nothing in flight');
  });
});

/**
 * Lane 01M2XAXRP3: a carried lane whose work is already on main is reported as UNSUBMITTED, with
 * the evidence and the next act, on the carrying line itself. Measured 2026-09-19: miley's seat
 * memory said "carrying" for three lanes that had shipped (#1474, #1500, #1550) and orientation
 * read the note before the board or the repo. The reconciliation is seat-side git
 * (`landed.ts`); this pins that the brief SAYS it once it knows.
 */
describe('fmtNext — a carried lane whose work landed is unsubmitted, not carried', () => {
  function carrying(): NextBrief {
    const b = brief(null);
    b.in_flight = [
      {
        id: '01M2M75BQH81NH40WJ69DZXY1W',
        state: 'claimed',
        title: '/watch',
        owner_seat: 'miley',
        project: 'agents',
        scope: [],
        depends_on: [],
        branch: 'miley/watch-page',
        goal_id: null,
        merged: null,
      } as unknown as Lane,
      {
        id: '01M2RTF9F2NJEA5ABNK77VD02A',
        state: 'active',
        title: 'sprite cache',
        owner_seat: 'miley',
        project: 'agents',
        scope: [],
        depends_on: [],
        branch: null,
        goal_id: null,
        merged: null,
      } as unknown as Lane,
    ];
    return b;
  }

  it('marks the landed lane with its evidence and names lane_submit as the next act', () => {
    const out = fmtNext(
      carrying(),
      new Map([
        ['01M2M75BQH81NH40WJ69DZXY1W', { evidence: 'main cites it: 83015333 /watch (#1474)' }],
      ]),
    );
    const lines = out.split('\n');
    const at = lines.findIndex((l) => l.includes('01M2M75BQH81NH40WJ69DZXY1W'));
    expect(lines[at + 1]).toContain('LANDED, unsubmitted — main cites it: 83015333 /watch (#1474)');
    expect(lines[at + 2]).toContain("lane_submit {id:'01M2M75BQH81NH40WJ69DZXY1W'");
    // The other carried lane is untouched — absent evidence is silence, never "not landed".
    const other = lines.findIndex((l) => l.includes('01M2RTF9F2NJEA5ABNK77VD02A'));
    expect(lines[other + 1] ?? '').not.toContain('LANDED');
  });

  it('renders exactly as before when nothing is reconciled (default argument)', () => {
    expect(fmtNext(carrying())).not.toContain('LANDED');
  });
});

/** ADR 664: carried work no wake will reach is said under the lane in the owner's own brief. */
describe('fmtNext — a carried lane no wake will reach (ADR 664)', () => {
  it('says NO WAKE DUE under the stalled lane only', () => {
    const b = brief(null);
    b.in_flight = [
      { id: '01STALLED', state: 'claimed', title: 'pick 5', owner_seat: 'mason' },
      { id: '01MOVING', state: 'active', title: 'other', owner_seat: 'mason' },
    ].map(
      (l) =>
        ({
          project: 'p',
          scope: [],
          depends_on: [],
          branch: null,
          goal_id: null,
          merged: null,
          ...l,
        }) as unknown as Lane,
    );
    b.stalled_continuations = [
      {
        kind: 'stalled_continuation',
        subject: '01STALLED',
        with: '01STALLED',
        owner: null,
        detail: 'moved nothing',
      },
    ];
    const lines = fmtNext(b).split('\n');
    const at = lines.findIndex((l) => l.includes('01STALLED'));
    expect(lines[at + 1]).toContain('NO WAKE DUE — moved nothing');
    const other = lines.findIndex((l) => l.includes('01MOVING'));
    expect(lines[other + 1] ?? '').not.toContain('NO WAKE DUE');
  });
});

describe('fmtNext — review promises (ADR 490)', () => {
  const H = 3_600_000;
  const PR = { kind: 'pr', repo: 'org/repo', number: 42 } as const;
  const supported = (): NextBrief => ({
    ...brief(null),
    request_reviews: [],
    requested_reviews: [],
    review_closures: [],
  });

  it('shows what the reader accepted, with the context, the artifact and the close call', () => {
    const b = supported();
    b.request_reviews = [
      {
        request_id: 'req1',
        requester: 'nick',
        owner: 'miley',
        context: 'please check the migration',
        review: PR,
        accepted_at: Date.now() - 2 * H,
      },
    ];
    const out = fmtNext(b);
    expect(out).toContain('review promises — 1 you accepted, still open:');
    expect(out).toContain('req1 for nick · accepted 2h ago');
    expect(out).toContain('"please check the migration" · PR org/repo#42');
    expect(out).toContain("team_send {act:'resolve', thread:'req1'");
    expect(out).not.toContain('nothing in flight');
  });

  it('shows what the reader asked for — who accepted and how long ago — in the daemon order', () => {
    const b = supported();
    b.requested_reviews = [
      {
        request_id: 'req1',
        requester: 'miley',
        owner: 'stanley',
        context: 'older',
        review: { kind: 'lane', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        accepted_at: Date.now() - 3 * 24 * H,
      },
      {
        request_id: 'req2',
        requester: 'miley',
        owner: 'izzo',
        context: 'newer',
        review: { kind: 'commit', repo: 'org/repo', sha: 'a'.repeat(40), path: 'src/x.ts' },
        accepted_at: Date.now() - H,
      },
    ];
    const out = fmtNext(b);
    expect(out).toContain('reviews you asked for — 2 accepted, still open:');
    expect(out.indexOf('req1 stanley accepted 3d ago')).toBeLessThan(
      out.indexOf('req2 izzo accepted 1h ago'),
    );
    expect(out).toContain('"older" · lane 01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(out).toContain('"newer" · org/repo@aaaaaaa src/x.ts');
    expect(out).not.toContain('review promises —');
  });

  it('shows a close by someone other than the owner, once, with the resolve to read', () => {
    const b = supported();
    b.review_closures = [
      { request_id: 'req1', resolve_id: 'done1', closer: 'nick', resolved_at: Date.now() - H },
    ];
    const out = fmtNext(b);
    expect(out).toContain('review closed for you — by someone else, 1:');
    expect(out).toContain('req1 closed by nick 1h ago');
    expect(out).toContain('resolve done1 — team_inbox_check and it is gone');
  });

  it('absent arrays are an older daemon and say so; empty arrays are quiet', () => {
    const legacy = fmtNext(brief(null));
    expect(legacy).toContain('review promises: not reported by this daemon');
    expect(legacy).toContain('nothing in flight');
    const empty = fmtNext(supported());
    expect(empty).not.toContain('review');
    expect(empty).toContain('nothing in flight');
  });
});

/** ADR 536 §4.5 — the up-next window says how much it is a window on, in `musterd next`'s words. */
describe('fmtNext — up next says how many were claimable and how many wait (ADR 536)', () => {
  const open = (id: string): Lane =>
    ({
      id,
      state: 'open',
      title: id,
      owner_seat: null,
      project: 'runtime',
      scope: [],
      depends_on: [],
      branch: null,
      goal_id: null,
      merged: null,
    }) as unknown as Lane;

  it('a window on a deeper pool: "N of M claimable · K more wait on a dependency"', () => {
    const b = brief(null);
    b.up_next = [open('L1'), open('L2')];
    b.up_next_total = 30;
    b.up_next_blocked_total = 44;
    expect(fmtNext(b)).toContain(
      'up next — open lanes you could pick up (2 of 30 claimable · 44 more wait on a dependency):',
    );
  });

  it('the whole pool shown, nothing blocked: "all N claimable" and no dependency clause', () => {
    const b = brief(null);
    b.up_next = [open('L1'), open('L2')];
    b.up_next_total = 2;
    b.up_next_blocked_total = 0;
    expect(fmtNext(b)).toContain('up next — open lanes you could pick up (all 2 claimable):');
  });

  it('an older daemon reports no counts (both 0): the line is as it always was, not zero-filled', () => {
    const b = brief(null);
    b.up_next = [open('L1')];
    expect(fmtNext(b)).toContain('up next — open lanes you could pick up:');
    expect(fmtNext(b)).not.toContain('claimable');
  });
});

/** ADR 536 increment 2 — the shortlist explains itself, one tag per offered lane. */
describe('fmtNext — up next carries the why tag (ADR 536 increment 2)', () => {
  const open = (id: string): Lane =>
    ({
      id,
      state: 'open',
      title: id,
      owner_seat: null,
      project: 'runtime',
      scope: [],
      depends_on: [],
      branch: null,
      goal_id: null,
      merged: null,
    }) as unknown as Lane;

  it('joins the server reasons with · after the lane line; a tier-5 lane carries no tag', () => {
    const b = brief(null);
    b.up_next = [open('L1'), open('L2')];
    b.up_next_why = [
      { lane: 'L1', tier: 2, reasons: ['role: platform', 'near what you shipped'] },
      { lane: 'L2', tier: 5, reasons: [] },
    ];
    const out = fmtNext(b);
    const l1 = out.split('\n').find((l) => l.includes('L1 [open]'))!;
    const l2 = out.split('\n').find((l) => l.includes('L2 [open]'))!;
    expect(l1).toMatch(/ · role: platform · near what you shipped$/);
    expect(l2).not.toContain(' · ');
  });

  it('an older daemon sends no up_next_why: the line is as it always was', () => {
    const b = brief(null);
    b.up_next = [open('L1')];
    expect(
      fmtNext(b)
        .split('\n')
        .find((l) => l.includes('L1 [open]')),
    ).not.toContain(' · ');
  });
});
