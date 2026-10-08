import { readFileSync } from 'node:fs';

/** A file's COMPLETE lines: the last one is dropped unless the file ends in a newline. */
export function readCompleteLines(path: string): string[] {
  const parts = readFileSync(path, 'utf8').split('\n');
  parts.pop(); // '' after a final newline, or a half-written line that the next poll will see whole
  return parts;
}
