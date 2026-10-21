import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  CALENDAR_KINDS,
  CALENDAR_STATUSES,
  CalendarEntryInputSchema,
  type CalendarEntry,
  type CalendarEntryInput,
  type CalendarWriteOutcome,
} from '@musterd/protocol';
import { flagStr, GLOBAL_FLAGS, rejectUnknownFlags, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve } from './helpers.js';

const USAGE =
  'usage: musterd calendar [list] [--all | --past] [--picks] [--kind <kind>] [--json]\n' +
  '       musterd calendar add "<title>" --date YYYY-MM-DD --kind <kind> [--start HH:MM] [--end HH:MM]\n' +
  '                            [--status <status>] [--place …] [--url https://…] [--note …] [--pick] [--tz <IANA>]\n' +
  '       musterd calendar edit <id> [--title …] [any add flag; "" clears one] [--pick | --unpick]\n' +
  '       musterd calendar rm <id>\n' +
  '       musterd calendar import <events.json | dir/> [--json]\n' +
  `  kinds: ${CALENDAR_KINDS.join(' ')}\n` +
  `  statuses: ${CALENDAR_STATUSES.join(' ')}`;

/**
 * ADR 519 — the Team's calendar from the terminal. Any Member reads and writes it (the daemon
 * decides; an observer seat is refused there). `import` is the one-time cutover from the claude.ai
 * artifact: every document goes up with its document id as `source_ref`, so running it twice reports
 * every entry `unchanged` and writes nothing.
 */
/**
 * The flags `musterd calendar` takes (lane
 * `01M5D907S74XVT5YECNWB5VW5A`). A flag this command does not know takes the NEXT argument as
 * its value and drops it, so a typo loses an argument — the lane id, the target, the words of a
 * message. A command knows its own flags, so it refuses the ones it does not, before anything
 * is composed. The global flags every command inherits come from `GLOBAL_FLAGS`; this list is
 * the command's own — and the flags the helpers it calls read, because a helper's read is this
 * command's vocabulary too.
 *
 * `pnpm cli-flags:check` proves this list covers every flag the file reads, so a flag added
 * without being declared fails the build instead of working in the field.
 */
export const CALENDAR_FLAGS = [
  '-',
  'all',
  'date',
  'end',
  'flags',
  'id',
  'kind',
  'note',
  'past',
  'pick',
  'picks',
  'place',
  'source',
  'start',
  'status',
  'title',
  'unpick',
  'url',
] as const;

export async function calendarCommand(parsed: Parsed): Promise<number> {
  // A flag this command does not know would take the NEXT argument as its value and drop it
  // — a lost lane id, a lost target, a lost body. Refuse it before anything is composed
  // (lane `01M5D907S74XVT5YECNWB5VW5A`).
  rejectUnknownFlags(
    parsed.flags,
    [...GLOBAL_FLAGS, ...CALENDAR_FLAGS],
    'the flags `musterd calendar` takes are listed by `musterd help calendar`',
  );
  const sub = parsed.positionals[0] ?? 'list';
  const { team, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;

  if (sub === 'list') {
    const { entries } = await http.listCalendar(team);
    const shown = filterEntries(entries, {
      range:
        parsed.flags['all'] === true ? 'all' : parsed.flags['past'] === true ? 'past' : 'upcoming',
      picks: parsed.flags['picks'] === true,
      kind: flagStr(parsed.flags, 'kind'),
      today: localDate(new Date()),
    });
    if (json) return printJson(shown);
    process.stdout.write(renderCalendar(shown) + '\n');
    return 0;
  }

  if (sub === 'add') {
    const title = parsed.positionals[1];
    if (!title) throw new CliError(USAGE, 2);
    const input = parseInput({ title, ...fieldsFromFlags(parsed.flags) });
    const { entry } = await http.createCalendarEntry(team, input);
    if (json) return printJson(entry);
    process.stdout.write(
      success(`added: ${renderLine(entry)}`, { next: `musterd calendar edit ${entry.id} …` }) +
        '\n',
    );
    return 0;
  }

  if (sub === 'edit') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    const current = (await http.listCalendar(team)).entries.find((e) => e.id === id);
    if (!current) {
      throw new CliError(
        `no calendar entry "${id}" — \`musterd calendar --all\` lists them`,
        1,
        'not_found',
      );
    }
    const input = parseInput({ ...inputOf(current), ...fieldsFromFlags(parsed.flags) });
    const { entry, outcome } = await http.replaceCalendarEntry(team, id, input);
    if (json) return printJson({ entry, outcome });
    process.stdout.write(
      (outcome === 'unchanged'
        ? theme.meta(`unchanged: ${renderLine(entry)}`)
        : success(`updated: ${renderLine(entry)}`)) + '\n',
    );
    return 0;
  }

  if (sub === 'rm') {
    const id = parsed.positionals[1];
    if (!id) throw new CliError(USAGE, 2);
    await http.deleteCalendarEntry(team, id);
    if (json) return printJson({ ok: true, id });
    process.stdout.write(success(`deleted ${id}`) + '\n');
    return 0;
  }

  if (sub === 'import') {
    const path = parsed.positionals[1];
    if (!path) throw new CliError(USAGE, 2);
    const { inputs, refused } = readArtifactExport(path);
    const counts: Record<CalendarWriteOutcome, number> = { created: 0, updated: 0, unchanged: 0 };
    for (const input of inputs) {
      const { outcome } = await http.createCalendarEntry(team, input);
      counts[outcome]++;
    }
    if (json) {
      printJson({ ...counts, refused });
      return refused.length > 0 ? 1 : 0;
    }
    process.stdout.write(
      success(
        `imported ${inputs.length}: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged`,
        { next: 'musterd calendar' },
      ) + '\n',
    );
    for (const r of refused)
      process.stdout.write(theme.warn(`  refused ${r.id}: ${r.reason}`) + '\n');
    return refused.length > 0 ? 1 : 0;
  }

  throw new CliError(USAGE, 2);
}

/** What `add` / `edit` flags say. A flag given as `""` clears that field (null or empty). */
function fieldsFromFlags(flags: Parsed['flags']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const text = ['title', 'date', 'kind', 'tz', 'place', 'note', 'source'] as const;
  for (const k of text) {
    const v = flagStr(flags, k);
    if (v !== undefined) out[k] = v;
  }
  const nullable = ['start', 'end', 'status', 'url'] as const;
  for (const k of nullable) {
    const v = flagStr(flags, k);
    if (v !== undefined) out[k] = v === '' ? null : v;
  }
  if (flags['pick'] === true) out['pick'] = true;
  if (flags['unpick'] === true) out['pick'] = false;
  return out;
}

/** Parse at the edge (hard rule 4), so a typo is refused before the request, with the field named. */
function parseInput(raw: Record<string, unknown>): CalendarEntryInput {
  const parsed = CalendarEntryInputSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const why = parsed.error.issues
    .map((i) => `${i.path.join('.') || 'entry'}: ${i.message}`)
    .join('; ');
  throw new CliError(`${why}\n${USAGE}`, 2);
}

/** The writable half of a stored entry — what `edit` starts from. */
function inputOf(e: CalendarEntry): CalendarEntryInput {
  return {
    title: e.title,
    date: e.date,
    start: e.start,
    end: e.end,
    tz: e.tz,
    kind: e.kind,
    status: e.status,
    place: e.place,
    url: e.url,
    note: e.note,
    pick: e.pick,
    source: e.source,
    source_ref: e.source_ref,
  };
}

/**
 * One artifact document → an entry input. The artifact stores "none" as `''`; the entry says
 * `null`. Its document id becomes `source_ref`, the import's idempotency key (ADR 519 §5).
 */
export function artifactDocToInput(
  id: string,
  doc: Record<string, unknown>,
): { ok: true; input: CalendarEntryInput } | { ok: false; reason: string } {
  const blankToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
  const parsed = CalendarEntryInputSchema.safeParse({
    title: doc['title'],
    date: doc['date'],
    start: blankToNull(doc['start']),
    end: blankToNull(doc['end']),
    kind: doc['kind'],
    status: blankToNull(doc['status']),
    place: doc['place'] ?? '',
    url: blankToNull(doc['url']),
    note: doc['note'] ?? '',
    pick: doc['pick'] === true,
    source: doc['source'] ?? '',
    source_ref: id,
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  return {
    ok: false,
    reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

/**
 * Read an export of the artifact's `events` collection. Three shapes, all keyed by document id: a
 * directory of `<doc_id>.json` files (what an ArtifactData list with `out_dir` writes), a JSON array
 * of documents each carrying `id`, or a JSON object mapping id → document.
 */
export function readArtifactExport(path: string): {
  inputs: CalendarEntryInput[];
  refused: { id: string; reason: string }[];
} {
  const docs: [string, Record<string, unknown>][] = [];
  const read = (p: string): unknown => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      throw new CliError(`cannot read ${p}: ${(err as Error).message}`, 1);
    }
  };
  let isDir: boolean;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    throw new CliError(`no such file or directory: ${path}`, 1);
  }
  if (isDir) {
    for (const f of readdirSync(path)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      docs.push([basename(f, '.json'), read(join(path, f)) as Record<string, unknown>]);
    }
  } else {
    const body = read(path);
    if (Array.isArray(body)) {
      for (const d of body as Record<string, unknown>[]) {
        if (typeof d?.['id'] !== 'string')
          throw new CliError('every document in the array needs an "id"', 1);
        docs.push([d['id'], d]);
      }
    } else if (body && typeof body === 'object') {
      for (const [id, d] of Object.entries(body)) docs.push([id, d as Record<string, unknown>]);
    } else {
      throw new CliError(`${path}: expected a JSON array or object of documents`, 1);
    }
  }
  const inputs: CalendarEntryInput[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const [id, doc] of docs) {
    const r = artifactDocToInput(id, doc);
    if (r.ok) inputs.push(r.input);
    else refused.push({ id, reason: r.reason });
  }
  return { inputs, refused };
}

/** The view the app also has: upcoming (today on), past, or everything; Picks; one kind. */
export function filterEntries(
  entries: CalendarEntry[],
  opts: {
    range: 'upcoming' | 'past' | 'all';
    picks: boolean;
    kind?: string | undefined;
    today: string;
  },
): CalendarEntry[] {
  const out = entries.filter(
    (e) =>
      (opts.range === 'all' ||
        (opts.range === 'upcoming' ? e.date >= opts.today : e.date < opts.today)) &&
      (!opts.picks || e.pick) &&
      (opts.kind === undefined || e.kind === opts.kind),
  );
  // Past reads most recent first, as the artifact's Past view does.
  return opts.range === 'past' ? out.reverse() : out;
}

/** `Thu Oct 08  14:00–14:30  ★ demo      SF Tech Week demo · Mission Bay [going]` */
export function renderLine(e: CalendarEntry): string {
  const [y, m, d] = e.date.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  });
  const time = e.start ? `${e.start}${e.end ? `–${e.end}` : ''}` : 'all day';
  const place = e.place ? ` · ${printable(e.place)}` : '';
  const status = e.status ? ` [${e.status}]` : '';
  return `${day.replace(',', '')}  ${time.padEnd(11)}  ${e.pick ? '★' : ' '} ${e.kind.padEnd(9)} ${printable(e.title)}${place}${status}`;
}

/**
 * Any Member — an agent included — writes these fields, and this prints them to a human's terminal.
 * A C0/C1 control byte (ESC above all) would let an entry recolour, retitle or rewrite the screen,
 * so each becomes U+FFFD before it is shown. The stored entry is untouched; `--json` stays exact.
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '\ufffd');
}

export function renderCalendar(entries: CalendarEntry[]): string {
  if (entries.length === 0)
    return theme.meta('nothing on the calendar here — `musterd calendar --all` shows everything');
  return entries.map((e) => `${renderLine(e)}  ${theme.meta(e.id)}`).join('\n');
}

/** Today's date on this machine's wall clock — the CLI's "upcoming" starts here. */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function printJson(v: unknown): number {
  process.stdout.write(JSON.stringify(v) + '\n');
  return 0;
}
