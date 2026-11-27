import { Button, HStack, Link, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  activityBackgroundTint,
  background,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  minimumScaleFactor,
  monospacedDigit,
  padding,
  privacySensitive,
  progressViewStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";
import type { WorkoutContent } from "./session.ts";

function workoutLayout(p: WorkoutContent, env: LiveActivityEnvironment) {
  "widget";
  const bone = "#F3F1EC";
  const graphite = "#171A20";
  const orange = "#FF5A32";
  const resting = p.restEnd > Date.now() && !env.isStale;
  // Leve's Appearance setting decides, as in the app; "system" follows the system's scheme, as
  // does an activity started before the setting was sent. The rest timer is inverted, as the
  // app's is: bone in the dark appearance, graphite on paper.
  const fixed = p.appearance === "light" || p.appearance === "dark";
  const light = (fixed ? p.appearance : env.colorScheme) === "light";
  const paper = resting !== light;
  const ink = paper ? graphite : bone;
  const ground = paper ? bone : graphite;
  const fraction = p.total ? p.done / p.total : 0;
  const interval = { lower: new Date(p.restStart), upper: new Date(p.restEnd) };
  const small = [font({ size: 12, design: "monospaced" }), lineLimit(1), privacySensitive()];
  const big = [
    font({ size: 29, weight: "light" }),
    monospacedDigit(),
    lineLimit(1),
    minimumScaleFactor(0.6),
    privacySensitive(),
  ];
  const count = `${p.done}/${p.total}`;
  // The island's leading slot: the rest ring while resting, otherwise the sets done. SwiftUI's
  // Gauge draws nothing in a Live Activity, so the count is text. The ring prints its own
  // countdown, which has to shrink to fit inside it.
  const disc = resting ? (
    <ProgressView
      timerInterval={interval}
      modifiers={[
        progressViewStyle("circular"),
        tint(bone),
        font({ size: 9, design: "monospaced" }),
        monospacedDigit(),
        lineLimit(1),
        minimumScaleFactor(0.5),
        frame({ width: 26, height: 26 }),
        accessibilityLabel("Rest remaining"),
      ]}
    />
  ) : (
    <Text
      modifiers={[
        ...small,
        monospacedDigit(),
        minimumScaleFactor(0.7),
        accessibilityLabel(`${count} sets`),
      ]}
    >
      {count}
    </Text>
  );
  const elapsed = (
    <Text
      date={new Date(p.started)}
      dateStyle="timer"
      modifiers={[...small, monospacedDigit(), frame({ width: 62, alignment: "trailing" })]}
    />
  );
  const metric = resting ? (
    <Text timerInterval={interval} modifiers={big} />
  ) : (
    <Text modifiers={big}>{p.measurements || p.exercise}</Text>
  );
  const control = (label: string, target: string, color: string) => (
    <Button
      label={label}
      target={target}
      modifiers={[buttonStyle("borderedProminent"), tint(color)]}
    />
  );
  const open = (
    <Link
      destination={
        p.openUrl ??
        (p.finish ? "leve-preview:///workout/finish" : "leve-preview:///workout/active")
      }
      label={p.finish ? "Finish" : "Open"}
      modifiers={[foregroundStyle(orange)]}
    />
  );
  const restTicket = p.restKey ? `leveRest.${p.restKey}` : p.token;
  // Native timer actions can change the deadline without changing the set's ticket.
  const logTicket = p.token.split(".");
  if (logTicket.length === 5 && logTicket[0] === "leve1") logTicket[3] = String(p.restEnd);
  const controls = !p.interactive ? (
    open
  ) : resting ? (
    <HStack spacing={5}>
      {control("−15", `${restTicket}:less`, "#565C66")}
      {control("+15", `${restTicket}:more`, "#565C66")}
      {control("Skip", `${restTicket}:skip`, "#383D46")}
    </HStack>
  ) : p.canLog ? (
    control("Log", `${logTicket.join(".")}:log`, orange)
  ) : (
    open
  );
  const caption = resting ? `Up next · ${p.exercise}` : p.previous ? `Last ${p.previous}` : p.set;
  const details = (
    <VStack alignment="leading" spacing={3}>
      <Text modifiers={small}>{resting ? "REST" : p.exercise + (p.set ? ` · ${p.set}` : "")}</Text>
      {metric}
      <Text modifiers={small}>{caption}</Text>
    </VStack>
  );
  const progress = resting ? (
    <ProgressView timerInterval={interval} modifiers={[tint(ink)]} />
  ) : (
    <ProgressView value={fraction} modifiers={[tint(ink)]} />
  );
  return {
    compactLeading: disc,
    minimal: disc,
    // The set's values, or the next set's while resting: the ring already counts down.
    compactTrailing: <Text modifiers={[...small, minimumScaleFactor(0.65)]}>{p.compact}</Text>,
    expandedLeading: <Text modifiers={small}>{p.title}</Text>,
    expandedTrailing: elapsed,
    expandedBottom: (
      <HStack>
        {details}
        <Spacer />
        {controls}
      </HStack>
    ),
    banner: (
      <VStack
        alignment="leading"
        spacing={6}
        modifiers={[
          padding({ all: 14 }),
          // iOS can shift the activity's background tint on the Lock Screen (a bone tint came out
          // khaki), so paint the ground too. The tint stays for the system's own controls.
          background(ground),
          activityBackgroundTint(ground),
          foregroundStyle(ink),
          privacySensitive(),
        ]}
      >
        <HStack>
          {/* The wordmark's full stop is vermilion, as in the logo. */}
          <Text modifiers={[font({ weight: "bold", size: 14 })]}>
            Leve
            <Text modifiers={[foregroundStyle(orange)]}>.</Text>
          </Text>
          <Text modifiers={small}>{p.title}</Text>
          <Spacer />
          {elapsed}
        </HStack>
        <HStack>
          {details}
          <Spacer />
          {controls}
        </HStack>
        {progress}
        <HStack>
          <Text modifiers={small}>{`${count} sets`}</Text>
          <Spacer />
          <Text modifiers={small}>{p.volume}</Text>
        </HStack>
      </VStack>
    ),
    bannerSmall: (
      <VStack modifiers={[privacySensitive()]}>
        <Text modifiers={small}>{p.exercise}</Text>
        {metric}
      </VStack>
    ),
  };
}
export const workoutActivity = createLiveActivity("LeveWorkout", workoutLayout);
