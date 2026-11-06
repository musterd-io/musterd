import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AsksView } from '../../native/asks';
import { heldBody, refusalLine } from '../../native/notice';
import { endedNote, type PairingEnded } from '../../native/pairingEnded';
import type { PairingPin } from '../../native/pairingPin';
import type { Roster } from '../../native/quickAction';
import { summary } from '../../native/readable';
import {
  forYouCount,
  portraitOf,
  summaryLine,
  teamRows,
  type AppMember,
  type OwnAsk,
} from '../../native/team';
import { useRosterPoll } from '../../native/useRosterPoll';
import { Button } from '../../ui/button';
import { useChrome } from '../../ui/chrome';
import { ForYouRow } from '../../ui/forYouRow';
import { Backdrop, Glass } from '../../ui/glass';
import { Icon } from '../../ui/icon';
import { MemberRow } from '../../ui/memberRow';
import { MemberSheet } from '../../ui/memberSheet';
import { Breathe, Rise, Squish } from '../../ui/motion';
import { Notice, SectionLabel } from '../../ui/notice';
import { OfflineFold } from '../../ui/offlineFold';
import { confirmPairAgain } from '../../ui/pairAgain';
import { GLIDE } from '../../ui/springs';
import { font, radius, space, usePalette } from '../../ui/theme';

/**
 * The asks list (ADR 676 decisions 7–9). Every open ask addressed to you that reached this phone,
 * newest first, each re-fetched through the relay so the daemon says what is still open. On open
 * the app asks the daemon to re-deliver its pending set; those arrive as notifications and refresh
 * the list. A listed act shows the app's own wording for it, never the agent's, and how many more
 * wait behind it. While this phone has no binding, the screen links to pairing instead.
 */
export default function AsksScreen() {
  const p = usePalette();
  // ADR 814: this is a tab under the pill, with no NavBar over it — it pads for the status bar
  // itself and leaves room under the pill; scrolling down tucks the pill away.
  const insets = useSafeAreaInsets();
  const { onScroll } = useChrome();
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
  // ADR 802: the daemon says this phone's pairing ended (a key rotation, or unpaired on /live).
  const [ended, setEnded] = useState<PairingEnded | null>(null);
  // ADR 814: the team as /live shows it, pulled with the asks and on the Now cadence.
  const [roster, setRoster] = useState<Roster | null>(null);
  const [showOffline, setShowOffline] = useState(false);
  const [sheet, setSheet] = useState<AppMember | null>(null);
  const keyDeclined = useRef(false);
  const alive = useRef(true);
  // Every list refresh re-fetches each ask, which re-issues its token and spends the old one. The
  // ask screen holds a token of its own, so nothing refreshes while it is in front.
  const focused = useRef(false);

  const refresh = useCallback(async (redeliver: boolean) => {
    if (!focused.current) return;
    setLoading(true);
    try {
      const { loadPairingPin } = await import('../../native/pairingPin');
      const current = await loadPairingPin();
      if (!alive.current) return;
      setPin(current);
      if (!current?.binding) {
        setView(null);
        return;
      }
      try {
        const { checkPairing } = await import('../../native/quickAction');
        const verdict = await checkPairing({ pin: current });
        if (alive.current) setEnded(verdict);
      } catch {
        if (alive.current) setEnded(null);
      }
      const { loadAsks, markShown, requestRedelivery } = await import('../../native/asks');
      // Answers a dropped relay kept from leaving go first (outbox.ts), and before the re-delivery:
      // re-issuing an ask spends the token a kept answer was signed with, and the daemon then
      // refuses it as consumed after the relay already took it (seen on build 40, 2026-11-01).
      const { flushOutbox } = await import('../../native/outbox');
      const stillWaiting = await flushOutbox();
      if (alive.current) setOutgoing(stillWaiting);
      if (redeliver) void requestRedelivery({ pin: current });
      const next = await loadAsks({ pin: current });
      if (!alive.current) return;
      generation.current += 1;
      setView(next);
      try {
        const { needsQuestionKey } = await import('../../native/questionKey');
        const needed = await needsQuestionKey(
          current,
          next.asks.map((entry) => entry.delivery),
        );
        if (alive.current) setOfferKey(needed && !keyDeclined.current);
      } catch {
        if (alive.current) setOfferKey(false);
      }
      try {
        const { phoneKeys } = await import('../../native/phoneKeys');
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

  const loadRoster = useCallback(async () => {
    try {
      const { loadPairingPin } = await import('../../native/pairingPin');
      const current = await loadPairingPin();
      if (!alive.current || !current?.binding) return;
      const { fetchRoster } = await import('../../native/quickAction');
      const got = await fetchRoster({ pin: current });
      if (!alive.current || 'miss' in got) return;
      setRoster((prev) => (prev && prev.ts > got.ts ? prev : got));
    } catch {
      // Expo Go has no native module; the asks list still shows.
    }
  }, []);
  useRosterPoll({ pin: pin ?? null, load: loadRoster });

  useEffect(() => {
    alive.current = true;
    let answers: { remove(): void } | undefined;
    let deliveries: { remove(): void } | undefined;
    void (async () => {
      try {
        // Dynamic: Expo Go has no native module, and the import throws there.
        const { watchNotificationAnswers } = await import('../../native/notificationAnswers');
        const { phoneKeys } = await import('../../native/phoneKeys');
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
      const { loadMoreAsks } = await import('../../native/asks');
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
        const { markShown } = await import('../../native/asks');
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
    const { enrollQuestionKey } = await import('../../native/questionKey');
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
  const pairAgain = () =>
    confirmPairAgain(pin?.team ?? null, (ok) => {
      if (!alive.current) return;
      setNote(
        ok
          ? 'Forgotten. Scan a new code from /live to pair.'
          : 'Couldn’t forget everything. Try again.',
      );
      setView(null);
      setEnded(null);
      void refresh(false);
    });

  const paired = Boolean(pin?.binding);
  const asks = paired ? (view?.asks ?? []) : [];
  const unfetched = paired ? (view?.rest.length ?? 0) : 0;
  const team = pin?.team ?? null;
  const now = Date.now();
  const own: OwnAsk[] = asks.map((entry) => ({
    id: entry.delivery.ask.id,
    from: entry.delivery.ask.from,
    ts: entry.delivery.ask.ts,
    summary: summary(entry.delivery.ask.body),
  }));
  const rows = teamRows(paired ? roster : null, paired ? own : [], null);
  const askByRef = new Map(asks.map((entry) => [entry.delivery.ask.id, entry] as const));
  const status: { tone: 'on' | 'wait' | 'off'; text: string } = paired
    ? { tone: 'on', text: team ?? 'Paired' }
    : pin
      ? { tone: 'wait', text: 'Waiting for approval' }
      : { tone: 'off', text: 'Not paired' };
  const dot = { on: p.success, wait: p.accent, off: p.placeholder }[status.tone];

  // An ask that couldn't load, or asks held for quiet hours, still need you: their notice says so.
  const waitingElsewhere = !!ended || (!!view && (view.unreachable > 0 || !!view.held));
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
          <Text style={[styles.summary, { color: p.muted }]}>{summaryLine(rows.counts)}</Text>
        ) : null}
      </Rise>
      {paired && ended ? (
        <Rise>
          <Notice icon="link.badge.plus" tone="alert" {...endedNote(ended)}>
            <Button label="Pair again" icon="qrcode.viewfinder" onPress={pairAgain} />
          </Notice>
        </Rise>
      ) : null}
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
      {paired && roster?.poll?.open ? (
        // ADR 807: an open Twitch poll rides the roster for an admin's phone; one line, not a card.
        <Squish
          accessibilityRole="button"
          accessibilityLabel={`Open the poll: ${roster.poll.open.question}`}
          onPress={() => router.push('/poll')}
          style={[styles.pollLine, { backgroundColor: p.tint }]}
        >
          <Icon name="chart.bar" color={p.accentText} size={13} />
          <Text numberOfLines={1} style={[styles.pollText, { color: p.accentText }]}>
            {roster.poll.open.question}
          </Text>
          <Text style={[styles.pollLive, { color: p.muted }]}>
            {roster.poll.live ? 'live' : 'not live'}
          </Text>
        </Squish>
      ) : null}
      {paired && rows.forYou.length > 0 ? (
        <SectionLabel label="For you" count={forYouCount(rows)} />
      ) : null}
      {paired && pin
        ? rows.forYou.map((item) => {
            const entry = askByRef.get(item.id);
            return (
              <ForYouRow
                key={item.id}
                item={item}
                now={now}
                pin={pin}
                portrait={portraitOf(rows, item.from)}
                onPress={() =>
                  entry
                    ? router.push({
                        pathname: '/ask/[ref]',
                        params: {
                          ref: entry.route.ref,
                          team: entry.route.team,
                          binding: entry.route.binding,
                          expires_at: String(entry.route.expires_at),
                        },
                      })
                    : void refresh(true)
                }
              />
            );
          })
        : null}
      {paired && rows.forYou.length === 0 && !waitingElsewhere ? (
        <Text style={[styles.quiet, { color: p.placeholder }]}>Nothing waiting on you.</Text>
      ) : null}
      {paired && (rows.present.length > 0 || rows.offline.length > 0) ? (
        <SectionLabel label="Team" count={`${rows.counts.here} here`} />
      ) : null}
    </View>
  );

  // The unpaired start: the three steps and the way into pairing. Paired, the list is the team.
  const empty = paired ? undefined : (
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
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={[styles.list, { paddingTop: insets.top + space.md }]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        data={paired ? rows.present : []}
        keyExtractor={(m) => m.name}
        ListHeaderComponent={header}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={empty}
        ItemSeparatorComponent={() => (
          <View style={[styles.hairline, { backgroundColor: p.border }]} />
        )}
        ListFooterComponent={
          <View>
            {paired && pin ? (
              <OfflineFold
                members={rows.offline}
                pin={pin}
                open={showOffline}
                onToggle={() => setShowOffline((o) => !o)}
              >
                {rows.offline.map((m) => (
                  <MemberRow key={m.name} member={m} pin={pin} now={now} onPress={setSheet} />
                ))}
              </OfflineFold>
            ) : null}
            {diagnostics || pin || unfetched > 0 ? (
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
            ) : null}
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={loading}
            tintColor={p.accent}
            progressViewOffset={insets.top}
            onRefresh={() => {
              void refresh(true);
              void loadRoster();
            }}
          />
        }
        renderItem={({ item }) =>
          pin ? (
            // A re-sort glides the row to its new place: eased, no overshoot (nick, build 61).
            <Animated.View
              layout={LinearTransition.duration(GLIDE.duration).easing(Easing.out(Easing.cubic))}
            >
              <MemberRow member={item} pin={pin} now={now} onPress={setSheet} />
            </Animated.View>
          ) : null
        }
      />
      {pin ? (
        <MemberSheet member={sheet} pin={pin} now={now} onClose={() => setSheet(null)} />
      ) : null}
    </View>
  );
}

const STEPS = [
  { icon: 'desktopcomputer', text: 'Show the code on your computer' },
  { icon: 'qrcode.viewfinder', text: 'Scan it here' },
  { icon: 'person.badge.key.fill', text: 'Approve with your passkey' },
] as const;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  footer: { gap: space.sm, alignItems: 'center', marginTop: space.md },
  list: {
    padding: space.lg,
    gap: space.sm + 2,
    paddingBottom: space.xl * 4,
  },
  header: { gap: space.sm + 2, marginBottom: space.xs },
  summary: { fontFamily: font.medium, fontSize: 12, marginTop: -2 },
  pollLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: 36,
  },
  pollText: { flex: 1, fontFamily: font.semibold, fontSize: 12.5 },
  pollLive: { fontFamily: font.regular, fontSize: 11 },
  quiet: { fontFamily: font.regular, fontSize: 12.5, paddingVertical: 4 },
  hairline: { height: StyleSheet.hairlineWidth, marginLeft: 34 + space.sm + 2 },
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
