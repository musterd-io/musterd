import { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { seatActions } from '../native/notice';
import type { PairingPin } from '../native/pairingPin';
import { sinceLabel, type AppMember } from '../native/team';
import { tap } from './haptics';
import { usePortrait } from './memberRow';
import { QuickActions } from './quickActions';
import { Seat } from './seat';
import { SPRING } from './springs';
import { StateDot } from './stateDot';
import { font, radius, space, usePalette } from './theme';

/** Dragging the sheet further than this lets it go. */
const DISMISS_PT = 120;
/** Where the sheet starts from, below the screen, before it rises. */
const OFFSCREEN = 600;

/**
 * A member's sheet (ADR 814, the app shell design): tap a row and it rises on a spring over a
 * dimmed page — the portrait, name, model, state and what they are on, then the quick actions
 * that fit their state. Drag it down past a hand's width and it goes; so does a tap on the dim.
 * Phase 1 carries today's quick actions only; the nudge and the chat come in phases 2 and 3.
 */
export function MemberSheet({
  member,
  pin,
  now,
  onClose,
}: {
  member: AppMember | null;
  pin: PairingPin;
  now: number;
  onClose: () => void;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const y = useSharedValue(OFFSCREEN);
  const dim = useSharedValue(0);
  const open = member !== null;

  useEffect(() => {
    if (!open) return;
    tap();
    y.value = reduce ? 0 : withSpring(0, SPRING.sheet);
    dim.value = withTiming(1, { duration: reduce ? 0 : 200 });
  }, [open, reduce, y, dim]);

  const close = () => {
    dim.value = withTiming(0, { duration: reduce ? 0 : 160 });
    if (reduce) {
      y.value = OFFSCREEN;
      onClose();
      return;
    }
    y.value = withTiming(OFFSCREEN, { duration: 220 }, (done) => {
      if (done) runOnJS(onClose)();
    });
  };

  const drag = Gesture.Pan()
    .onUpdate((e) => {
      y.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > DISMISS_PT || e.velocityY > 900) runOnJS(close)();
      else y.value = withSpring(0, SPRING.sheet);
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value * 0.32 }));

  const portrait = usePortrait(pin, member?.portrait ?? null);
  if (!member) return null;
  const age = sinceLabel(member.since, now);
  const where = [member.model, member.online ? 'online' : member.wakeable ? 'asleep' : 'offline']
    .filter(Boolean)
    .join(' · ');
  const meta = [member.goal ? `for ${member.goal}` : null, age ? `${age} in` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Modal visible transparent animationType="none" onRequestClose={close}>
      <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close">
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#1e140a' }, dimStyle]} />
      </Pressable>
      <GestureDetector gesture={drag}>
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: p.surface, paddingBottom: insets.bottom + space.lg },
            sheetStyle,
          ]}
        >
          <View style={[styles.grab, { backgroundColor: p.border }]} />
          <View style={styles.who}>
            <View>
              <Seat
                name={member.name}
                agent={member.kind === 'agent'}
                size={46}
                portrait={portrait}
              />
              <StateDot state={member.state} size={12} />
            </View>
            <View style={styles.names}>
              <Text style={[styles.name, { color: p.text }]}>{member.name}</Text>
              <Text numberOfLines={1} style={[styles.where, { color: p.muted }]}>
                {where}
              </Text>
            </View>
          </View>
          <View style={[styles.lane, { backgroundColor: p.raised }]}>
            <Text style={[styles.state, { color: p.accentText }]}>{member.label}</Text>
            {member.title ? (
              <Text
                numberOfLines={2}
                accessibilityLabel={
                  member.source === 'lane' ? `Their lane: ${member.title}` : member.title
                }
                style={[styles.title, { color: p.text }]}
              >
                {member.source === 'status' ? `“${member.title}”` : member.title}
              </Text>
            ) : null}
            {meta || member.more_lanes > 0 ? (
              <Text style={[styles.meta, { color: p.muted }]}>
                {[meta, member.more_lanes > 0 ? `+${member.more_lanes} more lanes` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
          </View>
          {member.kind === 'agent' ? (
            <QuickActions pin={pin} seat={member.name} actions={seatActions(member)} />
          ) : null}
        </Animated.View>
      </GestureDetector>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    borderRadius: 30,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.md,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: -6 },
    elevation: 20,
  },
  grab: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center' },
  who: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  names: { flex: 1, minWidth: 0 },
  name: { fontFamily: font.display, fontSize: 20, letterSpacing: -0.3 },
  where: { fontFamily: font.regular, fontSize: 12, marginTop: 1 },
  lane: { borderRadius: radius.lg, padding: space.md, gap: 3 },
  state: { fontFamily: font.semibold, fontSize: 11.5 },
  title: { fontFamily: font.medium, fontSize: 14 },
  meta: { fontFamily: font.regular, fontSize: 11.5 },
});
