import { readdirSync, readFileSync } from "node:fs";
import { EXERCISE_CATALOG as catalog } from "@leve/core";
import { expect, it } from "vitest";
import { exerciseImage, exerciseThumb } from "../src/data/exercise-images.ts";

const folder = new URL("../media/exercises/", import.meta.url);
const thumbFolder = new URL("thumbs/", folder);

// Everything else in the folders must be a .webp image, because REUSE.toml licenses the images
// by that pattern. Hidden files (such as .DS_Store) are ignored.
const visible = (file: string) => !file.startsWith(".");
const images = readdirSync(folder).filter(
  (file) => visible(file) && file !== "README.md" && file !== "thumbs",
);
const thumbs = readdirSync(thumbFolder).filter(visible);

it("names every exercise image after a built-in exercise", () => {
  const ids = new Set(catalog.map((exercise) => exercise.id));
  expect(images.length).toBeGreaterThan(0);
  for (const file of images) {
    expect(file).toMatch(/^[a-z0-9-]+\.webp$/);
    expect(ids.has(`builtin:${file.slice(0, -".webp".length)}`), file).toBe(true);
  }
});

it("stores every exercise image and thumbnail as WebP", () => {
  for (const file of [
    ...images.map((f) => new URL(f, folder)),
    ...thumbs.map((f) => new URL(f, thumbFolder)),
  ]) {
    const head = readFileSync(file).subarray(0, 12);
    expect(head.toString("latin1", 0, 4), file.pathname).toBe("RIFF");
    expect(head.toString("latin1", 8, 12), file.pathname).toBe("WEBP");
  }
});

it("has one thumbnail for each image", () => {
  expect([...thumbs].sort()).toEqual([...images].sort());
});

it("shows each image and thumbnail for its own exercise and none for the rest", () => {
  // In tests an imported image is its file's path, so each entry can be traced to its file.
  const files = new Set(images.map((file) => file.slice(0, -".webp".length)));
  for (const { id } of catalog) {
    const name = id.slice("builtin:".length);
    const source = exerciseImage(id);
    const thumb = exerciseThumb(id);
    if (files.has(name)) {
      expect(String(source), id).toMatch(new RegExp(`/exercises/${name}\\.webp$`));
      expect(String(thumb), id).toMatch(new RegExp(`/thumbs/${name}\\.webp$`));
    } else {
      expect(source, id).toBeNull();
      expect(thumb, id).toBeNull();
    }
  }
  for (const lookup of [exerciseImage, exerciseThumb]) {
    expect(lookup("custom:barbell-bench-press")).toBeNull();
    expect(lookup("toString")).toBeNull();
  }
});
