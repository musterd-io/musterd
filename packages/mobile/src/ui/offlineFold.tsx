import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AppMember } from '../native/team';
import { tap } from './haptics';
import { Squish } from './motion';
import { Seat } from './seat';
import { font, space, usePalette } from './theme';

/**
 * /live's "N offline" fold (ADR 814): one row with a few stacked faces and the count, Show/Hide at
 * the right; open, the rows come under it. Nothing is drawn for zero members.
 */
export function OfflineFold({
  members,
  open,
  onToggle,
  children,
}: {
  members: readonly AppMember[];
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const p = usePalette();
  if (members.length === 0) return null;
  return (
    <View>
      <Squish
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${members.length} offline, ${open ? 'hide' : 'show'}`}
        onPress={() => {
          tap();
          onToggle();
        }}
        style={[styles.fold, { borderTopColor: p.border }]}
      >
        <View style={styles.stack}>
          {members.slice(0, 4).map((m, i) => (
            <View
              key={m.name}
              style={[styles.face, { marginLeft: i === 0 ? 0 : -7, borderColor: p.bg }]}
            >
              <Seat name={m.name} agent={m.kind === 'agent'} size={20} />
            </View>
          ))}
        </View>
        <Text style={[styles.count, { color: p.text }]}>{`${members.length} offline`}</Text>
        <Text style={[styles.toggle, { color: p.accentText }]}>{open ? 'Hide' : 'Show'}</Text>
      </Squish>
      {open ? children : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fold: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingTop: space.sm + 2,
    paddingBottom: space.xs,
    marginTop: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  stack: { flexDirection: 'row', opacity: 0.55 },
  face: { borderRadius: 12, borderWidth: 2 },
  count: { fontFamily: font.semibold, fontSize: 12 },
  toggle: { fontFamily: font.bold, fontSize: 12, marginLeft: 'auto' },
});
