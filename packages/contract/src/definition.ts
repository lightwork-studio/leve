import {
  type Infer,
  type Issue,
  object,
  type Schema,
  type SchemaDescription,
  validate,
} from "./schema.ts";

/** A protocol release such as `1.0`. Minor releases only add optional fields. */
export type ReleaseId = `${number}.${number}`;

export interface FieldDefinition<T = unknown> {
  schema: Schema<T>;
  /** The release that introduced the field. */
  since: ReleaseId;
  /**
   * The major release that removed the field. A field can only be removed by a new major; minor
   * releases never take anything away.
   */
  removedIn?: number;
  /**
   * Required fields must hold a value in every record. Only fields a kind starts with (or a new
   * major) can be required. Every other field must be nullable: null means "not set", and stored
   * content written before the field existed reads as null.
   */
  required?: boolean;
}

export interface KindDefinition {
  since: ReleaseId;
  /** A child record names its parent in this field. Deleting the parent deletes the child. */
  parent?: {
    kind: string;
    field: string;
    /** A per-parent setting takes its parent’s ID and is deleted only with that parent. */
    sharedId?: true;
  };
  /** A kind with exactly one record per account, always stored under this id. */
  singletonId?: string;
  /** What each field means, frozen with every release that has the field. */
  meanings?: Record<string, string>;
  fields: Record<string, FieldDefinition>;
}

export interface FeatureDefinition {
  since: ReleaseId;
  description: string;
  /** Fields that entering this feature writes; they must exist from `since`. */
  fields: readonly (readonly [kind: string, field: string])[];
}

export interface ContractDefinition {
  /** Every release that exists, oldest first. Frozen releases never change. */
  releases: readonly ReleaseId[];
  kinds: Record<string, KindDefinition>;
  features: Record<string, FeatureDefinition>;
}

type FieldValue<F> = F extends FieldDefinition<infer T> ? T : never;
type RequiredFieldNames<K extends KindDefinition> = {
  [N in keyof K["fields"]]: K["fields"][N] extends { required: true } ? N : never;
}[keyof K["fields"]];

/** The current logical content of a record of kind `K`. */
export type ContentOf<K extends KindDefinition> = {
  -readonly [N in RequiredFieldNames<K>]: FieldValue<K["fields"][N]>;
} & {
  -readonly [N in Exclude<keyof K["fields"], RequiredFieldNames<K>>]?: FieldValue<K["fields"][N]>;
};

/** The largest record content, as UTF-8 JSON, that any release accepts. */
export const MAX_RECORD_BYTES = 200_000;

/** UTF-8 length of the JSON text of `value`, without needing TextEncoder. */
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value) ?? "";
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

const sizeIssues = (content: unknown): Issue[] =>
  jsonBytes(content) > MAX_RECORD_BYTES
    ? [{ path: "$", message: `record larger than ${MAX_RECORD_BYTES} bytes` }]
    : [];

export const parseRelease = (release: ReleaseId): { major: number; minor: number } => {
  const [major, minor] = release.split(".").map(Number);
  return { major: major ?? Number.NaN, minor: minor ?? Number.NaN };
};

export const compareReleases = (a: ReleaseId, b: ReleaseId): number => {
  const x = parseRelease(a);
  const y = parseRelease(b);
  return x.major - y.major || x.minor - y.minor;
};

/** Whether something introduced in `since` (and removed in major `removedIn`) is in `release`. */
export function inRelease(release: ReleaseId, since: ReleaseId, removedIn?: number): boolean {
  if (compareReleases(release, since) < 0) return false;
  return removedIn === undefined || parseRelease(release).major < removedIn;
}

export type JsonObject = Record<string, unknown>;

export interface EncodedContent {
  content: JsonObject;
  /** Fields holding a value that this release cannot carry. Uploading such a record is lossy. */
  omitted: string[];
  /** Validation problems of the encoded content; non-empty means the release can't represent it. */
  issues: Issue[];
}

export interface Contract<D extends ContractDefinition = ContractDefinition> {
  readonly definition: D;
  readonly releases: readonly ReleaseId[];
  readonly latest: ReleaseId;
  kindNames(release?: ReleaseId): string[];
  hasKind(kind: string, release?: ReleaseId): boolean;
  kind(kind: string): KindDefinition;
  fieldNames(kind: string, release?: ReleaseId): string[];
  /**
   * The strict wire schema of `kind` in `release` (the latest by default): every field the
   * release defines must be present, optional ones as null when not set.
   */
  wireSchema(kind: string, release?: ReleaseId): Schema<JsonObject>;
  /** Fills in null for every current optional field that `content` lacks. */
  normalize(kind: string, content: JsonObject): JsonObject;
  /** Validates normalized current content. */
  validateContent(kind: string, content: unknown, id?: string): Issue[];
  /** Picks the fields `release` defines and reports values it had to leave out. */
  encode(kind: string, content: JsonObject, release: ReleaseId): EncodedContent;
  /** Validates content received in `release`. */
  decode(kind: string, content: unknown, release: ReleaseId, id?: string): Issue[];
  /**
   * Applies content received in `release` to the stored content: fields the release defines are
   * replaced, fields it doesn't define keep their stored value.
   */
  applyOmissionRule(
    kind: string,
    stored: JsonObject | null,
    received: JsonObject,
    release: ReleaseId,
  ): JsonObject;
  /** The parent named by a child record's content, if the kind has a parent. */
  parentOf(kind: string, content: JsonObject): { kind: string; id: string } | null;
  childKinds(kind: string): { kind: string; field: string }[];
  featureAvailable(feature: string, release: ReleaseId): boolean;
  features(release: ReleaseId): string[];
  /** Canonical, frozen-comparable description of a release's record contents. */
  describeRelease(release: ReleaseId): Record<string, unknown>;
}

function checkDefinition(definition: ContractDefinition): void {
  const { releases, kinds, features } = definition;
  if (releases.length === 0) throw new Error("a contract needs at least one release");
  for (let index = 1; index < releases.length; index++) {
    if (compareReleases(releases[index - 1] as ReleaseId, releases[index] as ReleaseId) >= 0) {
      throw new Error("releases must be listed oldest first without duplicates");
    }
  }
  const known = new Set(releases);
  for (const [kindName, kind] of Object.entries(kinds)) {
    if (!known.has(kind.since)) throw new Error(`${kindName}: unknown release ${kind.since}`);
    for (const [fieldName, field] of Object.entries(kind.fields)) {
      const where = `${kindName}.${fieldName}`;
      if (!known.has(field.since)) throw new Error(`${where}: unknown release ${field.since}`);
      if (compareReleases(field.since, kind.since) < 0) {
        throw new Error(`${where}: field is older than its kind`);
      }
      const startsWithKind = field.since === kind.since;
      const startsMajor = parseRelease(field.since).minor === 0;
      if (field.required && !startsWithKind && !startsMajor) {
        throw new Error(`${where}: a field added in a minor release must be optional`);
      }
      if (!field.required && field.schema.description.type !== "nullable") {
        throw new Error(`${where}: an optional field must be nullable`);
      }
      if (field.removedIn !== undefined && field.removedIn <= parseRelease(field.since).major) {
        throw new Error(`${where}: removedIn must be a later major`);
      }
    }
    if (kind.parent) {
      const parentField = kind.fields[kind.parent.field];
      if (!kinds[kind.parent.kind] || !parentField?.required) {
        throw new Error(`${kindName}: parent must be an existing kind and a required field`);
      }
      // An older app deleting the parent couldn't list the new children, so a kind below an
      // existing kind needs a major release.
      const parentSince = (kinds[kind.parent.kind] as { since: ReleaseId }).since;
      if (parseRelease(kind.since).minor !== 0 && compareReleases(parentSince, kind.since) < 0) {
        throw new Error(`${kindName}: a kind below an existing kind needs a major release`);
      }
    }
  }
  for (const [name, feature] of Object.entries(features)) {
    if (!known.has(feature.since)) throw new Error(`feature ${name}: unknown release`);
    for (const [kindName, fieldName] of feature.fields) {
      const field = kinds[kindName]?.fields[fieldName];
      if (!field || compareReleases(field.since, feature.since) > 0) {
        throw new Error(`feature ${name}: ${kindName}.${fieldName} is missing in ${feature.since}`);
      }
    }
  }
}

const isPresent = (content: JsonObject, field: string) =>
  Object.hasOwn(content, field) && content[field] !== undefined;

export function createContract<const D extends ContractDefinition>(definition: D): Contract<D> {
  checkDefinition(definition);
  const releases = definition.releases;
  const latest = releases[releases.length - 1] as ReleaseId;
  const schemaCache = new Map<string, Schema<JsonObject>>();

  const kind = (name: string): KindDefinition => {
    const found = definition.kinds[name];
    if (!found) throw new Error(`unknown record kind ${name}`);
    return found;
  };
  const hasKind = (name: string, release: ReleaseId = latest) => {
    const found = definition.kinds[name];
    return found !== undefined && inRelease(release, found.since);
  };
  const fieldNames = (name: string, release: ReleaseId = latest) =>
    Object.entries(kind(name).fields)
      .filter(([, field]) => inRelease(release, field.since, field.removedIn))
      .map(([fieldName]) => fieldName)
      .sort();

  const wireSchema = (name: string, release: ReleaseId = latest): Schema<JsonObject> => {
    const key = `${name}@${release}`;
    let schema = schemaCache.get(key);
    if (!schema) {
      if (!hasKind(name, release)) throw new Error(`${name} does not exist in ${release}`);
      const fields = kind(name).fields;
      const names = fieldNames(name, release);
      const shape: Record<string, Schema<unknown>> = {};
      for (const fieldName of names)
        shape[fieldName] = (fields[fieldName] as FieldDefinition).schema;
      schema = object(shape) as unknown as Schema<JsonObject>;
      schemaCache.set(key, schema);
    }
    return schema;
  };

  const contentIssues = (
    name: string,
    content: unknown,
    release: ReleaseId,
    id?: string,
  ): Issue[] => {
    if (!hasKind(name, release)) return [{ path: "$", message: `unknown kind ${name}` }];
    const issues = [...validate(wireSchema(name, release), content), ...sizeIssues(content)];
    const parent = kind(name).parent;
    if (
      id !== undefined &&
      parent?.sharedId &&
      !issues.length &&
      (content as JsonObject)[parent.field] !== id
    )
      issues.push({ path: `$.${parent.field}`, message: "must use its parent record’s ID" });
    return issues;
  };

  const contract: Contract<D> = {
    definition,
    releases,
    latest,
    kindNames: (release = latest) =>
      Object.keys(definition.kinds)
        .filter((name) => hasKind(name, release))
        .sort(),
    hasKind,
    kind,
    fieldNames,
    wireSchema,
    normalize(name, content) {
      const fields = kind(name).fields;
      const result: JsonObject = {};
      for (const field of fieldNames(name)) {
        if (isPresent(content, field)) result[field] = content[field];
        else if (!fields[field]?.required) result[field] = null;
      }
      for (const field of Object.keys(content).sort()) {
        if (!Object.hasOwn(result, field) && isPresent(content, field)) {
          result[field] = content[field];
        }
      }
      return result;
    },
    validateContent: (name, content, id) => contentIssues(name, content, latest, id),
    encode(name, content, release) {
      const fields = kind(name).fields;
      const allowed = new Set(fieldNames(name, release));
      const encoded: JsonObject = {};
      for (const field of [...allowed].sort()) {
        if (isPresent(content, field)) encoded[field] = content[field];
        else if (!fields[field]?.required) encoded[field] = null;
      }
      const omitted = Object.keys(content)
        .filter((field) => !allowed.has(field) && isPresent(content, field))
        .filter((field) => content[field] !== null)
        .sort();
      return { content: encoded, omitted, issues: validate(wireSchema(name, release), encoded) };
    },
    decode: contentIssues,
    applyOmissionRule(name, stored, received, release) {
      const defined = new Set(fieldNames(name, release));
      const current = new Set(fieldNames(name));
      const result: JsonObject = {};
      for (const field of [...current].sort()) {
        if (defined.has(field)) {
          result[field] = isPresent(received, field) ? received[field] : null;
        } else {
          result[field] = stored && isPresent(stored, field) ? stored[field] : null;
        }
      }
      return contract.normalize(name, result);
    },
    parentOf(name, content) {
      const parent = kind(name).parent;
      if (!parent) return null;
      const parentId = content[parent.field];
      return typeof parentId === "string" ? { kind: parent.kind, id: parentId } : null;
    },
    childKinds: (name) =>
      Object.entries(definition.kinds)
        .filter(([, child]) => child.parent?.kind === name)
        .map(([childName, child]) => ({
          kind: childName,
          field: (child.parent as { field: string }).field,
        })),
    featureAvailable(feature, release) {
      const found = definition.features[feature];
      if (!found) throw new Error(`unknown feature ${feature}`);
      return inRelease(release, found.since);
    },
    features: (release) =>
      Object.entries(definition.features)
        .filter(([, feature]) => inRelease(release, feature.since))
        .map(([name]) => name)
        .sort(),
    describeRelease(release) {
      if (!releases.includes(release)) throw new Error(`unknown release ${release}`);
      const kinds: Record<string, unknown> = {};
      for (const name of contract.kindNames(release)) {
        const found = kind(name);
        const description: Record<string, unknown> = {
          content: wireSchema(name, release).description as SchemaDescription,
        };
        if (found.parent) description.parent = found.parent;
        if (found.singletonId) description.singletonId = found.singletonId;
        if (found.meanings) {
          const meanings: Record<string, string> = {};
          for (const field of fieldNames(name, release)) {
            const meaning = found.meanings[field];
            if (meaning !== undefined) meanings[field] = meaning;
          }
          description.meanings = meanings;
        }
        kinds[name] = description;
      }
      return { release, kinds, features: contract.features(release) };
    },
  };
  return contract;
}

export type ContentFor<D extends ContractDefinition, K extends keyof D["kinds"]> = ContentOf<
  D["kinds"][K]
>;

export type { Infer };
