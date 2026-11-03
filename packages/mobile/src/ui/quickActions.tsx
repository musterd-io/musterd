import type { SFSymbol } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { QUICK_ACTION_LABELS } from '../native/notice';
import type { PairingPin } from '../native/pairingPin';
import type { QuickAction, QuickOutcome } from '../native/quickAction';
import { success, warning } from './haptics';
import { Icon } from './icon';
import { Squish } from './motion';
import { font, radius, space, usePalette } from './theme';

const ICONS: Record<QuickAction, SFSymbol> = {
  start: 'play.fill',
  check_inbox: 'tray',
  check_pr: 'arrow.triangle.pull',
  resume: 'arrow.uturn.forward',
  stop: 'stop.fill',
};

type State = 'sending' | QuickOutcome;

/** How long a chip shows Sent or Couldn't send before it is a button again. */
const SETTLE_MS = 4_000;

/**
 * A seat's quick actions (ADR 779/791/792), only those that fit the seat (`seatActions`). One tap,
 * no Face ID once the question key is on (nick, 2026-11-03). A press says Sending…, then Sent or
 * Couldn't send for a few seconds; `onOutcome` lets the screen say more. What the seat did comes
 * back as a quiet notification. `compact`: icon-only, for a seat row.
 */
export function QuickActions({
  pin,
  seat,
  actions,
  compact = false,
  onOutcome,
}: {
  pin: PairingPin;
  seat: string;
  actions: readonly QuickAction[];
  compact?: boolean;
  onOutcome?: (action: QuickAction, outcome: QuickOutcome) => void;
}) {
  const p = usePalette();
  const [state, setState] = useState<Partial<Record<QuickAction, State>>>({});
  const timers = useRef(new Map<QuickAction, ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const press = async (action: QuickAction) => {
    if (state[action] === 'sending') return;
    clearTimeout(timers.current.get(action));
    setState((s) => ({ ...s, [action]: 'sending' }));
    let outcome: QuickOutcome;
    try {
      const { sendQuickAction } = await import('../native/quickAction');
      outcome = await sendQuickAction({ pin, seat, action });
    } catch {
      outcome = 'failed';
    }
    if (outcome === 'sent') success();
    else if (outcome === 'failed') warning();
    onOutcome?.(action, outcome);
    setState((s) => ({ ...s, [action]: outcome === 'cancelled' ? undefined : outcome }));
    timers.current.set(
      action,
      setTimeout(() => setState((s) => ({ ...s, [action]: undefined })), SETTLE_MS),
    );
  };

  return (
    <View style={[styles.row, compact && styles.compactRow]}>
      {actions.map((action) => {
        const label = QUICK_ACTION_LABELS[action];
        const at = state[action];
        const sent = at === 'sent';
        const failed = at === 'failed' || at === 'unpaired';
        const fg = sent ? p.accentText : failed || action === 'stop' ? p.danger : p.text;
        const icon: SFSymbol = sent
          ? 'checkmark'
          : failed
            ? 'exclamationmark.triangle'
            : at === 'sending'
              ? 'ellipsis'
              : ICONS[action];
        const shown =
          at === 'sending' ? 'Sending…' : sent ? 'Sent' : failed ? 'Couldn’t send' : label;
        return (
          <Squish
            key={action}
            accessibilityRole="button"
            accessibilityLabel={`${label} ${seat}`}
            accessibilityState={{ busy: at === 'sending' }}
            {...(at && at !== 'sending' ? { accessibilityValue: { text: shown } } : {})}
            hitSlop={compact ? 4 : 0}
            onPress={() => void press(action)}
            style={[
              compact ? styles.dot : styles.chip,
              { backgroundColor: sent ? p.tint : p.raised },
            ]}
          >
            <Icon name={icon} color={fg} size={compact ? 15 : 13} />
            {compact ? null : <Text style={[styles.text, { color: fg }]}>{shown}</Text>}
          </Squish>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  compactRow: { flexWrap: 'nowrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  dot: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { fontFamily: font.semibold, fontSize: 14 },
});
