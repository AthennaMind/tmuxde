import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { StartUpdateSchema, UpdateStatusSchema } from "./updates";

const status = JSON.parse(
  fs.readFileSync(new URL("./fixtures/http/updates.json", import.meta.url), "utf8"),
);
const requests = JSON.parse(
  fs.readFileSync(new URL("./fixtures/http/update-requests.json", import.meta.url), "utf8"),
);

describe("manual update contract", () => {
  it("keeps every inventory field from shared Go fixture", () => {
    expect(UpdateStatusSchema.parse(status)).toEqual(status);
  });

  it("accepts valid selections", () => {
    for (const request of requests.valid) {
      expect(StartUpdateSchema.parse(request)).toEqual(request);
    }
  });

  it("rejects invalid selections and custom download URLs", () => {
    for (const request of requests.invalid) {
      expect(StartUpdateSchema.safeParse(request).success).toBe(false);
    }
  });
});
