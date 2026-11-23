import { Button, Gauge, HStack, Link, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  activityBackgroundTint,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  gaugeStyle,
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
  const paper = resting || env.colorScheme === "light";
  const ink = paper ? graphite : bone;
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
  const ring = (
    <Gauge
      value={fraction}
      modifiers={[
        gaugeStyle("circularCapacity"),
        tint(bone),
        frame({ width: 22, height: 22 }),
        accessibilityLabel(`${count} sets`),
        privacySensitive(),
      ]}
    />
  );
  const disc = resting ? (
    <ProgressView
      timerInterval={interval}
      modifiers={[
        progressViewStyle("circular"),
        tint(bone),
        frame({ width: 22, height: 22 }),
        accessibilityLabel("Rest remaining"),
      ]}
    />
  ) : (
    ring
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
  const control = (label: string, action: string, color: string) => (
    <Button
      label={label}
      target={`${p.token}:${action}`}
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
  const controls = !p.interactive ? (
    open
  ) : resting ? (
    <HStack spacing={5}>
      {control("−15", "less", "#565C66")}
      {control("+15", "more", "#565C66")}
      {control("Skip", "skip", "#383D46")}
    </HStack>
  ) : p.canLog ? (
    control("Log", "log", orange)
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
    compactTrailing: resting ? (
      <Text
        timerInterval={interval}
        modifiers={[...small, monospacedDigit(), frame({ width: 44 })]}
      />
    ) : (
      <Text modifiers={[...small, minimumScaleFactor(0.65)]}>{p.compact}</Text>
    ),
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
          activityBackgroundTint(paper ? bone : graphite),
          foregroundStyle(ink),
          privacySensitive(),
        ]}
      >
        <HStack>
          <Text modifiers={[font({ weight: "bold", size: 14 })]}>Leve.</Text>
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
