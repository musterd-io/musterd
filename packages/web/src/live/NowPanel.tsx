import type { MemberSummary } from '@musterd/protocol';
import type { ReactNode } from 'react';
import type { Briefing, NeedsItem } from './briefing';
import { coarseAge, hueOf, initial, kindOf, memberAvatar, rosterIndex } from './format';

/**
 * The Now briefing's body: what a member reads when they sit down having forgotten yesterday. Three
 * columns of the same truth, each grouped the way its question is asked — what is waiting **on whom**,
 * what is on the plate **by goal**, and what landed **by who landed it**. The Team column beside the
 * room is by person; this is deliberately not, or it is the Team tab with a box on top (nick,
 * 2026-10-09: "it kind of just looks like the team tab").
 *
 * Pure markup over props — no hooks — so the render test can pin it. Rows are ONE line each: a
 * briefing is scanned, and a row that wraps to three lines is a card, not a row.
 */

/** Rows shown per group in the overlay, and in full view. The rest are one click from the board. */
export const CAP = {
  overlay: { needs: 4, goals: 6, perGoal: 0, review: 2, people: 6, titles: 0 },
  full: { needs: 12, goals: 12, perGoal: 6, review: 8, people: 12, titles: 5 },
} as const;

/** "yesterday" · "Friday" — where the shipped list starts, said the way a person says it. */
export function sinceLabel(since: number, now: number): string {
  const startOf = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOf(now) - startOf(since)) / 86_400_000);
  if (days <= 1) return 'yesterday';
  return new Date(since).toLocaleDateString('en-US', { weekday: 'long' });
}

/** "ann, bob" · "ann, bob +2" — who is on a goal, for the overlay's one-line summary. */
export function ownersOf(owners: readonly (string | null)[]): string {
  const names = [...new Set(owners.filter((o): o is string => o !== null))];
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

export interface NowSectionsProps {
  brief: Briefing;
  roster: readonly MemberSummary[];
  now: number;
  /** Where the shipped list starts (`briefingSince`). */
  since: number;
  /** The full-screen layout: three columns, nothing capped to a teaser. */
  full: boolean;
  onOpenLane: (laneId: string) => void;
  onOpenAsk: (envelopeId: string) => void;
  /** "+N more" — takes the reader to the whole thing. */
  onMore: () => void;
}

export function NowSections({
  brief,
  roster,
  now,
  since,
  full,
  onOpenLane,
  onOpenAsk,
  onMore,
}: NowSectionsProps) {
  const cap = full ? CAP.full : CAP.overlay;
  const idx = rosterIndex(roster as MemberSummary[]);
  const dot = (name: string): ReactNode => (
    <span
      className="now-dot"
      aria-hidden="true"
      style={{ background: memberAvatar(name, kindOf(name, idx), hueOf(name, idx)) }}
    >
      {initial(name)}
    </span>
  );
  const more = (shown: number, total: number) =>
    total > shown ? (
      <li className="now-more">
        <button type="button" className="now-more__btn" onClick={onMore}>
          +{total - shown} more
        </button>
      </li>
    ) : null;
  const need = (n: NeedsItem) => (
    <li key={n.id}>
      <NeedRow
        item={n}
        age={coarseAge(now - n.since)}
        onOpenAsk={onOpenAsk}
        onOpenLane={onOpenLane}
      />
    </li>
  );
  const laneRow = (id: string, title: string, meta: string, done = false) => (
    <li key={id}>
      <button
        type="button"
        className={`now-r${done ? ' now-r--done' : ''}`}
        title={title}
        onClick={() => onOpenLane(id.replace(/^lane:/, ''))}
      >
        <span className="now-r__t">{title}</span>
        <span className="now-r__m">{meta}</span>
      </button>
    </li>
  );

  const nothingWaiting = brief.needsGroups.length === 0 && brief.blocked.length === 0;

  return (
    <div className={`now-body${full ? ' is-full' : ''}`}>
        <section
          className={`now-sec now-sec--needs${nothingWaiting ? '' : ' is-loud'}`}
          aria-label="Needs attention"
        >
          {nothingWaiting && (
            <p className="now-calm">Nothing is waiting on anyone, and nothing is blocked.</p>
          )}
          {brief.needsGroups.map((g) => (
            <div key={g.key} className="now-grp">
              <h3 className="now-h now-h--loud">
                {g.heading} <b>{g.items.length}</b>
              </h3>
              <ul className="now-list">
                {g.items.slice(0, cap.needs).map(need)}
                {more(Math.min(g.items.length, cap.needs), g.items.length)}
              </ul>
            </div>
          ))}
          {brief.blocked.length > 0 && (
            <div className="now-grp">
              <h3 className="now-h now-h--blocked">
                Blocked <b>{brief.blocked.length}</b>
              </h3>
              <ul className="now-list">
                {brief.blocked.slice(0, cap.needs).map(need)}
                {more(Math.min(brief.blocked.length, cap.needs), brief.blocked.length)}
              </ul>
            </div>
          )}
        </section>

        <section className="now-sec now-sec--progress" aria-label="In progress, by goal">
          <h3 className="now-h">
            In progress <b>{brief.inProgress.length}</b> <span className="now-h__sub">by goal</span>
          </h3>
          {brief.byGoal.length === 0 && <p className="now-empty">no lanes in hand</p>}
          {full
            ? brief.byGoal.slice(0, cap.goals).map((g) => (
                <div key={g.key} className="now-goal">
                  <p className="now-goal__h">
                    <span className="now-goal__n">{g.goal}</span> <b>{g.items.length}</b>
                  </p>
                  <ul className="now-list">
                    {g.items.slice(0, cap.perGoal).map((w) => laneRow(w.id, w.title, w.owner ?? ''))}
                    {more(Math.min(g.items.length, cap.perGoal), g.items.length)}
                  </ul>
                </div>
              ))
            : (
                <ul className="now-list">
                  {brief.byGoal.slice(0, cap.goals).map((g) => (
                    <li key={g.key}>
                      <button type="button" className="now-r" title={g.goal} onClick={onMore}>
                        <span className="now-r__t">
                          <b>{g.goal}</b> <span className="now-r__n">{g.items.length}</span>
                        </span>
                        <span className="now-r__m">{ownersOf(g.items.map((w) => w.owner))}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          {brief.byGoal.length > cap.goals && (
            <p className="now-more">
              <button type="button" className="now-more__btn" onClick={onMore}>
                +{brief.byGoal.length - cap.goals} more goals
              </button>
            </p>
          )}
        </section>

        <section className="now-sec now-sec--shipped" aria-label={`Shipped since ${sinceLabel(since, now)}`}>
          <h3 className="now-h">
            Shipped <b>{brief.shipped.length}</b>{' '}
            <span className="now-h__sub">since {sinceLabel(since, now)}</span>
          </h3>
          {brief.shippedBy.length === 0 && <p className="now-empty">nothing has landed yet</p>}
          {full
            ? brief.shippedBy.slice(0, cap.people).map((p) => (
                <div key={p.who} className="now-person">
                  <p className="now-person__h">
                    {dot(p.who)}
                    {p.who} <b>{p.items.length}</b>
                  </p>
                  <ul className="now-list">
                    {p.items
                      .slice(0, cap.titles)
                      .map((s) => laneRow(s.id, s.title, `${coarseAge(now - s.at)} ago`, true))}
                    {more(Math.min(p.items.length, cap.titles), p.items.length)}
                  </ul>
                </div>
              ))
            : (
                <ul className="now-list">
                  {brief.shippedBy.slice(0, cap.people).map((p) => (
                    <li key={p.who}>
                      <button
                        type="button"
                        className="now-r now-r--done"
                        title={p.items.map((i) => i.title).join('\n')}
                        onClick={onMore}
                      >
                        <span className="now-r__t">
                          {dot(p.who)}
                          <b>{p.who}</b> <span className="now-r__n">{p.items.length}</span>{' '}
                          {p.items[0]?.title}
                        </span>
                        <span className="now-r__m">{coarseAge(now - (p.items[0]?.at ?? now))}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          {brief.shippedBy.length > cap.people && (
            <p className="now-more">
              <button type="button" className="now-more__btn" onClick={onMore}>
                +{brief.shippedBy.length - cap.people} more people
              </button>
            </p>
          )}
        </section>
        <section className="now-sec now-sec--review" aria-label="In review">
          <h3 className="now-h">
            In review <b>{brief.inReview.length}</b>
          </h3>
          {brief.inReview.length === 0 ? (
            <p className="now-empty">nothing waiting on a reviewer</p>
          ) : (
            <ul className="now-list">
              {brief.inReview.slice(0, cap.review).map((w) => laneRow(w.id, w.title, w.owner ?? ''))}
              {more(Math.min(brief.inReview.length, cap.review), brief.inReview.length)}
            </ul>
          )}
        </section>

    </div>
  );
}

function NeedRow({
  item,
  age,
  onOpenAsk,
  onOpenLane,
}: {
  item: NeedsItem;
  age: string;
  onOpenAsk: (id: string) => void;
  onOpenLane: (id: string) => void;
}) {
  const inner = (
    <>
      <span className="now-r__t">{item.title}</span>
      <span className="now-r__m">
        {item.owner ? `${item.owner} · ` : ''}
        {age}
      </span>
      {item.waitsOn && (
        <span className="now-r__sub">
          waits on {item.waitsOn.title}
          {item.waitsOn.owner ? ` (${item.waitsOn.owner})` : ''}
        </span>
      )}
    </>
  );
  if (item.kind === 'seat-request') {
    return (
      <a className="now-r" href="/approvals" title="Seat-claim approvals (admin)">
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={`now-r${item.waitsOn ? ' has-sub' : ''}`}
      title={item.title}
      onClick={() => (item.laneId ? onOpenLane(item.laneId) : onOpenAsk(item.ref))}
    >
      {inner}
    </button>
  );
}
