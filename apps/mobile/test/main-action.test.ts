import { act, createElement as h, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";

const focus = { Train: true, History: false };
vi.mock("expo-router", () => ({
  useIsFocused: () => focus[current as keyof typeof focus],
}));
let current = "Train";

const { MainAction, MainActionProvider, MainActionSlot } = await import(
  "../src/ui/main-action.tsx"
);

/** A tab screen offering an action, rendered while `current` names it. */
function Screen({ name, action }: { name: string; action: ReactNode }) {
  current = name;
  return h(MainAction, null, action);
}

function Tabs({ train, history }: { train: ReactNode; history: ReactNode }) {
  return h(
    MainActionProvider,
    null,
    h(Screen, { name: "Train", action: train }),
    h(Screen, { name: "History", action: history }),
    h(MainActionSlot, {
      render: (offered: ReactNode) => h("slot", null, running ? h("running", null) : offered),
    }),
  );
}
let running = false;

it("shows the focused screen's action, follows changes, and gives way to a running workout", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let tree: ReactTestRenderer | undefined;
  try {
    const shown = () =>
      tree?.root.findByType("slot" as never).children.map((c) => (c as { type: string }).type);
    await act(() => {
      tree = create(h(Tabs, { train: h("start", null), history: h("other", null) }));
    });
    expect(shown()).toEqual(["start"]);

    // A changed offer replaces the old one rather than stacking.
    await act(() => tree?.update(h(Tabs, { train: h("resume", null), history: null })));
    expect(shown()).toEqual(["resume"]);

    // Once another tab is focused, the one that left withdraws its action.
    focus.Train = false;
    focus.History = true;
    await act(() => tree?.update(h(Tabs, { train: h("resume", null), history: null })));
    expect(shown()).toEqual([]);
    await act(() => tree?.update(h(Tabs, { train: h("resume", null), history: h("other", null) })));
    expect(shown()).toEqual(["other"]);

    running = true;
    await act(() => tree?.update(h(Tabs, { train: null, history: h("other", null) })));
    expect(shown()).toEqual(["running"]);
  } finally {
    await act(() => tree?.unmount());
    vi.unstubAllGlobals();
  }
});

it("draws nothing outside a slot and leaves nothing behind when a screen goes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  focus.Train = true;
  running = false;
  let tree: ReactTestRenderer | undefined;
  try {
    await act(() => {
      tree = create(h(MainAction, null, h("start", null)));
    });
    expect(tree?.toJSON()).toBeNull();
    const slot = (offered: ReactNode) => h("slot", null, offered);
    await act(() =>
      tree?.update(
        h(
          MainActionProvider,
          null,
          h(Screen, { name: "Train", action: h("start", null) }),
          h(MainActionSlot, { render: slot }),
        ),
      ),
    );
    expect(tree?.root.findAllByType("start" as never)).toHaveLength(1);
    await act(() => tree?.update(h(MainActionProvider, null, h(MainActionSlot, { render: slot }))));
    expect(tree?.root.findAllByType("start" as never)).toHaveLength(0);
  } finally {
    await act(() => tree?.unmount());
    vi.unstubAllGlobals();
  }
});
