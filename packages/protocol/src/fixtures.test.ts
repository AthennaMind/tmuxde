import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClientMessage } from "./client-messages";
import { ServerMessage } from "./server-messages";

// Shared wire fixtures. The Go server tests read the same files.
// Each file holds a JSON array of samples for one message type.
// File name is the type with ":" replaced by ".".
// invalid/<side>/ holds samples both sides must reject. Each entry is
// { field, message }: message breaks exactly the field named by field.
const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));
const invalidDir = path.join(fixturesDir, "invalid");

const fixtureFileName = (type: string) => `${type.replaceAll(":", ".")}.json`;

// Union members come from the schemas, never from a hand written list.
const clientTypes = ClientMessage.options.map(
  (option) => option.shape.type.value,
);
const serverTypes = ServerMessage.options.map(
  (option) => option.shape.type.value,
);

// Top level keys of every union member, in union order.
const clientKeys = ClientMessage.options.map((option) =>
  Object.keys(option.shape).sort(),
);
const serverKeys = ServerMessage.options.map((option) =>
  Object.keys(option.shape).sort(),
);

const sides = [
  {
    side: "client",
    schema: ClientMessage,
    types: clientTypes,
    keys: clientKeys,
  },
  {
    side: "server",
    schema: ServerMessage,
    types: serverTypes,
    keys: serverKeys,
  },
] as const;

const readFixtureNames = (dir: string) => fs.readdirSync(dir).sort();

const readSamples = (dir: string, name: string): unknown[] => {
  const raw = fs.readFileSync(path.join(dir, name), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${dir}/${name} is not a JSON array`);
  }
  return parsed;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Zod path as the Go server writes it: panes[0].dimensions.cols.
const formatPath = (issuePath: (string | number)[]) =>
  issuePath
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`,
    )
    .join("");

describe.each(sides)("$side fixtures", ({ side, schema, types, keys }) => {
  const sideDir = path.join(fixturesDir, side);
  const names = readFixtureNames(sideDir);
  const typeByFileName = new Map(
    types.map((type) => [fixtureFileName(type), type]),
  );
  const keysByType = new Map<string, string[] | undefined>(
    types.map((type, index) => [type, keys[index]]),
  );

  it("derives a non empty union from the schema", () => {
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types).size).toBe(types.length);
  });

  it("has a fixture for every union type", () => {
    const missing = types.filter(
      (type) => !names.includes(fixtureFileName(type)),
    );
    expect(missing).toEqual([]);
  });

  it("has no fixture without a union type", () => {
    const orphans = names.filter((name) => !typeByFileName.has(name));
    expect(orphans).toEqual([]);
  });

  it.each(names)("%s parses with matching type", (name) => {
    const samples = readSamples(sideDir, name);
    expect(samples.length, `${side}/${name} is empty`).toBeGreaterThan(0);
    const expectedType = typeByFileName.get(name);
    expect(expectedType, `${side}/${name} maps to no union type`).toBeDefined();

    samples.forEach((sample, index) => {
      const result = schema.safeParse(sample);
      const label = `${side}/${name}[${index}]`;
      expect(
        result.success,
        result.success
          ? label
          : `${label}: ${JSON.stringify(result.error.issues)}`,
      ).toBe(true);
      if (result.success) {
        expect(result.data.type, label).toBe(expectedType);
        // Zod strips unknown keys, at every depth. A key it drops is a key
        // the schema does not have.
        expect(result.data, `${label} has keys the schema strips`).toEqual(
          sample,
        );
      }
    });

    // Sample 0 sets every top level key. A new Zod field then fails here
    // until the fixture and the Go struct both have it.
    const first = samples[0];
    expect(isRecord(first), `${side}/${name}[0] is not an object`).toBe(true);
    expect(
      Object.keys(first as object).sort(),
      `${side}/${name}[0] must set every schema key`,
    ).toEqual(keysByType.get(expectedType ?? ""));
  });
});

describe.each(sides)("$side invalid fixtures", ({ side, schema, types }) => {
  const sideDir = path.join(invalidDir, side);
  const names = readFixtureNames(sideDir);
  const typeByFileName = new Map(
    types.map((type) => [fixtureFileName(type), type]),
  );

  it("has files", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it("names only union types", () => {
    const orphans = names.filter((name) => !typeByFileName.has(name));
    expect(orphans).toEqual([]);
  });

  it.each(names)("%s is rejected for the named field", (name) => {
    const entries = readSamples(sideDir, name);
    expect(entries.length, `invalid/${side}/${name} is empty`).toBeGreaterThan(
      0,
    );
    const expectedType = typeByFileName.get(name);

    entries.forEach((entry, index) => {
      const label = `invalid/${side}/${name}[${index}]`;
      if (!isRecord(entry) || typeof entry.field !== "string") {
        throw new Error(`${label} must be { field, message }`);
      }
      expect(Object.keys(entry).sort(), label).toEqual(["field", "message"]);
      const { field, message } = entry;
      expect(isRecord(message) && message.type, label).toBe(expectedType);

      const result = schema.safeParse(message);
      expect(result.success, `${label} parses`).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((issue) =>
          formatPath(issue.path),
        );
        expect(paths, `${label} fails on other fields`).toContain(field);
      }
    });
  });
});
