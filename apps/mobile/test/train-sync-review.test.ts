/// <reference lib="dom" />
import type { DeviceStore } from "@leve/storage";
import { act, createElement } from "react";
import { Text } from "react-native";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { World } from "../../../packages/sync/test/support/harness.ts";
import { deleteFolder } from "../src/data/folder-actions.ts";
import { deleteRoutine } from "../src/data/organize-routine.ts";
import { trainData } from "../src/data/read.ts";
import { TrainSyncReview } from "../src/ui/train-sync-review.tsx";

vi.mock("react-native", () => ({
  useColorScheme: () => "dark",
  Platform: { OS: "ios" },
  Text: "Text",
  View: "View",
  StyleSheet: { create: (s: object) => s },
}));
vi.mock("../src/ui/tap.tsx", () => ({ Tap: "Tap" }));
vi.mock("../src/ui/shake.tsx", () => ({ Shake: "Shake" }));
vi.mock("../src/ui/icons.tsx", () => ({ WarnIcon: "Icon" }));
vi.mock("../src/ui/haptics.ts", () => ({
  haptic: { tap: vi.fn(), select: vi.fn(), warning: vi.fn() },
}));
vi.mock("../src/ui/action-sheet.tsx", async () => {
  const { createElement: h, Fragment, useState } = await import("react");
  return {
    // Like the real one, it acts only once its action sheet is confirmed.
    DestructiveButton: function DestructiveButton({
      label,
      action = label,
      onConfirm,
    }: {
      label: string;
      action?: string;
      onConfirm: () => unknown;
    }) {
      const [asking, setAsking] = useState(false);
      return h(
        Fragment,
        null,
        h(
          "Tap",
          { accessibilityRole: "button", onPress: () => setAsking(true) },
          h("Text", null, label),
        ),
        asking &&
          h("ActionSheet", {
            action,
            onConfirm: async () => {
              await onConfirm();
              setAsking(false);
            },
            onClose: () => setAsking(false),
          }),
      );
    },
  };
});

let store: DeviceStore;
vi.mock("../src/data/app-data.tsx", () => ({
  useAppData: () => ({ store, change: (write: (db: DeviceStore) => unknown) => write(store) }),
}));

type Root = ReactTestRenderer["root"];
const texts = (root: Root) =>
  root
    .findAllByType(Text)
    .flatMap((node) => node.children)
    .filter((part): part is string => typeof part === "string");
const tapText = (root: Root, label: string) =>
  act(() => {
    let node = root.find((n) => n.type === Text && n.props.children === label);
    while (!node.props.onPress && node.parent) node = node.parent;
    node.props.onPress();
  });

const plan = (title: string) => ({
  title,
  folderId: "f",
  notes: "",
  position: 1,
  exercises: [],
  effortScale: null,
});

type Phone = Awaited<ReturnType<World["phone"]>>;
async function twoPhones(run: (a: Phone, b: Phone) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const world = new World();
  try {
    const server = world.server({ releases: ["1.0"] });
    const account = { server: "s", account: "athlete", transport: server.transport("athlete") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    a.store.put("routine_folder", "f", { title: "Strength", position: 1 });
    a.store.put("routine", "r", plan("Friday"));
    await a.sync();
    await b.sync();
    await run(a, b);
  } finally {
    await world.dispose();
    vi.unstubAllGlobals();
  }
}

async function render(phone: Phone) {
  store = phone.store;
  const [record] = trainData(store, 0).reviews;
  if (!record) throw new Error("Missing review");
  let rendered: ReactTestRenderer | undefined;
  await act(() => {
    rendered = create(createElement(TrainSyncReview, { record }));
  });
  if (!rendered) throw new Error("Missing review card");
  return rendered;
}

it("restores a routine deleted here after it changed elsewhere", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b) => {
    deleteRoutine(a.store, "r", a.store.get("routine", "r")?.content ?? {});
    b.store.put("routine", "r", plan("Friday heavy"));
    await b.sync();
    await a.sync();
    const rendered = await render(a);
    const root = rendered.root;
    expect(texts(root)).toEqual(
      expect.arrayContaining([
        "Review deleted routine",
        "Deleted on this device",
        "Server",
        "Friday heavy",
        "Restore routine",
      ]),
    );
    await tapText(root, "Restore routine");
    expect(a.store.get("routine", "r")).toMatchObject({
      deleted: false,
      content: { title: "Friday heavy" },
    });
    await act(() => rendered.unmount());
  });
});

it("asks before accepting a routine's deletion, and can save it as new instead", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b) => {
    b.store.put("routine", "r", plan("Friday heavy"));
    deleteRoutine(a.store, "r", a.store.get("routine", "r")?.content ?? {});
    await a.sync();
    await b.sync();
    const rendered = await render(b);
    const root = rendered.root;
    expect(texts(root)).toEqual(
      expect.arrayContaining([
        "Review routine deleted elsewhere",
        "Friday heavy",
        "Deleted on the server",
        "Save as new routine",
        "Accept deletion",
      ]),
    );
    // Accepting asks first; closing the sheet keeps it.
    await tapText(root, "Accept deletion");
    const sheet = () => root.findByType("ActionSheet" as never);
    expect(sheet().props.action).toBe("Delete routine");
    await act(() => sheet().props.onClose());
    expect(b.store.get("routine", "r")).toMatchObject({ deleted: false, status: "conflict" });
    await tapText(root, "Save as new routine");
    expect(b.store.problems()).toEqual([]);
    expect(
      b.store
        .list("routine")
        .filter((row) => !row.deleted)
        .map((row) => row.content?.title),
    ).toEqual(["Friday heavy"]);
    await act(() => rendered.unmount());
  });
});

it("refuses a folder review choice once the folder changed since it was shown", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b) => {
    b.store.put("routine_folder", "f", { title: "Power", position: 1 });
    deleteFolder(a.store, { id: "f", content: { title: "Strength", position: 1 } });
    await a.sync();
    await b.sync();
    const rendered = await render(b);
    const root = rendered.root;
    expect(texts(root)).toEqual(
      expect.arrayContaining(["Review folder deleted elsewhere", "Power", "Accept deletion"]),
    );
    // A download that changes the record makes the shown choice stale.
    b.store.put("routine_folder", "f", { title: "Power two", position: 1 });
    await tapText(root, "Accept deletion");
    expect(texts(root).join(" ")).toMatch(/changed/);
    await act(() => rendered.unmount());
  });
});

it("deletes a routine deleted elsewhere once its deletion is confirmed", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b) => {
    b.store.put("routine", "r", plan("Friday heavy"));
    deleteRoutine(a.store, "r", a.store.get("routine", "r")?.content ?? {});
    await a.sync();
    await b.sync();
    const rendered = await render(b);
    const root = rendered.root;
    await tapText(root, "Accept deletion");
    const sheet = root.findByType("ActionSheet" as never);
    expect(sheet.props.action).toBe("Delete routine");
    await act(() => sheet.props.onConfirm());
    expect(b.store.problems()).toEqual([]);
    expect(b.store.list("routine").filter((row) => !row.deleted)).toEqual([]);
    await b.sync();
    expect(b.store.prepareSubmissions("1.0")).toEqual([]);
    await act(() => rendered.unmount());
  });
});
