/**
 * A small schema language for the sync contract. Each schema validates values at runtime, gives a
 * TypeScript type through `Infer`, and describes itself as canonical JSON. The description is what
 * gets frozen for a protocol release, so it must stay stable: never change how an existing schema
 * kind describes itself.
 */

export type SchemaDescription =
  | { type: "string"; minLength: number; maxLength: number; pattern?: string; format?: string }
  | { type: "number"; integer: boolean; minimum: number; maximum: number }
  | { type: "boolean" }
  | { type: "literal"; value: string | number | boolean }
  | { type: "enum"; values: readonly (string | number)[] }
  | { type: "nullable"; of: SchemaDescription }
  | { type: "array"; of: SchemaDescription; maxItems: number }
  | {
      type: "object";
      properties: Record<string, SchemaDescription>;
      required: readonly string[];
      /** Any object is accepted; its content is validated separately (record content). */
      open?: true;
    }
  | { type: "union"; discriminator: string; variants: readonly SchemaDescription[] };

export interface Issue {
  path: string;
  message: string;
}

export interface Schema<T> {
  /** Phantom field carrying the TypeScript type; never set at runtime. */
  readonly _type?: T;
  readonly description: SchemaDescription;
  check(value: unknown, path: string, issues: Issue[]): void;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Exactly three fraction digits, so each instant has one spelling and equal values compare equal
// as text.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A real calendar instant: Date would roll 2026-02-30 over to March, so compare it back. */
export function isUtcDateTime(value: string): boolean {
  if (!ISO_DATE_TIME.test(value)) return false;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  return new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}
const ID = /^[A-Za-z0-9._:-]+$/;

export interface StringOptions {
  minLength?: number;
  maxLength: number;
}

export function string(options: StringOptions): Schema<string> {
  const minLength = options.minLength ?? 0;
  const { maxLength } = options;
  return {
    description: { type: "string", minLength, maxLength },
    check(value, path, issues) {
      if (typeof value !== "string") {
        issues.push({ path, message: "expected a string" });
      } else if (value.length < minLength || value.length > maxLength) {
        issues.push({ path, message: `length must be ${minLength}..${maxLength}` });
      }
    },
  };
}

/** Record and item ids: random UUIDs or ids derived from an import. */
export function id(): Schema<string> {
  return {
    description: { type: "string", minLength: 1, maxLength: 64, pattern: ID.source },
    check(value, path, issues) {
      if (typeof value !== "string" || value.length > 64 || !ID.test(value)) {
        issues.push({ path, message: "expected an id" });
      }
    },
  };
}

/** A UTC timestamp such as 2026-11-10T19:57:06.000Z. */
export function dateTime(): Schema<string> {
  return {
    description: {
      type: "string",
      minLength: 24,
      maxLength: 24,
      pattern: ISO_DATE_TIME.source,
      format: "utc-date-time",
    },
    check(value, path, issues) {
      if (typeof value !== "string" || !isUtcDateTime(value)) {
        issues.push({ path, message: "expected a UTC date-time" });
      }
    },
  };
}

export interface NumberOptions {
  integer?: boolean;
  minimum: number;
  maximum: number;
}

export function number(options: NumberOptions): Schema<number> {
  const integer = options.integer ?? false;
  const { minimum, maximum } = options;
  return {
    description: { type: "number", integer, minimum, maximum },
    check(value, path, issues) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push({ path, message: "expected a finite number" });
      } else if (integer && !Number.isInteger(value)) {
        issues.push({ path, message: "expected an integer" });
      } else if (value < minimum || value > maximum) {
        issues.push({ path, message: `must be ${minimum}..${maximum}` });
      }
    },
  };
}

export function integer(minimum: number, maximum: number): Schema<number> {
  return number({ integer: true, minimum, maximum });
}

export function boolean(): Schema<boolean> {
  return {
    description: { type: "boolean" },
    check(value, path, issues) {
      if (typeof value !== "boolean") issues.push({ path, message: "expected a boolean" });
    },
  };
}

export function literal<const T extends string | number | boolean>(value: T): Schema<T> {
  return {
    description: { type: "literal", value },
    check(actual, path, issues) {
      if (actual !== value) issues.push({ path, message: `expected ${JSON.stringify(value)}` });
    },
  };
}

export function enumOf<const T extends readonly (string | number)[]>(values: T): Schema<T[number]> {
  return {
    description: { type: "enum", values: [...values] },
    check(value, path, issues) {
      if (!(values as readonly unknown[]).includes(value)) {
        issues.push({ path, message: `expected one of ${values.join(", ")}` });
      }
    },
  };
}

export function nullable<T>(of: Schema<T>): Schema<T | null> {
  return {
    description: { type: "nullable", of: of.description },
    check(value, path, issues) {
      if (value !== null) of.check(value, path, issues);
    },
  };
}

export function array<T>(of: Schema<T>, maxItems: number): Schema<T[]> {
  return {
    description: { type: "array", of: of.description, maxItems },
    check(value, path, issues) {
      if (!Array.isArray(value)) {
        issues.push({ path, message: "expected an array" });
        return;
      }
      if (value.length > maxItems) issues.push({ path, message: `at most ${maxItems} items` });
      value.forEach((item, index) => {
        of.check(item, `${path}[${index}]`, issues);
      });
    },
  };
}

export type Shape = Record<string, Schema<unknown>>;

type RequiredKeys<S extends Shape, O extends keyof S> = Exclude<keyof S, O>;
export type ObjectType<S extends Shape, O extends keyof S = never> = {
  -readonly [K in RequiredKeys<S, O>]: Infer<S[K]>;
} & { -readonly [K in O]?: Infer<S[K]> };

/**
 * A strict object: every key not listed is an error. `optional` keys may be absent; present
 * optional keys must still match their schema.
 */
export function object<S extends Shape, const O extends keyof S & string = never>(
  shape: S,
  optional: readonly O[] = [],
): Schema<ObjectType<S, O>> {
  const keys = Object.keys(shape).sort();
  const required = keys.filter((key) => !(optional as readonly string[]).includes(key));
  const properties: Record<string, SchemaDescription> = {};
  for (const key of keys) properties[key] = (shape[key] as Schema<unknown>).description;
  return {
    description: { type: "object", properties, required },
    check(value, path, issues) {
      if (!isPlainObject(value)) {
        issues.push({ path, message: "expected an object" });
        return;
      }
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key)) {
          issues.push({ path: `${path}.${key}`, message: "unknown field" });
        }
      }
      for (const key of keys) {
        if (!Object.hasOwn(value, key)) {
          if (required.includes(key)) issues.push({ path: `${path}.${key}`, message: "missing" });
          continue;
        }
        (shape[key] as Schema<unknown>).check(value[key], `${path}.${key}`, issues);
      }
    },
  };
}

/** Variants are objects told apart by a literal `discriminator` field. */
export function union<const V extends readonly Schema<Record<string, unknown>>[]>(
  discriminator: string,
  variants: V,
): Schema<Infer<V[number]>> {
  const tags = variants.map((variant) => {
    const description = variant.description;
    const tag = description.type === "object" ? description.properties[discriminator] : undefined;
    if (tag?.type !== "literal") throw new Error(`union variant lacks literal ${discriminator}`);
    return tag.value;
  });
  return {
    description: {
      type: "union",
      discriminator,
      variants: variants.map((variant) => variant.description),
    },
    check(value, path, issues) {
      if (!isPlainObject(value)) {
        issues.push({ path, message: "expected an object" });
        return;
      }
      const index = tags.indexOf(value[discriminator] as string);
      const variant = variants[index];
      if (!variant) {
        issues.push({ path: `${path}.${discriminator}`, message: `expected one of ${tags}` });
        return;
      }
      variant.check(value, path, issues);
    },
  };
}

export function validate<T>(schema: Schema<T>, value: unknown): Issue[] {
  const issues: Issue[] = [];
  schema.check(value, "$", issues);
  return issues;
}

export function is<T>(schema: Schema<T>, value: unknown): value is T {
  return validate(schema, value).length === 0;
}

export class ValidationError extends Error {
  override name = "ValidationError";
  readonly issues: readonly Issue[];
  constructor(what: string, issues: readonly Issue[]) {
    super(
      `${what}: ${issues
        .slice(0, 5)
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
    this.issues = issues;
  }
}

export function parse<T>(schema: Schema<T>, value: unknown, what = "value"): T {
  const issues = validate(schema, value);
  if (issues.length > 0) throw new ValidationError(what, issues);
  return value as T;
}
