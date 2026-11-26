import { readdirSync, readFileSync } from "node:fs";
import { EXERCISE_CATALOG as catalog } from "@leve/core";
import { expect, it } from "vitest";

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
