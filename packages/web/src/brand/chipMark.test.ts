import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHIP_DOTS,
  CHIP_DOT_RADIUS,
  CHIP_FG,
  CHIP_GLYPH_PATH,
  CHIP_RADIUS,
  CHIP_SMALL_DOT_EXTRA,
  CHIP_SMALL_EXTRA,
  CHIP_SOLID_BG,
  CHIP_STROKE,
  musterdChipSvg,
} from './chipMark';

const asset = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * ADR 702: the mark is one geometry in several files (the module, the docs assets, the web assets)
 * and the old chip's hand-copied paths are exactly how it drifted. The files are the design source;
 * these tests make the module agree with them.
 */
describe('the mark (ADR 702)', () => {
  it('is a gold glass tile with a solid apricot fallback, and cool ink', () => {
    expect(CHIP_SOLID_BG).toBe('#F9DDA0');
    expect(CHIP_FG).toBe('#2E3647');
    expect(CHIP_RADIUS).toBe(307);
  });

  it.each([
    ['chip.svg', CHIP_STROKE, CHIP_DOT_RADIUS],
    ['chip-sm.svg', CHIP_STROKE + CHIP_SMALL_EXTRA, CHIP_DOT_RADIUS + CHIP_SMALL_DOT_EXTRA],
    ['chip-glass.svg', CHIP_STROKE, CHIP_DOT_RADIUS],
    ['chip-glass-sm.svg', CHIP_STROKE + CHIP_SMALL_EXTRA, CHIP_DOT_RADIUS + CHIP_SMALL_DOT_EXTRA],
  ])('%s carries the module geometry at its own weight', (name, stroke, dot) => {
    for (const rel of [`./${name}`, `../../../../docs/design/assets/${name}`]) {
      const svg = asset(rel);
      expect(svg).toContain(`d="${CHIP_GLYPH_PATH}"`);
      expect(svg).toContain(`stroke="${CHIP_FG}" stroke-width="${stroke}"`);
      for (const [x, y] of CHIP_DOTS) {
        expect(svg).toContain(`<circle cx="${x}" cy="${y}" r="${dot}" fill="${CHIP_FG}"/>`);
      }
    }
  });

  it('solid files use the solid tile, glass files a translucent gradient', () => {
    expect(asset('./chip.svg')).toContain(`fill="${CHIP_SOLID_BG}"`);
    expect(asset('./chip-sm.svg')).toContain(`fill="${CHIP_SOLID_BG}"`);
    expect(asset('./chip-glass.svg')).toContain('stop-opacity=".22"');
    expect(asset('./chip-glass.svg')).not.toContain(CHIP_SOLID_BG);
  });

  it('renders the thickened glass cut, hidden from assistive tech', () => {
    const svg = musterdChipSvg(13);
    expect(svg).toContain(`d="${CHIP_GLYPH_PATH}"`);
    expect(svg).toContain(`stroke-width="${CHIP_STROKE + CHIP_SMALL_EXTRA}"`);
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('aria-hidden="true"');
  });

  it('web and docs copies of each file are byte-identical', () => {
    for (const f of ['chip.svg', 'chip-sm.svg', 'chip-glass.svg', 'chip-glass-sm.svg', 'tile.svg']) {
      expect(asset(`./${f}`)).toBe(asset(`../../../../docs/design/assets/${f}`));
    }
  });
});
