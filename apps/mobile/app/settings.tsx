import Constants from "expo-constants";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { buildInfo } from "../src/build-info.ts";
import { useAppData } from "../src/data/app-data.tsx";
import {
  type AppearanceSetting,
  saveAppearanceSetting,
  useAppearanceSetting,
} from "../src/data/appearance-setting.ts";
import { useOptimisticSettings } from "../src/data/optimistic-settings.ts";
import { readSettings } from "../src/data/read.ts";
import { saveRestAlertSetting, useRestAlertSetting } from "../src/data/rest-alert-setting.ts";
import {
  type Choice,
  DISTANCE_CHOICES,
  MEASUREMENT_CHOICES,
  PREVIOUS_CHOICES,
  REST_CHOICES,
  restLabel,
  SHORT_DISTANCE_CHOICES,
  type StoredSettings,
  startAgain,
  stepChoice,
  WEEKDAY_CHOICES,
  WEIGHT_CHOICES,
} from "../src/data/settings-actions.ts";
import { saveShowTargets, useShowTargets } from "../src/data/show-targets.ts";
import { canChangeTrackRir, useTrackRir } from "../src/data/track-rir.ts";
import { restAlertNative } from "../src/rest-alert/native";
import { DENIED_MESSAGE, useNotificationsBlocked } from "../src/rest-alert/rest-alert-host";
import { turnOnRestAlert } from "../src/rest-alert/rest-alerts.ts";
import { pairingLinkFrom } from "../src/sync/own-server.ts";
import { ownServerAvailable, syncEnabled } from "../src/sync/sync-config.ts";
// Without an extension, so browsers get the version without sync or sign-in.
import { SyncServerSection } from "../src/sync/sync-server-section";
import { font, gutter, numeral, radius, space, type } from "../src/theme.ts";
import { ActionSheet, useConfirmation } from "../src/ui/action-sheet.tsx";
import { ActionRow, ChoiceRow, Stepper, ToggleRow } from "../src/ui/choice-row.tsx";
import { Enter, StillOnOpen } from "../src/ui/enter.tsx";
import { announce } from "../src/ui/focus.ts";
import { Group } from "../src/ui/group.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { RestDialog } from "../src/ui/live/rest-dialog.tsx";
import { Banner } from "../src/ui/notice.tsx";
import { BackButton, TabTitle } from "../src/ui/screen.tsx";
import { Tap } from "../src/ui/tap.tsx";
import { themedStyles, useStyles } from "../src/ui/themed.ts";
import { clock } from "../src/ui/use-ticker.ts";
import { Wordmark } from "../src/ui/wordmark.tsx";

/** Extra space under the rows while a problem banner is pinned over the bottom of the screen. */
const PROBLEM_ROOM = 112;

const VERSION = Constants.expoConfig?.version ?? "unknown";
/** The about line: its text size, and the logo at roughly that text's cap height. */
const ABOUT_SIZE = 10.5;
const ABOUT_CAP_HEIGHT = ABOUT_SIZE * 0.76;

/** How far into its rest the preview is drawn, as a share of the whole. */
const PREVIEW_SHARE = 0.62;

/**
 * Each unit as a sample reading: one fixed measurement shown in the unit chosen, so the card reads
 * the way the app will. Tapping it switches to the other unit.
 */
const READINGS = [
  {
    key: "weightUnit",
    label: "Weight",
    choices: WEIGHT_CHOICES,
    sample: { kg: "82.4", lbs: "181.7" },
  },
  {
    key: "distanceUnit",
    label: "Distance",
    choices: DISTANCE_CHOICES,
    sample: { km: "5.0", miles: "3.1" },
  },
  {
    key: "shortDistanceUnit",
    label: "Short distance",
    choices: SHORT_DISTANCE_CHOICES,
    sample: { m: "400", yd: "437" },
  },
  {
    key: "measurementUnit",
    label: "Measurements",
    choices: MEASUREMENT_CHOICES,
    sample: { cm: "38", in: "15.0" },
  },
] as const satisfies readonly {
  key: keyof StoredSettings;
  label: string;
  choices: readonly Choice<string>[];
  sample: Record<string, string>;
}[];

const APPEARANCE_CHOICES: readonly Choice<AppearanceSetting>[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function SettingsScreen() {
  // Builds that sync never load made-up workouts: they would go up to the signed-in account.
  // Nor builds that could pair a server of the person's own.
  const seedsSample = buildInfo.sampleData && !syncEnabled() && !ownServerAvailable();
  const sampleOnRequest = buildInfo.sampleDataOnRequest && !syncEnabled() && !ownServerAvailable();
  const styles = useStyles(sheet);
  const { store, change, reset } = useAppData();
  const optimistic = useOptimisticSettings(store);
  // The optimistic draft can settle before the provider's version update is rendered.
  const committed = readSettings(store);
  const settings = { ...committed, ...optimistic.patch };
  const insets = useSafeAreaInsets();
  // A pairing link that opened the app (app/connect.tsx) arrives as these.
  const linked = useLocalSearchParams<{ server?: string; code?: string; opened?: string }>();
  // A new object each time a link is opened, even the same link, so the dialog asks again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `opened` marks each opening
  const pairing = useMemo(
    () => pairingLinkFrom(linked.server, linked.code),
    [linked.server, linked.code, linked.opened],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [trackRir, setTrackRir] = useTrackRir();
  const showTargets = useShowTargets();
  const restAlert = useRestAlertSetting();
  const notificationsBlocked = useNotificationsBlocked();
  const appearance = useAppearanceSetting();
  const buildDetails = [
    `version ${VERSION}`,
    buildInfo.releaseNumber && `release ${buildInfo.releaseNumber}`,
    `build ${buildInfo.label}`,
    buildInfo.commit,
  ].filter(Boolean);

  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

  /**
   * Shows what went wrong where it can be seen whichever row caused it, in a banner pinned to the
   * bottom of the screen, and reads it out (iOS doesn't announce an alert by itself).
   */
  const showProblem = (message: string) => {
    haptic.warning();
    setProblem(message);
    announce(message);
  };

  const queue = (edit: Parameters<typeof optimistic.enqueue>[0]) => {
    if (
      optimistic.enqueue(edit, change, (message) => {
        haptic.warning();
        announce(message);
      })
    ) {
      haptic.select();
      setProblem(null);
    }
  };
  const save = (patch: NonNullable<typeof optimistic.patch>) => queue(() => patch);

  const startOver = (sampleData: boolean) => async () => {
    const failed = await startAgain(() => reset(sampleData));
    if (failed) showProblem(failed);
    else {
      // Synced settings, Track RIR among them, went with the deleted data. The appearance is kept
      // on this device alone, so it starts again here.
      saveAppearanceSetting("system");
      haptic.success();
    }
  };
  const fresh = useConfirmation(startOver(seedsSample));
  // TestFlight starts empty, but can be filled with the made-up data to try things out.
  const sample = useConfirmation(startOver(true));

  const rest = settings.defaultRestSeconds;
  const stepRest = (direction: -1 | 1) =>
    queue((pending) => {
      const next = stepChoice(
        REST_CHOICES,
        pending.defaultRestSeconds ?? committed.defaultRestSeconds,
        direction,
      );
      return next === null ? null : { defaultRestSeconds: next };
    });
  const saveProblem = problem ?? optimistic.problem;

  return (
    <StillOnOpen>
      <View style={styles.screen}>
        <ScrollView
          style={styles.fill}
          contentContainerStyle={{
            paddingTop: insets.top + space.sm,
            // Room to scroll the last rows clear of a problem banner.
            paddingBottom: insets.bottom + space.xxl + (saveProblem ? PROBLEM_ROOM : 0),
          }}
        >
          <View style={styles.nav}>
            <BackButton label="Train" accessibilityLabel="Back to Train" onPress={back} />
          </View>
          <View style={styles.titles}>
            <TabTitle title="Settings" eyebrow="Leve · on this device" />
          </View>

          {/* Values shown on opening are simply there; only later changes animate. */}
          <StillOnOpen>
            <SyncServerSection link={pairing} />

            <Group
              label="Reads as"
              aside="Tap to switch"
              footnote="Stored values stay exact. Only what is shown converts."
            >
              <View style={styles.readings}>
                {READINGS.map((reading, i) => {
                  const unit = settings[reading.key];
                  const other = reading.choices.find((choice) => choice.value !== unit);
                  const sample = reading.sample[unit as keyof typeof reading.sample];
                  return (
                    <Tap
                      key={reading.key}
                      accessibilityRole="button"
                      accessibilityLabel={`${reading.label} in ${unit}`}
                      accessibilityHint={other ? `Switches to ${other.label}` : undefined}
                      onPress={() =>
                        queue((pending) => {
                          const current = pending[reading.key] ?? committed[reading.key];
                          const choice = reading.choices.find((item) => item.value !== current);
                          return choice ? { [reading.key]: choice.value } : null;
                        })
                      }
                      scaleTo={0.98}
                      style={[
                        styles.reading,
                        i % 2 === 1 && styles.readingRight,
                        i >= 2 && styles.readingLower,
                      ]}
                    >
                      <Text style={styles.label}>{reading.label}</Text>
                      <Text style={styles.readingNumber} numberOfLines={1}>
                        {sample}
                        <Text style={styles.unit}> {unit}</Text>
                      </Text>
                      <Text style={styles.readingAlt} numberOfLines={1}>
                        or {other?.label}
                      </Text>
                    </Tap>
                  );
                })}
              </View>
            </Group>

            <Group label="Display">
              <ChoiceRow
                label="Appearance"
                hint="Choose a theme or match your device"
                value={appearance}
                choices={APPEARANCE_CHOICES}
                onChoose={(value) => {
                  saveAppearanceSetting(value);
                  haptic.select();
                }}
              />
            </Group>

            <Group label="Rest timer">
              <View style={styles.restRow}>
                <View style={styles.rowText}>
                  <Text style={styles.rowLabel}>Default rest</Text>
                  <Text style={styles.rowHint}>For exercises you add to a workout</Text>
                </View>
                <RestStepper
                  seconds={rest}
                  onStep={stepRest}
                  onChoose={(seconds) => save({ defaultRestSeconds: seconds })}
                />
              </View>
              {rest > 0 && <RestPreview seconds={rest} />}
              {restAlertNative && (
                <ToggleRow
                  label="Alert when rest ends"
                  hint={
                    restAlert === "on" && notificationsBlocked
                      ? DENIED_MESSAGE
                      : "On this iPhone and a paired Apple Watch"
                  }
                  on={restAlert === "on" && !notificationsBlocked}
                  onChange={(on) => {
                    haptic.select();
                    if (!on) return saveRestAlertSetting(false);
                    const native = restAlertNative;
                    if (!native) return;
                    void turnOnRestAlert(native, saveRestAlertSetting)
                      .then((granted) => {
                        if (!granted) showProblem(DENIED_MESSAGE);
                      })
                      .catch(() => showProblem(DENIED_MESSAGE));
                  }}
                  divider
                />
              )}
            </Group>

            <Group
              label="More"
              footnote={
                seedsSample
                  ? "This preview keeps made-up workouts on this device only. Starting again deletes everything here, including your settings, and brings the made-up data back."
                  : sampleOnRequest
                    ? "Deleting everything removes your workouts and settings from this device. Leve then starts empty, or with made-up workouts when you start again with sample data."
                    : "Deleting everything removes your workouts and settings from this device. Leve then starts empty."
              }
            >
              <ChoiceRow
                label="Previous values"
                hint="Last time's values, shown while logging"
                value={settings.previousValues}
                choices={PREVIOUS_CHOICES}
                onChoose={(value) => save({ previousValues: value })}
              />
              {/* Hidden while the connected server can't keep the setting. */}
              {canChangeTrackRir(store) && (
                <ToggleRow
                  label="Ask for effort"
                  hint="An optional prompt after each working set"
                  on={trackRir}
                  onChange={(on) => {
                    try {
                      setTrackRir(on);
                      haptic.select();
                      setProblem(null);
                    } catch (error) {
                      showProblem((error as Error).message);
                    }
                  }}
                  divider
                />
              )}
              <ToggleRow
                label="Show targets"
                hint="Routine goals under set values, weight until first logged"
                on={showTargets}
                onChange={saveShowTargets}
                divider
              />
              <ToggleRow
                label="Warm-ups in stats"
                hint="Count warm-up sets in volume and set totals"
                on={settings.countWarmups}
                onChange={() =>
                  queue((pending) => ({
                    countWarmups: !(pending.countWarmups ?? committed.countWarmups),
                  }))
                }
                divider
              />
              <ChoiceRow
                label="Week starts on"
                value={settings.firstWeekday as StoredSettings["firstWeekday"]}
                choices={WEEKDAY_CHOICES}
                onChoose={(value) => save({ firstWeekday: value })}
                divider
              />
              <ActionRow
                label={
                  seedsSample
                    ? "Start again with fresh preview data"
                    : "Delete everything on this device"
                }
                danger
                divider
                accessibilityHint="Asks before it does anything"
                onPress={() => {
                  haptic.warning();
                  fresh.ask();
                }}
              />
              {sampleOnRequest && (
                <ActionRow
                  label="Start again with sample data"
                  danger
                  divider
                  accessibilityHint="Asks before it does anything"
                  onPress={() => {
                    haptic.warning();
                    sample.ask();
                  }}
                />
              )}
            </Group>

            <Text style={styles.about} accessibilityLabel={`Leve, ${buildDetails.join(", ")}`}>
              <Wordmark capHeight={ABOUT_CAP_HEIGHT} />
              {` · ${buildDetails.join(" · ")}`}
            </Text>
          </StillOnOpen>
        </ScrollView>

        <View
          style={[styles.problemDock, { bottom: insets.bottom + space.md }]}
          pointerEvents="box-none"
        >
          {saveProblem && (
            <Enter leaves>
              <Banner
                label="Not saved"
                message={saveProblem}
                onDismiss={() => {
                  setProblem(null);
                  optimistic.dismiss();
                }}
              />
            </Enter>
          )}
        </View>

        {fresh.asking && (
          <ActionSheet
            message={
              seedsSample
                ? "Everything on this device, including your settings, will be deleted and the made-up preview data brought back."
                : "Everything on this device, including your workouts and settings, will be deleted. Leve then starts empty."
            }
            action="Delete and start again"
            keep="Keep my data"
            busy={fresh.busy}
            busyLabel="Starting again…"
            onConfirm={fresh.confirm}
            onClose={fresh.cancel}
          />
        )}
        {sample.asking && (
          <ActionSheet
            message="Everything on this device, including your workouts and settings, will be deleted and made-up sample workouts loaded in their place."
            action="Delete and load sample data"
            keep="Keep my data"
            busy={sample.busy}
            busyLabel="Starting again…"
            onConfirm={sample.confirm}
            onClose={sample.cancel}
          />
        )}
      </View>
    </StillOnOpen>
  );
}

/** The rest times offered at a tap in the rest dialog, shortest first; Off follows them. */
const REST_PRESETS = REST_CHOICES.map((choice) => choice.value).filter((seconds) => seconds > 0);

/** The default rest as a stepper through the offered times; its value opens the rest dialog. */
function RestStepper({
  seconds,
  onStep,
  onChoose,
}: {
  seconds: number;
  onStep: (direction: -1 | 1) => void;
  onChoose: (seconds: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Stepper
        label="Default rest"
        value={seconds === 0 ? "Off" : clock(seconds)}
        onStep={onStep}
        canDecrease={stepChoice(REST_CHOICES, seconds, -1) !== null}
        canIncrease={stepChoice(REST_CHOICES, seconds, 1) !== null}
        onPressValue={() => setOpen(true)}
        valueHint={`${restLabel(seconds)}. Opens the rest dialog`}
      />
      {open && (
        <RestDialog
          title="Default rest"
          note="For exercises you add to a workout"
          initialSeconds={seconds}
          presets={REST_PRESETS}
          onClose={() => setOpen(false)}
          onSet={(chosen) => {
            setOpen(false);
            if (chosen !== seconds) onChoose(chosen);
          }}
        />
      )}
    </View>
  );
}

/** What the rest timer will look like, part way through the default rest. Only a picture. */
function RestPreview({ seconds }: { seconds: number }) {
  const styles = useStyles(sheet);
  const left = Math.round(seconds * PREVIEW_SHARE);
  return (
    <View
      style={styles.previewRow}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
    >
      <View style={styles.preview}>
        <View style={[styles.previewFill, { width: `${PREVIEW_SHARE * 100}%` }]} />
        <View style={styles.previewText}>
          <Text style={styles.previewLabel}>Preview · {clock(seconds)}</Text>
          <Text style={styles.previewTime}>{clock(left)}</Text>
        </View>
        <View style={styles.previewButton}>
          <Text style={styles.previewButtonText}>−15</Text>
        </View>
        <View style={[styles.previewButton, styles.previewSkip]}>
          <Text style={[styles.previewButtonText, styles.previewSkipText]}>Skip</Text>
        </View>
      </View>
    </View>
  );
}

const sheet = themedStyles((c) => ({
  fill: { flex: 1, backgroundColor: c.bg },
  screen: { flex: 1, backgroundColor: c.bg },
  nav: { flexDirection: "row", paddingHorizontal: gutter.group, paddingBottom: space.sm },
  titles: { paddingHorizontal: gutter.screen, paddingTop: 2, paddingBottom: 18 },
  problemDock: { position: "absolute", left: 12, right: 12 },
  label: { ...type.label, color: c.fg3 },
  readings: { flexDirection: "row", flexWrap: "wrap" },
  reading: {
    width: "50%",
    paddingTop: 14,
    paddingBottom: 13,
    paddingLeft: 16,
    paddingRight: 14,
  },
  readingRight: { borderLeftWidth: 1, borderLeftColor: c.line },
  readingLower: { borderTopWidth: 1, borderTopColor: c.line },
  readingNumber: { ...numeral(34), color: c.fg, marginTop: 10 },
  unit: { ...type.unit, color: c.fg3 },
  readingAlt: { ...font.mono, fontSize: 10.5, color: c.fg3, marginTop: 6 },
  restRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 54,
    paddingVertical: 9,
    paddingLeft: 16,
    paddingRight: 14,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { ...type.body, fontSize: 14.5, lineHeight: 19, color: c.fg },
  rowHint: { ...type.meta, fontSize: 10, lineHeight: 14, color: c.fg3, marginTop: 2 },
  previewRow: { paddingTop: 4, paddingHorizontal: 12, paddingBottom: 12 },
  preview: {
    height: 70,
    borderRadius: radius.card,
    backgroundColor: c.rest.bg,
    overflow: "hidden",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 18,
    paddingRight: 10,
  },
  previewFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: c.rest.fill,
  },
  previewText: { flex: 1, minWidth: 0 },
  previewLabel: { ...type.label, color: c.rest.ink2 },
  previewTime: { ...numeral(36), color: c.rest.ink, marginTop: 4 },
  previewButton: {
    height: 48,
    minWidth: 50,
    paddingHorizontal: 9,
    borderRadius: radius.button,
    backgroundColor: c.rest.button,
    alignItems: "center",
    justifyContent: "center",
  },
  previewSkip: { minWidth: 64, backgroundColor: c.rest.skip },
  previewButtonText: { ...font.monoSemi, fontSize: 11, letterSpacing: 0.66, color: c.rest.ink },
  previewSkipText: { ...type.action, color: c.rest.skipInk },
  about: {
    ...font.mono,
    fontSize: ABOUT_SIZE,
    lineHeight: 17,
    color: c.fg3,
    paddingHorizontal: 22,
  },
}));
