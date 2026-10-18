/**
 * Stale-page convergence: a long-lived page reloads itself once onto the build the daemon serves.
 *
 * The /live publisher swaps the web-root atomically under a RUNNING daemon (no restart, no WS drop),
 * so an open page — the broadcast machine's Chrome above all — has no signal that its bundle is old.
 * `officeRoom` keeps /live and /broadcast agreeing *within* one build; nothing kept an open page on
 * the *current* build, and the Twitch stream faithfully broadcast a days-old office (2026-08-19).
 *
 * Mechanism (the classic version.json pattern, chosen over pushing a build id down the WS: the WS is
 * the team-data channel and never drops on an asset swap, while HTTP already serves the answer): the
 * build bakes one id into the bundle (`__WEB_BUILD__`) and writes the same id to `build.json` beside
 * `index.html`. Visible pages poll it slowly; a mismatch reloads once. After the reload the two ids
 * are equal by construction (one build produced both), and the `reloadedFor` memory makes even a
 * misbehaving host (a cache serving the old bundle against a new build.json) a no-op, never a loop.
 * Dev pages and hosts without a build.json have no id on one side or the other and stay inert.
 */

/** How often a visible page asks what build is being served. The publisher polls main every 60s, so
 * five minutes bounds convergence at ~6 minutes end-to-end while costing a ~50-byte fetch. */
const POLL_MS = 5 * 60_000;

/** The poll cadence, honoring the `?build-sync=<ms>` dev override (floored at 1s — the same
 * explicitly-present-only contract as `?light=HH`; harmless in prod). */
export function pollMs(search: string): number {
  const raw = new URLSearchParams(search).get('build-sync');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(1000, n) : POLL_MS;
}

const RELOADED_KEY = 'musterd-build-sync-reloaded-for';

/**
 * The "a build landed into THIS page load" marker — deliberately a second key, not a reading of
 * `RELOADED_KEY`.
 *
 * The two facts have opposite lifetimes and one key cannot carry both. `RELOADED_KEY` is the
 * loop guard: it must SURVIVE for the rest of the session, or a host serving a stale bundle against
 * a fresh build.json reloads forever. The beat is the opposite — it is true of exactly one
 * navigation, and any later load of the same tab (an ordinary ⌘R, a back/forward, a second
 * `/broadcast` open) is not that navigation. Testing `reloadedFor === pageBuild`, as the first cut
 * did, cannot tell them apart: after a build-sync reload the equality holds permanently, so the
 * corner claimed "just shipped — that was the blink" on every manual reload after it, with no blink
 * to point at. So the beat gets a marker that is CONSUMED on read, and the guard keeps its own.
 */
const SHIPPED_KEY = 'musterd-build-sync-shipped';

/** The one rule: reload iff both ids are known, they differ, and this served build was never tried. */
export function shouldReload(
  page: string | null,
  served: string | null,
  reloadedFor: string | null,
): boolean {
  return page !== null && served !== null && served !== page && reloadedFor !== served;
}

export interface BuildSyncDeps {
  /** The build id baked into THIS bundle, or null when there isn't one (dev, tests). */
  pageBuild: string | null;
  /** Ask the origin which build it currently serves; null for "no answer" (404, bad JSON). */
  fetchServed: () => Promise<string | null>;
  getReloadedFor: () => string | null;
  setReloadedFor: (id: string) => void;
  reload: () => void;
  /** Hidden pages skip polls entirely — idle cost is paid by every viewer, forever. */
  isVisible: () => boolean;
  /** Call back when the page comes into view; returns an unsubscribe. A tab left in the background
   * across a publish asks at once on its return, before a click can reach for a chunk that is gone,
   * rather than up to a whole interval later. */
  onVisible?: (check: () => void) => () => void;
  intervalMs?: number;
}

/** Start the convergence loop; returns a stop function. Inert (no timer at all) without a page build. */
export function startBuildSync(deps: BuildSyncDeps): () => void {
  const { pageBuild } = deps;
  if (pageBuild === null) return () => {};
  let inFlight = false;
  const tick = () => {
    if (!deps.isVisible() || inFlight) return;
    inFlight = true;
    deps
      .fetchServed()
      .then((served) => {
        if (shouldReload(pageBuild, served, deps.getReloadedFor())) {
          deps.setReloadedFor(served as string);
          deps.reload();
        }
      })
      .catch(() => {}) // an unreachable origin is the WS layer's story, not this one's
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, deps.intervalMs ?? POLL_MS);
  const unsubscribe = deps.onVisible?.(tick);
  return () => {
    clearInterval(timer);
    unsubscribe?.();
  };
}

const STALE_CHUNK_KEY = 'musterd-stale-chunk-reloaded-for';

/**
 * The last line of defence when a lazy chunk will not load (lane 01M58JC1EF). The publisher keeps a
 * retired bundle's chunks for an hour and build-sync usually moves the tab on first, so this fires
 * only when both missed: reload once, onto whatever is served now. The guard is the page's own build
 * id. A reload that lands on the SAME build (the chunk really is missing, or the network is down)
 * may not try again, so the error screen shows instead of a loop. A reload onto a new build gets
 * its own attempt later. A dev page has no build id and never reloads, so the real error shows.
 */
export function shouldReloadForStaleChunk(page: string | null, triedFor: string | null): boolean {
  return page !== null && triedFor !== page;
}


/**
 * Did THIS page load happen because a build landed? — the honest signal behind the "just shipped"
 * beat in the broadcast corner.
 *
 * The reload path stamps the served id immediately before reloading, and after that reload the
 * page's own baked id IS that served id (one build produced both — the invariant `shouldReload`
 * already rests on). So a PRESENT stamp equal to the page build means exactly one thing: the bundle
 * running right now arrived by build-sync, moments ago.
 *
 * Presence is half the fact and the half that was missing: see `SHIPPED_KEY`. Equality alone is
 * permanent after the reload; the marker's single use is what pins the claim to one navigation.
 *
 * Pure, and takes both halves, so the corner's test can state the four cases without a DOM.
 */
export function reloadedForBuild(pageBuild: string | null, shipped: string | null): boolean {
  return pageBuild !== null && shipped !== null && shipped === pageBuild;
}

/**
 * Write both markers at the one moment they are both true: this reload is about to happen, and it is
 * about to happen because `id` landed. They diverge immediately afterwards — the guard is kept for
 * the session so the reload cannot repeat, the beat is spent by the load it produces — which is why
 * the writer is worth naming: the pair must be written together or the beat has nothing to read.
 */
export function stampReload(store: Pick<Storage, 'setItem'>, id: string): void {
  store.setItem(RELOADED_KEY, id);
  store.setItem(SHIPPED_KEY, id);
}

/** Read-and-clear: the marker answers once, and the load that consumed it is the only one that can
 * claim the beat. Clearing before the comparison means even a stamp we then REJECT (an id from some
 * other build) is spent, so no stale marker can survive to mislead a later load. */
export function consumeShipped(
  pageBuild: string | null,
  marker: { read: () => string | null; clear: () => void },
): boolean {
  const stamp = marker.read();
  if (stamp === null) return false;
  marker.clear();
  return reloadedForBuild(pageBuild, stamp);
}

/**
 * `consumeShipped` against the real page, run ONCE as this module is evaluated — that is what makes
 * the answer navigation-scoped rather than call-scoped. A lazy first-call version would leave the
 * marker sitting in storage on any page that never asks (`/live` reloads too, and has no corner),
 * ready for a later `/broadcast` mount in the same tab to spend it and claim a blink that happened
 * an hour ago. Evaluating here spends it in the pageview it describes, whoever ends up asking.
 *
 * False everywhere there is no baked build id (dev, tests, prerender) — which is also where there is
 * no publisher to have shipped anything, so storage is never touched there.
 */
const SHIPPED_THIS_PAGEVIEW: boolean = (() => {
  const pageBuild = bundleBuild();
  if (pageBuild === null) return false;
  try {
    return consumeShipped(pageBuild, {
      read: () => sessionStorage.getItem(SHIPPED_KEY),
      clear: () => sessionStorage.removeItem(SHIPPED_KEY),
    });
  } catch {
    return false; // private mode / prerender: no memory, so no claim
  }
})();

/** Whether a build landed into this page load. Stable for the life of the pageview, so repeat
 * callers (a remount, StrictMode's double effect) all see the same answer. */
export function justShipped(): boolean {
  return SHIPPED_THIS_PAGEVIEW;
}

/** The id Vite baked into this bundle at build time; absent in dev and under tests. */
function bundleBuild(): string | null {
  return typeof __WEB_BUILD__ === 'string' ? __WEB_BUILD__ : null;
}

let domStarted = false;

/** Wire the loop to the real page. Idempotent — the first live surface to mount wins, and a page
 * without a baked build id (dev) never starts anything. */
export function ensureBuildSync(): void {
  if (domStarted) return;
  domStarted = true;
  startBuildSync({
    pageBuild: bundleBuild(),
    fetchServed: () =>
      fetch('/build.json', { cache: 'no-store', signal: AbortSignal.timeout(2500) })
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { build?: string } | null) => (typeof b?.build === 'string' ? b.build : null)),
    getReloadedFor: () => {
      try {
        return sessionStorage.getItem(RELOADED_KEY);
      } catch {
        return null;
      }
    },
    setReloadedFor: (id) => {
      try {
        stampReload(sessionStorage, id);
      } catch {
        /* a page that can't remember still only reloads once per served id per pageview */
      }
    },
    reload: () => window.location.reload(),
    isVisible: () => document.visibilityState === 'visible',
    onVisible: (check) => {
      const onChange = () => {
        if (document.visibilityState === 'visible') check();
      };
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
    intervalMs: pollMs(window.location.search),
  });
  // Vite dispatches this when a lazy chunk fails to load, then rethrows. The rethrow is left alone:
  // the reload is already under way, and on a guarded build the error screen is the honest answer.
  window.addEventListener('vite:preloadError', () => {
    const page = bundleBuild();
    let triedFor: string | null = null;
    try {
      triedFor = sessionStorage.getItem(STALE_CHUNK_KEY);
    } catch {
      /* no memory: the one reload still happens, and a page that cannot remember only gets it once */
    }
    if (!shouldReloadForStaleChunk(page, triedFor)) return;
    try {
      sessionStorage.setItem(STALE_CHUNK_KEY, page as string);
    } catch {
      return; // cannot record the attempt, so do not risk a loop: let the error show
    }
    window.location.reload();
  });
}
