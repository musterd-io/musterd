import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PairingPin } from '../native/pairingPin';
import { modelLine, sinceLabel, type AppMember } from '../native/team';
import { Squish } from './motion';
import { Seat } from './seat';
import { StateDot } from './stateDot';
import { font, space, usePalette } from './theme';

/** A row's fixed height, so a portrait arriving late never moves the list. */
export const MEMBER_ROW_HEIGHT = 44;

/**
 * One member, as /live's team card reads in two lines (ADR 814): the portrait with the state dot,
 * the name, the model in small muted type and the age at the right; then the state word and what
 * they are on — the lane's title (the member's own text), or their status line in quotes. No card:
 * the row sits on the page, a hairline above the next.
 */
export function MemberRow({
  member,
  pin,
  now,
  onPress,
}: {
  member: AppMember;
  pin: PairingPin;
  now: number;
  onPress: (m: AppMember) => void;
}) {
  const p = usePalette();
  const portrait = usePortrait(pin, member.portrait);
  const age = sinceLabel(member.since, now);
  const said = member.source === 'status' && member.title ? `“${member.title}”` : member.title;
  const line =
    member.state === 'working'
      ? said
      : [member.label, said].filter(Boolean).join(' · ') || member.label;
  return (
    <Squish
      accessibilityRole="button"
      accessibilityLabel={`${member.name}, ${member.label}${said ? `, ${said}` : ''}`}
      onPress={() => onPress(member)}
      style={styles.row}
    >
      <View>
        <Seat name={member.name} agent={member.kind === 'agent'} size={28} portrait={portrait} />
        <StateDot state={member.state} />
      </View>
      <View style={styles.text}>
        <View style={styles.line1}>
          <Text numberOfLines={1} style={[styles.name, { color: p.text }]}>
            {member.name}
          </Text>
          {modelLine(member) ? (
            <Text numberOfLines={1} style={[styles.model, { color: p.placeholder }]}>
              {modelLine(member)}
            </Text>
          ) : null}
          {age ? <Text style={[styles.age, { color: p.placeholder }]}>{age}</Text> : null}
        </View>
        <Text numberOfLines={1} style={[styles.line2, { color: p.muted }]}>
          {line}
          {member.more_lanes > 0 ? (
            <Text style={{ color: p.placeholder }}>{`  +${member.more_lanes} more`}</Text>
          ) : null}
        </Text>
      </View>
    </Squish>
  );
}

/** ADR 797: the member's face as /live paints it, fetched once per digest; null until then. */
export function usePortrait(pin: PairingPin, digest: string | null): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    if (!digest) return;
    let live = true;
    void (async () => {
      try {
        const { fetchPortrait } = await import('../native/quickAction');
        const got = await fetchPortrait({ pin, digest });
        if (live && got) setUri(got);
      } catch {
        // Expo Go has no native module: keep the letter.
      }
    })();
    return () => {
      live = false;
    };
  }, [pin, digest]);
  return digest ? uri : null;
}

const styles = StyleSheet.create({
  row: {
    height: MEMBER_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
  },
  text: { flex: 1, minWidth: 0, gap: 1 },
  line1: { flexDirection: 'row', alignItems: 'baseline', gap: space.xs + 2 },
  name: { fontFamily: font.bold, fontSize: 13, flexShrink: 1 },
  model: { fontFamily: font.medium, fontSize: 10.5, flexShrink: 1 },
  age: {
    fontFamily: font.medium,
    fontSize: 10.5,
    marginLeft: 'auto',
    fontVariant: ['tabular-nums'],
  },
  line2: { fontFamily: font.regular, fontSize: 12 },
});
