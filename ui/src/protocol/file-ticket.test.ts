import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { FileTicketSchema } from "./file-ticket";

const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/http/file-ticket.json", import.meta.url), "utf8"),
);

describe("file ticket", () => {
  it("matches the hub answer without dropping fields", () => {
    expect(FileTicketSchema.parse(fixture)).toEqual(fixture);
  });

  it("rejects a ticket that is not url safe and a lifetime that is not a count", () => {
    expect(FileTicketSchema.safeParse({ ...fixture, ticket: "a+b/c=" }).success).toBe(false);
    expect(FileTicketSchema.safeParse({ ...fixture, ticket: "" }).success).toBe(false);
    expect(FileTicketSchema.safeParse({ ...fixture, expiresIn: 0 }).success).toBe(false);
    expect(FileTicketSchema.safeParse({ ...fixture, expiresIn: "900" }).success).toBe(false);
  });
});
