import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import catalog from "../src/data/exercise-catalog.json";
import { exerciseImage } from "../src/data/exercise-images.ts";

const folder = new URL("../media/exercises/", import.meta.url);

// Everything else in the folder must be a .webp image, because REUSE.toml licenses the images
// by that pattern. Hidden files (such as .DS_Store) are ignored.
const images = readdirSync(folder).filter((file) => file !== "README.md" && !file.startsWith("."));

it("names every exercise image after a built-in exercise", () => {
  const ids = new Set(catalog.map((exercise) => exercise.id));
  expect(images.length).toBeGreaterThan(0);
  for (const file of images) {
    expect(file).toMatch(/^[a-z0-9-]+\.webp$/);
    expect(ids.has(`builtin:${file.slice(0, -".webp".length)}`), file).toBe(true);
  }
});

it("stores every exercise image as WebP", () => {
  for (const file of images) {
    const head = readFileSync(new URL(file, folder)).subarray(0, 12);
    expect(head.toString("latin1", 0, 4), file).toBe("RIFF");
    expect(head.toString("latin1", 8, 12), file).toBe("WEBP");
  }
});

it("shows each image for its own exercise and no image for the rest", () => {
  // In tests an imported image is its file's path, so each entry can be traced to its file.
  const files = new Set(images.map((file) => file.slice(0, -".webp".length)));
  for (const { id } of catalog) {
    const name = id.slice("builtin:".length);
    const source = exerciseImage(id);
    if (files.has(name)) expect(String(source), id).toMatch(new RegExp(`/${name}\\.webp$`));
    else expect(source, id).toBeNull();
  }
  expect(exerciseImage("custom:barbell-bench-press")).toBeNull();
  expect(exerciseImage("toString")).toBeNull();
});
