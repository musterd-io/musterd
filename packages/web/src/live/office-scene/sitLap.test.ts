import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The hands-in-lap seat (office v3-6): an idle member on a stool, the couch or a meeting chair has no
 * keyboard, so the hands rest in the lap with the laptop closed under the right arm — "hands should
 * be down (macbook under 1 arm)" (nick, 2026-10-26). `character.ts` already prefers `sit-lap` for a
 * casual seat whenever the sheet has it; this pins that the shipped sheet does, and that it costs only
 * the layers the arms change (spec §8): everything else replays `sit-idle`.
 */
describe('the sit-lap clip in the rendered sheet', () => {
  const spec = JSON.parse(
    readFileSync(new URL('./rendered/assets/figure.json', import.meta.url), 'utf8'),
  ) as {
    anims: Record<string, { frames: number; loop: boolean; base?: string; layers?: string[] }>;
    layers: { id: string }[];
  };

  it('exists, loops, and is as long as the seated idle it rests on', () => {
    const lap = spec.anims['sit-lap'];
    expect(lap, 'figure.json carries anims["sit-lap"]').toBeDefined();
    expect(lap!.loop).toBe(true);
    expect(lap!.frames).toBe(spec.anims['sit-idle']!.frames);
  });

  it('stores only the arms, the sleeves, the trousers under them and what is held; the rest is sit-idle', () => {
    const lap = spec.anims['sit-lap']!;
    expect(lap.base).toBe('sit-idle');
    for (const own of ['skin', 'top/', 'bottom', 'carry/']) expect(lap.layers).toContain(own);
    expect(lap.layers).not.toContain('hair/');
  });

  it('the laptop layer is in the sheet, so the seated carry has pixels to draw', () => {
    expect(spec.layers.some((l) => l.id === 'carry/laptop')).toBe(true);
  });
});
