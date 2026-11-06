import { useEffect } from "react";
import { useMachineStore } from "@/features/connection/machine-store";
import { useSessionStore } from "@/features/session/session-store";
import { useFileStore } from "@/features/files/file-store";
import { MOBILE_MEDIA_QUERY } from "@/shared/mobile-query";
import { useStableMediaQuery } from "@/shared/use-media-query";
import { useMainTabsStore } from "./main-tabs-store";
import { useUiStore } from "./ui-store";
import { workspaceTitle } from "./workspace-title";

/** Mount inside lock gate so locking clears workspace names from title. */
export function useWorkspaceTitle(): void {
  const tab = useMainTabsStore((s) => s.tabs.find((item) => item.id === s.active));
  const session = useSessionStore((s) => s.activeSessionId);
  const machine = useMachineStore(
    (s) => s.machines.find((item) => item.id === s.activeMachine)?.name,
  );
  const editorFile = useFileStore((s) => s.editorFile);
  const mobileView = useUiStore((s) => s.mobileTab);
  const isMobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);
  const currentTitle = workspaceTitle({
    tab,
    session,
    machine,
    editorFile,
    mobileView: isMobile ? mobileView : undefined,
  });

  useEffect(() => {
    document.title = currentTitle;
    return () => {
      document.title = "TmuxDE";
    };
  }, [currentTitle]);
}
