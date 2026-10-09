import type { MemberSummary } from '@musterd/protocol';
import { useState } from 'react';
import { waitingFor, type Briefing, type GoalMotion, type ShippedGroup } from './briefing';
import { coarseAge, rosterIndex } from './format';
import { MemberFace } from './MemberFace';

/**
 * The Now card's body (live-briefing spec, "The Now card, v2"): what a member reads when they sit down
 * having forgotten yesterday. What waits on **you**, the goals that are **moving** — how far along,
 * what is moving, whose faces are on them — and what landed **by who landed it**.
 *
 * Colour on this card means something, and comes from three places only: the members' own faces, the
 * mustard band for what waits on you (and the goal bars), and danger ink on "blocked". nick turned
 * down a glow, a rainbow, a legend and initials on the way here; the spec keeps the list.
 */

/** Rows shown before "N more" in the overlay. Full view shows everything. */
export const CAP = { goals: 4, people: 4, faces: 3 } as const;

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

/** "4 working · 1 in review" — the non-zero states of a goal, blocked kept apart for its ink. */
export function goalStates(g: Pick<GoalMotion, 'working' | 'review'>): string {
  return [g.working ? `${g.working} working` : null, g.review ? `${g.review} in review` : null]
    .filter(Boolean)
    .join(' · ');
}

/** "2 waiting on sloane · 1 seat request" — what waits on everyone but the viewer, as one line. */
export function othersLine(others: readonly { who: string; n: number }[]): string {
  return others
    .map(({ who, n }) =>
      who === 'an admin' ? `${n} seat request${n === 1 ? '' : 's'}` : `${n} waiting on ${who}`,
    )
    .join(' · ');
}

export interface NowCardProps {
  brief: Briefing;
  roster: readonly MemberSummary[];
  /** The signed-in member, or null for an observer: whose asks get the band. */
  viewer: string | null;
  now: number;
  /** Where the shipped list starts (`briefingSince`). */
  since: number;
  /** Full screen: nothing capped. */
  full: boolean;
  onOpenAsk: (envelopeId: string) => void;
  onOpenLane: (laneId: string) => void;
  /** Opens the board drilled into a goal; null is the "No goal" row. */
  onOpenGoal: (goalId: string | null) => void;
  /** Lights these members' plates in the office while a goal row is under the pointer or focus. */
  onLight: (names: readonly string[] | null) => void;
}

export function NowCard({
  brief,
  roster,
  viewer,
  now,
  since,
  full,
  onOpenAsk,
  onOpenLane,
  onOpenGoal,
  onLight,
}: NowCardProps) {
  const idx = rosterIndex(roster as MemberSummary[]);
  const [allGoals, setAllGoals] = useState(false);
  const [allPeople, setAllPeople] = useState(false);
  const { mine, others } = waitingFor(brief, viewer);
  const top = mine[0];
  const goals = full || allGoals ? brief.goalsInMotion : brief.goalsInMotion.slice(0, CAP.goals);
  const people = full || allPeople ? brief.shippedBy : brief.shippedBy.slice(0, CAP.people);

  return (
    <div className={`nowc${full ? ' is-full' : ''}`}>
      {top && (
        <div className="nowc-you">
          {top.owner && <MemberFace name={top.owner} roster={idx} size={32} />}
          <div className="nowc-you__text">
            <p className="nowc-you__k">
              Waiting on you{mine.length > 1 ? ` · ${mine.length}` : ''}
            </p>
            <p className="nowc-you__what">{top.title}</p>
            <p className="nowc-you__who">
              {top.owner ?? 'a seat request'} · {coarseAge(now - top.since)}
            </p>
          </div>
          <button type="button" className="nowc-you__go" onClick={() => onOpenAsk(top.ref)}>
            Answer
          </button>
        </div>
      )}
      {others.length > 0 && <p className="nowc-others">{othersLine(others)}</p>}

      <div className="nowc-cols">
        <section className="nowc-sec" aria-labelledby="nowc-goals">
          <h3 className="nowc-h" id="nowc-goals">
            Goals in motion
          </h3>
          {goals.length === 0 ? (
            <p className="nowc-empty">Nothing is moving right now.</p>
          ) : (
            <ul className="nowc-list">
              {goals.map((g) => (
                <GoalRow key={g.key} g={g} idx={idx} onOpen={onOpenGoal} onLight={onLight} />
              ))}
            </ul>
          )}
          {!full && !allGoals && brief.goalsInMotion.length > CAP.goals && (
            <button type="button" className="nowc-more" onClick={() => setAllGoals(true)}>
              {brief.goalsInMotion.length - CAP.goals} more goals
            </button>
          )}
        </section>

        <section className="nowc-sec nowc-sec--ship" aria-labelledby="nowc-ship">
          <h3 className="nowc-h" id="nowc-ship">
            Shipped since {sinceLabel(since, now)}
          </h3>
          {people.length === 0 ? (
            <p className="nowc-empty">Nothing has shipped yet.</p>
          ) : (
            <ul className="nowc-list">
              {people.map((p) => (
                <ShipRow key={p.who} p={p} idx={idx} onOpen={onOpenLane} />
              ))}
            </ul>
          )}
          {!full && !allPeople && brief.shippedBy.length > CAP.people && (
            <button type="button" className="nowc-more" onClick={() => setAllPeople(true)}>
              {brief.shippedBy.length - CAP.people} more people
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function GoalRow({
  g,
  idx,
  onOpen,
  onLight,
}: {
  g: GoalMotion;
  idx: Map<string, MemberSummary>;
  onOpen: (goalId: string | null) => void;
  onLight: (names: readonly string[] | null) => void;
}) {
  const states = goalStates(g);
  const pct = g.total ? Math.round((100 * g.done) / g.total) : 0;
  const shown = g.people.slice(0, CAP.faces);
  const label = [
    g.title,
    `${g.done} of ${g.total} done`,
    states,
    g.blocked ? `${g.blocked} blocked` : '',
    g.people.length ? `with ${g.people.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const light = () => onLight(g.people);
  const dark = () => onLight(null);
  return (
    <li>
      <button
        type="button"
        className="nowc-goal"
        aria-label={label}
        title={g.title}
        onClick={() => onOpen(g.goalId)}
        onMouseEnter={light}
        onMouseLeave={dark}
        onFocus={light}
        onBlur={dark}
      >
        <span className="nowc-goal__name">{g.name}</span>
        <span className="nowc-faces" aria-hidden="true">
          {shown.map((p) => (
            <MemberFace key={p} name={p} roster={idx} />
          ))}
          {g.people.length > shown.length && (
            <span className="nowc-faces__more">+{g.people.length - shown.length}</span>
          )}
        </span>
        <span className="nowc-bar" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="nowc-goal__of" aria-hidden="true">
          {g.done} of {g.total} done
        </span>
        <span className="nowc-goal__state" aria-hidden="true">
          {states}
          {states && g.blocked ? ' · ' : ''}
          {g.blocked > 0 && <span className="nowc-blocked">{g.blocked} blocked</span>}
        </span>
      </button>
    </li>
  );
}

function ShipRow({
  p,
  idx,
  onOpen,
}: {
  p: ShippedGroup;
  idx: Map<string, MemberSummary>;
  onOpen: (laneId: string) => void;
}) {
  const latest = p.items[0];
  return (
    <li>
      <button
        type="button"
        className="nowc-shiprow"
        title={latest?.title}
        onClick={() => latest && onOpen(latest.id.replace(/^lane:/, ''))}
      >
        <MemberFace name={p.who} roster={idx} />
        <span className="nowc-shiprow__who">{p.who}</span>
        <span className="nowc-shiprow__n">{p.items.length}</span>
        {latest && <span className="nowc-shiprow__last">{latest.title}</span>}
      </button>
    </li>
  );
}
