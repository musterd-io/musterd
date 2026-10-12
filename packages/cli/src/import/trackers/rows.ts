import type { ImportRow } from '../rows.js';
import type { TrackerIssue } from './types.js';

/**
 * Tracker issues → the rows a CSV would give (spec 2026-10-11 §2): one goal per group, then one lane
 * per issue. From here the stage → preview → save path is the file import's, unchanged.
 */
const BODY_MAX = 4000;

export function slugify(title: string, key: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '');
  return slug || `group-${key}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 64);
}

export function issuesToRows(issues: TrackerIssue[]): ImportRow[] {
  const goalKey = new Map<string, string>();
  const used = new Set<string>();
  const rows: ImportRow[] = [];
  for (const i of issues) {
    if (!i.group || goalKey.has(i.group.key)) continue;
    let slug = slugify(i.group.title, i.group.key);
    for (let n = 2; used.has(slug); n += 1) {
      const suffix = `-${String(n)}`;
      slug = `${slugify(i.group.title, i.group.key).slice(0, 64 - suffix.length)}${suffix}`;
    }
    used.add(slug);
    goalKey.set(i.group.key, slug);
    rows.push({ row: rows.length + 1, kind: 'goal', key: slug, title: i.group.title, depends_on: [] });
  }
  for (const i of issues) {
    const body = i.body?.trim() ? i.body.slice(0, BODY_MAX) : undefined;
    const goal = i.group ? goalKey.get(i.group.key) : undefined;
    rows.push({
      row: rows.length + 1,
      kind: 'lane',
      title: i.title,
      detail: body ? `${i.url}\n\n${body}` : i.url,
      depends_on: [],
      source_ref: i.ref,
      ...(goal ? { goal } : {}),
      ...(i.stakes ? { stakes: i.stakes } : {}),
    });
  }
  return rows;
}
