import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Envelope, MemberSummary } from '@musterd/protocol';
import { askBanner } from './askPhrase';
import { BellIcon } from './AsksStrip';
import { applyTierClock, askIsLoud, clockFraction, deriveAsks, type AudienceContext } from './asks';
import { hueOf, initial, kindOf, memberAvatar, memberColor } from './format';

/**
 * The ask banner as stream chrome (ADR 464 follow-up): `/live`'s banner, same words and same
 * `lc-asks` markup, with every part that takes input taken out. It replaced `AsksReel`, which
 * rotated its own card through the asks; a stream viewer now reads the sentence a room reads.
 *
 * `AsksStrip` stays the answerable one: sending acts, signing in, the sheet, the tab title. What the
 * two share is the view-model, `askBanner()`, so they cannot say different things. A stream has no
 * sheet to open, so the count of the rest is plain text here rather than a button.
 */
export function StreamAskBanner({
  envelopes,
  roster,
}: {
  envelopes: Envelope[];
  roster: MemberSummary[];
}) {
  const [now, setNow] = useState(() => Date.now());
  const derived = useMemo(() => deriveAsks(envelopes), [envelopes]);
  const asks = useMemo(() => applyTierClock(derived, now), [derived, now]);
  // Nobody is signed in on a stream: "you" is no one, so the lead is a human's question first.
  const ctx: AudienceContext = useMemo(
    () => ({
      you: null,
      humans: new Set(roster.filter((m) => m.kind === 'human').map((m) => m.name)),
    }),
    [roster],
  );
  const banner = askBanner(asks, ctx, now);
  const lead = banner.mode === 'idle' ? null : banner.lead;

  // A 1s clock while an ask is open (the countdown) or settled (so it can shrink back to the idle
  // pill on time). Stops when there is nothing to count.
  const ticking = banner.mode !== 'idle';
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const idx = new Map(roster.map((m) => [m.name, m]));
  const frac = lead ? clockFraction(lead, now) : null;
  const style = lead
    ? ({
        '--lc-asks-hue': memberColor(lead.env.from, kindOf(lead.env.from, idx), hueOf(lead.env.from, idx)),
      } as CSSProperties)
    : undefined;

  return (
    <section
      className={`lc-asks lc-asks--${banner.mode} is-still${lead && askIsLoud(lead.state) ? ' lc-asks--loud' : ''}${lead ? ' has-lead' : ''}`}
      style={style}
      aria-label="asks and approvals"
    >
      <div className="lc-asks__rail">
        {banner.mode === 'open' ? (
          <span className="lc-asks__hand" aria-hidden="true">
            ✋
          </span>
        ) : (
          <BellIcon />
        )}
        {banner.mode === 'idle' ? (
          <span className="lc-asks__lead lc-asks__lead--quiet">
            <span className="lc-asks__verb">no open questions</span>
          </span>
        ) : (
          <>
            <span
              className={`lc-chip__avatar lc-asks__who${frac === null ? '' : frac > 0 ? ' is-timed' : ' is-over'}`}
              style={
                {
                  background: memberAvatar(banner.lead.env.from, kindOf(banner.lead.env.from, idx), hueOf(banner.lead.env.from, idx)),
                  '--lc-ask-frac': frac ?? 0,
                } as CSSProperties
              }
              aria-hidden="true"
            >
              {initial(banner.lead.env.from)}
            </span>
            <span className="lc-asks__lead">
              <b>{banner.who}</b>
              {banner.mode === 'open' && banner.reviewTitle ? (
                <>
                  <span className="lc-asks__verb">
                    asked <b>{banner.to ?? 'the team'}</b> to accept
                  </span>
                  <span className="lc-asks__q">{banner.reviewTitle}</span>
                </>
              ) : banner.mode === 'open' ? (
                <>
                  <span className="lc-asks__verb">
                    is asking <b>{banner.to ?? 'the team'}</b>
                    {banner.question ? ':' : ''}
                  </span>
                  {banner.question && <span className="lc-asks__q">{banner.question}</span>}
                </>
              ) : (
                <>
                  <span className="lc-asks__verb">asked {banner.to ?? 'the team'} ·</span>
                  <span className="lc-asks__outcome">{banner.outcome}</span>
                </>
              )}
            </span>
            {banner.mode === 'open' && (
              <>
                <span className={`lc-asks__hold lc-ask__hold lc-ask__hold--${banner.lead.tier}`}>
                  {banner.hold}
                </span>
                <span
                  className={`lc-ask__clock lc-asks__clock${
                    banner.lead.state === 'held' || frac === 0 ? ' lc-ask__clock--over' : ''
                  }`}
                >
                  {banner.clock}
                </span>
              </>
            )}
          </>
        )}
        <span className="lc-asks__spacer" />
        {banner.more > 0 && <span className="lc-asks__more-text">+{banner.more} more waiting</span>}
      </div>
    </section>
  );
}
