import type { MainTab } from "./main-tabs-store";

interface WorkspaceTitleContext {
  tab?: MainTab;
  session?: string | null;
  machine?: string;
  editorFile?: string | null;
  mobileView?: "terminal" | "sessions" | "files" | "settings";
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** Use labels as text. Remove controls that can hide or reorder title text. */
function title(...labels: (string | null | undefined)[]): string {
  return ["TmuxDE", ...labels.map((label) => label?.replace(/[\p{Cc}\p{Cf}]/gu, "").trim())]
    .filter(Boolean)
    .join(" | ");
}

export function workspaceTitle({
  tab,
  session,
  machine,
  editorFile,
  mobileView,
}: WorkspaceTitleContext): string {
  if (editorFile) return title(basename(editorFile));
  if (mobileView && mobileView !== "terminal") {
    const label = { sessions: "Sessions", files: "Files", settings: "Settings" }[mobileView];
    return title(label);
  }
  if (!tab) return title(session || machine);
  switch (tab.kind) {
    case "file":
      return title(basename(tab.path));
    case "commit":
      return title(tab.subject || tab.hash.slice(0, 7));
    case "graph":
      return title("Graph", basename(tab.contextPath));
    case "changes":
      return title("Changes", basename(tab.contextPath));
    case "settings":
      return title("Settings");
    case "overview":
      return title("Overview");
  }
}
