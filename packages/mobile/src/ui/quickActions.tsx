import type { SFSymbol } from 'expo-symbols';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { QUICK_ACTION_LABELS, QUICK_ACTION_ORDER } from '../native/notice';
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

/**
 * A seat's quick actions (ADR 779/791/792): Start, Check inbox, Check PR, Resume and Stop, each one
 * tap. No Face ID once the question key is on (nick, 2026-11-03). The chip says it was sent; what
 * the seat did comes back as a quiet notification.
 */
export function QuickActions({ pin, seat }: { pin: PairingPin; seat: string }) {
  const p = usePalette();
  const [state, setState] = useState<Partial<Record<QuickAction, State>>>({});

  const press = async (action: QuickAction) => {
    if (state[action] === 'sending') return;
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
    setState((s) => ({ ...s, [action]: outcome === 'cancelled' ? undefined : outcome }));
  };

  return (
    <View style={styles.row}>
      {QUICK_ACTION_ORDER.map((action) => {
        const label = QUICK_ACTION_LABELS[action];
        const at = state[action];
        const shown =
          at === 'sending'
            ? 'Sending…'
            : at === 'sent'
              ? 'Sent'
              : at === 'failed'
                ? 'Try again'
                : label;
        const stop = action === 'stop';
        const fg = at === 'failed' || stop ? p.danger : p.text;
        return (
          <Squish
            key={action}
            accessibilityRole="button"
            accessibilityLabel={`${label} ${seat}`}
            accessibilityState={{ busy: at === 'sending' }}
            {...(at === 'sent' ? { accessibilityValue: { text: 'sent' } } : {})}
            onPress={() => void press(action)}
            style={[
              styles.chip,
              { backgroundColor: at === 'sent' ? p.tint : p.raised, borderColor: p.border },
            ]}
          >
            <Icon
              name={at === 'sent' ? 'checkmark' : ICONS[action]}
              color={at === 'sent' ? p.accentText : fg}
              size={13}
            />
            <Text style={[styles.text, { color: at === 'sent' ? p.accentText : fg }]}>{shown}</Text>
          </Squish>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { fontFamily: font.semibold, fontSize: 14 },
});
