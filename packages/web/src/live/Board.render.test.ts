import type { Lane, MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Board } from './Board';

const lane = {
  id: 'lane_areas',
  title: 'Show areas on the board',
  owner_seat: 'dreamy',
  state: 'claimed',
  goal_id: 'find-work',
  areas: ['ui', 'server'],
  scope: ['packages/web/src/live/**'],
  depends_on: [],
  project: 'runtime',
  risk: [],
  stakes: 'normal',
  created_at: 0,
  updated_at: 0,
  claimed_at: 0,
} as unknown as Lane;

describe('Board area chips (ADR 582 §3)', () => {
  it('shows each area next to the goal chip', () => {
    const html = renderToStaticMarkup(
      createElement(Board, {
        lanes: [lane],
        warnings: [],
        view: 'columns',
        goals: [],
        roster: [] as MemberSummary[],
        me: null,
        busyId: null,
        composing: false,
        onComposeClose: () => {},
        onCreate: async () => true,
        onPatch: async () => true,
      }),
    );
    expect(html).toContain('find-work');
    expect(html).toContain('>ui<');
    expect(html).toContain('>server<');
  });
});
