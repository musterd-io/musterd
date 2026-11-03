import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { shiftCommand } from './shift.js';

describe('musterd shift (ADR 792)', () => {
  it('names the two verbs and the seat before it sends anything', async () => {
    await expect(shiftCommand(parseArgs(['nap', 'ryder']))).rejects.toThrow(
      /musterd shift start <seat>/,
    );
    await expect(shiftCommand(parseArgs(['start']))).rejects.toThrow(/name the seat/);
  });
});
