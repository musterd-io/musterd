import { encode } from 'uqr';

const DARK = '\u001b[30m';
const LIGHT_BG = '\u001b[47m';
const DARK_BG = '\u001b[40m';
const LIGHT = '\u001b[37m';
const RESET = '\u001b[0m';

/**
 * A QR code for the terminal (ADR 690): two modules per row with the upper-half block, colours set
 * explicitly so the code scans the same on a dark or a light theme — a scanner needs dark modules on
 * a light field, never the terminal's own inversion. The quiet zone is the standard four modules.
 */
export function renderTerminalQr(text: string): string {
  const { data } = encode(text, { ecc: 'L', border: 4 });
  const lines: string[] = [];
  for (let y = 0; y < data.length; y += 2) {
    let line = '';
    const top = data[y]!;
    const bottom = data[y + 1];
    for (let x = 0; x < top.length; x++) {
      const upper = top[x]!;
      const lower = bottom ? bottom[x]! : false;
      line += `${upper ? DARK : LIGHT}${lower ? DARK_BG : LIGHT_BG}▀`;
    }
    lines.push(line + RESET);
  }
  return lines.join('\n');
}
