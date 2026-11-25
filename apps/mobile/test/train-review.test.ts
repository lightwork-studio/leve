import { join } from "node:path";
import { expect, it } from "vitest";
import { World } from "../../../packages/sync/test/support/harness.ts";
import { deleteFolder } from "../src/data/folder-actions.ts";
import { deleteRoutine } from "../src/data/organize-routine.ts";
import { trainData } from "../src/data/read.ts";
import {
  resolveTrainReview,
  trainReviewCase,
  trainReviewChoices,
} from "../src/data/train-review.ts";

const plan = (title: string, folderId: string | null, position: number) => ({
  title,
  folderId,
  notes: "",
  position,
  exercises: [],
  effortScale: null,
});

type Phone = Awaited<ReturnType<World["phone"]>>;

/**
 * Two phones with one folder and one routine in it, both synced. `restore` puts the server back to
 * how it was before either existed.
 */
async function twoPhones(run: (a: Phone, b: Phone, restore: () => Promise<void>) => Promise<void>) {
  const world = new World();
  try {
    const server = world.server({ releases: ["1.0"] });
    const account = { server: "s", account: "athlete", transport: server.transport("athlete") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    await a.sync();
    const backup = join(world.directory, "backup.db");
    await server.snapshot("athlete", backup);
    a.store.put("routine_folder", "f", { title: "Strength", position: 1 });
    a.store.put("routine", "r", plan("Friday", "f", 1));
    await a.sync();
    await b.sync();
    await run(a, b, async () => {
      await server.restoreWithCommand("athlete", backup);
    });
  } finally {
    await world.dispose();
  }
}

const shown = (phone: Phone) =>
  trainData(phone.store, 0).groups.map((group) => [
    group.folder?.content.title ?? null,
    group.routines.map((routine) => routine.title),
  ]);

/** Syncs both phones until each has sent everything, and checks nothing is left to review. */
const settled = async (first: Phone, second: Phone) => {
  await first.sync();
  await second.sync();
  await first.sync();
  for (const phone of [first, second]) {
    expect(phone.store.problems()).toEqual([]);
    expect(phone.store.prepareSubmissions("1.0")).toEqual([]);
  }
};

const opened = (phone: Phone) => phone.store.get("routine", "r")?.content ?? {};
const strength = { id: "f", content: { title: "Strength", position: 1 } };

it("offers a routine and folder deleted here after they changed elsewhere for review, and restores them", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b) => {
    deleteRoutine(a.store, "r", opened(a));
    deleteFolder(a.store, strength);
    b.store.put("routine", "r", plan("Friday heavy", "f", 1));
    b.store.put("routine_folder", "f", { title: "Power", position: 1 });
    await b.sync();
    await a.sync();

    // Train shows nothing else of them, while the server keeps both.
    expect(shown(a)).toEqual([]);
    const reviews = trainData(a.store, 0).reviews;
    expect(reviews.map((row) => [row.kind, row.id, trainReviewCase(row)])).toEqual(
      expect.arrayContaining([
        ["routine", "r", "restore"],
        ["routine_folder", "f", "restore"],
      ]),
    );
    expect(reviews).toHaveLength(2);
    for (const row of reviews) {
      expect(trainReviewChoices(row)).toEqual(["keep_theirs"]);
      // Only what is offered can be chosen.
      expect(() => resolveTrainReview(a.store, row, "keep_mine")).toThrow(/offered/);
    }
    for (const row of reviews) resolveTrainReview(a.store, row, "keep_theirs");
    expect(trainData(a.store, 0).reviews).toEqual([]);
    expect(shown(a)).toEqual([["Power", ["Friday heavy"]]]);
    await settled(a, b);
    expect(shown(b)).toEqual([["Power", ["Friday heavy"]]]);
  });
});

it("refuses a review choice once the record changed since it was shown", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b) => {
    deleteRoutine(a.store, "r", opened(a));
    b.store.put("routine", "r", plan("Friday heavy", "f", 1));
    await b.sync();
    await a.sync();
    const [seen] = trainData(a.store, 0).reviews;
    if (!seen) throw new Error("Missing review");
    b.store.put("routine", "r", plan("Friday heavier", "f", 1));
    await b.sync();
    await a.sync();
    expect(() => resolveTrainReview(a.store, seen, "keep_theirs")).toThrow(/changed/);
    const [latest] = trainData(a.store, 0).reviews;
    expect(latest?.server?.content).toMatchObject({ title: "Friday heavier" });
  });
});

it.each(["save_as_new", "keep_theirs"] as const)(
  "offers a routine edited here after it was deleted elsewhere for review (%s)",
  {
    timeout: 60000,
  },
  async (choice) => {
    await twoPhones(async (a, b) => {
      b.store.put("routine", "r", plan("Friday heavy", "f", 1));
      deleteRoutine(a.store, "r", opened(a));
      await a.sync();
      await b.sync();
      const [row] = trainData(b.store, 0).reviews;
      if (!row) throw new Error("Missing review");
      expect([row.kind, row.id, trainReviewCase(row)]).toEqual([
        "routine",
        "r",
        "deleted_elsewhere",
      ]);
      expect(trainReviewChoices(row)).toEqual(["save_as_new", "keep_theirs"]);
      resolveTrainReview(b.store, row, choice);
      await settled(b, a);
      const expected =
        choice === "save_as_new" ? [["Strength", ["Friday heavy"]]] : [["Strength", []]];
      expect(shown(a)).toEqual(expected);
      expect(shown(b)).toEqual(expected);
      // Saved as new, the routine has a new id: the deleted one stays deleted.
      expect(b.store.get("routine", "r")?.deleted ?? true).toBe(true);
    });
  },
);

it.each([
  [
    "save_as_new",
    [
      ["Power", []],
      [null, ["Friday"]],
    ],
  ],
  ["keep_theirs", [[null, ["Friday"]]]],
] as const)(
  "offers a folder renamed here after it was deleted elsewhere, its routines kept (%s)",
  {
    timeout: 60000,
  },
  async (choice, expected) => {
    await twoPhones(async (a, b) => {
      b.store.put("routine_folder", "f", { title: "Power", position: 1 });
      deleteFolder(a.store, strength);
      await a.sync();
      await b.sync();
      const [row] = trainData(b.store, 0).reviews;
      if (!row) throw new Error("Missing review");
      expect(trainReviewCase(row)).toBe("deleted_elsewhere");
      expect(trainReviewChoices(row)).toEqual(["save_as_new", "keep_theirs"]);
      expect(() => resolveTrainReview(b.store, row, "keep_mine")).toThrow(/offered/);
      resolveTrainReview(b.store, row, choice);
      await settled(b, a);
      // Saved as new, the folder is empty: its routines stay where the deletion left them.
      expect(shown(a)).toEqual(expected);
      expect(shown(b)).toEqual(expected);
    });
  },
);

it.each([
  ["keep_mine", "Power"],
  ["keep_theirs", "Lifting"],
] as const)(
  "settles a folder renamed on both phones (%s)",
  {
    timeout: 60000,
  },
  async (choice, title) => {
    await twoPhones(async (a, b) => {
      a.store.put("routine_folder", "f", { title: "Lifting", position: 1 });
      await a.sync();
      b.store.put("routine_folder", "f", { title: "Power", position: 1 });
      await b.sync();
      const [row] = trainData(b.store, 0).reviews;
      if (!row) throw new Error("Missing review");
      expect(trainReviewCase(row)).toBe("both_changed");
      // Deleting waits for the review.
      expect(() =>
        deleteFolder(b.store, { id: "f", content: { title: "Power", position: 1 } }),
      ).toThrow(/sync issue/);
      resolveTrainReview(b.store, row, choice);
      await settled(b, a);
      expect(shown(a)).toEqual([[title, ["Friday"]]]);
      expect(shown(b)).toEqual([[title, ["Friday"]]]);
    });
  },
);

it("leaves a routine changed on both phones to its editor's review", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b) => {
    a.store.put("routine", "r", plan("Friday A", "f", 1));
    await a.sync();
    b.store.put("routine", "r", plan("Friday B", "f", 1));
    await b.sync();
    expect(b.store.get("routine", "r")?.status).toBe("conflict");
    expect(trainData(b.store, 0).reviews).toEqual([]);
  });
});

it.each(["save_as_new", "keep_theirs"] as const)(
  "offers a routine a server restore left with no server copy for review (%s)",
  {
    timeout: 60000,
  },
  async (choice) => {
    await twoPhones(async (a, b, restore) => {
      deleteRoutine(b.store, "r", opened(b));
      await b.sync();
      a.store.put("routine", "r", plan("Friday heavy", "f", 1));
      await a.sync();
      await restore();
      // The other phone stays silent, as a retired or reset one would.
      for (let i = 0; i < 4; i++) await a.sync();
      const row = trainData(a.store, 0).reviews.find((review) => review.kind === "routine");
      if (!row) throw new Error("Missing review");
      expect(row).toMatchObject({ server: null, content: { title: "Friday heavy" } });
      expect(trainReviewCase(row)).toBe("missing_on_server");
      expect(trainReviewChoices(row)).toEqual(["save_as_new", "keep_theirs"]);
      resolveTrainReview(a.store, row, choice);
      await a.sync();
      await a.sync();
      expect(a.store.problems().filter((p) => p.kind === "routine")).toEqual([]);
      const titles = a.store
        .list("routine")
        .filter((r) => !r.deleted)
        .map((r) => r.content?.title);
      expect(titles).toEqual(choice === "save_as_new" ? ["Friday heavy"] : []);
      // Saved as new, the routine has a new id: the deleted one is never restored under its old id.
      expect(a.store.get("routine", "r")?.deleted ?? true).toBe(true);
      expect(a.store.prepareSubmissions("1.0")).toEqual([]);
    });
  },
);

it("offers a folder changed on both phones, through a restore without it, back to the previous copy", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b, restore) => {
    b.store.put("routine_folder", "f", { title: "Power", position: 1 });
    await b.sync();
    a.store.put("routine_folder", "f", { title: "Lifting", position: 1 });
    await a.sync();
    await restore();
    for (let i = 0; i < 4; i++) await a.sync();
    const row = trainData(a.store, 0).reviews.find((review) => review.kind === "routine_folder");
    if (!row) throw new Error("Missing review");
    expect(trainReviewCase(row)).toBe("missing_on_server");
    expect(row.keptContent).toMatchObject({ title: "Power" });
    resolveTrainReview(a.store, row, "keep_theirs");
    await a.sync();
    await a.sync();
    expect(a.store.problems().filter((p) => p.kind === "routine_folder")).toEqual([]);
    expect(a.store.get("routine_folder", "f")?.content).toMatchObject({ title: "Power" });
  });
});

it("restores a routine a server restore brought back after it was deleted here", {
  timeout: 60000,
}, async () => {
  const world = new World();
  try {
    const server = world.server({ releases: ["1.0"] });
    const account = { server: "s", account: "athlete", transport: server.transport("athlete") };
    const a = await world.phone("a", account);
    a.store.put("routine", "r", plan("Friday", null, 1));
    await a.sync();
    const backup = join(world.directory, "backup.db");
    await server.snapshot("athlete", backup);
    deleteRoutine(a.store, "r", opened(a));
    await a.sync();
    await server.restoreWithCommand("athlete", backup);
    for (let i = 0; i < 3; i++) await a.sync();
    const [row] = trainData(a.store, 0).reviews;
    if (!row) throw new Error("Missing review");
    expect(trainReviewCase(row)).toBe("restore");
    expect(row.problem?.reason).toBe("restored");
    resolveTrainReview(a.store, row, "keep_theirs");
    expect(a.store.get("routine", "r")).toMatchObject({
      deleted: false,
      content: { title: "Friday" },
    });
    await a.sync();
    await a.sync();
    deleteRoutine(a.store, "r", opened(a));
    await a.sync();
    expect(a.store.problems()).toEqual([]);
    expect(await server.row("athlete", "routine", "r")).toMatchObject({ state: "deleted" });
  } finally {
    await world.dispose();
  }
});

it("restores the copy kept from before a server restore, and asks to sync before deleting it", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b, restore) => {
    deleteRoutine(a.store, "r", opened(a));
    b.store.put("routine", "r", plan("Friday heavy", "f", 1));
    await b.sync();
    await a.sync();
    await restore();
    for (let i = 0; i < 3; i++) await a.sync();
    const row = trainData(a.store, 0).reviews.find((review) => review.kind === "routine");
    if (!row) throw new Error("Missing review");
    expect(row).toMatchObject({ deleted: true, server: null });
    expect(trainReviewCase(row)).toBe("restore");
    resolveTrainReview(a.store, row, "keep_theirs");
    const restored = a.store.get("routine", "r");
    expect(restored).toMatchObject({
      deleted: false,
      fromRestore: true,
      content: { title: "Friday heavy" },
    });
    // Offered again but not yet synced: deleting it says so, rather than pointing at a sync issue.
    expect(() => deleteRoutine(a.store, "r", opened(a))).toThrow(/Sync this routine/);
    await a.sync();
    await a.sync();
    deleteRoutine(a.store, "r", opened(a));
    await a.sync();
    expect(a.store.problems().filter((p) => p.kind === "routine")).toEqual([]);
  });
});
