/**
 * Tinted identity layers (office realism, plan Task 11; spec §3.2).
 *
 * A figure's sheets are rendered neutral grey; a member's look — `appearance.ts`, still the source
 * of truth — tints each layer at draw time. The tint is a multiply over the grey, so the render's
 * own shading survives. It is done PER FRAME on one small scratch canvas and never cached as a
 * tinted copy of a sheet: a sheet-sized copy per (layer, colour) is tens of megabytes each, and
 * nineteen members × six layers of them is what made the first cut eat the browser's memory.
 */
export type CreateCanvas = (w: number, h: number) => HTMLCanvasElement;

export const defaultCreate: CreateCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/**
 * Draw the `sw × sh` cell at `(sx, sy)` of `src` onto `scratch` at the origin, multiplied by `color`
 * and cut back to the cell's alpha. The scratch grows to fit and is reused; the caller blits
 * `scratch`'s top-left `sw × sh` straight after. Returns the scratch, or null if it has no context.
 */
export function tintFrame(
  scratch: HTMLCanvasElement,
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  color: string,
): HTMLCanvasElement | null {
  if (scratch.width < sw || scratch.height < sh) {
    scratch.width = Math.max(scratch.width, sw);
    scratch.height = Math.max(scratch.height, sh);
  }
  const g = scratch.getContext('2d');
  if (!g) return null;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, sw, sh);
  g.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  g.fillRect(0, 0, sw, sh);
  // the multiply fill painted the transparent pixels too; cut them back to the sprite's alpha
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  g.globalCompositeOperation = 'source-over';
  return scratch;
}

/** Multiply two hex colours channel by channel — a layer colour under the room's light tint. */
export function mulHex(a: string, b: string): string {
  if (b === '#ffffff') return a;
  const ch = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16);
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  const out = [1, 3, 5].map((i) => hex((ch(a, i) * ch(b, i)) / 255));
  return `#${out.join('')}`;
}
