import type { JsonObject } from "@leve/contract";
import { type WeightUnit, weightFromKg } from "@leve/core";
import { useMemo, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppData } from "../src/data/app-data.tsx";
import { correctBodyweight, deleteBodyweight, recordBodyweight } from "../src/data/bodyweight.ts";
import { useProgress } from "../src/data/queries.ts";
import { measurementClock } from "../src/model/measurement-clock.ts";
import { lineAxis } from "../src/model/progress.ts";
import { font, gutter, numeral, radius, space, type } from "../src/theme.ts";
import { ActionSheet, DestructiveButton } from "../src/ui/action-sheet.tsx";
import { BackLink } from "../src/ui/back-link.tsx";
import { BodyweightEditor } from "../src/ui/bodyweight-editor.tsx";
import { BottomSheet } from "../src/ui/bottom-sheet.tsx";
import { Button } from "../src/ui/buttons.tsx";
import { EditorSyncReview, hasEditorConflict } from "../src/ui/editor-sync-review.tsx";
import { EmptyState } from "../src/ui/empty-state.tsx";
import { announce } from "../src/ui/focus.ts";
import { dayLabel, shortDay, timeLabel, weightValue } from "../src/ui/format.ts";
import { SectionLabel } from "../src/ui/group.tsx";
import { haptic } from "../src/ui/haptics.ts";
import { ChevronIcon, PlusIcon } from "../src/ui/icons.tsx";
import { LineChart } from "../src/ui/line-chart.tsx";
import { Banner, showToast } from "../src/ui/notice.tsx";
import { HeaderButton, TabTitle } from "../src/ui/screen.tsx";
import { Tap } from "../src/ui/tap.tsx";
import { themedStyles, useColors, useStyles } from "../src/ui/themed.ts";

export default function BodyweightHistory() {
  const styles = useStyles(sheet);
  const c = useColors();
  const { settings, measurements } = useProgress();
  const { store, change } = useAppData();
  const conflicts = store
    .problems()
    .filter((row) => row.kind === "body_measurement" && hasEditorConflict(row));
  const [editor, setEditor] = useState<{
    reading: (typeof measurements)[number] | null;
    unit: WeightUnit;
    reviewing?: boolean;
  } | null>(null);
  // The reading a long press asked to delete, with its whole record as it was then.
  const [deleting, setDeleting] = useState<{
    reading: (typeof measurements)[number];
    content: JsonObject;
  } | null>(null);
  const askToDelete = (reading: (typeof measurements)[number]) => {
    const content = store.get("body_measurement", reading.id)?.content;
    if (content) setDeleting({ reading, content });
  };
  const fat = deleting?.content.fatPercent;
  const reading = editor?.reading;
  const conflict = conflicts.find((row) => row.id === reading?.id);
  const reviewing = !!conflict && !!editor?.reviewing;
  const editorTitle = reading ? "Edit measurement" : "Record bodyweight";
  const unit = settings.weightUnit;
  const insets = useSafeAreaInsets();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = useMemo(() => measurementClock(zone), [zone]);
  const measurementTime = (at: number) => {
    const time = timeLabel(new Date(at).toISOString());
    const offset = clock.repeatedOffset(at);
    return offset ? `${time} (${offset})` : time;
  };
  const newestFirst = useMemo(() => measurements.slice().reverse(), [measurements]);
  const chart = useMemo(() => {
    const recent = measurements.slice(-30);
    const samples = new Map(recent.map(({ at, kg }) => [at, weightFromKg(kg, unit)]));
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last || first.at === last.at) return null;
    const span = last.at - first.at;
    const points = Array.from(samples, ([time, value]) => ({
      time,
      value,
      x: (time - first.at) / span,
    }));
    // The history lists weights to one decimal place. Give tiny changes a readable axis.
    const values = points.map((point) => point.value);
    const low = Math.floor(Math.min(...values) * 10) / 10;
    const high = Math.ceil(Math.max(...values) * 10) / 10;
    return {
      points,
      axis: lineAxis([low, high]),
      marks: [
        { x: 0, label: shortDay(first.at) },
        { x: 1, label: shortDay(last.at) },
      ],
      count: recent.length,
    };
  }, [measurements, unit]);
  const latest = measurements.at(-1);
  // How much it moved over the charted readings: the newest less the oldest.
  const oldest = chart?.points[0];
  const newest = chart?.points.at(-1);
  const drift = oldest && newest ? newest.value - oldest.value : null;
  // A reading that sync found another version of opens on the review of both versions.
  const openEditor = (reading: (typeof measurements)[number] | null) =>
    setEditor({
      reading,
      unit,
      reviewing: !!reading && conflicts.some((row) => row.id === reading.id),
    });
  return (
    <>
      <FlatList
        data={newestFirst}
        style={styles.page}
        contentContainerStyle={{
          paddingTop: insets.top + space.sm,
          paddingBottom: insets.bottom + space.lg,
        }}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <>
            <View style={styles.nav}>
              <BackLink label="Progress" fallback="/progress" />
              <HeaderButton label="Record bodyweight" onPress={() => openEditor(null)}>
                <PlusIcon color={c.fg2} size={19} strokeWidth={2} />
              </HeaderButton>
            </View>
            <View style={styles.titles}>
              <TabTitle title="Bodyweight" eyebrow="History" />
            </View>
            {conflicts.map((record) => (
              <View key={record.id} style={styles.review}>
                <EditorSyncReview record={record} />
              </View>
            ))}
            {latest && (
              <View style={styles.card}>
                <View style={styles.gauge}>
                  <Text style={[styles.label, styles.strong]}>
                    Latest · {dayLabel(new Date(latest.at).toISOString())} ·{" "}
                    {measurementTime(latest.at)}
                  </Text>
                  <Text style={styles.gaugeNumber}>
                    {weightValue(latest.kg, unit)}
                    <Text style={styles.gaugeUnit}> {unit}</Text>
                  </Text>
                  {chart && drift !== null && (
                    <Text style={styles.delta}>
                      {drift > 0 ? "▲" : drift < 0 ? "▼" : "±"}{" "}
                      {Math.abs(drift).toLocaleString(undefined, { maximumFractionDigits: 1 })}{" "}
                      {unit} over the last {chart.count} measurements
                    </Text>
                  )}
                </View>
                {chart && (
                  <View style={styles.chart}>
                    <LineChart
                      points={chart.points}
                      axis={chart.axis}
                      marks={chart.marks}
                      tickLabel={(n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      accessibilityLabel={`Bodyweight in ${unit} over the last ${chart.count} measurements. Individual readings follow.`}
                    />
                  </View>
                )}
              </View>
            )}
            {newestFirst.length > 0 && (
              <View style={styles.readingsHead}>
                <SectionLabel aside={String(newestFirst.length)} header>
                  {READINGS}
                </SectionLabel>
              </View>
            )}
          </>
        }
        ListEmptyComponent={
          <EmptyState
            label="Bodyweight"
            title="No bodyweight recorded yet."
            text="Record one to see how it changes over time."
            action={<Button label="Record bodyweight" onPress={() => openEditor(null)} />}
          />
        }
        renderItem={({ item, index }) => {
          const iso = new Date(item.at).toISOString();
          const time = measurementTime(item.at);
          return (
            <Tap
              style={[
                styles.row,
                index === 0 && styles.rowFirst,
                index === newestFirst.length - 1 && styles.rowLast,
                index > 0 && styles.divider,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Edit bodyweight for ${dayLabel(iso)} at ${time}, ${weightValue(item.kg, unit)} ${unit}`}
              // Holding a reading offers to delete it; screen readers get that as an action.
              accessibilityActions={[{ name: "delete", label: "Delete measurement" }]}
              onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === "delete") askToDelete(item);
              }}
              scaleTo={0.98}
              onPress={() => openEditor(item)}
              onLongPress={() => {
                haptic.select();
                askToDelete(item);
              }}
            >
              <View style={styles.date}>
                <Text style={styles.day}>{dayLabel(iso)}</Text>
                <Text style={styles.time}>{time}</Text>
              </View>
              <Text style={styles.value}>{`${weightValue(item.kg, unit)} ${unit}`}</Text>
              <ChevronIcon size={16} strokeWidth={2} color={c.fg3} />
            </Tap>
          );
        }}
      />
      {deleting && (
        <ActionSheet
          message={`The ${weightValue(deleting.reading.kg, unit)} ${unit} reading from ${dayLabel(new Date(deleting.reading.at).toISOString())} at ${measurementTime(deleting.reading.at)}${typeof fat === "number" ? `, with ${fat.toLocaleString()}% body fat,` : ""} will be deleted.`}
          action="Delete measurement"
          keep="Keep measurement"
          onConfirm={() => {
            setDeleting(null);
            try {
              change((store) => deleteBodyweight(store, deleting.reading.id, deleting.content));
            } catch (cause) {
              // A toast shows wherever the list is scrolled to, and reads the reason out.
              haptic.warning();
              showToast((cause as Error).message);
              return;
            }
            haptic.tap();
            announce("Measurement deleted");
          }}
          onClose={() => setDeleting(null)}
        />
      )}
      {editor && (
        <BottomSheet
          title={editorTitle}
          {...(reading
            ? {
                eyebrow: `${dayLabel(new Date(reading.at).toISOString())} · ${measurementTime(reading.at)}`,
              }
            : {})}
          {...(reviewing ? { close: "x" as const, closeLabel: "Close review" } : {})}
          onClose={() => setEditor(null)}
        >
          {conflict && reviewing ? (
            <EditorSyncReview record={conflict} onResolved={() => setEditor(null)} />
          ) : (
            <>
              {conflict && (
                <View style={styles.conflict}>
                  <Banner label="Sync" message="Sync found another version of this measurement." />
                  <DestructiveButton
                    label="Discard draft and review versions"
                    message="The value you typed will be lost. Then you can choose which saved version to keep."
                    action="Discard draft"
                    keep="Keep editing"
                    onConfirm={() => setEditor({ ...editor, reviewing: true })}
                  />
                </View>
              )}
              <BodyweightEditor
                inSheet
                label={reading ? "Recorded bodyweight" : "Today's bodyweight"}
                unit={editor.unit}
                initialText={reading ? String(weightFromKg(reading.kg, editor.unit)) : undefined}
                onCancel={() => setEditor(null)}
                onSave={(text, measuredAt) => {
                  change((store) => {
                    if (reading) correctBodyweight(store, reading, text, editor.unit);
                    else recordBodyweight(store, text, editor.unit, measuredAt);
                  });
                  setEditor(null);
                }}
              />
            </>
          )}
        </BottomSheet>
      )}
    </>
  );
}

/** The readings group's label. */
const READINGS = "Readings";

const sheet = themedStyles((c) => ({
  page: { flex: 1, backgroundColor: c.bg },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: gutter.group,
    paddingBottom: space.sm,
  },
  titles: { paddingHorizontal: gutter.screen, paddingTop: 2, paddingBottom: 18 },
  review: { marginHorizontal: gutter.group, marginBottom: space.md },
  conflict: { gap: space.sm, marginBottom: space.md },
  label: { ...type.label, color: c.fg3 },
  strong: { color: c.fg },
  card: {
    marginHorizontal: gutter.group,
    marginBottom: 22,
    backgroundColor: c.s1,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: radius.card,
    overflow: "hidden",
  },
  gauge: { paddingTop: 16, paddingHorizontal: 16, paddingBottom: 2 },
  gaugeNumber: { ...numeral(66), color: c.fg, marginTop: 11 },
  gaugeUnit: { ...font.mono, fontSize: 13, letterSpacing: 0.5, color: c.fg3 },
  delta: { ...type.meta, fontSize: 11.5, color: c.fg2, marginTop: 11 },
  chart: { paddingTop: 8, paddingHorizontal: 16, paddingBottom: 10 },
  readingsHead: { paddingHorizontal: gutter.group + 6, paddingBottom: 9 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    marginHorizontal: gutter.group,
    paddingVertical: 10,
    paddingHorizontal: space.lg,
    backgroundColor: c.s1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: c.line,
  },
  rowFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
  },
  rowLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
  },
  divider: { borderTopWidth: 1, borderTopColor: c.line },
  date: { flex: 1, minWidth: 0 },
  day: { ...type.rowTitle, fontSize: 14.5, color: c.fg },
  time: { ...type.meta, color: c.fg3, marginTop: 4 },
  value: { ...numeral(24, "300"), color: c.fg },
}));
