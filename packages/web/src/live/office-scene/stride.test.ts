import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STRIDE } from './skeleton';

/**
 * The gait phase advances by distance (`STRIDE` floor units per cycle), so the feet only plant if the
 * rendered walk's foot sweep matches: a `STRIDE` longer than the clip's travel slides the feet forward
 * on the planks, a shorter one drags them back (the moonwalk) — office v3-5, Review Focus 4. The
 * number comes from the rig itself: render.py writes `anims.walk.contact` into figure.json.
 */
describe('STRIDE matches the rendered walk', () => {
  const spec = JSON.parse(
    readFileSync(new URL('./rendered/assets/figure.json', import.meta.url), 'utf8'),
  ) as { anims: { walk: { contact?: number } } };

  it('is within 10% of the walk clip’s measured foot travel, one cycle being two steps', () => {
    const contact = spec.anims.walk.contact;
    expect(contact, 'figure.json carries anims.walk.contact (render.py walk_contact)').toBeTypeOf('number');
    const cycle = contact! * 2;
    expect(Math.abs(STRIDE - cycle) / cycle).toBeLessThan(0.1);
  });
});
