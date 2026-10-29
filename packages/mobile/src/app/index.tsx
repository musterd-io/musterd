import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, Image, RefreshControl, StyleSheet, Text, View } from 'react-native';
import mark from '../../assets/mark.png';
import type { AskEntry, AsksView } from '../native/asks';
import { heldBody, waitingSubtitle } from '../native/notice';
import { showOffer } from '../native/offer';
import type { PairingPin } from '../native/pairingPin';
import { Backdrop, Glass } from '../ui/glass';
import { Icon } from '../ui/icon';
import { Breathe, Halo, Rise, Squish } from '../ui/motion';
import { ago, Seat } from '../ui/seat';
import { font, radius, space, usePalette } from '../ui/theme';

/**
 * The asks list (ADR 676 decisions 7–9). Every open ask addressed to you that reached this phone,
 * newest first, each re-fetched through the relay so the daemon says what is still open. On open
 * the app asks the daemon to re-deliver its pending set; those arrive as notifications and refresh
 * the list. A listed act shows the app's own wording for it, never the agent's, and how many more
 * wait behind it. While this phone has no binding, the screen links to pairing instead.
 */
export default function AsksScreen() {
  const p = usePalette();
  const [note, setNote] = useState<string | null>(null);
  const [pin, setPin] = useState<PairingPin | null | undefined>(undefined);
  const [view, setView] = useState<AsksView | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  // Every list refresh re-fetches each ask, which re-issues its token and spends the old one. The
  // ask screen holds a token of its own, so nothing refreshes while it is in front.
  const focused = useRef(false);

  const refresh = useCallback(async (redeliver: boolean) => {
    if (!focused.current) return;
    setLoading(true);
    try {
      const { loadPairingPin } = await import('../native/pairingPin');
      const current = await loadPairingPin();
      if (!alive.current) return;
      setPin(current);
      if (!current?.binding) {
        setView(null);
        return;
      }
      const { loadAsks, requestRedelivery } = await import('../native/asks');
      if (redeliver) void requestRedelivery({ pin: current });
      const next = await loadAsks({ pin: current });
      if (alive.current) setView(next);
    } catch {
      // Expo Go has no native module; the shell still opens and links to pairing.
      if (alive.current) setPin(null);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let answers: { remove(): void } | undefined;
    let deliveries: { remove(): void } | undefined;
    void (async () => {
      try {
        // Dynamic: Expo Go has no native module, and the import throws there.
        const { watchNotificationAnswers } = await import('../native/notificationAnswers');
        const { phoneKeys } = await import('../native/phoneKeys');
        if (!alive.current) return;
        answers = watchNotificationAnswers(setNote);
        deliveries = phoneKeys.addListener('onDelivery', () => void refresh(false));
      } catch {
        // The shell still opens. A dev build or TestFlight has the module.
      }
    })();
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh(true);
    });
    return () => {
      alive.current = false;
      answers?.remove();
      deliveries?.remove();
      foreground.remove();
    };
  }, [refresh]);

  // On first focus and on coming back from an ask: re-deliver the first time, refresh after.
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void refresh(first.current);
      first.current = false;
      return () => {
        focused.current = false;
      };
    }, [refresh]),
  );

  const paired = Boolean(pin?.binding);
  const asks = view?.asks ?? [];
  const pairLabel = paired ? null : pin ? 'Finish pairing' : 'Pair this phone';

  const banners = (
    <>
      {note ? (
        <Rise style={[styles.banner, { backgroundColor: p.raised }]}>
          <Text style={[styles.bannerText, { color: p.text }]}>{note}</Text>
        </Rise>
      ) : null}
      {view?.held ? (
        <Rise style={[styles.banner, { backgroundColor: p.tint }]}>
          <Text style={[styles.bannerTitle, { color: p.accentText }]}>
            {heldBody(view.held.count)}
          </Text>
          <Text style={[styles.bannerText, { color: p.text }]}>
            To keep things calm, they reach this phone as the hour allows. /live has them now.
          </Text>
        </Rise>
      ) : null}
    </>
  );

  if (!paired || asks.length === 0) {
    return (
      <View style={[styles.empty, { backgroundColor: p.bg }]}>
        <Backdrop />
        {banners}
        <Rise>
          <Halo color={p.tint}>
            <Image source={mark} style={styles.mark} accessibilityIgnoresInvertColors />
          </Halo>
        </Rise>
        <View style={styles.rollCall} accessible={false}>
          <Breathe>
            <View style={[styles.rollDot, { backgroundColor: p.success }]} />
          </Breathe>
          <Breathe delay={300}>
            <View style={[styles.rollDot, { backgroundColor: p.accent }]} />
          </Breathe>
          <Breathe delay={600}>
            <View style={[styles.rollDot, { backgroundColor: p.teal }]} />
          </Breathe>
        </View>
        <Rise index={1}>
          <Text style={[styles.title, { color: p.text }]}>
            {paired ? 'You’re all caught up' : 'No asks yet'}
          </Text>
        </Rise>
        <Rise index={2}>
          <Text style={[styles.copy, { color: p.muted }]}>
            {paired
              ? `While you’re away from your computer, asks from ${pin?.team ?? 'your team'} land here — sealed so only this phone can read them, and answered with Face ID. At your desk, they stay on the computer; change that in /live under Settings, You, Away channels.`
              : 'Asks addressed to you arrive on this phone — sealed so only this phone can read them — and are answered with Face ID.'}
          </Text>
        </Rise>
        <Rise index={3}>
          {pairLabel ? (
            <Squish
              accessibilityRole="button"
              accessibilityLabel={pairLabel}
              onPress={() => router.push('/pair')}
              style={[styles.primary, { backgroundColor: p.accent }]}
            >
              <Icon name="qrcode.viewfinder" color={p.onAccent} size={19} />
              <Text style={[styles.primaryText, { color: p.onAccent }]}>{pairLabel}</Text>
            </Squish>
          ) : (
            <Squish
              accessibilityRole="button"
              accessibilityLabel="Check again"
              onPress={() => void refresh(true)}
              style={[styles.quiet, { backgroundColor: p.raised }]}
            >
              <Text style={[styles.quietText, { color: p.text }]}>
                {loading ? 'Checking…' : 'Check again'}
              </Text>
            </Squish>
          )}
        </Rise>
      </View>
    );
  }

  return (
    <FlatList
      style={{ backgroundColor: p.bg }}
      contentContainerStyle={styles.list}
      data={asks}
      keyExtractor={(entry) => entry.delivery.ask.id}
      ListHeaderComponent={
        <View style={styles.header}>
          <Backdrop />
          <Rise>
            <Text style={[styles.greeting, { color: p.muted }]}>{greeting(new Date())}</Text>
            <Text style={[styles.count, { color: p.text }]}>
              {asks.length === 1 ? '1 ask needs you' : `${asks.length} asks need you`}
            </Text>
          </Rise>
          {banners}
        </View>
      }
      refreshControl={
        <RefreshControl
          refreshing={loading}
          tintColor={p.accent}
          onRefresh={() => void refresh(true)}
        />
      }
      renderItem={({ item, index }) => (
        <Rise index={index + 1}>
          <AskRow entry={item} />
        </Rise>
      )}
    />
  );
}

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function AskRow({ entry }: { entry: AskEntry }) {
  const p = usePalette();
  const { delivery, route } = entry;
  const listed = delivery.approval !== undefined;
  // A listed act is named by the app's fixed wording; the agent's words wait for the screen.
  const headline = listed
    ? (showOffer(delivery.approval!.approve, { team: route.team, now: Date.now() })?.wording
        .headline ?? 'An ask that needs the app')
    : delivery.ask.body;
  const waiting = waitingSubtitle(delivery.waiting ?? 0);
  const agent = delivery.ask.from_kind === 'agent';
  return (
    <Squish
      accessibilityRole="button"
      accessibilityLabel={`${listed ? 'Needs Face ID. ' : ''}${headline}, from ${delivery.ask.from}`}
      onPress={() =>
        router.push({
          pathname: '/ask/[ref]',
          params: {
            ref: route.ref,
            team: route.team,
            binding: route.binding,
            expires_at: String(route.expires_at),
          },
        })
      }
    >
      <Glass style={styles.row}>
        <View style={styles.rowTop}>
          <Seat name={delivery.ask.from} agent={agent} />
          <View style={styles.rowWho}>
            <Text style={[styles.from, { color: p.text }]}>{delivery.ask.from}</Text>
            <Text style={[styles.meta, { color: p.muted }]}>
              {agent ? 'agent' : 'person'} · {ago(delivery.ask.ts, Date.now())}
            </Text>
          </View>
          {listed ? (
            <View style={[styles.chip, { backgroundColor: p.tint }]}>
              <Icon name="faceid" color={p.accentText} size={12} />
              <Text style={[styles.chipText, { color: p.accentText }]}>Face ID</Text>
            </View>
          ) : null}
        </View>
        <Text numberOfLines={3} style={[styles.headline, { color: p.text }]}>
          {headline}
        </Text>
        {waiting ? (
          <View style={styles.waitingRow}>
            <View style={[styles.waitingDot, { backgroundColor: p.accent }]} />
            <Text style={[styles.meta, { color: p.muted }]}>{waiting}</Text>
          </View>
        ) : null}
      </Glass>
    </Squish>
  );
}

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  mark: { width: 88, height: 88, marginVertical: space.lg },
  rollCall: { flexDirection: 'row', gap: space.sm, marginBottom: space.sm },
  rollDot: { width: 8, height: 8, borderRadius: radius.pill },
  title: { fontSize: 22, fontFamily: font.bold, textAlign: 'center', letterSpacing: -0.3 },
  copy: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 320,
  },
  banner: { borderRadius: radius.md, padding: space.lg, gap: space.xs, alignSelf: 'stretch' },
  bannerTitle: { fontSize: 15, fontFamily: font.bold },
  bannerText: { fontFamily: font.regular, fontSize: 15, lineHeight: 21 },
  primary: {
    flexDirection: 'row',
    gap: space.sm,
    minHeight: 50,
    marginTop: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 17, fontFamily: font.bold },
  quiet: {
    minHeight: 44,
    marginTop: space.sm,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quietText: { fontSize: 15, fontFamily: font.semibold },
  list: { padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 },
  header: { gap: space.md, marginBottom: space.xs },
  greeting: { fontSize: 15, fontFamily: font.medium },
  count: { fontSize: 28, fontFamily: font.bold, letterSpacing: -0.5 },
  row: { padding: space.lg, gap: space.md },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowWho: { flex: 1, gap: 1 },
  from: { fontSize: 15, fontFamily: font.semibold },
  meta: { fontFamily: font.regular, fontSize: 13 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 3,
  },
  chipText: { fontSize: 12, fontFamily: font.bold },
  headline: { fontSize: 17, lineHeight: 24, fontFamily: font.medium },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  waitingDot: { width: 6, height: 6, borderRadius: radius.pill },
});
