import type { Envelope, HuddleView, MemberSummary } from '@musterd/protocol';
import { clock, hueOf, initial, kindOf, memberAvatar } from './format';
import { huddleBudget, sinceOpen } from './huddles';

/**
 * A huddle as ONE card in the Stream (huddle replay increment 1, nick 2026-10-01).
 *
 * The Stream places it at the huddle's latest row (`streamPlacement`), so the room the audience is
 * watching stays at the live edge while its turns gather inside it, in order, each with its
 * time-to-turn in the close-note format (`miley +1.4m`). Every line keeps its act's `lc-msg-<id>`
 * reveal target, so a quote, the asks strip or an office bubble still lands on the exact turn.
 *
 * It reads the same `HuddleView` the rail over the office reads — one fold, every surface — and,
 * like the rail, never enforces: an over-budget huddle says so and stays.
 */
export function StreamHuddleCard({
  view,
  byId,
  idx,
  now,
  liveIds,
}: {
  view: HuddleView;
  byId: Map<string, Envelope>;
  idx: Map<string, MemberSummary>;
  /** This card holds the stream's newest row — it wears the live-edge treatment a plain row would. */
  now: boolean;
  /** Rows that arrived live this session — a turn among them enters with the row animation. */
  liveIds: Set<string>;
}) {
  const budget = huddleBudget(view, Date.now());
  const silent = view.named.filter((n) => !view.spoke.includes(n));
  const closing = view.closed ? closeRow(view, byId) : undefined;
  const turns =
    budget.turnsDeclared === undefined
      ? `${budget.turnsUsed} ${budget.turnsUsed === 1 ? 'turn' : 'turns'}`
      : `${budget.turnsUsed} of ${budget.turnsDeclared} turns${budget.overTurns ? ' — over' : ''}`;
  return (
    <article
      className={`lc-hcard${now ? ' lc-row--now' : ''}${view.closed ? ' is-closed' : ''}${budget.phase === 'spent' ? ' is-spent' : ''}`}
      aria-label={`huddle on ${view.topic.replace(":", " ")}`}
    >
      <div className="lc-hcard__head">
        <time className="lc-row__ts">{clock(view.openedAt)}</time>
        <span className="lc-badge lc-badge--huddle">huddle</span>
        <Topic topic={view.topic} />
        <span className="lc-hcard__count">{turns}</span>
        <span className="lc-hcard__state">
          {/* Live only while it is: the dot goes when the room closes (motion means "now"). */}
          {!view.closed && <span className="lc-hcard__live" aria-hidden="true" />}
          {view.closed ? 'closed' : 'open'}
        </span>
      </div>
      <div id={`lc-msg-${view.id}`} className="lc-hcard__line lc-hcard__line--open">
        <Who name={view.opener} idx={idx} />
        <span className="lc-hcard__body">{view.body}</span>
      </div>
      {view.turns.length > 0 && (
        <ol className="lc-hcard__turns">
          {view.turns.map((t) => (
            <li
              key={t.id}
              id={`lc-msg-${t.id}`}
              className={`lc-hcard__line${t.act === 'steer' ? ' is-steer' : ''}${liveIds.has(t.id) ? ' lc-row--enter' : ''}`}
            >
              <Who name={t.from} idx={idx} />
              <span className="lc-hcard__since">{sinceOpen(t.ts - view.openedAt)}</span>
              <span className="lc-hcard__body">
                {t.act === 'steer' && <span className="lc-badge lc-badge--steer">steer</span>}
                {t.body}
              </span>
            </li>
          ))}
        </ol>
      )}
      {closing ? (
        <div id={`lc-msg-${closing.id}`} className="lc-hcard__foot">
          closed by {closing.from} · {sinceOpen(closing.ts - view.openedAt)}
          {closing.body && <span className="lc-hcard__body"> — {closing.body}</span>}
        </div>
      ) : (
        silent.length > 0 && (
          // Who is still expected, drawn as empty seats beside the filled ones above — the room
          // visibly fills as each one speaks and moves up into the turns.
          <div className="lc-hcard__foot lc-hcard__waiting">
            {silent.map((n) => (
              <span key={n} className="lc-hcard__waiting-seat">
                <span className="lc-hcard__waiting-dot" aria-hidden="true">
                  {initial(n)}
                </span>
                {n}
              </span>
            ))}
            <span>yet to speak</span>
          </div>
        )
      )}
    </article>
  );
}

/** `goal:demo` → a quiet `goal` and the name that matters, `demo`. */
function Topic({ topic }: { topic: string }) {
  const i = topic.indexOf(':');
  if (i < 0) return <span className="lc-hcard__topic">{topic}</span>;
  return (
    <span className="lc-hcard__topic">
      <span className="lc-hcard__kind">{topic.slice(0, i)}</span>
      {topic.slice(i + 1)}
    </span>
  );
}

function Who({ name, idx }: { name: string; idx: Map<string, MemberSummary> }) {
  return (
    <span className="lc-chip lc-hcard__who">
      <span
        className="lc-chip__avatar"
        style={{ background: memberAvatar(name, kindOf(name, idx), hueOf(name, idx)) }}
      >
        {initial(name)}
      </span>
      <span className="lc-chip__name">{name}</span>
    </span>
  );
}

/** The resolve that closed the room — the thread row `closed` points at by time and sender. */
function closeRow(view: HuddleView, byId: Map<string, Envelope>): Envelope | undefined {
  for (const e of byId.values())
    if (e.thread === view.id && e.act === 'resolve' && e.ts === view.closed!.at) return e;
  return undefined;
}
