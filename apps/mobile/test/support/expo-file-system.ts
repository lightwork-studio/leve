// Node stand-in for expo-file-system in tests: files kept in memory, as the phone keeps them.
export const files = new Map<string, string>();

export class Directory {
  constructor(readonly uri: string) {}
}

export const Paths = { document: new Directory("document") };

export class File {
  readonly path: string;
  constructor(folder: Directory, name: string) {
    this.path = `${folder.uri}/${name}`;
  }
  get exists() {
    return files.has(this.path);
  }
  create() {
    files.set(this.path, "");
  }
  textSync() {
    return files.get(this.path) ?? "";
  }
  writeSync(content: string) {
    files.set(this.path, content);
  }
}
