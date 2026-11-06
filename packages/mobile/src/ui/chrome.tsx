import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

/**
 * The shell's chrome (the tab pill) fades and slides away as a list scrolls down, and comes back
 * on a scroll up or a tab switch — movetrail's `FloatingChrome`. One shared value, read on the UI
 * thread by the pill, written from any screen's `onScroll`. A screen that does not scroll never
 * hides it.
 */
interface Chrome {
  visible: SharedValue<number>;
  /** Pass to a list's `onScroll` (with `scrollEventThrottle={16}`). */
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** Bring the chrome back now: a tab press, or a screen with no scroll of its own. */
  reveal: () => void;
}

const ChromeContext = createContext<Chrome | null>(null);

/** How far a scroll must travel before the chrome moves, so a bounce does not flicker it. */
const SLACK = 12;
const FADE_MS = 200;

export function ChromeProvider({ children }: { children: ReactNode }) {
  const visible = useSharedValue(1);
  const last = useSharedValue(0);
  const reveal = useCallback(() => {
    visible.value = withTiming(1, { duration: FADE_MS });
  }, [visible]);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      const delta = y - last.value;
      if (y <= 0) {
        last.value = 0;
        visible.value = withTiming(1, { duration: FADE_MS });
        return;
      }
      if (Math.abs(delta) < SLACK) return;
      last.value = y;
      visible.value = withTiming(delta > 0 ? 0 : 1, { duration: FADE_MS });
    },
    [last, visible],
  );
  const value = useMemo(() => ({ visible, onScroll, reveal }), [visible, onScroll, reveal]);
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

/** The chrome, for the pill and for any screen that scrolls. Outside the provider: always shown. */
export function useChrome(): Chrome {
  const ctx = useContext(ChromeContext);
  const fallback = useSharedValue(1);
  return (
    ctx ?? {
      visible: fallback,
      onScroll: () => undefined,
      reveal: () => undefined,
    }
  );
}
