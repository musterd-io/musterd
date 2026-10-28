import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DwellLog } from './dwell';
import { RosterPanel } from './RosterPanel';

/**
 * What the roster RENDERS for a seat living on another machine (presence replication, ADR 356).
 *
 * Rendered with `react-dom/server` and no DOM, for the reasons `AsksStrip.render.test.ts` sets out
 * at length: React is already here, a headless browser costs a Chromium per run, and the question
 * is the markup rather than the paint. Effects never run, so every claim below is render-time.
 *
 * The claim under test is narrow and worth stating precisely: the node suffix is a fact about
 * WHERE, and it must appear only when that fact is news. A row on this daemon carries `node: null`
 * and gets nothing, because the machine you are already looking at is not information.
 */

const seat = (over: Partial<MemberSummary> = {}): MemberSummary =>
  ({
    // The row keys on `id`, so the fixture carries one — without it React warns about a missing
    // key and the noise reads like a product defect in every future run of this file.
    id: 'm_stanley',
    name: 'stanley',
    kind: 'agent',
    presence: 'online',
    posture: 'working',
    presences: [],
    capabilities: {},
    ...over,
  }) as unknown as MemberSummary;

const presence = (over: Record<string, unknown> = {}) =>
  ({ surface: 'claude-code', node: null, node_label: null, ...over }) as never;

const render = (roster: MemberSummary[]) =>
  renderToStaticMarkup(createElement(RosterPanel, { roster }));

describe('RosterPanel — the machine a seat lives on', () => {
  it('names the node beside the posture chip when the seat is on another machine', () => {
    const html = render([
      seat({ presences: [presence({ node: 'n_b', node_label: 'laptop-b' })] }),
    ]);
    expect(html).toContain('lc-stat__node');
    expect(html).toContain('@ laptop-b');
  });

  it('says WHERE in the chip tooltip too, so the suffix is not the only carrier', () => {
    const html = render([
      seat({ presences: [presence({ node: 'n_b', node_label: 'laptop-b' })] }),
    ]);
    expect(html).toContain('on laptop-b');
  });

  it('stays silent for a local row — the machine you are on is not news', () => {
    const html = render([seat({ presences: [presence()] })]);
    expect(html).not.toContain('lc-stat__node');
    expect(html).not.toContain(' @ ');
  });

  it('stays silent when the seat has no presence at all', () => {
    const html = render([seat({ presence: 'offline', posture: 'offline', presences: [] })]);
    expect(html).not.toContain('lc-stat__node');
  });

  /**
   * A replicated node row can arrive with an id and no label — the label lives on the `nodes` row
   * the presence LEFT JOINs to, so a node this daemon has not synced yet joins to null. Printing
   * the raw id would put a ULID in the roster; printing nothing is the honest fallback, since the
   * seat's own posture is unaffected by our not knowing the machine's name.
   */
  it('prints nothing rather than a raw node id when the label has not synced', () => {
    const html = render([seat({ presences: [presence({ node: 'n_b', node_label: null })] })]);
    expect(html).not.toContain('lc-stat__node');
    expect(html).not.toContain('n_b');
  });

  /**
   * `presences` is ordered `last_seen_at DESC` server-side (presence.ts:461), so index 0 is the
   * machine the seat was most recently seen on. This pins that the chip follows that order rather
   * than insertion or an arbitrary pick — the CLI reads `presences[0]` for the same reason
   * (render/rows.ts:352), and the two surfaces disagreeing about where someone is would be worse
   * than either being wrong alone.
   */
  it('names the most recently seen machine when a seat is present on two', () => {
    const html = render([
      seat({
        presences: [
          presence({ node: 'n_b', node_label: 'laptop-b' }),
          presence({ node: 'n_c', node_label: 'laptop-c' }),
        ],
      }),
    ]);
    expect(html).toContain('@ laptop-b');
    expect(html).not.toContain('laptop-c');
  });
});

/**
 * The contrast gate cannot see this suffix, and that is worth pinning rather than hoping about.
 *
 * `a11y:check` sweeps `/live` connected against the fixture team (scripts/a11y/fixture-team.sh),
 * and that team runs on ONE daemon — every seat it seats carries `node: null`, so no fixture row
 * ever renders `.lc-stat__node`. Seeding one would take a second daemon and a replicated presence,
 * which is federation machinery for a fixture, and I am not spending that here.
 *
 * What makes the blindness harmless is a property of the rule rather than a fact about the fixture:
 * the suffix declares NO colour and NO alpha, so it inherits the chip's ink and paints at exactly
 * the ratio the gate already measures on the label beside it, on every row, every run. That holds
 * only as long as nobody adds `color` or `opacity` — which is precisely the edit a future reader
 * would make to "quieten" it, and precisely the edit no gate would catch.
 *
 * So: read the stylesheet and fail on it. The reason the fix is weight-and-tracking rather than an
 * alpha pass is in the rule's own comment; this is the test that keeps it that way.
 */
const css = readFileSync(fileURLToPath(new URL('./Live.css', import.meta.url)), 'utf8');

describe('.lc-stat__node stays inside what the contrast gate can measure', () => {
  const rule = /\.lc-stat__node\s*\{([^}]*)\}/.exec(css)?.[1];

  it('exists as a rule at all', () => {
    expect(rule).toBeDefined();
  });

  it('declares no colour of its own — it inherits the chip ink the gate already measures', () => {
    expect(rule).not.toMatch(/(^|[;\s])color\s*:/);
  });

  it('declares no alpha — an opacity pass over the faintest chip ink lands below AA', () => {
    expect(rule).not.toMatch(/(^|[;\s])opacity\s*:/);
  });
});

/**
 * A woken seat says so on the roster (ADR 131 residency + ADR 356 provenance).
 *
 * The chip rides ALONGSIDE the posture rather than replacing it — posture is what the seat is
 * doing, provenance is why it is in the room at all, and a wake can be `working` or `active` like
 * anything else. `wokenSeat.test.ts` holds the derivation; these two pin that the roster actually
 * paints it, and that a seat nobody woke stays quiet.
 */
describe('RosterPanel — a woken seat says so', () => {
  const wokenSeatRow = (provenance: string | null) =>
    seat({
      presences: [
        { status: 'online', surface: 'codex', provenance, last_seen_at: Date.now() } as never,
      ],
    });

  it('marks a seat a wake put in the room, without dropping its posture', () => {
    const html = render([wokenSeatRow('wake')]);
    expect(html).toContain('woken');
    expect(html).toContain('working');
  });

  it('stays quiet for a seat someone opened themselves', () => {
    expect(render([wokenSeatRow('session')])).not.toContain('woken');
  });

  it(' stays quiet when the row never said — absence is not an assertion', () => {
    expect(render([wokenSeatRow(null)])).not.toContain('woken');
  });
});

describe('RosterPanel — a live deaf seat says so (ADR 558 §5)', () => {
  it('renders the `live · deaf` chip with its reason when hearing is deaf', () => {
    const html = render([
      seat({
        presences: [presence({ hearing: 'deaf', hearing_reason: 'no-inject:cursor' })],
      }),
    ]);
    expect(html).toContain('live · deaf (no-inject:cursor)');
  });

  it('stays quiet when hearing is idle or absent', () => {
    expect(render([seat({ presences: [presence({ hearing: 'idle' })] })])).not.toContain(
      'live · deaf',
    );
    expect(render([seat({ presences: [presence()] })])).not.toContain('live · deaf');
  });
});

describe('RosterPanel — a seat a human reported says so (ADR 676 §8)', () => {
  it('flags the seat, with the count once it recurs', () => {
    const one = render([seat({ reported_asks: { count: 1, last_at: 1_792_600_000_000 } })]);
    expect(one).toContain('lc-stat--reported');
    expect(one).toContain('>reported<');
    expect(one).toContain('Nothing is blocked');
    const three = render([seat({ reported_asks: { count: 3, last_at: 1_792_600_000_000 } })]);
    expect(three).toContain('reported ×3');
    expect(three).toContain('3 asks');
  });

  it('stays quiet when nobody reported it, or the daemon did not say', () => {
    expect(render([seat({ reported_asks: null })])).not.toContain('lc-stat--reported');
    expect(render([seat()])).not.toContain('lc-stat--reported');
  });

  // The contrast gate's fixture never reports an ask, so it cannot paint this chip. It borrows the
  // `halted` recipe, which the gate does measure; keeping the two identical keeps that evidence.
  it('paints exactly the measured `halted` ink and fill', () => {
    const body = (sel: string) =>
      new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css)?.[1]?.trim();
    expect(body('.lc-stat--reported')).toBeDefined();
    expect(body('.lc-stat--reported')).toBe(body('.lc-stat--halted'));
  });
});

/**
 * Both `woken` marks stay fill-free, for a margin that is measured even though the chip is not.
 *
 * `--lc-accent-ink` is 4.60:1 worst case (Live.css:113) — a tenth of a point over AA. The `dnd`
 * tag's comment records what a tint does to that kind of margin: a 14% amber under `--lc-warn-ink`
 * lightened the ground and took 5.11 to 4.35. At 4.60 there is no tint that survives.
 *
 * And the gate cannot check this for us on the roster. Its fixture joins every seat with a TEAM
 * BOOTSTRAP key (`mskey_`), while provenance rides an agent-seat credential gate (`msac_`,
 * cli/src/client.ts:321) because it is a harness fact a human must not stamp (ADR 121). Seeding a
 * woken row into the fixture was tried and the gate correctly refused it — so no `a11y:check` run
 * will ever render `.lc-stat--woken`, and the guard has to live here.
 *
 * The office nameplate's `woken` tag IS swept, through /office-preview, and uses the same ink and
 * the same recipe. Keeping the two identical is what makes that sweep evidence for this chip.
 */
describe('the woken marks stay fill-free — 4.60:1 leaves no room for a tint', () => {
  // The office nameplate's tag left this recipe on 2026-10-09 (nick: "make woken slightly more
  // prominent"): it is a solid indigo pill under WHITE text, pinned below. Light text on a fill is
  // not the tint-under-dark-ink case this guard exists for. The roster chip keeps the ink recipe,
  // and the /office-preview sweep is no longer evidence for it — this guard is.
  for (const selector of ['.lc-stat--woken']) {
    const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1];

    it(`${selector} exists`, () => {
      expect(rule).toBeDefined();
    });

    it(`${selector} paints no background tint`, () => {
      expect(rule).not.toMatch(/background\s*:\s*color-mix/);
      expect(rule).not.toMatch(/background\s*:\s*(?!transparent)[a-z#]/i);
    });

    it(`${selector} carries the accent INK, never the accent fill`, () => {
      expect(rule).toMatch(/color:\s*var\(--lc-accent-ink\)/);
    });
  }
});

describe('the nameplate woken tag is a solid pill under white text', () => {
  const rule = /\.lc-gl-label__woken\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  it('fills with the woken indigo and sets light text on it', () => {
    expect(rule).toMatch(/--lc-woken-fill:\s*#4b43b8/);
    expect(rule).toMatch(/background:\s*var\(--lc-woken-fill\)/);
    expect(rule).toMatch(/color:\s*#fff/);
  });
});

/**
 * A short visit leaves a trace after it ends (lane 01M1JQENBK).
 *
 * The claim worth pinning is the honesty one, not the feature one: the trace is past tense, it
 * carries a real elapsed time, and it NEVER appears on a seat that is still here. A trace on a
 * present seat would be the surface saying someone left who has not, which is the failure this
 * whole design is arranged around.
 */
describe('the dwell trace', () => {
  const T0 = 1_700_000_000_000;

  const withDwell = (roster: MemberSummary[], dwell: DwellLog, now: number) =>
    renderToStaticMarkup(createElement(RosterPanel, { roster, dwell, dwellNow: now }));

  it('says a departed seat was here, and how long ago it left', () => {
    const html = withDwell(
      [seat({ name: 'gptbot', presence: 'offline', posture: 'offline' })],
      { gptbot: { arrivedAt: T0, lastOnlineAt: T0 + 11_000, departed: true } },
      T0 + 11_000 + 9_000,
    );
    expect(html).toContain('was here · left 9s ago');
  });

  it('says nothing about a seat that is still in the room', () => {
    const html = withDwell(
      [seat({ name: 'gptbot', presence: 'online', posture: 'working' })],
      { gptbot: { arrivedAt: T0, lastOnlineAt: T0 + 11_000 } },
      T0 + 11_000,
    );
    expect(html).not.toContain('was here');
  });

  it('claims no duration for a seat that was already here when the page loaded', () => {
    // The log this page actually builds for that seat: a last-seen, and no arrival to measure from.
    const html = withDwell(
      [seat({ name: 'gptbot', presence: 'offline', posture: 'offline' })],
      { gptbot: { lastOnlineAt: T0 + 8_000, departed: true } },
      T0 + 9_000,
    );
    expect(html).toContain('was here · left 1s ago');
    expect(html).not.toContain('in the room for');
    expect(html).not.toContain('Watched from this page');
  });

  it('says nothing about a seat it has only ever read absent', () => {
    const html = withDwell(
      [seat({ name: 'gptbot', presence: 'offline', posture: 'offline' })],
      { gptbot: { departed: true } },
      T0,
    );
    expect(html).not.toContain('was here');
  });

  it('renders nothing at all when no dwell log is passed — every other surface is untouched', () => {
    const html = renderToStaticMarkup(
      createElement(RosterPanel, {
        roster: [seat({ name: 'gptbot', presence: 'offline', posture: 'offline' })],
      }),
    );
    expect(html).not.toContain('was here');
  });
});

/** The trace must stay inside what the contrast gate can measure — same rule as `.lc-stat__node`. */
describe('.lc-roster__dwell', () => {
  const rule = /\.lc-roster__dwell\s*\{([^}]*)\}/.exec(css)?.[1];

  it('exists as a rule at all', () => {
    expect(rule).toBeDefined();
  });

  it('declares no alpha — an opacity pass over the faintest ink lands below AA', () => {
    expect(rule).not.toMatch(/(^|[;\s])opacity\s*:/);
  });
});

describe('the stored hue reaches the roster avatar (ADR 374)', () => {
  it('fills the monogram from the roster hue, not the name hash', () => {
    const html = renderToStaticMarkup(
      createElement(RosterPanel, {
        roster: [seat({ name: 'gptbot', presence: 'online', posture: 'working', hue: 212 })],
      }),
    );
    expect(html).toMatch(/background:hsl\(212, 70%/);
  });
});

/**
 * ADR 501 increment 3 — a halted seat says so, and the halt/resume buttons render from the
 * server-computed `can_halt` ALONE: never from the viewer's role in this client, and never for a
 * viewer who has not signed in (no `cfg`). The badge is the fact; the buttons are the authority.
 */
describe('RosterPanel — halt as revocation (ADR 501)', () => {
  const cfg = { team: 'dawn', as: 'nick', token: 'mscr_x' };
  const halted = { at: 1, by: 'nick', reason: 'looping on the wrong lane' };
  const withCfg = (roster: MemberSummary[]) =>
    renderToStaticMarkup(createElement(RosterPanel, { roster, cfg }));

  it('paints the halted badge with who and why, for any viewer', () => {
    const html = render([seat({ presence: 'offline', posture: 'offline', halted } as never)]);
    expect(html).toContain('lc-stat--halted');
    expect(html).toContain('halted by nick: looping on the wrong lane');
  });

  it('shows the halt button only when the daemon says this viewer may halt', () => {
    expect(withCfg([seat({ can_halt: true } as never)])).toContain('lc-seat__halt');
    expect(withCfg([seat({ can_halt: false } as never)])).not.toContain('lc-seat__halt');
    expect(withCfg([seat({} as never)])).not.toContain('lc-seat__halt');
  });

  it('offers resume instead of halt while the seat is halted', () => {
    const html = withCfg([seat({ can_halt: true, halted } as never)]);
    expect(html).toContain('lc-seat__halt--resume');
    expect(html).toContain('>resume<');
    expect(html).not.toContain('>halt<');
  });

  it('renders no button at all for a viewer who has not signed in, whatever can_halt says', () => {
    expect(render([seat({ can_halt: true } as never)])).not.toContain('lc-seat__halt');
  });
});

describe('.lc-stat--halted stays inside what the contrast gate can measure', () => {
  const rule = /\.lc-stat--halted\s*\{([^}]*)\}/.exec(css)?.[1];
  it('exists as a rule at all', () => {
    expect(rule).toBeDefined();
  });
  it('declares no alpha', () => {
    expect(rule).not.toMatch(/(^|[;\s])opacity\s*:/);
  });
});
