import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserDocument, putUserDocument } from "./user-documents-api";

const token = vi.hoisted(() => ({ value: "test-token" as string | null }));

vi.mock("./relay-url", () => ({ resolveRelayHttpBase: () => "https://hub.test" }));
vi.mock("./storage-keys", () => ({ readSelfHostedToken: () => token.value }));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  token.value = "test-token";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getUserDocument", () => {
  it("reads text and etag with the bearer token and no cache", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"files.wrapLines": true}', { headers: { ETag: '"abc"' } }),
    );
    expect(await getUserDocument("settings")).toEqual({
      kind: "ok",
      text: '{"files.wrapLines": true}',
      etag: '"abc"',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://hub.test/user/settings");
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(url).not.toContain("token");
  });

  it.each([
    [401, { kind: "unauthorized" }],
    [404, { kind: "notFound" }],
    [500, { kind: "network", message: "Request failed (500)", status: 500 }],
  ])("maps HTTP %s", async (status, expected) => {
    fetchMock.mockResolvedValue(new Response("nope", { status }));
    expect(await getUserDocument("keybindings")).toEqual(expected);
  });

  it("maps a failed request to network without throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await getUserDocument("settings")).toEqual({
      kind: "network",
      message: "Failed to fetch",
    });
  });

  it("treats a reply without an etag as unusable", async () => {
    fetchMock.mockResolvedValue(new Response("{}"));
    expect(await getUserDocument("settings")).toMatchObject({ kind: "network" });
  });

  it("does not call the hub without a token", async () => {
    token.value = null;
    expect(await getUserDocument("settings")).toEqual({ kind: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("putUserDocument", () => {
  it("sends the text with If-Match and returns the new etag", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204, headers: { ETag: '"new"' } }));
    expect(await putUserDocument("keybindings", "[]", '"old"')).toEqual({
      kind: "ok",
      text: "[]",
      etag: '"new"',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://hub.test/user/keybindings");
    expect(init).toMatchObject({
      method: "PUT",
      body: "[]",
      cache: "no-store",
      headers: {
        Authorization: "Bearer test-token",
        "If-Match": '"old"',
        "Content-Type": "application/json",
      },
    });
  });

  it("sends before it returns, so a lock right after cannot take the token", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204, headers: { ETag: '"new"' } }));
    const pending = putUserDocument("settings", "{}", '"old"');
    token.value = null;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: "Bearer test-token" },
    });
    expect(await pending).toMatchObject({ kind: "ok" });
  });

  it("asks for keepalive only on request and within the browser's limit", async () => {
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 204, headers: { ETag: '"new"' } }),
    );
    await putUserDocument("settings", "{}", '"old"', { keepalive: true });
    await putUserDocument("settings", `{"a.b": "${"x".repeat(70 * 1024)}"}`, '"old"', {
      keepalive: true,
    });
    await putUserDocument("settings", "{}", '"old"');
    const keepalive = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).keepalive);
    expect(keepalive).toEqual([true, undefined, undefined]);
  });

  it.each([
    [412, "", { kind: "conflict" }],
    [413, "", { kind: "tooLarge" }],
    [
      400,
      "settings: key 0 is not dotted\n",
      { kind: "invalid", message: "settings: key 0 is not dotted" },
    ],
    [400, "", { kind: "invalid", message: "Invalid document" }],
    [428, "", { kind: "invalid", message: "If-Match header required" }],
    [401, "", { kind: "unauthorized" }],
    [405, "", { kind: "network", message: "Request failed (405)", status: 405 }],
  ])("maps HTTP %s", async (status, body, expected) => {
    fetchMock.mockResolvedValue(new Response(body || null, { status }));
    expect(await putUserDocument("settings", "{}", "*")).toEqual(expected);
  });
});
