import type { AppearanceSetting } from "../data/appearance-setting.ts";
import type { useWorkoutPlayer } from "../ui/live/use-workout-player.ts";
import type { ActivityFrame } from "./session.ts";

// Keep user-entered strings within ActivityKit's 4 KB payload limit.
const short = (text: string, length = 70) => Array.from(text).slice(0, length).join("");
export function workoutFrame(
  player: ReturnType<typeof useWorkoutPlayer>,
  now: number,
  interactive: boolean,
  appearance: AppearanceSetting,
): ActivityFrame | null {
  const rest = player?.rest;
  if (player) {
    const { tree, target, progress, store } = player;
    const activeRest = rest && rest.endsAt > now ? rest : null;
    const version = target && store.editVersion("workout_set", target.set.id);
    const sync = store.syncState();
    const binding =
      target && version && player.canLog
        ? JSON.stringify([
            sync.server,
            sync.account,
            sync.lineage,
            tree.workout.id,
            target.entry.entry.id,
            target.entry.entry.content.exerciseId,
            target.entry.entry.content.exerciseType,
            target.set.id,
            version,
            player.logValues,
            player.measurements,
          ])
        : null;
    const finish = !target && progress.total > 0 && progress.done === progress.total;
    return {
      workoutId: tree.workout.id,
      binding,
      selection: JSON.stringify([
        sync.server,
        sync.account,
        sync.lineage,
        target?.set.id,
        activeRest?.source.setId,
        activeRest?.source.completedAt,
      ]),
      display: {
        title: short(player.title),
        exercise: short(player.name ?? (finish ? "All sets logged" : "Open workout")),
        set: short(player.setName),
        compact: short(player.unitValues || (finish ? "Done" : "Leve"), 20),
        started: Date.parse(tree.workout.content.startedAt),
        done: progress.done,
        total: progress.total,
        interactive,
        measurements: short(player.measurements),
        previous: short(player.lastValues),
        volume: player.volume,
        restKey: rest?.key,
        restStart: activeRest ? activeRest.endsAt - activeRest.totalSeconds * 1000 : 0,
        restEnd: activeRest?.endsAt ?? 0,
        canLog: player.canLog,
        finish,
        appearance,
      },
      act() {
        const owner = store.syncState();
        if (
          owner.server !== sync.server ||
          owner.account !== sync.account ||
          owner.lineage !== sync.lineage ||
          store.activeWorkout()?.id !== tree.workout.id
        )
          return;
        return version !== null && player.log(version) === true;
      },
    };
  }
  return null;
}
