import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadFile, getFileUrl } from "./file-url";
import { setMachineId } from "./machine-context";

vi.mock("@/lib/relay-url", () => ({ resolveRelayHttpBase: () => "https://hub.test" }));
vi.mock("./storage-keys", () => ({ readSelfHostedToken: () => "test-token" }));

afterEach(() => {
  setMachineId(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function browser() {
  vi.useFakeTimers();
  const click = vi.fn();
  const anchor = { href: "", download: "", rel: "", click, remove: vi.fn() };
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
  const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { anchor, click, objectUrl };
}

describe("file downloads", () => {
  it("captures explicit machine and authenticates only in headers", async () => {
    const { anchor, objectUrl } = browser();
    setMachineId("beta");
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([0, 255, 3]), { headers: { "Content-Length": "3" } }));
    vi.stubGlobal("fetch", fetch);
    const progress = vi.fn();
    await downloadFile("/same path/你好.bin", "你好.bin", { machineId: "alpha", progress });
    const [url, options] = fetch.mock.calls[0]!;
    expect(new URL(url).searchParams.get("machine")).toBe("alpha");
    expect(new URL(url).searchParams.get("path")).toBe("/same path/你好.bin");
    expect(new URL(url).searchParams.get("download")).toBe("1");
    expect(url).not.toContain("token");
    expect(options.headers.Authorization).toBe("Bearer test-token");
    expect(new Uint8Array(await (objectUrl.mock.calls[0]![0] as Blob).arrayBuffer())).toEqual(new Uint8Array([0, 255, 3]));
    expect(anchor.download).toBe("你好.bin");
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });

  it.each([403, 404, 503])("reports HTTP %s without creating download", async (status) => {
    const { click } = browser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Denied", { status })));
    await expect(downloadFile("/x", "x")).rejects.toThrow(String(status));
    expect(click).not.toHaveBeenCalled();
  });

  it("refuses incomplete bodies and cancelled downloads", async () => {
    const { click } = browser();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x", { headers: { "Content-Length": "10" } })));
    await expect(downloadFile("/x", "x")).rejects.toThrow("interrupted");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x")));
    await expect(downloadFile("/x", "x", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(click).not.toHaveBeenCalled();
  });

  it("keeps explicit local route when active machine is remote", () => {
    setMachineId("beta");
    expect(getFileUrl("/x", true, "local")).toBe("https://hub.test/file?path=%2Fx&download=1");
  });
});
