/** Drop C0/C1 control characters and any ESC-introduced sequence (CSI, OSC, …) from text that
 *  originated with a teammate before it reaches the terminal. Keeps the visible characters only. */
export function plainTerminalText(s: string): string {
  /* eslint-disable no-control-regex -- the control characters ARE the subject here */
  return (
    s
      // ESC + CSI/OSC/other: `ESC [ … final`, `ESC ] … BEL/ST`, `ESC <single>`
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
      .replace(/\u001b[\x20-\x7e]/g, '')
      // C0 (except nothing — a one-line field has no legitimate control), DEL, C1
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  );
  /* eslint-enable no-control-regex */
}

/** The same, line by line: for multi-line text from outside (an issue body) that keeps its breaks. */
export function plainTerminalLines(s: string): string {
  return s
    .split(/\r?\n/)
    .map((line) => plainTerminalText(line))
    .join('\n');
}
