import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@/protocol";
import { usePaneStore } from "@/stores/pane-store";
import { repositoryRequest, type RepositoryClient } from "./repository-request";

function fakeClient() {
  const messages = new Set<(message: ServerMessage) => void>();
  const statuses = new Set<Parameters<RepositoryClient["onStatusChange"]>[0]>();
  const sent: ClientMessage[] = [];
  const client: RepositoryClient = {
    status: "connected",
    send: (message) => {
      sent.push(message);
    },
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
  return { client, sent, messages, statuses };
}

afterEach(() => {
  vi.useRealTimers();
  usePaneStore.setState({ activePaneId: null });
});

describe("repositoryRequest", () => {
  it("matches concurrent replies by request ID and removes subscriptions", async () => {
    const { client, sent, messages, statuses } = fakeClient();
    const first = repositoryRequest(client, {
      id: "%1",
      action: "list",
      path: "/one",
    });
    const second = repositoryRequest(client, {
      id: "%1",
      action: "list",
      path: "/two",
    });
    const [one, two] = sent;
    if (one?.type !== "repo:request" || two?.type !== "repo:request")
      throw Error("Missing request");
    const reply = (requestId: string, path: string) => {
      for (const handler of messages)
        handler({
          type: "repo:result",
          requestId,
          result: { kind: "list", path, entries: [], truncated: false },
        });
    };
    reply(two.requestId, "/two");
    await expect(second).resolves.toMatchObject({ path: "/two" });
    expect(messages.size).toBe(1);
    reply(one.requestId, "/one");
    await expect(first).resolves.toMatchObject({ path: "/one" });
    expect(messages.size).toBe(0);
    expect(statuses.size).toBe(0);
  });

  it("aborts stale requests and clears listeners", async () => {
    const { client, messages, statuses } = fakeClient();
    const controller = new AbortController();
    const promise = repositoryRequest(
      client,
      { id: "%1", action: "context" },
      controller.signal,
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(messages.size).toBe(0);
    expect(statuses.size).toBe(0);
  });

  it("rejects disconnects and never sends while disconnected", async () => {
    const { client, sent, statuses } = fakeClient();
    const promise = repositoryRequest(client, { id: "%1", action: "context" });
    for (const handler of statuses) handler("reconnecting");
    await expect(promise).rejects.toThrow("Connection lost");
    Object.defineProperty(client, "status", { value: "disconnected" });
    await expect(
      repositoryRequest(client, { id: "%1", action: "context" }),
    ).rejects.toThrow("Connect");
    expect(sent).toHaveLength(1);
  });

  it("times out without retaining handlers", async () => {
    vi.useFakeTimers();
    const { client, messages, statuses } = fakeClient();
    const promise = repositoryRequest(client, { id: "%1", action: "status" });
    const assertion = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(messages.size).toBe(0);
    expect(statuses.size).toBe(0);
  });

  it("surfaces scoped server errors", async () => {
    const { client, sent, messages } = fakeClient();
    const promise = repositoryRequest(client, {
      id: "%1",
      action: "read",
      path: "/restricted",
    });
    const request = sent[0];
    if (request?.type !== "repo:request") throw Error("Missing request");
    for (const handler of messages)
      handler({
        type: "repo:result",
        requestId: request.requestId,
        result: { kind: "error", message: "Permission denied" },
      });
    await expect(promise).rejects.toThrow("Permission denied");
  });

  it("carries absolute paths through the active pane, the rest through their own", () => {
    const { client, sent } = fakeClient();
    usePaneStore.setState({ activePaneId: "%9" });
    const ignore = () => {};
    repositoryRequest(client, { id: "%1", action: "list", path: "/one" }).catch(ignore);
    repositoryRequest(client, { id: "%1", action: "list", path: "rel" }).catch(ignore);
    repositoryRequest(client, { id: "%1", action: "context" }).catch(ignore);
    repositoryRequest(client, {
      id: "%1",
      action: "context",
      path: "/one",
    }).catch(ignore);
    expect(sent.map((m) => (m.type === "repo:request" ? m.id : null))).toEqual([
      "%9",
      "%1",
      "%1",
      "%1",
    ]);
  });

  it("keeps the given pane when none is active", () => {
    const { client, sent } = fakeClient();
    repositoryRequest(client, { id: "%1", action: "list", path: "/one" }).catch(
      () => {},
    );
    expect(sent[0]).toMatchObject({ id: "%1" });
  });
});
