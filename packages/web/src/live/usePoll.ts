import { useEffect, useState } from 'react';
import type { OpenPollReply } from '@musterd/protocol/wire';
import { apiGet, type LiveConfig } from './client';
import { pollView, type PollView } from './poll';

/** How often /broadcast reads the poll: often enough that the bars move with the chat. */
const READ_MS = 2_000;

/**
 * The poll card's view (ADR 807, lane 01M6ME5BFQ): reads `GET /polls/open` every 2 s and ticks a
 * one-second clock only while there is something on screen. The read never asks for the poll's
 * token (`?token=1` is the stream machine's), so it mints nothing on the shared broadcast seat.
 */
export function usePoll(cfg: LiveConfig | null): PollView | null {
  const [reply, setReply] = useState<OpenPollReply | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!cfg) return;
    let alive = true;
    const read = () =>
      apiGet<OpenPollReply>(cfg, `/teams/${encodeURIComponent(cfg.team)}/polls/open`)
        .then((r) => {
          if (!alive) return;
          setReply(r);
          setNow(Date.now());
        })
        // An unreachable daemon keeps what is on screen; the next read decides.
        .catch(() => {});
    void read();
    const id = setInterval(read, READ_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cfg]);

  const view = pollView(reply, now);
  const showing = view !== null;
  useEffect(() => {
    if (!showing) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [showing]);

  return view;
}
