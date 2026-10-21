import type { MemberSummary } from '@musterd/protocol';
import { LIVE_PAGE_WORKSPACE } from './client';

/** One member who has /live open, as the "who is here" row draws them (ADR 691). */
export interface HereEntry {
  name: string;
  kind: 'human' | 'agent';
  /** The viewer's own seat. Drawn last, so the row reads "these people, and you". */
  you: boolean;
  /** Open /live tabs. A member counts once however many tabs or devices they use (ADR 042). */
  tabs: number;
  /** When the earliest of those tabs opened (ms), or null when the daemon did not say. */
  since: number | null;
  /** Every tab has gone quiet (`away`): the face dims, the name does not. */
  idle: boolean;
}

/**
 * Who has /live open, from the roster alone. A member is here when one of their presence rows is a
 * `web` socket that claimed with the /live label (`LiveConfig.page`). Nothing else qualifies:
 *
 * - **Observer seats**, which includes the anonymous watcher, a watch link and the /broadcast capture
 *   seat, never reach the roster. `listPresence` drops `observer = 1` members.
 * - The **board** page and the page's own HTTP reads hold `web` rows too, but without the label.
 * - A **closed** tab's row is held for the reclaim grace and is left out of the roster during it
 *   (ADR 010).
 *
 * Order: the others by arrival, earliest first (the row grows to the right as people come in), then
 * the viewer.
 */
export function whoIsHere(roster: readonly MemberSummary[], you: string | null): HereEntry[] {
  const here: HereEntry[] = [];
  for (const m of roster) {
    const rows = m.presences.filter(
      (p) => p.surface === 'web' && p.workspace === LIVE_PAGE_WORKSPACE && p.status !== 'offline',
    );
    if (rows.length === 0) continue;
    const starts = rows.map((p) => p.attached_at).filter((t): t is number => typeof t === 'number');
    here.push({
      name: m.name,
      kind: m.kind === 'human' ? 'human' : 'agent',
      you: m.name === you,
      tabs: rows.length,
      since: starts.length ? Math.min(...starts) : null,
      idle: rows.every((p) => p.status !== 'online'),
    });
  }
  return here.sort(
    (a, b) =>
      Number(a.you) - Number(b.you) ||
      (a.since ?? Infinity) - (b.since ?? Infinity) ||
      a.name.localeCompare(b.name),
  );
}
