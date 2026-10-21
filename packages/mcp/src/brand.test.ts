import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHIP_SVG, MCP_ICONS, chipIconDataUri } from './brand.js';

describe('brand (ADR 702)', () => {
  it('mirrors docs/design/assets/chip.svg exactly', () => {
    const asset = readFileSync(
      new URL('../../../docs/design/assets/chip.svg', import.meta.url),
      'utf8',
    );
    expect(CHIP_SVG).toBe(asset.trimEnd());
  });

  it('chip SVG is the mark on the flat sand tile', () => {
    expect(CHIP_SVG).toContain('#EBD9A0');
    expect(CHIP_SVG).toContain('#2E3647');
    expect(CHIP_SVG).toContain('aria-label="musterd"');
  });

  it('MCP icons use a data-uri SVG', () => {
    expect(MCP_ICONS).toHaveLength(1);
    const icon = MCP_ICONS[0]!;
    expect(icon.mimeType).toBe('image/svg+xml');
    expect(icon.sizes).toEqual(['any']);
    expect(icon.src).toBe(chipIconDataUri());
    expect(icon.src.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });
});
