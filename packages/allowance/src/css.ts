/** One class per whole percent, so the bar width is not an inline style. */
export function percentCss(): string {
  return Array.from({ length: 101 }, (_, i) => `.p${i}{width:${i}%}`).join('');
}
