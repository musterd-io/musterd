import type { AppMoment } from '@musterd/protocol/app-channel';
import { StyleSheet, Text, View } from 'react-native';
import { momentWords } from '../native/floor';
import type { PairingPin } from '../native/pairingPin';
import { Icon } from './icon';
import { usePortrait } from './memberRow';
import { Squish } from './motion';
import { ago, Seat } from './seat';
import { font, space, usePalette } from './theme';

/**
 * One moment under the floor (ADR 819): a landing or a finished goal is a full row — the member's
 * portrait, who and what, the lane or the outcome, its goal, the age, and a seal when a peer
 * accepted it; everything else is one quiet line. Tapping opens the member's sheet.
 */
export function MomentRow({
  moment,
  agent,
  portrait,
  pin,
  now,
  onPress,
}: {
  moment: AppMoment;
  /** Whether the member is an agent (their letter's colour until the portrait loads). */
  agent: boolean;
  /** The member's portrait digest from the roster (`portraitOf`). */
  portrait: string | null;
  pin: PairingPin;
  now: number;
  onPress: () => void;
}) {
  const p = usePalette();
  const words = momentWords(moment);
  const face = usePortrait(pin, words.full ? portrait : null);
  const label = `${words.lead}${words.line ? `: ${words.line}` : ''}, ${ago(moment.ts, now)}`;
  if (!words.full)
    return (
      <Squish
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={styles.quiet}
      >
        <View style={[styles.tick, { backgroundColor: p.border }]} />
        <Text numberOfLines={1} style={[styles.quietText, { color: p.muted }]}>
          <Text style={{ fontFamily: font.semibold, color: p.text }}>{words.lead}</Text>
          {words.line ? ` ${moment.kind === 'said' ? '' : '· '}${words.line}` : ''}
        </Text>
        <Text style={[styles.age, { color: p.placeholder }]}>{ago(moment.ts, now)}</Text>
      </Squish>
    );
  return (
    <Squish
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.full}
    >
      <View>
        <Seat name={moment.member} agent={agent} size={32} portrait={face} />
        <View
          style={[styles.badge, { backgroundColor: moment.kind === 'goal' ? p.accent : p.success }]}
        >
          <Icon
            name={moment.kind === 'goal' ? 'bell.fill' : 'arrow.down.to.line'}
            color="#fff"
            size={8}
          />
        </View>
      </View>
      <View style={styles.text}>
        <View style={styles.line1}>
          <Text numberOfLines={1} style={[styles.lead, { color: p.text }]}>
            {words.lead}
          </Text>
          {words.accepted ? <Icon name="checkmark.seal.fill" color={p.success} size={12} /> : null}
          <Text style={[styles.age, { color: p.placeholder }]}>{ago(moment.ts, now)}</Text>
        </View>
        {words.line ? (
          <Text numberOfLines={2} style={[styles.title, { color: p.text }]}>
            {words.line}
          </Text>
        ) : null}
        {moment.kind === 'landed' && moment.goal ? (
          <Text numberOfLines={1} style={[styles.goal, { color: p.muted }]}>
            {moment.goal}
          </Text>
        ) : null}
      </View>
    </Squish>
  );
}

const styles = StyleSheet.create({
  full: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm + 2, paddingVertical: 6 },
  badge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
  },
  text: { flex: 1, minWidth: 0, gap: 1 },
  line1: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  lead: { flexShrink: 1, fontFamily: font.semibold, fontSize: 12.5 },
  title: { fontFamily: font.medium, fontSize: 13.5, lineHeight: 18 },
  goal: { fontFamily: font.regular, fontSize: 11 },
  age: { marginLeft: 'auto', fontFamily: font.regular, fontSize: 11 },
  quiet: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 30 },
  tick: { width: 6, height: 6, borderRadius: 3, marginHorizontal: 13 },
  quietText: { flex: 1, fontFamily: font.regular, fontSize: 12 },
});
