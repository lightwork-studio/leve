import Svg, { Circle, Line, Path, Polyline, Rect } from "react-native-svg";

type IconProps = { size?: number; color: string; strokeWidth?: number };

// Plain stroke icons drawn for Leve; no icon set or other product's artwork.
const frame = ({ size = 24, color, strokeWidth = 1.9 }: IconProps) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: color,
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const DumbbellIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Line x1="7" y1="12" x2="17" y2="12" />
    <Rect x="4" y="8" width="3" height="8" rx="1" />
    <Rect x="17" y="8" width="3" height="8" rx="1" />
    <Line x1="2" y1="10.5" x2="2" y2="13.5" />
    <Line x1="22" y1="10.5" x2="22" y2="13.5" />
  </Svg>
);

export const ClockIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Circle cx="12" cy="12" r="9" />
    <Polyline points="12 7 12 12 15.5 14" />
  </Svg>
);

export const BarsIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Line x1="6" y1="20" x2="6" y2="13" />
    <Line x1="12" y1="20" x2="12" y2="5" />
    <Line x1="18" y1="20" x2="18" y2="10" />
  </Svg>
);

export const SlidersIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Line x1="4" y1="8" x2="20" y2="8" />
    <Line x1="4" y1="16" x2="20" y2="16" />
    <Circle cx="15" cy="8" r="2" fill={props.color} />
    <Circle cx="9" cy="16" r="2" fill={props.color} />
  </Svg>
);

export const PlusIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Line x1="12" y1="5" x2="12" y2="19" />
    <Line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
);

export const ChevronIcon = ({
  direction = "right",
  ...props
}: IconProps & {
  direction?: "right" | "down" | "left";
}) => {
  const points = { right: "9 5 16 12 9 19", down: "5 9 12 16 19 9", left: "15 5 8 12 15 19" };
  return (
    <Svg {...frame(props)}>
      <Polyline points={points[direction]} />
    </Svg>
  );
};

export const MoreIcon = ({ color, size = 24 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <Circle cx="5" cy="12" r="1.7" />
    <Circle cx="12" cy="12" r="1.7" />
    <Circle cx="19" cy="12" r="1.7" />
  </Svg>
);

export const PlayIcon = ({ color, size = 24 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <Path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5z" />
  </Svg>
);

export const LayersIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Path d="M12 4 3 9l9 5 9-5z" />
    <Path d="m3 14 9 5 9-5" />
  </Svg>
);

export const FolderIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

export const TrayIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Path d="M4 13h4l1.5 2.5h5L16 13h4" />
    <Path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z" />
  </Svg>
);

export const RulerIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Path d="M3.5 15.5 15.5 3.5l5 5-12 12z" />
    <Line x1="7.5" y1="11.5" x2="9.5" y2="13.5" />
    <Line x1="10.5" y1="8.5" x2="12" y2="10" />
    <Line x1="13.5" y1="5.5" x2="15.5" y2="7.5" />
  </Svg>
);

export const CheckIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Polyline points="5 12.5 10 17.5 19 7" />
  </Svg>
);

/** A filled star, marking a standout. */
export const StarIcon = ({ color, size = 24 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <Path d="M12 3.2l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L12 16.4l-5.3 3 1.2-5.9-4.5-4.1 6-.7z" />
  </Svg>
);

/** A short arrow pointing up or down, for a change. */
export const ArrowIcon = ({ direction, ...props }: IconProps & { direction: "up" | "down" }) => (
  <Svg {...frame(props)}>
    {direction === "up" ? (
      <>
        <Line x1="12" y1="19" x2="12" y2="5" />
        <Polyline points="6 11 12 5 18 11" />
      </>
    ) : (
      <>
        <Line x1="12" y1="5" x2="12" y2="19" />
        <Polyline points="6 13 12 19 18 13" />
      </>
    )}
  </Svg>
);

/** An arrow pointing on: starting or going ahead. */
export const ForwardIcon = (props: IconProps) => (
  <Svg {...frame({ strokeWidth: 2, ...props })}>
    <Path d="M4 12h15M13 6l6 6-6 6" />
  </Svg>
);

/** Settings: a cog with a closed outline and a bore. */
export const GearIcon = (props: IconProps) => (
  <Svg {...frame({ strokeWidth: 1.8, ...props })}>
    <Circle cx="12" cy="12" r="3.2" />
    <Path d="M10.5 3h3l.5 2.5 1.2.5 2.2-1.4 2 2L18 8.8l.5 1.2 2.5.5v3l-2.5.5-.5 1.2 1.4 2.2-2 2-2.2-1.4-1.2.5-.5 2.5h-3l-.5-2.5-1.2-.5-2.2 1.4-2-2L6 15.2 5.5 14 3 13.5v-3l2.5-.5.5-1.2-1.4-2.2 2-2L8.8 6l1.2-.5z" />
  </Svg>
);

/** The Train tab: a bar with plates. */
export const TrainIcon = (props: IconProps) => (
  <Svg {...frame({ strokeWidth: 1.8, ...props })}>
    <Path d="M3 12h2.5M18.5 12H21M5.5 8v8M18.5 8v8M8.5 6v12M15.5 6v12M8.5 12h7" />
  </Svg>
);

/** The History tab: lines of a log. */
export const HistoryIcon = (props: IconProps) => (
  <Svg {...frame({ strokeWidth: 1.8, ...props })}>
    <Path d="M4 5h16M4 10h10M4 15h16M4 20h7" />
  </Svg>
);

/** The Progress tab: rising bars. */
export const ProgressIcon = (props: IconProps) => (
  <Svg {...frame({ strokeWidth: 1.8, ...props })}>
    <Path d="M4 20V14M9.3 20V9M14.6 20v-7M20 20V4" />
  </Svg>
);

export const MinusIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
);

/** Deleting the last character: a key with a cross. */
export const DeleteIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Path d="M9 5.5h10.5v13H9L3.5 12z" />
    <Path d="m11.5 9.5 5 5M16.5 9.5l-5 5" />
  </Svg>
);

/** A rest timer: a stopwatch face. */
export const TimerIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Circle cx="12" cy="13.5" r="7.5" />
    <Path d="M12 9.5v4l2.5 2M9.5 3h5" />
  </Svg>
);

/** Skipping ahead: two filled arrowheads. */
export const SkipIcon = ({ color, size = 24 }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <Path d="M5 6.5v11l8-5.5zM13 6.5v11l8-5.5z" />
  </Svg>
);

/** Changing a value: a pencil. */
export const EditIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Path d="M4.5 19.5h4l10-10-4-4-10 10z" />
    <Path d="m13 7 4 4" />
  </Svg>
);

/** A note: a page with a turned corner and two lines of writing. */
export const NoteIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Path d="M5.5 4h9l4 4v12h-13z" />
    <Path d="M14.5 4v4h4M8.5 12.5h7M8.5 16h5" />
  </Svg>
);

/** Searching: a magnifier. */
export const SearchIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Circle cx="11" cy="11" r="6.5" />
    <Path d="m16 16 4.5 4.5" />
  </Svg>
);

/** Closing or clearing: a cross. */
export const CloseIcon = (props: IconProps) => (
  <Svg {...frame({ strokeWidth: 2, ...props })}>
    <Path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

/** Something went wrong: a triangle with a stroke and a dot. */
export const WarnIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Path d="M12 4 21 19.5H3z" />
    <Path d="M12 10v4.5M12 17.2v.2" />
  </Svg>
);

/** Something to drag: two columns of three dots. */
export const GripIcon = (props: IconProps) => (
  <Svg {...frame({ strokeWidth: 2.2, ...props })}>
    <Path d="M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01" />
  </Svg>
);

/** Joining two things: a chain link. */
export const LinkIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Path d="M9 15 15 9" />
    <Path d="M10.5 6.5 12 5a4 4 0 0 1 5.7 5.7l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-5.7-5.7l1.5-1.5" />
  </Svg>
);

/** A note about something: an i in a circle. */
export const InfoIcon = (props: IconProps) => (
  <Svg {...frame(props)}>
    <Circle cx="12" cy="12" r="8.5" />
    <Path d="M12 11v5.5M12 7.6v.2" />
  </Svg>
);
