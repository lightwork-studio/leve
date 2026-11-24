import { type ReactElement, type Ref, useMemo } from "react";
import { FlatList, type FlatListProps, View } from "react-native";
import type { ExerciseSection } from "../model/muscle-map.ts";
import { space } from "../theme.ts";
import { SectionLabel } from "./group.tsx";

type ResultRow<T> =
  | { kind: "heading"; key: string; title: string; count: number }
  | { kind: "exercise"; key: string; exercise: T; first: boolean; last: boolean }
  | { kind: "gap"; key: string };

type ExerciseRow<T> = Extract<ResultRow<T>, { kind: "exercise" }>;

export type ExerciseResultsList<T> = FlatList<ResultRow<T>>;

type ExerciseResultsProps<T> = Omit<
  FlatListProps<ResultRow<T>>,
  "data" | "renderItem" | "keyExtractor"
> & {
  sections: ExerciseSection<T>[];
  exerciseKey: (exercise: T) => string;
  renderExercise: (row: ExerciseRow<T>) => ReactElement;
  sectionGap?: number;
  ref?: Ref<ExerciseResultsList<T>>;
};

/** Keep a result's row mounted when it moves between the primary, secondary and unfiltered groups. */
export function ExerciseResults<T>({
  sections,
  exerciseKey,
  renderExercise,
  sectionGap = space.lg,
  ref,
  ...props
}: ExerciseResultsProps<T>) {
  const data = useMemo(() => {
    const rows: ResultRow<T>[] = [];
    for (const { key, title, data } of sections) {
      if (!data.length) continue;
      if (title) rows.push({ kind: "heading", key: `heading:${key}`, title, count: data.length });
      data.forEach((exercise, index) => {
        rows.push({
          kind: "exercise",
          key: `exercise:${exerciseKey(exercise)}`,
          exercise,
          first: index === 0,
          last: index === data.length - 1,
        });
      });
      rows.push({ kind: "gap", key: `gap:${key}` });
    }
    return rows;
  }, [sections, exerciseKey]);

  return (
    <FlatList
      {...props}
      ref={ref}
      data={data}
      keyExtractor={(row) => row.key}
      // Keep two screens of SVG thumbnails on either side of the visible rows.
      windowSize={5}
      renderItem={({ item }) => {
        switch (item.kind) {
          case "heading":
            return (
              <View style={headingStyle}>
                <SectionLabel aside={String(item.count)} header>
                  {item.title}
                </SectionLabel>
              </View>
            );
          case "gap":
            return <View style={{ height: sectionGap }} />;
          case "exercise":
            return renderExercise(item);
        }
      }}
    />
  );
}

const headingStyle = { paddingHorizontal: 6, paddingBottom: 9 };
