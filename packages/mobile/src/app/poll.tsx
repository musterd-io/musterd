import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { PairingPin } from '../native/pairingPin';
import type { AppPollState, PollSpec } from '../native/poll';
import { Button } from '../ui/button';
import { Backdrop, Glass } from '../ui/glass';
import { Rise } from '../ui/motion';
import { NAV_HEIGHT } from '../ui/nav';
import { Notice, SectionLabel } from '../ui/notice';
import { font, radius, space, usePalette } from '../ui/theme';

/**
 * A Twitch poll from the phone (ADR 807 §5). Start one while the stream is live — Face ID signs the
 * exact question, options and time limit — watch its count, end it early or cancel it. The poll's
 * state rides the roster, which the daemon sends only to an admin's phone; the outcome of a press
 * is pulled by its nonce.
 */

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MIN_MINUTES = 1;
const MAX_MINUTES = 15;

/** The spec the daemon will parse, or the first thing wrong. */
export function draftSpec(
  question: string,
  options: readonly string[],
  minutes: number,
): { ok: true; spec: PollSpec } | { ok: false; problem: string } {
  const q = question.trim();
  const opts = options.map((o) => o.trim()).filter((o) => o !== '');
  if (!q) return { ok: false, problem: 'Ask a question.' };
  if (q.length > 200) return { ok: false, problem: 'Keep the question under 200 characters.' };
  if (opts.length < MIN_OPTIONS) return { ok: false, problem: 'Give at least 2 options.' };
  if (opts.some((o) => o.length > 80))
    return { ok: false, problem: 'Keep each option under 80 characters.' };
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length)
    return { ok: false, problem: 'Two options say the same thing.' };
  return { ok: true, spec: { question: q, options: opts, minutes } };
}

/** `m:ss`, never negative. */
const left = (closesAt: number, now: number) => {
  const s = Math.max(0, Math.ceil((closesAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function PollScreen() {
  const p = usePalette();
  const [pin, setPin] = useState<PairingPin | null>(null);
  const [poll, setPoll] = useState<AppPollState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [minutes, setMinutes] = useState(5);
  const [now, setNow] = useState(Date.now());
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
      if (alive.current && !('miss' in got)) setPoll(got.poll ?? null);
    } catch {
      // Unreachable: keep what is on screen; a pull tries again.
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      alive.current = false;
      clearInterval(tick);
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /** Send, then pull the daemon's answer and show the poll as it stands after it. */
  const run = async (
    send: () => Promise<{ sent: true; nonce: string } | { sent: false; why: string }>,
    done: string,
  ) => {
    if (!pin) return;
    setBusy(true);
    setSaid(null);
    try {
      const mod = await import('../native/poll');
      const out = await send();
      if (!out.sent) {
        if (out.why !== 'cancelled') setSaid({ text: 'That didn’t send. Try again.', bad: true });
        return;
      }
      const result = await mod.fetchPollResult({ pin, nonce: out.nonce });
      if (!alive.current) return;
      if (!result) {
        setSaid({ text: 'Sent — your team hasn’t answered yet. Pull to refresh.', bad: false });
        return;
      }
      setPoll(result.poll);
      setSaid(
        result.ok
          ? { text: done, bad: false }
          : { text: mod.pollReasonText(result.reason), bad: true },
      );
      if (result.ok && result.op === 'open') {
        setQuestion('');
        setOptions(['', '']);
      }
    } catch {
      setSaid({ text: 'That didn’t send. Try again.', bad: true });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const check = draftSpec(question, options, minutes);
  const open = poll?.open ?? null;
  const live = poll?.live === true;

  return (
    <View style={[styles.screen, { backgroundColor: p.bg }]}>
      <Backdrop />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={loading}
            tintColor={p.accent}
            progressViewOffset={NAV_HEIGHT}
            onRefresh={() => void load()}
          />
        }
      >
        {!loading && pin?.binding && poll === null ? (
          <Rise>
            <Notice
              icon="chart.bar"
              title="Polls are for team admins"
              body="Your team didn’t send a poll to this phone."
            />
          </Rise>
        ) : null}

        {poll ? <SectionLabel label="Twitch poll" count={live ? 'live' : 'not live'} /> : null}

        {open ? (
          <Rise>
            <Glass style={styles.card}>
              <Text style={[styles.q, { color: p.text }]}>{open.question}</Text>
              {open.options.map((o, i) => {
                const c = open.counts[i] ?? 0;
                const pct = open.voters > 0 ? Math.round((c / open.voters) * 100) : 0;
                return (
                  <View key={i} style={styles.row}>
                    <Text style={[styles.n, { color: p.muted }]}>{i + 1}</Text>
                    <Text numberOfLines={2} style={[styles.opt, { color: p.text }]}>
                      {o}
                    </Text>
                    <Text style={[styles.pct, { color: p.muted }]}>{`${c} · ${pct}%`}</Text>
                  </View>
                );
              })}
              <Text style={[styles.meta, { color: p.muted }]}>
                {`${open.voters} ${open.voters === 1 ? 'vote' : 'votes'} · ${left(open.closes_at, now)} left`}
              </Text>
              {open.post_failed ? (
                <Text style={[styles.meta, { color: p.danger }]}>
                  musterdbot couldn’t post in chat — votes still count.
                </Text>
              ) : null}
              <View style={styles.acts}>
                <Button
                  label="End now"
                  icon="stop.circle"
                  onPress={() =>
                    void run(
                      async () =>
                        (await import('../native/poll')).sendPollClose({
                          pin: pin!,
                          pollId: open.id,
                          how: 'end',
                        }),
                      'Poll ended.',
                    )
                  }
                  hint="Closes it with the votes so far"
                />
                <Button
                  label="Cancel"
                  kind="secondary"
                  onPress={() =>
                    void run(
                      async () =>
                        (await import('../native/poll')).sendPollClose({
                          pin: pin!,
                          pollId: open.id,
                          how: 'cancel',
                        }),
                      'Poll cancelled.',
                    )
                  }
                  hint="Closes it with no winner"
                />
              </View>
            </Glass>
          </Rise>
        ) : poll ? (
          <Rise>
            <Glass style={styles.card}>
              <TextInput
                value={question}
                onChangeText={setQuestion}
                placeholder="What should we work on next?"
                placeholderTextColor={p.placeholder}
                maxLength={200}
                accessibilityLabel="Question"
                style={[
                  styles.input,
                  { color: p.text, borderColor: p.border, backgroundColor: p.surface },
                ]}
              />
              {options.map((o, i) => (
                <View key={i} style={styles.optRow}>
                  <TextInput
                    value={o}
                    onChangeText={(v) => setOptions(options.map((x, j) => (j === i ? v : x)))}
                    placeholder={`Option ${i + 1}`}
                    placeholderTextColor={p.placeholder}
                    maxLength={80}
                    accessibilityLabel={`Option ${i + 1}`}
                    style={[
                      styles.input,
                      styles.flex,
                      { color: p.text, borderColor: p.border, backgroundColor: p.surface },
                    ]}
                  />
                  {options.length > MIN_OPTIONS ? (
                    <Button
                      label="Remove"
                      kind="quiet"
                      onPress={() => setOptions(options.filter((_, j) => j !== i))}
                    />
                  ) : null}
                </View>
              ))}
              <View style={styles.acts}>
                {options.length < MAX_OPTIONS ? (
                  <Button
                    label="Add option"
                    kind="quiet"
                    icon="plus"
                    onPress={() => setOptions([...options, ''])}
                  />
                ) : null}
                <View style={styles.mins}>
                  <Button
                    label="−"
                    kind="secondary"
                    onPress={() => setMinutes(Math.max(MIN_MINUTES, minutes - 1))}
                    hint="One minute shorter"
                  />
                  <Text style={[styles.minsText, { color: p.text }]}>{`${minutes} min`}</Text>
                  <Button
                    label="+"
                    kind="secondary"
                    onPress={() => setMinutes(Math.min(MAX_MINUTES, minutes + 1))}
                    hint="One minute longer"
                  />
                </View>
              </View>
              <Button
                label={busy ? 'Starting…' : 'Start poll'}
                icon="faceid"
                onPress={() => {
                  if (!live || !check.ok || busy || !pin) return;
                  const spec = check.spec;
                  void run(
                    async () => (await import('../native/poll')).sendPollOpen({ pin, spec }),
                    'Poll started — musterdbot is posting it in chat.',
                  );
                }}
                hint="Face ID signs it"
              />
              <Text style={[styles.meta, { color: p.muted }]}>
                {!live
                  ? 'Polls open while you’re live on Twitch.'
                  : !check.ok
                    ? check.problem
                    : 'Face ID signs it. musterdbot posts it in chat.'}
              </Text>
            </Glass>
          </Rise>
        ) : null}

        {said ? (
          <Text style={[styles.meta, { color: said.bad ? p.danger : p.accentText }]}>
            {said.text}
          </Text>
        ) : null}

        {poll?.last && !open ? (
          <Text style={[styles.meta, { color: p.muted }]}>
            {`Last poll: ${poll.last.question} — ${lastOutcome(poll.last)}`}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function lastOutcome(r: NonNullable<AppPollState['last']>): string {
  const pick = (i: number) => `${i + 1} · ${r.options[i]}`;
  if (r.end === 'cancelled') return 'cancelled';
  if (r.end === 'interrupted') return 'ended when the stream dropped';
  if (r.winners.length === 0) return 'no votes';
  if (r.winners.length > 1) return `a tie, ${r.winners.map(pick).join(' and ')}`;
  return pick(r.winners[0]!);
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: {
    padding: space.lg,
    paddingTop: NAV_HEIGHT + space.md,
    gap: space.sm,
    paddingBottom: space.xl * 2,
  },
  card: { paddingVertical: space.md, paddingHorizontal: space.md, gap: space.sm },
  q: { fontFamily: font.semibold, fontSize: 16, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  n: { fontFamily: font.medium, fontSize: 13, width: 14 },
  opt: { flex: 1, fontFamily: font.regular, fontSize: 15 },
  pct: { fontFamily: font.medium, fontSize: 13, fontVariant: ['tabular-nums'] },
  meta: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  acts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  optRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  flex: { flex: 1 },
  input: {
    minHeight: 40,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    fontFamily: font.regular,
    fontSize: 15,
  },
  mins: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginLeft: 'auto' },
  minsText: { fontFamily: font.medium, fontSize: 15, minWidth: 48, textAlign: 'center' },
});
