import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  WORDMARK_BOX,
  WORDMARK_INK,
  WORDMARK_PATH,
  WORDMARK_PLATE,
  WORDMARK_RIM,
  WORDMARK_SEATS,
  WORDMARK_SEAT_RADIUS,
  WORDMARK_SPARK,
  musterdWordmarkSvg,
} from './wordmarkMark';

const asset = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * ADR 704: the wordmark is one geometry in three places (the module, the docs asset, the web
 * asset). The files are the design source; these tests make the module agree with them.
 */
describe('the wordmark (ADR 704)', () => {
  it.each([
    ['web wordmark.svg', './wordmark.svg'],
    ['docs wordmark.svg', '../../../../docs/design/assets/wordmark.svg'],
  ])('%s carries the module geometry and colours', (_name, rel) => {
    const svg = asset(rel);
    const { x, y, w, h } = WORDMARK_BOX;
    expect(svg).toContain(`viewBox="${x} ${y} ${w} ${h}"`);
    expect(svg).toContain(`d="${WORDMARK_PATH}"`);
    expect(svg).toContain(`fill="${WORDMARK_PLATE}"`);
    expect(svg).toContain(`stroke="${WORDMARK_RIM}"`);
    expect(svg).toContain(`stroke="${WORDMARK_INK}"`);
    expect(svg).toContain(`fill="${WORDMARK_SPARK}"`);
    expect(svg).not.toContain('font-family');
    for (const [cx, cy] of WORDMARK_SEATS) {
      expect(svg).toContain(`<circle cx="${cx}" cy="${cy}" r="${WORDMARK_SEAT_RADIUS}"`);
    }
  });

  it('web and docs copies are byte-identical', () => {
    expect(asset('./wordmark.svg')).toBe(asset('../../../../docs/design/assets/wordmark.svg'));
  });

  it('renders as markup with a name and no font', () => {
    const svg = musterdWordmarkSvg(28);
    expect(svg).toContain('aria-label="musterd"');
    expect(svg).toContain('height="28"');
    expect(svg).toContain(`d="${WORDMARK_PATH}"`);
    expect(svg).not.toContain('font-family');
  });
});
