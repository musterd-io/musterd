import {
  STYLE_BLUNTNESS,
  STYLE_FORMAT,
  STYLE_LENGTH,
  STYLE_PUSHBACK,
  type StyleDials,
  type StylePrefs,
  describeDials,
  styleProseProblem,
} from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import type { StyleSelfRead } from '../client.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * `musterd style` — how seats talk to you (ADR 514, spec §4.5). Self only, by construction: the
 * route is `/members/me/style`, and the daemon answers 403 for an agent seat.
 *
 *   musterd style                                     your dials (each labelled yours / team default)
 *                                                     and the block a seat steered by you reads
 *   musterd style set length=concise pushback=every-time [--prose "<≤5 lines>"]
 *   musterd style set --prose ""                      drop your prose, keep the dials
 *   musterd style clear                               back to team defaults
 *
 * From an agent seat, bare `style` prints the block that seat reads (`GET /style-block`) — the same
 * text `team_join` renders — and `set` / `clear` are refused: agents have no preferences.
 */

const DIAL_KEYS = ['pushback', 'bluntness', 'length', 'format'] as const;
type DialKey = (typeof DIAL_KEYS)[number];

export const DIAL_VALUES: Record<DialKey, readonly string[]> = {
  pushback: STYLE_PUSHBACK,
  bluntness: STYLE_BLUNTNESS,
  length: STYLE_LENGTH,
  format: STYLE_FORMAT,
};

export async function styleCommand(parsed: Parsed): Promise<number> {
  const [sub] = parsed.positionals;
  const { team, http } = resolve(parsed.flags);

  if (sub === undefined) return show(parsed, team, http);
  if (sub !== 'set' && sub !== 'clear') throw usage();

  let next: StylePrefs = {};
  if (sub === 'set') {
    const dials = parseDialPairs(parsed.positionals.slice(1));
    const prose = flagStr(parsed.flags, 'prose');
    if (Object.keys(dials).length === 0 && prose === undefined) throw usage();
    if (prose) {
      // The daemon refuses too (422 with the count); saying it here spares the round trip.
      const problem = styleProseProblem(prose);
      if (problem) throw new CliError(problem, 3, 'validation');
    }
    const current = await selfOrRefuse(http.getStyle(team));
    next = { ...current.prefs, ...dials };
    if (prose === '') delete next.prose;
    else if (prose !== undefined) next.prose = prose;
  }
  const updated = await selfOrRefuse(http.putStyle(team, next));
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(updated) + '\n');
    return 0;
  }
  const what =
    sub === 'clear' ? 'style cleared — team defaults' : `style set — ${describeSet(next)}`;
  process.stdout.write(success(what, { next: 'musterd style' }) + '\n');
  process.stdout.write(
    theme.meta(`your seats now read: ${describeDials(updated.resolved.dials)}`) + '\n',
  );
  return 0;
}

/** Bare `style`: a human's own view; a seat's is the block it reads. */
async function show(
  parsed: Parsed,
  team: string,
  http: ReturnType<typeof resolve>['http'],
): Promise<number> {
  let view: StyleSelfRead;
  try {
    view = await http.getStyle(team);
  } catch (err) {
    if (!(err instanceof CliError) || err.code !== 'forbidden') throw err;
    // An agent seat: no preferences, but the block it reads is worth seeing from the shell — it
    // is what `team_join` showed, current as of now.
    const env = await http.getStyleBlock(team);
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify(env) + '\n');
      return 0;
    }
    process.stdout.write(
      `${theme.accent('style')} — the block this seat reads` +
        theme.meta(env.driver ? ` (driver ${env.driver})` : ' (no driver)') +
        '\n',
    );
    process.stdout.write(indent(env.block) + '\n');
    process.stdout.write(
      theme.meta('a seat has no preferences — a human sets theirs with: musterd style set') + '\n',
    );
    return 0;
  }
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(view) + '\n');
    return 0;
  }
  process.stdout.write(
    `${theme.accent('style')} — ${view.member} ${theme.meta(`(epoch ${view.resolved.epoch})`)}\n`,
  );
  for (const key of DIAL_KEYS) {
    const value = view.resolved.dials[key];
    const label = view.prefs[key] !== undefined ? theme.ok('yours') : theme.meta('team default');
    process.stdout.write(`  ${key.padEnd(10)} ${value.padEnd(16)} ${label}\n`);
  }
  process.stdout.write(
    `  ${'prose'.padEnd(10)} ${
      view.prefs.prose !== undefined
        ? `${JSON.stringify(view.prefs.prose)} ${theme.ok('yours')}`
        : theme.meta('none')
    }\n`,
  );
  process.stdout.write(theme.meta('the block a seat steered by you reads:') + '\n');
  process.stdout.write(indent(view.block) + '\n');
  process.stdout.write(
    theme.dim(
      'musterd style set length=concise · musterd style set --prose "…" · musterd style clear',
    ) + '\n',
  );
  return 0;
}

async function selfOrRefuse<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof CliError && err.code === 'forbidden') {
      throw new CliError(
        'style preferences are for human members — a seat reads the block it is given (musterd style)',
        err.exitCode,
        'forbidden',
      );
    }
    throw err;
  }
}

/** `key=value` pairs for the four dials; anything else is a usage error naming the choices. */
export function parseDialPairs(words: string[]): Partial<StyleDials> {
  const out: Partial<Record<DialKey, string>> = {};
  for (const word of words) {
    const eq = word.indexOf('=');
    const key = eq === -1 ? word : word.slice(0, eq);
    const value = eq === -1 ? '' : word.slice(eq + 1);
    if (!(DIAL_KEYS as readonly string[]).includes(key)) {
      throw new CliError(`unknown dial "${key}" — one of ${DIAL_KEYS.join(', ')}`, 2);
    }
    const choices = DIAL_VALUES[key as DialKey];
    if (!choices.includes(value)) {
      throw new CliError(`${key}: one of ${choices.join(', ')}`, 2);
    }
    out[key as DialKey] = value;
  }
  return out as Partial<StyleDials>;
}

function describeSet(prefs: StylePrefs): string {
  const parts = DIAL_KEYS.filter((k) => prefs[k] !== undefined).map((k) => `${k} ${prefs[k]}`);
  if (prefs.prose !== undefined) parts.push('prose');
  return parts.length ? parts.join(', ') : 'nothing';
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

function usage(): CliError {
  return new CliError(
    'usage: musterd style [set <dial>=<value> … [--prose <text>] | clear]  — dials: ' +
      DIAL_KEYS.map((k) => `${k}=${DIAL_VALUES[k].join('|')}`).join(' '),
    2,
  );
}
