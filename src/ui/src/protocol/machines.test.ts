import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MachineListSchema } from "./machines";

const fixture = JSON.parse(fs.readFileSync(
  new URL("./fixtures/http/machines.json", import.meta.url), "utf8",
));

describe("machine inventory", () => {
  it("matches shared Go fixture without dropping fields", () => {
    expect(MachineListSchema.parse(fixture)).toEqual(fixture);
  });

  it("rejects malformed machine identity and status", () => {
    expect(MachineListSchema.safeParse([{ ...fixture[0], id: "../local" }]).success).toBe(false);
    expect(MachineListSchema.safeParse([{ ...fixture[0], online: "yes" }]).success).toBe(false);
    expect(MachineListSchema.safeParse([{ ...fixture[0], features: null }]).success).toBe(false);
  });
});
