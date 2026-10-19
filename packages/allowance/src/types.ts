/** One measured window a provider actually reported. */
export interface Window {
  id: string;
  unit: string;
  used: number;
  limit: number;
  /** Unix ms, or null when the provider did not say when it resets. */
  resetsAt: number | null;
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

export type ActiveProvider = LiveProvider | HeldProvider;

export interface Board {
  readAt: number;
  timeZone: string;
  active: ActiveProvider[];
  quiet: QuietProvider[];
}
