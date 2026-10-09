import type { MemberSummary } from '@musterd/protocol';
import type { ReactNode } from 'react';
import type { Briefing, NeedsItem, ShippedItem, WorkItem } from './briefing';
import { coarseAge, hueOf, initial, kindOf, memberAvatar, rosterIndex } from './format';
import './NowPanel.css';

/**
 * The Now panel's body (live-briefing spec): what the team is on, in four sections ordered by how
 * much each needs a person — Needs a human first and the only loud one, then In progress, In review
 * and Shipped. Everything here reads the one `Briefing`, so the numbers cannot disagree with the
 * topbar headline built from the same arrays.
 *
 * Pure markup over props (no hooks), so the render test can pin it. The clock is passed in for the
 * same reason `TeamColumn` takes `now`.
 */

/** Quiet sections show this many rows and then say how many more the board holds. */
export const QUIET_ROWS = 5;
/** The loud section hides less: a Needs-a-human item behind "+N more" defeats its one job. */
export const LOUD_ROWS = 8;

const KIND_LABEL: Record<NeedsItem['kind'], string> = {
  ask: 'ask',
  approval: 'approval',
  blocked: 'blocked',
  'seat-request': 'seat request',
};

export interface NowSectionsProps {
  brief: Briefing;
  roster: readonly MemberSummary[];
  now: number;
  /** Open a lane on the board overlay. */
  onOpenLane: (laneId: string) => void;
  /** Open an ask on its act in the log. */
  onOpenAsk: (envelopeId: string) => void;
  /** "+N more" opens the whole board. */
  onOpenBoard: () => void;
}

export function NowSections({
  brief,
  roster,
  now,
  onOpenLane,
  onOpenAsk,
  onOpenBoard,
}: NowSectionsProps) {
  const idx = rosterIndex(roster as MemberSummary[]);
  const who = (name: string | null): ReactNode =>
    name === null ? null : (
      <span className="now-who">
        <span
          className="now-who__dot"
          aria-hidden="true"
          style={{ background: memberAvatar(name, kindOf(name, idx), hueOf(name, idx)) }}
        >
          {initial(name)}
        </span>
        {name}
      </span>
    );
  const age = (since: number) => coarseAge(now - since);
  const more = (shown: number, total: number) =>
    total > shown ? (
      <li className="now-more">
        <button type="button" className="now-more__btn" onClick={onOpenBoard}>
          +{total - shown} more on the board
        </button>
      </li>
    ) : null;

  const needs = brief.needsHuman;
  return (
    <div className="now" role="tabpanel" aria-label="Now">
      <section
        className={`now-needs${needs.length ? ' is-loud' : ''}`}
        aria-label="Needs a human"
      >
        {needs.length === 0 ? (
          <p className="now-calm">nothing is waiting on anyone</p>
        ) : (
          <>
            <h2 className="now-h now-h--loud">
              Needs a human <b className="now-h__n">{needs.length}</b>
            </h2>
            <ul className="now-list">
              {needs.slice(0, LOUD_ROWS).map((n) => (
                <li key={n.id} className={`now-need now-need--${n.kind}`}>
                  <NeedBody
                    item={n}
                    onOpenLane={onOpenLane}
                    onOpenAsk={onOpenAsk}
                    who={who}
                    age={age(n.since)}
                  />
                </li>
              ))}
              {more(Math.min(needs.length, LOUD_ROWS), needs.length)}
            </ul>
          </>
        )}
      </section>

      <Quiet title="In progress" items={brief.inProgress} empty="no lanes in hand" who={who} age={age} more={more}
        onOpenLane={onOpenLane} />
      <Quiet title="In review" items={brief.inReview} empty="nothing waiting on a reviewer" who={who} age={age} more={more}
        onOpenLane={onOpenLane} />
      <Shipped items={brief.shipped} who={who} age={age} more={more} onOpenLane={onOpenLane} />
    </div>
  );
}

function NeedBody({
  item,
  onOpenLane,
  onOpenAsk,
  who,
  age,
}: {
  item: NeedsItem;
  onOpenLane: (id: string) => void;
  onOpenAsk: (id: string) => void;
  who: (name: string | null) => ReactNode;
  age: string;
}) {
  const inner = (
    <>
      <span className="now-need__kind">{KIND_LABEL[item.kind]}</span>
      <span className="now-need__title">{item.title}</span>
      <span className="now-need__meta">
        {item.owner ? who(item.owner) : item.kind === 'blocked' ? <span>unowned</span> : null}
        {item.waitingOn && <span className="now-need__to">→ {item.waitingOn}</span>}
        <span className="now-need__age">{age}</span>
      </span>
    </>
  );
  if (item.kind === 'seat-request') {
    return (
      <a className="now-need__hit" href="/approvals" title="Seat-claim approvals (admin)">
        {inner}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="now-need__hit"
      title={item.title}
      onClick={() => (item.laneId ? onOpenLane(item.laneId) : onOpenAsk(item.ref))}
    >
      {inner}
    </button>
  );
}

function Quiet({
  title,
  items,
  empty,
  who,
  age,
  more,
  onOpenLane,
}: {
  title: string;
  items: readonly WorkItem[];
  empty: string;
  who: (name: string | null) => ReactNode;
  age: (since: number) => string;
  more: (shown: number, total: number) => ReactNode;
  onOpenLane: (id: string) => void;
}) {
  return (
    <section className="now-sec" aria-label={title}>
      <h2 className="now-h">
        {title} <b className="now-h__n">{items.length}</b>
      </h2>
      {items.length === 0 ? (
        <p className="now-empty">{empty}</p>
      ) : (
        <ul className="now-list">
          {items.slice(0, QUIET_ROWS).map((w) => (
            <li key={w.id} className="now-row">
              <button
                type="button"
                className="now-row__hit"
                title={w.title}
                onClick={() => onOpenLane(w.id.replace(/^lane:/, ''))}
              >
                <span className="now-row__title">{w.title}</span>
                <span className="now-row__meta">
                  {who(w.owner)}
                  {w.goal && <span className="now-row__goal">{w.goal}</span>}
                  <span className="now-row__age">{age(w.since)}</span>
                </span>
              </button>
            </li>
          ))}
          {more(Math.min(items.length, QUIET_ROWS), items.length)}
        </ul>
      )}
    </section>
  );
}

function Shipped({
  items,
  who,
  age,
  more,
  onOpenLane,
}: {
  items: readonly ShippedItem[];
  who: (name: string | null) => ReactNode;
  age: (since: number) => string;
  more: (shown: number, total: number) => ReactNode;
  onOpenLane: (id: string) => void;
}) {
  return (
    <section className="now-sec" aria-label="Shipped in the last 24 hours">
      <h2 className="now-h">
        Shipped <span className="now-h__sub">24 h</span> <b className="now-h__n">{items.length}</b>
      </h2>
      {items.length === 0 ? (
        <p className="now-empty">nothing has landed today</p>
      ) : (
        <ul className="now-list">
          {items.slice(0, QUIET_ROWS).map((s) => (
            <li key={s.id} className="now-row now-row--done">
              <button
                type="button"
                className="now-row__hit"
                title={s.title}
                onClick={() => onOpenLane(s.id.replace(/^lane:/, ''))}
              >
                <span className="now-row__title">{s.title}</span>
                <span className="now-row__meta">
                  {who(s.by)}
                  <span className="now-row__age">{age(s.at)} ago</span>
                </span>
              </button>
            </li>
          ))}
          {more(Math.min(items.length, QUIET_ROWS), items.length)}
        </ul>
      )}
    </section>
  );
}
