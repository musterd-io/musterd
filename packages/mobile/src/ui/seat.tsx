import { Text, View } from 'react-native';
import { usePalette } from './theme';

/** "just now", "4m ago", "2h ago", "yesterday", then a date. */
export function ago(ts: number, now: number): string {
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return 'yesterday';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** A member's seat: the mark's sand and teal for an agent, the warm tint for a person. */
export function Seat({ name, agent, size = 36 }: { name: string; agent: boolean; size?: number }) {
  const p = usePalette();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: agent ? p.sand : p.tint,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: agent ? p.teal : p.accentText,
          fontSize: size * 0.42,
          fontWeight: '700',
        }}
      >
        {(name[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}
