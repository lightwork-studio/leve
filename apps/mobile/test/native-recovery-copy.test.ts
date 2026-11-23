import { expect, it, vi } from "vitest";
import { openEngine } from "../src/data/engine.ts";

const state = vi.hoisted(() => ({
  inputs: new Map<string, Uint8Array>(),
  outputs: new Map<string, Uint8Array>(),
  pick: vi.fn(),
}));
vi.mock("expo-sqlite", () => ({
  defaultDatabaseDirectory: "file:///sqlite",
  openDatabaseSync: vi.fn(),
  backupDatabaseSync: vi.fn(),
  backupDatabaseAsync: vi.fn(),
}));
vi.mock("expo-file-system", () => {
  class File {
    constructor(
      _directory: unknown,
      readonly name: string,
    ) {}
    bytes() {
      return Promise.resolve(state.inputs.get(this.name));
    }
  }
  class Directory {
    readonly exists: boolean;
    constructor(_parent: string, name?: string) {
      this.exists = name !== "leve-preview-protocol-1-sqlite-inspection";
    }
    static pickDirectoryAsync = state.pick;
    list() {
      return [...state.inputs.keys()].map((name) => new File(this, name));
    }
  }
  return { Directory, File, Paths: { cache: "file:///cache" } };
});

it("copies only Leve's database files and snapshots to the selected recovery folder", async () => {
  state.inputs.set("leve-preview-protocol-1__device.db", Uint8Array.of(1, 2));
  state.inputs.set("leve-preview-protocol-1__device.db-journal", Uint8Array.of(3));
  state.inputs.set("leve-preview-protocol-1__device.db.pre-v3", Uint8Array.of(4, 0));
  state.inputs.set("leve__device.db", Uint8Array.of(6));
  state.inputs.set("other.db", Uint8Array.of(5));
  const createDirectory = vi.fn(() => ({
    createFile: (name: string) => ({
      write: async (bytes: Uint8Array) => {
        state.outputs.set(name, bytes.slice());
      },
    }),
  }));
  state.pick.mockRejectedValueOnce(new Error("cancelled")).mockResolvedValue({ createDirectory });
  const opened = await openEngine();
  const initial = [...state.inputs.entries()];
  await expect(opened.exportRecovery()).rejects.toThrow("cancelled");
  expect(state.outputs.size).toBe(0);
  await opened.exportRecovery();
  expect(createDirectory).toHaveBeenCalledWith(expect.stringMatching(/^leve-recovery-/));
  expect([...state.outputs.entries()]).toEqual(initial.slice(0, 3));
  expect([...state.inputs.entries()]).toEqual(initial);
});
