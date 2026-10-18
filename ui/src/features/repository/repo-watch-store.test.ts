import { beforeEach, describe, expect, it } from "vitest";
import {
  holdWatch,
  releaseWatch,
  startRepoWatch,
  useRepoWatchStore,
  watchHealthy,
} from "./repo-watch-store";

beforeEach(() => {
  useRepoWatchStore.getState().reset();
});

describe("repo watch store", () => {
  it("remembers each answer by root", () => {
    const store = useRepoWatchStore.getState();
    store.applyResult({ type: "repo:watch:result", root: "/w/a/", ok: true, partial: false });
    store.applyResult({ type: "repo:watch:result", root: "/w/b", ok: true, partial: true });
    expect(useRepoWatchStore.getState().roots).toEqual({
      "/w/a": { ok: true, partial: false },
      "/w/b": { ok: true, partial: true },
    });
  });

  it("takes a later partial answer for a watched root", () => {
    const store = useRepoWatchStore.getState();
    store.applyResult({ type: "repo:watch:result", root: "/w/a", ok: true, partial: false });
    expect(watchHealthy(useRepoWatchStore.getState().roots["/w/a"])).toBe(true);
    // The server sends this when a walk after the start hits a cap.
    store.applyResult({ type: "repo:watch:result", root: "/w/a", ok: true, partial: true });
    expect(watchHealthy(useRepoWatchStore.getState().roots["/w/a"])).toBe(false);
  });

  it("ignores a refusal without a root", () => {
    useRepoWatchStore.getState().applyResult({
      type: "repo:watch:result",
      root: null,
      ok: false,
      partial: false,
      message: "Current pane directory is not a Git repository",
    });
    expect(useRepoWatchStore.getState().roots).toEqual({});
  });

  it("numbers every change, also two equal ones", () => {
    const store = useRepoWatchStore.getState();
    const msg = {
      type: "repo:changed" as const,
      root: "/w/a",
      git: false,
      refs: false,
      paths: ["x"],
      truncated: false,
    };
    store.applyChange(msg);
    const first = useRepoWatchStore.getState().lastChange;
    store.applyChange(msg);
    const second = useRepoWatchStore.getState().lastChange;
    expect(first?.paths).toEqual(["x"]);
    expect(second).not.toBe(first);
    expect(second!.seq).toBeGreaterThan(first!.seq);
  });

  it("forgets one root and resets all", () => {
    const store = useRepoWatchStore.getState();
    store.applyResult({ type: "repo:watch:result", root: "/w/a", ok: true, partial: false });
    store.applyResult({ type: "repo:watch:result", root: "/w/b", ok: false, partial: false });
    store.forget("/w/a/");
    expect(Object.keys(useRepoWatchStore.getState().roots)).toEqual(["/w/b"]);
    store.applyChange({
      type: "repo:changed",
      root: "/w/b",
      git: true,
      refs: true,
      paths: [],
      truncated: false,
    });
    expect(useRepoWatchStore.getState().lastChange).toMatchObject({ git: true, refs: true });
    store.reset();
    expect(useRepoWatchStore.getState()).toMatchObject({ roots: {}, lastChange: null });
  });
});

describe("watchHealthy", () => {
  it("needs a full, live watch", () => {
    expect(watchHealthy(undefined)).toBe(false);
    expect(watchHealthy({ ok: false, partial: false })).toBe(false);
    expect(watchHealthy({ ok: true, partial: true })).toBe(false);
    expect(watchHealthy({ ok: true, partial: false })).toBe(true);
  });
});

describe("watch holders", () => {
  it("lets only the last holder unwatch", () => {
    holdWatch("/w/a");
    holdWatch("/w/a/");
    expect(releaseWatch("/w/a")).toBe(false);
    expect(releaseWatch("/w/a")).toBe(true);
    // A stray release does not go negative.
    expect(releaseWatch("/w/a")).toBe(true);
    holdWatch("/w/a");
    expect(releaseWatch("/w/a")).toBe(true);
  });
});

describe("startRepoWatch", () => {
  type Client = Parameters<typeof startRepoWatch>[0];
  /** A connected client that logs what it sends, in order. */
  function fakeClient() {
    const sent: string[] = [];
    const client: { -readonly [K in keyof Client]: Client[K] } = {
      status: "connected",
      send: (msg) => {
        sent.push(msg.type === "repo:unwatch" ? `unwatch ${msg.root}` : msg.type);
      },
    };
    return { client, sent };
  }
  const answer = (root: string, ok: boolean) =>
    useRepoWatchStore.getState().applyResult({
      type: "repo:watch:result",
      root,
      ok,
      partial: false,
      ...(ok ? {} : { message: "Too many repository watchers" }),
    });
  /** Starts a watch whose sends log `watch <name>`. */
  function start(client: ReturnType<typeof fakeClient>, root: string) {
    return startRepoWatch(client.client, root, () => {
      client.sent.push(`watch ${root}`);
      return true;
    });
  }

  it("sends a refused watch again once another root frees a slot", () => {
    const c = fakeClient();
    const stopA = start(c, "/w/a");
    const stopB = start(c, "/w/b");
    answer("/w/a", true);
    answer("/w/b", false);
    stopA();
    expect(c.sent).toEqual(["watch /w/a", "watch /w/b", "unwatch /w/a", "watch /w/b"]);
    // A second refusal waits for the next freed slot, it does not loop.
    answer("/w/b", false);
    expect(c.sent).toHaveLength(4);
    answer("/w/b", true);
    stopB();
    expect(c.sent.at(-1)).toBe("unwatch /w/b");
  });

  it("retries once for all holders of a root", () => {
    const c = fakeClient();
    const stopA = start(c, "/w/a");
    const stopB1 = start(c, "/w/b");
    const stopB2 = start(c, "/w/b/");
    answer("/w/a", true);
    answer("/w/b", false);
    c.sent.length = 0;
    stopA();
    expect(c.sent).toEqual(["unwatch /w/a", "watch /w/b"]);
    stopB1();
    stopB2();
  });

  it("leaves watches the server took alone", () => {
    const c = fakeClient();
    const stopA = start(c, "/w/a");
    const stopB = start(c, "/w/b");
    answer("/w/a", true);
    answer("/w/b", true);
    c.sent.length = 0;
    stopA();
    expect(c.sent).toEqual(["unwatch /w/a"]);
    stopB();
  });

  it("frees no slot with the unwatch of a refused root", () => {
    const c = fakeClient();
    const stopA = start(c, "/w/a");
    const stopB = start(c, "/w/b");
    answer("/w/a", false);
    answer("/w/b", false);
    const released = useRepoWatchStore.getState().released;
    c.sent.length = 0;
    stopA();
    expect(c.sent).toEqual(["unwatch /w/a"]);
    expect(useRepoWatchStore.getState().released).toBe(released);
    stopB();
  });

  it("sends nothing on a closed socket", () => {
    const c = fakeClient();
    const stopA = start(c, "/w/a");
    const stopB = start(c, "/w/b");
    answer("/w/a", true);
    answer("/w/b", false);
    c.client.status = "disconnected";
    c.sent.length = 0;
    stopA();
    expect(c.sent).toEqual([]);
    stopB();
  });

  it("holds nothing when the watch had no pane to go through", () => {
    const c = fakeClient();
    const stop = startRepoWatch(c.client, "/w/a", () => false);
    stop();
    expect(c.sent).toEqual([]);
    // The holder count was never raised, so one hold is the last one.
    holdWatch("/w/a");
    expect(releaseWatch("/w/a")).toBe(true);
  });
});
