import {
  type AuditEntry,
  type PolicyOverride,
  type StyleFloor,
  type StylePolicyOverride,
  resolveStyle,
  styleProseProblem,
} from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { rejectAs, resolve } from './helpers.js';
import { DIAL_VALUES, parseDialPairs } from './style.js';

/**
 * `musterd team policy style` — the team's floor, default dials and prose (ADR 514, spec §4.5):
 * the one area of `team policy` with positional sub-words, because it holds eleven knobs and a
 * prose. Admin only, like every policy write; the read-merge-write `POST /policy` the doorbell's
 * team knobs use, so the hub forward and the `policy.change` audit row come with it. Lane
 * 01M47A4WRRWVD3SN6D7DSZ9V3J moved it here from a top-level `policy` word (one home per knob).
 *
 *   musterd team policy style                              each knob: its value, and default / set by whom
 *   musterd team policy style set assess_before_agreeing=off length=thorough [--prose "<≤5 lines>"]
 *   musterd team policy style set --prose ""               drop the team prose
 *   musterd team policy style clear                        back to the shipped style
 *
 * "set by whom" is read from the audit log (`policy.change` rows carry the stored doc): the newest
 * row where that knob took its current value. A reader the log refuses sees `set` instead.
 */

const FLOOR_KEYS = [
  'assess_before_agreeing',
  'disagree_once_then_commit',
  'concession_names_check',
  'human_critique_weighed_as_peer',
] as const satisfies readonly (keyof StyleFloor)[];
const DIAL_KEYS = ['pushback', 'bluntness', 'length', 'format'] as const;

/** `parsed.positionals` here start at `style` — `teamCommand` has already consumed `policy`. */
export async function teamPolicyStyle(parsed: Parsed): Promise<number> {
  const [area, sub] = parsed.positionals;
  if (area !== 'style') throw usage();
  rejectAs(parsed.flags);
  const { team, http } = resolve(parsed.flags);
  const { stored } = await http.getPolicy(team);

  let changed = false;
  const next: PolicyOverride = { ...stored };
  if (sub === 'clear') {
    delete next.style;
    changed = true;
  } else if (sub === 'set') {
    const words = parsed.positionals.slice(2);
    const floorWords = words.filter((w) =>
      (FLOOR_KEYS as readonly string[]).includes(w.split('=')[0]!),
    );
    const dialWords = words.filter((w) => !floorWords.includes(w));
    const floor = parseFloorPairs(floorWords);
    const defaults = parseDialPairs(dialWords);
    const prose = flagStr(parsed.flags, 'prose');
    if (!Object.keys(floor).length && !Object.keys(defaults).length && prose === undefined)
      throw usage();
    if (prose) {
      const problem = styleProseProblem(prose);
      if (problem) throw new CliError(problem, 3, 'validation');
    }
    const style: StylePolicyOverride = { ...stored.style };
    if (Object.keys(floor).length) style.floor = { ...style.floor, ...floor };
    if (Object.keys(defaults).length) style.defaults = { ...style.defaults, ...defaults };
    if (prose === '') delete style.prose;
    else if (prose !== undefined) style.prose = prose;
    next.style = style;
    changed = true;
  } else if (sub !== undefined) {
    throw usage();
  }

  const result = changed ? await http.setPolicy(team, next) : { policy: null, stored };
  const current = result.policy ?? (await http.getPolicy(team)).policy;
  const now = current.style;
  const setBy = await styleSetByFromAudit(http, team, changed ? next : stored);

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({ style: now, stored: result.stored.style ?? null }) + '\n',
    );
    return 0;
  }
  if (changed) {
    process.stdout.write(
      success(sub === 'clear' ? 'policy style cleared — shipped style' : 'policy style set', {
        next: 'musterd team policy style',
      }) + '\n',
    );
  }
  process.stdout.write(
    `${theme.accent('policy style')} — ${team} ${theme.meta(`(team epoch ${resolveStyle(now).epoch})`)}\n`,
  );
  process.stdout.write('  floor\n');
  for (const key of FLOOR_KEYS) {
    const on = now.floor[key];
    process.stdout.write(
      `    ${key.padEnd(32)} ${on ? theme.accent('on ') : 'off'} ${setBy(['floor', key])}\n`,
    );
  }
  process.stdout.write('  defaults\n');
  for (const key of DIAL_KEYS) {
    process.stdout.write(
      `    ${key.padEnd(32)} ${now.defaults[key].padEnd(16)} ${setBy(['defaults', key])}\n`,
    );
  }
  process.stdout.write(
    `  ${'prose'.padEnd(34)} ${now.prose ? `${JSON.stringify(now.prose)} ${setBy(['prose'])}` : theme.meta('none')}\n`,
  );
  return 0;
}

function parseFloorPairs(words: string[]): Partial<StyleFloor> {
  const out: Partial<StyleFloor> = {};
  for (const word of words) {
    const [key, value] = word.split('=') as [(typeof FLOOR_KEYS)[number], string | undefined];
    if (value === 'on' || value === 'true') out[key] = true;
    else if (value === 'off' || value === 'false') out[key] = false;
    else throw new CliError(`${key}: on or off`, 2);
  }
  return out;
}

type Path = readonly string[];

const at = (doc: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
    doc,
  );

/**
 * Who set each style knob, from the `policy.change` audit rows (newest first, each carrying the
 * stored doc): the newest row where the knob took its current value and the row before it did
 * not. A knob absent from the stored doc is `default`. Pure, so the label is testable without a
 * daemon.
 */
export function styleSetBy(rows: AuditEntry[], stored: PolicyOverride): (path: Path) => string {
  const changes = rows.filter((r) => r.action === 'policy.change' && r.detail);
  return (path) => {
    const current = at(stored, ['style', ...path]);
    if (current === undefined) return theme.meta('default');
    for (let i = 0; i < changes.length; i++) {
      const here = at(changes[i]!.detail, ['style', ...path]);
      const before =
        i + 1 < changes.length ? at(changes[i + 1]!.detail, ['style', ...path]) : undefined;
      if (here === current && before !== current) {
        return theme.meta(changes[i]!.actor ? `set by ${changes[i]!.actor}` : 'set');
      }
    }
    return theme.meta('set');
  };
}

async function styleSetByFromAudit(
  http: ReturnType<typeof resolve>['http'],
  team: string,
  stored: PolicyOverride,
): Promise<(path: Path) => string> {
  try {
    return styleSetBy((await http.audit(team, { limit: 500 })).audit, stored);
  } catch {
    // A reader the audit log refuses still sees default vs set — just not by whom.
    return styleSetBy([], stored);
  }
}

function usage(): CliError {
  return new CliError(
    'usage: musterd team policy style [set <knob>=<value> … [--prose <text>] | clear]  — floor: ' +
      FLOOR_KEYS.map((k) => `${k}=on|off`).join(' ') +
      '; defaults: ' +
      DIAL_KEYS.map((k) => `${k}=${DIAL_VALUES[k].join('|')}`).join(' ') +
      '  (other knobs: musterd team policy --<knob>)',
    2,
  );
}
