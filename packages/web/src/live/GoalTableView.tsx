import type { Goal, GoalFlow, Lane, LaneWarning, MemberSummary } from '@musterd/protocol';
import { useMemo } from 'react';
import { buildGoalTable, type GoalRow } from './goalTable';
import { initial, kindOf, memberAvatar, hueOf } from './format';
import './GoalGrid.css';
import './GoalTable.css';

/**
 * The board's table view (board readability inc 2): one row per goal, the questions nick asked a
 * seat on 2026-10-05 read off one screen — who owns what, what is unowned, what it waits on, what
 * went quiet, who owns the last thing that moved. Pure render of {@link buildGoalTable}; the goal
 * name is the drill-in, the same one a grid card is.
 */
export function GoalTable({
  lanes,
  goals,
  warnings,
  goalFlow,
  roster,
  onOpenGoal,
}: {
  lanes: Lane[];
  goals: Goal[];
  warnings: LaneWarning[];
  goalFlow?: GoalFlow[] | undefined;
  roster: MemberSummary[];
  onOpenGoal: (goalId: string | null) => void;
}) {
  const now = Date.now();
  const rows = useMemo(
    () => buildGoalTable(lanes, goals, now, warnings, goalFlow),
    [lanes, goals, now, warnings, goalFlow],
  );
  const rosterIdx = useMemo(() => new Map(roster.map((m) => [m.name, m])), [roster]);
  const unowned = rows.reduce((n, r) => n + r.unowned, 0);
  const quiet = rows.reduce((n, r) => n + r.quiet, 0);

  return (
    <div className="gg-stage">
      <header className="gg-hdr">
        <div>
          <h2 className="gg-title">
            Who&apos;s on <em>what</em>
          </h2>
          <p className="gg-sub">
            {rows.length} goal{rows.length === 1 ? '' : 's'} · {unowned} unowned · {quiet} quiet
            14d+ · live lanes only
          </p>
        </div>
      </header>
      <div className="gt-scroll">
        <table className="gt">
          <thead>
            <tr>
              <th scope="col">Goal</th>
              <th scope="col">Owners</th>
              <th scope="col" className="gt-num">
                Unowned
              </th>
              <th scope="col">Waiting on</th>
              <th scope="col" className="gt-num">
                Quiet 14d+
              </th>
              <th scope="col">Last moved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Row
                key={row.id ?? '∅'}
                row={row}
                now={now}
                rosterIdx={rosterIdx}
                onOpen={() => onOpenGoal(row.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  row,
  now,
  rosterIdx,
  onOpen,
}: {
  row: GoalRow;
  now: number;
  rosterIdx: Map<string, MemberSummary>;
  onOpen: () => void;
}) {
  const unheld = row.review - row.reviewers.length;
  return (
    <tr className={row.id === null ? 'gt-row gt-row--loose' : 'gt-row'}>
      <th scope="row" className="gt-goal">
        <button className="gt-goal__btn" onClick={onOpen} title="Show this goal's lanes">
          {row.title}
        </button>
        <span className="gt-goal__meta">
          {row.live} live · {row.chip}
        </span>
      </th>
      <td>
        {row.owners.length === 0 ? (
          <span className="gt-none">nobody</span>
        ) : (
          <ul className="gt-owners">
            {row.owners.map((o) => (
              <li key={o.seat} className="gt-owner">
                <span
                  className="gt-owner__av"
                  style={{
                    background: memberAvatar(o.seat, kindOf(o.seat, rosterIdx), hueOf(o.seat, rosterIdx)),
                  }}
                  aria-hidden="true"
                >
                  {initial(o.seat)}
                </span>
                {o.seat}
                {o.n > 1 && <span className="gt-owner__n">{o.n}</span>}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className={`gt-num${row.unowned > 0 ? ' gt-num--hot' : ''}`}>{row.unowned || '—'}</td>
      <td>
        <div className="gt-wait">
        {row.blocked === 0 && row.review === 0 && <span className="gt-none">—</span>}
        {row.blocked > 0 && <span className="gt-wait__blocked">{row.blocked} blocked</span>}
        {row.reviewers.length > 0 && (
          <span>
            review → <b>{row.reviewers.join(', ')}</b>
          </span>
        )}
        {unheld > 0 && <span className="gt-none">{unheld} in review, no holder</span>}
        </div>
      </td>
      <td className={`gt-num${row.quiet > 0 ? ' gt-num--hot' : ''}`}>{row.quiet || '—'}</td>
      <td className="gt-last">
        {row.lastMoved ? (
          <>
            <span className="gt-last__title">{row.lastMoved.title}</span>
            <span className="gt-last__meta">
              {row.lastMoved.owner ?? 'unowned'} · {age(now - row.lastMoved.at)}
            </span>
          </>
        ) : (
          <span className="gt-none">—</span>
        )}
      </td>
    </tr>
  );
}

function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}
