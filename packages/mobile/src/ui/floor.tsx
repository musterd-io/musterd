import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { BUBBLE_MS, bubbleText } from '../native/floor';
import type { PairingPin } from '../native/pairingPin';
import type { AppMember } from '../native/team';
import { Icon } from './icon';
import { usePortrait } from './memberRow';
import { Breathe, Squish } from './motion';
import { Seat } from './seat';
import { GLOW_MS } from './springs';
import { StateDot } from './stateDot';
import { font, radius, space, usePalette } from './theme';

/** /live's floor, warm wood under cream light, so the phone and the office read as one place. */
const WOOD_TOP = '#F3D3A0';
const WOOD_BOTTOM = '#E2AE6C';
const FLOOR_HEIGHT = 176;
const FACE = 40;

/**
 * The live floor at the top of Now (ADR 819, the alive design): each member who is here at a desk
 * as their portrait with /live's state dot, one speech bubble at a time, a glow at a desk when its
 * member lands a lane, and the bell over the room when a goal finishes. Motion budget: one bubble
 * change every BUBBLE_MS, one glow at a time; Reduce Motion freezes the bubble and stills the glow.
 */
export function Floor({
  desks,
  more,
  live,
  askingYou,
  glowing,
  bell,
  pin,
  onPressMember,
}: {
  desks: AppMember[];
  more: number;
  live: boolean;
  /** Members with something in your For you: their bubble says "asking you →". */
  askingYou: ReadonlySet<string>;
  /** The member whose desk glows now, or null. */
  glowing: string | null;
  /** A goal just finished: the bell rings over the room. */
  bell: boolean;
  pin: PairingPin;
  onPressMember: (m: AppMember) => void;
}) {
  const p = usePalette();
  const reduce = useReducedMotion();
  const talkers = useMemo(
    () => desks.filter((m) => bubbleText(m, askingYou.has(m.name)) !== null),
    [desks, askingYou],
  );
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (reduce || talkers.length < 2) return;
    const t = setInterval(() => setTurn((n) => n + 1), BUBBLE_MS);
    return () => clearInterval(t);
  }, [reduce, talkers.length]);
  // Someone asking you speaks first and is never rotated away for long.
  const mine = talkers.find((m) => askingYou.has(m.name));
  const speaker =
    talkers.length === 0 ? null : mine && turn % 2 === 0 ? mine : talkers[turn % talkers.length]!;

  const rows =
    desks.length > 4
      ? [desks.slice(0, Math.ceil(desks.length / 2)), desks.slice(Math.ceil(desks.length / 2))]
      : [desks];

  return (
    <View
      style={[styles.floor, { borderColor: 'rgba(122,90,6,0.18)' }]}
      accessibilityLabel={
        desks.length === 0
          ? 'The floor. Nobody is at a desk.'
          : `The floor. ${desks.length + more} here${live ? ', live' : ''}.`
      }
    >
      <Svg style={StyleSheet.absoluteFill} accessible={false}>
        <Defs>
          <LinearGradient id="wood" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={WOOD_TOP} />
            <Stop offset="1" stopColor={WOOD_BOTTOM} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#wood)" />
      </Svg>
      <View style={styles.top}>
        {live ? (
          <View style={styles.live} accessibilityLabel="Live">
            <Breathe>
              <View style={[styles.liveDot, { backgroundColor: p.danger }]} />
            </Breathe>
            <Text style={styles.liveText}>LIVE</Text>
          </View>
        ) : (
          <View />
        )}
        {more > 0 ? <Text style={styles.more}>{`+${more}`}</Text> : null}
      </View>
      {bell ? (
        <Animated.View
          {...(reduce ? {} : { entering: ZoomIn.springify().damping(12) })}
          exiting={FadeOut.duration(240)}
          style={styles.bell}
          accessibilityLabel="A goal finished"
        >
          <Icon name="bell.fill" color={p.accentText} size={22} />
        </Animated.View>
      ) : null}
      {desks.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>A quiet room. Nobody’s at a desk right now.</Text>
        </View>
      ) : (
        <View style={styles.rows}>
          {rows.map((row, r) => (
            <View key={r} style={styles.row}>
              {row.map((m) => (
                <Desk
                  key={m.name}
                  member={m}
                  pin={pin}
                  glowing={glowing === m.name}
                  bubble={speaker?.name === m.name ? bubbleText(m, askingYou.has(m.name)) : null}
                  reduce={reduce}
                  onPress={onPressMember}
                />
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Desk({
  member,
  pin,
  glowing,
  bubble,
  reduce,
  onPress,
}: {
  member: AppMember;
  pin: PairingPin;
  glowing: boolean;
  bubble: { text: string; mine: boolean } | null;
  reduce: boolean;
  onPress: (m: AppMember) => void;
}) {
  const p = usePalette();
  const face = usePortrait(pin, member.portrait);
  const glow = useSharedValue(0);
  useEffect(() => {
    if (!glowing) {
      glow.value = withTiming(0, { duration: 160 });
      return;
    }
    glow.value = reduce
      ? 1
      : withSequence(
          withTiming(1, { duration: GLOW_MS * 0.3 }),
          withTiming(0.85, { duration: GLOW_MS * 0.4 }),
          withTiming(0, { duration: GLOW_MS * 0.3 }),
        );
  }, [glowing, reduce, glow]);
  const ring = useAnimatedStyle(() => ({
    opacity: glow.value,
    transform: [{ scale: 1 + glow.value * 0.18 }],
  }));
  return (
    <Squish
      accessibilityRole="button"
      accessibilityLabel={`${member.name}, ${member.label}`}
      onPress={() => onPress(member)}
      style={styles.desk}
    >
      <View style={styles.bubbleSlot} pointerEvents="none">
        {bubble ? (
          <Animated.View
            key={`${member.name}:${bubble.text}`}
            {...(reduce ? {} : { entering: FadeIn.duration(220), exiting: FadeOut.duration(180) })}
            style={[
              styles.bubble,
              { backgroundColor: bubble.mine ? p.accent : 'rgba(255,255,255,0.94)' },
            ]}
          >
            <Text
              numberOfLines={1}
              style={[styles.bubbleText, { color: bubble.mine ? p.onAccent : p.text }]}
            >
              {bubble.text}
            </Text>
          </Animated.View>
        ) : null}
      </View>
      <View>
        <Animated.View
          pointerEvents="none"
          style={[styles.glow, { backgroundColor: 'rgba(255,236,170,0.95)' }, ring]}
        />
        <Seat name={member.name} agent={member.kind === 'agent'} size={FACE} portrait={face} />
        <StateDot state={member.state} size={11} />
      </View>
      <View style={styles.deskTop} />
      <Text numberOfLines={1} style={styles.name}>
        {member.name}
      </Text>
    </Squish>
  );
}

const styles = StyleSheet.create({
  floor: {
    height: FLOOR_HEIGHT,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
  },
  top: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 18,
    paddingHorizontal: 4,
  },
  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveText: { fontFamily: font.bold, fontSize: 10, letterSpacing: 0.8, color: '#7A2E12' },
  more: { fontFamily: font.semibold, fontSize: 12, color: '#6B4210' },
  bell: {
    position: 'absolute',
    top: space.sm,
    alignSelf: 'center',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  rows: { flex: 1, justifyContent: 'space-evenly' },
  row: { flexDirection: 'row', justifyContent: 'space-evenly' },
  desk: { alignItems: 'center', width: 72 },
  bubbleSlot: { height: 22, width: 72, alignItems: 'center', marginBottom: 3 },
  bubble: {
    position: 'absolute',
    bottom: 0,
    alignSelf: 'center',
    maxWidth: 150,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    shadowColor: '#5A3A0A',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  bubbleText: { fontFamily: font.medium, fontSize: 10.5 },
  glow: {
    position: 'absolute',
    left: -6,
    top: -6,
    width: FACE + 12,
    height: FACE + 12,
    borderRadius: (FACE + 12) / 2,
  },
  deskTop: {
    width: 46,
    height: 5,
    borderRadius: 3,
    marginTop: 3,
    backgroundColor: 'rgba(110,62,18,0.35)',
  },
  name: { fontFamily: font.medium, fontSize: 10.5, color: '#4A2E0A', marginTop: 2, maxWidth: 70 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
  emptyText: { fontFamily: font.medium, fontSize: 13, color: '#5A3A0A', textAlign: 'center' },
});
