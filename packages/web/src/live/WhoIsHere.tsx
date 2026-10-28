import type { MemberSummary } from '@musterd/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MemberFace } from './MemberFace';
import { clock, hueOf, memberColor, rosterIndex } from './format';
import { whoIsHere, type HereEntry } from './hereRow';

/** Faces drawn before the rest fold into "+N". */
const MAX_FACES = 5;
/** How long a leaving face takes to fold away; matches `--lc-dur-3`. */
const LEAVE_MS = 280;
/** How long an arriving face wears its ring; matches `--lc-dur-5`. */
const ARRIVE_MS = 600;
/** How long "nick opened /live" stays beside the row. */
const WHISPER_MS = 3200;
/** The note's fade out; matches `--lc-dur-4`. */
const FADE_MS = 400;
/** A face back within this long of leaving is a reload, not news. */
const REJOIN_MS = 60_000;

type Shown = HereEntry & { leaving?: boolean; arrived?: boolean };

/**
 * The "who is here" row (ADR 692): the members with /live open, as the faces they wear on the floor.
 * It sits at the head of the topbar's tools. Hovering or focusing the stack fans it open, and each
 * face carries a small card. The one authored moment is an arrival: when someone opens /live while
 * you watch, their face slides in with a single ring of their own colour. If they were already
 * online elsewhere, "<name> opened /live" shows beside the row for a few seconds (announced politely
 * to screen readers); if they came online by opening it, the team column's "just walked in" has
 * said so and this row does not repeat it. A face that leaves
 * folds away rather than vanishing. Nothing loops. Under reduced motion every change is instant and
 * the words still say what moved.
 */
export function WhoIsHere({ roster, you }: { roster: MemberSummary[]; you: string | null }) {
  const idx = useMemo(() => rosterIndex(roster), [roster]);
  const here = useMemo(() => whoIsHere(roster, you), [roster, you]);
  // Who was online on the previous read: someone who comes online BY opening /live is already
  // announced by the team column ("just walked in"), so the note beside this row is for a member
  // who was elsewhere first (a CLI or agent session) and then opened /live. Say it once.
  const onlineBefore = useRef(new Set<string>());
  const { shown, whisper } = useArrivals(here, (name) => onlineBefore.current.has(name));
  useEffect(() => {
    onlineBefore.current = new Set(roster.filter((m) => m.presences.length > 0).map((m) => m.name));
  }, [roster]);
  const [open, setOpen] = useState<string | null>(null);

  // A tap pins a card open; a tap anywhere else, or Escape, puts it away.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !rootRef.current?.contains(e.target as Node))
        setOpen(null);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', away);
    };
  }, [open]);

  const faces = shown.slice(0, MAX_FACES);
  const folded = shown.slice(MAX_FACES).filter((e) => !e.leaving);
  const present = shown.filter((e) => !e.leaving);
  // One person watching is nobody to show (nick, 2026-10-28: "if there is only 1 person watching,
  // let's not show that at all"); the row appears the moment a second one opens /live.
  if (present.length < 2) return null;

  return (
    <div className="lc-here" ref={rootRef}>
      <div className="lc-here__pile" role="group" aria-label={groupLabel(present)}>
        {faces.map((e) => (
          <div
            key={e.name}
            className={`lc-here__slot${e.leaving ? ' is-leaving' : ''}${e.arrived ? ' is-arriving' : ''}${e.idle ? ' is-idle' : ''}${e.you ? ' is-you' : ''}`}
            style={{ ['--here-ring' as string]: memberColor(e.name, e.kind, hueOf(e.name, idx)) }}
          >
            <button
              type="button"
              className="lc-here__face"
              aria-expanded={open === e.name}
              aria-label={faceLabel(e)}
              onClick={() => setOpen((o) => (o === e.name ? null : e.name))}
            >
              <MemberFace name={e.name} roster={idx} size={26} />
            </button>
            <HereCard entry={e} roster={idx} pinned={open === e.name} />
          </div>
        ))}
        {folded.length > 0 && (
          <div className="lc-here__slot">
            <button
              type="button"
              className="lc-here__more"
              aria-expanded={open === '+'}
              aria-label={`${folded.length} more: ${folded.map((e) => e.name).join(', ')}`}
              onClick={() => setOpen((o) => (o === '+' ? null : '+'))}
            >
              +{folded.length}
            </button>
            <div className={`lc-here__card lc-here__card--list${open === '+' ? ' is-pinned' : ''}`} role="tooltip">
              {folded.map((e) => (
                <div key={e.name} className="lc-here__li">
                  <MemberFace name={e.name} roster={idx} size={20} />
                  <span className="lc-here__name">{e.name}</span>
                  {e.you && <span className="lc-here__you">you</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <span className="lc-here__whisper" aria-live="polite">
        {whisper && (
          <span key={whisper.key} className={`lc-here__whisper-text${whisper.going ? ' is-going' : ''}`}>
            <b>{whisper.name}</b> opened /live
          </span>
        )}
      </span>
    </div>
  );
}

function HereCard({ entry: e, roster, pinned }: { entry: HereEntry; roster: Map<string, MemberSummary>; pinned: boolean }) {
  return (
    <div className={`lc-here__card${pinned ? ' is-pinned' : ''}`} role="tooltip">
      <MemberFace name={e.name} roster={roster} size={36} />
      <div className="lc-here__who">
        <span className="lc-here__name">
          {e.name}
          {e.you && <span className="lc-here__you">you</span>}
        </span>
        <span className="lc-here__meta">
          {e.kind === 'human' ? 'person' : 'agent session'}
          {e.since !== null && <> · here since {clock(e.since)}</>}
          {e.tabs > 1 && <> · {e.tabs} tabs</>}
          {e.idle && <> · quiet</>}
        </span>
      </div>
    </div>
  );
}

function faceLabel(e: HereEntry): string {
  const who = e.you ? `${e.name} (you)` : e.name;
  return `${who}, ${e.kind === 'human' ? 'person' : 'agent session'}${e.since !== null ? `, here since ${clock(e.since)}` : ''}`;
}

function groupLabel(present: HereEntry[]): string {
  const others = present.filter((e) => !e.you).map((e) => e.name);
  const you = present.some((e) => e.you);
  if (others.length === 0) return 'On /live now: just you';
  return `On /live now: ${others.join(', ')}${you ? ', and you' : ''}`;
}

/**
 * Arrivals, departures and the whisper, from successive reads of the row. The first non-empty read
 * never animates (opening the page is not an arrival), and a face back within a minute of leaving
 * (a reload) slides in again but is not announced.
 */
function useArrivals(
  here: HereEntry[],
  wasOnline: (name: string) => boolean,
): {
  shown: Shown[];
  whisper: { name: string; key: number; going: boolean } | null;
} {
  const seen = useRef<Set<string> | null>(null);
  const goneAt = useRef(new Map<string, number>());
  const prev = useRef<HereEntry[]>([]);
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<Shown[]>([]);
  const [whisper, setWhisper] = useState<{ name: string; key: number; going: boolean } | null>(null);

  useEffect(() => {
    const names = new Set(here.map((e) => e.name));
    const now = Date.now();
    const gone = prev.current.filter((e) => !names.has(e.name));
    prev.current = here;
    if (seen.current === null) {
      if (here.length > 0) seen.current = names;
    } else {
      const known = seen.current;
      const fresh = here.filter((e) => !known.has(e.name));
      for (const e of fresh) known.add(e.name);
      for (const e of gone) {
        known.delete(e.name);
        goneAt.current.set(e.name, now);
      }
      if (fresh.length > 0) {
        const ids = fresh.map((e) => e.name);
        setArriving((a) => new Set([...a, ...ids]));
        window.setTimeout(
          () => setArriving((a) => new Set([...a].filter((n) => !ids.includes(n)))),
          ARRIVE_MS,
        );
        const news = fresh.find(
          (e) => !e.you && wasOnline(e.name) && now - (goneAt.current.get(e.name) ?? 0) > REJOIN_MS,
        );
        if (news) setWhisper({ name: news.name, key: now, going: false });
      }
    }
    if (gone.length > 0) {
      setLeaving((l) => [
        ...l.filter((e) => !names.has(e.name) && !gone.some((g) => g.name === e.name)),
        ...gone.map((e) => ({ ...e, leaving: true })),
      ]);
      window.setTimeout(
        () => setLeaving((l) => l.filter((e) => !gone.some((g) => g.name === e.name))),
        LEAVE_MS,
      );
    }
  }, [here]);

  // Held, then faded (`.is-going`, --lc-dur-4), then gone.
  const whisperKey = whisper?.key;
  useEffect(() => {
    if (whisperKey === undefined) return;
    const fade = window.setTimeout(
      () => setWhisper((w) => (w && w.key === whisperKey ? { ...w, going: true } : w)),
      WHISPER_MS - FADE_MS,
    );
    const gone = window.setTimeout(
      () => setWhisper((w) => (w && w.key === whisperKey ? null : w)),
      WHISPER_MS,
    );
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [whisperKey]);

  const shown: Shown[] = [
    ...here.map((e) => (arriving.has(e.name) ? { ...e, arrived: true } : e)),
    // A face that came back while still folding away is simply here again.
    ...leaving.filter((l) => !here.some((e) => e.name === l.name)),
  ];
  return { shown, whisper };
}
