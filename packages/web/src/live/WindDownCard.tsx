import type { CSSProperties } from 'react';
import type { LiveConfig } from './client';
import { useWindDown } from './useWindDown';
import { windDownView } from './windDown';
import './WindDownCard.css';

/**
 * The stream's end-of-day card (lane 01M5GDACC0): from the moment `musterd stream stop` queues a
 * stop, a paper card tells viewers the team is wrapping up, and a small sun sinks to the horizon
 * as the deadline nears. Gone the moment the stop is cancelled. Display only — it never speaks.
 */
export function WindDownCard({ cfg }: { cfg: LiveConfig | null }) {
  const [stopAt, now] = useWindDown(cfg);
  const view = cfg ? windDownView(cfg.team, stopAt, now) : null;
  if (!view) return null;
  return (
    <aside
      className="bc-wind"
      style={{ '--bc-wind-day': view.daylight } as CSSProperties}
      aria-live="polite"
    >
      <span className="bc-wind__sky" aria-hidden="true">
        <span className="bc-wind__sun" />
        <span className="bc-wind__horizon" />
      </span>
      <span className="bc-wind__text">{view.text}</span>
    </aside>
  );
}
