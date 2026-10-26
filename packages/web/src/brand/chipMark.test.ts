import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHIP_BG,
  CHIP_DOTS,
  CHIP_DOT_RADIUS,
  CHIP_FG,
  CHIP_GLYPH_PATH,
  CHIP_RADIUS,
  CHIP_SMALL_DOT_EXTRA,
  CHIP_SMALL_EXTRA,
  CHIP_SPARK,
  CHIP_SPARK_RADIUS,
  CHIP_SPARKS,
  CHIP_STROKE,
  musterdChipSvg,
} from './chipMark';

const asset = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * ADR 702: the mark is one geometry in several files (the module, the docs assets, the web assets)
 * and the old chip's hand-copied paths are exactly how it drifted. The files are the design source;
 * these tests make the module agree with them.
 */
describe('the mark (ADR 702, 733)', () => {
  it('is a flat sand tile with cool ink', () => {
    expect(CHIP_BG).toBe('#EBD9A0');
    expect(CHIP_FG).toBe('#1F6F6B');
    expect(CHIP_RADIUS).toBe(307);
  });

  it.each([
    ['chip.svg', CHIP_STROKE, CHIP_DOT_RADIUS, true],
    ['chip-sm.svg', CHIP_STROKE + CHIP_SMALL_EXTRA, CHIP_DOT_RADIUS + CHIP_SMALL_DOT_EXTRA, false],
  ])('%s carries the module geometry at its own weight', (name, stroke, dot, sparks) => {
    for (const rel of [`./${name}`, `../../../../docs/design/assets/${name}`]) {
      const svg = asset(rel);
      expect(svg).toContain(`fill="${CHIP_BG}"`);
      expect(svg).not.toContain('Gradient');
      expect(svg).toContain(`d="${CHIP_GLYPH_PATH}"`);
      expect(svg).toContain(`stroke="${CHIP_FG}" stroke-width="${stroke}"`);
      for (const [x, y] of CHIP_DOTS) {
        expect(svg).toContain(`<circle cx="${x}" cy="${y}" r="${dot}" fill="${CHIP_FG}"/>`);
      }
      // ADR 733: the full weight carries a spark in each cut; the small one has no room for them
      for (const [x, y] of CHIP_SPARKS) {
        const spark = `<circle cx="${x}" cy="${y}" r="${CHIP_SPARK_RADIUS}" fill="${CHIP_SPARK}"/>`;
        if (sparks) expect(svg).toContain(spark);
        else expect(svg).not.toContain(CHIP_SPARK);
      }
    }
  });

  it('the sparks are the wordmark sparks, and clear the cut they sit in (ADR 733)', () => {
    const word = asset('./wordmark.svg');
    for (const [x, y] of CHIP_SPARKS) {
      expect(word).toContain(`<circle cx="${x}" cy="${y}" r="${CHIP_SPARK_RADIUS}" fill="${CHIP_SPARK}"/>`);
    }
    // the cut runs from the shoulder's underside (416 + half the stroke) to the stem's top (530 − half)
    const cut = [416 + CHIP_STROKE / 2, 530 - CHIP_STROKE / 2];
    for (const [, y] of CHIP_SPARKS) {
      expect(y - CHIP_SPARK_RADIUS).toBeGreaterThan(cut[0]!);
      expect(y + CHIP_SPARK_RADIUS).toBeLessThan(cut[1]!);
    }
  });

  it('renders the thickened cut, flat and hidden from assistive tech', () => {
    const svg = musterdChipSvg(13);
    expect(svg).toContain(`fill="${CHIP_BG}"`);
    expect(svg).not.toContain('Gradient');
    expect(svg).toContain(`d="${CHIP_GLYPH_PATH}"`);
    expect(svg).toContain(`stroke-width="${CHIP_STROKE + CHIP_SMALL_EXTRA}"`);
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('aria-hidden="true"');
  });

  it('web and docs copies of each file are byte-identical', () => {
    for (const f of ['chip.svg', 'chip-sm.svg', 'tile.svg']) {
      expect(asset(`./${f}`)).toBe(asset(`../../../../docs/design/assets/${f}`));
    }
  });
});
