import type { MemberSummary } from '@musterd/protocol';
import { useId } from 'react';
import { appearanceOf } from './office-scene/appearance';
import { hueOf, kindOf, memberColor } from './format';
import { usePortrait } from './portraits';

/**
 * A member's face as the office draws them, small enough for a row (live-briefing spec, "The Now card,
 * v2"). Head and shoulders: the look comes from `appearanceOf` — stable per name, the same skin, hair
 * and hat as their body on the floor — and the shoulders wear the member's identity colour, which is
 * the colour of their top in the room. A reader who knows miley by her lilac beanie on the floor knows
 * her here too. Every hue on the Now card belongs to a person; this is where they come from.
 *
 * The scene's agent/human tell survives (ADR 079): an agent wears the dark visor with two eyes in its
 * own colour, a human has eyes. A name the roster does not know gets a plain disc — never a face made
 * up for nobody. Static SVG: no canvas, no animation, nothing to pause.
 *
 * Once the office has painted the member from their rendered figure (`portraits.ts`, lane 01M6017Z38),
 * that head and shoulders replaces the vector face in the same circle: the team panel, the Now card
 * and the rail show the person the floor shows. The vector face stays as the fallback for a /live
 * that never opened the office.
 */
export function MemberFace({
  name,
  roster,
  size = 26,
}: {
  name: string;
  roster: Map<string, MemberSummary>;
  size?: number;
}) {
  const clip = useId();
  const portrait = usePortrait(name);
  if (!roster.has(name)) {
    return (
      <svg className="mface" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="15.5" fill="var(--lc-surface-3)" />
      </svg>
    );
  }
  const kind = kindOf(name, roster);
  const color = memberColor(name, kind, hueOf(name, roster));
  if (portrait) {
    return (
      <svg className="mface" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={name}>
        <title>{name}</title>
        <clipPath id={clip}>
          <circle cx="16" cy="16" r="15.5" />
        </clipPath>
        <g clipPath={`url(#${clip})`}>
          <rect width="32" height="32" fill="var(--lc-surface-2)" />
          <image href={portrait} x="0" y="0" width="32" height="32" preserveAspectRatio="xMidYMid slice" />
        </g>
        <circle cx="16" cy="16" r="15.5" fill="none" stroke="var(--lc-border-2)" />
      </svg>
    );
  }
  const look = appearanceOf({ name, kind });
  const hair = look.hair !== 'bald';
  const long = look.hair === 'long' || look.hair === 'bob' || look.hair === 'ponytail';
  return (
    <svg
      className="mface"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label={name}
    >
      <title>{name}</title>
      <clipPath id={clip}>
        <circle cx="16" cy="16" r="15.5" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect width="32" height="32" fill="var(--lc-surface-2)" />
        <ellipse cx="16" cy="33" rx="12.5" ry="9" fill={color} />
        {long && hair && <rect x="7" y="12" width="18" height="12" rx="4" fill={look.hairColor} />}
        <circle cx="16" cy="15.5" r="8.2" fill={look.skin} />
        {look.hat !== 'none' ? (
          <>
            <path d="M7.4 14.6a8.6 8.6 0 0 1 17.2 0z" fill={look.hatColor} />
            {look.hat === 'cap' && <rect x="15" y="13.2" width="12" height="2.2" rx="1.1" fill={look.hatColor} />}
            {look.hat === 'beanie' && <rect x="7.2" y="12.8" width="17.6" height="2.4" rx="1.2" fill={look.hatColor} />}
          </>
        ) : (
          hair && (
            <path d="M7.7 15.4a8.3 8.3 0 0 1 16.6 0c-2.7-2.1-5.4-3.1-8.3-3.1s-5.6 1-8.3 3.1z" fill={look.hairColor} />
          )
        )}
        {kind === 'agent' ? (
          <>
            <rect x="9.6" y="15.6" width="12.8" height="4.4" rx="2.2" fill="#242d33" />
            <circle cx="12.9" cy="17.8" r="1.25" fill={color} />
            <circle cx="19.1" cy="17.8" r="1.25" fill={color} />
          </>
        ) : (
          <>
            <circle cx="13.1" cy="17.4" r="1.1" fill="#2e2a26" />
            <circle cx="18.9" cy="17.4" r="1.1" fill="#2e2a26" />
          </>
        )}
      </g>
      <circle cx="16" cy="16" r="15.5" fill="none" stroke="var(--lc-border-2)" />
    </svg>
  );
}
