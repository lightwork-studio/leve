import { type DeviceStore, openDeviceStore } from "@leve/storage";
import { createSqlJsEngine } from "@leve/storage/sqljs";
import { router } from "expo-router";
import { act, createElement } from "react";
import { Text, View } from "react-native";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import { previewContract } from "../../../packages/contract/test/support/preview-contract.ts";
import { entry, set, workout } from "../../../packages/sync/test/support/content.ts";
import { World } from "../../../packages/sync/test/support/harness.ts";
import WorkoutNotesScreen from "../app/workout/notes/[id].tsx";
import { liveData, readWorkoutTree } from "../src/data/read.ts";
import { setExerciseRest, updateRunningWorkoutDetails } from "../src/data/workout-actions.ts";
import { resolveWorkoutRecord } from "../src/data/workout-review.ts";
import { dayLabel, timeLabel } from "../src/ui/format.ts";
import { SheetOutline } from "../src/ui/sheet-outline.tsx";
import { WorkoutDetailsEditor } from "../src/ui/workout-details-editor.tsx";
import { WorkoutSyncReview } from "../src/ui/workout-sync-review.tsx";

let store: DeviceStore;
let version = 0;
let id = "first";
vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  Platform: { OS: "web" },
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  StyleSheet: { create: (s: object) => s, absoluteFill: {} },
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Line: "Line" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id }),
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("../src/ui/back-link.tsx", () => ({ BackLink: "BackLink" }));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/toggle.tsx", () => ({ Toggle: "Toggle" }));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: ({ children }: { children: unknown }) => children,
  StillOnOpen: ({ children }: { children: unknown }) => children,
}));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, select: () => {}, warning: () => {}, success: () => {} },
}));
vi.mock("../src/ui/live/sheet-drag.ts", () => ({
  useSheetDrag: () => ({ handlers: {}, style: {} }),
}));
vi.mock("react-native-reanimated", () => ({ default: { View: "Animated", Text: "Text" } }));
// A refused save shakes its field; here it only needs to hold the field.
vi.mock("../src/ui/shake.tsx", () => ({ Shake: "Shake" }));
vi.mock("../src/ui/motion.ts", () => ({ fade: undefined }));
vi.mock("../src/ui/icons.tsx", () => ({
  CheckIcon: "Check",
  ChevronIcon: "Chevron",
  CloseIcon: "Close",
  MinusIcon: "Minus",
  MoreIcon: "More",
  PlusIcon: "Plus",
}));
// A note's menu lists its actions in place, so they can be pressed by name.
vi.mock("../src/ui/popover-menu.tsx", async () => {
  const { createElement } = await import("react");
  return {
    MoreButton: ({ items }: { items: { label: string; onPress: () => void }[] }) =>
      items.map(({ label, onPress }) =>
        createElement("Tap", { key: label, onPress }, createElement("Text", null, label)),
      ),
    PopoverMenu: "Menu",
    useAnchor: () => ({ ref: { current: null }, measure: () => {} }),
  };
});
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({
    store,
    version,
    change: (write: (db: DeviceStore) => unknown) => {
      const result = write(store);
      version++;
      return result;
    },
  }),
}));

it("records a pinned note, shows its comments read-only, and brings it back in every later workout of its routine", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T10:15:00Z"));
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    contract: previewContract,
    path: "/notes-screen.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  const open = async (workoutId: string) => {
    id = workoutId;
    await act(() => {
      const node = createElement(WorkoutNotesScreen, { key: id });
      if (screen) screen.update(node);
      else screen = create(node);
    });
    if (!screen) throw Error("Missing journal");
    return screen.root;
  };
  try {
    for (const [i, workoutId] of ["first", "second", "third"].entries()) {
      const day = i + 1;
      store.put("workout", workoutId, {
        title: "Strength",
        routineId: "strength",
        startedAt: `2026-11-0${day}T10:00:00.000Z`,
        endedAt: `2026-11-0${day}T11:00:00.000Z`,
      });
    }
    let root = await open("first");
    const press = (label: string, times = 1) =>
      act(() => {
        let button = root.find((n) => n.type === Text && n.props.children === label);
        while (!button.props.onPress && button.parent) button = button.parent;
        for (let i = 0; i < times; i++) button.props.onPress();
      });
    const enter = (label: string, text: string) =>
      act(() => root.findByProps({ accessibilityLabel: label }).props.onChangeText(text));
    await press("Add note");
    // The notes sheet clips a uniform rounded stroke after the top corners.
    const [clip, stroke] = root.findByType(SheetOutline).findAllByType(View);
    if (!clip || !stroke) throw Error("Missing the notes sheet outline");
    expect(clip.props.pointerEvents).toBe("none");
    const { height, overflow } = Object.assign({}, ...clip.props.style);
    const outline = Object.assign({}, ...stroke.props.style);
    expect(height).toBeGreaterThan(0);
    expect(overflow).toBe("hidden");
    expect(outline).toMatchObject({ borderWidth: 1, borderRadius: height, bottom: -height });
    expect(outline).not.toHaveProperty("borderTopWidth");
    await enter("Note", "Check grip");
    await press("Cancel");
    expect(store.list("workout_note", { parentId: "first" })).toHaveLength(0);
    await press("Add note");
    await enter("Note", "Check grip");
    expect(root.findAllByProps({ accessibilityLabel: "Coach reply" })).toEqual([]);
    store.bindAccount("server", "lifter");
    store.setNegotiated("1.2", []);
    version++;
    root = await open("first");
    expect(root.findByProps({ accessibilityLabel: "Note" }).props.editable).toBe(false);
    expect(root.findByProps({ accessibilityLabel: "Pin for future workouts" }).props.disabled).toBe(
      true,
    );
    expect(root.findAllByType(Text).map((n) => n.children.join(""))).toContain(
      "Update the connected server to edit workout notes.",
    );
    expect(root.findAllByType(Text).map((n) => n.children.join(""))).not.toContain("Save note");
    expect(root.findByProps({ accessibilityLabel: "Note" }).props.value).toBe("Check grip");
    store.setNegotiated("2.0", ["workout_journal"]);
    store.applyPull([], store.syncState().cursor, {
      release: "2.0",
      lastPage: true,
      cursor: store.syncState().cursor,
      lineage: store.syncState().lineage,
    });
    version++;
    root = await open("first");
    await press("Pin for future workouts");
    await press("Save note", 2);
    expect(store.list("workout_note", { parentId: "first" })).toHaveLength(1);
    const labels = () => root.findAllByType(Text).map((n) => n.children.join(""));
    expect(labels()).toContain("Pinned note");
    const [saved] = store.list("workout_note", { parentId: "first" });
    if (!saved) throw Error("Missing saved note");
    expect(saved.content).toEqual({
      workoutId: "first",
      pinned: true,
      text: "Check grip",
      createdAt: "2026-11-01T10:15:00.000Z",
      agent: null,
    });
    store.put("workout_note_comment", "coach", {
      noteId: saved.id,
      text: "Keep thumbs around the bar",
      createdAt: "2026-11-01T11:30:00.000Z",
      agent: "Coach",
    });
    version++;
    root = await open("first");
    expect(labels()).toEqual(expect.arrayContaining(["Coach", "Keep thumbs around the bar"]));
    root = await open("second");
    expect(labels()).toContain("Check grip");
    expect(labels()).toContain("Keep thumbs around the bar");
    const sessionLabel = (day: number) => {
      const startedAt = `2026-11-0${day}T10:00:00.000Z`;
      return `Strength · ${dayLabel(startedAt)} · ${timeLabel(startedAt)}`;
    };
    expect(labels()).toContain(sessionLabel(2));
    expect(labels()).toContain(`Pinned note · ${sessionLabel(1)}`);
    await press("Open source workout’s notes");
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: "/workout/notes/[id]",
      params: { id: "first" },
    });
    root = await open("first");
    expect(labels()).toContain(sessionLabel(1));
    await press("Edit note");
    expect(labels()).toContain(sessionLabel(1));
    root = await open("third");
    // Pinned, it comes back in every later workout of its routine, with its comments.
    expect(labels()).toContain("Check grip");
    expect(labels()).toContain(`Pinned note · ${sessionLabel(1)}`);
    expect(labels()).toContain("Keep thumbs around the bar");

    const original = store.list("workout_note", { parentId: "first" })[0];
    if (!original?.content) throw Error("Missing source note");
    root = await open("second");
    // A newer edit and comment have arrived since this card rendered. Unpin only changes the pin.
    const updated = { ...original.content, text: "  Check grip  " };
    store.put("workout_note", original.id, updated);
    store.put("workout_note_comment", "later", {
      noteId: original.id,
      text: "  Use a neutral grip  ",
      createdAt: "2026-11-01T12:00:00.000Z",
      agent: "Coach",
    });
    await press("Unpin note");
    root = await open("second");
    expect(store.get("workout_note", original.id)?.content).toEqual({
      ...updated,
      pinned: false,
    });
    expect(
      store
        .list("workout_note_comment")
        .map((row) => row.id)
        .sort(),
    ).toEqual(["coach", "later"]);
    expect(labels()).toContain("  Use a neutral grip  ");
    expect(labels()).toContain(`Last time · ${sessionLabel(1)}`);
    expect(labels()).not.toContain("Unpin note");
    root = await open("third");
    expect(labels()).not.toContain("  Check grip  ");
    root = await open("first");
    expect(labels()).toContain("Note");
    expect(labels()).not.toContain("Pinned note");
    expect(labels()).toContain("  Check grip  ");

    await press("Add note");
    await press("Save note");
    expect(labels()).toContain("Enter a note.");
    await enter("Note", "Check grip");
    await press("Save note", 2);
    expect(store.list("workout_note", { parentId: "first" })).toHaveLength(2);
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("keeps same-minute source sessions distinct in their carried cards and source journals", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/same-minute.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  const open = async (workoutId: string) => {
    id = workoutId;
    await act(() => {
      const element = createElement(WorkoutNotesScreen, { key: id });
      if (screen) screen.update(element);
      else screen = create(element);
    });
    if (!screen) throw Error("Missing journal");
    return screen.root;
  };
  try {
    for (const [source, second] of [
      ["b", "01"],
      ["c", "59"],
      ["a", "01"],
    ] as const) {
      store.put(
        "workout",
        source,
        workout("Strength", {
          startedAt: `2026-11-01T10:00:${second}.000Z`,
          endedAt: "2026-11-01T10:30:00.000Z",
        }),
      );
      store.put("workout_note", `pin-${source}`, {
        workoutId: source,
        createdAt: "2026-11-01T10:10:00.000Z",
        text: "Check grip",
        pinned: true,
        agent: null,
      });
    }
    store.put(
      "workout",
      "next",
      workout("Strength", {
        startedAt: "2026-11-02T10:00:00.000Z",
        endedAt: null,
      }),
    );
    const stamp = "2026-11-01T10:00:01.000Z";
    const prefix = `Strength · ${dayLabel(stamp)} · ${timeLabel(stamp)}`;
    for (const [index, source] of ["a", "b", "c"].entries()) {
      const expected = `${prefix} · Session ${index + 1}`;
      const root = await open("next");
      const heading = root.find(
        (n) => n.type === Text && n.children.join("") === `Pinned note · ${expected}`,
      );
      // The note's menu sits beside its text, in the same row.
      const action = heading.parent?.parent?.find(
        (n) =>
          n.props.onPress &&
          n.findAllByType(Text).some((t) => t.children.join("") === "Open source workout’s notes"),
      );
      if (!action) throw Error("Missing source action");
      await act(() => action.props.onPress());
      expect(router.push).toHaveBeenLastCalledWith({
        pathname: "/workout/notes/[id]",
        params: { id: source },
      });
      const sourceRoot = await open(source);
      expect(sourceRoot.findAllByType(Text).map((n) => n.children.join(""))).toContain(expected);
    }
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it("keeps a newly rejected source note intact when its carried card is unpinned", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/unpin-rejected.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    store.put(
      "workout",
      "source",
      workout("Monday", {
        startedAt: "2026-11-02T09:00:00.000Z",
        endedAt: "2026-11-02T10:00:00.000Z",
      }),
    );
    id = "next";
    store.put(
      "workout",
      id,
      workout("Tuesday", { startedAt: "2026-11-03T09:00:00.000Z", endedAt: null }),
    );
    store.put("workout_note", "pin", {
      workoutId: "source",
      createdAt: "2026-11-02T09:30:00.000Z",
      text: "Set the bench",
      pinned: true,
      agent: null,
    });
    await act(() => {
      screen = create(createElement(WorkoutNotesScreen));
    });
    if (!screen) throw Error("Missing workout journal");
    const root = screen.root;
    let button = root.find((node) => node.type === Text && node.props.children === "Unpin note");
    while (!button.props.onPress && button.parent) button = button.parent;
    const send = store.prepareSubmissions("1.0").find(({ submission }) => submission.id === "pin");
    if (!send) throw Error("Missing reminder submission");
    store.applyPushResults([
      {
        submissionId: send.submission.submissionId,
        status: "invalid",
        code: "invalid_content",
        message: "Review reminder",
      },
    ]);
    const rejected = store.get("workout_note", "pin");
    expect(rejected?.status).toBe("invalid");
    await act(() => button.props.onPress());
    expect(store.get("workout_note", "pin")).toEqual(rejected);
    expect(root.findAllByType(Text).map((node) => node.children.join(""))).toContain(
      "Review the sync issue in the source workout before unpinning this note.",
    );
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});

it.each([false, true])(
  "reviews both devices’ note and rest versions (same note text: %s)",
  async (sameText) => {
    const world = new World();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let screen: ReactTestRenderer | undefined;
    try {
      const server = world.server();
      const options = { server: "s", account: "alice", transport: server.transport("alice") };
      const a = await world.phone("a", options);
      const b = await world.phone("b", options);
      a.store.put(
        "workout",
        "first",
        workout("First", {
          startedAt: "2026-10-01T08:00:00.000Z",
          endedAt: "2026-10-01T09:00:00.000Z",
        }),
      );
      a.store.put("workout", "next", workout("Next", { startedAt: "2026-10-02T08:00:00.000Z" }));
      const note = {
        workoutId: "first",
        pinned: true,
        text: "Seat height",
        createdAt: "2026-10-01T08:10:00.000Z",
        agent: null,
      };
      a.store.put("workout_note", "seat", note);
      a.store.put("workout_rest", "first", { workoutId: "first", seconds: 45 });
      await a.sync();
      await b.sync();
      for (const [phone, text, seconds] of [
        [a, "Use seat 3", 90],
        [b, sameText ? "Use seat 3" : "Try seat 4", 30],
      ] as const) {
        // With the same text, this device unpinned the note instead.
        phone.store.put("workout_note", "seat", {
          ...note,
          text,
          pinned: !(phone === b && sameText),
        });
        phone.store.put("workout_rest", "first", { workoutId: "first", seconds });
        await phone.sync();
      }
      store = b.store;
      const shown = store.get("workout_note", "seat");
      if (!shown?.problem) throw Error("Missing conflict");
      expect(() => resolveWorkoutRecord(store, "next", shown, "keep_mine")).toThrow(/changed/);
      const journal = async (workoutId: string) => {
        id = workoutId;
        await act(() => {
          const view = createElement(WorkoutNotesScreen, { key: id });
          if (screen) screen.update(view);
          else screen = create(view);
        });
      };
      const labels = () => screen?.root.findAllByType(Text).map((n) => n.children.join("")) ?? [];
      const press = async (label: string) => {
        const root = screen?.root;
        if (!root) throw Error("Missing screen");
        await act(() => {
          let button = root.find((n) => n.type === Text && n.props.children === label);
          while (!button.props.onPress && button.parent) button = button.parent;
          button.props.onPress();
        });
      };
      await journal("next");
      expect(labels()).toContain("Sync issue · review this note in its source workout.");
      expect(labels()).not.toContain("Unpin note");
      await journal("first");
      expect(labels()).toEqual(
        expect.arrayContaining([
          "Review note",
          sameText ? "Use seat 3" : "Try seat 4",
          "Use seat 3",
          "Pinned note",
        ]),
      );
      if (sameText) expect(labels()).toContain("Note");
      else expect(labels()).not.toContain("Note");
      await press("Use server version");
      await b.sync();
      expect(store.get("workout_note", "seat")).toMatchObject({
        status: "synced",
        content: { text: "Use seat 3", pinned: true },
      });
      expect(() => resolveWorkoutRecord(store, "first", shown, "keep_mine")).toThrow(/changed/);
      const saved = readWorkoutTree(store, "first")?.workout;
      if (!saved) throw Error("Missing workout");
      await act(() =>
        screen?.update(
          createElement(WorkoutDetailsEditor, {
            workout: saved,
            onClose: () => {},
            onDeleted: () => {},
          }),
        ),
      );
      expect(labels()).toEqual(
        expect.arrayContaining(["Review workout rest", "30 seconds", "90 seconds"]),
      );
      await press("Keep my version");
      await b.sync();
      expect((await server.row("alice", "workout_rest", "first"))?.content?.seconds).toBe(30);
      await journal("next");
      expect(labels()).toContain("Use seat 3");
      expect(labels()).not.toContain("Sync issue · review this note in its source workout.");
    } finally {
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
      await world.dispose();
    }
  },
);

it.each(["save", "delete"])(
  "lets the lifter %s the entire workout after another device deletes it",
  async (decision) => {
    const world = new World();
    let screen: ReactTestRenderer | undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    try {
      const server = world.server();
      const opts = { account: "alice", server: "s", transport: server.transport("alice") };
      const a = await world.phone("a", opts);
      const b = await world.phone("b", opts);
      id = "source";
      a.store.put("workout", id, workout("Thursday", { endedAt: "2026-11-01T11:00:00.000Z" }));
      a.store.put("workout_exercise", "e", entry(id, "Press"));
      a.store.put("workout_set", "s", set("e", { reps: 8 }));
      a.store.put("workout_rest", id, { workoutId: id, seconds: 90 });
      await a.sync();
      await b.sync();
      a.store.delete("workout", id);
      await a.sync();
      b.store.put("workout_note", "n", {
        workoutId: id,
        pinned: true,
        text: "Seat four",
        createdAt: "2026-11-01T10:00:00.000Z",
        agent: null,
      });
      b.store.put("workout_note_comment", "c", {
        noteId: "n",
        text: "Keep it there",
        createdAt: "2026-11-01T10:30:00.000Z",
        agent: null,
      });
      b.store.put("workout_rest", id, { workoutId: id, seconds: 45 });
      b.store.put("workout_set", "s", set("e", { reps: 10 }));
      await b.sync();
      store = b.store;
      expect(store.get("workout_note", "n")?.problem?.reason).toBe("parent_deleted");
      await act(() => {
        screen = create(createElement(WorkoutNotesScreen));
      });
      const press = async (label: string) => {
        const node = screen?.root.find((n) => n.type === Text && n.props.children === label);
        if (!node) throw Error("Missing action: " + label);
        let button = node;
        while (!button.props.onPress && button.parent) button = button.parent;
        await act(() => button.props.onPress());
      };
      if (decision === "save") {
        await press("Save workout as new");
        const copies = store.list("workout");
        expect(copies).toHaveLength(1);
        const copy = copies[0];
        if (!copy) throw Error("Missing recovered workout");
        expect(copy.id).not.toBe(id);
        expect(router.replace).toHaveBeenCalledWith({
          pathname: "/workout/[id]",
          params: { id: copy.id },
        });
        await b.sync();
        await b.restart();
        const tree = readWorkoutTree(b.store, copy.id);
        expect(tree?.entries[0]?.sets[0]?.content.reps).toBe(10);
        const notes = b.store.list("workout_note", { parentId: copy.id });
        expect(notes.map((row) => row.content)).toEqual([
          expect.objectContaining({ workoutId: copy.id, pinned: true, text: "Seat four" }),
        ]);
        const noteCopy = notes[0];
        if (!noteCopy) throw Error("Missing recovered note");
        expect(
          b.store.list("workout_note_comment", { parentId: noteCopy.id }).map((row) => row.content),
        ).toEqual([expect.objectContaining({ noteId: noteCopy.id, text: "Keep it there" })]);
        expect((await server.row("alice", "workout_rest", copy.id))?.content?.seconds).toBe(45);
      } else {
        await press("Accept workout deletion");
        store.put("workout_set", "s", set("e", { reps: 12 }));
        version++;
        await act(() => screen?.update(createElement(WorkoutNotesScreen)));
        await press("Delete workout and its local changes");
        expect(store.get("workout_set", "s")?.content?.reps).toBe(12);
        expect(store.get("workout_note", "n")?.content?.text).toBe("Seat four");
        await press("Accept workout deletion");
        await press("Delete workout and its local changes");
        await b.sync();
        expect(b.store.list("workout_note")).toHaveLength(0);
        expect(b.store.list("workout_note_comment")).toHaveLength(0);
        expect(b.store.list("workout")).toHaveLength(0);
      }
      expect(b.store.hasUnsyncedWork()).toBe(false);
      expect((await server.row("alice", "workout", id))?.state).toBe("deleted");
    } finally {
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
      await world.dispose();
    }
  },
);

it("reviews rejected exercise rests and edits from the newly accepted workout default", async () => {
  const world = new World();
  let screen: ReactTestRenderer | undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    const server = world.server();
    const opts = { account: "alice", server: "s", transport: server.transport("alice") };
    const a = await world.phone("a", opts);
    const b = await world.phone("b", opts);
    a.store.put("workout", "w", workout("Running", { endedAt: null }));
    a.store.put("workout_exercise", "e", { ...entry("w", "Bench"), restSeconds: 90 });
    a.store.put("workout_rest", "w", { workoutId: "w", seconds: 60 });
    await a.sync();
    await b.sync();
    const tree = readWorkoutTree(b.store, "w");
    if (!tree) throw Error("Missing workout");
    setExerciseRest(a.store, "w", "e", "75", 90);
    a.store.put("workout_rest", "w", { workoutId: "w", seconds: 90 });
    await a.sync();
    updateRunningWorkoutDetails(
      b.store,
      "w",
      tree.workout.content,
      {},
      {
        seconds: 45,
        originalSeconds: 60,
        applyTo: new Map([["e", 90]]),
      },
    );
    await b.sync();
    store = b.store;
    expect(liveData(store)?.needsDetailReview).toBe(true);
    await act(() => {
      screen = create(
        createElement(WorkoutDetailsEditor, {
          workout: tree.workout,
          mode: "active",
          onClose: () => {},
        }),
      );
    });
    if (!screen) throw Error("Missing editor");
    const root = screen.root;
    const action = async (section: ReactTestInstance, label: string) => {
      let tap = section.find((n) => n.type === Text && n.props.children === label);
      while (!tap.props.onPress && tap.parent) tap = tap.parent;
      await act(() => tap.props.onPress());
    };
    const card = (kind: string) => {
      const card = root.findAllByType(WorkoutSyncReview).find((n) => n.props.record.kind === kind);
      if (!card) throw Error("Missing conflict " + kind);
      return card;
    };
    const ex = card("workout_exercise");
    expect(ex.findAllByType(Text).map((n) => n.children.join(""))).toEqual(
      expect.arrayContaining(["Rest: 45 seconds", "Rest: 75 seconds"]),
    );
    await action(ex, "Use server version");
    await action(card("workout_rest"), "Use server version");
    const input = root.findByProps({ accessibilityLabel: "Workout rest in seconds" });
    expect(input.props.value).toBe("90");
    await act(() => input.props.onChangeText("50"));
    await action(root, "Save changes");
    await b.sync();
    expect((await server.row("alice", "workout_rest", "w"))?.content?.seconds).toBe(50);
    expect((await server.row("alice", "workout_exercise", "e"))?.content?.restSeconds).toBe(75);
    expect(liveData(store)?.needsDetailReview).toBe(false);
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
    await world.dispose();
  }
});

it.each(["exercise", "workout"])(
  "reviews the affected sets when the server deletes a retained %s",
  async (deleted) => {
    const world = new World();
    let screen: ReactTestRenderer | undefined;
    try {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const server = world.server();
      const opts = { server: "s", account: "alice", transport: server.transport("alice") };
      const a = await world.phone("a", opts);
      const b = await world.phone("b", opts);
      const w = workout("Training");
      a.store.put("workout", "w", w);
      a.store.put("workout_exercise", "e", entry("w", "Press"));
      a.store.put("workout_set", "s", set("e", { reps: 8 }));
      await a.sync();
      await b.sync();
      store = b.store;
      store.put("workout_set", "s", set("e", { reps: 10 }));
      if (deleted === "exercise") {
        a.store.delete("workout_exercise", "e");
        await a.sync();
        await b.sync();
      } else {
        // A parent marker can be applied without receiving all descendants in that page.
        store.applyPull([{ kind: "workout", id: "w", state: "deleted", revision: 4 }], 4);
      }
      const render = async () => {
        const tree = readWorkoutTree(store, "w");
        if (!tree) throw Error("Missing retained workout");
        const view = createElement(WorkoutDetailsEditor, {
          workout: tree.workout,
          mode: "active",
          onClose: () => {},
        });
        await act(() => {
          if (screen) screen.update(view);
          else screen = create(view);
        });
      };
      await render();
      if (!screen) throw Error("Missing details");
      const root = (screen as ReactTestRenderer).root;
      const labels = () => root.findAllByType(Text).map((n) => n.children.join(""));
      const press = async (label: string) => {
        let button = root.find((n) => n.type === Text && n.props.children === label);
        while (!button.props.onPress && button.parent) button = button.parent;
        await act(() => button.props.onPress());
      };
      const item = store.get("workout_exercise", "e");
      if (!item?.problem) throw Error("Missing exercise conflict");
      expect(() => resolveWorkoutRecord(store, "w", item, "keep_theirs")).toThrow(
        /review|retained/i,
      );
      if (deleted === "workout") {
        expect(labels()).toContain("Save workout as new");
        expect(labels()).not.toContain("Save as a new exercise entry");
        await press("Save workout as new");
        const copy = store.list("workout")[0];
        expect(copy?.id).not.toBe("w");
        expect(copy && readWorkoutTree(store, copy.id)?.entries[0]?.sets[0]?.content.reps).toBe(10);
      } else {
        expect(
          labels().some((label) => label.startsWith("Set 1 · ") && label.includes("10 reps")),
        ).toBe(true);
        expect(labels()).not.toContain("Use server version");
        await press("Discard exercise and retained sets");
        store.put("workout_set", "s", set("e", { reps: 12 }));
        await render();
        await press("Delete exercise and 1 set");
        expect(store.get("workout_set", "s")?.content?.reps).toBe(12);
        expect(labels().some((label) => label.includes("12 reps"))).toBe(true);
        await press("Discard exercise and retained sets");
        await press("Delete exercise and 1 set");
        expect(store.get("workout_set", "s")).toBeNull();
      }
    } finally {
      await act(() => screen?.unmount());
      vi.unstubAllGlobals();
      await world.dispose();
    }
  },
);

it("compares both source workouts and creation times before resolving a moved note", async () => {
  const world = new World();
  let screen: ReactTestRenderer | undefined;
  try {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const server = world.server();
    const opts = { server: "s", account: "alice", transport: server.transport("alice") };
    const a = await world.phone("a", opts);
    const b = await world.phone("b", opts);
    a.store.put("workout", "mon", workout("Monday"));
    a.store.put("workout", "fri", workout("Friday"));
    const text = {
      workoutId: "mon",
      pinned: false,
      text: "Seat three",
      createdAt: "2026-11-10T10:00:00.000Z",
      agent: null,
    };
    a.store.put("workout_note", "n", text);
    await a.sync();
    await b.sync();
    a.store.put("workout_note", "n", {
      ...text,
      workoutId: "fri",
      createdAt: "2026-11-11T10:00:00.000Z",
    });
    b.store.put("workout_note", "n", { ...text, text: "Seat four" });
    await a.sync();
    await b.sync();
    store = b.store;
    id = "mon";
    await act(() => {
      screen = create(createElement(WorkoutNotesScreen));
    });
    if (!screen) throw Error("Missing notes page");
    const labels = screen.root.findAllByType(Text).map((n) => n.children.join(""));
    expect(labels).toEqual(
      expect.arrayContaining([
        "Workout · Monday (mon)",
        "Workout · Friday (fri)",
        "Note recorded 2026-11-10T10:00:00.000Z",
        "Note recorded 2026-11-11T10:00:00.000Z",
      ]),
    );
    let button = screen.root.find((n) => n.type === Text && n.props.children === "Keep my version");
    while (!button.props.onPress && button.parent) button = button.parent;
    await act(() => button.props.onPress());
    await b.sync();
    expect((await server.row("alice", "workout_note", "n"))?.content).toMatchObject({
      workoutId: "mon",
      text: "Seat four",
    });
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
    await world.dispose();
  }
});

it("restores a moved exercise for review without deleting newly downloaded server sets", async () => {
  const world = new World();
  let screen: ReactTestRenderer | undefined;
  try {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const server = world.server();
    const opts = { server: "s", account: "alice", transport: server.transport("alice") };
    const a = await world.phone("a", opts);
    const b = await world.phone("b", opts);
    a.store.put("workout", "mon", workout("Monday"));
    a.store.put("workout", "fri", workout("Friday"));
    a.store.put("workout_exercise", "e", entry("mon", "Press"));
    await a.sync();
    await b.sync();
    b.store.delete("workout_exercise", "e");
    a.store.put("workout_exercise", "e", entry("fri", "Press"));
    a.store.put("workout_set", "new", set("e", { reps: 20 }));
    await a.sync();
    await b.sync();
    store = b.store;
    const record = store.get("workout_exercise", "e");
    if (!record?.problem || !record.deleted) throw Error("Missing deletion conflict");
    expect(() => resolveWorkoutRecord(store, "fri", record, "keep_mine")).toThrow(/restore.*sets/i);
    await act(() => {
      screen = create(
        createElement(WorkoutSyncReview, { workoutId: "fri", record, readOnlyReason: null }),
      );
    });
    if (!screen) throw Error("Missing review");
    const labels = screen.root.findAllByType(Text).map((n) => n.children.join(""));
    expect(labels).not.toContain("Keep my version");
    expect(labels).toContain("Workout · Friday (fri)");
    let button = screen.root.find(
      (n) => n.type === Text && n.props.children === "Restore exercise to review its sets",
    );
    while (!button.props.onPress && button.parent) button = button.parent;
    await act(() => button.props.onPress());
    await b.sync();
    expect(readWorkoutTree(store, "fri")?.entries[0]?.sets[0]?.content.reps).toBe(20);
    expect((await server.row("alice", "workout_set", "new"))?.state).toBe("live");
  } finally {
    await act(() => screen?.unmount());
    vi.unstubAllGlobals();
    await world.dispose();
  }
});

it("deletes a note from its menu only once the action sheet is confirmed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store = await openDeviceStore({
    engine: createSqlJsEngine(await initSqlJs()),
    path: "/delete-note.db",
    appVersion: "test",
  });
  let screen: ReactTestRenderer | undefined;
  try {
    id = "only";
    store.put("workout", id, {
      title: "Strength",
      routineId: null,
      startedAt: "2026-11-01T10:00:00.000Z",
      endedAt: "2026-11-01T11:00:00.000Z",
    });
    store.put("workout_note", "note", {
      workoutId: id,
      createdAt: "2026-11-01T10:10:00.000Z",
      text: "Knees felt good",
      pinned: false,
      agent: null,
    });
    await act(() => {
      screen = create(createElement(WorkoutNotesScreen));
    });
    if (!screen) throw Error("Missing journal");
    const root = screen.root;
    const texts = () => root.findAllByType(Text).map((n) => n.children.join(""));
    const pressLast = (label: string) =>
      act(() => {
        let button = root.findAll((n) => n.type === Text && n.props.children === label).at(-1);
        while (button && !button.props.onPress && button.parent) button = button.parent;
        button?.props.onPress();
      });
    await pressLast("Delete note");
    expect(texts()).toContain("This note and its comments will be deleted.");
    await pressLast("Keep it");
    expect(store.list("workout_note", { parentId: id })).toHaveLength(1);
    expect(texts()).not.toContain("This note and its comments will be deleted.");
    await pressLast("Delete note");
    // The last "Delete note" is the confirming choice in the action sheet.
    await pressLast("Delete note");
    expect(store.list("workout_note", { parentId: id })).toHaveLength(0);
    expect(texts()).toContain("No notes on this workout");
  } finally {
    await act(() => screen?.unmount());
    store.close();
    vi.unstubAllGlobals();
  }
});
