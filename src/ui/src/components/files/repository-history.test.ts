import { describe, expect, it } from "vitest";
import {
  createRepositoryHistory,
  navigateRepositoryHistory,
  replaceRepositoryHistory,
  moveRepositoryHistory,
  repositoryHistoryState,
  readRepositoryHistory,
  type RepositoryView,
} from "./repository-history.js";

const root: RepositoryView = {
  tab: "files",
  directory: null,
  filter: "",
  preview: null,
};
const folder = { ...root, directory: "/project/src" };
const preview = { ...folder, preview: { path: "/project/src/index.ts" } };

describe("repository history", () => {
  it("restores directory, filter, tab and preview in both directions", () => {
    const filtered = { ...folder, filter: "index" };
    let history = createRepositoryHistory(root);
    history = navigateRepositoryHistory(history, filtered);
    history = navigateRepositoryHistory(history, {
      ...preview,
      filter: "index",
    });
    history = moveRepositoryHistory(history, -1);
    expect(history.entries[history.index]?.view).toEqual(filtered);
    history = moveRepositoryHistory(history, 1);
    expect(history.entries[history.index]?.view.preview).toEqual(
      preview.preview,
    );
    expect(moveRepositoryHistory(history, 1)).toBe(history);
  });

  it("discards forward branch after new navigation", () => {
    let history = createRepositoryHistory(root);
    history = navigateRepositoryHistory(history, folder);
    history = navigateRepositoryHistory(history, preview);
    history = moveRepositoryHistory(history, -1);
    history = navigateRepositoryHistory(history, { ...folder, tab: "changes" });
    expect(history.entries).toHaveLength(3);
    expect(history.entries.at(-1)?.view.tab).toBe("changes");
    expect(moveRepositoryHistory(history, 1)).toBe(history);
  });

  it("replaces current filter without adding steps or losing forward branch", () => {
    let history = createRepositoryHistory(root);
    history = navigateRepositoryHistory(history, folder);
    history = moveRepositoryHistory(history, -1);
    history = replaceRepositoryHistory(history, { ...root, filter: "readme" });
    expect(history.entries).toHaveLength(2);
    expect(history.entries[0]?.view.filter).toBe("readme");
    expect(moveRepositoryHistory(history, 1).entries[1]?.view).toEqual(folder);
  });

  it("bounds retained entries and never moves outside viewer history", () => {
    let history = createRepositoryHistory(root);
    for (let index = 0; index < 120; index++) {
      history = navigateRepositoryHistory(history, {
        ...root,
        directory: `/${index}`,
      });
    }
    expect(history.entries).toHaveLength(100);
    for (let index = 0; index < 100; index++)
      history = moveRepositoryHistory(history, -1);
    expect(history.index).toBe(0);
    expect(moveRepositoryHistory(history, -1)).toBe(history);
  });

  it("skips navigation to equal views", () => {
    const history = createRepositoryHistory(preview);
    expect(
      navigateRepositoryHistory(history, {
        ...preview,
        preview: { ...preview.preview },
      }),
    ).toBe(history);
  });
});

describe("native repository history", () => {
  it("assigns fresh entry IDs after restoring history from previous page load", () => {
    const history = createRepositoryHistory(root);
    history.entries[0]!.id = 1_000_000;
    const next = navigateRepositoryHistory(history, folder);
    expect(next.entries[1]!.id).toBeGreaterThan(1_000_000);
  });

  it("preserves framework state and restores viewer snapshot for matching pane", () => {
    const history = navigateRepositoryHistory(
      createRepositoryHistory(root),
      preview,
    );
    const state = repositoryHistoryState(
      { __NA: true, tree: ["route"] },
      "%1",
      history,
    );
    expect(state).toMatchObject({
      __NA: true,
      tree: ["route"],
      mobileTab: "files",
    });
    expect(readRepositoryHistory(state, "%1")).toEqual(history);
    expect(readRepositoryHistory(state, "%2")).toBeNull();
    expect(
      readRepositoryHistory({ ...state, mobileTab: "sessions" }, "%1"),
    ).toBeNull();
  });

  it("rejects malformed browser state", () => {
    expect(readRepositoryHistory(null, "%1")).toBeNull();
    expect(
      readRepositoryHistory(
        {
          mobileTab: "files",
          repository: { paneId: "%1", history: { entries: [{}], index: 0 } },
        },
        "%1",
      ),
    ).toBeNull();
  });

  it("restores a commit view and refuses a malformed one", () => {
    const commit = {
      ...root,
      tab: "history" as const,
      commit: { hash: "a".repeat(40), subject: "Fix it" },
    };
    const history = navigateRepositoryHistory(
      createRepositoryHistory(root),
      commit,
    );
    const state = repositoryHistoryState({}, "%1", history);
    expect(readRepositoryHistory(state, "%1")).toEqual(history);
    const bad = navigateRepositoryHistory(createRepositoryHistory(root), {
      ...commit,
      commit: { hash: "HEAD", subject: "" },
    });
    expect(
      readRepositoryHistory(repositoryHistoryState({}, "%1", bad), "%1"),
    ).toBeNull();
  });

  it("treats a different commit as a new step", () => {
    const first = { ...root, tab: "history" as const, commit: { hash: "a".repeat(40), subject: "" } };
    const second = { ...first, commit: { hash: "b".repeat(40), subject: "" } };
    const history = navigateRepositoryHistory(
      navigateRepositoryHistory(createRepositoryHistory(root), first),
      second,
    );
    expect(history.entries).toHaveLength(3);
  });
});

it("restores current changes detail and its pinned repository through back and forward", () => {
  const changes = { ...root, tab: "changes" as const };
  const detail = { ...changes, changesPath: "/repo" };
  let history = navigateRepositoryHistory(createRepositoryHistory(changes), detail);
  expect(history.entries).toHaveLength(2);
  const stored = repositoryHistoryState({}, "%1", history);
  expect(readRepositoryHistory(stored, "%1")?.entries[1]?.view).toEqual(detail);
  history = moveRepositoryHistory(history, -1);
  expect(history.entries[history.index]?.view).toEqual(changes);
  history = moveRepositoryHistory(history, 1);
  expect(history.entries[history.index]?.view).toEqual(detail);
});
