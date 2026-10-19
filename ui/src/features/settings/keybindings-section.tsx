import { useId, useMemo, useRef, useState } from "react";
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
import { formatChord } from "@/features/keybindings/chord";
import { chordSpeech } from "@/features/keybindings/chord-speech";
import {
  COMMAND_GROUPS,
  COMMAND_IDS,
  COMMAND_INFO,
  type CommandId,
} from "@/features/keybindings/command-ids";
import { DEFAULT_KEYBINDINGS } from "@/features/keybindings/default-keybindings";
import { useKeybindingsStore } from "@/features/keybindings/keybindings-store";
import { resolveKeymap, type Keymap, type ResolvedBinding } from "@/features/keybindings/keymap";
import type { Platform } from "@/features/keybindings/platform";
import {
  BROKEN_DOCUMENT,
  SCOPE_LABELS,
  applyShortcutChange,
  changedCommands,
  entryCount,
  primaryBinding,
  removeShortcut,
  resetCommandEntries,
  type DocumentEdit,
} from "@/features/keybindings/shortcut-edit";
import { Kbd } from "@/features/palette/palette-primitives";
import { DocumentImport } from "./document-import";
import { openSettingsFile } from "./open-settings-file";
import { exportUserDocument } from "./settings-export";
import { SettingsSection } from "./settings-rows";
import { KEYBOARD_SHORTCUTS_SECTION } from "./settings-reveal";
import { ShortcutRecorder, type RecordedShortcut, type RecorderError } from "./shortcut-recorder";
import { useUserDocumentsStore } from "./user-documents-store";

/**
 * `fromStore` marks a failed save. The sync toasts those already, so callers
 * without an inline place for the error stay quiet.
 */
type EditResult = { ok: true } | ({ ok: false; fromStore: boolean } & RecorderError);

const SECTION_TITLE = "Keyboard shortcuts";

/** Buttons of a row, in their order. Focus moves between them after an edit. */
type RowAction = "change" | "remove" | "reset";

function toastError(result: RecorderError): void {
  toast.error(result.text, {
    duration: Infinity,
    closeButton: true,
    ...(result.action
      ? { action: { label: result.action.label, onClick: result.action.run } }
      : {}),
  });
}

/**
 * A later click of a double click. Remove and Reset change which buttons a
 * row shows, so that click lands on the one that moved under the pointer.
 * Keyboard presses report 0.
 */
function secondClick(event: React.MouseEvent): boolean {
  return event.detail > 1;
}

/** Where Reset takes a command, by how many default shortcuts it has. */
function resetTarget(defaults: number): string {
  if (defaults === 0) return "no shortcut";
  return defaults === 1 ? "its default shortcut" : "its default shortcuts";
}

/** "Ctrl =", "Ctrl = and Ctrl Shift =", one label per chord. */
function chordList(bindings: readonly ResolvedBinding[], platform: Platform): string {
  const labels = [...new Set(bindings.map((binding) => formatChord(binding.chord, platform)))];
  const last = labels.pop() ?? "";
  return labels.length ? `${labels.join(", ")} and ${last}` : last;
}

/**
 * Write the keybindings document through the documents store.
 *
 * The edit runs on the server copy: a document never loaded is loaded
 * first. A refused save reloads the server copy, which the list then shows,
 * and the refused text is dropped, since the recorder can build it again.
 */
async function editKeybindings(edit: (text: string) => DocumentEdit): Promise<EditResult> {
  const store = useUserDocumentsStore.getState();
  if (store.documents.keybindings.etag === null) await store.load("keybindings");
  const result = edit(useUserDocumentsStore.getState().documents.keybindings.text);
  if (!result.ok) {
    return {
      ok: false,
      fromStore: false,
      text: result.error,
      ...(result.error === BROKEN_DOCUMENT
        ? {
            action: {
              label: "Edit keybindings JSON",
              run: () => openSettingsFile("keybindings"),
            },
          }
        : {}),
    };
  }
  const outcome = await useUserDocumentsStore.getState().save("keybindings", result.text);
  if (outcome === "saved" || outcome === "unchanged") return { ok: true };
  if (outcome === "conflict") {
    useUserDocumentsStore.getState().dismissConflict("keybindings");
    return {
      ok: false,
      fromStore: true,
      text: "Shortcuts changed in another browser. Check the list, then try again.",
    };
  }
  const reason = useUserDocumentsStore.getState().documents.keybindings.lastError;
  return {
    ok: false,
    fromStore: true,
    text: reason
      ? `Unable to save. ${reason}`
      : "Unable to save. Check your connection and try again.",
  };
}

/**
 * Every command with its shortcuts, grouped as the registry groups them.
 *
 * Change records a new chord for the binding the hints show. Saving writes a
 * new entry plus a removal of the replaced default into the keybindings
 * document, which syncs to every browser. Remove takes that binding off
 * without a new one. Reset drops the document's entries for one command,
 * Reset all empties the document. The header also edits, exports and
 * imports the keybindings file. Touch layouts keep everything but Add and
 * Change, since recording needs a keyboard.
 */
export function KeyboardShortcutsSection({ touch = false }: { touch?: boolean }) {
  const keymap = useKeybindingsStore((s) => s.keymap);
  const text = useUserDocumentsStore((s) => s.documents.keybindings.text);
  return <KeyboardShortcutsList keymap={keymap} text={text} touch={touch} />;
}

/**
 * The section for a given keymap and keybindings text. Split out so tests
 * render it with fixed values: a server render reads only initial store
 * state.
 */
export function KeyboardShortcutsList({
  keymap,
  text,
  touch,
}: {
  keymap: Keymap;
  /** Keybindings document text, for Reset and Reset all. */
  text: string;
  touch: boolean;
}) {
  const { platform } = keymap;
  // Reset copy names what a command goes back to, so it needs the defaults.
  const defaults = useMemo(() => resolveKeymap(DEFAULT_KEYBINDINGS, [], platform), [platform]);
  const changed = useMemo(() => changedCommands(text), [text]);
  // Null when the file is not a JSON array. Reset all still empties it.
  const entries = useMemo(() => entryCount(text), [text]);
  const [editing, setEditing] = useState<CommandId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<RecorderError | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const base = useId();
  const sectionRef = useRef<HTMLDivElement>(null);
  const resetAllRef = useRef<HTMLButtonElement>(null);
  // Set while Remove or Reset saves. A second press meanwhile does nothing.
  const busyRef = useRef(false);
  const recordable = !touch;
  const actionId = (id: CommandId, action: RowAction) => `${base}${id}${action}`;

  /**
   * Focus the first of the row's buttons that is still there. An edit can
   * take the pressed one away, and on touch the whole row.
   */
  const focusRow = (id: CommandId, order: readonly RowAction[]) =>
    requestAnimationFrame(() => {
      for (const action of order) {
        const button = document.getElementById(actionId(id, action));
        if (button) {
          button.focus();
          return;
        }
      }
      sectionRef.current?.focus();
    });

  /** Close the recorder and give focus back to the row's Change button. */
  const finish = (id: CommandId) => {
    setEditing(null);
    setError(null);
    focusRow(id, ["change"]);
  };

  /** Run a row edit that is not the recorder's. One at a time. */
  async function rowEdit(id: CommandId, edit: (text: string) => DocumentEdit) {
    if (busyRef.current) return null;
    busyRef.current = true;
    if (editing === id) {
      setEditing(null);
      setError(null);
    }
    try {
      return await editKeybindings(edit);
    } finally {
      busyRef.current = false;
    }
  }

  async function saveShortcut(id: CommandId, shortcut: RecordedShortcut) {
    const replacing = primaryBinding(keymap, id);
    setSaving(true);
    const result = await editKeybindings((current) =>
      applyShortcutChange(
        current,
        {
          command: id,
          chord: shortcut.chord,
          scope: shortcut.scope,
          ...(replacing ? { replacing } : {}),
        },
        platform,
      ),
    );
    setSaving(false);
    if (!result.ok) {
      setError(result);
      return;
    }
    toast.success(`${COMMAND_INFO[id].title} now uses ${formatChord(shortcut.chord, platform)}`);
    finish(id);
  }

  async function remove(id: CommandId) {
    const binding = primaryBinding(keymap, id);
    if (!binding) return;
    // A removal entry drops every binding of the chord, whatever its scope.
    const others = keymap.bindingsFor(id).filter((b) => b.chordKey !== binding.chordKey);
    const result = await rowEdit(id, (current) =>
      removeShortcut(current, { command: id, binding }, platform),
    );
    if (!result) return;
    if (!result.ok) {
      if (!result.fromStore) toastError(result);
      return;
    }
    const title = COMMAND_INFO[id].title;
    if (others.length === 0) toast.success(`${title} has no shortcut now`);
    else {
      toast.success(`${title} no longer uses ${formatChord(binding.chord, platform)}`, {
        description: `It still uses ${chordList(others, platform)}.`,
      });
    }
    // Remove stays while other shortcuts do. Otherwise the row's next button.
    focusRow(id, ["remove", "change", "reset"]);
  }

  async function reset(id: CommandId) {
    const result = await rowEdit(id, (current) => resetCommandEntries(current, id));
    if (!result) return;
    if (result.ok) {
      const title = COMMAND_INFO[id].title;
      const count = defaults.bindingsFor(id).length;
      toast.success(
        count === 0 ? `${title} has no shortcut now` : `${title} uses ${resetTarget(count)} again`,
      );
      // Reset leaves with the change it undid. Keep focus in the row.
      focusRow(id, ["change", "remove"]);
    } else if (!result.fromStore) toastError(result);
  }

  async function resetAll() {
    setSaving(true);
    const result = await editKeybindings(() => ({
      ok: true,
      text: USER_DOCUMENT_EMPTY.keybindings,
    }));
    setSaving(false);
    setConfirmingReset(false);
    if (result.ok) toast.success("All shortcuts use their defaults again");
    else if (!result.fromStore) toastError(result);
  }

  return (
    // A target for the shortcuts dialog's link. See settings-reveal.ts. Named,
    // so moving focus here announces the section.
    <div
      ref={sectionRef}
      role="group"
      aria-label={SECTION_TITLE}
      data-settings-section={KEYBOARD_SHORTCUTS_SECTION}
      tabIndex={-1}
      className="scroll-mt-6"
    >
      <SettingsSection
        title={SECTION_TITLE}
        description={
          touch
            ? "Shortcuts for a hardware keyboard. Recording a shortcut needs a keyboard."
            : "Global works everywhere. Outside terminal leaves the key to the shell while the terminal has focus. Changes sync to every browser."
        }
        action={
          // A full line under the description. Beside it, four buttons would
          // squeeze the text into a narrow column.
          <div className="flex basis-full flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                aria-label="Edit JSON for keybindings"
                onClick={() => openSettingsFile("keybindings")}
              >
                Edit JSON
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                aria-label="Export keybindings"
                onClick={() => exportUserDocument("keybindings")}
              >
                Export
              </Button>
              <DocumentImport only="keybindings" aria-label="Import keybindings" />
            </div>
            {entries !== 0 && (
              <Button
                ref={resetAllRef}
                variant="outline"
                size="sm"
                className="pointer-coarse:h-11"
                aria-label="Reset all shortcuts"
                onClick={() => setConfirmingReset(true)}
              >
                Reset all
              </Button>
            )}
          </div>
        }
      >
        {COMMAND_GROUPS.map((group) => {
          const headingId = `${base}${group.id}`;
          // Touch skips commands without a shortcut, unless Reset can bring
          // one back. Nothing to see or do there.
          const ids = COMMAND_IDS.filter(
            (id) =>
              COMMAND_INFO[id].group === group.id &&
              (recordable || keymap.bindingsFor(id).length > 0 || changed.has(id)),
          );
          if (ids.length === 0) return null;
          return (
            <div key={group.id}>
              <h3
                id={headingId}
                className="px-4 pt-3.5 pb-1 text-[11px] font-semibold uppercase leading-4 tracking-wide text-muted-foreground"
              >
                {group.title}
              </h3>
              <ul aria-labelledby={headingId} className="divide-y divide-line-subtle">
                {ids.map((id) => (
                  <ShortcutRow
                    key={id}
                    id={id}
                    keymap={keymap}
                    platform={platform}
                    recordable={recordable}
                    changed={changed.has(id)}
                    defaults={defaults.bindingsFor(id).length}
                    editing={editing === id}
                    actionId={(action) => actionId(id, action)}
                    onEdit={() => {
                      setError(null);
                      setEditing(editing === id ? null : id);
                    }}
                    onRemove={() => void remove(id)}
                    onReset={() => void reset(id)}
                  >
                    {editing === id && (
                      <ShortcutRecorder
                        command={id}
                        replacing={primaryBinding(keymap, id)}
                        keymap={keymap}
                        platform={platform}
                        saving={saving}
                        error={error}
                        onSave={(shortcut) => void saveShortcut(id, shortcut)}
                        onCancel={() => finish(id)}
                      />
                    )}
                  </ShortcutRow>
                ))}
              </ul>
            </div>
          );
        })}
      </SettingsSection>

      <AlertDialog
        open={confirmingReset}
        onOpenChange={(open) => {
          if (!open && !saving) setConfirmingReset(false);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // No trigger element, so Radix would leave focus on the body.
            // Reset all is gone after a reset, so fall back to the section.
            event.preventDefault();
            (resetAllRef.current ?? sectionRef.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Reset all shortcuts?</AlertDialogTitle>
            <AlertDialogDescription>
              {entries === null
                ? "The keybindings file has errors."
                : entries === 1
                  ? "The keybindings file has 1 entry."
                  : `The keybindings file has ${entries} entries.`}{" "}
              Resetting empties it, and every browser uses the default shortcuts again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving} className="pointer-coarse:h-11">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              className="pointer-coarse:h-11"
              onClick={(event) => {
                // Stay open while it saves.
                event.preventDefault();
                void resetAll();
              }}
            >
              {saving ? "Resetting…" : "Reset all shortcuts"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * One command: title, shortcuts, then its buttons in a fixed order. Change
 * or Add, Remove while it has a shortcut, Reset while the document holds
 * entries for it.
 */
function ShortcutRow({
  id,
  keymap,
  platform,
  recordable,
  changed,
  defaults,
  editing,
  actionId,
  onEdit,
  onRemove,
  onReset,
  children,
}: {
  id: CommandId;
  keymap: Keymap;
  platform: Platform;
  /** Add and Change record a chord, so they need a keyboard. */
  recordable: boolean;
  changed: boolean;
  /** Default shortcuts the command has, for Reset's name. */
  defaults: number;
  editing: boolean;
  actionId: (action: RowAction) => string;
  onEdit: () => void;
  onRemove: () => void;
  onReset: () => void;
  children?: React.ReactNode;
}) {
  const title = COMMAND_INFO[id].title;
  const bindings = keymap.bindingsFor(id);
  const primary = primaryBinding(keymap, id);
  const verb = bindings.length ? "Change" : "Add";
  // With more than one chord, Remove names the one it takes off.
  const several = bindings.some((binding) => binding.chordKey !== primary?.chordKey);
  const button = "pointer-coarse:h-11";
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <span className="min-w-0 flex-1 basis-48 text-sm leading-5 text-foreground text-pretty">
          {title}
        </span>
        <div className="flex max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
          {bindings.length > 0 ? (
            <ul
              aria-label={`Shortcuts for ${title}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
            >
              {bindings.map((binding) => (
                <li
                  key={`${binding.source}:${binding.index}:${binding.chordKey}`}
                  className="flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Kbd aria-hidden>{formatChord(binding.chord, platform)}</Kbd>
                  <span className="sr-only">{chordSpeech(binding.chord, platform)},</span>
                  <span className="text-xs text-muted-foreground">
                    {SCOPE_LABELS[binding.scope]}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-[13px] text-muted-foreground">No shortcut</span>
          )}
          {(recordable || primary || changed) && (
            <div className="flex flex-wrap gap-2">
              {recordable && (
                <Button
                  id={actionId("change")}
                  variant="outline"
                  size="sm"
                  className={button}
                  aria-label={`${verb} shortcut for ${title}`}
                  aria-expanded={editing}
                  onClick={onEdit}
                >
                  {verb}
                </Button>
              )}
              {primary && (
                <Button
                  id={actionId("remove")}
                  variant="outline"
                  size="sm"
                  className={button}
                  aria-label={
                    several
                      ? `Remove ${chordSpeech(primary.chord, platform)} from ${title}`
                      : `Remove shortcut for ${title}`
                  }
                  onClick={(event) => {
                    if (!secondClick(event)) onRemove();
                  }}
                >
                  Remove
                </Button>
              )}
              {changed && (
                <Button
                  id={actionId("reset")}
                  variant="outline"
                  size="sm"
                  className={button}
                  aria-label={`Reset ${title} to ${resetTarget(defaults)}`}
                  onClick={(event) => {
                    if (!secondClick(event)) onReset();
                  }}
                >
                  Reset
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {children}
    </li>
  );
}
