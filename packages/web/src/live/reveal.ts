/**
 * The "reveal this act in the log" request, as a window event — dispatched by the office's
 * speech-bubble click-through, the asks strip and a reply quote; listened for by `Stream`. An event
 * rather than a DOM lookup because the target row may sit above the stream's rendered window: the
 * stream widens its window to mount the row first, then scrolls.
 *
 * Lives apart from `Stream.tsx` (ADR 464 lane 2) so a caller can ask for a reveal without pulling
 * the whole stream into its chunk — the stream is a lazy drawer on `/live` now.
 */
export const REVEAL_EVENT = 'lc:reveal-message';

export function scrollToMessage(id: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: { id } }));
}

/**
 * Reveal once the stream is on the page. The log drawer mounts `Stream` lazily, so a reveal fired
 * on the same click that opened the drawer would land before the listener exists and be lost.
 * Polls a frame at a time for the stream's rows, for at most ~2s, then gives up quietly.
 */
export function revealWhenMounted(id: string, frames = 120) {
  if (typeof window === 'undefined') return;
  const tryOnce = (left: number) => {
    if (document.querySelector('.lc-stream__rows')) {
      scrollToMessage(id);
      return;
    }
    if (left > 0) window.requestAnimationFrame(() => tryOnce(left - 1));
  };
  tryOnce(frames);
}
