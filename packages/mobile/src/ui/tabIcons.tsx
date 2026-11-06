import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { Tab } from './springs';

/**
 * The pill's three glyphs, drawn as SVG (ADR 815) so they carry their own tint and fill on the
 * active tab: Now is a ring with a centre that fills (what is happening right now); Work is three
 * bars of differing height (the board); You is a head and shoulders. Each is 24 × 24 at 2 pt
 * strokes, the weight SF Symbols use at this size, so they sit beside system glyphs.
 */
export function TabIcon({
  tab,
  color,
  active,
  size = 20,
}: {
  tab: Tab;
  color: string;
  active: boolean;
  size?: number;
}) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' } as const;
  switch (tab) {
    case 'now':
      return (
        <Svg {...common} accessible={false}>
          <Circle cx={12} cy={12} r={8} stroke={color} strokeWidth={2} />
          <Circle cx={12} cy={12} r={3} fill={color} opacity={active ? 1 : 0.45} />
        </Svg>
      );
    case 'work':
      return (
        <Svg {...common} accessible={false}>
          <Rect
            x={4}
            y={5}
            width={5}
            height={14}
            rx={1.5}
            stroke={color}
            strokeWidth={2}
            fill={active ? color : 'none'}
            fillOpacity={active ? 0.25 : 0}
          />
          <Rect x={10.5} y={5} width={5} height={9} rx={1.5} stroke={color} strokeWidth={2} />
          <Rect x={17} y={5} width={3} height={11} rx={1.5} stroke={color} strokeWidth={2} />
        </Svg>
      );
    case 'you':
      return (
        <Svg {...common} accessible={false}>
          <Circle
            cx={12}
            cy={9}
            r={3.5}
            stroke={color}
            strokeWidth={2}
            fill={active ? color : 'none'}
            fillOpacity={active ? 0.25 : 0}
          />
          <Path
            d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
          />
        </Svg>
      );
  }
}
