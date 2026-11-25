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

/** Two phones with one folder and one routine in it, both synced. */
async function twoPhones(run: (a: Phone, b: Phone) => Promise<void>) {
  const world = new World();
  try {
    const server = world.server({ releases: ["1.0"] });
    const account = { server: "s", account: "athlete", transport: server.transport("athlete") };
    const a = await world.phone("a", account);
    const b = await world.phone("b", account);
    a.store.put("routine_folder", "f", { title: "Strength", position: 1 });
    a.store.put("routine", "r", plan("Friday", "f", 1));
    await a.sync();
    await b.sync();
    await run(a, b);
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

it("offers a folder renamed here after it was deleted elsewhere, its routines kept", {
  timeout: 60000,
}, async () => {
  await twoPhones(async (a, b) => {
    b.store.put("routine_folder", "f", { title: "Power", position: 1 });
    deleteFolder(a.store, strength);
    await a.sync();
    await b.sync();
    const [row] = trainData(b.store, 0).reviews;
    if (!row) throw new Error("Missing review");
    expect(trainReviewCase(row)).toBe("deleted_elsewhere");
    expect(trainReviewChoices(row)).toEqual(["keep_theirs"]);
    expect(() => resolveTrainReview(b.store, row, "save_as_new")).toThrow(/offered/);
    resolveTrainReview(b.store, row, "keep_theirs");
    await settled(b, a);
    expect(shown(a)).toEqual([[null, ["Friday"]]]);
    expect(shown(b)).toEqual([[null, ["Friday"]]]);
  });
});

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
