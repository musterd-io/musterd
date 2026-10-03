import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHIP_BG,
  CHIP_GLYPH_PATH,
  CHIP_RING_PATH,
  musterdChipSvg,
} from './chipMark';

const asset = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * ADR 497: the mark is one geometry in three files (the module, the docs asset, the web asset) and
 * the old chip's six hand-copied paths are exactly how it drifted. The files are the design source;
 * these tests make the module — and the favicon — agree with them.
 */
describe('the mark (ADR 497)', () => {
  it('keeps the brand accent as its ground, not the logo-art yellow', () => {
    expect(CHIP_BG).toBe('#E1AD01');
  });

  it.each([
    ['web chip.svg', './chip.svg'],
    ['docs chip.svg', '../../../../docs/design/assets/chip.svg'],
  ])('%s carries the module geometry', (_name, rel) => {
    const svg = asset(rel);
    expect(svg).toContain(CHIP_RING_PATH);
    expect(svg).toContain(CHIP_GLYPH_PATH);
    expect(svg).toContain('fill="#E1AD01"');
    // The full cut is the file's: it carries the hairline outlines the code does not.
    expect(svg.length).toBeGreaterThan(8000);
  });

  it.each([
    ['web chip-sm.svg', './chip-sm.svg'],
    ['docs chip-sm.svg', '../../../../docs/design/assets/chip-sm.svg'],
  ])('%s is the outline-free cut over the same ring and glyph', (_name, rel) => {
    const svg = asset(rel);
    expect(svg).toContain(CHIP_RING_PATH);
    expect(svg).toContain(CHIP_GLYPH_PATH);
    expect(svg.length).toBeLessThan(6000);
  });

  it('renders the thickened, outline-free cut, hidden from assistive tech', () => {
    const svg = musterdChipSvg(13);
    expect(svg).toContain(CHIP_RING_PATH);
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('aria-hidden="true"');
  });

  it('web and docs copies of each file are byte-identical', () => {
    for (const f of ['chip.svg', 'chip-sm.svg', 'tile.svg']) {
      expect(asset(`./${f}`)).toBe(asset(`../../../../docs/design/assets/${f}`));
    }
  });
});
