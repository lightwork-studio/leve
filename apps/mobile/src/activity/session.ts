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

export type FramePublisher = ReturnType<typeof framePublisher>;

/**
 * Mints and checks the tickets that surfaces put on their buttons. Keep one per process and share
 * it between surfaces, so that a set logged from one surface is never logged again from another,
 * and so that a surface gets tickets without an ActivityKit handle. A ticket depends only on the
 * process, the frame's generation, its rest deadline and the digest of its binding, so every
 * surface showing the same frame shows the same ticket. Every surface must be given the same
 * sequence of frames: a surface that sets a different one replaces the frame for all of them.
 */
export function framePublisher() {
  const epoch = newId(); // A tap from a former process must never authorize a new frame.
  let current: ActivityFrame | null = null;
  let signature: string | undefined;
  let generation = 0;
  let published = "";
  let applied = "";
  let currentDigest = "";
  let publishedGeneration = -1;
  const shownRestTickets = new Set<string>();
  return {
    /** Makes the frame current. Its generation changes whenever what the frame shows does. */
    set(frame: ActivityFrame | null) {
      current = frame;
      const next = JSON.stringify(
        frame && [frame.workoutId, frame.selection, frame.binding, frame.display],
      );
      if (next !== signature) generation++;
      signature = next;
      return generation;
    },
    generation: () => generation,
    /** The ticket for a frame of this generation, or none once a newer frame has replaced it. */
    async ticket(frame: ActivityFrame, scheduled: number) {
      const digest = frame.binding
        ? await digestStringAsync(CryptoDigestAlgorithm.SHA256, frame.binding)
        : "-";
      if (scheduled !== generation) return;
      return {
        token: ["leve1", epoch, scheduled, frame.display.restEnd, digest].join("."),
        digest,
      };
    },
    /** Records that a surface now shows this frame's ticket. */
    shown(frame: ActivityFrame, ticket: { token: string; digest: string }, scheduled: number) {
      // A surface that finishes late never takes back a newer frame another surface shows.
      if (scheduled < publishedGeneration) return;
      const { token, digest } = ticket;
      if (publishedGeneration !== scheduled) {
        const wasResting = Number(published.split(".")[3]) > 0;
        if (digest !== currentDigest || !wasResting) shownRestTickets.clear();
        // Native Skip can expose Log from any frame that was visible during this rest.
        if (frame.display.restEnd && digest !== "-") shownRestTickets.add(logTicketIdentity(token));
      }
      published = token;
      publishedGeneration = scheduled;
      currentDigest = digest;
    },
    /**
     * Forgets the shown ticket, when a surface stops showing a workout. Keeps it while some
     * surface already shows the current frame.
     */
    clear() {
      if (publishedGeneration !== generation) published = "";
    },
    /** Applies a button's `<ticket>:<action>` target if it still matches what is shown. */
    interact(target: string) {
      if (!current || publishedGeneration !== generation || !current.display.interactive)
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
        !shownRestTickets.has(identity) &&
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

// The Live Activity surface. Serialize native operations. A queued tap must still belong to the
// same activity and exact displayed set/rest when it reaches the workout. Never resurrect a
// user-dismissed activity.
export function workoutSession(
  factory: Factory,
  scheme: string,
  memory: ActivityMemory,
  frames: FramePublisher = framePublisher(),
) {
  const activeUrl = `${scheme}:///workout/active`;
  const finishUrl = `${scheme}:///workout/finish`;
  let seen: number | undefined;
  let owner: string | undefined;
  let handle: WorkoutActivity | undefined;
  let cleanStart = true;
  let work = Promise.resolve();
  return {
    publish(frame: ActivityFrame | null, retry = false) {
      const scheduled = frames.set(frame);
      if (scheduled === seen && !retry) return work;
      seen = scheduled;
      work = work
        .then(async () => {
          if (scheduled !== frames.generation()) return;
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
            frames.clear();
          }
          if (!frame || scheduled !== frames.generation()) return;
          const ticket = await frames.ticket(frame, scheduled);
          if (!ticket || scheduled !== frames.generation()) return;
          const props = {
            ...frame.display,
            token: ticket.token,
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
          frames.shown(frame, ticket, scheduled);
        })
        .catch(() => {
          // Disabled activities and a background start are normal. Retry on foreground or change.
        });
      return work;
    },
    async adoptExisting(frame: ActivityFrame, source: string) {
      const existing = factory.getInstances().find((activity) => activity.getId() === source);
      if (!existing) return false;
      const scheduled = frames.set(frame);
      const ticket = await frames.ticket(frame, scheduled);
      if (!ticket || scheduled !== frames.generation()) return false;
      handle = existing;
      owner = frame.workoutId;
      cleanStart = false;
      // Bind a fresh local frame for validation without replacing the live countdown.
      frames.shown(frame, ticket, scheduled);
      return true;
    },
    interact(source: string, target: string) {
      return source === handle?.getId() && frames.interact(target);
    },
  };
}
