import { describe, expect, it } from 'vitest';
import { CATALOG, GROUPS, START_HERE } from '../help/catalog.js';
import {
  detailParagraphs,
  nearestCommand,
  renderCommandHelp,
  renderGroupHelp,
  renderHelp,
  renderHelpJson,
  wantsCommandHelp,
  wrapIndented,
} from './help.js';
import { visibleLen } from './ui.js';

// Color is pinned OFF via NO_COLOR in vitest.config, so assertions are on visible text.

describe('renderHelp (grouped overview)', () => {
  const out = renderHelp();

  it('leads with the banner tagline and a start-here section', () => {
    expect(out).toContain('on a team with you');
    expect(out.toLowerCase()).toContain('start here');
  });

  it('shows every group title', () => {
    for (const g of GROUPS) expect(out.toUpperCase()).toContain(g.title.toUpperCase());
  });

  it('surfaces the start-here commands and points at deeper help', () => {
    for (const n of START_HERE) expect(out).toContain(n);
    expect(out).toContain('musterd help <command>');
    expect(out).toContain('musterd help --json');
  });

  it('does not overflow the available width at 40, 60 and 80 columns', () => {
    for (const width of [40, 60, 80]) {
      const out = renderHelp({ width });
      for (const line of out.split('\n')) {
        expect(visibleLen(line)).toBeLessThanOrEqual(width);
      }
      const cmd = renderCommandHelp('lane', { width })!;
      for (const line of cmd.split('\n')) {
        expect(visibleLen(line)).toBeLessThanOrEqual(width);
      }
      const grp = renderGroupHelp('setup', { width })!;
      for (const line of grp.split('\n')) {
        expect(visibleLen(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('folds non-primary commands behind a "+N more" pointer by default', () => {
    expect(out).toContain('more — musterd help setup');
    // `wire` is non-primary in setup, so it is hidden from the condensed overview…
    expect(renderHelp().includes('\nwire')).toBe(false);
    // …but --full inlines it.
    expect(renderHelp({ full: true })).toContain('wire');
  });
});

describe('renderCommandHelp', () => {
  it('shows signature, summary, detail, and examples for a known command', () => {
    const out = renderCommandHelp('lane')!;
    expect(out).toContain('musterd lane');
    expect(out).toContain('declare a unit of work');
    expect(out.toLowerCase()).toContain('examples');
    expect(out).toContain('musterd lane open');
  });

  it('returns null for an unknown command', () => {
    expect(renderCommandHelp('bogus')).toBeNull();
  });
});

describe('renderGroupHelp', () => {
  it('lists a whole group, including non-primary commands', () => {
    const out = renderGroupHelp('setup')!;
    expect(out).toContain('wire');
    expect(out).toContain('uninstall');
  });

  it('returns null for an unknown group id', () => {
    expect(renderGroupHelp('nope')).toBeNull();
  });
});

describe('renderHelpJson', () => {
  it('round-trips the catalog with stable top-level keys', () => {
    const j = JSON.parse(renderHelpJson());
    expect(j.groups.length).toBe(GROUPS.length);
    expect(j.commands.length).toBeGreaterThan(20);
    expect(j.start_here).toEqual([...START_HERE]);
    expect(Array.isArray(j.acts)).toBe(true);
  });
});

describe('nearestCommand', () => {
  it('suggests the closest command for a typo', () => {
    expect(nearestCommand('clam')).toBe('claim');
    expect(nearestCommand('statuss')).toBe('status');
  });

  it('returns null when nothing is close', () => {
    expect(nearestCommand('xyzzy-nonsense')).toBeNull();
  });
});

describe('wantsCommandHelp — `musterd <cmd> help` is a help request, not an argument', () => {
  // The footgun this closes: `musterd agent help` parsed "help" as a SEAT NAME and provisioned a
  // member called `help` (roster row + git worktree + branch + MCP wiring) before erroring out on an
  // unrelated missing credential. `help` was only ever recognized in argv[0] or as a --help flag.
  it('fires for a bare `help` after a real command', () => {
    expect(wantsCommandHelp('agent', ['help'])).toBe(true);
    expect(wantsCommandHelp('team', ['help'])).toBe(true);
    expect(wantsCommandHelp('lane', ['help'])).toBe(true);
  });

  it('does NOT fire when `help` is one of several positionals — `team add help` still adds', () => {
    expect(wantsCommandHelp('team', ['add', 'help'])).toBe(false);
    expect(wantsCommandHelp('agent', ['help', 'extra'])).toBe(false);
  });

  it('does not fire for a different positional', () => {
    expect(wantsCommandHelp('agent', ['june'])).toBe(false);
    expect(wantsCommandHelp('agent', [])).toBe(false);
  });

  it('does not fire for an uncatalogued command — `musterd bogus help` stays an unknown command', () => {
    expect(wantsCommandHelp('bogus', ['help'])).toBe(false);
  });
});

describe('wantsCommandHelp does not eat a free-text argument (#858 follow-up)', () => {
  it('a one-word body of exactly "help" still sends — send carries free text, not subcommands', () => {
    // `musterd send --to nick --act request_help help` must SEND the word, not print usage.
    // On a request_help act, "help" is the most plausible one-word body anyone would ever type,
    // so the word the guard reserves is the word that verb exists to carry.
    expect(wantsCommandHelp('send', ['help'])).toBe(false);
  });

  it('still fires for a verb whose positional is a subcommand', () => {
    expect(wantsCommandHelp('agent', ['help'])).toBe(true);
    expect(wantsCommandHelp('team', ['help'])).toBe(true);
  });

  it('still ignores a non-sole positional and an uncatalogued command', () => {
    expect(wantsCommandHelp('team', ['add', 'help'])).toBe(false);
    expect(wantsCommandHelp('bogus', ['help'])).toBe(false);
  });
});

describe('wrapped detail keeps its shape (journeys review F3)', () => {
  it('wraps a description in its own column', () => {
    const line =
      '  show <id> [--json]            one lane in full: brief, history, merge, the ask to reply_to';
    expect(wrapIndented(line, 80)).toEqual([
      '  show <id> [--json]            one lane in full: brief, history, merge, the ask',
      '                                to reply_to',
    ]);
  });

  it('puts the description under a term that leaves its column no room', () => {
    const out = wrapIndented(
      '  open "<title>" [--surface …] [--goal <id>] [--claim]   declare it',
      40,
    );
    expect(out[0]).toBe('  open "<title>" [--surface …] [--goal');
    expect(out.at(-1)).toBe('      declare it');
  });

  it('hangs a long term-only line two spaces in', () => {
    const out = wrapIndented(
      '  add <name> --kind <agent|human> [--role <role>] [--lifecycle forever]',
      40,
    );
    expect(out.every((l, i) => l.startsWith(i === 0 ? '  add' : '    '))).toBe(true);
  });

  it('joins a sentence and a description the catalog split across lines', () => {
    expect(detailParagraphs('the issue it came from\n(acme/app#12) on open.')).toEqual([
      'the issue it came from (acme/app#12) on open.',
    ]);
    expect(
      detailParagraphs(
        '  create <slug>\n          binds the folder; --switch also\n          points',
      ),
    ).toEqual(['  create <slug>', '          binds the folder; --switch also points']);
    // A sentence that ends stays its own paragraph.
    expect(detailParagraphs('First.\nSecond.')).toEqual(['First.', 'Second.']);
  });

  it('no command help overflows or prints an indented line flush left, at 40, 60 and 80', () => {
    for (const width of [40, 60, 80]) {
      for (const cmd of CATALOG) {
        const out = renderCommandHelp(cmd.name, { width })!;
        for (const line of out.split('\n')) {
          expect(visibleLen(line), `${cmd.name} @${width}: ${line}`).toBeLessThanOrEqual(width);
        }
        // Everything under the rule is indented, up to the "in:" footer (which may wrap).
        const lines = out.split('\n');
        const body = lines
          .slice(
            1,
            lines.findIndex((l) => l.startsWith('in: ')),
          )
          .filter(Boolean);
        for (const line of body) expect(line, `${cmd.name} @${width}`).toMatch(/^ |^─|^EXAMPLES/i);
      }
    }
  });
});
