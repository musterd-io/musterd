import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { rosterIndex } from './format';
import { MemberFace } from './MemberFace';
import { appearanceOf } from './office-scene/appearance';

const roster = rosterIndex([
  { name: 'miley', kind: 'agent', hue: 260 },
  { name: 'nick', kind: 'human', hue: 40 },
] as unknown as MemberSummary[]);
const face = (name: string) => renderToStaticMarkup(createElement(MemberFace, { name, roster }));

describe('MemberFace', () => {
  it('draws the skin the office gives the member, and names them for a screen reader', () => {
    const html = face('nick');
    expect(html).toContain(appearanceOf({ name: 'nick', kind: 'human' }).skin);
    expect(html).toContain('aria-label="nick"');
    expect(html).toContain('<title>nick</title>');
  });

  it('keeps the room’s agent/human tell in the figure v2 form: an agent’s eyes glow in its colour, no visor', () => {
    expect(face('miley')).not.toContain('#242d33'); // the visor left with figure v2-1
    expect(face('miley')).toContain('opacity="0.35"'); // the glow halo
    expect(face('nick')).not.toContain('opacity="0.35"');
  });

  it('wears every spot the wardrobe deals — glasses, headphones and a scarf can show together', () => {
    const names = Array.from({ length: 300 }, (_, i) => `person${i}`);
    const big = rosterIndex(names.map((name) => ({ name, kind: 'human', hue: 40 })) as unknown as MemberSummary[]);
    const html = (name: string) => renderToStaticMarkup(createElement(MemberFace, { name, roster: big }));
    const spots = (name: string) => (html(name).match(/data-spot="(eyes|ears|neck)"/g) ?? []).length;
    for (const name of names) {
      const look = appearanceOf({ name, kind: 'human' });
      const worn = [look.eyes, look.ears, look.neck].filter((x) => x !== 'none').length;
      expect(spots(name)).toBe(worn);
      if (look.eyes === 'glasses') expect(html(name)).toContain(`stroke="${look.accessoryColor}"`);
    }
    expect(names.some((n) => spots(n) >= 2)).toBe(true);
  });
});
