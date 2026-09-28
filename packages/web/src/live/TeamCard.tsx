import { useState } from 'react';
import type { LiveConfig } from './client';
import { initial, memberAvatar } from './format';
import { modelBadge } from './modelBadge';
import { providerIconHtml } from './modelProviderIcon';
import { SeatDetail } from './RosterPanel';
import { elapsed, type TeamCard as Card } from './teamCards';

/**
 * One member, read by a room (ADR 464, spec §4): avatar, name, the model badge (provider logo +
 * readable name, or "human"), a plain-language state, and what they are on in big type. Hover or
 * focus links the card to the member's character on the floor; click expands to the operator
 * detail the roster row used to carry.
 */
export function TeamCard({
  card,
  now,
  linked,
  onLink,
  cfg = null,
}: {
  card: Card;
  now: number;
  linked: boolean;
  onLink?: ((name: string | null) => void) | undefined;
  cfg?: LiveConfig | null;
}) {
  const [open, setOpen] = useState(false);
  const badge = modelBadge(card.member);
  const age = elapsed(card.since, now);
  const meta = [card.goal ? `for ${card.goal}` : null, age].filter(Boolean).join(' · ');
  const showLogo = badge.source !== 'human' && badge.source !== 'service';
  return (
    <li
      className={`lc-team-card lc-team-card--${card.state}${linked ? ' is-linked' : ''}`}
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
        <span
          className="lc-team-card__avatar"
          style={{ background: memberAvatar(card.name, card.kind, card.member.hue) }}
          aria-hidden="true"
        >
          {initial(card.name)}
        </span>
        <span className="lc-team-card__who">
          <span className="lc-team-card__name">{card.name}</span>
          <span
            className={`lc-team-card__model is-${badge.source}`}
            title={badge.full ?? undefined}
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
            {badge.source === 'declared' && (
              <span className="lc-team-card__declared"> · declared</span>
            )}
          </span>
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
      </button>
      {open && (
        <div className="lc-team-card__detail">
          <SeatDetail m={card.member} cfg={cfg} />
        </div>
      )}
    </li>
  );
}
