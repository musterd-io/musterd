import type { MemberSummary } from '@musterd/protocol';
import { useId } from 'react';
import { appearanceOf } from './office-scene/appearance';
import { hueOf, kindOf, memberAvatarLight, memberColor } from './format';
import { usePortrait } from './portraits';

/**
 * A member's face as the office draws them, small enough for a row (live-briefing spec, "The Now card,
 * v2"). Head and shoulders: the look comes from `appearanceOf` — stable per name, the same skin, hair
 * and hat as their body on the floor — and the shoulders wear the member's identity colour, which is
 * the colour of their top in the room. A reader who knows miley by her lilac beanie on the floor knows
 * her here too. Every hue on the Now card belongs to a person; this is where they come from.
 *
 * The scene's agent/human tell survives (ADR 079), in the figure v2 form: an agent's eyes and collar
 * light glow in its own colour (no visor, nick 2026-10-22), a human has eyes. The spots the wardrobe
 * deals (figure v2-5a) are worn here too — glasses on the eyes, headphones on the ears, a scarf at the
 * neck, in the member's accessory colour — so a face in a row matches the body on the floor. A name
 * the roster does not know gets a plain disc — never a face made up for nobody. Static SVG: no
 * canvas, no animation, nothing to pause.
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
  // A light tint of the member's own hue behind every face (nick, 2026-10-28: no dark discs).
  const ground = memberAvatarLight(name, kind, hueOf(name, roster));
  if (portrait) {
    return (
      <svg className="mface" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={name}>
        <title>{name}</title>
        <clipPath id={clip}>
          <circle cx="16" cy="16" r="15.5" />
        </clipPath>
        <g clipPath={`url(#${clip})`}>
          <rect width="32" height="32" fill={ground} />
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
        <rect width="32" height="32" fill={ground} />
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
            {/* the tell: eyes that glow in the identity colour, and a collar light at the neckline */}
            <circle cx="13.1" cy="17.4" r="1.6" fill={color} opacity="0.35" />
            <circle cx="18.9" cy="17.4" r="1.6" fill={color} opacity="0.35" />
            <circle cx="13.1" cy="17.4" r="1.05" fill={color} />
            <circle cx="18.9" cy="17.4" r="1.05" fill={color} />
            <rect x="13.4" y="24.6" width="5.2" height="1.3" rx="0.65" fill="#f6f1e8" opacity="0.9" />
          </>
        ) : (
          <>
            <circle cx="13.1" cy="17.4" r="1.1" fill="#2e2a26" />
            <circle cx="18.9" cy="17.4" r="1.1" fill="#2e2a26" />
          </>
        )}
        {look.eyes !== 'none' && (
          <g fill="none" stroke={look.accessoryColor} strokeWidth="0.9" data-spot="eyes">
            <circle cx="13" cy="17.5" r="2.4" />
            <circle cx="19" cy="17.5" r="2.4" />
            <path d="M15.4 17.3h1.2" />
          </g>
        )}
        {look.ears === 'headphones' && (
          <g fill={look.accessoryColor} data-spot="ears">
            <path d="M8.4 16.2a7.6 7.6 0 0 1 15.2 0" fill="none" stroke={look.accessoryColor} strokeWidth="1.1" />
            <rect x="6.9" y="15" width="2.6" height="4.2" rx="1.1" />
            <rect x="22.5" y="15" width="2.6" height="4.2" rx="1.1" />
          </g>
        )}
        {look.neck === 'scarf' && (
          <path d="M9.5 24.2c2 1.6 4.2 2.3 6.5 2.3s4.5-.7 6.5-2.3v2.6c-2 1.5-4.2 2.2-6.5 2.2s-4.5-.7-6.5-2.2z" fill={look.accessoryColor} data-spot="neck" />
        )}
      </g>
      <circle cx="16" cy="16" r="15.5" fill="none" stroke="var(--lc-border-2)" />
    </svg>
  );
}
