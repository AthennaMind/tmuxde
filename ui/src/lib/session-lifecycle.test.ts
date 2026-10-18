import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneInfo, SessionInfo } from "@/protocol";
import {
  applySessionList,
  findRenames,
  forgetMissingSession,
  forgetSession,
  isAttachFallout,
  isGone,
  isRenamedAway,
  noteSessionCreated,
  renamedTo,
  resetSessionLifecycleForTests,
  sessionNotFoundText,
} from "@/lib/session-lifecycle";
import {
  believedInCopyMode,
  noteEnteredCopyMode,
  resetCopyModeBeliefForTests,
} from "@/lib/copy-mode-belief";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionTreeStore } from "@/stores/session-tree-store";

const LAST = "tmuxde-last-session";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function session(name: string, id: string, windows = 1): SessionInfo {
  return {
    name,
    id,
    windows,
    attached: false,
    created: "2026-10-12T00:00:00.000Z",
    activity: "2026-10-12T00:00:00.000Z",
  };
}

const pane: PaneInfo = {
  id: "%1",
  index: 0,
  windowId: "@1",
  active: true,
  zoomed: false,
  dimensions: { cols: 80, rows: 24 },
  position: { x: 0, y: 0 },
  path: "/home/user/repo",
};

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", memoryStorage());
  resetSessionLifecycleForTests();
  resetCopyModeBeliefForTests();
  useSessionStore.setState({
    sessions: [],
    sessionsLoaded: false,
    activeSessionId: null,
    openedSessions: [],
  });
  useSessionTreeStore.setState({
    details: {},
    loading: {},
    attachedSession: null,
    attachCount: 0,
  });
  usePaneStore.getState().clearAll();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("findRenames", () => {
  it("pairs a name that kept its id", () => {
    expect(
      findRenames(
        [session("a", "$1"), session("b", "$2")],
        [session("b", "$2"), session("c", "$1")],
      ),
    ).toEqual([["a", "c"]]);
  });

  it("does not read a kill and a create as a rename", () => {
    expect(findRenames([session("a", "$1")], [session("c", "$7")])).toEqual([]);
  });

  it("ignores sessions without an id", () => {
    expect(findRenames([session("a", "")], [session("c", "")])).toEqual([]);
  });

  it("does not move a name that is still listed", () => {
    // The id moved to a name that already existed. Not a rename this list
    // can prove.
    expect(
      findRenames(
        [session("a", "$1"), session("b", "$2")],
        [session("a", "$3"), session("b", "$1")],
      ),
    ).toEqual([]);
  });
});

describe("applySessionList", () => {
  it("follows a rename of the active session", () => {
    // The browser kept the old name after a rename. Window and pane polls
    // then failed, and the terminal said it was attached to a session that
    // no longer existed.
    useSessionStore.getState().setSessions([session("p9-a", "$1")]);
    useSessionStore.getState().setActiveSession("p9-a");
    localStorage.setItem(LAST, "p9-a");
    noteEnteredCopyMode("p9-a");

    applySessionList([session("p9-b", "$1")]);

    const store = useSessionStore.getState();
    expect(store.activeSessionId).toBe("p9-b");
    expect(store.openedSessions).toEqual(["p9-b"]);
    expect(store.sessions.map((s) => s.name)).toEqual(["p9-b"]);
    expect(localStorage.getItem(LAST)).toBe("p9-b");
    expect(renamedTo("p9-a")).toBe("p9-b");
    expect(believedInCopyMode("p9-a")).toBe(false);
    expect(believedInCopyMode("p9-b")).toBe(true);
  });

  it("marks the old name, until a session takes it again", () => {
    // The Node relay reports a rename as an exit of the old name.
    useSessionStore.getState().setSessions([session("a", "$1")]);
    applySessionList([session("b", "$1")]);
    expect(isRenamedAway("a")).toBe(true);
    noteSessionCreated(session("a", "$4"));
    expect(isRenamedAway("a")).toBe(false);
  });

  it("follows a chain of renames", () => {
    useSessionStore.getState().setSessions([session("a", "$1")]);
    applySessionList([session("b", "$1")]);
    applySessionList([session("c", "$1")]);
    expect(renamedTo("a")).toBe("c");
    expect(renamedTo("b")).toBe("c");
  });

  it("leaves other sessions alone", () => {
    useSessionStore.getState().setSessions([session("a", "$1")]);
    useSessionStore.getState().setActiveSession("a");
    applySessionList([session("a", "$1", 2), session("b", "$2")]);
    expect(useSessionStore.getState().activeSessionId).toBe("a");
    expect(useSessionStore.getState().sessions[0]?.windows).toBe(2);
    expect(renamedTo("a")).toBeNull();
  });
});

describe("forgetSession", () => {
  it("clears a killed active session and the name kept for reloads", () => {
    // The layout restored the last session whenever nothing was active, so
    // a kill selected the dead session again and the attach never landed.
    useSessionStore.getState().setSessions([session("p9-c", "$3")]);
    useSessionStore.getState().setActiveSession("p9-c");
    useSessionTreeStore.getState().setAttachedSession("p9-c");
    usePaneStore.getState().setPanes([pane], "@1");
    localStorage.setItem(LAST, "p9-c");

    forgetSession("p9-c");

    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(localStorage.getItem(LAST)).toBeNull();
    expect(useSessionTreeStore.getState().attachedSession).toBeNull();
    // The Files view and the Changes badge read the pane from here.
    expect(usePaneStore.getState().panes).toEqual([]);
    expect(isGone("p9-c")).toBe(true);
  });

  it("falls back to another opened session", () => {
    useSessionStore.getState().setActiveSession("keep");
    useSessionStore.getState().setActiveSession("dead");
    localStorage.setItem(LAST, "dead");

    forgetSession("dead");

    expect(useSessionStore.getState().activeSessionId).toBe("keep");
    expect(localStorage.getItem(LAST)).toBe("keep");
  });

  it("keeps the active session when another one ends", () => {
    useSessionStore.getState().setActiveSession("work");
    useSessionTreeStore.getState().setAttachedSession("work");
    usePaneStore.getState().setPanes([pane], "@1");
    localStorage.setItem(LAST, "work");

    forgetSession("other");

    expect(useSessionStore.getState().activeSessionId).toBe("work");
    expect(localStorage.getItem(LAST)).toBe("work");
    expect(useSessionTreeStore.getState().attachedSession).toBe("work");
    expect(usePaneStore.getState().panes).toHaveLength(1);
  });

  it("lets a name come back", () => {
    forgetSession("again");
    expect(isGone("again")).toBe(true);
    noteSessionCreated(session("again", "$9"));
    expect(isGone("again")).toBe(false);
    forgetSession("again");
    applySessionList([session("again", "$9")]);
    expect(isGone("again")).toBe(false);
  });
});

describe("forgetMissingSession", () => {
  it("drops the session and quiets the replies sent with the attach", () => {
    vi.useFakeTimers();
    useSessionStore.getState().setActiveSession("p9-d");
    useSessionTreeStore.getState().setAttachedSession("before");
    localStorage.setItem(LAST, "p9-d");

    forgetMissingSession("p9-d");

    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(localStorage.getItem(LAST)).toBeNull();
    // The relay detaches before it looks the session up.
    expect(useSessionTreeStore.getState().attachedSession).toBeNull();
    expect(isAttachFallout("NOT_ATTACHED")).toBe(true);
    expect(isAttachFallout("SESSION_NOT_FOUND")).toBe(false);

    vi.advanceTimersByTime(3000);
    expect(isAttachFallout("NOT_ATTACHED")).toBe(false);
  });

  it("words the refusal as both relays do", () => {
    expect(sessionNotFoundText("p9-d")).toBe('Session "p9-d" not found');
  });
});

describe("session tree attach count", () => {
  it("counts attaches, not detaches", () => {
    // Files asks for the pane folder again on every attach. A remount
    // detaches and attaches the same name, and an answer given in between
    // said "No session attached" for good.
    const tree = useSessionTreeStore.getState();
    tree.setAttachedSession("work");
    tree.setAttachedSession(null);
    tree.setAttachedSession("work");
    expect(useSessionTreeStore.getState().attachCount).toBe(2);
  });
});
