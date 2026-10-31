import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Clock } from '../live/Clock';
import liveCss from '../live/Live.css?url';
import brandCss from '../brand/brand.css?url';
import { MusterdWord } from '../brand/MusterdWord';
import { teamContact } from '../live/teamContact';
import { AsksStrip } from '../live/AsksStrip';
import { MemberSignInFields, MemberSignInToggle, type AdvancedState } from '../live/MemberSignIn';
import { OfficeScene } from '../live/OfficeScene';
import { TeamColumn, captionColorFor } from '../live/TeamColumn';
import type { Caption } from '../live/captions';
import { applyTierClock, deriveAsks } from '../live/asks';
import { logOpenMode } from '../live/stillMode';
import { promptBarFlag, promptBarVisible } from '../live/promptGate';
import { revealWhenMounted } from '../live/reveal';
import { briefing, briefingSince } from '../live/briefing';
import { useSeatRequests } from '../live/useSeatRequests';
import { TopMeter } from '../live/TopMeter';
import type { LiveConfig } from '../live/client';
import { clearSnapshot, saveSnapshot } from '../live/liveCache';
import {
  forgetObserver,
  acquireObserver,
  acquireWatchLinkObserver,
  type WatchGrade,
  loadObserver,
  ObserverSignInRequired,
  redeemSignin,
} from '../live/client';
import {
  fetchLocalIdentities,
  forgetMemberIdentity,
  loadMemberIdentity,
  saveMemberIdentity,
} from '../live/memberIdentity';
import { firehoseSound, roomTone, setSoundInBackground, soundInBackground } from '../live/sound';
import { useLiveStream } from '../live/useLiveStream';
import { HealthBanner } from '../live/HealthBanner';
import { useTeamHolds } from '../live/useTeamHolds';
import { usePendingPairings } from '../live/usePendingPairings';
import { useServerHealth } from '../live/serverHealth';
import { officeRoom } from '../live/officeRoom';
import { useWorkingOn } from '../live/useWorkingOn';
import { useReport } from '../live/useReport';
import { roomEntries } from '../live/workingOn';

const LazySeedsTray = lazy(() =>
  import('../live/SeedsTray').then((module) => ({ default: module.SeedsTray })),
);

/**
 * The board overlay, lazy — its own header has always said it is "kept out of /live's eager graph"
 * (ADR 151), but only the heavy `Board` inside it ever was. The 219-line modal shell, and with it
 * `useBoardData`, `goalGrid` and `boardOverlayMath`, rode the entry chunk on a route that renders
 * none of it until someone reaches for the wall. Measured 2026-09-02: moving the shell out returned
 * more than #1158 borrowed, which is what paid that PR's perf debt back instead of raising the
 * ceiling to meet it.
 *
 * `preloadBoardOverlay` keeps the hover promise the old `preloadBoard` made, and now covers both
 * halves: the shell first, then the board it wraps. By the time a click lands, both are usually here.
 */
const LazyBoardOverlay = lazy(() =>
  import('../live/BoardOverlay').then((module) => ({ default: module.BoardOverlay })),
);
/** The lane picker (`/live?pick=<seat>`, lane 01M5162T6H): its own lazy chunk and stylesheet. */
const LazyPickOverlay = lazy(() =>
  import('../live/PickOverlay').then((module) => ({ default: module.PickOverlay })),
);
function preloadBoardOverlay(): void {
  void import('../live/BoardOverlay').then((module) => module.preloadBoard());
}

export const Route = createFileRoute('/live')({
  head: () => ({
    meta: [{ title: 'musterd — live comms' }],
    links: [
      { rel: 'stylesheet', href: liveCss },
      { rel: 'stylesheet', href: brandCss },
    ],
  }),
  component: LivePage,
});

const TEAM_KEY = 'musterd.live.team';
const COLLAPSE_KEY = 'musterd.live.collapsed';

/** Work lives in the team column (ADR 464) — not on plates, and no longer in the floating stack. */
const WORK_CUES: 'hybrid' | 'none' = 'none';

/** The three live panels, each independently collapsible into a slim rail. */
type PanelId = 'office' | 'team';
type Collapsed = Record<PanelId, boolean>;
const NO_COLLAPSE: Collapsed = { office: false, team: false };

/** The log drawer hosts today's `Stream` unchanged (ADR 464 lane 2) — fetched the first time it
 *  opens, never before: the stream column left /live's eager graph with the column itself. */
/** The log drawer only exists while open (L, or the log button); its chunk loads then. */
// Seats ask 1e: the "Waiting on you" list and its triage sheet — downloaded only once a question is open.
const LazyWaitingOnYou = lazy(() => import('../live/WaitingOnYou').then((m) => ({ default: m.WaitingOnYou })));
const LazyLogDrawer = lazy(() => import('../live/LogDrawer').then((m) => ({ default: m.LogDrawer })));
/** "Who is here" (ADR 692) is chrome the room does not need to paint: it follows the first roster
 *  read in its own chunk, so the faces and their cards stay off /live's eager graph. */
const LazyWhoIsHere = lazy(() => import('../live/WhoIsHere').then((m) => ({ default: m.WhoIsHere })));
/** ADR 744: the header's allowance chips load after the first roster read, as Who is here does. */
const LazyAllowanceChips = lazy(() =>
  import('../live/AllowanceChips').then((m) => ({ default: m.AllowanceChips })),
);
/** Settings (nick, 2026-10-19): opened from the working-hours calendar on the office wall, so its
 *  chunk loads on the calendar's first hover or on the click — never with the room. */
const LazySettingsOverlay = lazy(() =>
  import('../live/settings/SettingsOverlay').then((m) => ({ default: m.SettingsOverlay })),
);
function preloadSettings(): void {
  void import('../live/settings/SettingsOverlay');
}
/** The Team's wiki (ADR 747): opened from the left-wall bookshelf; its chunk (and `marked`) loads on
 *  the shelf's first hover or on the click — never with the room. */
const LazyWikiOverlay = lazy(() =>
  import('../live/wiki/WikiOverlay').then((m) => ({ default: m.WikiOverlay })),
);
function preloadWiki(): void {
  void import('../live/wiki/WikiOverlay');
}
const LazyStream = lazy(() => import('../live/Stream').then((m) => ({ default: m.Stream })));
// The Now briefing is not needed to paint the room: it comes up a beat after first paint anyway, so
// its code rides a lazy chunk and /live's eager graph (ADR 151/183) does not pay for it.
// The demo prompt bar (lane 01M4H4ARQC): a lazy chunk with its own CSS, mounted only behind its three
// gates, so the default /live pays nothing for it.
const LazyPromptBar = lazy(() =>
  import('../live/PromptBar').then((m) => ({ default: m.PromptBar })),
);
const LazyNowOverlay = lazy(() =>
  import('../live/NowOverlay').then((m) => ({ default: m.NowOverlay })),
);
/** Where the Now card's dock chip lands in the topbar (it is portalled in from the lazy chunk). */
const NOW_SLOT_ID = 'lc-now-slot';
// The first-run tour (lane 01M4M4DDYF): a lazy chunk mounted only for a viewer signed in as a human,
// its entry button portalled into the topbar slot below.
const LazyTour = lazy(() => import('../components/tour/Tour').then((m) => ({ default: m.Tour })));
const TOUR_SLOT_ID = 'lc-tour-slot';
/** How often /live re-reads the roster on its own (ADR 692: a closed tab leaves "who is here"). */
const HERE_POLL_MS = 60_000;
// ADR 516: rendered only while a hold is in force, so its formatter (in `@musterd/protocol/wire`)
// stays out of /live's eager graph on every ordinary day.
const HoldsBanner = lazy(() =>
  import('../live/HoldsBanner').then((m) => ({ default: m.HoldsBanner })),
);
/** Below this width the team column starts folded (ADR 464): the room keeps its pixels. */
const TEAM_FOLDS_BELOW = 1280;
/** Below this width there is one column (spec §2's phone layout): the office is hidden and the team
 *  column takes the whole width — never the folded rail, which left a blank page (dolly's acceptance
 *  of lane 2, 2026-09-29). */
const PHONE_QUERY = '(max-width: 880px)';
function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

/** The collapse restore must land BEFORE first paint: the canvas grid animates its columns, so a
 *  restore in a passive effect slides every panel shut in front of the viewer on every load — and
 *  the contrast sweep shot /live mid-slide on CI (2026-09-28). A layout effect is a no-op on the
 *  server, which is what the guard inside it already assumed. */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function LivePage() {
  const router = useRouter();
  const [team, setTeam] = useState('');
  const [advanced, setAdvanced] = useState({ open: false, as: '', token: '' });
  const [cfg, setCfg] = useState<LiveConfig | null>(null);
  /** True when `cfg` is a real member (ADR 222) rather than an observer or a watch-link seat — the
   *  difference between an office you can act in and one you can only read. */
  const [signedIn, setSignedIn] = useState(false);
  /** Connected via an explicit watch link — read-only by the team's choice, not by accident. */
  const [watchLink, setWatchLink] = useState(false);
  /** The grade the sharer chose for that link (ADR 616), read from `&grade=` — a label for the viewer,
   *  never an authority: the daemon decides what the seat reads. */
  const [watchGrade, setWatchGrade] = useState<WatchGrade>('public');
  const [provisioning, setProvisioning] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Collapsed>(NO_COLLAPSE);
  const [seedsOpen, setSeedsOpen] = useState(false);
  /** The log drawer (ADR 464 lane 2): every message, one keystroke away. */
  const [logOpen, setLogOpen] = useState(logOpenMode);
  const closeLog = useCallback(() => setLogOpen(false), []);
  const phone = usePhone();
  /** ADR 464: the member under the pointer — on a card or on their plate — so both wear a ring. */
  const [linked, setLinked] = useState<string | null>(null);
  /** The people on the Now goal row under the pointer — their plates ring together. */
  const [lit, setLit] = useState<readonly string[] | null>(null);
  /** The room's narration line, lifted out of the scene so the team column's header can carry it. */
  const [caption, setCaption] = useState<Caption | null>(null);

  const toggleCollapse = (id: PanelId) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* private mode — collapse state just won't persist */
      }
      return next;
    });
  };

  // A credential the daemon rejects (a wiped DB, a reaped 24h observer, ADR 064; an expired sign-in)
  // drops back to the connect form with the sign-in fields open and says why. Since ADR 580 a page
  // cannot mint a replacement observer on its own, so there is no silent re-provision to try first.
  // `recoveredToken` dedupes the HTTP-401 + WS-refused double-signal for one credential.
  const recoveredToken = useRef<string | null>(null);
  const recoverObserver = useCallback(() => {
    const team = cfg?.team;
    const staleToken = cfg?.token;
    const staleAs = cfg?.as;
    if (!team || !staleToken) return;
    if (recoveredToken.current === staleToken) return; // already handling this exact credential
    recoveredToken.current = staleToken;
    // A signed-in human is NOT silently demoted to an observer (ADR 222). Doing that would take the
    // answer buttons away again with no explanation — the exact defect this arc exists to fix — so a
    // dead member credential falls back to this browser's cached watching seat, if it has one, and
    // says why.
    if (signedIn) {
      forgetMemberIdentity(team);
      if (staleAs) clearSnapshot(team, staleAs);
      setSignedIn(false);
      setFormError('your sign-in expired — sign in again to answer asks');
      void acquireObserver(team).then(setCfg, () => {
        setAdvanced({ open: true, as: '', token: '' });
        setCfg(null);
      });
      return;
    }
    forgetObserver(team);
    setFormError("this browser's watching seat expired — sign in to watch again");
    setAdvanced({ open: true, as: '', token: '' });
    setCfg(null);
  }, [cfg?.team, cfg?.token, cfg?.as, signedIn]);

  // Cloud spec §7: a server that cannot reach its database says so on /health; show it.
  const outage = useServerHealth();
  // ADR 516: the Team's active holds, read from the same route every surface reads.
  const { holds, canSet: canSetHold, refresh: refreshHolds } = useTeamHolds(cfg);
  // ADR 692: this page's socket says it is /live, which is what the "who is here" row reads; the
  // poll takes a closed tab out of that row when its member is still online elsewhere.
  const liveCfg = useMemo(() => (cfg ? { ...cfg, page: 'live' as const } : null), [cfg]);
  const stream = useLiveStream(liveCfg, {
    onCredentialInvalid: recoverObserver,
    rosterPollMs: HERE_POLL_MS,
  });
  const {
    envelopes: streamed,
    roster,
    error,
    liveIds,
    daemonBuild,
    daemonEpoch,
    daemonInfo,
    rosterUnreadable,
    rosterStale,
    fresh,
  } = stream;
  // Settings are a signed-in human's: their own sheet for anyone, the team's for an admin. The
  // roster says which; the daemon still decides every read and write.
  const meRow = signedIn && cfg ? (roster.find((m) => m.name === cfg.as) ?? null) : null;
  const settingsHuman = meRow?.kind === 'human';
  const settingsAdmin = settingsHuman && meRow?.capabilities?.is_admin === true;
  const { pairings, refresh: refreshPairings } = usePendingPairings(cfg, settingsHuman);
  // What this browser sent through the demo prompt bar, folded in from the ack so a huddle shows on
  // the screen that opened it at once; the firehose copy that follows is deduped by id below.
  const [sent, setSent] = useState<Envelope[]>([]);
  const envelopes = useMemo(
    () =>
      sent.length === 0
        ? streamed
        : [...streamed, ...sent.filter((s) => !streamed.some((e) => e.id === s.id))],
    [streamed, sent],
  );
  const [promptbar, setPromptbar] = useState(false);
  useEffect(() => setPromptbar(promptBarFlag(window.location.search, window.location.hash)), []);

  // The office overlay's reel: everyone in the room and what they are on. Derived here (not in the
  // scene) so both routes hand the scene the same already-projected shape.
  const board = useWorkingOn(cfg, envelopes);
  const report = useReport(cfg, envelopes);
  // Nothing to show yet: a first visit before the daemon answers. Panels draw their skeletons rather
  // than "0 working" and "no open questions", which were false while it loaded (lane 01M4RNBNFM).
  const loading = !!cfg && !fresh && roster.length === 0;
  // The last snapshot is on screen and the daemon has not answered yet.
  const refreshing = !!cfg && !fresh && roster.length > 0;
  useSnapshotSaver(cfg, fresh, roster, envelopes, board);
  // The asks, derived once for the surfaces that read them beside the strip (ADR 464 §4): the team
  // column's "asking nick" and the room's ask moment. The strip keeps its own derivation because it
  // folds in the answers this browser just sent; a second copy here costs one pass over the buffer.
  const derivedAsks = useMemo(() => deriveAsks(envelopes), [envelopes]);
  const asks = useMemo(() => applyTierClock(derivedAsks, Date.now()), [derivedAsks]);
  // The briefing (live-briefing spec): the topbar's sentence and the column's Now tab read ONE
  // derivation, so a count cannot disagree with the list under it. Pending seat claims are admin-only
  // data — they are asked for only once someone is signed in, and a "no" ends the asking.
  const seatRequests = useSeatRequests(cfg, signedIn);
  // `Date.now()` is read when an input changes, not per tick: the 24 h shipped window moves by
  // minutes, not seconds.
  const brief = useMemo(
    () =>
      briefing({
        board,
        goals: report?.goals ?? [],
        asks,
        roster,
        requests: seatRequests,
        now: Date.now(),
        shippedSince: briefingSince(Date.now()),
      }),
    [board, report, asks, roster, seatRequests],
  );
  const entries = roomEntries(roster, board);

  /**
   * Does this machine hold an identity we could sign in as with one click (ADR 222)? Probed once per
   * connected team and never polled — it is a fact about this machine, not a live signal, and the
   * perf contract is unambiguous that idle cost is paid by every viewer forever. Skipped entirely
   * once signed in, because then the answer cannot change anything.
   *
   * The name goes in state (the rail renders it); the credential stays in a ref, so it never enters
   * the render path or a dependency array.
   */
  const [localIdentities, setLocalIdentities] = useState<string[]>([]);
  const localIdentity = localIdentities[0] ?? null;
  const localCreds = useRef<{ as: string; credential: string }[]>([]);
  useEffect(() => {
    const slug = cfg?.team;
    if (!slug || signedIn) return;
    let cancelled = false;
    void fetchLocalIdentities(slug).then((ids) => {
      if (cancelled) return;
      localCreds.current = ids;
      setLocalIdentities(ids.map((i) => i.as));
    });
    return () => {
      cancelled = true;
    };
  }, [cfg?.team, signedIn]);

  /**
   * Route back to the credential form (ADR 222). The sign-in fields live on the connect screen, so
   * an already-connected observer has to return to it — which is exactly the dead end the rail was
   * reporting: there was no way back at all once a seat was cached.
   */
  const promptSignIn = useCallback(() => {
    setAdvanced({ open: true, as: '', token: '' });
    setFormError(null);
    setCfg(null);
  }, []);

  /** Become yourself on this browser: remember the identity and reconnect as it (ADR 222). */
  const signIn = useCallback((slug: string, id: { as: string; token: string }) => {
    saveMemberIdentity(slug, id);
    setSignedIn(true);
    setFormError(null);
    setCfg({ team: slug, as: id.as, token: id.token });
  }, []);

  /** Hand the screen back: drop the identity and fall back to watching. The escape hatch a cached
   *  seat never had — before ADR 222 the only way out was clearing localStorage by hand. The
   *  watching seat is minted with the outgoing credential (ADR 580), so only an admin's sign-out
   *  can leave the room watching; anyone else's lands on the connect form. */
  const signOut = useCallback(() => {
    const slug = cfg?.team;
    const as = cfg?.as;
    const outgoing = cfg?.token;
    if (!slug || !as) return;
    forgetMemberIdentity(slug);
    clearSnapshot(slug, as);
    setSignedIn(false);
    void acquireObserver(slug, outgoing).then(setCfg, () => {
      setFormError(null);
      setCfg(null);
    });
  }, [cfg?.team, cfg?.as, cfg?.token]);

  /**
   * The rail's one button, both meanings (ADR 222). If this machine has an identity, becoming
   * yourself is a click and nothing else happens. If it does not — off-machine, or no CLI identity
   * here — the same button falls back to the credential form, which does work over the network.
   */
  const signInHere = useCallback((as?: string) => {
    const id = localCreds.current.find((i) => i.as === as) ?? localCreds.current[0];
    const slug = cfg?.team;
    if (id && slug) signIn(slug, { as: id.as, token: id.credential });
    else promptSignIn();
  }, [cfg?.team, signIn, promptSignIn]);

  const watch = async (explicit?: string) => {
    setFormError(null);
    const slug = (explicit ?? team).trim();
    if (!slug) return;
    setTeam(slug);
    window.localStorage.setItem(TEAM_KEY, slug);

    // Advanced: connect as a specific seat the operator supplied (a credential authenticates HTTP + WS).
    if (!explicit && advanced.open && advanced.as.trim() && advanced.token.trim()) {
      signIn(slug, { as: advanced.as.trim(), token: advanced.token.trim() });
      return;
    }

    // A remembered member identity outranks this browser's observer (ADR 222): once you have signed
    // in on this browser you are yourself, on every surface, until you say otherwise.
    const member = loadMemberIdentity(slug);
    if (member) {
      setSignedIn(true);
      setCfg({ team: slug, as: member.as, token: member.token });
      return;
    }

    // Default: this browser's cached watching seat for the team. Minting a new one takes a human
    // admin's credential (ADR 580), which a signed-out page does not have, so without one the
    // sign-in fields open and say how to get in.
    setSignedIn(false);
    try {
      setCfg(await acquireObserver(slug));
    } catch (e) {
      if (e instanceof ObserverSignInRequired) {
        setAdvanced({ open: true, as: '', token: '' });
        setFormError('This browser has no saved seat for this team — sign in to watch.');
      } else {
        setFormError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  // The wall's agile board, opened. Two ways in, and they differ only in where the panel comes
  // from: a click on the wall hands us the hotspot's rect and the panel grows out of it, while a
  // `?lane=` deep link has no object to grow from and simply arrives. Either way `boardOpen` is
  // what mounts the overlay — closed, /live pays nothing for the board at all.
  //
  // Declared above the URL hydration below because that effect opens the deep-linked board, and a
  // `const` read before its declaration is a temporal-dead-zone error, not a hoisting nicety.
  //
  // The opener is captured in `openBoard`, before the canvas goes inert (inert blurs it — an
  // activeElement read any later sees only <body>), and focus goes home after the close commits.
  const [boardOrigin, setBoardOrigin] = useState<DOMRect | null>(null);
  const [boardLane, setBoardLane] = useState<string | null>(null);
  /** `?pick=<seat>` — the lane picker for that seat (musterd pick spec §5.4). */
  const [pickSeat, setPickSeat] = useState<string | null>(null);
  const closePick = useCallback(() => {
    setPickSeat(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('pick');
    window.history.replaceState(null, '', url);
  }, []);
  // A goal the board opens drilled into (a Now goal row); null is "lanes on no goal", undefined none.
  const [boardGoal, setBoardGoal] = useState<string | null | undefined>(undefined);
  const boardOpen = boardOrigin != null || boardLane != null || boardGoal !== undefined;
  const boardOpener = useRef<HTMLElement | null>(null);
  const openBoard = useCallback((rect: DOMRect) => {
    boardOpener.current = (document.activeElement as HTMLElement | null) ?? null;
    setBoardOrigin(rect);
    // The paper lift rides the CLICK paths only (E4 spec §2) — the ?lane= deep link below arrives
    // without a hand, so it stays silent. Centre-panned: the overlay is chrome over the room.
    roomTone.moment('boardOpen', 0);
  }, []);
  const openGoal = useCallback((goalId: string | null) => {
    boardOpener.current = (document.activeElement as HTMLElement | null) ?? null;
    setBoardGoal(goalId);
    roomTone.moment('boardOpen', 0);
  }, []);
  // Settings, from the calendar under the wall clock — the board's open/close/focus pattern again.
  const [settingsOrigin, setSettingsOrigin] = useState<DOMRect | null>(null);
  const [settingsTab, setSettingsTab] = useState<'you' | 'team'>('you');
  const settingsOpener = useRef<HTMLElement | null>(null);
  const openSettings = useCallback((rect: DOMRect) => {
    settingsOpener.current = (document.activeElement as HTMLElement | null) ?? null;
    setSettingsTab('you');
    setSettingsOrigin(rect);
    roomTone.moment('boardOpen', 0);
  }, []);
  // The wiki, from the left-wall bookshelf (ADR 747) — the same open/close/focus pattern.
  const [wikiOrigin, setWikiOrigin] = useState<DOMRect | null>(null);
  const wikiOpener = useRef<HTMLElement | null>(null);
  const openWiki = useCallback((rect: DOMRect) => {
    wikiOpener.current = (document.activeElement as HTMLElement | null) ?? null;
    setWikiOrigin(rect);
    roomTone.moment('boardOpen', 0);
  }, []);
  const closeWiki = useCallback(() => {
    setWikiOrigin(null);
    roomTone.moment('boardClose', 0);
    window.setTimeout(() => wikiOpener.current?.focus?.({ preventScroll: true }), 0);
  }, []);
  // An unlinked shelf's "link the repo" goes straight to the Team sheet, from where the shelf was.
  const linkWiki = useCallback(() => {
    settingsOpener.current = wikiOpener.current;
    setSettingsTab('team');
    setSettingsOrigin(wikiOrigin);
    setWikiOrigin(null);
  }, [wikiOrigin]);
  const closeSettings = useCallback(() => {
    setSettingsOrigin(null);
    roomTone.moment('boardClose', 0);
    window.setTimeout(() => settingsOpener.current?.focus?.({ preventScroll: true }), 0);
  }, []);
  const closeBoard = useCallback(() => {
    setBoardOrigin(null);
    setBoardLane(null);
    setBoardGoal(undefined);
    roomTone.moment('boardClose', 0);
    // A macrotask, not rAF: focus must go home even in a hidden tab (rAF stalls there), and by the
    // time this runs React has committed the close and lifted `inert`.
    window.setTimeout(() => boardOpener.current?.focus?.({ preventScroll: true }), 0);
  }, []);

  // Hydrate from the URL or the last team (SSR-safe; runs once on the client). Two URL shapes:
  //   /live?team=<slug>&as=<observer>#w=<credential>  — a shared, team-controlled watch link: connect
  //     straight to that one read-only observer seat (fans out, no per-viewer seat). The credential
  //     rides the URL *fragment* so it never reaches the server or its logs.
  //   /live?team=<slug>                               — auto-provision this browser's own observer.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const urlTeam = params.get('team');
    const urlAs = params.get('as');
    // `/live?team=…&broadcast=1` is an alias for the broadcast render mode (ADR 157) — the spec URL
    // people will guess and type. Hand it straight to /broadcast, which is a different route by
    // design: it has no advanced-seat path, so streaming can't attach a phantom human presence.
    if (params.get('broadcast') === '1' && urlTeam) {
      window.location.replace(`/broadcast?team=${encodeURIComponent(urlTeam)}`);
      return;
    }
    // `?lane=<id>` — the acceptance deep link, arriving at the office instead of `/board`. The
    // room's own board opens on that lane; there is no hotspot rect to grow out of, so the overlay
    // fades in rather than zooming (see BoardOverlay's `origin`).
    const urlLane = params.get('lane');
    if (urlLane) setBoardLane(urlLane);
    const urlPick = params.get('pick');
    if (urlPick) setPickSeat(urlPick);
    // `#s=<nonce>` — `musterd live` walked us here (ADR 222). Outranks the watch link below: they
    // never appear together, and if they somehow did, your own identity is the right answer.
    const nonce = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('s');
    if (urlTeam && nonce) {
      setTeam(urlTeam);
      try {
        window.localStorage.setItem(TEAM_KEY, urlTeam);
      } catch {
        /* private mode */
      }
      // Strip through the ROUTER's history, not `window.history.replaceState`. The raw call cleans
      // the address bar but leaves the router's own location — captured at hydration, hash included
      // — stale; on the success path the post-connect render settles the router, re-syncs its
      // location and puts the spent nonce back in the bar (izzo's find, ADR 174 acceptance run).
      // Replacing via the router updates both copies. Still before the redeem is sent, per ADR 170's
      // guarantee that a slow response cannot leave a nonce on screen for a shoulder to read.
      router.history.replace(`${window.location.pathname}${window.location.search}`);
      setProvisioning(true);
      void redeemSignin(urlTeam, nonce)
        .then(({ as, credential }) => signIn(urlTeam, { as, token: credential }))
        .catch((e: unknown) => {
          // An expired or already-opened link is ordinary, not exceptional: say so in the daemon's
          // own words and fall through to watching rather than dead-ending on a blank office.
          setFormError(e instanceof Error ? e.message : String(e));
          void watch(urlTeam);
        })
        .finally(() => setProvisioning(false));
      return;
    }
    const watchTok = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('w');
    if (urlTeam && urlAs && watchTok) {
      setTeam(urlTeam);
      try {
        window.localStorage.setItem(TEAM_KEY, urlTeam);
      } catch {
        /* private mode */
      }
      setWatchLink(true);
      setWatchGrade(params.get('grade') === 'broadcast' ? 'broadcast' : 'public');
      // A watch link outranks a stored member identity (ADR 222) and is explicitly NOT you: handing
      // the office to someone else must never hand them whoever last signed in on this browser.
      setSignedIn(false);
      setCfg({ team: urlTeam, as: urlAs, token: watchTok });
    } else if (urlTeam) {
      void watch(urlTeam);
    } else {
      setTeam(window.localStorage.getItem(TEAM_KEY) ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore saved panel collapse state (SSR-safe; once on the client, before paint).
  useBeforePaint(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(COLLAPSE_KEY);
      if (raw) {
        // `roster` is the key the team column's track carried before ADR 464 — honour it so a
        // stored collapse survives the rename.
        const saved = JSON.parse(raw) as Partial<Collapsed> & { roster?: boolean };
        setCollapsed({
          office: !!saved.office,
          team: !!(saved.team ?? saved.roster),
        });
      } else {
        setCollapsed({ ...NO_COLLAPSE, team: window.innerWidth < TEAM_FOLDS_BELOW });
      }
    } catch {
      /* ignore malformed persisted state */
    }
  }, []);

  // A clicked office speech bubble opens the log on its act. The drawer mounts the stream lazily,
  // so the reveal waits for the rows to exist rather than firing into an empty listener list.
  const onActClick = useCallback((id: string) => {
    setLogOpen(true);
    revealWhenMounted(id);
  }, []);

  // `L` opens the log (spec §5). Not while typing, not with a modifier, and not under a modal —
  // the board overlay and the seeds tray own the keyboard while they are up.
  useEffect(() => {
    if (!cfg) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'l' && event.key !== 'L') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const t = event.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (boardOpen || seedsOpen) return;
      event.preventDefault();
      setLogOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cfg, boardOpen, seedsOpen]);

  // On a terminal connection error (e.g. a stale observer token after a daemon reset), drop the
  // stored observer so the next Watch re-provisions a fresh one.
  const reset = () => {
    if (cfg) forgetObserver(cfg.team);
    setCfg(null);
  };

  const connected = cfg != null;
  // The ask banner (ADR 464 §6). Inside the office on a desk; on a phone the office is hidden, so
  // the banner sits ABOVE the team list instead — spec §2's phone order, and the answer to dolly's
  // note that a phone could not see an open question at all.
  // Seats ask 1e: derives and renders inside its own lazy chunk, so the eager graph pays only the stub.
  const waitingOnYou = connected ? (
    <Suspense fallback={null}>
      <LazyWaitingOnYou roster={roster} cfg={cfg} envelopes={envelopes} board={board} />
    </Suspense>
  ) : null;
  const asksStrip = connected ? (
    <AsksStrip
      loading={loading}
      envelopes={envelopes}
      roster={roster}
      cfg={cfg}
      watchLink={watchLink}
      localIdentity={localIdentity}
      localIdentities={localIdentities}
      onSignIn={signInHere}
      onSignOut={signOut}
      board={board}
      onOpenLane={setBoardLane}
      liveIds={liveIds}
      onReveal={onActClick}
    />
  ) : null;

  return (
    <main className="lc">
      <HealthBanner reason={outage} />
      {/* ADR 516: the banner is a hold IN FORCE, so it mounts only then — an admin used to get an
          empty amber bar on every visit just so "pause…" had somewhere to live (nick, 2026-10-12);
          that control now sits in the topbar. */}
      {holds.length > 0 && (
        <Suspense fallback={null}>
          <HoldsBanner holds={holds} cfg={cfg} canSet={canSetHold} onChanged={refreshHolds} />
        </Suspense>
      )}
      <header className="lc__topbar">
        {/* Operator chrome only. The team name and the connection/present signal moved into the
            office overlay, which carries them over the scene on both /live and /broadcast — repeating
            them a few inches above was the duplication nick asked us to drop (2026-07-24). */}
        <MusterdWord />
        {connected && (
          <TopMeter
            teamName={team}
            envelopes={envelopes}
            roster={roster}
            loading={loading}
            refreshing={refreshing}
          />
        )}
        {connected && watchLink && (
          <span className="lc-watchgrade">
            {watchGrade === 'broadcast' ? 'demo view · agent DMs shown' : 'watching · team-wide only'}
          </span>
        )}
        {connected && <span id={NOW_SLOT_ID} className="lc__nowslot" />}
        {/* ADR 744: each human's allowance sits here; the tour's entry button left this bar for
            it (LazyTour still mounts, and finds no slot, so it offers no button on /live). */}
        {connected && (
          <Suspense fallback={null}>
            <LazyAllowanceChips roster={roster} you={signedIn ? (cfg?.as ?? null) : null} />
          </Suspense>
        )}
        <span className="lc__spacer" />
        {/* One group, so a narrow topbar wraps the controls to a row of their own instead of
            pushing them off-screen (Live.css `.lc__tools`). */}
        <span className="lc__tools">
          {connected && (
            <Suspense fallback={null}>
              <LazyWhoIsHere roster={roster} you={signedIn ? (cfg?.as ?? null) : null} />
            </Suspense>
          )}
          {/* An admin's "pause…" moved into settings' Team sheet (nick, 2026-10-19); the banner
              still appears above the room while a hold is in force. */}
          {/* The Seeds button left the bar (nick, 2026-10-28: "hide the seeds button for now, maybe
              put that on the workboard instead"). The tray and its state stay for the day it does. */}
          {connected && (
            <button
              type="button"
              className={`lc__pbtn${logOpen ? ' lc__pbtn--on' : ''}`}
              onClick={() => setLogOpen(true)}
              aria-pressed={logOpen}
              aria-label="Open the team log"
              title="Every message — the team log (L)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 4h10M3 8h10M3 12h6" />
              </svg>
            </button>
          )}
          {/* Signed in only: minting a link takes a human admin's credential (ADR 580), which a
              watching page does not hold, so offering it there would only ever fail. */}
          {connected && signedIn && <WatchLinkButton cfg={cfg!} />}
          {connected && <SoundToggle />}
          <Clock />
        </span>
      </header>

      {!connected ? (
        <ConnectForm
          team={team}
          onTeam={setTeam}
          advanced={advanced}
          onAdvanced={setAdvanced}
          onWatch={() => void watch()}
          provisioning={provisioning}
          error={formError}
        />
      ) : (
        <>
          {error && (
            <div className="lc__error">
              {error} <button onClick={reset}>reset &amp; reconnect</button>
            </div>
          )}
          {phone && (
            <div className="lc__phone-asks">
              {waitingOnYou}
              {asksStrip}
            </div>
          )}
          {/* On a phone the room is inert (below), so its wall board and bookshelf are not doors any
              more. These two are: the same overlays, opened from the button instead of the
              furniture (lane 01M61QMGJC). */}
          {phone && (
            <nav className="lc__phone-doors" aria-label="Board and wiki">
              <button
                type="button"
                className="lc__phone-door"
                onPointerDown={preloadBoardOverlay}
                onClick={(e) => openBoard(e.currentTarget.getBoundingClientRect())}
              >
                <span className="lc__phone-door-mark lc__phone-door-mark--board" aria-hidden />
                Work board
              </button>
              {cfg && (
                <button
                  type="button"
                  className="lc__phone-door"
                  onPointerDown={preloadWiki}
                  onClick={(e) => openWiki(e.currentTarget.getBoundingClientRect())}
                >
                  <span className="lc__phone-door-mark lc__phone-door-mark--wiki" aria-hidden />
                  Wiki
                </button>
              )}
            </nav>
          )}
          <div
            className={
              `lc__canvas${collapsed.office ? ' is-office-collapsed' : ''}` +
              `${collapsed.team ? ' is-team-collapsed' : ''}`
            }
            // A modal means it: while the board overlay is up, the room behind it takes no focus and
            // no clicks (the AsksStrip inert precedent, promoted to page scope).
            inert={
              boardOpen ||
              seedsOpen ||
              logOpen ||
              pickSeat !== null ||
              settingsOrigin !== null ||
              wikiOrigin !== null
            }
          >
            {/* On a phone the room is a window to watch, not a panel to work (goal live-delight):
                inert, so its plates — a few px apart at that scale — are not tap targets anyone
                could hit on purpose. `display: contents` keeps it a grid child of the canvas. */}
            <div className="lc__office-wrap" inert={phone}>
              <OfficeScene
                markContact={teamContact(team)}
                {...officeRoom(team, stream, { entries, board, asks, goals: report?.goals })}
                fit="furnished"
                collapsed={collapsed.office}
                onCollapse={() => toggleCollapse('office')}
                onActClick={onActClick}
                onLaneClick={setBoardLane}
                onBoardOpen={openBoard}
                onBoardHover={preloadBoardOverlay}
                onSettingsOpen={openSettings}
                onSettingsHover={preloadSettings}
                onWikiOpen={openWiki}
                onWikiHover={preloadWiki}
                // ADR 618 §7: a staged pairing used to be a full-width panel above the room; now it
                // is a dot on the calendar, and the You sheet holds the confirmation.
                settingsSpot={{ enabled: settingsHuman, flagged: pairings.length > 0 }}
                // The asks & approvals rail (ADR 149) rides the top of the room itself — the office
                // frames its own asks (nick, 2026-07-28). Still renders nothing until an ask exists.
                topSlot={
                  phone ? null : (
                    <>
                      {waitingOnYou}
                      {asksStrip}
                    </>
                  )
                }
                workCues={WORK_CUES}
                onCaption={setCaption}
                linked={lit ?? linked}
                onPlateHover={setLinked}
                you={signedIn ? (cfg?.as ?? null) : null}
              />
            </div>
            <TeamColumn
              loading={loading}
              teamName={team}
              daemonInfo={daemonInfo}
              roster={roster}
              board={board}
              goals={report?.goals ?? []}
              collapsed={collapsed.team && !phone}
              onCollapse={phone ? undefined : () => toggleCollapse('team')}
              linked={linked}
              onLink={setLinked}
              caption={caption}
              captionColor={captionColorFor(roster, caption)}
              cfg={cfg}
              daemonBuild={daemonBuild}
              daemonEpoch={daemonEpoch}
              unreadable={rosterUnreadable}
              stale={rosterStale}
              asks={asks}
              you={signedIn ? (cfg?.as ?? null) : null}
            />
            <Suspense fallback={null}>
              <LazyNowOverlay
                brief={brief}
                roster={roster}
                since={briefingSince(Date.now())}
                viewer={signedIn ? (cfg?.as ?? null) : null}
                onOpenLane={setBoardLane}
                onOpenAsk={onActClick}
                onOpenGoal={openGoal}
                onLight={setLit}
                slotId={NOW_SLOT_ID}
              />
            </Suspense>
          </div>
          {/* The headline ticker (ADR 464 §5) that sat under the room is gone: nick never looked at
              it (2026-10-12), and the team column beside the room already carries each member's
              latest moment. */}
          {signedIn && cfg && roster.find((m) => m.name === cfg.as)?.kind === 'human' && (
            <Suspense fallback={null}>
              <LazyTour
                cfg={cfg}
                viewer={cfg.as}
                roster={roster}
                envelopes={envelopes}
                lanes={board?.lanes ?? null}
                slotId={TOUR_SLOT_ID}
              />
            </Suspense>
          )}
          {/* Gates: ?promptbar=1, a signed-in member (not the read-only observer), and an admin. */}
          {promptBarVisible({ flag: promptbar, signedIn, admin: canSetHold }) && cfg && (
            <Suspense fallback={null}>
              <LazyPromptBar
                cfg={cfg}
                roster={roster}
                viewer={cfg.as}
                envelopes={envelopes}
                asks={asks}
                onSent={(ack) => setSent((prev) => [...prev, ack])}
              />
            </Suspense>
          )}
          {logOpen && (
            <Suspense fallback={null}>
              <LazyLogDrawer open onClose={closeLog} title={`Team log — ${team}`}>
                <Suspense fallback={<p className="lc-drawer__loading">Opening the log…</p>}>
                  <LazyStream
                    envelopes={envelopes}
                    roster={roster}
                    liveIds={liveIds}
                    cfg={cfg ?? undefined}
                    board={board}
                  />
                </Suspense>
              </LazyLogDrawer>
            </Suspense>
          )}
          {pickSeat !== null && (
            <Suspense fallback={null}>
              <LazyPickOverlay
                cfg={cfg}
                seat={pickSeat}
                signedIn={signedIn}
                roster={roster}
                onSignIn={() => signInHere()}
                onClose={closePick}
              />
            </Suspense>
          )}
          {boardOpen && (
            <Suspense fallback={null}>
              <LazyBoardOverlay
                cfg={cfg}
                roster={roster}
                base={board}
                goals={report?.goals ?? []}
                origin={boardOrigin}
                focusLane={boardLane}
                focusGoal={boardGoal}
                onClose={closeBoard}
              />
            </Suspense>
          )}
          {settingsOrigin !== null && cfg && settingsHuman && (
            <Suspense fallback={null}>
              <LazySettingsOverlay
                cfg={cfg}
                me={meRow}
                isAdmin={settingsAdmin}
                teamHours={stream.teamWorkingHours}
                pairings={pairings}
                seats={roster.filter((m) => m.kind === 'agent').map((m) => m.name)}
                origin={settingsOrigin}
                initialTab={settingsAdmin ? settingsTab : 'you'}
                onPairingsChanged={refreshPairings}
                onHoldsChanged={refreshHolds}
                onClose={closeSettings}
              />
            </Suspense>
          )}
          {wikiOrigin !== null && cfg && (
            <Suspense fallback={null}>
              <LazyWikiOverlay
                cfg={cfg}
                origin={wikiOrigin}
                isAdmin={settingsAdmin}
                onOpenSettings={linkWiki}
                onClose={closeWiki}
              />
            </Suspense>
          )}
          {seedsOpen && (
            <Suspense fallback={null}>
              <LazySeedsTray
                cfg={cfg!}
                activityKey={envelopes[envelopes.length - 1]?.id}
                onClose={() => setSeedsOpen(false)}
              />
            </Suspense>
          )}
        </>
      )}
    </main>
  );
}

/** What each watch-link grade shows, in the words the share control uses (ADR 616). */
const WATCH_GRADES: { grade: WatchGrade; label: string; says: string }[] = [
  { grade: 'public', label: 'public link', says: 'Team-wide messages only. No DMs, no account.' },
  {
    grade: 'broadcast',
    label: 'demo link',
    says: 'Agent DMs and asks too. Never a DM between two humans; keys masked.',
  },
];

/**
 * Copy a shareable, read-only **watch link** — an observer credential in the URL fragment (`#w=…`, so
 * it never hits the server). Anyone the team hands it to opens the office as that observer: read-only
 * by construction (ADR 063), fans out to any number of viewers, no account and no per-viewer seat.
 *
 * The link carries a seat of its own, minted on first share at the grade chosen here (ADR 136, ADR
 * 616): **public** by default, or **broadcast** for a demo room. Never `full` and never this
 * dashboard's credential — that used to be `cfg.token`, the operator's own full-grade seat, so sharing
 * a link shared every DM on the team. The link names its grade (`&grade=broadcast`) so the viewer's
 * page can say what it shows; the daemon, not the label, decides what the seat reads.
 *
 * Minting it takes a human admin's credential (ADR 580), so the button is only offered signed in, and
 * `cfg.token` is the member's own — used to mint, never put in the link.
 */
/** The share failure in words a person acts on; the daemon's codes are for the audit (lane 01M5QE7HXP). */
function watchLinkFailure(e: unknown): string {
  const msg = e instanceof Error ? e.message : '';
  if (/no_signature/.test(msg)) return 'No link made: this needs your passkey. Try again.';
  if (/passkey|localhost URL/i.test(msg)) return `No link made: ${msg.replace(/; nothing was sent$/, '')}.`;
  if (/admin|unauthorized|forbidden/i.test(msg)) return 'Only a team admin can share a watch link.';
  return 'Could not make a watch link. Try again.';
}

function WatchLinkButton({ cfg }: { cfg: LiveConfig }) {
  const [choosing, setChoosing] = useState(false);
  const [copied, setCopied] = useState<WatchGrade | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  // Opening the choice moves focus to it, so a keyboard user lands on the options they just asked for.
  useEffect(() => {
    if (choosing) firstChoice.current?.focus();
  }, [choosing]);
  // A failure stays up long enough to read, and goes on the next press anywhere.
  useEffect(() => {
    if (!failed) return;
    const t = window.setTimeout(() => setFailed(null), 8000);
    const away = () => setFailed(null);
    document.addEventListener('pointerdown', away);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('pointerdown', away);
    };
  }, [failed]);
  // A press anywhere else puts the card away, as any dropdown does.
  useEffect(() => {
    if (!choosing) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setChoosing(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [choosing]);
  const copy = async (grade: WatchGrade) => {
    setChoosing(false);
    const { origin } = window.location;
    let creds;
    try {
      // Minting a seat is `admin.roster` (ADR 662): an enrolled human's passkey signs it, or the
      // daemon refuses it no_signature. Lazily loaded, like the verdict rail's ceremony.
      creds = await acquireWatchLinkObserver(cfg.team, cfg.token, grade, async (name) => {
        const { authorityProofForObserver } = await import('../live/authorityProof');
        return authorityProofForObserver(cfg, name);
      });
    } catch (e) {
      // Minting failed — do NOT fall back to cfg.token. That fallback is the whole bug: it would
      // silently hand out a full-visibility credential at the exact moment we meant to withhold one.
      setFailed(watchLinkFailure(e));
      return;
    }
    const url =
      `${origin}/live?team=${encodeURIComponent(cfg.team)}&as=${encodeURIComponent(creds.name)}` +
      (grade === 'public' ? '' : `&grade=${grade}`) +
      `#w=${encodeURIComponent(creds.token)}`;
    const label = WATCH_GRADES.find((g) => g.grade === grade)!.label;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt(`Copy this read-only ${label}:`, url);
    }
    setCopied(grade);
    window.setTimeout(() => setCopied(null), 1600);
  };
  // The outcome is a checkmark or a changed tooltip, neither of which a screen reader speaks. The
  // status sits beside the button, not in it, so the button's name stays the same while it speaks;
  // it is always mounted because a live region that appears with its text is often not announced.
  return (
    <span className="lc-share-wrap" ref={wrap}>
      <span className="lc-sr" role="status">
        {failed ?? (copied ? `${WATCH_GRADES.find((g) => g.grade === copied)!.label} copied` : '')}
      </span>
      {/* The failure, where the eye already is: it used to land only in the status region above,
          so a sighted reader saw nothing happen (lane 01M5QE7HXP). Hidden from assistive tech,
          which hears the same words from that region. */}
      {failed && !choosing && (
        <span className="lc-share lc-share--failed" aria-hidden="true">
          {failed}
        </span>
      )}
      {/* The two grades drop down under the button as a small card, each saying what it shows —
          not two more pills spilled into the topbar. */}
      {choosing && (
        <span className="lc-share" role="group" aria-label="Share a read-only watch link">
          {WATCH_GRADES.map(({ grade, label, says }, i) => (
            <button
              key={grade}
              ref={i === 0 ? firstChoice : undefined}
              type="button"
              className="lc-share__btn"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setChoosing(false);
              }}
              onClick={() => void copy(grade)}
            >
              <span className="lc-share__label">Copy the {label}</span>
              <span className="lc-share__says">{says}</span>
            </button>
          ))}
        </span>
      )}
      <button
        type="button"
        className={`lc__pbtn${copied || choosing ? ' lc__pbtn--on' : ''}`}
        onClick={() => {
          setFailed(null);
          setChoosing((c) => !c);
        }}
        aria-expanded={choosing}
        aria-label="Share a read-only watch link"
        title={failed ?? 'Share a read-only watch link'}
      >
        {copied ? (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5 6.5 11.5 12.5 5" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.5 9.5 9.5 6.5M7 4.5 8.4 3a2.6 2.6 0 0 1 3.7 3.7L10.6 8.2M9 11.5 7.6 13a2.6 2.6 0 0 1-3.7-3.7L5.4 7.8" />
          </svg>
        )}
      </button>
    </span>
  );
}

/** The sound button's three states, in click order. */
type SoundMode = 'off' | 'front' | 'always';
const NEXT_SOUND: Record<SoundMode, SoundMode> = { off: 'front', front: 'always', always: 'off' };
const SOUND_LABEL: Record<SoundMode, string> = {
  off: 'Sound off',
  front: 'Sound on while this tab is in front',
  always: 'Sound on, even in a background tab',
};

/**
 * Sound, one button (nick, 2026-10-28: "get rid of the 2 separate audio buttons"), three states
 * (nick, 2026-10-30): off → on while the tab is in front → on in a background tab too → off. The
 * act cues and the room tone come on and go off together. Each engine still keeps its own stored
 * preference, so a viewer who had one of them on before keeps that; the button reads "on" when
 * either is. Default OFF: the click is the user gesture that lets the AudioContext start (browser
 * autoplay policy), and the room's own sounds confirm it is live.
 */
function SoundToggle() {
  const [mode, setMode] = useState<SoundMode>(() =>
    firehoseSound.enabled || roomTone.enabled ? (soundInBackground() ? 'always' : 'front') : 'off',
  );
  const on = mode !== 'off';
  // A stored `on` from a previous visit needs a gesture before it can make a sound. Any click
  // anywhere on the page is gesture enough, and one is cheaper to catch than to ask for.
  useEffect(() => {
    if (!roomTone.enabled) return;
    const wake = () => roomTone.resumeIfEnabled();
    window.addEventListener('pointerdown', wake, { once: true });
    return () => window.removeEventListener('pointerdown', wake);
  }, []);
  const toggle = () => {
    const next = NEXT_SOUND[mode];
    setSoundInBackground(next === 'always');
    firehoseSound.setEnabled(next !== 'off');
    roomTone.setEnabled(next !== 'off');
    setMode(next);
  };
  return (
    <button
      type="button"
      className={`lc__sound${on ? ' lc__sound--on' : ''}`}
      onClick={toggle}
      aria-label={`${SOUND_LABEL[mode]} — click for: ${SOUND_LABEL[NEXT_SOUND[mode]].toLowerCase()}`}
      title={`${SOUND_LABEL[mode]}. Click: ${SOUND_LABEL[NEXT_SOUND[mode]].toLowerCase()}`}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 6.2h2.2L8.3 3.6v8.8L5.2 9.8H3z" />
        {mode === 'off' && <path d="m10.8 6 3.4 4M14.2 6l-3.4 4" />}
        {mode === 'front' && <path d="M10.4 5.6a3.2 3.2 0 0 1 0 4.8" />}
        {mode === 'always' && <path d="M10.4 5.6a3.2 3.2 0 0 1 0 4.8M12.2 4a5.6 5.6 0 0 1 0 8" />}
      </svg>
      {mode === 'always' && <span className="lc__sound-bg" aria-hidden="true" />}
    </button>
  );
}

function ConnectForm({
  team,
  onTeam,
  advanced,
  onAdvanced,
  onWatch,
  provisioning,
  error,
}: {
  team: string;
  onTeam: (v: string) => void;
  advanced: AdvancedState;
  onAdvanced: (a: AdvancedState) => void;
  onWatch: () => void;
  provisioning: boolean;
  error: string | null;
}) {
  return (
    <div className="lc-form">
      <div className="lc-form__card">
        <h1 className="lc-form__title">Watch the team, live</h1>
        <p className="lc-form__sub">
          Run <code>musterd live</code> in your team folder and this page opens signed in. A browser
          that has watched this team before keeps its hidden read-only seat — watching never shows
          you on the roster.
        </p>
        <label className="lc-form__field">
          <span>Team</span>
          {/* No autoFocus. This form is the FIRST thing on the page, and focusing it on load drops a
              screen-reader user straight into a text field — past the heading and past the sentence
              above explaining that watching uses a hidden observer seat and never puts them on
              the roster. That is a privacy fact they are entitled to hear before they start typing.
              The page is a single form, so a keyboard user is one Tab away regardless. */}
          <input
            type="text"
            value={team}
            placeholder="alpha"
            onChange={(e) => onTeam(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onWatch()}
          />
        </label>

        <MemberSignInFields advanced={advanced} onAdvanced={onAdvanced} seatLabel="Sign in as (seat)" />

        {error && <p className="lc-form__error">{error}</p>}

        <button
          className="lc-form__connect"
          disabled={!team.trim() || provisioning}
          onClick={onWatch}
        >
          {provisioning && <span className="lc-spinner" aria-hidden="true" />}
          {provisioning ? 'Signing in…' : advanced.open ? 'Sign in' : 'Watch live'}
        </button>

        <MemberSignInToggle
          advanced={advanced}
          onAdvanced={onAdvanced}
          openLabel="Sign in as yourself"
          closeLabel="Just watch instead"
          canWatch={loadObserver(team.trim()) != null}
        />
      </div>
    </div>
  );
}

/**
 * Keep this browser's snapshot of /live current (liveCache): every 15 s while the page shows fresh
 * data, and once more as it is hidden or closed, so the next visit paints at once. Refs, not deps, so
 * a busy firehose never re-arms the timer.
 */
function useSnapshotSaver(
  cfg: LiveConfig | null,
  fresh: boolean,
  roster: MemberSummary[],
  envelopes: Envelope[],
  board: LaneBoard | null,
) {
  const latest = useRef({ roster, envelopes, board });
  useEffect(() => {
    latest.current = { roster, envelopes, board };
  });
  useEffect(() => {
    if (!cfg || !fresh) return;
    const save = () => saveSnapshot(cfg.team, cfg.as, latest.current);
    save();
    const timer = window.setInterval(save, 15_000);
    const onHide = () => document.visibilityState === 'hidden' && save();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', save);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', save);
    };
  }, [cfg, fresh]);
}
