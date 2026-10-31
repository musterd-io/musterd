import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AnswerOutcome } from '../../native/answer';
import type { AskEntry } from '../../native/asks';
import { STALE_TEXT, UNVERIFIED_TEXT, waitingSubtitle } from '../../native/notice';
import { showOffer, type ShownOffer } from '../../native/offer';
import type { PairingPin } from '../../native/pairingPin';
import { plain } from '../../native/readable';
import { AskText } from '../../ui/askText';
import { Button } from '../../ui/button';
import { Backdrop, Glass } from '../../ui/glass';
import { success, warning } from '../../ui/haptics';
import { Icon } from '../../ui/icon';
import { Moment } from '../../ui/moment';
import { Rise, Squish } from '../../ui/motion';
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
  | { kind: 'unreachable' }
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
      return 'This phone hasn’t finished pairing, so it can’t sign this. Pair it again.';
    case 'refused':
      return 'This ask cannot be answered from the app.';
    case 'undelivered':
      return 'Your answer hasn’t reached your team yet. musterd keeps sending it each time it opens.';
    case 'cancelled':
      return 'Face ID didn’t confirm. Nothing was sent.';
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
      const { fetchAskOrMiss, clearSettled } = await import('../../native/asks');
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
      const route = {
        team: params.team,
        binding: params.binding,
        ref: params.ref,
        expires_at: expiresAt,
      };
      // A first fetch after the app wakes can miss a sleeping daemon (the relay's 503/504): try
      // once more before saying anything, and never call an unreachable ask settled.
      let entry = await fetchAskOrMiss({ pin: current, route });
      if ('miss' in entry && entry.miss === 'unreachable') {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        entry = await fetchAskOrMiss({ pin: current, route });
      }
      if ('miss' in entry) {
        if (entry.miss === 'gone') void clearSettled([route.ref]);
        setPhase({ kind: entry.miss });
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
      setNote('It had expired, so here it is fresh. Check it, then answer.');
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
      // Answered: the ask is settled, so its notifications go too.
      const { clearSettled } = await import('../../native/asks');
      void clearSettled([entry.route.ref]);
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

  if (phase.kind === 'loading') return <Moment title="Opening the ask…" />;
  if (phase.kind === 'sending') return <Moment title="Sealing your answer…" />;
  if (phase.kind === 'sent') {
    return (
      <Moment
        icon="checkmark"
        tone="done"
        title="Sent"
        copy="Signed here and sealed for your team. It closes when the daemon records it."
      >
        <Button label="Back to asks" kind="secondary" onPress={() => router.back()} />
      </Moment>
    );
  }
  if (phase.kind === 'gone') {
    return (
      <Moment
        icon="checkmark.circle"
        title="Already settled"
        copy="Answered somewhere else, or it expired."
      >
        <Button label="Back to asks" kind="secondary" onPress={() => router.back()} />
      </Moment>
    );
  }
  if (phase.kind === 'unreachable') {
    return (
      <Moment
        icon="wifi.exclamationmark"
        title="Couldn’t reach your team"
        copy="It may still be open. Check your connection."
      >
        <Button label="Try again" icon="arrow.clockwise" onPress={() => void load()} />
        <Button label="Back to asks" kind="secondary" onPress={() => router.back()} />
      </Moment>
    );
  }
  if (phase.kind === 'unverified') {
    return (
      <Moment icon="eye.slash" title="Not shown" copy={note ?? UNVERIFIED_TEXT}>
        <Button label="Back to asks" kind="secondary" onPress={() => router.back()} />
      </Moment>
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
          <AskText text={ask.body} large={!offers} foldable={!offers} />
        </View>
        {entry.delivery.lane ? (
          <Text numberOfLines={2} style={[styles.muted, { color: p.muted }]}>
            Lane, as its seat named it: {plain(entry.delivery.lane.title)}
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
        <Button
          label={offers ? 'Approve with Face ID' : 'Approve'}
          {...(offers ? { icon: 'faceid' as const } : {})}
          onPress={() => void answer('approve', false)}
        />
        <Button label="Decline" kind="secondary" onPress={() => void answer('reject', false)} />
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
            Flags {ask.from} on /live. It locks nothing.
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
  muted: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  banner: { borderRadius: radius.md, padding: space.lg },
  bannerText: { fontFamily: font.regular, fontSize: 15, lineHeight: 21 },
  actions: { gap: space.sm, marginTop: space.sm },
  link: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingTop: space.sm,
  },
  linkText: { fontSize: 15, fontFamily: font.semibold },
});
