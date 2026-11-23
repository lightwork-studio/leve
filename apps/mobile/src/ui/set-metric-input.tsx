import type { SetMetric } from "@leve/core";
import { TextInput, type TextInputProps } from "react-native";

export function SetMetricInput({ metric, ...props }: TextInputProps & { metric: SetMetric }) {
  return (
    <TextInput
      selectTextOnFocus
      returnKeyType="done"
      inputMode={
        metric === "duration"
          ? "text"
          : metric === "reps" || metric === "count"
            ? "numeric"
            : "decimal"
      }
      {...props}
    />
  );
}
