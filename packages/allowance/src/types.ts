/** One measured window a provider actually reported. */
export interface Window {
  id: string;
  unit: string;
  used: number;
  limit: number;
  /** Unix ms, or null when the provider did not say when it resets. */
  resetsAt: number | null;
  /**
   * When set, the sentence is a share of this window ("67% left of the 5-hour window")
   * and `used` / `limit` are that share, out of 100.
   */
  label?: string;
}

export interface LiveProvider {
  id: string;
  name: string;
  state: 'live';
  /** Plan word from the provider, such as "starter". Null when they sent none. */
  detail: string | null;
  windows: Window[];
}

export interface HeldProvider {
  id: string;
  name: string;
  state: 'missing' | 'error';
  reason: string;
}

export interface QuietProvider {
  id: string;
  name: string;
  state: 'quiet';
  reason: string;
}

export type ProviderCard = LiveProvider | HeldProvider | QuietProvider;

export interface Board {
  readAt: number;
  timeZone: string;
  /** Account ids the user has turned on, in catalog order. */
  chosen: string[];
  providers: ProviderCard[];
}
