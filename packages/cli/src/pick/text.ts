/**
 * Lane-sourced text is written by seats, and the lane picker paints it into a full-screen terminal.
 * A brief carrying `\x1b[2J` or a bare `\r` would repaint or scramble the whole screen, so every
 * string from a lane is stripped of control bytes and escape sequences before layout (ADR 624).
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f\x9b]/g;

export function clean(s: string | null | undefined): string {
  return (s ?? '').replace(CONTROL, '').replace(/\t/g, ' ');
}

/** Word-wrap one paragraph-bearing string to `width`; a word longer than the width is cut. */
export function wrap(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of clean(s).split('\n')) {
    let line = '';
    for (const word of para.split(/ +/).filter(Boolean)) {
      for (let piece = word; piece.length > 0; ) {
        const room = line ? w - line.length - 1 : w;
        if (piece.length <= room) {
          line = line ? `${line} ${piece}` : piece;
          piece = '';
        } else if (line) {
          out.push(line);
          line = '';
        } else {
          out.push(piece.slice(0, w));
          piece = piece.slice(w);
        }
      }
    }
    out.push(line);
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Cut to `width` visible characters with an ellipsis. Input must already be clean. */
export function cut(s: string, width: number): string {
  if (width <= 0) return '';
  return s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;
}

export function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
