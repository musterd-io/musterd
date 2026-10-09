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

  it('keeps the room’s agent/human tell: an agent wears the visor, a human does not', () => {
    expect(face('miley')).toContain('#242d33');
    expect(face('nick')).not.toContain('#242d33');
  });
});
