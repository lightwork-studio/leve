// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finishFolderCreation } from "../src/data/folder-actions.ts";
import { DestructiveButton } from "../src/ui/action-sheet.tsx";
import { ChoiceRow, Stepper, ToggleRow } from "../src/ui/choice-row.tsx";
import { EmptyState } from "../src/ui/empty-state.tsx";
import { ExercisePicker } from "../src/ui/exercise-picker.tsx";
import { ErrorRow, FieldError, TextField } from "../src/ui/field.tsx";
import { SetStrip, type StripField } from "../src/ui/live/dock.tsx";
import { gridRows, RestDialog } from "../src/ui/live/rest-dialog.tsx";
import { NewFolderDialog } from "../src/ui/new-folder-dialog.tsx";
import { Banner, showToast, TOAST_MS, ToastHost } from "../src/ui/notice.tsx";
import { MoreButton, menuPlacement } from "../src/ui/popover-menu.tsx";
import { SearchField } from "../src/ui/search-field.tsx";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({ store: { list: () => [] }, version: 0 }),
}));
vi.mock("../src/ui/muscle-figure.tsx", () => ({
  MuscleFigure: ({ accessibilityLabel }: { accessibilityLabel: string }) =>
    h("span", { "aria-label": accessibilityLabel }),
}));
// Whether motion is reduced, and how many shakes have started.
const motion = vi.hoisted(() => ({ reduced: false, shakes: 0 }));
vi.mock("react-native-reanimated", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    default: {
      createAnimatedComponent: (component: unknown) => component,
      View: passthrough,
      Text: ({ children }: { children?: ReactNode }) => h("span", null, children),
    },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value }),
    withTiming: (value: number) => value,
    withSpring: (value: number) => value,
    withSequence: (...steps: number[]) => {
      motion.shakes++;
      return steps.at(-1);
    },
    useReducedMotion: () => motion.reduced,
    interpolateColor: () => "#000",
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native-svg", () => ({
  default: "svg",
  Path: "path",
  Circle: "circle",
  Line: "line",
  Polyline: "polyline",
  Rect: "rect",
}));
vi.mock("../src/ui/motion.ts", () => ({
  emphasised: undefined,
  pressScale: 1,
  spring: {},
  fade: undefined,
}));
vi.mock("../src/ui/enter.tsx", () => ({
  Enter: ({ children, ...props }: { children?: ReactNode; role?: string }) =>
    h(
      "div",
      { role: props.role, "aria-label": (props as { "aria-label"?: string })["aria-label"] },
      children,
    ),
}));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: () => {}, select: () => {}, warning: () => {}, success: () => {} },
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const press = async (label: string) => {
  const target = byLabel(label);
  if (!target) throw Error(`Missing ${label}`);
  await act(async () => {
    target.click();
    // Menus find their tile's place on screen before they open.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};
const confirmChoice = async (text: string) => {
  const choice = [
    ...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [role="button"]'),
  ].find((button) => button.textContent === text);
  if (!choice) throw Error(`Missing ${text}`);
  await act(async () => choice.click());
};

describe("the destructive confirm", () => {
  it("only acts once the action sheet is confirmed", async () => {
    const remove = vi.fn();
    await act(() =>
      root.render(
        h(DestructiveButton, {
          label: "Delete workout",
          message: "Legs and its 16 sets will be deleted.",
          keep: "Keep it",
          onConfirm: remove,
        }),
      ),
    );
    await press("Delete workout");
    expect(remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Legs and its 16 sets will be deleted.");
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    // The safe choice closes it without doing anything.
    await press("Keep it");
    expect(remove).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    await press("Delete workout");
    const confirm = [
      ...document.querySelectorAll<HTMLElement>('[role="alertdialog"] [role="button"]'),
    ].find((button) => button.textContent === "Delete workout");
    if (!confirm) throw Error("Missing the confirming choice");
    await act(async () => confirm.click());
    expect(remove).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("runs the action as it was when asked, when told to keep it", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const render = (run: () => void) =>
      act(() =>
        root.render(
          h(DestructiveButton, {
            label: "Use synced",
            message: "Replaces this device's copy.",
            action: "Replace",
            capture: true,
            onConfirm: run,
          }),
        ),
      );
    await render(first);
    await press("Use synced");
    await render(second);
    await confirmChoice("Replace");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

describe("the ⋯ menu", () => {
  const screen = { width: 390, height: 844 };

  it("opens under its tile, right edges aligned", () => {
    const place = menuPlacement({ x: 334, y: 60, width: 44, height: 44 }, screen, 212);
    expect(place).toMatchObject({ top: 110, right: 12, up: false, width: 290 });
  });

  it("opens upwards when it would run off the bottom", () => {
    const place = menuPlacement({ x: 334, y: 700, width: 44, height: 44 }, screen, 212);
    expect(place).toMatchObject({ bottom: 150, up: true });
  });

  it("stays on screen when it fits neither way", () => {
    const place = menuPlacement({ x: 0, y: 300, width: 44, height: 44 }, screen, 900);
    expect(place.up).toBe(false);
    expect(place.top).toBe(12);
    expect(place.right).toBe(346);
  });

  it("lists destructive actions last and closes before acting", async () => {
    const rename = vi.fn();
    const remove = vi.fn();
    await act(() =>
      root.render(
        h(MoreButton, {
          label: "Folder options",
          title: "Push · Pull · Legs",
          meta: "Folder · 3 routines",
          items: [
            { label: "Delete folder", destructive: true, onPress: remove },
            { label: "Rename", onPress: rename },
          ],
        }),
      ),
    );
    await press("Folder options");
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toEqual(["Rename", "Delete folder"]);
    await press("Rename");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("draws a given icon on the tile in place of the ⋯", async () => {
    const drawn: [string, number][] = [];
    await act(() =>
      root.render(
        h("div", null, [
          h(MoreButton, {
            key: "add",
            label: "Add routine or folder",
            icon: (color: string, size: number) => {
              drawn.push([color, size]);
              return h("span", { "data-icon": "plus" });
            },
            items: [{ label: "New routine", onPress: () => {} }],
          }),
          h(MoreButton, { key: "more", label: "Routine options", items: [] }),
        ]),
      ),
    );
    const tile = (label: string) =>
      document.querySelector(`[aria-label="${label}"]`) as HTMLElement;
    expect(tile("Add routine or folder").querySelector('[data-icon="plus"]')).not.toBeNull();
    expect(tile("Add routine or folder").querySelector("svg")).toBeNull();
    expect(drawn.at(-1)?.[1]).toBe(20);
    // Without one, the tile keeps its ⋯.
    expect(tile("Routine options").querySelector("svg")).not.toBeNull();
  });
});

describe("rows and controls", () => {
  it("picks from a menu of choices, checking the current one", async () => {
    const choose = vi.fn();
    await act(() =>
      root.render(
        h(ChoiceRow<number>, {
          label: "Week starts on",
          value: 1,
          choices: [
            { value: 1, label: "Monday" },
            { value: 0, label: "Sunday" },
          ],
          onChoose: choose,
        }),
      ),
    );
    await press("Week starts on, Monday");
    const radios = [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["Monday", "true"],
      ["Sunday", "false"],
    ]);
    // Picking the current choice changes nothing.
    await act(async () => radios[0]?.click());
    expect(choose).not.toHaveBeenCalled();
    await press("Week starts on, Monday");
    await press("Sunday");
    expect(choose).toHaveBeenCalledWith(0);
  });

  it("steps a number and says when a step can't be taken", async () => {
    const step = vi.fn();
    await act(() =>
      root.render(
        h(Stepper, { value: "Off", label: "Default rest", onStep: step, canDecrease: false }),
      ),
    );
    expect(byLabel("Less default rest")?.getAttribute("aria-disabled")).toBe("true");
    await press("More default rest");
    expect(step).toHaveBeenCalledWith(1);
  });

  it("switches a toggle row as a whole", async () => {
    const change = vi.fn();
    await act(() =>
      root.render(h(ToggleRow, { label: "Warm-ups in stats", on: false, onChange: change })),
    );
    const row = document.querySelector<HTMLElement>('[role="switch"]');
    expect(row?.getAttribute("aria-checked")).toBe("false");
    await act(async () => row?.click());
    expect(change).toHaveBeenCalledWith(true);
  });
});

describe("fields, search and notices", () => {
  it("shows a field's problem as an alert, and nothing without one", async () => {
    await act(() =>
      root.render(
        h(
          "div",
          null,
          h(TextField, { label: "Routine name", value: "Push", onChangeText: () => {} }),
          h(FieldError, { message: "" }),
          h(FieldError, { message: "Name the routine." }),
        ),
      ),
    );
    const alerts = [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    expect(alerts).toEqual(["Name the routine."]);
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Routine name"]')?.value,
    ).toBe("Push");
  });

  it("offers clearing a search only once there is text", async () => {
    const change = vi.fn();
    const render = (value: string) =>
      act(() =>
        root.render(h(SearchField, { label: "Search exercises", value, onChangeText: change })),
      );
    await render("");
    expect(byLabel("Clear search")).toBeNull();
    await render("bench");
    await press("Clear search");
    expect(change).toHaveBeenCalledWith("");
  });

  it("keeps keyboard focus on the muscle control when reached from an empty picker search", {
    timeout: 20000,
  }, async () => {
    await act(() =>
      root.render(h(ExercisePicker, { included: [], onPick: vi.fn(), onClose: vi.fn() })),
    );
    const field = byLabel("Search exercises");
    if (!field) throw Error("Missing search field");
    await act(() => field.focus());
    const chip = byLabel("Muscle filter, All muscles");
    if (!chip) throw Error("Missing muscle filter");
    await act(() => chip.focus());
    expect(document.activeElement).toBe(chip);
    await act(() => chip.click());
    expect(byLabel("Filter by muscle group, All muscles")).not.toBeNull();
    await act(() => byLabel("Cancel")?.focus());
    expect(document.activeElement).toBe(byLabel("Cancel"));
    expect(byLabel("Muscle filter, All muscles")).toBeNull();
  });

  it("keeps the visible Bench Press thumbnail mounted while switching and clearing muscle groups", {
    timeout: 20000,
  }, async () => {
    await act(() =>
      root.render(h(ExercisePicker, { included: [], onPick: vi.fn(), onClose: vi.fn() })),
    );
    const field = byLabel("Search exercises");
    if (!(field instanceof HTMLInputElement)) throw Error("Missing search field");
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field,
        "barbell bench press",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(byLabel("Clear exercise search")).not.toBeNull();
    await press("Muscle filter, All muscles");
    const bench = (muscle = "") => byLabel(`Add Bench Press, Weight and reps${muscle}`);
    const thumbnail = bench()?.querySelector('[aria-label=""]');
    expect(thumbnail).toBeInstanceOf(HTMLElement);
    const select = async (muscle: string) => {
      const chip = Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]')).find(
        (node) => node.textContent === muscle,
      );
      if (!chip) throw Error(`Missing muscle chip ${muscle}`);
      await act(() => chip.click());
      return chip;
    };

    expect((await select("Chest")).getAttribute("aria-checked")).toBe("true");
    expect(bench(", Chest (primary)")?.querySelector('[aria-label=""]')).toBe(thumbnail);
    expect((await select("Triceps")).getAttribute("aria-checked")).toBe("true");
    expect(bench(", Triceps (secondary)")?.querySelector('[aria-label=""]')).toBe(thumbnail);
    expect((await select("Triceps")).getAttribute("aria-checked")).toBe("false");
    expect(bench()?.querySelector('[aria-label=""]')).toBe(thumbnail);
  });

  it("shows a toast for a while, the newest replacing the last", async () => {
    vi.useFakeTimers();
    try {
      await act(() => root.render(h(ToastHost)));
      await act(async () => showToast("Workout saved"));
      expect(document.body.textContent).toContain("Workout saved");
      await act(async () => showToast("Bodyweight saved"));
      expect(document.body.textContent).not.toContain("Workout saved");
      await act(async () => vi.advanceTimersByTime(TOAST_MS - 1));
      expect(document.body.textContent).toContain("Bodyweight saved");
      await act(async () => vi.advanceTimersByTime(1));
      expect(document.body.textContent).not.toContain("Bodyweight saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a banner up until it is dismissed", async () => {
    const dismiss = vi.fn();
    await act(() =>
      root.render(
        h(
          "div",
          null,
          h(Banner, { label: "Not saving", message: "Storage is full.", onDismiss: dismiss }),
          h(EmptyState, { label: "Notes", title: "No notes on this workout" }),
        ),
      ),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Storage is full.");
    await press("OK");
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("No notes on this workout");
  });
});

describe("dialogs and refused saves", () => {
  beforeEach(() => {
    motion.reduced = false;
    motion.shakes = 0;
  });
  const helperAlert = () =>
    [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);
  const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Folder name"]');
  const type = async (text: string) => {
    const input = field();
    if (!input) throw Error("Missing the folder name");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("keeps Create enabled on an empty name, so the refusal shows in the helper line", async () => {
    const change = vi.fn();
    const finish = vi.fn((name: string | null) => finishFolderCreation(change, name));
    await act(() => root.render(h(NewFolderDialog, { onFinish: finish })));
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "New folder",
    );
    expect(document.body.textContent).toContain("Routines move in from their Folder row");
    expect(document.body.textContent).toContain("0 / 30");
    const create = byLabel("Create folder");
    expect(create?.getAttribute("aria-disabled")).not.toBe("true");

    await press("Create folder");
    expect(change).not.toHaveBeenCalled();
    // The hint gives way to the message; the field is marked and shakes once.
    expect(helperAlert()).toEqual(["Enter a folder name."]);
    expect(document.body.textContent).not.toContain("Routines move in from their Folder row");
    expect(field()?.getAttribute("aria-invalid")).toBe("true");
    expect(motion.shakes).toBe(1);
    // Refused again with the same message, it shakes again.
    await press("Create folder");
    expect(motion.shakes).toBe(2);

    // Typing clears the message and brings the hint back.
    await type("Push · Pull · Legs · heavy block");
    expect(helperAlert()).toEqual([]);
    expect(document.body.textContent).toContain("32 / 30");
    await press("Create folder");
    expect(helperAlert()).toEqual(["Use at most 30 characters for the folder name."]);

    // Duplicate names are allowed: a valid name is handed on.
    await type("Push");
    await press("Create folder");
    expect(change).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenLastCalledWith("Push");
  });

  it("renames with the folder's routine count, and ✕ or the scrim leave without a name", async () => {
    const finish = vi.fn();
    await act(() =>
      root.render(
        h(NewFolderDialog, { initialName: "Push day", routineCount: 3, onFinish: finish }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Edit folder",
    );
    // Without a way to delete, none is offered.
    expect(byLabel("Delete folder")).toBeNull();
    expect(field()?.value).toBe("Push day");
    expect(document.body.textContent).toContain("3 routines");
    expect(document.body.textContent).toContain("8 / 30");
    await press("Cancel");
    expect(finish).toHaveBeenLastCalledWith(null);
    await press("Close");
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenLastCalledWith(null);
  });

  it.each([
    [3, "“Push day” will be deleted. Its 3 routines stay and move to Not in a folder."],
    [1, "“Push day” will be deleted. Its routine stays and moves to Not in a folder."],
    [0, "“Push day” will be deleted."],
  ])("deletes an edited folder holding %i routines only once confirmed", async (count, message) => {
    const finish = vi.fn();
    const remove = vi.fn();
    await act(() =>
      root.render(
        h(NewFolderDialog, {
          initialName: "Push day",
          routineCount: count,
          onFinish: finish,
          onDelete: remove,
        }),
      ),
    );
    await press("Delete folder");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(message);
    await confirmChoice("Keep folder");
    expect(remove).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await press("Delete folder");
    await confirmChoice("Delete folder");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });

  it("shows a refused folder deletion in the name's helper line", async () => {
    const remove = vi.fn(() => {
      throw new Error("Resolve the sync issue on this folder before deleting it.");
    });
    await act(() =>
      root.render(
        h(NewFolderDialog, {
          initialName: "Push day",
          routineCount: 2,
          onFinish: vi.fn(),
          onDelete: remove,
        }),
      ),
    );
    await press("Delete folder");
    await confirmChoice("Delete folder");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(helperAlert()).toEqual(["Resolve the sync issue on this folder before deleting it."]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(field()?.value).toBe("Push day");
  });

  it("marks a text field's refusal in its helper line, still with reduced motion", async () => {
    motion.reduced = true;
    const render = (error?: string) =>
      act(() =>
        root.render(
          h(TextField, {
            label: "Exercise name",
            hint: "As it shows in the library",
            count: "0 / 64",
            value: "",
            onChangeText: () => {},
            ...(error ? { error } : {}),
          }),
        ),
      );
    await render();
    expect(document.body.textContent).toContain("As it shows in the library");
    expect(helperAlert()).toEqual([]);
    await render("Enter a name.");
    expect(helperAlert()).toEqual(["Enter a name."]);
    expect(document.body.textContent).not.toContain("As it shows in the library");
    expect(document.body.textContent).toContain("0 / 64");
    expect(
      document.querySelector('input[aria-label="Exercise name"]')?.getAttribute("aria-invalid"),
    ).toBe("true");
    // Reduced motion: the colour and message say it, and the field stays still.
    expect(motion.shakes).toBe(0);
  });

  it("shows a card's problem as a row of its own", async () => {
    await act(() =>
      root.render(h("div", null, h(ErrorRow, { message: "" }), h(ErrorRow, { message: "No." }))),
    );
    expect(helperAlert()).toEqual(["No."]);
  });

  it("offers Off as a rest length after the longest, and sets it", async () => {
    const set = vi.fn();
    await act(() =>
      root.render(
        h(RestDialog, {
          title: "Bench Press",
          note: "After each set of this exercise",
          initialSeconds: 90,
          onSet: set,
          onClose: () => {},
        }),
      ),
    );
    const lengths = [...document.querySelectorAll('[role="radio"]')]
      .map((radio) => radio.getAttribute("aria-label") ?? "")
      .filter((label) => /^(\d|Off)/.test(label));
    expect(lengths).toEqual([
      "0:45",
      "1:00",
      "1:30",
      "2:00",
      "2:30",
      "3:00",
      "4:00",
      "5:00",
      "Off",
    ]);
    expect(document.body.textContent).toContain("Rest timer · Bench Press");
    await press("Off");
    expect(byLabel("Off")?.getAttribute("aria-checked")).toBe("true");
    await press("Set rest to Off");
    expect(set).toHaveBeenCalledWith(0);
  });

  it("lays rest lengths out four to a row, Off taking two places", () => {
    const cells = (keys: string[]) => keys.map((key) => ({ key, wide: key === "Off" }));
    const keys = (rows: ({ key: string } | null)[][]) =>
      rows.map((row) => row.map((cell) => cell?.key ?? "·"));
    expect(keys(gridRows(cells(["1", "2", "3", "4", "5", "6", "7", "8", "Off"])))).toEqual([
      ["1", "2", "3", "4"],
      ["5", "6", "7", "8"],
      ["Off", "·", "·"],
    ]);
    expect(keys(gridRows(cells(["1", "2", "3", "Off"])))).toEqual([
      ["1", "2", "3", "·"],
      ["Off", "·", "·"],
    ]);
    expect(keys(gridRows(cells(["1", "2", "Off"])))).toEqual([["1", "2", "Off"]]);
  });
});

describe("the dock's logging strip on the web", () => {
  const field = (metric: "weight" | "reps", text: string): StripField => ({
    metric,
    name: metric,
    text,
    firm: true,
    unit: metric === "weight" ? "kg" : "reps",
    steps: 0,
    editing: false,
    onStep: () => {},
    onEdit: () => {},
  });

  // `flex: 0` is CSS's `0 1 0%` on the web, whose zero basis wins over a width: the fields drew
  // as their 1 px hairline and left the check alone at the strip's start. The fields now share
  // the strip by growing from nothing, reps up to three 44 pt targets, and the effort column keeps
  // its width as its basis.
  it.each([false, true])("lays its columns out by flex (effort %s)", async (effort) => {
    await act(() =>
      root.render(
        h(SetStrip, {
          fields: [field("weight", "57.5"), field("reps", "7")],
          ...(effort ? { effort: { label: "RIR", value: 2, target: null } } : {}),
          logLabel: "Log set 1",
          canLog: true,
          onLog: () => {},
        }),
      ),
    );
    const strip = byLabel("Log set 1")?.parentElement as
      | (HTMLElement & { __reactLayoutHandler?: (event: unknown) => void })
      | null;
    if (!strip?.__reactLayoutHandler) throw Error("No measured strip");
    await act(() => strip.__reactLayoutHandler?.({ nativeEvent: { layout: { width: 347 } } }));
    const columns = ([...strip.children].slice(0, -1) as HTMLElement[]).map((column) => {
      const style = getComputedStyle(column);
      return [style.flexGrow, style.flexShrink, style.flexBasis, style.maxWidth, style.width];
    });
    expect(columns).toEqual([
      ["1", "1", "0px", "", ""],
      ["1", "1", "0px", "133px", ""],
      ...(effort ? [["0", "0", "48px", "", "48px"]] : []),
    ]);
  });
});
