// What is outside the office windows on /live (window views inc 3, lane 01M6ENHBPB): the viewer's
// choice of panorama, kept in this browser. /broadcast never reads it — a stream shows the city.
//
// Deliberately tiny and free of the scene: the header button renders from it on first paint, and the
// office (a lazy chunk) hears changes through `onViewPref` from its React host, so neither side
// imports the other. Precedence where the scene decides: `?view=` > this pref > city.

import { VIEW_SETTINGS, type ViewSetting } from './office-scene/viewSetting';

const KEY = 'musterd.live.view';
const listeners = new Set<(v: ViewSetting) => void>();

/** The stored view, or null when there is none, it is junk, or storage throws (private mode). */
export function readViewPref(): ViewSetting | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(KEY);
    return v && (VIEW_SETTINGS as readonly string[]).includes(v) ? (v as ViewSetting) : null;
  } catch {
    return null;
  }
}

/** Store the view and tell every listener. A storage that throws only loses the persistence. */
export function writeViewPref(v: ViewSetting): void {
  try {
    window.localStorage.setItem(KEY, v);
  } catch {
    /* private mode / disabled storage — the room still changes, it just won't be remembered */
  }
  for (const l of listeners) l(v);
}

/** Hear the view change; returns the unsubscribe. */
export function onViewPref(l: (v: ViewSetting) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The button's click order: city → coast → mountain → city. */
export function nextView(v: ViewSetting): ViewSetting {
  return VIEW_SETTINGS[(VIEW_SETTINGS.indexOf(v) + 1) % VIEW_SETTINGS.length]!;
}
