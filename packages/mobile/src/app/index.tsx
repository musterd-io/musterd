import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, Image, RefreshControl, StyleSheet, Text, View } from 'react-native';
import mark from '../../assets/mark.png';
import type { AskEntry, AsksView } from '../native/asks';
import { heldBody, refusalLine, waitingSubtitle } from '../native/notice';
import { showOffer } from '../native/offer';
import type { PairingPin } from '../native/pairingPin';
import { summary } from '../native/readable';
import { Backdrop, Glass } from '../ui/glass';
import { Icon } from '../ui/icon';
import { Halo, Rise, Squish } from '../ui/motion';
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
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
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
      const { loadAsks, markShown, requestRedelivery } = await import('../native/asks');
      if (redeliver) void requestRedelivery({ pin: current });
      const next = await loadAsks({ pin: current });
      if (!alive.current) return;
      setView(next);
      try {
        const { phoneKeys } = await import('../native/phoneKeys');
        setDiagnostics(refusalLine(phoneKeys.recentRefusals(), Date.now()));
      } catch {
        setDiagnostics(null);
      }
      // Shown to you, so their notifications go; the asks stay here until settled (ADR 772).
      if (focused.current && AppState.currentState === 'active')
        void markShown(next.asks.map((entry) => entry.route.ref));
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
        answers = watchNotificationAnswers(setNote, (route) =>
          router.push({
            pathname: '/ask/[ref]',
            params: {
              ref: route.ref,
              team: route.team,
              binding: route.binding,
              expires_at: String(route.expires_at),
            },
          }),
        );
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
  const asks = paired ? (view?.asks ?? []) : [];
  const team = pin?.team ?? null;
  const headline = !pin
    ? 'Pair this phone'
    : !paired
      ? 'Almost there'
      : asks.length === 0
        ? 'All clear'
        : asks.length === 1
          ? '1 ask needs you'
          : `${asks.length} asks need you`;
  const status: { tone: 'on' | 'wait' | 'off'; text: string } = paired
    ? { tone: 'on', text: `Paired with ${team}` }
    : pin
      ? { tone: 'wait', text: 'Waiting for approval' }
      : { tone: 'off', text: 'Not paired' };
  const dot = { on: p.success, wait: p.accent, off: p.placeholder }[status.tone];

  const header = (
    <View style={styles.header}>
      <Rise>
        <Text style={[styles.greeting, { color: p.muted }]}>{greeting(new Date())}</Text>
        <Text accessibilityRole="header" style={[styles.headline, { color: p.text }]}>
          {headline}
        </Text>
      </Rise>
      <Rise index={1}>
        <View style={[styles.pill, { backgroundColor: p.surface, borderColor: p.border }]}>
          <View style={[styles.pillDot, { backgroundColor: dot }]} />
          <Text style={[styles.pillText, { color: p.text }]}>{status.text}</Text>
        </View>
      </Rise>
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
            They come here as the hour allows. /live has them now.
          </Text>
        </Rise>
      ) : null}
    </View>
  );

  const empty = paired ? (
    <View style={styles.calm}>
      <Rise index={2}>
        <Halo color={p.tint}>
          <Image source={mark} style={styles.mark} accessibilityIgnoresInvertColors />
        </Halo>
      </Rise>
      <Rise index={3}>
        <Text style={[styles.calmText, { color: p.muted }]}>
          New asks land here while you’re away from your desk.
        </Text>
      </Rise>
      <Rise index={4}>
        <Squish
          accessibilityRole="button"
          accessibilityLabel="Check now"
          onPress={() => void refresh(true)}
          style={styles.textButton}
        >
          <Text style={[styles.textButtonText, { color: p.accentText }]}>
            {loading ? 'Checking…' : 'Check now'}
          </Text>
        </Squish>
      </Rise>
    </View>
  ) : (
    <Rise index={2}>
      <Glass style={styles.start}>
        {['Show the code on your computer', 'Scan it here', 'Approve with your passkey'].map(
          (step, i) => (
            <View key={step} style={styles.step}>
              <View style={[styles.stepNumber, { backgroundColor: p.tint }]}>
                <Text style={[styles.stepNumberText, { color: p.accentText }]}>{i + 1}</Text>
              </View>
              <Text style={[styles.stepText, { color: p.text }]}>{step}</Text>
            </View>
          ),
        )}
        <Squish
          accessibilityRole="button"
          accessibilityLabel={pin ? 'Finish pairing' : 'Scan pairing code'}
          onPress={() => router.push('/pair')}
          style={[styles.primary, { backgroundColor: p.accent }]}
        >
          <Icon name="qrcode.viewfinder" color={p.onAccent} size={19} />
          <Text style={[styles.primaryText, { color: p.onAccent }]}>
            {pin ? 'Finish pairing' : 'Scan pairing code'}
          </Text>
        </Squish>
      </Glass>
    </Rise>
  );

  return (
    <View style={[styles.screen, { backgroundColor: p.bg }]}>
      <Backdrop />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        data={asks}
        keyExtractor={(entry) => entry.delivery.ask.id}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={
          diagnostics ? (
            <Text style={[styles.diagnostics, { color: p.placeholder }]}>{diagnostics}</Text>
          ) : undefined
        }
        refreshControl={
          <RefreshControl
            refreshing={loading}
            tintColor={p.accent}
            onRefresh={() => void refresh(true)}
          />
        }
        renderItem={({ item, index }) => (
          <Rise index={index + 2}>
            <AskRow entry={item} />
          </Rise>
        )}
      />
    </View>
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
    : summary(delivery.ask.body, 140);
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
        <Text numberOfLines={3} style={[styles.askText, { color: p.text }]}>
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
  screen: { flex: 1 },
  list: { padding: space.lg, paddingTop: space.md, gap: space.md, paddingBottom: space.xl * 2 },
  header: { gap: space.md, marginBottom: space.sm },
  greeting: { fontFamily: font.medium, fontSize: 15 },
  headline: { fontFamily: font.display, fontSize: 32, lineHeight: 38, letterSpacing: -0.8 },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
  pillDot: { width: 8, height: 8, borderRadius: radius.pill },
  pillText: { fontFamily: font.medium, fontSize: 13 },
  banner: { borderRadius: radius.md, padding: space.lg, gap: space.xs },
  bannerTitle: { fontFamily: font.bold, fontSize: 15 },
  bannerText: { fontFamily: font.regular, fontSize: 15, lineHeight: 21 },
  calm: { alignItems: 'center', gap: space.md, paddingTop: space.xl * 2 },
  mark: { width: 88, height: 88, marginVertical: space.lg },
  calmText: { fontFamily: font.regular, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  textButton: { minHeight: 44, paddingHorizontal: space.lg, justifyContent: 'center' },
  textButtonText: { fontFamily: font.semibold, fontSize: 15 },
  start: { padding: space.lg, gap: space.lg },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumberText: { fontFamily: font.bold, fontSize: 14 },
  stepText: { flex: 1, fontFamily: font.medium, fontSize: 16, lineHeight: 22 },
  primary: {
    flexDirection: 'row',
    gap: space.sm,
    minHeight: 52,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontFamily: font.bold, fontSize: 17 },
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
  askText: { fontSize: 17, lineHeight: 24, fontFamily: font.medium },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  waitingDot: { width: 6, height: 6, borderRadius: radius.pill },
  diagnostics: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: space.lg,
  },
});
