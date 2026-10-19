import { Button } from "@/components/ui/button";
import { cn } from "@/shared/utils";
import { DocumentImport } from "./document-import";
import { openSettingsFile } from "./open-settings-file";
import { exportUserDocument } from "./settings-export";
import { KEYBOARD_SHORTCUTS_SECTION, revealSettingsSection } from "./settings-reveal";
import { SettingsRow, SettingsSection, settingsFocus } from "./settings-rows";

/**
 * The two synced documents as files: edit as JSON, export, import.
 *
 * Import takes either file. Keyboard shortcuts has the same buttons for the
 * keybindings file, where people look for them. This section keeps both
 * files side by side for moving them to another server.
 */
export function SettingsFilesSection() {
  return (
    <SettingsSection
      title="Settings files"
      description="Settings and keybindings are two JSON files on the server. Edit them as text, or move them to another server."
    >
      <SettingsRow
        label="Settings"
        hint="Synced settings only. Settings marked This device are left out."
        textLabel
      >
        {() => (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={() => openSettingsFile("settings")}
            >
              Edit settings JSON
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={() => exportUserDocument("settings")}
            >
              Export settings
            </Button>
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
            has the same buttons.
          </>
        }
        textLabel
      >
        {() => (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={() => openSettingsFile("keybindings")}
            >
              Edit keybindings JSON
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={() => exportUserDocument("keybindings")}
            >
              Export keybindings
            </Button>
          </div>
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
  );
}
