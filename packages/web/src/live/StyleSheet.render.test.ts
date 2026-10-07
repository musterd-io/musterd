import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MyStyle, TeamPolicyRead } from './client';
import { StyleSheetView } from './StyleSheet';

/** ADR 514 inc 5: the /board sheet renders the daemon's answer — the first frame, no DOM. */
describe('StyleSheetView', () => {
  const dials = {
    pushback: 'when-it-matters',
    bluntness: 'plain',
    length: 'normal',
    format: 'prose',
  } as const;
  const floor = {
    assess_before_agreeing: true,
    disagree_once_then_commit: true,
    concession_names_check: true,
    human_critique_weighed_as_peer: true,
  };
  const mine: MyStyle = {
    member: 'nick',
    prefs: { length: 'concise', prose: 'skip the recap' },
    resolved: {
      floor,
      dials: { ...dials, length: 'concise' },
      team_dials: dials,
      team_prose: '',
      human_prose: 'skip the recap',
      epoch: 'abcd1234',
    },
    block: 'Style (epoch abcd1234) — how you talk here.',
  };
  const noop = () => undefined;
  const html = (m: MyStyle | null, team: TeamPolicyRead | null = null) =>
    renderToStaticMarkup(
      createElement(StyleSheetView, {
        mine: m,
        team,
        busy: false,
        note: null,
        onDial: noop,
        onProse: noop,
        onTeam: noop,
      }),
    );

  it('says it is reading before the daemon answers', () => {
    expect(html(null)).toContain('Reading how agents talk to you');
  });

  it('marks the dial you set as yours, with a way back; the rest read team default', () => {
    const out = html(mine);
    expect(out).toContain('How agents talk to me');
    expect(out).toContain('yours · use the team’s');
    expect(out.match(/team default</g)?.length).toBe(3);
    // the resolved value is checked; the team's own value carries the team mark
    expect(out).toMatch(/aria-checked="true"[^>]*>concise</);
    expect(out).toMatch(/lc-style__opt--team"[^>]*>normal</);
  });

  it('shows your words, the line count, the floor read-only and the block a seat reads', () => {
    const out = html(mine);
    expect(out).toContain('skip the recap');
    expect(out).toContain('1 / 5 lines');
    expect(out).toContain('assess before you agree');
    expect(out).not.toContain('type="checkbox"');
    expect(out).toContain('Style (epoch abcd1234)');
  });

  it('says how many floor rules an admin turned off, and prints the team prose', () => {
    const out = html({
      ...mine,
      resolved: {
        ...mine.resolved,
        floor: { ...floor, concession_names_check: false },
        team_prose: 'ship small',
      },
    });
    expect(out).toContain('1 of 4 turned off by an admin');
    expect(out).not.toContain('a concession names what you checked');
    expect(out).toContain('ship small');
  });

  it('no team part without the admin read; with it, each knob says default or set for the team', () => {
    expect(html(mine)).not.toContain('admin</span>');
    const team: TeamPolicyRead = {
      policy: { style: { floor, defaults: { ...dials, length: 'thorough' }, prose: '' } },
      stored: { style: { defaults: { length: 'thorough' } } },
    };
    const out = html(mine, team);
    expect(out).toContain('The team’s floor and defaults');
    expect(out.match(/type="checkbox"/g)?.length).toBe(4);
    expect(out.match(/set for the team</g)?.length).toBe(1);
    // 4 floor + 3 dials + prose = 8 knobs still at the shipped default
    expect(out.match(/>default</g)?.length).toBe(8);
  });
});
