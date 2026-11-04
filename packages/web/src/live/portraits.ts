import { useSyncExternalStore } from 'react';

/**
 * Members' faces as the rendered office draws them (lane 01M6017Z38, nick 2026-10-28: the team panel
 * still showed the old hand-drawn faces). The office scene paints a head-and-shoulders crop of each
 * member's figure once its sheets have loaded and publishes it here; `MemberFace` reads it and keeps
 * its vector face until one arrives. This module is the only thing the eager /live graph carries: the
 * figure sheets and the painter stay in the office's lazy chunk.
 */

const portraits = new Map<string, string>();
const listeners = new Set<() => void>();
const painted = new Set<(name: string, url: string) => void>();

/** Publish (or replace) a member's portrait, as an image URL. */
export function setPortrait(name: string, url: string): void {
  if (portraits.get(name) === url) return;
  portraits.set(name, url);
  for (const l of listeners) l();
  for (const l of painted) l(name, url);
}

/** Every portrait held now, then each new one as it is painted (ADR 797: /live hands them on). */
export function onPortrait(listener: (name: string, url: string) => void): () => void {
  painted.add(listener);
  for (const [name, url] of portraits) listener(name, url);
  return () => painted.delete(listener);
}

export function portraitOf(name: string): string | undefined {
  return portraits.get(name);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The member's rendered portrait, or undefined until the office has painted one. */
export function usePortrait(name: string): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => portraits.get(name),
    () => undefined,
  );
}
