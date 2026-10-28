import type { Goal, GoalFlow, Lane, LaneWarning, MemberSummary } from '@musterd/protocol';
import { useMemo } from 'react';
import { buildGoalTable, type GoalRow } from './goalTable';
import { initial, kindOf, memberDisc, hueOf } from './format';
import { ago } from './GoalGridView';
import './GoalGrid.css';
import './GoalTable.css';

/**
 * The board's table view (board readability inc 2): one row per goal, the questions nick asked a
 * seat on 2026-10-05 read off one screen — who owns what, what is unowned, what it waits on, what
 * went quiet, who owns the last thing that moved.
 *
 * Dense by design (nick, 2026-10-05: "I need to see more without scrolling"): one line per goal, a
 * stacked bar for its live lanes by stage, avatars instead of names, and a fixed layout that never
 * scrolls sideways — it reflows to two-line rows when its container is narrow. Pure render of
 * {@link buildGoalTable}; the goal name is the drill-in, the same one a grid card is.
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
  const sum = (k: 'unowned' | 'quiet' | 'blocked' | 'review') => rows.reduce((n, r) => n + r[k], 0);
  const widest = Math.max(1, ...rows.map((r) => r.live));
  // Goals with nothing live take one closing line, not a row each: they answer no question here.
  const busy = rows.filter((r) => r.live > 0);
  const idle = rows.filter((r) => r.live === 0);

  return (
    <div className="gg-stage gt-wrap">
      <header className="gt-hdr">
        <h2 className="gg-title">
          Who&apos;s on <em>what</em>
        </h2>
        <ul className="gt-stats" aria-label="Across all goals">
          <li className="gt-stat">
            <b>{rows.length}</b> goals
          </li>
          <li className="gt-stat gt-stat--hot">
            <b>{sum('unowned')}</b> unowned
          </li>
          <li className="gt-stat gt-stat--blocked">
            <b>{sum('blocked')}</b> blocked
          </li>
          <li className="gt-stat gt-stat--review">
            <b>{sum('review')}</b> in review
          </li>
          <li className="gt-stat">
            <b>{sum('quiet')}</b> quiet 14d+
          </li>
        </ul>
        <span className="gt-legend" aria-hidden="true">
          <i className="gt-seg--open" /> backlog <i className="gt-seg--working" /> working{' '}
          <i className="gt-seg--blocked" /> blocked <i className="gt-seg--review" /> review
        </span>
      </header>
      <table className="gt">
        <colgroup>
          <col className="gt-c-goal" />
          <col className="gt-c-lanes" />
          <col className="gt-c-owners" />
          <col className="gt-c-unowned" />
          <col className="gt-c-wait" />
          <col className="gt-c-quiet" />
          <col className="gt-c-last" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Goal</th>
            <th scope="col">Lanes</th>
            <th scope="col">Owners</th>
            <th scope="col" className="gt-num">
              Unowned
            </th>
            <th scope="col">Waiting on</th>
            <th scope="col" className="gt-num">
              Quiet
            </th>
            <th scope="col">Last moved</th>
          </tr>
        </thead>
        <tbody>
          {busy.map((row) => (
            <Row
              key={row.id ?? '∅'}
              row={row}
              widest={widest}
              now={now}
              rosterIdx={rosterIdx}
              onOpen={() => onOpenGoal(row.id)}
            />
          ))}
        </tbody>
      </table>
      {idle.length > 0 && (
        <p className="gt-idle">
          <span className="gt-idle__label">nothing live</span>
          {idle.map((r) => (
            <button
              key={r.id ?? '∅'}
              className="gt-idle__goal"
              onClick={() => onOpenGoal(r.id)}
              title={r.title}
            >
              {r.name}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

function Row({
  row,
  widest,
  now,
  rosterIdx,
  onOpen,
}: {
  row: GoalRow;
  widest: number;
  now: number;
  rosterIdx: Map<string, MemberSummary>;
  onOpen: () => void;
}) {
  const unheld = row.review - row.reviewers.length;
  const stages = (['open', 'working', 'blocked', 'review'] as const).filter((k) => row.mix[k] > 0);
  return (
    <tr className={row.id === null ? 'gt-row gt-row--loose' : 'gt-row'}>
      <th scope="row" className="gt-goal">
        <button className="gt-goal__btn" onClick={onOpen} title={row.title}>
          {row.name}
        </button>
        {row.blurb && <span className="gt-goal__blurb">{row.blurb}</span>}
      </th>
      <td>
        <span className="gt-goal__line">
          <span
            className="gt-bar"
            // sqrt, so a 3-lane goal still reads as a bar beside a 47-lane one.
            style={{ width: `${Math.max(14, Math.sqrt(row.live / widest) * 100)}%` }}
            aria-label={stages.map((k) => `${row.mix[k]} ${k}`).join(', ')}
            role="img"
          >
            {stages.map((k) => (
              <i key={k} className={`gt-seg--${k}`} style={{ flexGrow: row.mix[k] }} />
            ))}
          </span>
          <span className="gt-goal__n">{row.live}</span>
        </span>
      </td>
      <td className="gt-owners" title={row.owners.map((o) => `${o.seat} ${o.n}`).join(', ')}>
        {row.owners.length === 0 ? (
          <span className="gt-none">nobody</span>
        ) : (
          <>
            <Avatars seats={row.owners.map((o) => o.seat)} rosterIdx={rosterIdx} />
            <span className="gt-owners__lead">
              {row.owners[0]!.seat}
              {row.owners.length > 1 && <span className="gt-quiet"> +{row.owners.length - 1}</span>}
            </span>
            <span className="gt-sr">
              owners: {row.owners.map((o) => `${o.seat} ${o.n}`).join(', ')}
            </span>
          </>
        )}
      </td>
      <td className="gt-num">
        <Pill n={row.unowned} tone="hot" />
      </td>
      <td className="gt-wait">
        {row.blocked > 0 && <span className="gt-pill gt-pill--blocked">{row.blocked} blocked</span>}
        {row.reviewers.length > 0 && (
          <span className="gt-review" title={`Review waits on ${row.reviewers.join(', ')}`}>
            <span className="gt-review__arrow" aria-hidden="true">
              →
            </span>
            <Avatars seats={row.reviewers} rosterIdx={rosterIdx} />
            <span className="gt-sr">review waits on {row.reviewers.join(', ')}</span>
          </span>
        )}
        {unheld > 0 && (
          <span className="gt-pill gt-pill--review" title={`${unheld} in review with no holder`}>
            {unheld} unheld
          </span>
        )}
        {row.blocked === 0 && row.review === 0 && <span className="gt-none">—</span>}
      </td>
      <td className="gt-num">
        <Pill n={row.quiet} tone="quiet" />
      </td>
      <td className="gt-last" title={row.lastMoved?.title}>
        {row.lastMoved ? (
          <>
            {row.lastMoved.owner ? (
              <Avatars seats={[row.lastMoved.owner]} rosterIdx={rosterIdx} />
            ) : (
              <span className="gt-av gt-av--none" aria-hidden="true">
                ∅
              </span>
            )}
            <span className="gt-last__title">{row.lastMoved.title}</span>
            <span className="gt-last__age">{ago(now, row.lastMoved.at)}</span>
          </>
        ) : (
          <span className="gt-none">—</span>
        )}
      </td>
    </tr>
  );
}

const STACK = 4;

function Avatars({ seats, rosterIdx }: { seats: string[]; rosterIdx: Map<string, MemberSummary> }) {
  return (
    <span className="gt-avs" aria-hidden="true">
      {seats.slice(0, STACK).map((s) => (
        <span
          key={s}
          className="gt-av"
          style={memberDisc(s, kindOf(s, rosterIdx), hueOf(s, rosterIdx))}
        >
          {initial(s)}
        </span>
      ))}
      {seats.length > STACK && <span className="gt-av gt-av--more">+{seats.length - STACK}</span>}
    </span>
  );
}

function Pill({ n, tone }: { n: number; tone: 'hot' | 'quiet' }) {
  return n > 0 ? (
    <span className={`gt-pill gt-pill--${tone}`}>{n}</span>
  ) : (
    <span className="gt-none">—</span>
  );
}
