import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { AnswerOutcome } from '../native/answer';
import type { AskEntry } from '../native/asks';
import type { PairingPin } from '../native/pairingPin';
import { plain } from '../native/readable';
import { AskText } from './askText';
import { Button } from './button';
import { Glass } from './glass';
import { tap } from './haptics';
import { Icon } from './icon';
import { Rise, Squish } from './motion';
import { font, radius, space, usePalette } from './theme';

/**
 * A question on the ask screen (ADR 773): the seat's text, why it asks, and its options, each a
 * row to tap; or a typed answer. Never approve or decline. The answer is signed silently once the
 * question key is enrolled, and with Face ID before that (`sendQuestionAnswer`).
 */
export function QuestionCard({
  entry,
  pin,
  onOutcome,
}: {
  entry: AskEntry;
  pin: PairingPin;
  onOutcome: (outcome: AnswerOutcome) => void;
}) {
  const p = usePalette();
  const question = entry.delivery.ask.question!;
  const options = question.options ?? [];
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const context = [
    question.context?.lane ? `Lane ${question.context.lane.slice(0, 10)}` : null,
    question.context?.pr ? `PR #${question.context.pr}` : null,
    question.context?.branch ?? null,
  ].filter(Boolean);

  const send = async (answer: { choice?: number; text?: string }) => {
    if (sending) return;
    setSending(true);
    const { sendQuestionAnswer } = await import('../native/questionKey');
    const outcome = await sendQuestionAnswer({
      pin,
      route: entry.route,
      delivery: entry.delivery,
      answer,
    });
    setSending(false);
    onOutcome(outcome);
  };
  const typed = text.trim();

  return (
    <>
      <Rise index={1}>
        <Glass style={styles.card}>
          <View style={[styles.cardEdge, { backgroundColor: p.teal }]} />
          <View style={styles.chips}>
            <View style={[styles.chip, { backgroundColor: p.raised }]}>
              <Icon name="questionmark.bubble.fill" color={p.muted} size={11} />
              <Text style={[styles.chipText, { color: p.muted }]}>Question</Text>
            </View>
            {question.blocking ? (
              <View style={[styles.chip, { backgroundColor: p.tint }]}>
                <Text style={[styles.chipText, { color: p.accentText }]}>Waiting on you</Text>
              </View>
            ) : null}
          </View>
          <AskText text={question.text} large foldable />
          {question.why ? (
            <View style={[styles.why, { backgroundColor: p.raised }]}>
              <Icon name="lightbulb.fill" color={p.accentText} size={12} />
              <Text style={[styles.body, styles.grow, { color: p.text }]}>
                {plain(question.why)}
              </Text>
            </View>
          ) : null}
          {context.length > 0 ? (
            <Text style={[styles.muted, { color: p.muted }]}>{context.join(' · ')}</Text>
          ) : null}
        </Glass>
      </Rise>

      {options.length > 0 ? (
        <Rise index={2} style={styles.options}>
          {options.map((option, i) => (
            <Squish
              key={`${i}-${option.label}`}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              {...(option.consequence ? { accessibilityHint: option.consequence } : {})}
              onPress={() => {
                tap();
                void send({ choice: i });
              }}
              style={[styles.option, { backgroundColor: p.surface, borderColor: p.border }]}
            >
              <View style={[styles.letter, { backgroundColor: i === 0 ? p.tint : p.raised }]}>
                <Text style={[styles.letterText, { color: i === 0 ? p.accentText : p.muted }]}>
                  {String.fromCharCode(65 + i)}
                </Text>
              </View>
              <View style={styles.optionText}>
                <Text style={[styles.optionLabel, { color: p.text }]}>{option.label}</Text>
                {option.consequence ? (
                  <Text style={[styles.muted, { color: p.muted }]}>{option.consequence}</Text>
                ) : null}
              </View>
              <Icon name="chevron.right" color={p.placeholder} size={14} />
            </Squish>
          ))}
        </Rise>
      ) : null}

      <Rise index={3} style={styles.reply}>
        <Text style={[styles.label, { color: p.muted }]}>
          {options.length > 0 ? 'Or say it in your words' : 'Your answer'}
        </Text>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Type an answer"
          placeholderTextColor={p.placeholder}
          multiline
          maxLength={4000}
          accessibilityLabel="Your answer"
          style={[
            styles.input,
            { color: p.text, borderColor: p.border, backgroundColor: p.surface },
          ]}
        />
        {typed.length > 0 ? (
          <Button
            label={sending ? 'Sending…' : 'Send answer'}
            icon="paperplane"
            onPress={() => void send({ text: typed })}
          />
        ) : null}
      </Rise>
    </>
  );
}

const styles = StyleSheet.create({
  card: { padding: space.lg, paddingTop: space.lg + 3, gap: space.md },
  cardEdge: { position: 'absolute', top: 0, left: 0, right: 0, height: 3 },
  chips: { flexDirection: 'row', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  chipText: { fontSize: 11, fontFamily: font.semibold },
  why: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    borderRadius: radius.sm,
    padding: space.sm + 2,
  },
  grow: { flex: 1 },
  label: { fontSize: 12, fontFamily: font.semibold, paddingHorizontal: space.xs },
  body: { fontFamily: font.regular, fontSize: 14, lineHeight: 20 },
  muted: { fontFamily: font.regular, fontSize: 12, lineHeight: 17 },
  options: { gap: space.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  letter: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  letterText: { fontFamily: font.bold, fontSize: 12 },
  optionText: { flex: 1, gap: 1 },
  optionLabel: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20 },
  reply: { gap: space.sm },
  input: {
    minHeight: 76,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: 'top',
  },
});
