/**
 * Where an insight stands now (ADR 526). Insights stay append-only in the log (ADR 327) — nothing
 * here edits or deletes one. What changes is how readers treat it, derived from two kinds of act:
 *
 * - **retracted** — a `resolve` whose thread is the insight's own id, from the insight's author or
 *   any human. A resolve on it from anyone else is an ordinary resolve and retracts nothing: a seat
 *   that thinks a teammate's finding is wrong challenges it (ADR 505), it does not erase it.
 * - **superseded** — a later `insight` naming it in `meta.supersedes`. From the author or a human it
 *   HIDES the old one; from anyone else it only annotates it, so no seat can bury another's finding.
 *
 * A hidden insight drops out of search, the dream packet and the digest — the three places that
 * re-broadcast findings — while its row and its log entry stay exactly where they were.
 */
import type { InsightStatus } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';

export interface InsightRef {
  id: string;
  /** The finder's member id. */
  from_member: string;
}

export interface InsightVerdict {
  status: InsightStatus | null;
  /** Left out of search / dreams / the digest. */
  hidden: boolean;
}

interface ResolveRow {
  thread_id: string;
  from_member: string;
  name: string;
  kind: string;
  body: string;
  ts: number;
}

interface SupersedeRow {
  id: string;
  from_member: string;
  name: string;
  kind: string;
  meta: string | null;
}

/** The current standing of each given insight, keyed by id. One query per kind, bounded by input. */
export async function insightVerdicts(
  db: Driver,
  teamId: string,
  insights: readonly InsightRef[],
): Promise<Map<string, InsightVerdict>> {
  const out = new Map<string, InsightVerdict>();
  if (insights.length === 0) return out;
  const author = new Map(insights.map((i) => [i.id, i.from_member]));
  const ids = [...author.keys()];
  const marks = ids.map(() => '?').join(',');

  const resolves = await db.all<ResolveRow>(
    `SELECT m.thread_id, m.from_member, mem.name, mem.kind, m.body, m.ts
       FROM messages m JOIN members mem ON mem.id = m.from_member
      WHERE m.team_id = ? AND m.act = 'resolve' AND m.thread_id IN (${marks})
      ORDER BY m.ts ASC`,
    [teamId, ...ids],
  );
  // Superseding insights are few (a team's findings, not its traffic); the meta filter narrows to
  // the ones that name any id at all, and the parse below keeps only names that match.
  const supersedes = await db.all<SupersedeRow>(
    `SELECT m.id, m.from_member, mem.name, mem.kind, m.meta
       FROM messages m JOIN members mem ON mem.id = m.from_member
      WHERE m.team_id = ? AND m.act = 'insight' AND m.meta LIKE '%"supersedes"%'
      ORDER BY m.ts ASC`,
    [teamId],
  );

  const entry = (id: string): { status: InsightStatus; hidden: boolean } => {
    const prior = out.get(id);
    if (prior?.status) return prior as { status: InsightStatus; hidden: boolean };
    const fresh = { status: {} as InsightStatus, hidden: false };
    out.set(id, fresh);
    return fresh;
  };

  for (const r of resolves) {
    const owner = author.get(r.thread_id);
    if (owner === undefined) continue;
    if (r.from_member !== owner && r.kind !== 'human') continue;
    const e = entry(r.thread_id);
    if (e.status.retracted) continue; // the first retraction stands
    e.status.retracted = { by: r.name, at: r.ts, reason: r.body };
    e.hidden = true;
  }

  for (const r of supersedes) {
    let meta: { supersedes?: unknown; headline?: unknown };
    try {
      meta = JSON.parse(r.meta ?? '{}') as typeof meta;
    } catch {
      continue;
    }
    if (!Array.isArray(meta.supersedes)) continue;
    for (const target of meta.supersedes) {
      if (typeof target !== 'string' || target === r.id) continue;
      const owner = author.get(target);
      if (owner === undefined) continue;
      const hides = r.from_member === owner || r.kind === 'human';
      const e = entry(target);
      (e.status.superseded_by ??= []).push({
        id: r.id,
        from: r.name,
        headline: typeof meta.headline === 'string' ? meta.headline : '',
        hides,
      });
      if (hides) e.hidden = true;
    }
  }

  for (const i of insights) if (!out.has(i.id)) out.set(i.id, { status: null, hidden: false });
  return out;
}
