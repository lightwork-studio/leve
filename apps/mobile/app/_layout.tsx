import { StatusBar } from "expo-status-bar";
import { useLayoutEffect, useRef, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
// Without an extension, so browsers get the version without sign-in.
import { AccountProvider } from "../src/account/account-provider";
import { UnavailableWorkoutActivity, WorkoutActivityHost } from "../src/activity/workout-activity";
import { buildInfo } from "../src/build-info.ts";
import { AppDataProvider, useAppData } from "../src/data/app-data.tsx";
// Without an extension, so browsers get the version without sync.
import { SyncHost } from "../src/sync/sync-host";
import { SyncLineLayout } from "../src/sync/sync-note.tsx";
import { gutter, space, type } from "../src/theme.ts";
import { Button } from "../src/ui/buttons.tsx";
import { EmptyState } from "../src/ui/empty-state.tsx";
import { Banner, ToastHost } from "../src/ui/notice.tsx";
// Without an extension, so each platform gets its own file (stack.web.tsx in browsers).
import { AppStack } from "../src/ui/stack";
import { themedStyles, useAppearance, useColors, useStyles } from "../src/ui/themed.ts";

/**
 * Behind every screen in a browser: the ground colour, so nothing between screens flashes, and
 * the page's own colour scheme (scroll bars, form controls) to match.
 */
function usePageColors() {
  const c = useColors();
  const appearance = useAppearance();
  useLayoutEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    document.documentElement.style.backgroundColor = c.bg;
    document.documentElement.style.colorScheme = appearance === "paper" ? "light" : "dark";
    document.body.style.backgroundColor = c.bg;
  }, [c, appearance]);
}

export default function RootLayout() {
  const styles = useStyles(sheet);
  const appearance = useAppearance();
  usePageColors();
  const blank = <View style={styles.fill} />;
  return (
    <SafeAreaProvider>
      {/* Dark status bar text on paper, light text on graphite. */}
      <StatusBar style={appearance === "paper" ? "dark" : "light"} />
      {buildInfo.webDemo && typeof window !== "undefined" && window.parent === window ? (
        <Text style={styles.demoNotice}>
          Sample workouts. Changes reset when you leave the demo.
        </Text>
      ) : null}
      <AccountProvider>
        <AppDataProvider
          loading={blank}
          failed={(message, exportRecovery) => (
            <>
              <UnavailableWorkoutActivity />
              <Recovery message={message} exportRecovery={exportRecovery} />
            </>
          )}
        >
          <WorkoutActivityHost />
          <SaveProblemBanner />
          <SyncHost />
          <AppStack
            // Sync's note, as a line at the top of every screen that doesn't show it itself.
            layout={SyncLineLayout}
            screens={[
              { name: "(tabs)", transition: "push" },
              { name: "bodyweight", transition: "push" },
              { name: "workout/[id]", transition: "push" },
              { name: "workout/active", transition: "cover", transparent: true },
              { name: "workout/notes/[id]", transition: "push" },
              { name: "workout/finish", transition: "cover" },
              { name: "exercises", transition: "push" },
              { name: "exercise/[id]", transition: "push" },
              { name: "settings", transition: "push" },
              { name: "connect", transition: "push" },
            ]}
          />
          <ToastHost />
        </AppDataProvider>
      </AccountProvider>
    </SafeAreaProvider>
  );
}

function Recovery({
  message,
  exportRecovery,
}: {
  message: string;
  exportRecovery: (() => Promise<void>) | null;
}) {
  const styles = useStyles(sheet);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const inProgress = useRef(false);
  const saveCopy = async () => {
    if (!exportRecovery || inProgress.current) return;
    inProgress.current = true;
    setBusy(true);
    setStatus("Exporting…");
    try {
      await exportRecovery();
      setStatus(
        Platform.OS === "web"
          ? "Download requested. Check your downloads."
          : "Recovery copy saved.",
      );
    } catch (error) {
      setStatus(`Export did not finish. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inProgress.current = false;
      setBusy(false);
    }
  };
  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.failed}>
      <EmptyState
        label="Leve couldn't open its data"
        title="Something is wrong with this device's copy"
        text={message}
        action={
          exportRecovery ? (
            <View style={styles.recovery}>
              <Text style={styles.recoveryText}>
                Export your database files for safekeeping, then try opening them with an updated
                version of Leve.
              </Text>
              <Button label="Export recovery copy" busy={busy} onPress={saveCopy} />
              {status ? (
                <Text accessibilityLiveRegion="polite" style={styles.recoveryText}>
                  {status}
                </Text>
              ) : null}
            </View>
          ) : undefined
        }
      />
    </ScrollView>
  );
}

/** Says so when changes can't be saved, instead of losing them quietly. */
function SaveProblemBanner() {
  const styles = useStyles(sheet);
  const { saveProblem } = useAppData();
  const insets = useSafeAreaInsets();
  if (!saveProblem) return null;
  return (
    <View style={[styles.bannerDock, { paddingTop: insets.top + space.sm }]}>
      <Banner
        label="Not saving"
        message={`Changes aren't being saved in this browser (${saveProblem}). Leve keeps trying.`}
      />
    </View>
  );
}

const sheet = themedStyles((c) => ({
  demoNotice: {
    ...type.label,
    padding: space.sm,
    backgroundColor: c.s1,
    color: c.fg2,
    textAlign: "center",
  },
  bannerDock: {
    paddingHorizontal: gutter.group - 2,
    paddingBottom: space.sm,
    backgroundColor: c.bg,
  },
  fill: { flex: 1, backgroundColor: c.bg },
  failed: { flexGrow: 1, justifyContent: "center", paddingVertical: space.xxl },
  recovery: { alignItems: "center", gap: space.md },
  recoveryText: { ...type.body, fontSize: 14, lineHeight: 21, color: c.fg2, textAlign: "center" },
}));
