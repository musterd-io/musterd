import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { QUICK_ACTION_LABELS, seatActions } from '../native/notice';
import type { PairingPin } from '../native/pairingPin';
import type { QuickAction, QuickOutcome, Roster, RosterSeat } from '../native/quickAction';
import { Backdrop, Glass } from '../ui/glass';
import { Rise } from '../ui/motion';
import { QuickActions } from '../ui/quickActions';
import { Seat } from '../ui/seat';
import { font, radius, space, usePalette } from '../ui/theme';

/**
 * The team's agent seats and their quick actions (ADR 791). The roster is pulled from the daemon
 * each time this screen comes forward, on a pull, and when a delivery lands while it is open (a
 * quick action's result is one). A seat's lane title is the seat's own text, so it is labelled
 * as theirs.
 */
export default function SeatsScreen() {
  const p = usePalette();
  const [pin, setPin] = useState<PairingPin | null>(null);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [miss, setMiss] = useState<'gone' | 'unreachable' | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { loadPairingPin } = await import('../native/pairingPin');
      const current = await loadPairingPin();
      if (!alive.current) return;
      setPin(current);
      if (!current?.binding) return;
      const { fetchRoster } = await import('../native/quickAction');
      const got = await fetchRoster({ pin: current });
      if (!alive.current) return;
      if ('miss' in got) setMiss(got.miss);
      else {
        setMiss(null);
        setRoster((prev) => (prev && prev.ts > got.ts ? prev : got));
      }
    } catch {
      if (alive.current) setMiss('unreachable');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let deliveries: { remove(): void } | undefined;
    void (async () => {
      try {
        const { phoneKeys } = await import('../native/phoneKeys');
        if (alive.current) deliveries = phoneKeys.addListener('onDelivery', () => void load());
      } catch {
        // Expo Go has no native module.
      }
    })();
    return () => {
      alive.current = false;
      deliveries?.remove();
    };
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const seats = roster?.seats ?? [];
  const online = seats.filter((s) => s.online).length;

  return (
    <View style={[styles.screen, { backgroundColor: p.bg }]}>
      <Backdrop />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        data={pin?.binding ? seats : []}
        keyExtractor={(s) => s.seat}
        ListHeaderComponent={
          <View style={styles.header}>
            <Rise>
              <Text accessibilityRole="header" style={[styles.headline, { color: p.muted }]}>
                {roster ? `${online} of ${seats.length} online` : 'Seats'}
              </Text>
            </Rise>
            {miss && !loading ? (
              <Rise style={[styles.banner, { backgroundColor: p.raised }]}>
                <Text style={[styles.bannerText, { color: p.text }]}>
                  {miss === 'unreachable'
                    ? 'Couldn’t reach your team. Pull down to try again.'
                    : 'Your team didn’t send its seats. Pull down to try again.'}
                </Text>
              </Rise>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !loading && roster ? (
            <Text style={[styles.empty, { color: p.muted }]}>This team has no agent seats.</Text>
          ) : undefined
        }
        refreshControl={
          <RefreshControl refreshing={loading} tintColor={p.accent} onRefresh={() => void load()} />
        }
        renderItem={({ item, index }) =>
          pin ? (
            <Rise index={index + 1}>
              <SeatCard pin={pin} seat={item} />
            </Rise>
          ) : null
        }
      />
    </View>
  );
}

function SeatCard({ pin, seat }: { pin: PairingPin; seat: RosterSeat }) {
  const p = usePalette();
  const actions = seatActions(seat);
  // After a press, the line under the name says what happened, then goes back to the lane.
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const clear = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(clear.current), []);
  const onOutcome = (action: QuickAction, outcome: QuickOutcome) => {
    if (outcome === 'cancelled') return;
    const label = QUICK_ACTION_LABELS[action];
    setSaid(
      outcome === 'sent'
        ? { text: `${label} sent`, bad: false }
        : { text: `${label} didn’t send. Check your connection.`, bad: true },
    );
    clearTimeout(clear.current);
    clear.current = setTimeout(() => setSaid(null), 6_000);
  };
  const state = seat.online ? 'online' : seat.wakeable ? 'asleep' : 'offline';
  const line =
    said?.text ?? seat.lane?.title ?? (actions.length === 0 ? 'Can’t be woken from here' : null);
  return (
    <Glass style={styles.card}>
      <View>
        <Seat name={seat.seat} agent size={32} />
        <View
          style={[
            styles.dot,
            { backgroundColor: seat.online ? p.success : p.placeholder, borderColor: p.surface },
          ]}
        />
      </View>
      <View style={styles.who}>
        <Text numberOfLines={1} style={[styles.name, { color: p.text }]}>
          {seat.seat}
          <Text style={[styles.meta, { color: p.muted }]}>{`  ${state}`}</Text>
        </Text>
        {line ? (
          <Text
            numberOfLines={1}
            accessibilityLabel={said || !seat.lane ? line : `Their lane: ${line}`}
            style={[styles.meta, { color: said?.bad ? p.danger : said ? p.accentText : p.muted }]}
          >
            {line}
          </Text>
        ) : null}
      </View>
      {actions.length > 0 ? (
        <QuickActions pin={pin} seat={seat.seat} actions={actions} compact onOutcome={onOutcome} />
      ) : null}
    </Glass>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { padding: space.lg, paddingTop: space.md, gap: space.sm, paddingBottom: space.xl * 2 },
  header: { gap: space.md, marginBottom: space.sm },
  headline: { fontFamily: font.semibold, fontSize: 13, letterSpacing: 0.2 },
  banner: { borderRadius: radius.md, padding: space.lg },
  bannerText: { fontFamily: font.regular, fontSize: 15, lineHeight: 21 },
  empty: { fontFamily: font.regular, fontSize: 15, textAlign: 'center', marginTop: space.xl },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
  },
  who: { flex: 1, gap: 1 },
  name: { fontFamily: font.semibold, fontSize: 15 },
  dot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 11,
    height: 11,
    borderRadius: radius.pill,
    borderWidth: 2,
  },
  meta: { fontFamily: font.regular, fontSize: 13 },
});
