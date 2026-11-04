import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdates, getUpdateStatus, startUpdate } from "./updates-api";

const token = vi.hoisted(() => ({ value: "test-token" as string | null }));
vi.mock("./relay-url", () => ({ resolveRelayHttpBase: () => "https://hub.test" }));
vi.mock("./storage-keys", () => ({ readSelfHostedToken: () => token.value }));

const status = { components: [], snapshot: null, job: null };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  token.value = "test-token";
  fetchMock = vi.fn().mockImplementation(async () => Response.json(status));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("manual update requests", () => {
  it("reads local status without release check or install", async () => {
    await getUpdateStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.test/updates",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
  });

  it("checks only through explicit check call", async () => {
    expect(fetchMock).not.toHaveBeenCalled();
    await checkForUpdates();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.test/updates/check",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("never retries an install after a lost response", async () => {
    fetchMock.mockRejectedValue(new TypeError("connection lost"));
    await expect(startUpdate("request", "snapshot", ["server"])).rejects.toThrow("connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send requests while locked", async () => {
    token.value = null;
    await expect(checkForUpdates()).rejects.toThrow("Sign in");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate targets before sending", async () => {
    await expect(startUpdate("request", "snapshot", ["speech", "speech"])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
