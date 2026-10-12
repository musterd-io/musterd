import type { ReplaySource } from './twitchLiveness';

export const TWITCH_CHANNEL = 'sandrise_ai';
export const TWITCH_URL = `https://www.twitch.tv/${TWITCH_CHANNEL}`;

/**
 * What a dark channel plays instead of Twitch's black offline card.
 *
 * Public ids, hardcoded on purpose (lane 01M32JE1ZP weighed the routes): there is no player
 * parameter meaning "this channel's most recent video", resolving one needs Helix, and this repo
 * holds no Twitch API credential that can read. A public id needs no secret, no build-time network
 * call and no runtime endpoint on a prerendered page.
 *
 * THE COST, measured 2026-10-12: a curated id goes stale SILENTLY. The first collection
 * (`oHDc4g501xg16g`, nick, 2026-09-21) became unavailable and musterd.io showed the still with
 * nothing to say why. So this is a HIGHLIGHT — Twitch deletes past broadcasts after 7–60 days,
 * highlights never — and `replayWhenDark` falls back to the video if a collection never starts
 * (lane 01M4RC8WAA). A collection, when there is one again, goes in `collection` ahead of it.
 *
 * Falsify: open twitch.tv/videos/2898914090 and find it gone, or no longer a highlight.
 */
export const TWITCH_FALLBACK_VIDEO = 'v2898914090';

/** What a dark channel plays, in order — passed to `replayWhenDark`. */
export const TWITCH_REPLAY: ReplaySource = { fallbackVideo: TWITCH_FALLBACK_VIDEO };

/**
 * player.twitch.tv iframe URL. `parent` is Twitch's embed allowlist — the embedding hostname.
 * Muted autoplay is deliberate: browsers permit it, and a muted playing embed still counts as a
 * concurrent Twitch viewer (ADR 302 records the falsifier if that policy changes).
 */
export function twitchEmbedUrl(channel: string, parent: string): string {
  const u = new URL('https://player.twitch.tv/');
  u.searchParams.set('channel', channel);
  u.searchParams.set('parent', parent);
  u.searchParams.set('muted', 'true');
  u.searchParams.set('autoplay', 'true');
  return u.toString();
}
