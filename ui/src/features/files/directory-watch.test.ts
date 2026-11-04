import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { holdDirectoryWatch } from "./directory-watch";

function connection() {
  const messages = new Set<(message: ServerMessage) => void>();
  const statuses = new Set<Parameters<RepositoryClient["onStatusChange"]>[0]>();
  let currentStatus: RepositoryClient["status"] = "connected";
  const client: RepositoryClient = {
    get status() {
      return currentStatus;
    },
    send: vi.fn(),
    onMessage: (handler) => {
      messages.add(handler);
      return () => {
        messages.delete(handler);
      };
    },
    onStatusChange: (handler) => {
      statuses.add(handler);
      return () => {
        statuses.delete(handler);
      };
    },
  };
  return {
    client,
    messages,
    statuses,
    change: (path: string, event: "addDir" | "unlinkDir" | "change" = "addDir") => {
      for (const handler of messages) handler({ type: "file:changed", path, event });
    },
    status: (status: RepositoryClient["status"]) => {
      currentStatus = status;
      for (const handler of statuses) handler(status);
    },
  };
}
const held: ReturnType<typeof holdDirectoryWatch>[] = [];
function hold(...args: Parameters<typeof holdDirectoryWatch>) {
  const watch = holdDirectoryWatch(...args);
  held.push(watch);
  return watch;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const watch of held.splice(0)) watch.release();
  vi.useRealTimers();
});

describe("directory watches", () => {
  it("shares ownership and keeps watching after editor or tree releases", async () => {
    const fake = connection();
    const first = vi.fn();
    const second = vi.fn();
    const editor = hold(fake.client, "/work/", first);
    const tree = hold(fake.client, "/work", second);
    expect(fake.client.send).toHaveBeenCalledExactlyOnceWith({ type: "file:watch", path: "/work" });
    await vi.advanceTimersByTimeAsync(75);
    first.mockClear();
    second.mockClear();
    editor.release();
    fake.change("/work/new");
    await vi.advanceTimersByTimeAsync(75);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    tree.release();
    tree.release();
    expect(fake.client.send).toHaveBeenCalledTimes(2);
    expect(fake.client.send).toHaveBeenLastCalledWith({ type: "file:unwatch", path: "/work" });
    expect(fake.messages.size + fake.statuses.size).toBe(0);
  });

  it("matches direct children and filesystem root, coalescing continuous bursts", async () => {
    const fake = connection();
    const changed = vi.fn();
    const root = vi.fn();
    hold(fake.client, "/work", changed);
    hold(fake.client, "/", root);
    await vi.advanceTimersByTimeAsync(75);
    changed.mockClear();
    root.mockClear();
    fake.change("/work-other/new");
    fake.change("/work/nested/new");
    await vi.advanceTimersByTimeAsync(75);
    expect(changed).not.toHaveBeenCalled();
    for (let i = 0; i < 15; i++) {
      fake.change(`/work/file-${i}`);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(75);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(root).not.toHaveBeenCalled();
    fake.change("/top");
    await vi.advanceTimersByTimeAsync(75);
    expect(root).toHaveBeenCalledTimes(1);
  });

  it("isolates identical paths on different machines and restores watches after reconnect", async () => {
    const alpha = connection();
    const beta = connection();
    const a = vi.fn();
    const b = vi.fn();
    const first = hold(alpha.client, "/work", a);
    hold(beta.client, "/work", b);
    await vi.advanceTimersByTimeAsync(75);
    a.mockClear();
    b.mockClear();
    alpha.status("reconnecting");
    beta.change("/work/new");
    await vi.advanceTimersByTimeAsync(75);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    first.renew();
    expect(alpha.client.send).toHaveBeenCalledTimes(1);
    alpha.status("connected");
    await vi.advanceTimersByTimeAsync(75);
    expect(alpha.client.send).toHaveBeenCalledTimes(2);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("caps active watches and promotes waiting folders when slots free", async () => {
    const fake = connection();
    const watches = Array.from({ length: 34 }, (_, index) =>
      hold(fake.client, `/work/${index}`, vi.fn()),
    );
    expect(fake.client.send).toHaveBeenCalledTimes(32);
    watches[32]!.renew();
    expect(fake.client.send).toHaveBeenCalledTimes(32);
    watches[0]!.release();
    expect(fake.client.send).toHaveBeenLastCalledWith({ type: "file:watch", path: "/work/32" });
    fake.status("reconnecting");
    vi.mocked(fake.client.send).mockClear();
    watches[1]!.release();
    expect(fake.client.send).not.toHaveBeenCalled();
    fake.status("connected");
    expect(fake.client.send).toHaveBeenCalledTimes(32);
    expect(fake.client.send).toHaveBeenLastCalledWith({ type: "file:watch", path: "/work/33" });
  });

  it("drops dead watches and renews recreated or refused directories", async () => {
    const fake = connection();
    const changed = vi.fn();
    const watch = hold(fake.client, "/work/folder", changed);
    fake.change("/work/folder", "unlinkDir");
    expect(fake.client.send).toHaveBeenLastCalledWith({
      type: "file:unwatch",
      path: "/work/folder",
    });
    fake.change("/work/folder", "addDir");
    expect(fake.client.send).toHaveBeenLastCalledWith({ type: "file:watch", path: "/work/folder" });
    watch.renew();
    expect(fake.client.send).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(75);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
