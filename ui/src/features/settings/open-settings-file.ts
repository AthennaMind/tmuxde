import type { UserDocumentName } from "@/protocol";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useUiStore } from "@/features/workspace/ui-store";
import { isMobileViewport } from "@/shared/mobile-query";

/** Open a settings file in its JSON tab. A phone shows main tabs on its terminal screen. */
export function openSettingsFile(name: UserDocumentName): void {
  useMainTabsStore.getState().openJsonSettings(name);
  if (isMobileViewport()) useUiStore.getState().setMobileTab("terminal");
}
