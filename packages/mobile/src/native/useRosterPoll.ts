import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { PairingPin } from './pairingPin';
import { nextPollDelay, ROSTER_POLL_MS } from './rosterPoll';

/**
 * Pull the roster on focus, on every delivery, and on the cadence above while the screen is
 * focused and the app is active. `load` is the screen's own loader; this only decides when.
 */
export function useRosterPoll(input: {
  pin: PairingPin | null;
  load: () => Promise<void>;
  intervalMs?: number;
}): void {
  const { pin, load } = input;
  const intervalMs = input.intervalMs ?? ROSTER_POLL_MS;
  const focused = useRef(false);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const pull = useCallback(async () => {
    lastAt.current = Date.now();
    await load();
  }, [load]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    const delay = nextPollDelay(
      {
        focused: focused.current,
        appActive: AppState.currentState === 'active',
        lastAt: lastAt.current,
      },
      Date.now(),
      intervalMs,
    );
    if (delay === null) return;
    timer.current = setTimeout(() => {
      void pull().finally(schedule);
    }, delay);
  }, [intervalMs, pull]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void pull().finally(schedule);
      return () => {
        focused.current = false;
        clearTimeout(timer.current);
      };
    }, [pull, schedule]),
  );

  useEffect(() => {
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') void pull().finally(schedule);
      else clearTimeout(timer.current);
    });
    let deliveries: { remove(): void } | undefined;
    void (async () => {
      try {
        const { phoneKeys } = await import('./phoneKeys');
        deliveries = phoneKeys.addListener('onDelivery', () => void pull().finally(schedule));
      } catch {
        // Expo Go has no native module.
      }
    })();
    return () => {
      app.remove();
      deliveries?.remove();
      clearTimeout(timer.current);
    };
  }, [pin, pull, schedule]);
}
