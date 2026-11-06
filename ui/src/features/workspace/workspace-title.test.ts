import { describe, expect, it } from "vitest";
import { workspaceTitle } from "./workspace-title";
import type { MainTab } from "./main-tabs-store";

const origin = { machineId: "remote", sessionName: "workspace", paneId: "%1" };
const file: MainTab = { ...origin, id: "file", kind: "file", path: "/home/user/project/main.ts" };

describe("workspaceTitle", () => {
  it("uses base app name without workspace context", () => {
    expect(workspaceTitle({})).toBe("TmuxDE");
  });

  it("follows workspace name before machine name", () => {
    expect(workspaceTitle({ session: "project", machine: "Mac" })).toBe("TmuxDE | project");
    expect(workspaceTitle({ machine: "Mac" })).toBe("TmuxDE | Mac");
  });

  it("uses active file name without exposing its full path", () => {
    expect(workspaceTitle({ tab: file, session: "another-workspace" })).toBe("TmuxDE | main.ts");
  });

  it("keeps file names for diff tabs", () => {
    expect(workspaceTitle({ tab: { ...file, scope: "staged" } })).toBe("TmuxDE | main.ts");
  });

  it.each([
    [{ id: "settings", kind: "settings" }, "TmuxDE | Settings"],
    [{ id: "overview", kind: "overview" }, "TmuxDE | Overview"],
    [
      { ...origin, id: "graph", kind: "graph", contextPath: "/repo/project/" },
      "TmuxDE | Graph | project",
    ],
    [
      { ...origin, id: "changes", kind: "changes", contextPath: "/repo/project" },
      "TmuxDE | Changes | project",
    ],
    [
      {
        ...origin,
        id: "commit",
        kind: "commit",
        contextPath: "/repo",
        hash: "abcdef1234",
        subject: "Fix layout",
      },
      "TmuxDE | Fix layout",
    ],
    [
      {
        ...origin,
        id: "commit",
        kind: "commit",
        contextPath: "/repo",
        hash: "abcdef1234",
        subject: "",
      },
      "TmuxDE | abcdef1",
    ],
  ] satisfies [MainTab, string][])("names active view %j", (tab, expected) => {
    expect(workspaceTitle({ tab })).toBe(expected);
  });

  it.each(["sessions", "files", "settings"] as const)("follows mobile %s view", (mobileView) => {
    expect(workspaceTitle({ tab: file, mobileView })).toBe(
      `TmuxDE | ${mobileView[0]!.toUpperCase()}${mobileView.slice(1)}`,
    );
  });

  it("prefers visible file overlay over workspace and mobile views", () => {
    expect(
      workspaceTitle({ tab: file, editorFile: "/other/notes.md", mobileView: "settings" }),
    ).toBe("TmuxDE | notes.md");
  });

  it("preserves Unicode and markup as plain title text", () => {
    expect(workspaceTitle({ editorFile: "/repo/日本語 <script>.ts" })).toBe(
      "TmuxDE | 日本語 <script>.ts",
    );
  });

  it("removes control and bidi formatting characters from labels", () => {
    expect(workspaceTitle({ session: "\u202eproject\n\t\u0000" })).toBe("TmuxDE | project");
    expect(workspaceTitle({ session: " \n " })).toBe("TmuxDE");
  });
});
