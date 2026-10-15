import { lazy, Suspense, useState } from 'react';
import type { LiveConfig } from './client';
import { initial, isFeatureBehind, memberAvatar } from './format';
import { modelBadge } from './modelBadge';
import { providerIconHtml } from './modelProviderIcon';
import { elapsed, type TeamCard as Card } from './teamCards';

/** The expanded operator detail, fetched on the first expand: most visits never open a card, and
 *  RosterPanel rode /live's initial download only for this (lane 01M4RNDW6Z). */
const SeatDetail = lazy(() => import('./RosterPanel').then((m) => ({ default: m.SeatDetail })));

/**
 * One member, read by a room (ADR 464, spec §4): avatar, name, the model badge (provider logo +
 * readable name, or "human"), a plain-language state, and what they are on in big type. Hover or
 * focus links the card to the member's character on the floor; click expands to the operator
 * detail the roster row used to carry.
 *
 * `still` is the stream's card (`/broadcast`, ADR 464 lane 5): the same face, but nobody can point
 * at a stream, so there is no hit area, no link and no detail to open.
 */
export function TeamCard({
  card,
  now,
  linked,
  onLink,
  cfg = null,
  daemonBuild,
  daemonEpoch,
  still = false,
  you = false,
}: {
  card: Card;
  now: number;
  linked: boolean;
  onLink?: ((name: string | null) => void) | undefined;
  cfg?: LiveConfig | null;
  daemonBuild?: string | undefined;
  daemonEpoch?: number | undefined;
  still?: boolean;
  /** This card is the signed-in viewer's own seat (signed-in `/live` only). */
  you?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const badge = modelBadge(card.member);
  const age = elapsed(card.since, now);
  const meta = [
    card.goal ? `for ${card.goal}` : null,
    card.areas?.length ? card.areas.join(', ') : null,
    age,
  ]
    .filter(Boolean)
    .join(' · ');
  const showLogo = badge.source !== 'human' && badge.source !== 'service';
  // Feature-skew (ADR 148): the one actionable skew, carried over from the roster row's name line.
  const m = card.member;
  const behind = isFeatureBehind(m, daemonEpoch);
  const memberBuild = m.presences?.[0]?.build;
  const skewTitle = behind
    ? `Behind on features — this seat is on epoch ${m.presences?.[0]?.epoch}, the team is on ${daemonEpoch}. ` +
      `Reload it to pick up recent capabilities.` +
      (memberBuild && daemonBuild
        ? ` (build ${memberBuild.slice(0, 7)} vs ${daemonBuild.slice(0, 7)})`
        : '')
    : undefined;
  const face = (
    <>
      <span
        className="lc-team-card__avatar"
        style={{ background: memberAvatar(card.name, card.kind, card.member.hue) }}
        aria-hidden="true"
      >
        {initial(card.name)}
      </span>
      <span className="lc-team-card__who">
        <span className="lc-team-card__name">{card.name}</span>
        {you && (
          <span className="lc-team-card__you" title="this is you">
            you
          </span>
        )}
        <span
          className={`lc-team-card__model is-${badge.source}`}
          // The readable name first, so the accessible name matches what the eye reads; the raw
          // id follows for the operator (stanley, lane-1 acceptance).
          title={badge.full ? `${badge.label} · ${badge.full}` : undefined}
          style={
            showLogo
              ? {
                  borderColor: badge.provider.border,
                  background: badge.provider.fill,
                  color: badge.provider.ink,
                }
              : undefined
          }
        >
          {showLogo && (
            <span
              className="lc-team-card__logo"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: providerIconHtml(badge.provider) }}
            />
          )}
          {badge.label}
          {(badge.source === 'declared' || badge.source === 'unverified') && (
            <span className="lc-team-card__declared"> · {badge.source}</span>
          )}
        </span>
        {behind && (
          <span className="lc-seat__behind" title={skewTitle}>
            behind
          </span>
        )}
      </span>
      <span className="lc-team-card__state">{card.stateLabel}</span>
      {card.title && (
        <span className={`lc-team-card__work${card.source === 'status' ? ' is-said' : ''}`}>
          {card.source === 'status' ? `“${card.title}”` : card.title}
          {card.moreLanes > 0 && (
            <span className="lc-team-card__more"> +{card.moreLanes} more</span>
          )}
        </span>
      )}
      {meta && <span className="lc-team-card__meta">{meta}</span>}
    </>
  );
  if (still) {
    return (
      <li
        className={`lc-team-card lc-team-card--${card.state} is-still`}
        data-member={card.name}
        style={{ ['--member' as string]: card.color }}
      >
        <div className="lc-team-card__hit">{face}</div>
      </li>
    );
  }
  return (
    <li
      className={`lc-team-card lc-team-card--${card.state}${linked ? ' is-linked' : ''}`}
      // The tour's spotlight finds the agent by this (components/tour); nothing else reads it.
      data-member={card.name}
      style={{ ['--member' as string]: card.color }}
      onMouseEnter={() => onLink?.(card.name)}
      onMouseLeave={() => onLink?.(null)}
    >
      <button
        type="button"
        className="lc-team-card__hit"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => onLink?.(card.name)}
        onBlur={() => onLink?.(null)}
      >
        {face}
      </button>
      {open && (
        <div className="lc-team-card__detail">
          <Suspense fallback={null}>
            <SeatDetail m={card.member} cfg={cfg} />
          </Suspense>
        </div>
      )}
    </li>
  );
}
