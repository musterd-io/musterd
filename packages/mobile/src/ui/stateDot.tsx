import { View } from 'react-native';
import type { AppMemberState } from '../native/team';
import { usePalette } from './theme';

/**
 * /live's state dot (`Live.css` `.lc-team-card__dot`), on a portrait's corner: working green,
 * waiting for review mustard, blocked red, asking amber, between tasks a hollow amber ring, away
 * none. The colours are the palette's semantic ones, so the two surfaces agree.
 */
export function StateDot({ state, size = 9 }: { state: AppMemberState; size?: number }) {
  const p = usePalette();
  if (state === 'away') return null;
  const ring = state === 'between';
  const fill =
    state === 'working'
      ? p.success
      : state === 'review'
        ? p.accent
        : state === 'blocked'
          ? p.danger
          : p.warning;
  return (
    <View
      accessible={false}
      style={{
        position: 'absolute',
        right: -1,
        bottom: -1,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: ring ? p.bg : fill,
        borderWidth: ring ? 1.5 : 2,
        borderColor: ring ? p.warning : p.bg,
      }}
    />
  );
}
