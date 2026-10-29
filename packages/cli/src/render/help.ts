/**
 * The pretty, colorized help — the warm, scannable replacement for a flat command dump. Three views,
 * one catalog (help/catalog.ts): the grouped overview, per-command detail, and a JSON dump for agents.
 *
 * The overview reads like a floor plan: a short "start here", then commands grouped into labelled
 * rooms, with depth (flags, examples) one `musterd help <command>` away. That is what fixes the
 * "35-command wall" — the top view stays scannable; you descend only when you need to.
 */
import {
  ACTS,
  CATALOG,
  type CommandEntry,
  GLOBAL_FLAGS,
  GROUPS,
  START_HERE,
} from '../help/catalog.js';
import { renderBanner } from './rows.js';
import { theme } from './theme.js';
import { defList, dim, heading, hint, rule, sym, termWidth, visibleLen, wrapText } from './ui.js';

function entry(name: string): CommandEntry | undefined {
  return CATALOG.find((c) => c.name === name);
}

/** The grouped overview shown by `musterd help`. `full` includes non-primary commands inline. */
export function renderHelp(opts: { full?: boolean; width?: number } = {}): string {
  const width = opts.width ?? termWidth();
  const out: string[] = [renderBanner(), ''];
  out.push(dim('the coordination layer for your team'));
  out.push(hint('musterd help <command> for detail'));

  // Start here — the four commands a fresh session reaches for first.
  // A short rule (not a full-width bar) is the room divider; the footer keeps the long one.
  out.push('', rule(28), heading('start here'));
  const startRows = START_HERE.map((n) => entry(n))
    .filter((c): c is CommandEntry => !!c)
    .map((c) => ({ term: c.name, desc: c.summary }));
  out.push(defList(startRows, { width }));

  // The rooms.
  for (const group of GROUPS) {
    const inGroup = CATALOG.filter((c) => c.group === group.id);
    const shown = opts.full ? inGroup : inGroup.filter((c) => c.primary);
    const rows = (shown.length ? shown : inGroup).map((c) => ({ term: c.name, desc: c.summary }));
    // The blurb is long; on a narrow terminal wrap it instead of overflowing the line.
    const title = heading(group.title);
    const titleWidth = visibleLen(title);
    const inlineBlurbWidth = Math.max(10, width - titleWidth - 2);
    const blurbLines = wrapText(group.blurb, inlineBlurbWidth);
    if (titleWidth + 2 + visibleLen(blurbLines[0] ?? '') <= width) {
      out.push('', rule(28), title + '  ' + dim(blurbLines[0] ?? ''));
      for (const bl of blurbLines.slice(1)) out.push(' '.repeat(titleWidth + 2) + dim(bl));
    } else {
      out.push('', rule(28), title);
      for (const bl of blurbLines) out.push('  ' + dim(bl));
    }
    out.push(defList(rows, { width }));
    const hidden = inGroup.length - rows.length;
    if (hidden > 0) {
      out.push(
        `  ${dim(`${sym.more} +${hidden} more — `)}${theme.accent(`musterd help ${group.id}`)}`,
      );
    }
  }

  // Footer.
  out.push('', rule(Math.min(width, 72)));
  // Wrap the flag/act lists so a narrow terminal doesn't overflow.
  const flagLine = theme.meta('global flags') + '  ';
  const flags = GLOBAL_FLAGS.map((f) => theme.accent(f.flag)).join(theme.meta('  '));
  for (const line of wrapText(flags, Math.max(20, width - visibleLen(flagLine)))) {
    out.push(flagLine + line);
  }
  const actLine = theme.meta('acts') + '  ';
  const acts = ACTS.map((a) => theme.dim(a)).join(' ');
  for (const line of wrapText(acts, Math.max(20, width - visibleLen(actLine)))) {
    out.push(actLine + line);
  }
  for (const line of wrapText(
    `more   musterd help <command>  ${sym.dot}  musterd help --json`,
    width,
  )) {
    out.push(dim(line));
  }
  return out.join('\n');
}

/** One group's full command list (`musterd help <group-id>`), or null if the id is unknown. */
export function renderGroupHelp(id: string, opts: { width?: number } = {}): string | null {
  const group = GROUPS.find((g) => g.id === id);
  if (!group) return null;
  const width = opts.width ?? termWidth();
  const rows = CATALOG.filter((c) => c.group === group.id).map((c) => ({
    term: c.name,
    desc: c.summary,
  }));
  const title = heading(group.title);
  const blurbLines = wrapText(group.blurb, Math.max(20, width - visibleLen(title) - 2));
  const header =
    visibleLen(title) + 2 + visibleLen(blurbLines[0] ?? '') <= width
      ? title + '  ' + dim(blurbLines[0] ?? '')
      : title;
  const out: string[] = [header];
  if (visibleLen(title) + 2 + visibleLen(blurbLines[0] ?? '') > width) {
    for (const bl of blurbLines) out.push('  ' + dim(bl));
  } else {
    for (const bl of blurbLines.slice(1)) out.push(' '.repeat(visibleLen(title) + 2) + dim(bl));
  }
  out.push(defList(rows, { width }));
  for (const line of wrapText(
    `musterd help <command> for detail  ${sym.dot}  musterd help  for the full map`,
    width,
  )) {
    out.push(dim(line));
  }
  return out.join('\n');
}

/** Detail for one command (`musterd help <name>`), or null if the name is unknown. */
export function renderCommandHelp(name: string, opts: { width?: number } = {}): string | null {
  const cmd = entry(name);
  if (!cmd) return null;
  const width = opts.width ?? termWidth();
  const out: string[] = [];

  const sig = cmd.signature ? cmd.signature : '';
  const head = `${theme.accent('musterd ' + cmd.name)}`;
  out.push(head);
  if (sig) {
    for (const line of wrapText(sig, width - 2)) {
      out.push('  ' + theme.meta(line));
    }
  }
  out.push(rule(Math.min(28, width)));
  for (const line of wrapText(cmd.summary, width - 2)) out.push('  ' + line);

  if (cmd.detail) {
    out.push('');
    for (const para of detailParagraphs(cmd.detail)) {
      // Preserve the intentional indented sub-command blocks; wrap only free-flowing prose.
      if (/^\s{2,}/.test(para)) {
        for (const line of wrapIndented(para, width)) out.push(theme.meta(line));
      } else for (const line of wrapText(para, width - 2)) out.push('  ' + line);
    }
  }

  if (cmd.examples?.length) {
    out.push('', heading('examples'));
    for (const ex of cmd.examples) {
      const exLine = `  ${theme.meta('$')} ${ex}`;
      if (visibleLen(exLine) <= width) {
        out.push(exLine);
      } else {
        // The command starts on the `$` line; its continuation hangs under it.
        const [first, ...rest] = wrapText(ex, Math.max(20, width - 4));
        out.push(`  ${theme.meta('$')} ${first ?? ''}`);
        for (const line of rest) out.push('    ' + theme.meta(line));
      }
    }
  }

  const group = GROUPS.find((g) => g.id === cmd.group);
  for (const line of wrapText(
    `in: ${group?.title ?? cmd.group}  ${sym.dot}  musterd help  for the full map`,
    width,
  )) {
    out.push(dim(line));
  }
  return out.join('\n');
}

/**
 * Is `musterd <command> help` a request for that command's help? — the trailing-`help` form.
 *
 * `help` used to be recognized only as argv[0] (`musterd help agent`) or as a `--help`/`-h` flag, so
 * `musterd agent help` — the form most people reach for first — fell through to the command with
 * "help" as its first positional. For `agent` that positional is a SEAT NAME: on 2026-08-05 the typo
 * provisioned a member called `help` on team `revive`, complete with a workspace, a branch and MCP
 * wiring, and nobody noticed for nine days. Reserving the word here fixes every verb at once rather
 * than teaching each command to distrust its own arguments.
 *
 * Deliberately narrow on THREE sides. It fires only when `help` is the SOLE positional, so
 * `musterd team add help` still adds a member by that name; only for a catalogued command, so
 * `musterd bogus help` still reports an unknown command with a did-you-mean; and never for a
 * command whose first positional is free text (`freeTextPositional`), because there the word is
 * the user's argument and not a request. `send` is that case: its positional is the message body,
 * and `--act request_help` with a one-word body of "help" is the most plausible message on the
 * system. A guard that eats it would break the verb it was meant to protect.
 */
/** Where a detail line's description starts: after a term's run of spaces, else at its indent. */
function descColumn(line: string): number {
  const indent = line.length - line.trimStart().length;
  const gap = /\S( {2,})(?=\S)/.exec(line.slice(indent));
  return gap ? indent + gap.index + 1 + gap[1]!.length : indent;
}

/**
 * A detail's lines, with what the catalog split across lines joined back up: a prose sentence
 * that runs on into the next unindented line, and a description continued on a line indented to
 * its column. Without this each piece wrapped on its own and a single word could sit on a line by
 * itself (journeys review F3).
 */
export function detailParagraphs(detail: string): string[] {
  const out: string[] = [];
  for (const line of detail.split('\n')) {
    const prev = out[out.length - 1];
    const indent = line.length - line.trimStart().length;
    const prose = line !== '' && indent === 0;
    const runsOn = prev !== undefined && prev !== '' && !/[.:;!?]$/.test(prev.trimEnd());
    const continuation =
      prev !== undefined &&
      /^\s/.test(prev) &&
      indent >= 8 &&
      descColumn(line) === indent &&
      descColumn(prev) === indent;
    if ((prose && runsOn && !/^\s/.test(prev)) || continuation) {
      out[out.length - 1] = `${prev!.trimEnd()} ${line.trim()}`;
    } else out.push(line);
  }
  return out;
}

/**
 * Wrap one indented detail line without losing its shape (journeys review F3). The leading indent
 * stays, and a description wraps in its own column. When that column leaves under 20 cells, the
 * term wraps with a two-space hang and the description follows on its own lines, four in.
 */
export function wrapIndented(line: string, width: number): string[] {
  if (visibleLen(line) <= width) return [line];
  const indent = line.length - line.trimStart().length;
  const col = descColumn(line);
  // A description column (past the indent) that leaves room keeps its alignment.
  if (col > indent && width - col >= 20) {
    const [first, ...rest] = wrapText(line.slice(col), width - col);
    return [line.slice(0, col) + (first ?? ''), ...rest.map((l) => ' '.repeat(col) + l)];
  }
  const lead = Math.min(indent, Math.max(0, width - 22));
  const hang = (n: number, text: string, first = n): string[] =>
    wrapText(text, width - n).map((l, i) => ' '.repeat(i === 0 ? first : n) + l);
  // A line that is all term, or all description (a block indented to its column), hangs.
  if (col === indent) return hang(indent >= 8 ? lead : lead + 2, line.trim(), lead);
  return [
    ...hang(lead + 2, line.slice(indent, col).trim(), lead),
    ...hang(lead + 4, line.slice(col)),
  ];
}

export function wantsCommandHelp(command: string, positionals: readonly string[]): boolean {
  if (positionals.length !== 1 || positionals[0] !== 'help') return false;
  const cmd = entry(command);
  return cmd !== undefined && cmd.freeTextPositional !== true;
}

/** The whole catalog as JSON — a stable machine surface for agents and agentic workflows. */
export function renderHelpJson(): string {
  return JSON.stringify({
    groups: GROUPS,
    start_here: START_HERE,
    commands: CATALOG,
    global_flags: GLOBAL_FLAGS,
    acts: ACTS,
  });
}

/**
 * A "did you mean" nearest-name suggestion for an unknown command word — the warm alternative to a bare
 * "unknown command". Returns the closest catalog name within a small edit distance, or null.
 */
export function nearestCommand(input: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of CATALOG) {
    const d = editDistance(input, c.name);
    if (d < bestDist) {
      bestDist = d;
      best = c.name;
    }
  }
  // Only suggest when it's genuinely close (≤2 edits, or a clear prefix typo).
  return best && bestDist <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}
