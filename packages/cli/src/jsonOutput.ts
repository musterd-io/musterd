/**
 * Where `--json` has no JSON to give (ADR 758, lane 01M64CN3VY). `--json` is a global flag, so every
 * command accepts it. A command that prints prose under it hands a script text it cannot parse, and
 * a write has already happened by the time the script finds out. `bin.ts` refuses the flag for the
 * commands and subcommands listed here, with exit 2, before any request goes out.
 *
 * The list is of what does NOT print JSON, audited 2026-10-29. When a command learns `--json`,
 * remove it here; `jsonOutput.test.ts` fails while a whole-command entry's module reads the flag.
 */

/** Commands that never print JSON. */
export const NO_JSON_COMMANDS: readonly string[] = [
  'board',
  'broadcast',
  'codex-hook',
  'dream',
  'gate',
  'grok',
  'import',
  'live',
  'nudge',
  'pick',
  'reap',
  'reset',
  'serve',
  'service',
  'store',
  'surface',
  'tour',
  'uninstall',
];

/** Subcommands (the first positional) that print prose while their siblings print JSON. */
export const NO_JSON_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  channels: ['confirm', 'reject', 'revoke', 'slack-revoke', 'kill-switch'],
  goal: ['declare', 'outcome', 'retract'],
  harness: ['configure'],
  huddle: ['room'],
  integration: ['generate'],
  node: ['invite', 'join', 'rotate', 'revoke', 'trust', 'unbind'],
  seed: ['claim', 'ask', 'answer', 'brief', 'conclude', 'promote'],
  team: ['hue'],
};

/** Why `musterd <command> <sub> --json` is refused, or null when it prints JSON. */
export function jsonRefusal(command: string, positionals: readonly string[]): string | null {
  if (NO_JSON_COMMANDS.includes(command)) {
    return `\`musterd ${command}\` has no JSON output — run it without --json (nothing was sent)`;
  }
  const sub = positionals[0];
  if (sub !== undefined && NO_JSON_SUBCOMMANDS[command]?.includes(sub)) {
    return (
      `\`musterd ${command} ${sub}\` has no JSON output — run it without --json ` +
      '(nothing was sent)'
    );
  }
  return null;
}
