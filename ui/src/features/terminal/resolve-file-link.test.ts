import { beforeEach, describe, expect, it, vi } from "vitest";
import { repositoryRequest, type RepositoryClient } from "@/features/repository/repository-request";
import { resolveFileLink } from "./resolve-file-link";
import type { FileLinkTarget } from "./file-links";

vi.mock("@/features/repository/repository-request", () => ({ repositoryRequest: vi.fn() }));
const request = vi.mocked(repositoryRequest);
const client = {} as RepositoryClient;
const root = "/home/dev/workspace/file-moves-check";
const cwd = `${root}/inbox`;
const target: FileLinkTarget = {
  machineId: "beta",
  sessionName: "dev",
  paneId: "%0",
  path: `${cwd}/file-moves-check/`,
  relativePath: "file-moves-check/",
};
const entry = (path: string, type: "file" | "directory" = "file") => ({
  path,
  name: path.split("/").pop()!,
  type,
  size: 0,
  modified: "",
});

function setup(entries: ReturnType<typeof entry>[]) {
  request.mockImplementation(async (_client, query, signal) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (query.action === "context") return { kind: "context", path: cwd, root, branch: "main" };
    return {
      kind: "list",
      path: query.path!,
      entries: entries.filter(
        (item) => item.path.slice(0, item.path.lastIndexOf("/")) === query.path,
      ),
      truncated: false,
    };
  });
}

beforeEach(() => {
  request.mockReset();
});

describe("resolve terminal file links", () => {
  it("resolves Dev Beta old directory output to repository folder", async () => {
    setup([entry(root, "directory")]);
    const result = await resolveFileLink(client, target, new AbortController().signal);
    expect(result.entry).toEqual(entry(root, "directory"));
    expect(request.mock.calls.every(([connection]) => connection === client)).toBe(true);
    expect(request.mock.calls.every(([, query]) => query.id === "%0")).toBe(true);
  });

  it("uses fresh pane folder and prefers existing current-folder file", async () => {
    setup([entry(`${cwd}/note.txt`), entry(`${root}/note.txt`)]);
    const result = await resolveFileLink(
      client,
      { ...target, path: "/stale/note.txt", relativePath: "note.txt" },
      new AbortController().signal,
    );
    expect(result.entry.path).toBe(`${cwd}/note.txt`);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects ambiguous ancestor matches", async () => {
    setup([entry(`${root}/note.txt`), entry("/home/dev/workspace/note.txt")]);
    await expect(
      resolveFileLink(
        client,
        { ...target, relativePath: "note.txt" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Multiple paths match");
  });

  it("does not reinterpret explicit relative or absolute paths", async () => {
    setup([entry(`${root}/note.txt`)]);
    await expect(
      resolveFileLink(
        client,
        { ...target, relativePath: "./note.txt" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Path not found");
    await expect(
      resolveFileLink(
        client,
        { ...target, relativePath: undefined, path: "/missing/note.txt" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Path not found");
  });

  it("preserves denied reads and cancellation", async () => {
    setup([]);
    const abort = new AbortController();
    abort.abort();
    await expect(resolveFileLink(client, target, abort.signal)).rejects.toThrow();
    request.mockRejectedValue(new Error("Access denied"));
    await expect(resolveFileLink(client, target, new AbortController().signal)).rejects.toThrow(
      "Access denied",
    );
  });

  it("does not treat truncated listings as missing entries", async () => {
    setup([]);
    request
      .mockResolvedValueOnce({ kind: "context", path: cwd, root, branch: null })
      .mockResolvedValueOnce({ kind: "list", path: cwd, entries: [], truncated: true });
    await expect(resolveFileLink(client, target, new AbortController().signal)).rejects.toThrow(
      "Folder listing truncated",
    );
  });
});

it("rejects trailing slash on a file", async () => {
  setup([entry(`${cwd}/note.txt`)]);
  await expect(
    resolveFileLink(client, { ...target, relativePath: "note.txt/" }, new AbortController().signal),
  ).rejects.toThrow("Not a directory");
});

it("opens current and parent directory references using server canonical path", async () => {
  setup([]);
  request
    .mockResolvedValueOnce({ kind: "context", path: cwd, root, branch: null })
    .mockResolvedValueOnce({ kind: "list", path: root, entries: [], truncated: false });
  const result = await resolveFileLink(
    client,
    { ...target, relativePath: "../" },
    new AbortController().signal,
  );
  expect(result.entry).toMatchObject({ path: root, type: "directory" });
});

it("does not fall back after cancellation during a listing", async () => {
  const abort = new AbortController();
  setup([]);
  request
    .mockResolvedValueOnce({ kind: "context", path: cwd, root, branch: null })
    .mockImplementationOnce(async () => {
      abort.abort();
      return { kind: "list", path: cwd, entries: [], truncated: false };
    });
  await expect(resolveFileLink(client, target, abort.signal)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
});
