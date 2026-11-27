import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import type { AppearanceSetting } from "../data/appearance-setting.ts";
import { newId } from "../data/ids.ts";
import { readLiveActivityRest } from "../data/live-activity-rest";
// Only this display snapshot crosses into ActivityKit. In particular, no notes, history records,
// account identifiers or input objects are shared with the extension.
export interface WorkoutDisplay {
  title: string;
  exercise: string;
  set: string;
  compact: string;
  measurements: string;
  previous: string;
  volume: string;
  started: number;
  done: number;
  total: number;
  restKey?: string;
  restStart: number;
  restEnd: number;
  interactive: boolean;
  canLog: boolean;
  finish: boolean;
  /** Leve's Appearance setting, so the activity matches the app rather than only the system. */
  appearance: AppearanceSetting;
}
export type WorkoutContent = WorkoutDisplay & { token: string; openUrl?: string };
export interface WorkoutActivity {
  getId(): string;
  update(content: WorkoutContent, staleDate?: Date): Promise<void>;
  end(policy: "immediate"): Promise<void>;
}
interface Factory {
  getInstances(): WorkoutActivity[];
  start(content: WorkoutContent, url: string, staleDate?: Date): WorkoutActivity;
}
/**
 * Which workout this phone last showed a Live Activity for, kept across launches so that only the
 * user's dismissal keeps a workout's activity away. Only the workout's local ID is kept, on this
 * phone, and it is forgotten when Leve ends the activity itself.
 */
export interface ActivityMemory {
  shown(): string | undefined;
  remember(workoutId: string): void;
  forget(): void;
}
export interface ActivityFrame {
  workoutId: string;
  // Even visually identical sets need distinct actions.
  selection: string;
  // Private input to SHA-256. Only its digest is carried in the ActivityKit button.
  binding: string | null;
  display: WorkoutDisplay;
  act(action: "log"): boolean | undefined;
}

// The frame identity stays fixed when ActivityKit supplies an updated deadline for Log.
function logTicketIdentity(ticket: string) {
  const [format, process, generation, , digest] = ticket.split(".");
  return [format, process, generation, digest].join(".");
}

// Serialize native operations. A queued tap must still belong to the same activity and exact
// displayed set/rest when it reaches the workout. Never resurrect a user-dismissed activity.
export function workoutSession(factory: Factory, scheme: string, memory: ActivityMemory) {
  const activeUrl = `${scheme}:///workout/active`;
  const finishUrl = `${scheme}:///workout/finish`;
  let current: ActivityFrame | null = null;
  let signature: string | undefined;
  let generation = 0;
  let owner: string | undefined;
  let handle: WorkoutActivity | undefined;
  let cleanStart = true;
  const epoch = newId(); // A tap from a former process must never authorize a new frame.
  let work = Promise.resolve();
  let published = "";
  let applied = "";
  let currentDigest = "";
  let publishedGeneration = -1;
  let previousRestTicket = "";
  return {
    publish(frame: ActivityFrame | null, retry = false) {
      current = frame;
      const next = JSON.stringify(
        frame && [frame.workoutId, frame.selection, frame.binding, frame.display],
      );
      if (next === signature && !retry) return work;
      if (next !== signature) generation++;
      signature = next;
      const scheduled = generation;
      work = work
        .then(async () => {
          if (scheduled !== generation) return;
          if (cleanStart) {
            const existing = factory.getInstances();
            // Reuse a surviving surface even when iOS relaunched Leve in the background,
            // where ActivityKit can update an activity but may refuse to start one.
            handle = frame ? existing[0] : undefined;
            for (const previous of existing) {
              if (previous !== handle) await previous.end("immediate");
            }
            // A workout that already had an activity, now gone, was dismissed: keep it hidden
            // across launches. One that never had one (begun before this launch) gets one now.
            owner =
              frame && (handle || memory.shown() === frame.workoutId) ? frame.workoutId : undefined;
            if (owner) memory.remember(owner);
            // Ended by Leve (no workout to show), not dismissed: a later launch may show it again.
            else if (!frame && existing.length > 0) memory.forget();
            cleanStart = false;
          }
          if (owner !== frame?.workoutId) {
            if (handle && factory.getInstances().some((a) => a.getId() === handle?.getId())) {
              await handle.end("immediate");
              // Ended by Leve, not dismissed. A dismissed workout's memory stays.
              memory.forget();
            }
            handle = undefined;
            owner = undefined;
            published = "";
          }
          if (!frame || scheduled !== generation) return;
          const digest = frame.binding
            ? await digestStringAsync(CryptoDigestAlgorithm.SHA256, frame.binding)
            : "-";
          if (scheduled !== generation) return;
          const token = ["leve1", epoch, scheduled, frame.display.restEnd, digest].join(".");
          const props = {
            ...frame.display,
            token,
            openUrl: frame.display.finish ? finishUrl : activeUrl,
          };
          const stale = props.restEnd ? new Date(props.restEnd) : undefined;
          if (!owner) {
            handle = factory.start(props, activeUrl, stale);
            owner = frame.workoutId;
            memory.remember(owner);
          } else if (handle && factory.getInstances().some((a) => a.getId() === handle?.getId())) {
            await handle.update(props, stale);
          } else {
            handle = undefined;
            return;
          }
          if (publishedGeneration !== scheduled) {
            const priorDeadline = Number(published.split(".")[3]);
            // A queued frame can be replaced before ActivityKit ever displays it.
            previousRestTicket =
              digest === currentDigest &&
              digest !== "-" &&
              priorDeadline > 0 &&
              !frame.display.restEnd
                ? published
                : "";
          }
          published = token;
          publishedGeneration = scheduled;
          currentDigest = digest;
        })
        .catch(() => {
          // Disabled activities and a background start are normal. Retry on foreground or change.
        });
      return work;
    },
    interact(source: string, target: string) {
      if (
        !current ||
        source !== handle?.getId() ||
        publishedGeneration !== generation ||
        !current.display.interactive
      )
        return false;
      const [ticket, action] = target.split(":");
      if (action !== "log" || !ticket || !current.display.canLog) return false;
      const parts = ticket.split(".");
      const [format, process, , deadline, digest] = parts;
      if (parts.length !== 5 || format !== "leve1") return false;
      const now = Date.now();
      const { restKey, restEnd } = current.display;
      const activeDeadline = (restKey ? readLiveActivityRest(restKey)?.end : undefined) ?? restEnd;
      if (activeDeadline > now) return false;
      const identity = logTicketIdentity(ticket);
      const restoredLog =
        process !== epoch && digest === currentDigest && digest !== "-" && Number(deadline) <= now;
      if (
        identity !== logTicketIdentity(published) &&
        identity !== logTicketIdentity(previousRestTicket) &&
        !restoredLog
      )
        return false;
      if (applied === currentDigest) return true;
      const success = current.act("log") === true;
      if (success) applied = currentDigest;
      return success;
    },
  };
}
