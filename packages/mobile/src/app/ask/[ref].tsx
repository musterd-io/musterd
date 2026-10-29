import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AnswerOutcome } from '../../native/answer';
import type { AskEntry } from '../../native/asks';
import { STALE_TEXT, UNVERIFIED_TEXT, waitingSubtitle } from '../../native/notice';
import { showOffer, type ShownOffer } from '../../native/offer';
import type { PairingPin } from '../../native/pairingPin';
import { Backdrop, Glass } from '../../ui/glass';
import { success, warning } from '../../ui/haptics';
import { Icon } from '../../ui/icon';
import { Breathe, Pop, Rise, Squish } from '../../ui/motion';
import { ago, Seat } from '../../ui/seat';
import { font, radius, space, usePalette } from '../../ui/theme';

/**
 * One ask (ADR 676 decisions 6–8, spec §7). Opening it fetches the ask by ref through the relay,
 * which re-issues it with a fresh token and, for a listed act, fresh descriptors.
 *
 * A listed act is the descriptor screen: fixed fields in the spec's order — the act in the app's
 * own words, who asked, the target, whose authority and where, requested at and expires in — and
 * only below a rule, labelled as theirs, the asker's own words and the lane's title. The phone
 * hashes the payload itself; an offer whose digest does not match is not shown and not signed.
 *
 * An advisory ask shows its text and the two answers. Decline also comes as "I did not expect
 * this", which the daemon records as `channel.answer_reported` and flags on /live.
 */
type Phase =
  | { kind: 'loading' }
  | { kind: 'gone' }
  | { kind: 'unverified' }
  | { kind: 'ready'; entry: AskEntry; offers: { approve: ShownOffer; reject: ShownOffer } | null }
  | { kind: 'sending' }
  | { kind: 'sent' };

function noteFor(outcome: AnswerOutcome): string {
  switch (outcome) {
    case 'sent':
      return 'Sent.';
    case 'unverified':
      return UNVERIFIED_TEXT;
    case 'stale':
      return STALE_TEXT;
    case 'unpaired':
      return 'This phone has not finished pairing, so it cannot sign this. Pair it again.';
    case 'refused':
      return 'This ask cannot be answered from the app.';
    case 'undelivered':
      return 'The answer did not leave this phone. Try again.';
    case 'cancelled':
      return 'Face ID did not confirm the answer.';
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function expiresIn(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((ms - now) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export default function AskScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{
    ref: string;
    team: string;
    binding: string;
    expires_at: string;
  }>();
  const [pin, setPin] = useState<PairingPin | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const { loadPairingPin } = await import('../../native/pairingPin');
      const { fetchAsk } = await import('../../native/asks');
      const current = await loadPairingPin();
      setPin(current);
      const expiresAt = Number(params.expires_at);
      if (
        !current ||
        !params.ref ||
        !params.team ||
        !params.binding ||
        !Number.isFinite(expiresAt)
      ) {
        setPhase({ kind: 'unverified' });
        return;
      }
      const entry = await fetchAsk({
        pin: current,
        route: {
          team: params.team,
          binding: params.binding,
          ref: params.ref,
          expires_at: expiresAt,
        },
      });
      if (!entry) {
        setPhase({ kind: 'gone' });
        return;
      }
      if (!entry.delivery.approval) {
        setPhase({ kind: 'ready', entry, offers: null });
        return;
      }
      const now = Date.now();
      const approve = showOffer(entry.delivery.approval.approve, { team: entry.route.team, now });
      const reject = showOffer(entry.delivery.approval.reject, { team: entry.route.team, now });
      if (!approve || !reject) {
        setPhase({ kind: 'unverified' });
        return;
      }
      setPhase({ kind: 'ready', entry, offers: { approve, reject } });
    } catch {
      setPhase({ kind: 'unverified' });
    }
  }, [params.binding, params.expires_at, params.ref, params.team]);

  useEffect(() => {
    void load();
  }, [load]);

  const answer = async (decision: 'approve' | 'reject', reported: boolean) => {
    if (phase.kind !== 'ready' || !pin) return;
    const { entry, offers } = phase;
    // A descriptor lives five minutes. Past that, fetch fresh ones and show them again: the phone
    // signs only what is on the screen now.
    if (
      offers &&
      Math.min(offers.approve.descriptor.expiry, offers.reject.descriptor.expiry) <= Date.now()
    ) {
      setNote('This had expired, so it was fetched again. Check it, then answer.');
      await load();
      return;
    }
    setNote(null);
    setPhase({ kind: 'sending' });
    const { sendAnswer } = await import('../../native/answer');
    const outcome = await sendAnswer({
      pin,
      route: entry.route,
      delivery: entry.delivery,
      decision,
      reported,
      now: Date.now(),
    });
    if (outcome === 'sent') {
      success();
      setPhase({ kind: 'sent' });
      return;
    }
    setNote(noteFor(outcome));
    // A cancelled Face ID or a failed send keeps the same token live: answer again from here.
    if (outcome === 'cancelled' || outcome === 'undelivered')
      setPhase({ kind: 'ready', entry, offers });
    else setPhase({ kind: 'unverified' });
  };

  if (phase.kind === 'loading' || phase.kind === 'sending') {
    return (
      <View style={[styles.center, { backgroundColor: p.bg }]}>
        <View style={styles.dots}>
          {[0, 1, 2].map((i) => (
            <Breathe key={i} delay={i * 220}>
              <View style={[styles.dot, { backgroundColor: p.accent }]} />
            </Breathe>
          ))}
        </View>
        <Text style={[styles.muted, { color: p.muted }]}>
          {phase.kind === 'loading' ? 'Opening the ask…' : 'Sealing your answer…'}
        </Text>
      </View>
    );
  }
  if (phase.kind === 'sent') {
    return (
      <View style={[styles.center, { backgroundColor: p.bg }]}>
        <Pop style={[styles.done, { backgroundColor: p.accent }]}>
          <Icon name="checkmark" color={p.onAccent} size={34} fallback="✓" bounce />
        </Pop>
        <Rise index={2}>
          <Text style={[styles.title, { color: p.text }]}>Sent</Text>
        </Rise>
        <Rise index={3}>
          <Text style={[styles.centerCopy, { color: p.muted }]}>
            Signed on this phone and sealed for your team. The ask closes once the daemon records
            your answer.
          </Text>
        </Rise>
        <Rise index={4}>
          <Squish
            accessibilityRole="button"
            accessibilityLabel="Back to asks"
            onPress={() => router.back()}
            style={[styles.secondary, { backgroundColor: p.raised }]}
          >
            <Text style={[styles.secondaryText, { color: p.text }]}>Back to asks</Text>
          </Squish>
        </Rise>
      </View>
    );
  }
  if (phase.kind !== 'ready') {
    const gone = phase.kind === 'gone';
    return (
      <View style={[styles.center, { backgroundColor: p.bg }]}>
        <Rise>
          <Text style={[styles.title, { color: p.text }]}>
            {gone ? 'Already settled' : 'Not shown'}
          </Text>
        </Rise>
        <Rise index={1}>
          <Text style={[styles.centerCopy, { color: p.muted }]}>
            {gone
              ? 'This ask is no longer open. It was answered somewhere else, or it expired.'
              : (note ?? UNVERIFIED_TEXT)}
          </Text>
        </Rise>
        <Rise index={2}>
          <Squish
            accessibilityRole="button"
            accessibilityLabel="Back to asks"
            onPress={() => router.back()}
            style={[styles.secondary, { backgroundColor: p.raised }]}
          >
            <Text style={[styles.secondaryText, { color: p.text }]}>Back to asks</Text>
          </Squish>
        </Rise>
      </View>
    );
  }

  const { entry, offers } = phase;
  const { ask } = entry.delivery;
  const now = Date.now();
  const agent = ask.from_kind === 'agent';
  const waiting = waitingSubtitle(entry.delivery.waiting ?? 0);
  const theirs = agent ? 'The agent says' : `${ask.from} says`;

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.page}>
      <Backdrop />
      <Rise style={styles.who}>
        <Seat name={ask.from} agent={agent} size={44} />
        <View style={styles.whoText}>
          <Text style={[styles.from, { color: p.text }]}>{ask.from}</Text>
          <Text style={[styles.muted, { color: p.muted }]}>
            {agent ? 'agent seat' : 'person'} · asked {ago(ask.ts, now)}
          </Text>
        </View>
      </Rise>

      {offers ? (
        <Rise index={1}>
          <Glass style={styles.card}>
            <View style={[styles.cardEdge, { backgroundColor: p.accent }]} />
            <View style={[styles.chip, { backgroundColor: p.tint }]}>
              <Icon name="faceid" color={p.accentText} size={12} />
              <Text style={[styles.chipText, { color: p.accentText }]}>Needs your Face ID</Text>
            </View>
            <Text style={[styles.headline, { color: p.text }]}>
              {offers.approve.wording.headline}
            </Text>
            <View style={styles.fields}>
              <Field label="Asked by" value={agent ? `${ask.from}, an agent seat` : ask.from} />
              <Field label="Target" value={offers.approve.descriptor.target} />
              <Field label="Authority" value={offers.approve.wording.scope} />
              <Field label="If you decline" value={offers.reject.wording.headline} />
              <Field label="Requested" value={clock(ask.ts)} />
              <Field
                label="Expires in"
                value={expiresIn(
                  Math.min(offers.approve.descriptor.expiry, offers.reject.descriptor.expiry),
                  now,
                )}
              />
            </View>
          </Glass>
        </Rise>
      ) : null}

      <Rise index={2} style={styles.theirs}>
        {offers ? (
          <>
            <View style={[styles.rule, { backgroundColor: p.border }]} />
            <Text style={[styles.label, { color: p.muted }]}>{theirs}</Text>
          </>
        ) : null}
        <View style={[styles.quote, { borderColor: offers ? p.border : p.accent }]}>
          <Text style={[offers ? styles.body : styles.bodyLarge, { color: p.text }]}>
            {ask.body}
          </Text>
        </View>
        {entry.delivery.lane ? (
          <Text style={[styles.muted, { color: p.muted }]}>
            Lane title, as its seat wrote it: {entry.delivery.lane.title}
          </Text>
        ) : null}
        {waiting ? <Text style={[styles.muted, { color: p.muted }]}>{waiting}</Text> : null}
      </Rise>

      {note ? (
        <Rise style={[styles.banner, { backgroundColor: p.raised }]}>
          <Text style={[styles.bannerText, { color: p.text }]}>{note}</Text>
        </Rise>
      ) : null}

      <Rise index={3} style={styles.actions}>
        <Squish
          accessibilityRole="button"
          accessibilityLabel={offers ? 'Approve with Face ID' : 'Approve'}
          onPress={() => void answer('approve', false)}
          style={[styles.primary, { backgroundColor: p.accent }]}
        >
          {offers ? <Icon name="faceid" color={p.onAccent} size={19} /> : null}
          <Text style={[styles.primaryText, { color: p.onAccent }]}>
            {offers ? 'Approve with Face ID' : 'Approve'}
          </Text>
        </Squish>
        <Squish
          accessibilityRole="button"
          accessibilityLabel="Decline"
          onPress={() => void answer('reject', false)}
          style={[styles.secondary, { backgroundColor: p.raised }]}
        >
          <Text style={[styles.secondaryText, { color: p.text }]}>Decline</Text>
        </Squish>
        <Squish
          accessibilityRole="button"
          accessibilityLabel="Decline — I did not expect this"
          accessibilityHint={`Records it and flags ${ask.from} on /live. It locks nothing.`}
          onPress={() => {
            warning();
            void answer('reject', true);
          }}
          style={styles.link}
        >
          <Text style={[styles.linkText, { color: p.danger }]}>
            Decline — I did not expect this
          </Text>
          <Text style={[styles.muted, { color: p.muted, textAlign: 'center' }]}>
            Records it and flags {ask.from} on /live. It locks nothing.
          </Text>
        </Squish>
      </Rise>
    </ScrollView>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const p = usePalette();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: p.muted }]}>{label}</Text>
      <Text style={[styles.value, { color: p.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  centerCopy: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 320,
  },
  dots: { flexDirection: 'row', gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  done: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  title: { fontSize: 22, fontFamily: font.bold, textAlign: 'center', letterSpacing: -0.3 },
  page: { padding: space.lg, gap: space.lg, paddingBottom: space.xl * 2 },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  whoText: { flex: 1, gap: 2 },
  from: { fontSize: 17, fontFamily: font.semibold },
  card: { padding: space.lg, paddingTop: space.lg + 4, gap: space.md },
  cardEdge: { position: 'absolute', top: 0, left: 0, right: 0, height: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 3,
  },
  chipText: { fontSize: 12, fontFamily: font.bold },
  headline: { fontSize: 22, lineHeight: 28, fontFamily: font.bold, letterSpacing: -0.3 },
  fields: { gap: space.md },
  field: { gap: 2 },
  label: {
    fontSize: 12,
    fontFamily: font.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  value: { fontFamily: font.regular, fontSize: 15, lineHeight: 21 },
  rule: { height: StyleSheet.hairlineWidth, marginBottom: space.xs },
  theirs: { gap: space.sm },
  quote: { borderLeftWidth: 3, paddingLeft: space.md },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 23 },
  bodyLarge: { fontSize: 20, lineHeight: 28, fontFamily: font.medium },
  muted: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  banner: { borderRadius: radius.md, padding: space.lg },
  bannerText: { fontFamily: font.regular, fontSize: 15, lineHeight: 21 },
  actions: { gap: space.sm, marginTop: space.sm },
  primary: {
    flexDirection: 'row',
    gap: space.sm,
    minHeight: 52,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 17, fontFamily: font.bold },
  secondary: {
    minHeight: 48,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontSize: 17, fontFamily: font.semibold },
  link: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingTop: space.sm,
  },
  linkText: { fontSize: 15, fontFamily: font.semibold },
});
