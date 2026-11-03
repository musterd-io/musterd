import { useState } from 'react';
import { DEFAULT_VIEW, type ViewSetting } from './office-scene/viewSetting';
import { nextView, readViewPref, writeViewPref } from './viewPref';

/** One glyph per view, so the button shows what is outside without a word: towers, a sail on a
 *  swell, two peaks. Strokes only, on the share button's 16px grid. */
const GLYPH: Record<ViewSetting, string> = {
  city: 'M2.5 13.5h11M3.5 13.5V7h3v6.5M6.5 13.5V3.5h3.5v10M10 13.5V8.5h2.5v5',
  coast: 'M2 12.2c1.5-1 3-1 4.5 0s3 1 4.5 0 2-.8 3 0M8.5 3v7.2M8.5 3.6l3.6 5.6H8.5M8.5 4.8 5.6 9.2h2.9',
  mountain: 'M1.8 13.2 6 6l2.4 3.6L10.6 5.4l3.6 7.8zM9.4 7.8l1.2-2.4 1.2 2.4',
};

/**
 * "Outside" (window views inc 3, lane 01M6ENHBPB): one button beside the sound toggle that cycles
 * what the office windows look out on — city → coast → mountain. The choice is this browser's
 * (`viewPref`); the office hears it through `onViewPref`, so the panes change without a reload.
 * `initial` is for tests and SSR; the page reads the stored pref.
 */
export function ViewToggle({ initial }: { initial?: ViewSetting }) {
  const [view, setView] = useState<ViewSetting>(() => initial ?? readViewPref() ?? DEFAULT_VIEW);
  const next = nextView(view);
  return (
    <button
      type="button"
      className="lc__pbtn lc__view"
      data-view={view}
      onClick={() => {
        writeViewPref(next);
        setView(next);
      }}
      aria-label={`Outside: ${view} — click for ${next}`}
      title={`Outside the windows: ${view}. Click for ${next}`}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={GLYPH[view]} />
      </svg>
    </button>
  );
}
