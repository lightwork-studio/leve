import Svg, { Circle, Polyline } from "react-native-svg";
import { useColors } from "./themed.ts";

/** A tiny line of recent values, oldest first, with a dot on the latest. Decoration only. */
export function Sparkline({
  values,
  width = 60,
  height = 26,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
}) {
  const c = useColors();
  if (values.length < 2) return null;
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const points = values.map((value, i) => [
    2 + (i / (values.length - 1)) * (width - 4),
    height - 3 - ((value - low) / span) * (height - 6),
  ]);
  const [lastX, lastY] = points.at(-1) as number[];
  return (
    <Svg width={width} height={height} aria-hidden accessibilityElementsHidden>
      <Polyline
        points={points.map((p) => p.join(",")).join(" ")}
        fill="none"
        stroke={c.fg2}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <Circle cx={lastX} cy={lastY} r={2.5} fill={c.fg} />
    </Svg>
  );
}
