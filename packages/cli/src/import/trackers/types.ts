import type { LaneStakes } from '@musterd/protocol';

/**
 * What a tracker source hands `musterd import github|linear|jira` (spec 2026-10-11 §2). A source
 * reads; it never writes back (one-way pull). `ref` is the lane's `source_ref` (ADR 561).
 */
export type Tracker = 'github' | 'linear' | 'jira';

export interface TrackerIssue {
  ref: string;
  title: string;
  url: string;
  body?: string;
  /** The tracker's grouping (a GitHub `milestone`, a Linear project or cycle, a Jira `epic`). */
  group?: { key: string; title: string };
  stakes?: LaneStakes;
}

export type UpstreamState = 'open' | 'closed' | 'not_found';

export interface TrackerSource {
  tracker: Tracker;
  /** 'GitHub' — the word the abandon reason uses. */
  label: string;
  /** 'acme/app' | 'ENG' | 'PROJ' — whose refs this source answers for. */
  scope: string;
  ownsRef(ref: string): boolean;
  /** The open issues, in tracker order, at most `limit`. */
  open(limit?: number): Promise<TrackerIssue[]>;
  /** One issue's state now — asked for every board lane whose ref is missing from `open()`. */
  state(ref: string): Promise<UpstreamState>;
}
