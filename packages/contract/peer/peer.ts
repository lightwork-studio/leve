/*
 * A minimal sync client for one protocol release, used as a historical peer in compatibility tests.
 * `pnpm contract:freeze <release>` copies this file and the release's frozen contract into
 * `history/<release>/`, where it never changes again. It must stay self-contained: it may import
 * only node built-ins and files next to it, never current Leve code.
 *
 * Everything it sends and receives is checked against the frozen contract description, not against
 * today's schemas, so a server answering in a changed format fails here.
 */
import { readFileSync } from "node:fs";

// biome-ignore lint/suspicious/noExplicitAny: interprets JSON schema descriptions
type Description = any;
type Json = Record<string, unknown>;

export interface FrozenContract {
  release: string;
  kinds: Record<string, { content: Description; parent?: { kind: string; field: string } }>;
  messages: Record<string, Description>;
  negotiation: {
    helloRequest: Description;
    helloResponse: Description;
    errorResponse: Description;
  };
}

export function loadContract(directory: URL): FrozenContract {
  return JSON.parse(readFileSync(new URL("contract.json", directory), "utf8")) as FrozenContract;
}

/** Validates a value against a frozen description; returns problems as text. */
export function check(description: Description, value: unknown, path = "$"): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(`${path} ${message}`);
  switch (description.type) {
    case "string":
      if (typeof value !== "string") fail("not a string");
      else if (value.length < description.minLength || value.length > description.maxLength)
        fail("bad length");
      else if (description.pattern && !new RegExp(description.pattern).test(value))
        fail("bad pattern");
      else if (
        description.format === "utc-date-time" &&
        (Number.isNaN(Date.parse(value)) ||
          new Date(Date.parse(value)).toISOString().slice(0, 19) !== value.slice(0, 19))
      )
        fail("bad date-time");
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("not a number");
      else if (description.integer && !Number.isInteger(value)) fail("not an integer");
      else if (value < description.minimum || value > description.maximum) fail("out of range");
      break;
    case "boolean":
      if (typeof value !== "boolean") fail("not a boolean");
      break;
    case "literal":
      if (value !== description.value) fail(`not ${JSON.stringify(description.value)}`);
      break;
    case "enum":
      if (!description.values.includes(value)) fail("not an allowed value");
      break;
    case "nullable":
      if (value !== null) problems.push(...check(description.of, value, path));
      break;
    case "array":
      if (!Array.isArray(value)) fail("not an array");
      else {
        if (value.length > description.maxItems) fail("too many items");
        value.forEach((item, index) => {
          problems.push(...check(description.of, item, `${path}[${index}]`));
        });
      }
      break;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("not an object");
        break;
      }
      const properties = description.properties as Record<string, Description>;
      // Record content inside an envelope; checked separately against the kind's description.
      if (description.open === true) break;
      const object = value as Json;
      for (const key of Object.keys(object)) {
        if (!Object.hasOwn(properties, key)) fail(`unknown ${key}`);
      }
      for (const [key, property] of Object.entries(properties)) {
        if (!Object.hasOwn(object, key)) {
          if (description.required.includes(key)) fail(`missing ${key}`);
        } else problems.push(...check(property, object[key], `${path}.${key}`));
      }
      break;
    }
    case "union": {
      const object = value as Json;
      const variant = (description.variants as Description[]).find(
        (candidate) =>
          candidate.properties[description.discriminator]?.value ===
          object?.[description.discriminator],
      );
      if (!variant) fail("no matching variant");
      else problems.push(...check(variant, value, path));
      break;
    }
    default:
      fail(`unknown description type ${description.type}`);
  }
  return problems;
}

export class PeerProtocolError extends Error {
  override name = "PeerProtocolError";
}

function expectValid(description: Description, value: unknown, what: string): void {
  const problems = check(description, value);
  if (problems.length > 0) throw new PeerProtocolError(`${what}: ${problems.join("; ")}`);
}

export type Transport = (path: string, body: Json) => Promise<{ status: number; body: unknown }>;

export interface PeerRecord {
  kind: string;
  id: string;
  revision: number;
  state: "live" | "deleted" | "unavailable";
  content?: Json;
}

let counter = 0;

/** A client that speaks exactly one frozen release and keeps its state in memory. */
export class HistoricalPeer {
  readonly contract: FrozenContract;
  readonly transport: Transport;
  readonly records = new Map<string, PeerRecord>();
  cursor = 0;
  lineage = "";

  constructor(contract: FrozenContract, transport: Transport) {
    this.contract = contract;
    this.transport = transport;
  }

  get release(): string {
    return this.contract.release;
  }

  newSubmissionId(): string {
    counter += 1;
    return `peer-${this.release}-${counter}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async call(path: string, body: Json): Promise<{ status: number; body: Json }> {
    const response = await this.transport(path, body);
    const payload = response.body as Json;
    if (response.status !== 200) {
      expectValid(this.contract.negotiation.errorResponse, payload, `${path} error`);
    }
    return { status: response.status, body: payload };
  }

  async hello(): Promise<Json> {
    const request = { releases: [this.release], app: `peer-${this.release}` };
    expectValid(this.contract.negotiation.helloRequest, request, "hello request");
    const response = await this.call("/sync/hello", request);
    if (response.status === 200) {
      expectValid(this.contract.negotiation.helloResponse, response.body, "hello response");
      this.lineage = String(response.body.lineage);
    }
    return response.body;
  }

  /** Builds a put of `content` and checks it against this release's record description. */
  put(kind: string, id: string, content: Json, submissionId = this.newSubmissionId()): Json {
    const definition = this.contract.kinds[kind];
    if (!definition) throw new PeerProtocolError(`${kind} is not in release ${this.release}`);
    expectValid(definition.content, content, `${kind} content`);
    const known = this.records.get(`${kind}/${id}`);
    return {
      op: "put",
      submissionId,
      kind,
      id,
      baseRevision: known && known.state === "live" ? known.revision : null,
      content,
    };
  }

  delete(kind: string, id: string, submissionId = this.newSubmissionId()): Json {
    const known = this.records.get(`${kind}/${id}`);
    if (!known) throw new PeerProtocolError(`${kind}/${id} is unknown`);
    const descendants = this.descendants(kind, id).map((record) => ({
      kind: record.kind,
      id: record.id,
      revision: record.revision,
    }));
    return { op: "delete", submissionId, kind, id, baseRevision: known.revision, descendants };
  }

  /** Live records below `kind/id` as this peer knows them. */
  descendants(kind: string, id: string): PeerRecord[] {
    const children = [...this.records.values()].filter((record) => {
      const parent = this.contract.kinds[record.kind]?.parent;
      return (
        record.state === "live" && parent?.kind === kind && record.content?.[parent.field] === id
      );
    });
    return children.flatMap((child) => [child, ...this.descendants(child.kind, child.id)]);
  }

  /** Sends submissions, checks the reply against the frozen release, applies accepted ones. */
  async push(submissions: Json[]): Promise<Json> {
    const request = { release: this.release, lineage: this.lineage, submissions };
    expectValid(this.contract.messages.pushRequest, request, "push request");
    const response = await this.call("/sync/push", request);
    if (response.status !== 200) return response.body;
    expectValid(this.contract.messages.pushResponse, response.body, "push response");
    const results = response.body.results as Json[];
    if (results.length !== submissions.length) throw new PeerProtocolError("result count");
    results.forEach((result, index) => {
      const submission = submissions[index] as Json;
      if (result.submissionId !== submission.submissionId) {
        throw new PeerProtocolError("results out of order");
      }
      const key = `${submission.kind}/${submission.id}`;
      if (result.status === "accepted") {
        this.records.set(key, {
          kind: String(submission.kind),
          id: String(submission.id),
          revision: Number(result.revision),
          state: submission.op === "put" ? "live" : "deleted",
          ...(submission.op === "put" ? { content: submission.content as Json } : {}),
        });
      } else if (result.status === "conflict" && result.current) {
        this.apply(result.current as Json);
      }
    });
    return response.body;
  }

  apply(change: Json): void {
    const kind = this.contract.kinds[String(change.kind)];
    if (change.state === "live") {
      if (!kind) throw new PeerProtocolError(`unknown kind ${change.kind}`);
      expectValid(kind.content, change.content, `${change.kind} content`);
    }
    const key = `${change.kind}/${change.id}`;
    const known = this.records.get(key);
    if (known && known.revision >= Number(change.revision)) return;
    this.records.set(key, {
      kind: String(change.kind),
      id: String(change.id),
      revision: Number(change.revision),
      state: change.state as PeerRecord["state"],
      ...(change.state === "live" ? { content: change.content as Json } : {}),
    });
  }

  /** Downloads every page after the cursor. */
  async pull(limit = 100): Promise<Json[]> {
    const received: Json[] = [];
    for (;;) {
      const request = { release: this.release, lineage: this.lineage, cursor: this.cursor, limit };
      expectValid(this.contract.messages.pullRequest, request, "pull request");
      const response = await this.call("/sync/pull", request);
      if (response.status !== 200) throw new PeerProtocolError(JSON.stringify(response.body));
      expectValid(this.contract.messages.pullResponse, response.body, "pull response");
      for (const change of response.body.changes as Json[]) {
        this.apply(change);
        received.push(change);
      }
      this.cursor = Number(response.body.cursor);
      if (!response.body.hasMore) return received;
    }
  }
}
