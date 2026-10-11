import type { Envelope } from '@musterd/protocol';
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
import { AsksStrip } from '../live/AsksStrip';
import { MemberSignInFields, MemberSignInToggle, type AdvancedState } from '../live/MemberSignIn';
import { OfficeScene } from '../live/OfficeScene';
import { TeamColumn, captionColorFor } from '../live/TeamColumn';
import type { Caption } from '../live/captions';
import { applyTierClock, askIsLoud, deriveAsks } from '../live/asks';
import { logOpenMode } from '../live/stillMode';
import { promptBarFlag, promptBarVisible } from '../live/promptGate';
import { revealWhenMounted } from '../live/reveal';
import { LogDrawer } from '../live/LogDrawer';
import { Ticker } from '../live/Ticker';
import { briefing, briefingSince } from '../live/briefing';
import { useSeatRequests } from '../live/useSeatRequests';
import { TopMeter } from '../live/TopMeter';
import type { LiveConfig } from '../live/client';
import {
  provisionObserver,
  loadObserver,
  saveObserver,
  forgetObserver,
  genObserverName,
  acquireObserver,
  acquireWatchLinkObserver,
  redeemSignin,
} from '../live/client';
import {
  fetchLocalIdentities,
  forgetMemberIdentity,
  loadMemberIdentity,
  saveMemberIdentity,
} from '../live/memberIdentity';
import { firehoseSound, roomTone } from '../live/sound';
import { useLiveStream } from '../live/useLiveStream';
import { HealthBanner } from '../live/HealthBanner';
import { useTeamHolds } from '../live/useTeamHolds';
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

  // Auto-recovery for a stale observer credential (a wiped DB or an expired 24h observer TTL, ADR 064):
  // instead of dead-ending on "invalid … credential", drop the cached credential and provision a fresh
  // observer, then reconnect. `recoveredToken` dedupes the HTTP-401 + WS-refused double-signal for one
  // credential; `attempts` is a backstop so a persistently-failing provision falls back to the form
  // rather than looping. `onConnected` re-arms both once a fresh credential works.
  const recoveredToken = useRef<string | null>(null);
  const recoverAttempts = useRef(0);
  const recoverObserver = useCallback(() => {
    const team = cfg?.team;
    const staleToken = cfg?.token;
    if (!team || !staleToken) return;
    if (recoveredToken.current === staleToken) return; // already handling this exact credential
    // A signed-in human is NOT silently demoted to an observer (ADR 222). Doing that would take the
    // answer buttons away again with no explanation — the exact defect this arc exists to fix — so a
    // dead member credential drops back to watching and says why.
    if (signedIn) {
      recoveredToken.current = staleToken;
      forgetMemberIdentity(team);
      setSignedIn(false);
      setFormError('your sign-in expired — sign in again to answer asks');
      void acquireObserver(team).then(setCfg, (e: unknown) => {
        setFormError(e instanceof Error ? e.message : String(e));
        setCfg(null);
      });
      return;
    }
    if (recoverAttempts.current >= 2) {
      forgetObserver(team);
      setFormError('the live observer keeps being rejected — reconnect or check the daemon');
      setCfg(null);
      return;
    }
    recoveredToken.current = staleToken;
    recoverAttempts.current += 1;
    forgetObserver(team);
    void (async () => {
      try {
        const name = genObserverName();
        const credential = await provisionObserver(team, name);
        saveObserver(team, { name, token: credential });
        setCfg({ team, as: name, token: credential }); // reconnect with the fresh observer
      } catch (e) {
        setFormError(e instanceof Error ? e.message : String(e));
        setCfg(null);
      }
    })();
  }, [cfg?.team, cfg?.token, signedIn]);
  const armRecovery = useCallback(() => {
    recoverAttempts.current = 0;
  }, []);

  // Cloud spec §7: a server that cannot reach its database says so on /health; show it.
  const outage = useServerHealth();
  // ADR 516: the Team's active holds, read from the same route every surface reads.
  const { holds, canSet: canSetHold, refresh: refreshHolds } = useTeamHolds(cfg);
  const stream = useLiveStream(cfg, {
    onCredentialInvalid: recoverObserver,
    onConnected: armRecovery,
  });
  const {
    envelopes: streamed,
    roster,
    error,
    liveIds,
    daemonBuild,
    daemonEpoch,
    rosterUnreadable,
    rosterStale,
  } = stream;
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
  // The asks, derived once for the surfaces that read them beside the strip (ADR 464 §4): the team
  // column's "asking nick" and the room's ask moment. The strip keeps its own derivation because it
  // folds in the answers this browser just sent; a second copy here costs one pass over the buffer.
  const derivedAsks = useMemo(() => deriveAsks(envelopes), [envelopes]);
  const asks = useMemo(() => applyTierClock(derivedAsks, Date.now()), [derivedAsks]);
  // The acts the asks strip is showing; the ticker leaves them out rather than repeat them.
  const stripAskIds = useMemo(
    () => new Set(asks.filter((a) => askIsLoud(a.state)).map((a) => a.env.id)),
    [asks],
  );
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
   *  seat never had — before ADR 222 the only way out was clearing localStorage by hand. */
  const signOut = useCallback(() => {
    const slug = cfg?.team;
    if (!slug) return;
    forgetMemberIdentity(slug);
    setSignedIn(false);
    void acquireObserver(slug).then(setCfg, (e: unknown) =>
      setFormError(e instanceof Error ? e.message : String(e)),
    );
  }, [cfg?.team]);

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

    // Default: reuse this browser's observer seat for the team, or provision one.
    setSignedIn(false);
    let creds = loadObserver(slug);
    if (!creds) {
      setProvisioning(true);
      try {
        const name = genObserverName();
        const credential = await provisionObserver(slug, name);
        creds = { name, token: credential };
        saveObserver(slug, creds);
      } catch (e) {
        setFormError(e instanceof Error ? e.message : String(e));
        setProvisioning(false);
        return;
      }
      setProvisioning(false);
    }
    setCfg({ team: slug, as: creds.name, token: creds.token });
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
  const asksStrip = connected ? (
    <AsksStrip
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
      {/* ADR 516: the chunk loads only when a hold is in force or this viewer may set one (inc 4). */}
      {(holds.length > 0 || canSetHold) && (
        <Suspense fallback={null}>
          <HoldsBanner holds={holds} cfg={cfg} canSet={canSetHold} onChanged={refreshHolds} />
        </Suspense>
      )}
      <header className="lc__topbar">
        {/* Operator chrome only. The team name and the connection/present signal moved into the
            office overlay, which carries them over the scene on both /live and /broadcast — repeating
            them a few inches above was the duplication nick asked us to drop (2026-07-24). */}
        <MusterdWord />
        {connected && <TopMeter teamName={team} envelopes={envelopes} roster={roster} />}
        {connected && <span id={NOW_SLOT_ID} className="lc__nowslot" />}
        <span className="lc__spacer" />
        {connected && (
          <button
            type="button"
            className={`lc__pbtn${seedsOpen ? ' lc__pbtn--on' : ''}`}
            onClick={() => setSeedsOpen(true)}
            aria-pressed={seedsOpen}
            title="Shared Seeds — Team ideas before they become Lanes"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 13V7M8 8C5.4 8 3.4 6.6 3 4c2.7-.2 4.7 1 5 4ZM8 10c2.6 0 4.6-1.4 5-4-2.7-.2-4.7 1-5 4Z" />
            </svg>
          </button>
        )}
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
        {connected && <WatchLinkButton cfg={cfg!} />}
        {connected && <RoomToneToggle />}
        {connected && <SoundToggle />}
        <Clock />
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
          {phone && <div className="lc__phone-asks">{asksStrip}</div>}
          <div
            className={
              `lc__canvas${collapsed.office ? ' is-office-collapsed' : ''}` +
              `${collapsed.team ? ' is-team-collapsed' : ''}`
            }
            // A modal means it: while the board overlay is up, the room behind it takes no focus and
            // no clicks (the AsksStrip inert precedent, promoted to page scope).
            inert={boardOpen || seedsOpen || logOpen}
          >
            <OfficeScene
              {...officeRoom(team, stream, { entries, board, asks })}
              fit="furnished"
              collapsed={collapsed.office}
              onCollapse={() => toggleCollapse('office')}
              onActClick={onActClick}
              onBoardOpen={openBoard}
              onBoardHover={preloadBoardOverlay}
              // The asks & approvals rail (ADR 149) rides the top of the room itself — the office
              // frames its own asks (nick, 2026-07-28). Still renders nothing until an ask exists.
              topSlot={phone ? null : asksStrip}
              workCues={WORK_CUES}
              onCaption={setCaption}
              linked={lit ?? linked}
              onPlateHover={setLinked}
            />
            <TeamColumn
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
          {/* The headline ticker (ADR 464 §5): the last few notable moments, under the room. */}
          <Ticker
            envelopes={envelopes}
            roster={roster}
            board={board}
            hide={stripAskIds}
          />
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
          <LogDrawer open={logOpen} onClose={closeLog} title={`Team log — ${team}`}>
            <Suspense fallback={<p className="lc-drawer__loading">Opening the log…</p>}>
              <LazyStream envelopes={envelopes} roster={roster} liveIds={liveIds} cfg={cfg ?? undefined} />
            </Suspense>
          </LogDrawer>
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

/**
 * Copy a shareable, read-only **watch link** — an observer credential in the URL fragment (`#w=…`, so
 * it never hits the server). Anyone the team hands it to opens the office as that observer: read-only
 * by construction (ADR 063), fans out to any number of viewers, no account and no per-viewer seat.
 *
 * The link carries a **public-grade** seat of its own (ADR 136), minted on first share — *not* this
 * dashboard's credential. It used to be `cfg.token`, which is the operator's own full-grade seat, so
 * sharing a link shared every DM on the team. A viewer now sees team/broadcast traffic and nothing
 * directed.
 */
function WatchLinkButton({ cfg }: { cfg: LiveConfig }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    const { origin } = window.location;
    let creds;
    try {
      creds = await acquireWatchLinkObserver(cfg.team);
    } catch {
      // Minting failed — do NOT fall back to cfg.token. That fallback is the whole bug: it would
      // silently hand out a full-visibility credential at the exact moment we meant to withhold one.
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2400);
      return;
    }
    const url =
      `${origin}/live?team=${encodeURIComponent(cfg.team)}&as=${encodeURIComponent(creds.name)}` +
      `#w=${encodeURIComponent(creds.token)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt('Copy this read-only watch link (public traffic only):', url);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      className={`lc__pbtn${copied ? ' lc__pbtn--on' : ''}`}
      onClick={() => void copy()}
      title={
        failed
          ? 'Could not mint a watch-link seat — copy it from the daemon host'
          : 'Copy a shareable read-only watch link (public traffic only — no DMs, no account)'
      }
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
  );
}

/**
 * Mute/unmute the firehose's per-act sound cues. Default OFF: enabling is the user gesture that lets
 * the AudioContext start (browser autoplay policy), and a one-shot blip confirms it's live.
 */
function SoundToggle() {
  const [on, setOn] = useState(() => firehoseSound.enabled);
  const toggle = () => {
    const next = !on;
    firehoseSound.setEnabled(next);
    setOn(next);
    if (next) firehoseSound.chime('handoff'); // a friendly two-note "sound is on" confirmation
  };
  return (
    <button
      type="button"
      className={`lc__sound${on ? ' lc__sound--on' : ''}`}
      onClick={toggle}
      aria-pressed={on}
      title={on ? 'Mute arrival sounds' : 'Play a sound on every new message'}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 6.2h2.2L8.3 3.6v8.8L5.2 9.8H3z" />
        {on ? (
          <path d="M10.4 5.6a3.2 3.2 0 0 1 0 4.8M12.2 4a5.6 5.6 0 0 1 0 8" />
        ) : (
          <path d="m10.8 6 3.4 4M14.2 6l-3.4 4" />
        )}
      </svg>
    </button>
  );
}

/**
 * Room tone: the sound of the office being *there* — ventilation, a low building hum, and somebody
 * typing a few desks away. Its own switch rather than a mode of the one above, because the two
 * answer different questions (see the room-tone block in `sound.ts`): a viewer may reasonably want
 * arrivals audible in a silent room, or a lived-in room that never pings at them.
 *
 * Default OFF, like the cues, and for the same reason — the click IS the gesture that lets the
 * AudioContext start. A preference restored from an earlier session cannot start itself, so this
 * button is also where `resumeIfEnabled` gets its chance.
 */
function RoomToneToggle() {
  const [on, setOn] = useState(() => roomTone.enabled);
  // A stored `on` from a previous visit needs a gesture before it can make a sound. Any click
  // anywhere on the page is gesture enough, and one is cheaper to catch than to ask for.
  useEffect(() => {
    if (!roomTone.enabled) return;
    const wake = () => roomTone.resumeIfEnabled();
    window.addEventListener('pointerdown', wake, { once: true });
    return () => window.removeEventListener('pointerdown', wake);
  }, []);
  const toggle = () => {
    const next = !on;
    roomTone.setEnabled(next);
    setOn(next);
  };
  return (
    <button
      type="button"
      className={`lc__sound lc__sound--room${on ? ' lc__sound--on' : ''}`}
      onClick={toggle}
      aria-pressed={on}
      title={on ? 'Silence the room' : 'Play the room: quiet office ambience'}
    >
      {/* Three rising bars behind a mug — "the room is running", not "a message arrived". Muted, the
          bars flatten to one line: the room is still there, it just is not making a sound. */}
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {on ? <path d="M2.5 9.5v2M5 7.5v4M7.5 5.5v6" /> : <path d="M2.5 11.5h5.2" />}
        <path d="M10.5 6.5h3.2v3a2 2 0 0 1-2 2h-1.2z" />
        <path d="M13.7 7.5h.6a1.1 1.1 0 0 1 0 2.2h-.6" />
      </svg>
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
          Enter a team to stream all of its communication. A hidden read-only observer seat is
          created for you — watching never shows you on the roster.
        </p>
        <label className="lc-form__field">
          <span>Team</span>
          {/* No autoFocus. This form is the FIRST thing on the page, and focusing it on load drops a
              screen-reader user straight into a text field — past the heading and past the sentence
              above explaining that watching creates a hidden observer seat and never puts them on
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

        <MemberSignInFields advanced={advanced} onAdvanced={onAdvanced} />

        {error && <p className="lc-form__error">{error}</p>}

        <button
          className="lc-form__connect"
          disabled={!team.trim() || provisioning}
          onClick={onWatch}
        >
          {provisioning && <span className="lc-spinner" aria-hidden="true" />}
          {provisioning ? 'Provisioning…' : 'Watch live'}
        </button>

        <MemberSignInToggle advanced={advanced} onAdvanced={onAdvanced} />
      </div>
    </div>
  );
}
