import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { USER_DOCUMENT_EMPTY } from "@/protocol";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/utils";
import { DocumentImport } from "./document-import";
import { exportUserDocument } from "./settings-export";
import { settingsCount } from "./settings-schema";
import { KEYBOARD_SHORTCUTS_SECTION, revealSettingsSection } from "./settings-reveal";
import { SettingsRow, SettingsSection, settingsFocus } from "./settings-rows";
import { flushSettingsSave, useUserDocumentsStore } from "./user-documents-store";

/**
 * The two synced documents as files: export, import and reset settings.
 *
 * Import takes either file. Keyboard shortcuts has the same buttons for the
 * keybindings file, plus its own Reset all. This section keeps both files
 * side by side for moving them to another server.
 */
export function SettingsFilesSection() {
  const text = useUserDocumentsStore((s) => s.documents.settings.text);
  return <SettingsFilesList text={text} />;
}

/**
 * The section for a given settings text. Split out so tests render it with
 * fixed values: a server render reads only initial store state.
 */
export function SettingsFilesList({ text }: { text: string }) {
  // Null when the file is broken. Reset still empties it.
  const count = useMemo(() => settingsCount(text), [text]);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const exportRef = useRef<HTMLButtonElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);

  async function reset() {
    setResetting(true);
    // A change still waiting for its save would land on top of the reset.
    await flushSettingsSave();
    const outcome = await useUserDocumentsStore
      .getState()
      .save("settings", USER_DOCUMENT_EMPTY.settings);
    setResetting(false);
    setConfirmingReset(false);
    if (outcome === "saved" || outcome === "unchanged") {
      toast.success("All settings use their defaults again");
      return;
    }
    // The sync toasts conflicts and failed saves already.
    if (outcome === "conflict") useUserDocumentsStore.getState().dismissConflict("settings");
  }

  return (
    <>
      <SettingsSection
        title="Settings files"
        description="Settings and keybindings are two JSON files on the server. Export them to keep a copy or to move them to another server."
      >
        <SettingsRow
          label="Settings"
          hint="Synced settings only. Settings marked This device are left out, and Reset keeps them."
          textLabel
        >
          {() => (
            <div className="flex flex-wrap gap-2">
              <Button
                ref={exportRef}
                size="sm"
                variant="outline"
                className="pointer-coarse:h-11"
                onClick={() => exportUserDocument("settings")}
              >
                Export settings
              </Button>
              {count !== 0 && (
                <Button
                  ref={resetRef}
                  size="sm"
                  variant="outline"
                  className="pointer-coarse:h-11"
                  onClick={() => setConfirmingReset(true)}
                >
                  Reset settings
                </Button>
              )}
            </div>
          )}
        </SettingsRow>
        <SettingsRow
          label="Keybindings"
          hint={
            <>
              Your changes to the default shortcuts.{" "}
              <button
                type="button"
                className={cn(
                  "rounded-sm font-medium text-foreground underline underline-offset-2 hover:text-primary",
                  settingsFocus,
                )}
                onClick={() => revealSettingsSection(KEYBOARD_SHORTCUTS_SECTION)}
              >
                Keyboard shortcuts
              </button>{" "}
              has the same buttons and Reset all.
            </>
          }
          textLabel
        >
          {() => (
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={() => exportUserDocument("keybindings")}
            >
              Export keybindings
            </Button>
          )}
        </SettingsRow>
        <SettingsRow
          label="Import a file"
          hint="Replaces settings or keybindings with an exported file. You confirm first."
          textLabel
        >
          {() => <DocumentImport />}
        </SettingsRow>
      </SettingsSection>

      <AlertDialog
        open={confirmingReset}
        onOpenChange={(open) => {
          if (!open && !resetting) setConfirmingReset(false);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // No trigger element, so Radix would leave focus on the body.
            // Reset is gone after a reset, so fall back to Export.
            event.preventDefault();
            (resetRef.current ?? exportRef.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Reset all settings?</AlertDialogTitle>
            <AlertDialogDescription>
              {count === null
                ? "The settings file has errors."
                : count === 1
                  ? "The settings file has 1 setting."
                  : `The settings file has ${count} settings.`}{" "}
              Resetting empties it, and every browser uses the default settings again. Settings
              marked This device and keyboard shortcuts stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting} className="pointer-coarse:h-11">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={resetting}
              className="pointer-coarse:h-11"
              onClick={(event) => {
                // Stay open while it saves.
                event.preventDefault();
                void reset();
              }}
            >
              {resetting ? "Resetting…" : "Reset settings"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
