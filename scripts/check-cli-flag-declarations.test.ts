import { describe, expect, it } from 'vitest';
import { forwardsParsedCommand } from './check-cli-flag-declarations.ts';

describe('forwardsParsedCommand', () => {
  it('does not propagate CLI flags through a helper that merely inspects a usage field', () => {
    expect(
      forwardsParsedCommand(
        "if (!json || !json.includes('usage')) return;",
        "export function parseUsage(json: string): void { const usage = ['usage']; }",
        'parseUsage',
      ),
    ).toBe(false);
  });

  it('propagates flags when a command forwards Parsed to another command', () => {
    expect(
      forwardsParsedCommand(
        'return childCommand(parsed);',
        'export async function childCommand(parsed: Parsed): Promise<number> { return 0; }',
        'childCommand',
      ),
    ).toBe(true);
  });
});
