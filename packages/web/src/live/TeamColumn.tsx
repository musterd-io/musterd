import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import type { AskView } from './asks';
import { CaptionPill } from './CaptionPill';
import type { Caption } from './captions';
import type { LiveConfig } from './client';
import { acceptanceCapacity, initial, memberAvatar, memberColor } from './format';
import { modelBadge } from './modelBadge';
import { providerIconHtml } from './modelProviderIcon';
import { Experiments, ReadMark } from './Experiments';
import { useLiveSamples } from './useLiveSamples';
import { experimentEntries, withLivePoints } from './experimentReads';
import { CollapseButton, PanelRail } from './PanelChrome';
import { TeamCard } from './TeamCard';
import { teamCards, type TeamCard as TeamCardModel } from './teamCards';

/**
 * The narrator's own colour, from the same roster the floor is drawn from — so the caption pill's
 * dot, their floor plate and their card are one identity. A caption can name someone who is not
 * in the working list (an arrival, above all), so this reads the roster, not the cards.
 */
export function captionColorFor(
  roster: MemberSummary[],
  caption: Caption | null,
): string | undefined {
  const narrator = caption ? roster.find((m) => m.name === caption.who) : undefined;
  return narrator
    ? memberColor(narrator.name, narrator.kind === 'human' ? 'human' : 'agent', narrator.hue)
    : undefined;
}

/**
 * The team column (ADR 464): who is here, which model each agent runs, and what each is doing —
 * readable from the back of a room. Replaces the roster rail on /live; the operator detail it
 * carried is one click down on every card. Collapsed, it is a rail of avatars with provider logos.
 *
 * `still` is the stream's column (`/broadcast`, ADR 464 lane 5): the same cards with nothing to
 * press, and none of the operator notes — a Twitch viewer cannot reload a seat.
 */
export function TeamColumn({
  loading = false,
  roster,
  board,
  goals,
  collapsed = false,
  onCollapse,
  linked = null,
  onLink,
  caption = null,
  captionColor,
  now = Date.now(),
  cfg = null,
  daemonBuild,
  daemonEpoch,
  unreadable = 0,
  stale = false,
  asks = [],
  still = false,
  you = null,
}: {
  /** Nothing loaded yet: card-shaped placeholders instead of an empty team saying "0 working". */
  loading?: boolean;
  roster: MemberSummary[];
  board: LaneBoard | null;
  goals: readonly { id: string; title: string }[];
  /** The derived asks, clock applied (ADR 464 §4): an open one to a human makes a card say
   *  "asking nick". */
  asks?: readonly AskView[];
  collapsed?: boolean;
  /** Absent on a phone (spec §2): one full-width column, nothing to fold. */
  onCollapse?: (() => void) | undefined;
  /** The member whose character is under the pointer on the floor (or whose card is hovered). */
  linked?: string | null;
  onLink?: (name: string | null) => void;
  caption?: Caption | null;
  captionColor?: string | undefined;
  /** The clock cards age against — passed so one render has one `now`, and a test can name it. */
  now?: number;
  cfg?: LiveConfig | null;
  /** The daemon's build ref (ADR 135) — operator detail, in a behind seat's tooltip. */
  daemonBuild?: string | undefined;
  /** The daemon's feature epoch (ADR 148) — a live seat below it wears a calm `behind` tag. */
  daemonEpoch?: number | undefined;
  /** Seats this bundle could not read (`fetchRoster`) — said here because this is the only
   *  surface that knows the count it shows is short. */
  unreadable?: number;
  /** The roster refetch is failing persistently; these cards are frozen at the last good read. */
  stale?: boolean;
  /** Non-interactive (a stream source): no hover link, no expanding, no operator notes. */
  still?: boolean;
  /** The signed-in viewer's seat — its card wears a "you" tag. `/live` only; observers pass null. */
  you?: string | null;
}) {
  const { cards, offline } = teamCards(roster, board, goals, asks);
  const working = cards.filter((c) => c.state === 'working').length;
  const dated = loading ? [] : experimentEntries(board, now);
  // ADR 701: the charts' live points — polled only while some read has a chart to move.
  const live = useLiveSamples(cfg, dated.some((e) => e.metric !== null && e.status !== 'read'));
  const reads = withLivePoints(dated, live);
  // A read's owner wears the same avatar their card does, offline seats included.
  const avatarOf = (seat: string) => {
    const m = roster.find((r) => r.name === seat);
    if (!m) return null;
    const kind = m.kind === 'human' ? 'human' : 'agent';
    return { background: memberAvatar(m.name, kind, m.hue), initial: initial(m.name) };
  };
  if (collapsed) {
    const overdue = reads.filter((e) => e.status === 'overdue').length;
    return (
      <aside className="lc-team is-collapsed" aria-label="The team">
        {onCollapse && (
          <PanelRail side="mid" label="Team" hint={String(cards.length)} onExpand={onCollapse} />
        )}
        {overdue > 0 && (
          <p
            className="lc-team__overdue"
            title={`${overdue} overdue read${overdue === 1 ? '' : 's'}`}
            aria-label={`${overdue} overdue read${overdue === 1 ? '' : 's'}`}
          >
            <ReadMark status="overdue" />
            {overdue}
          </p>
        )}
        <ul className="lc-team__rail">
          {cards.map((c) => {
            const b = modelBadge(c.member);
            const showLogo = b.source !== 'human' && b.source !== 'service';
            const what = `${c.stateLabel}${c.title ? ` ${c.title}` : ''}`;
            return (
              <li
                key={c.name}
                className={`lc-team__pip lc-team__pip--${c.state}${linked === c.name ? ' is-linked' : ''}`}
                data-member={c.name}
                aria-label={`${c.name} — ${b.label} — ${what}`}
                title={`${c.name} · ${b.label} · ${what}`}
                onMouseEnter={() => onLink?.(c.name)}
                onMouseLeave={() => onLink?.(null)}
              >
                <span
                  className="lc-team__pip-avatar"
                  style={{ background: memberAvatar(c.name, c.kind, c.member.hue) }}
                >
                  {initial(c.name)}
                </span>
                {showLogo && (
                  <span
                    className="lc-team__pip-logo"
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: providerIconHtml(b.provider, b.full) }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </aside>
    );
  }
  return (
    <aside className="lc-team" aria-label="The team">
      <header className="lc-team__head">
        <span className="lc-team__title">The team</span>
        <span className="lc-team__count">
          {loading ? <i className="lc-skel" style={{ width: '5em' }} /> : `${working} working`}
        </span>
        <span className="lc-team__spacer" />
        {onCollapse && <CollapseButton side="mid" label="the team" onClick={onCollapse} />}
      </header>
      <CaptionPill caption={caption} color={captionColor} className="lc-team__caption" />
      {loading && (
        <ul className="lc-team__cards" aria-label="Loading the team">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="lc-team-card lc-team-card--skel">
              <i className="lc-skel lc-skel--face" />
              <i className="lc-skel" style={{ width: '40%' }} />
              <i className="lc-skel" style={{ width: '85%' }} />
            </li>
          ))}
        </ul>
      )}
      <ul className="lc-team__cards">
        {(still ? cards.filter((c) => !IDLE.has(c.state)) : cards).map((c) => (
          <TeamCard
            key={c.name}
            card={c}
            now={now}
            linked={linked === c.name}
            onLink={onLink}
            cfg={cfg}
            daemonBuild={daemonBuild}
            daemonEpoch={daemonEpoch}
            still={still}
            you={you === c.name}
          />
        ))}
      </ul>
      {still && <IdleStrip cards={cards.filter((c) => IDLE.has(c.state))} />}
      {offline > 0 && <p className="lc-team__offline">+ {offline} offline</p>}
      {board && !loading && <Experiments entries={reads} now={now} avatarOf={avatarOf} still={still} stale={stale} />}
      {!still && <TeamColumnNotes roster={roster} unreadable={unreadable} stale={stale} />}
    </aside>
  );
}

/** States with nothing in hand — on a stream they are names, not cards. */
const IDLE: ReadonlySet<TeamCardModel['state']> = new Set(['between', 'away']);

/**
 * The stream's idle seats, as one strip of avatars with names (nick, 2026-10-06: the column "is
 * taking up a little too much real estate"). Measured on the live frame that day: ten cards, two
 * working, and eight full cards of "between tasks" each quoting a stale status line — most of a
 * full-height column spent on the seats with nothing to watch. A viewer needs to know they are
 * here, not what they last said. /live keeps the cards: there an operator can open one.
 */
function IdleStrip({ cards }: { cards: TeamCardModel[] }) {
  if (cards.length === 0) return null;
  return (
    <section className="lc-team__idle" aria-label="Between tasks">
      <p className="lc-team__idle-head">
        Between tasks <span className="lc-team__idle-count">{cards.length}</span>
      </p>
      <ul className="lc-team__idle-list">
        {cards.map((c) => (
          <li
            key={c.name}
            className={`lc-team__idle-seat${c.state === 'away' ? ' is-away' : ''}`}
            title={`${c.name} · ${c.stateLabel}`}
          >
            <span
              className="lc-team__idle-avatar"
              aria-hidden="true"
              style={{ background: memberAvatar(c.name, c.kind, c.member.hue) }}
            >
              {initial(c.name)}
            </span>
            {c.name}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The ways this list can quietly lie, each said out loud in one line — carried over from the roster
 * rail (same `lc-roster__gap` markup, so the styles are one home). Deliberately NOT an error: the
 * room beside it is live, and ADR 148's promise is that a client behind the daemon degrades calmly.
 */
function TeamColumnNotes({
  roster,
  unreadable,
  stale,
}: {
  roster: MemberSummary[];
  unreadable: number;
  stale: boolean;
}) {
  // Whether the review ladder under this team is standing up (ADR 188) — a fact about the team,
  // so it sits beside the other things this list can be quietly wrong about.
  const capacity = acceptanceCapacity(roster);
  return (
    <>
      {unreadable > 0 && (
        <p className="lc-roster__gap" role="status">
          {unreadable} seat{unreadable === 1 ? '' : 's'} newer than this page — reload to meet{' '}
          {unreadable === 1 ? 'them' : 'them all'}.
        </p>
      )}
      {capacity.degraded && (
        <p className="lc-roster__gap is-ladder" role="status">
          <b>No live acceptor.</b>{' '}
          {capacity.models.length === 1
            ? `Every live agent is on ${capacity.models[0]}, and a seat cannot accept its own model's work — so every review is waiting on a wake.`
            : "No live seat can accept another seat's work, so every review is waiting on a wake."}
        </p>
      )}
      {capacity.unattested.length > 0 && (
        <p className="lc-roster__gap" role="status">
          {capacity.unattested.join(', ')} attest{capacity.unattested.length === 1 ? 's' : ''} no
          model, so {capacity.unattested.length === 1 ? 'it can' : 'they can'} neither review nor be
          reviewed.
        </p>
      )}
      {stale && (
        <p className="lc-roster__gap is-stale" role="status">
          Roster paused — showing the last good read.
        </p>
      )}
    </>
  );
}
