import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { AskEntry, AsksView } from '../native/asks';
import { heldBody, refusalLine, waitingSubtitle } from '../native/notice';
import { showOffer } from '../native/offer';
import type { PairingPin } from '../native/pairingPin';
import { summary } from '../native/readable';
import { Button } from '../ui/button';
import { Backdrop, Glass } from '../ui/glass';
import { Icon } from '../ui/icon';
import { Breathe, Rise, Squish } from '../ui/motion';
import { Notice, SectionLabel } from '../ui/notice';
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
  const [outgoing, setOutgoing] = useState(0);
  const [more, setMore] = useState(false);
  const loadingMore = useRef(false);
  // Bumped by every refresh: a page fetched against an older list is dropped, not merged.
  const generation = useRef(0);
  // ADR 774 §5: offer to enroll the question key, once per binding and key, until "Not now".
  const [offerKey, setOfferKey] = useState(false);
  const keyDeclined = useRef(false);
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
      // Answers a dropped relay kept from leaving go first (outbox.ts), and before the re-delivery:
      // re-issuing an ask spends the token a kept answer was signed with, and the daemon then
      // refuses it as consumed after the relay already took it (seen on build 40, 2026-11-01).
      const { flushOutbox } = await import('../native/outbox');
      const stillWaiting = await flushOutbox();
      if (alive.current) setOutgoing(stillWaiting);
      if (redeliver) void requestRedelivery({ pin: current });
      const next = await loadAsks({ pin: current });
      if (!alive.current) return;
      generation.current += 1;
      setView(next);
      try {
        const { needsQuestionKey } = await import('../native/questionKey');
        const needed = await needsQuestionKey(
          current,
          next.asks.map((entry) => entry.delivery),
        );
        if (alive.current) setOfferKey(needed && !keyDeclined.current);
      } catch {
        if (alive.current) setOfferKey(false);
      }
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

  // Lane 01M6H8H9G2: the asks past the first page are fetched when the list nears its end.
  const loadMore = useCallback(async () => {
    if (!view || view.rest.length === 0 || loadingMore.current || !pin?.binding) return;
    loadingMore.current = true;
    const started = generation.current;
    setMore(true);
    try {
      const { loadMoreAsks } = await import('../native/asks');
      const page = await loadMoreAsks({ pin, routes: view.rest });
      if (!alive.current || generation.current !== started) return;
      setView((prev) =>
        prev
          ? {
              ...prev,
              asks: [...prev.asks, ...page.asks].sort(
                (a, b) => b.delivery.ask.ts - a.delivery.ask.ts,
              ),
              unreachable: prev.unreachable + page.unreachable,
              rest: page.rest,
            }
          : prev,
      );
      if (focused.current && AppState.currentState === 'active') {
        const { markShown } = await import('../native/asks');
        void markShown(page.asks.map((entry) => entry.route.ref));
      }
    } catch {
      // A page that failed stays in `rest`; the next scroll tries again.
    } finally {
      loadingMore.current = false;
      if (alive.current) setMore(false);
    }
  }, [view, pin]);

  const turnOnKey = async () => {
    if (!pin?.binding) return;
    const { enrollQuestionKey } = await import('../native/questionKey');
    const outcome = await enrollQuestionKey({ pin });
    if (!alive.current) return;
    if (outcome === 'enrolled') {
      setOfferKey(false);
      setNote('Done. A question now shows its answers on the lock screen.');
    } else if (outcome === 'failed') {
      setNote('Couldn’t turn it on just now. Try again in a minute.');
    }
  };

  // Lane 01M6FJFW66: iOS keeps the pairing in the Keychain after the app is deleted, so this is
  // the way back to the scan screen. Behind a confirm: it destroys this phone's keys.
  const pairAgain = () => {
    Alert.alert(
      'Pair this phone again?',
      `This phone forgets ${pin?.team ?? 'its team'} and its keys. Asks stop reaching it until you scan a new code. Unpair it on /live too.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget and pair again',
          style: 'destructive',
          onPress: () =>
            void (async () => {
              const { forgetPairing } = await import('../native/pairingPin');
              const ok = await forgetPairing();
              if (!alive.current) return;
              setNote(
                ok
                  ? 'Forgotten. Scan a new code from /live to pair.'
                  : 'Couldn’t forget everything. Try again.',
              );
              setView(null);
              await refresh(false);
            })(),
        },
      ],
    );
  };

  const paired = Boolean(pin?.binding);
  const asks = paired ? (view?.asks ?? []) : [];
  const unfetched = paired ? (view?.rest.length ?? 0) : 0;
  const team = pin?.team ?? null;
  const count = unfetched > 0 ? `${asks.length}+` : asks.length;
  const status: { tone: 'on' | 'wait' | 'off'; text: string } = paired
    ? { tone: 'on', text: team ?? 'Paired' }
    : pin
      ? { tone: 'wait', text: 'Waiting for approval' }
      : { tone: 'off', text: 'Not paired' };
  const dot = { on: p.success, wait: p.accent, off: p.placeholder }[status.tone];

  // No headline (nick, 2026-11-03: "No big text, heros, headers"): the wordmark is the title, a row
  // of pills says where this phone stands, and notes are compact cards.
  const header = (
    <View style={styles.header}>
      <Rise style={styles.pills}>
        <View
          accessible
          accessibilityLabel={paired ? `Paired with ${team}` : status.text}
          style={[styles.pill, { backgroundColor: p.surface, borderColor: p.border }]}
        >
          <Breathe>
            <View style={[styles.pillDot, { backgroundColor: dot }]} />
          </Breathe>
          <Text style={[styles.pillText, { color: p.text }]}>{status.text}</Text>
        </View>
        {paired ? (
          // ADR 791: the team's seats and their quick actions.
          <Squish
            accessibilityRole="button"
            accessibilityLabel="Seats"
            accessibilityHint="Start, check or stop your team's agent seats"
            onPress={() => router.push('/seats')}
            style={[styles.pill, { backgroundColor: p.surface, borderColor: p.border }]}
          >
            <Icon name="person.2.fill" color={p.accentText} size={12} />
            <Text style={[styles.pillText, { color: p.accentText }]}>Seats</Text>
            <Icon name="chevron.right" color={p.placeholder} size={10} />
          </Squish>
        ) : null}
      </Rise>
      {note ? (
        <Rise>
          <Notice icon="checkmark.circle.fill" title={note} />
        </Rise>
      ) : null}
      {paired && offerKey ? (
        <Rise>
          <Notice
            icon="faceid"
            tone="warm"
            title="Answer from the lock screen"
            body="Turn it on once with Face ID, then tap an answer right on the notification."
          >
            <View style={styles.actions}>
              <View style={styles.grow}>
                <Button label="Turn on" icon="faceid" onPress={() => void turnOnKey()} />
              </View>
              <Button
                label="Not now"
                kind="quiet"
                onPress={() => {
                  keyDeclined.current = true;
                  setOfferKey(false);
                }}
              />
            </View>
          </Notice>
        </Rise>
      ) : null}
      {outgoing > 0 ? (
        <Rise>
          <Notice
            icon="paperplane.fill"
            tone="warm"
            title={outgoing === 1 ? '1 answer on its way' : `${outgoing} answers on their way`}
            body="Your team hasn’t got it yet. It goes again each time you open the app."
          />
        </Rise>
      ) : null}
      {view && view.unreachable > 0 ? (
        <Rise>
          <Notice
            icon="arrow.clockwise"
            title={
              view.unreachable === 1
                ? '1 ask couldn’t load'
                : `${view.unreachable} asks couldn’t load`
            }
            body="Pull down to try again."
          />
        </Rise>
      ) : null}
      {view?.held ? (
        <Rise>
          <Notice
            icon="moon.zzz.fill"
            tone="warm"
            title={heldBody(view.held.count)}
            body="They come here as the hour allows. /live has them now."
          />
        </Rise>
      ) : null}
      {paired && asks.length > 0 ? <SectionLabel label="Needs you" count={count} /> : null}
    </View>
  );

  // "All clear" only when nothing is waiting anywhere: an ask that couldn't load, or asks held for
  // quiet hours, still need you, and their notice above already says so (big-body's review of lane
  // 01M6HQ4DT4: both cards showed at once).
  const waitingElsewhere = !!view && (view.unreachable > 0 || !!view.held);
  const empty = waitingElsewhere ? undefined : paired ? (
    <Rise index={1}>
      <Glass style={styles.calm}>
        <View style={[styles.calmTile, { backgroundColor: p.tint }]}>
          <Icon name="checkmark.seal.fill" color={p.accentText} size={20} bounce />
        </View>
        <View style={styles.words}>
          <Text style={[styles.calmTitle, { color: p.text }]}>All clear</Text>
          <Text style={[styles.calmText, { color: p.muted }]}>
            New asks land here while you’re away.
          </Text>
        </View>
        <Squish
          accessibilityRole="button"
          accessibilityLabel="Check now"
          onPress={() => void refresh(true)}
          style={[styles.check, { backgroundColor: p.raised }]}
        >
          <Icon name="arrow.clockwise" color={p.text} size={13} />
          <Text style={[styles.checkText, { color: p.text }]}>
            {loading ? 'Checking' : 'Check'}
          </Text>
        </Squish>
      </Glass>
    </Rise>
  ) : (
    <Rise index={1}>
      <Glass style={styles.start}>
        {STEPS.map((step, i) => (
          <View key={step.text} style={styles.step}>
            <View style={styles.stepRail}>
              <View style={[styles.stepTile, { backgroundColor: p.tint }]}>
                <Icon name={step.icon} color={p.accentText} size={15} />
              </View>
              {i < STEPS.length - 1 ? (
                <View style={[styles.stepLine, { backgroundColor: p.border }]} />
              ) : null}
            </View>
            <Text style={[styles.stepText, { color: p.text }]}>{step.text}</Text>
          </View>
        ))}
        <Button
          label={pin ? 'Finish pairing' : 'Scan pairing code'}
          icon="qrcode.viewfinder"
          onPress={() => router.push('/pair')}
        />
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
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={empty}
        ListFooterComponent={
          diagnostics || pin || unfetched > 0 ? (
            <View style={styles.footer}>
              {unfetched > 0 ? (
                <Squish
                  accessibilityRole="button"
                  accessibilityLabel="Show more asks"
                  onPress={() => void loadMore()}
                  style={styles.textButton}
                >
                  <Text style={[styles.textButtonText, { color: p.accentText }]}>
                    {more ? 'Loading…' : 'Show more'}
                  </Text>
                </Squish>
              ) : null}
              {diagnostics ? (
                <Text style={[styles.diagnostics, { color: p.placeholder }]}>{diagnostics}</Text>
              ) : null}
              {pin ? (
                <Squish
                  accessibilityRole="button"
                  accessibilityLabel="Pair this phone again"
                  onPress={pairAgain}
                  style={styles.textButton}
                >
                  <Text style={[styles.textButtonText, { color: p.muted }]}>Pair again</Text>
                </Squish>
              ) : null}
            </View>
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

const STEPS = [
  { icon: 'desktopcomputer', text: 'Show the code on your computer' },
  { icon: 'qrcode.viewfinder', text: 'Scan it here' },
  { icon: 'person.badge.key.fill', text: 'Approve with your passkey' },
] as const;

function AskRow({ entry }: { entry: AskEntry }) {
  const p = usePalette();
  const { delivery, route } = entry;
  const listed = delivery.approval !== undefined;
  const question = delivery.ask.question;
  // A listed act is named by the app's fixed wording; the agent's words wait for the screen.
  const headline = listed
    ? (showOffer(delivery.approval!.approve, { team: route.team, now: Date.now() })?.wording
        .headline ?? 'An ask that needs the app')
    : summary(question?.text ?? delivery.ask.body, 140);
  const waiting = waitingSubtitle(delivery.waiting ?? 0);
  const agent = delivery.ask.from_kind === 'agent';
  return (
    <Squish
      accessibilityRole="button"
      accessibilityLabel={`${listed ? 'Needs Face ID. ' : question ? 'Question. ' : ''}${headline}, from ${delivery.ask.from}`}
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
          <Seat name={delivery.ask.from} agent={agent} size={30} />
          <Text numberOfLines={1} style={styles.rowWho}>
            <Text style={[styles.from, { color: p.text }]}>{delivery.ask.from}</Text>
            <Text style={[styles.meta, { color: p.placeholder }]}>
              {'  '}
              {ago(delivery.ask.ts, Date.now())}
            </Text>
          </Text>
          {listed ? (
            <View style={[styles.chip, { backgroundColor: p.tint }]}>
              <Icon name="faceid" color={p.accentText} size={11} />
              <Text style={[styles.chipText, { color: p.accentText }]}>Face ID</Text>
            </View>
          ) : question ? (
            <View style={[styles.chip, { backgroundColor: p.raised }]}>
              <Icon name="questionmark.bubble.fill" color={p.muted} size={11} />
              <Text style={[styles.chipText, { color: p.muted }]}>Question</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.rowBody}>
          <Text numberOfLines={2} style={[styles.askText, { color: p.text }]}>
            {headline}
          </Text>
          <Icon name="chevron.right" color={p.placeholder} size={12} />
        </View>
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
  footer: { gap: space.sm, alignItems: 'center', marginTop: space.md },
  list: { padding: space.lg, paddingTop: space.sm, gap: space.sm + 2, paddingBottom: space.xl * 2 },
  header: { gap: space.sm + 2, marginBottom: space.xs },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    minHeight: 32,
  },
  pillDot: { width: 7, height: 7, borderRadius: radius.pill },
  pillText: { fontFamily: font.medium, fontSize: 13 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1 },
  words: { flex: 1, gap: 1 },
  calm: { padding: space.md, flexDirection: 'row', alignItems: 'center', gap: space.md },
  calmTile: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calmTitle: { fontFamily: font.semibold, fontSize: 15 },
  calmText: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  check: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 34,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
  },
  checkText: { fontFamily: font.semibold, fontSize: 13 },
  textButton: { minHeight: 44, paddingHorizontal: space.lg, justifyContent: 'center' },
  textButtonText: { fontFamily: font.medium, fontSize: 14 },
  start: { padding: space.lg, gap: space.md },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  stepRail: { alignItems: 'center', width: 30 },
  stepTile: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepLine: { width: 2, height: 14, borderRadius: 1, marginTop: 4 },
  stepText: { flex: 1, fontFamily: font.medium, fontSize: 15, lineHeight: 30 },
  row: { padding: space.md, gap: space.sm },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 },
  rowWho: { flex: 1 },
  from: { fontSize: 14, fontFamily: font.semibold },
  meta: { fontFamily: font.regular, fontSize: 12 },
  rowBody: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  chipText: { fontSize: 11, fontFamily: font.semibold },
  askText: { flex: 1, fontSize: 15, lineHeight: 21, fontFamily: font.medium },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  waitingDot: { width: 6, height: 6, borderRadius: radius.pill },
  diagnostics: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
