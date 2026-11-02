import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SETTLED_MS } from './askPhrase';
import {
  applyTierClock,
  askIsLoud,
  deriveAsks,
  resurrectRefusedVerdicts,
  type AskView,
  type AudienceContext,
} from './asks';
import type { LiveConfig } from './client';
import { deriveQuestions, type QuestionCard } from './questions';
import { stillMode } from './stillMode';
import { useRecoveredAsks } from './useRecoveredAsks';

/** The ask derivation every surface on the page reads: one pipeline, one clock, one local fold. */
export interface AskViews {
  /** Who "you" are for audience purposes: the signed-in seat, else the seat one click would make you. */
  ctx: AudienceContext;
  /** Answerable iff the connected seat is a real member (observers are hidden from the roster). */
  canAnswer: boolean;
  /** Every ask, with the tier clock applied and refused human verdicts re-offered. */
  asks: AskView[];
  /** The timeline-only derivation, before the clock — what `settledAt` is read from. */
  derived: AskView[];
  /** The seats' open questions to the reader (ADR 773), oldest first; rows on the rail. */
  questions: QuestionCard[];
  /** The one instant the countdowns and the tier verdicts are read at. */
  now: number;
  /** Fold an answer this browser just sent, so its ask settles before the firehose copy lands. */
  addLocal: (ack: Envelope) => void;
}

/**
 * The asks rail's derivation, lifted out of `AsksStrip` (lane 01M6DBDSGH) so the (since retired) "Waiting on you"
 * list reads the same asks the rail does — same recovered history, same clock, same local answers —
 * instead of each deriving its own and disagreeing about what waits on the reader. `live.tsx` calls
 * it once and hands the result to both; a surface rendered alone (tests, previews) calls it itself.
 *
 * `enabled: false` skips the recovery fetch (the caller is handing views in and must not fetch twice).
 */
export function useAskViews({
  cfg,
  roster,
  board,
  envelopes,
  localIdentity = null,
  loading = false,
  enabled = true,
}: {
  cfg: LiveConfig | null;
  roster: MemberSummary[];
  board: LaneBoard | null;
  envelopes: Envelope[];
  localIdentity?: string | null;
  loading?: boolean;
  enabled?: boolean;
}): AskViews {
  const [localAnswers, setLocalAnswers] = useState<Envelope[]>([]);
  const addLocal = useCallback((ack: Envelope) => setLocalAnswers((prev) => [...prev, ack]), []);
  const [now, setNow] = useState(() => Date.now());
  const canAnswer = cfg != null && roster.some((m) => m.name === cfg.as);
  /**
   * Who "you" are (lane 01KZ9GFHZ9): the signed-in seat, else the seat one click would make you.
   * Routing is judged against that identity — an ask routed to an AGENT must never render under
   * "sign in to answer" copy.
   */
  const ctx: AudienceContext = useMemo(
    () => ({
      you: canAnswer && cfg ? cfg.as : localIdentity,
      humans: new Set(roster.filter((m) => m.kind === 'human').map((m) => m.name)),
    }),
    [canAnswer, cfg, localIdentity, roster],
  );
  // Review asks older than the backfill window, fetched by date (lane 01M5G10DB2).
  const recovered = useRecoveredAsks(cfg, board, envelopes, ctx.humans, enabled && !loading);
  const derived = useMemo(
    () => deriveAsks([...recovered, ...envelopes, ...localAnswers]),
    [recovered, envelopes, localAnswers],
  );
  // A refused human verdict must not settle its ask (lane 01M5EA60RD). Applied after the tier
  // clock so a long-refused ask is not instantly lapsed back out.
  const asks = useMemo(
    () => resurrectRefusedVerdicts(applyTierClock(derived, now), board?.lanes ?? [], ctx.humans),
    [derived, board, ctx.humans, now],
  );
  const questions = useMemo(
    () => (cfg ? deriveQuestions([...envelopes, ...localAnswers], cfg.as, now, board) : []),
    [cfg, envelopes, localAnswers, now, board],
  );
  const loudCount = asks.filter((a) => askIsLoud(a.state)).length + questions.length;
  // A 1s tick while any clock is running, so the countdowns are honest; off when nothing is loud
  // (idle cost is paid by every viewer, forever). Held under `?still` (ADR 285). Keeps ticking
  // through a settle (lane 01M511XNQC) so "nick approved ✓" gets its few seconds.
  const still = stillMode();
  const settling = derived.some(
    (a) => a.settledAt !== undefined && (a.settledAt > now || now - a.settledAt <= SETTLED_MS),
  );
  useEffect(() => {
    if ((loudCount === 0 && !settling) || still) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [loudCount, settling, still]);
  return { ctx, canAnswer, asks, derived, questions, now, addLocal };
}
