import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import type { Desk, DeskProp } from '../native/floor';
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
const INK = '#4A2E0A';
const INK_SOFT = '#7A5428';
const FACE = 32;
const LOUNGE_FACE = 24;
const LOUNGE_MAX = 8;

/**
 * The live floor at the top of Now (ADR 819), laid out as /live's office (`office-scene/seating.ts`):
 * members with work at desks, two to a row, each with their face and state dot, their name, what
 * they are on, and the prop that says their state (◎ review, a blocked sticky, ! asking, ! you in
 * mustard); members between tasks on the lounge sofa; the board with what landed today. A landing
 * glows its member's desk (one at a time); a finished goal rings the bell. The floor's height is
 * what it holds, never a fixed box. Reduce Motion stills the glow.
 */
export function Floor({
  desks,
  moreDesks,
  lounge,
  live,
  landed,
  glowing,
  bell,
  pin,
  onPressMember,
}: {
  desks: Desk[];
  moreDesks: number;
  lounge: AppMember[];
  live: boolean;
  /** Lanes landed today: the board's count. */
  landed: number;
  /** The member whose desk glows now, or null. */
  glowing: string | null;
  /** A goal just finished: the bell rings over the room. */
  bell: boolean;
  pin: PairingPin;
  onPressMember: (m: AppMember) => void;
}) {
  const p = usePalette();
  const reduce = useReducedMotion();
  const empty = desks.length === 0 && lounge.length === 0;
  const rows: Desk[][] = [];
  for (let i = 0; i < desks.length; i += 2) rows.push(desks.slice(i, i + 2));

  return (
    <View
      style={styles.floor}
      accessibilityLabel={
        empty
          ? 'The office. Nobody is in.'
          : `The office. ${desks.length + moreDesks} at desks, ${lounge.length} in the lounge, ${landed} landed today.`
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
          <Text style={styles.quietTag}>the office</Text>
        )}
        <View style={styles.board} accessibilityLabel={`${landed} landed today`}>
          <Icon name="pin.fill" color={p.danger} size={10} />
          <Text style={styles.boardText}>
            <Text style={styles.boardCount}>{landed}</Text> landed today
          </Text>
        </View>
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

      {empty ? <Text style={styles.emptyText}>A quiet office. Nobody’s in right now.</Text> : null}

      {rows.map((row, r) => (
        <View key={r} style={styles.deskRow}>
          {row.map((d) => (
            <DeskCard
              key={d.member.name}
              desk={d}
              pin={pin}
              glowing={glowing === d.member.name}
              reduce={reduce}
              onPress={onPressMember}
            />
          ))}
          {row.length === 1 ? <View style={styles.deskGap} /> : null}
        </View>
      ))}
      {moreDesks > 0 ? <Text style={styles.more}>{`+${moreDesks} more at desks`}</Text> : null}

      {lounge.length > 0 ? (
        <View style={styles.lounge}>
          <Icon name="sofa.fill" color={INK_SOFT} size={13} />
          <Text style={styles.loungeLabel}>lounge</Text>
          <View style={styles.loungeFaces}>
            {lounge.slice(0, LOUNGE_MAX).map((m, i) => (
              <LoungeFace
                key={m.name}
                member={m}
                pin={pin}
                first={i === 0}
                onPress={onPressMember}
              />
            ))}
          </View>
          {lounge.length > LOUNGE_MAX ? (
            <Text style={styles.loungeMore}>{`+${lounge.length - LOUNGE_MAX}`}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function propLook(prop: DeskProp, p: ReturnType<typeof usePalette>) {
  switch (prop) {
    case 'review':
      return { text: '◎ review', bg: p.tint, fg: p.accentText };
    case 'blocked':
      return { text: 'blocked', bg: '#FDE7A7', fg: p.danger };
    case 'asking':
      return { text: '! asking', bg: '#FFF1DB', fg: p.warning };
    case 'asking-you':
      return { text: '! you', bg: p.accent, fg: p.onAccent };
    default:
      return null;
  }
}

function DeskCard({
  desk,
  pin,
  glowing,
  reduce,
  onPress,
}: {
  desk: Desk;
  pin: PairingPin;
  glowing: boolean;
  reduce: boolean;
  onPress: (m: AppMember) => void;
}) {
  const p = usePalette();
  const m = desk.member;
  const face = usePortrait(pin, m.portrait);
  const look = propLook(desk.prop, p);
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
          withTiming(0.8, { duration: GLOW_MS * 0.4 }),
          withTiming(0, { duration: GLOW_MS * 0.3 }),
        );
  }, [glowing, reduce, glow]);
  const light = useAnimatedStyle(() => ({ opacity: glow.value }));
  return (
    <Squish
      accessibilityRole="button"
      accessibilityLabel={`${m.name}, ${m.label}${desk.cue ? `, ${desk.cue}` : ''}`}
      onPress={() => onPress(m)}
      style={styles.desk}
    >
      <Animated.View pointerEvents="none" style={[styles.deskGlow, light]} />
      <View>
        <Seat name={m.name} agent={m.kind === 'agent'} size={FACE} portrait={face} />
        <StateDot state={m.state} size={10} />
      </View>
      <View style={styles.deskWords}>
        <View style={styles.deskLine1}>
          <Text numberOfLines={1} style={styles.deskName}>
            {m.name}
          </Text>
          {look ? (
            <View style={[styles.prop, { backgroundColor: look.bg }]}>
              <Text style={[styles.propText, { color: look.fg }]}>{look.text}</Text>
            </View>
          ) : null}
        </View>
        {desk.cue ? (
          <Text
            numberOfLines={1}
            style={[styles.cue, desk.prop === 'blocked' ? { color: p.danger } : null]}
          >
            {desk.cue}
          </Text>
        ) : null}
      </View>
    </Squish>
  );
}

function LoungeFace({
  member,
  pin,
  first,
  onPress,
}: {
  member: AppMember;
  pin: PairingPin;
  first: boolean;
  onPress: (m: AppMember) => void;
}) {
  const face = usePortrait(pin, member.portrait);
  return (
    <Squish
      accessibilityRole="button"
      accessibilityLabel={`${member.name}, between tasks`}
      onPress={() => onPress(member)}
      style={[styles.loungeFace, first ? null : { marginLeft: -6 }]}
    >
      <Seat name={member.name} agent={member.kind === 'agent'} size={LOUNGE_FACE} portrait={face} />
    </Squish>
  );
}

const styles = StyleSheet.create({
  floor: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(122,90,6,0.18)',
    padding: space.sm + 2,
    gap: space.sm,
  },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveText: { fontFamily: font.bold, fontSize: 10.5, letterSpacing: 0.8, color: '#7A2E12' },
  quietTag: { fontFamily: font.semibold, fontSize: 11, color: INK_SOFT },
  board: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#FFF8EB',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    transform: [{ rotate: '-1.5deg' }],
    shadowColor: '#5A3A0A',
    shadowOpacity: 0.18,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  boardText: { fontFamily: font.medium, fontSize: 11, color: INK },
  boardCount: { fontFamily: font.bold },
  bell: { position: 'absolute', top: space.sm, left: 0, right: 0, alignItems: 'center' },
  emptyText: {
    fontFamily: font.medium,
    fontSize: 13,
    color: INK,
    textAlign: 'center',
    paddingVertical: space.lg,
  },
  deskRow: { flexDirection: 'row', gap: space.sm },
  deskGap: { flex: 1 },
  desk: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: 'rgba(255,248,235,0.78)',
    borderRadius: radius.sm + 2,
    borderBottomWidth: 3,
    borderBottomColor: 'rgba(110,62,18,0.32)',
    paddingHorizontal: space.sm,
    paddingVertical: 7,
    overflow: 'hidden',
  },
  deskGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,226,140,0.95)',
  },
  deskWords: { flex: 1, minWidth: 0, gap: 1 },
  deskLine1: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  deskName: { flexShrink: 1, fontFamily: font.semibold, fontSize: 12.5, color: INK },
  prop: { borderRadius: radius.pill, paddingHorizontal: 5, paddingVertical: 1 },
  propText: { fontFamily: font.bold, fontSize: 9.5 },
  cue: { fontFamily: font.regular, fontSize: 11, color: INK_SOFT },
  more: { fontFamily: font.medium, fontSize: 11, color: INK_SOFT, textAlign: 'center' },
  lounge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(122,74,30,0.14)',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 5,
  },
  loungeLabel: { fontFamily: font.semibold, fontSize: 11, color: INK_SOFT },
  loungeFaces: { flexDirection: 'row', alignItems: 'center', marginLeft: 2 },
  loungeFace: { borderRadius: LOUNGE_FACE / 2, borderWidth: 1.5, borderColor: '#F6E3C2' },
  loungeMore: { fontFamily: font.semibold, fontSize: 11, color: INK_SOFT },
});
