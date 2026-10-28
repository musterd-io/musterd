import type { Envelope, LaneBoard, MemberSummary, WorkingHours } from '@musterd/protocol';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { MusterdChip } from '../brand/MusterdWord';
import { memberColor, memberPosture } from './format';
import { gatheredFrom } from './huddles';
import { HuddleRail } from './HuddleRail';
import type { OfficeAsk, OfficeData, OfficeHandle } from './office-scene/types';
import { askIsLoud, type AskView } from './asks';
import { SETTLED_MS } from './askPhrase';
import { actToEvent, speechEventFor } from './office-scene/mapping';
import { replayEvents } from './office-scene/replay';
import { CollapseButton, PanelRail } from './PanelChrome';
import { captionFor, type Caption } from './captions';
import type { RoomEntry } from './workingOn';
import { dreamingSeat, lingerUntil, wokenSeat } from './wokenSeat';
import { blockedOwners, type OfficeRoomProps } from './officeRoom';
import { stalledLaneIds } from './briefing';
import { experimentEntries } from './experimentReads';
import { nextStatusExpiry, visibleStatusLine } from './statusLine';
import { projectWallBoard } from './office-scene/wallboard';

/** The key (ADR 464 §3.4) is a corner card a viewer reads once; it rides a lazy chunk so the words
 *  cost /live's eager graph nothing (ADR 151/183 — initial JS sat exactly at its ceiling). */
const LazyOfficeKey = lazy(() => import('./OfficeKey').then((m) => ({ default: m.OfficeKey })));

/**
 * Roster → the office's node data. `posture` is resolved here with `memberPosture` — the *same* call the
 * roster rail's chip makes — so the floor and the rail read one value: a member the rail calls `idle` is
 * on the couch with an amber dot, never at a desk with a green one.
 *
 * Surface/model/work fields feed the floating nameplates (presence-chrome design, 2026-07-30).
 */
/** Replay on open fires once, on the first envelopes the mounted scene sees (office-scene/replay). */
interface ReplayOnce {
  done: boolean;
  envelopes: Envelope[];
  liveIds: ReadonlySet<string>;
}
function replayOnce(h: OfficeHandle | null, ref: MutableRefObject<ReplayOnce>): void {
  const r = ref.current;
  if (!h || r.done || r.envelopes.length === 0) return;
  r.done = true;
  h.replay(replayEvents(r.envelopes, r.liveIds, Date.now()));
}

/** lane id → owner, one map per board object, so the scene sees a new reference only when the board
 *  changes (a roster tick must not re-seed and drop the walks the room just watched). */
const ownersByBoard = new WeakMap<LaneBoard, ReadonlyMap<string, string>>();
function laneOwnersOf(board: LaneBoard | null): ReadonlyMap<string, string> | null {
  if (!board) return null;
  let owners = ownersByBoard.get(board);
  if (!owners) {
    owners = new Map(board.lanes.flatMap((l) => (l.owner_seat ? [[l.id, l.owner_seat] as const] : [])));
    ownersByBoard.set(board, owners);
  }
  return owners;
}

/** lane id → title, one map per board object: the huddle rail names a lane topic by its title. */
const titlesByBoard = new WeakMap<LaneBoard, ReadonlyMap<string, string>>();
function laneTitlesOf(board: LaneBoard | null): ReadonlyMap<string, string> | undefined {
  if (!board) return undefined;
  let titles = titlesByBoard.get(board);
  if (!titles) {
    titles = new Map(board.lanes.map((l) => [l.id, l.title] as const));
    titlesByBoard.set(board, titles);
  }
  return titles;
}

/** One shared empty list, so a route without goals never re-runs the room's memo. */
const NO_GOALS: readonly string[] = [];

function computeData(
  teamName: string,
  teamWorkingHours: WorkingHours | null,
  roster: MemberSummary[],
  entries: RoomEntry[],
  board: LaneBoard | null,
  envelopes: Envelope[],
  asks: readonly AskView[],
  you: string | null = null,
  now: number = Date.now(),
  goals: readonly string[] = NO_GOALS,
): OfficeData {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const humans = new Set(roster.filter((m) => m.kind === 'human').map((m) => m.name));
  // ADR 449's `sponsored_by` is a member ID; the welcome caption says the sponsor's NAME.
  const nameById = new Map(roster.map((m) => [m.id, m.name]));
  const blocked = blockedOwners(board);
  return {
    teamName,
    teamWorkingHours,
    // A stopped plan's cards fade on the wall (lane 01M4V9YKMG) — the Now card's rule, at lane level.
    // The corkboard's read pins (ADR 644 inc 3) are the Experiments section's entries, same order.
    wallBoard: projectWallBoard(
      board,
      stalledLaneIds(board, now),
      now,
      experimentEntries(board, now).map((e) => e.status),
      goals,
    ),
    laneOwners: laneOwnersOf(board),
    // Who is in an open huddle right now (ADR 378 increment 2) — folded from the timeline the page
    // already holds, so both surfaces gather without either route wiring anything.
    gathered: [...gatheredFrom(envelopes)],
    asks: roomAsks(asks, humans, Date.now()),
    // Only a seat that is actually on the roster: a stale saved identity marks nobody.
    you: you !== null && roster.some((m) => m.name === you) ? you : null,
    nodes: roster.map((m) => {
      const kind = m.kind === 'human' ? 'human' : 'agent';
      // Just woken and already gone: doze at the desk for a while instead of walking straight out
      // (display only — the plate keeps saying offline; `lingerUntil` in wokenSeat.ts).
      const dozing = lingerUntil(m, now) !== null;
      const live =
        m.presences?.find((p) => p.status === 'online' || p.status === 'away') ?? m.presences?.[0];
      const entry = byName.get(m.name);
      return {
        name: m.name,
        kind,
        service: m.kind === 'service',
        presence: dozing ? 'online' : m.presence,
        activity: dozing ? 'active' : (m.activity ?? (m.presence === 'offline' ? 'offline' : 'active')),
        posture: dozing ? 'working' : memberPosture(m),
        state: m.state ?? null,
        color: memberColor(m.name, kind, m.hue),
        hue: m.hue ?? null,
        role: m.role,
        roles: m.roles,
        surface: live?.surface ?? null,
        model: live?.model ?? null,
        workTitle: entry?.title ?? null,
        workSource: entry?.source ?? null,
        laneState: entry?.laneState ?? null,
        blocked: blocked.has(m.name),
        statusLine: visibleStatusLine(m, now),
        moreLanes: entry?.moreLanes ?? 0,
        dnd: m.availability?.status === 'dnd',
        offline_reason: m.offline_reason ?? null,
        last_seen_at: m.presences?.length
          ? Math.max(...m.presences.map((p) => p.last_seen_at))
          : null,
        created_at: m.created_at ?? null,
        sponsored_by: m.sponsored_by ? (nameById.get(m.sponsored_by) ?? null) : null,
        // Reads the same live row `surface` and `model` came from just above, via the shared
        // helper — a plate that took its harness from one attachment and its provenance from
        // another would be describing two sessions as one.
        woken: dozing || wokenSeat(m),
        dreaming: dozing || dreamingSeat(m),
        ...(dozing ? { dozing: true } : {}),
      };
    }),
  };
}

/**
 * The asks the ROOM plays (ADR 464 §3.3): to a human or the team only — an agent-routed review ask
 * is a review, not a room moment — open while loud, settled for a beat after `settledAt`, then gone.
 */
function roomAsks(asks: readonly AskView[], humans: Set<string>, now: number): OfficeAsk[] {
  const out: OfficeAsk[] = [];
  for (const a of asks) {
    if (a.to !== null && !humans.has(a.to)) continue;
    if (askIsLoud(a.state)) {
      out.push({ id: a.env.id, from: a.env.from, to: a.to, state: 'open' });
      continue;
    }
    if (a.settledAt !== undefined && now - a.settledAt <= SETTLED_MS) {
      const outcome =
        a.state === 'accepted'
          ? 'accepted'
          : a.state === 'declined'
            ? 'declined'
            : a.state === 'deferred'
              ? 'deferred'
              : a.state === 'resolved'
                ? 'resolved'
                : a.state === 'lapsed'
                  ? 'expired'
                  : 'proceeded';
      out.push({ id: a.env.id, from: a.env.from, to: a.to, state: 'settled', outcome });
    }
  }
  return out;
}

/**
 * The live isometric office: every teammate sits at a desk (presence decides who's in the room and
 * whether they're working / idle / away), and each act plays as a cue over the floor. The scene is
 * dynamically imported (kept out of SSR); prefers-reduced-motion draws a static frame. Name labels are
 * HTML overlay.
 */
export function OfficeScene({
  teamName,
  teamWorkingHours,
  roster,
  envelopes,
  liveIds,
  pulses,
  collapsed = false,
  onCollapse,
  onActClick,
  onLaneClick,
  onBoardOpen,
  onBoardHover,
  onSettingsOpen,
  onSettingsHover,
  onWikiOpen,
  onWikiHover,
  settingsSpot = null,
  broadcast = false,
  captureFps,
  sprites = false,
  dirtyRects = false,
  fit = 'room',
  entries,
  board,
  goals = NO_GOALS,
  asks,
  onReady,
  topSlot,
  bandSlot,
  cornerSlot,
  markContact,
  /** Hybrid nameplate work cues, or none. Default none: who is on what lives in the team column on
   *  `/live` and `/broadcast` alike (ADR 464). */
  workCues = 'none',
  onCaption,
  linked = null,
  onPlateHover,
  you = null,
}: OfficeRoomProps & {
  collapsed?: boolean;
  onCollapse?: () => void;
  /** Speech-bubble click-through: called with the act's envelope id (the route scrolls the stream). */
  onActClick?: (id: string) => void;
  /** A lane act's bubble "open ›" clicked — hands back the lane id (the route opens its chain on the
   * board). `/live` only; without it every bubble's link opens the log. */
  onLaneClick?: (laneId: string) => void;
  /** The wall's agile board clicked — hands back its viewport rect (the overlay's zoom origin).
   * `/live` only; leaving it unset (as `/broadcast` does) renders the board as plain paint. */
  onBoardOpen?: (rect: DOMRect) => void;
  /** First hover/focus on the board — preload the overlay's lazy chunk. */
  onBoardHover?: () => void;
  /** The working-hours calendar clicked — hands back its rect, the settings overlay's zoom origin.
   * `/live` only, like `onBoardOpen`. */
  onSettingsOpen?: (rect: DOMRect) => void;
  /** First hover/focus on the calendar — preload the settings overlay's chunk. */
  onSettingsHover?: () => void;
  /** The wiki shelf clicked (ADR 747) — hands back its rect, the wiki overlay's zoom origin. `/live`
   * only; on /broadcast the shelf's sign hangs and nothing opens. */
  onWikiOpen?: (rect: DOMRect) => void;
  /** First hover/focus on the shelf — preload the wiki overlay's chunk. */
  onWikiHover?: () => void;
  /** Whether the calendar opens settings for this viewer, and whether something there waits for
   * them. Null (the default) leaves the calendar as paint. */
  settingsSpot?: { enabled: boolean; flagged: boolean } | null;
  /** Broadcast mode (ADR 157) — only `/broadcast` sets it: the scene is a stream source, so it keeps
   * animating unseen, pins DPR to 1, and ignores reduced-motion (the viewer of a stream is not the
   * person whose OS preference this is). */
  broadcast?: boolean;
  /** Encode fps when broadcasting — office coalesces draws to this rate. From `?fps=` on `/broadcast`. */
  captureFps?: number;
  /** Cache the static furniture as sprites instead of redrawing the room every frame (spec
   * 2026-09-17). On for `/broadcast` (ADR 488, `&sprites=0` opts out); `/live` never passes it. */
  sprites?: boolean;
  /** Repaint only what changed each frame (smooth-capture spec, lever 2). Needs `sprites`; honoured
   * under `broadcast` only. On for `/broadcast` (`&dirty=0` opts out); `/live` never passes it. */
  dirtyRects?: boolean;
  /** What the room is fitted to — `'furnished'` on /live and /broadcast (see `mountOffice`). */
  fit?: 'room' | 'furnished';
  /** Handed the scene handle once it mounts (and `null` on teardown) — the broadcast route publishes it
   * as `window.__office` so a capturer can probe the scene. */
  onReady?: (handle: OfficeHandle | null) => void;
  /** Chrome floated over the TOP of the room. `/live` seats the answerable asks & approvals rail
   * here (nick's call: the office frames its own asks; the page above the panels stays quiet), and
   * `/broadcast` seats `StreamAskBanner` — the same banner, read-only, because a stream cannot
   * answer an ask but should still show one is waiting (ADR 228, ADR 464). */
  topSlot?: ReactNode;
  /**
   * Chrome seated in a strip BENEATH the room rather than floated over it. The band is sized to its
   * content and the room keeps every remaining pixel. No route fills it today.
   */
  bandSlot?: ReactNode;
  /** Chrome stacked in the bottom-right corner above the product watermark — the route's own
   * assertions about the page (a notice, a contact line). `/broadcast` fills it; `/live` does not. */
  cornerSlot?: ReactNode;
  /** The team's address, printed beside the mark in the bottom-right corner (teamContact). */
  markContact?: string | undefined;
  workCues?: 'hybrid' | 'none';
  /** ADR 464: the narration line, handed OUT to the route so chrome outside the room (the team
   * column's header) can carry it. */
  onCaption?: (caption: Caption | null) => void;
  /** ADR 464: the member whose card is hovered in the team column — their plate wears a ring. */
  /** One member (a team card under the pointer) or several (a Now goal row): their plates ring. */
  linked?: string | readonly string[] | null;
  /** ADR 464: a plate under the pointer (null on leave), so the route can ring that member's card. */
  onPlateHover?: (name: string | null) => void;
  /** The signed-in viewer's seat: their plate says "you". `/live` only —
   *  `/broadcast` never passes it (its seat is an observer, not a person). */
  you?: string | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OfficeHandle | null>(null);
  const emittedRef = useRef<Set<string>>(new Set());

  // A dozing seat (a wake that just ended) needs one more pass when its linger runs out, so it gets up
  // and leaves on time even if nothing else changes — one timer, to the earliest expiry.
  const [lingerTick, setLingerTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    // ADR 721: the same one timer also lands on the minute a status line lapses, so it leaves the
    // plate with no new event and no poll.
    const next = Math.min(
      ...roster.map((m) => lingerUntil(m, now) ?? Infinity),
      nextStatusExpiry(roster, now) ?? Infinity,
    );
    if (!Number.isFinite(next)) return;
    const t = window.setTimeout(() => setLingerTick((n) => n + 1), next - now + 50);
    return () => window.clearTimeout(t);
  }, [roster, lingerTick]);
  const data = useMemo(
    () =>
      computeData(teamName, teamWorkingHours, roster, entries, board, envelopes, asks, you, Date.now(), goals),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lingerTick re-reads the clock
    [teamName, teamWorkingHours, roster, entries, board, envelopes, asks, you, goals, lingerTick],
  );
  // Latest-value refs for the mount effect below, which subscribes ONCE and must not re-run when a
  // prop identity changes (re-running it would tear down and rebuild the whole canvas scene).
  //
  // Replay on open (nick, 2026-10-12): the last ten minutes' lane walks, once, when the scene and the
  // first backfill are both here — whichever lands second fires it. Declared before the mount effect, which reads the ref. /broadcast replays too: a stream
  // that opens on a still room is the same problem.
  const replayRef = useRef<ReplayOnce>({ done: false, envelopes, liveIds });
  useEffect(() => {
    replayRef.current = { ...replayRef.current, envelopes, liveIds };
    replayOnce(handleRef.current, replayRef);
  }, [envelopes, liveIds]);

  // Written in an effect rather than during render: a render must be pure, and React may render a
  // component and throw the result away. This effect is declared BEFORE the mount effect on purpose
  // — effects run in declaration order, so the refs are populated by the time the scene mounts and
  // reads them.
  const dataRef = useRef(data);
  const onActClickRef = useRef(onActClick);
  const onLaneClickRef = useRef(onLaneClick);
  const onBoardOpenRef = useRef(onBoardOpen);
  const onBoardHoverRef = useRef(onBoardHover);
  const onSettingsOpenRef = useRef(onSettingsOpen);
  const onSettingsHoverRef = useRef(onSettingsHover);
  const onWikiOpenRef = useRef(onWikiOpen);
  const onWikiHoverRef = useRef(onWikiHover);
  const settingsSpotRef = useRef(settingsSpot);
  const onReadyRef = useRef(onReady);
  const onCaptionRef = useRef(onCaption);
  const onPlateHoverRef = useRef(onPlateHover);
  const collapsedRef = useRef(collapsed);
  useEffect(() => {
    dataRef.current = data;
    onActClickRef.current = onActClick;
    onLaneClickRef.current = onLaneClick;
    onBoardOpenRef.current = onBoardOpen;
    onBoardHoverRef.current = onBoardHover;
    onSettingsOpenRef.current = onSettingsOpen;
    onSettingsHoverRef.current = onSettingsHover;
    onWikiOpenRef.current = onWikiOpen;
    onWikiHoverRef.current = onWikiHover;
    settingsSpotRef.current = settingsSpot;
    onReadyRef.current = onReady;
    onCaptionRef.current = onCaption;
    onPlateHoverRef.current = onPlateHover;
    collapsedRef.current = collapsed;
  });

  useEffect(() => {
    const host = hostRef.current;
    const labelHost = labelRef.current;
    if (!host || !labelHost) return;
    // Reduced-motion is a *viewer's* preference, and a broadcast page has no viewer — honouring it on
    // the capture machine would ship a frozen room to everyone watching the stream (and would drop the
    // Tier-A ambient CSS layer with it). Stream sources render in full motion, always.
    const reduced = broadcast
      ? false
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let disposed = false;
    import('./office-scene')
      .then(({ mountOffice }) => {
        if (disposed || !host || !labelHost) return;
        const handle = mountOffice(host, labelHost, reduced, {
          onActClick: (id) => onActClickRef.current?.(id),
          // Gated on the mount-time prop like the board below: /live wires it, /broadcast never does.
          ...(onLaneClickRef.current
            ? { onLaneClick: (lane: string) => onLaneClickRef.current?.(lane) }
            : {}),
          // The narration line renders in the team column's header (chrome), not as scene DOM.
          onCaption: (next) => {
            if (disposed) return;
            onCaptionRef.current?.(next);
          },
          onPlateHover: (n) => onPlateHoverRef.current?.(n),
          // Presence decides whether the hotspot exists at all, so gate on the mount-time prop —
          // stable per route (/live wires it, /broadcast never does) — and read through the ref after.
          ...(onBoardOpenRef.current
            ? {
                onBoardClick: (rect: DOMRect) => onBoardOpenRef.current?.(rect),
                onBoardHover: () => onBoardHoverRef.current?.(),
              }
            : {}),
          ...(onSettingsOpenRef.current
            ? {
                onSettingsClick: (rect: DOMRect) => onSettingsOpenRef.current?.(rect),
                onSettingsHover: () => onSettingsHoverRef.current?.(),
              }
            : {}),
          ...(onWikiOpenRef.current
            ? {
                onWikiClick: (rect: DOMRect) => onWikiOpenRef.current?.(rect),
                onWikiHover: () => onWikiHoverRef.current?.(),
              }
            : {}),
          broadcast,
          ...(captureFps !== undefined ? { captureFps } : {}),
          sprites,
          dirtyRects,
          fit,
          interactiveLabels: !broadcast,
          showWorkCues: workCues === 'hybrid',
        });
        handle.update(dataRef.current);
        handle.setSuspended(collapsedRef.current); // mounted while collapsed → start parked
        if (settingsSpotRef.current) handle.setSettingsSpot(settingsSpotRef.current);
        handleRef.current = handle;
        replayOnce(handle, replayRef);
        onReadyRef.current?.(handle);
      })
      .catch((err: unknown) => {
        /* canvas unavailable — the warm gradient + labels stand in. A thrown update/replay lands
           here too and used to vanish; say so where a developer can see it. */
        if (import.meta.env.DEV) console.error('office mount failed', err);
      });
    return () => {
      disposed = true;
      handleRef.current?.dispose();
      handleRef.current = null;
      onReadyRef.current?.(null);
    };
  }, [broadcast, captureFps, sprites, dirtyRects, fit, workCues]);

  useEffect(() => {
    handleRef.current?.update(data);
  }, [data]);

  // Collapsed panel (opacity 0, still mounted) → park the render loop; expanding resumes with one
  // fresh synchronous frame, so the reopen stays instant. Measured before this: a collapsed office
  // kept the full-scene ambient repaint running at ~18fps for pixels nobody could see.
  useEffect(() => {
    handleRef.current?.setSuspended(collapsed);
  }, [collapsed]);

  // The settings door on the calendar: shown for a viewer who has settings, flagged when a pairing
  // waits. Two booleans, so the effect keys on them rather than on a fresh object every render.
  const spotEnabled = settingsSpot?.enabled ?? false;
  const spotFlagged = settingsSpot?.flagged ?? false;
  useEffect(() => {
    handleRef.current?.setSettingsSpot({ enabled: spotEnabled, flagged: spotFlagged });
  }, [spotEnabled, spotFlagged]);

  // The card↔character link (ADR 464): a class on the plate, so it costs no frame.
  useEffect(() => {
    handleRef.current?.setLinked(linked ?? null);
  }, [linked]);

  // Play a cue for each newly *live*-arrived act (backfilled history never appears in liveIds, so it
  // doesn't replay on load). The act→choreography mapping lives in office-scene/mapping.
  useEffect(() => {
    const h = handleRef.current;
    if (!h) return;
    for (const e of envelopes) {
      if (!liveIds.has(e.id) || emittedRef.current.has(e.id)) continue;
      emittedRef.current.add(e.id);
      const ev = actToEvent(e);
      if (ev) h.emit(ev);
      // The caption rail (first-five-seconds §2): the lazy scene owns scheduling + DOM; only the
      // plain-sentence projection is computed here (keeps the entry chunk out of the rail's bytes).
      // An accept is narrated by what it answered (lane 01M51E333V), so look the answered act up — only
      // for an accept, so the common act pays nothing for it.
      const ref = e.act === 'accept' ? e.meta?.['in_reply_to'] : undefined;
      const answered = typeof ref === 'string' ? envelopes.find((x) => x.id === ref) : undefined;
      const caption = captionFor(e, answered);
      if (caption) h.emit({ kind: 'caption', caption });
      // EVERY act also speaks over the sender's head — constructed in mapping.ts (speechEventFor),
      // where the passthrough of text/tone/addressee is pinned by tests this component can't carry.
      h.emit(speechEventFor(e));
    }
  }, [envelopes, liveIds]);

  // The tool-call pulse (ADR 660): hand the scene only the entries whose `ts` moved since the last
  // frame — a Map arrives per pulse, so a room of ten working seats would otherwise re-send ten.
  const pulsedRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const h = handleRef.current;
    if (!h || !pulses) return;
    for (const [member, p] of pulses) {
      if (pulsedRef.current.get(member) === p.ts) continue;
      pulsedRef.current.set(member, p.ts);
      h.pulse(member, p);
    }
  }, [pulses]);

  const agents = roster.filter((m) => m.kind === 'agent').length;
  const humans = roster.filter((m) => m.kind === 'human').length;

  return (
    <section className={`lc-office${collapsed ? ' is-collapsed' : ''}`}>
      {/* The room's box. Everything below that must line up with canvas pixels — the plates, the
          ambient overlay, the speech bubbles, the floated chrome — is positioned against the stage,
          so framing the office moves the whole scene as one piece. */}
      <div className="lc-office__stage">
        {/* Canvas stays mounted while collapsed (state survives, re-expanding is instant) but the
            render loop is SUSPENDED via setSuspended — no draw cost behind an invisible panel. */}
        <div className="lc-gl-canvas" ref={hostRef} aria-hidden="true" />
        <div className="lc-gl-labels" ref={labelRef} aria-hidden="true" />
        {/* The asks rail floats over the top of the room the way the reel floats over the bottom —
            and the huddle rail stacks directly beneath it in the same box, so the two never overlap
            however tall either grows. The rail is mounted HERE, inside the room, rather than in a
            route's slot: the office frames its own huddles, and one mount is what makes /live and
            /broadcast show the same rooms without either route wiring anything (the officeRoom
            parity argument). It renders nothing until a huddle is open. */}
        {!collapsed && (
          <div className="lc-office__asks">
            {topSlot}
            <HuddleRail
              envelopes={envelopes}
              roster={roster}
              laneTitles={laneTitlesOf(board)}
              roomLink={!broadcast}
              {...(broadcast || !onActClick ? {} : { onShow: onActClick })}
            />
          </div>
        )}
        {/* The product's mark on the room itself — for every frame that leaves this app (a clip, a
            screenshot, the stream), quiet enough to live under everything. The overlay card carries
            the TEAM's name; this corner carries the product's. */}
        {/* The key (ADR 464 §3.4) — the page only: a stream has no one to close it. */}
        {!collapsed && !broadcast && (
          <Suspense fallback={null}>
            <LazyOfficeKey />
          </Suspense>
        )}
        {!collapsed && cornerSlot && <div className="lc-office__corner">{cornerSlot}</div>}
        {!collapsed && (
          <div className="lc-office__mark">
            <MusterdChip size={15} className="lc-office__chip" />
            {markContact && <span className="lc-office__contact">{markContact}</span>}
          </div>
        )}
      </div>
      {!collapsed && bandSlot && <div className="lc-office__band">{bandSlot}</div>}
      {onCollapse && (
        <div className="lc-office__collapse">
          <CollapseButton side="left" label="the office" onClick={onCollapse} />
        </div>
      )}
      {collapsed && onCollapse && (
        <PanelRail
          side="left"
          label="Office"
          hint={String(agents + humans)}
          onExpand={onCollapse}
        />
      )}
    </section>
  );
}
