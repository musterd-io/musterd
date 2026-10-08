import type { WatchEnd } from '../byName.js';
import type { LocalWake } from '../live.js';
import type { Seat } from '../store.js';
import { pidAlive } from '../yield.js';
import { formatWatchLine } from './events.js';
import type { WatchReader, WatchSnapshot } from './reader.js';
import { watchReaderFor } from './readers.js';

/** One keypress the watch view reads; `null` means the input is gone. */
export interface Keys {
  next(): Promise<'enter' | 'esc' | null>;
  close(): void;
}

export interface WatchDeps {
  /** The harness's reader (default: the registry's, by the wake's harness). */
  reader?: WatchReader;
  alive?: (pid: number) => boolean;
  keys?: Keys;
  out?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  cols?: number;
}

const POLL_MS = 500;
const BACKLOG = 10;

/** Raw-mode keypresses from the terminal: ⏎ → enter, esc or ⌃C → esc, anything else ignored. */
export function ttyKeys(): Keys {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const queue: Array<'enter' | 'esc'> = [];
  let waiting: ((k: 'enter' | 'esc' | null) => void) | null = null;
  let closed = false;
  const onData = (buf: Buffer): void => {
    const k = buf.toString();
    const key =
      k === '\r' || k === '\n' ? 'enter' : k === '\u001b' || k === '\u0003' ? 'esc' : null;
    if (!key) return;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(key);
    } else queue.push(key);
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  return {
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift()!)
        : closed
          ? Promise.resolve(null)
          : new Promise((resolve) => {
              waiting = resolve;
            }),
    close: () => {
      if (closed) return;
      closed = true;
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      waiting?.(null);
    },
  };
}

/**
 * Follow a local wake read-only (ADR 546): its words and tool calls from its transcript, scrubbed,
 * until the person presses ⏎ (take over) or esc (leave), or the wake ends. A wake that ends cleanly
 * opens its conversation straight away; one that ended early asks first.
 */
export async function watchWake(
  wake: LocalWake,
  seat: Seat,
  deps: WatchDeps = {},
): Promise<WatchEnd> {
  const out = deps.out ?? ((s: string) => void process.stderr.write(s));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = deps.alive ?? pidAlive;
  const cols = deps.cols ?? process.stderr.columns ?? 80;
  const reader = deps.reader ?? watchReaderFor(wake.harness);
  if (!reader) {
    out(`can't watch: watching ${wake.harness} wakes is not supported yet\n`);
    return 'leave';
  }
  const snap = (): WatchSnapshot | null => {
    try {
      return reader.snapshot(wake);
    } catch {
      return null; // a transcript that cannot be read this poll is read again on the next one
    }
  };
  const first = snap();
  if (!first) {
    out(`can't watch: no transcript for this wake yet\n`);
    return 'leave';
  }
  const keys = deps.keys ?? ttyKeys();
  try {
    out(`watching ${seat.member}'s wake — ⏎ take over · esc leave\n`);
    let shot = first;
    let consumed = shot.events.length;
    for (const e of shot.events.slice(-BACKLOG)) out(formatWatchLine(e, cols) + '\n');

    // One key request stays outstanding for the whole watch; each turn waits for it or for the next
    // poll. The key goes first in the race so a key that is already there is never lost to a tick.
    const pending = keys.next();
    const turn = async (): Promise<'enter' | 'esc' | null | undefined> =>
      Promise.race([pending, sleep(POLL_MS).then(() => undefined)]);
    for (;;) {
      const key = await turn();
      if (key === 'enter') return 'take-over';
      if (key === 'esc' || key === null) return 'leave';
      shot = snap() ?? shot;
      for (const e of shot.events.slice(consumed)) out(formatWatchLine(e, cols) + '\n');
      consumed = shot.events.length;
      if (alive(wake.pid)) continue;
      if (shot.endedCleanly) {
        out('wake finished — opening its conversation\n');
        return 'finished';
      }
      out('wake ended before finishing\n⏎ open its conversation · esc quit\n');
      for (;;) {
        const answer = await turn();
        if (answer === 'enter') return 'ended';
        if (answer === 'esc' || answer === null) return 'leave';
      }
    }
  } finally {
    if (!deps.keys) keys.close();
  }
}
