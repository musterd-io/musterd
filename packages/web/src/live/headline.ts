/**
 * The verb tag a walker wears while a purposeful walk is in flight (ADR 464 §3.2), present tense
 * because the walk is happening now: "handing off → dolly" · "asking for help" · "redirecting izzo".
 *
 * This file used to hold `headline()` too — one line per notable act for the ticker under the room,
 * built from names and lane titles, never the body. The ticker was retired on 2026-10-12 (nick never
 * looked at it) and the headline builders went with it; the caption (`captions.ts`) is the sentence
 * about a moment the room still says.
 */
export function walkTag(
  kind: 'handoff' | 'help' | 'steer' | 'claim' | 'pin' | 'submit' | 'deliver',
  to: string | null,
): string {
  switch (kind) {
    case 'deliver':
      // `to` is the acceptor: the submitted lane's card is on its way to their desk.
      return to ? `submitting → ${to}` : 'submitting a lane';
    case 'pin':
      // `to` is the lane's title: what they are carrying back to the board as finished.
      return to ? `finished ${to}` : 'finished a lane';
    case 'submit':
      return to ? `submitting ${to}` : 'submitting a lane';
    case 'claim':
      // `to` is the lane's title here: what they are on their way to pick up.
      return to ? `claiming ${to}` : 'claiming a lane';
    case 'handoff':
      return to ? `handing off → ${to}` : 'handing off';
    case 'help':
      return 'asking for help';
    case 'steer':
      return to ? `redirecting ${to}` : 'redirecting';
  }
}
