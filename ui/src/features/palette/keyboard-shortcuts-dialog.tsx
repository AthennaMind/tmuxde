import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatChord, parseChord, type Chord } from "@/features/keybindings/chord";
import { chordSpeech } from "@/features/keybindings/chord-speech";
import { COMMAND_GROUPS, COMMAND_IDS, COMMAND_INFO } from "@/features/keybindings/command-ids";
import { runCommand } from "@/features/keybindings/commands";
import { useKeybindingsStore } from "@/features/keybindings/keybindings-store";
import type { Keymap } from "@/features/keybindings/keymap";
import type { Platform } from "@/features/keybindings/platform";
import { SCOPE_LABELS } from "@/features/keybindings/shortcut-edit";
import {
  KEYBOARD_SHORTCUTS_SECTION,
  revealSettingsSection,
} from "@/features/settings/settings-reveal";
import { Kbd } from "./palette-primitives";
import { useShortcutsDialog } from "./shortcuts-dialog-store";

/**
 * On a phone every one of these is a button in the toolbar rather than a key
 * combination, because a soft keyboard has no modifiers to hold. The dialog
 * lists both so the answer to "how do I send Shift+Tab" is in one place.
 */
const agentKeys = [
  { chords: ["shift+tab"], description: "Cycle Claude Code permission modes" },
  { chords: ["alt+enter"], description: "Newline without sending" },
  // A sequence: Escape twice. One key per chord.
  { chords: ["escape", "escape"], description: "Rewind to edit the previous message" },
  { chords: ["ctrl+r"], description: "Expand the transcript" },
];

/** Keys that are no bindings: they go to the shell, or work in one place only. */
const fixedKeys = [
  { chords: ["ctrl+c"], description: "Interrupt, in the terminal" },
  { chords: ["ctrl+d"], description: "Send EOF, in the terminal" },
  { chords: ["ctrl+l"], description: "Clear terminal" },
  { chords: ["ctrl+z"], description: "Suspend process" },
  { chords: ["mod+enter"], description: "Run typed text in the terminal, from the palette" },
  { chords: ["mod+v"], description: "Paste a screenshot as a photo" },
];

const HEADING_CLASS =
  "pt-3 pb-1 text-[11px] font-semibold uppercase leading-4 tracking-wide text-muted-foreground";

interface ShortcutKey {
  label: string;
  /** Words for screen readers. Mac symbols read badly. */
  speech: string;
  /** Scope, when it is not the same for every key of the row. */
  note?: string;
}

function ShortcutRow({
  description,
  keys,
  note,
}: {
  description: string;
  keys: ShortcutKey[];
  note?: string;
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-1">
      <span className="min-w-0 text-sm leading-5 text-muted-foreground text-pretty">
        {description}
        {note && <span className="text-xs"> · {note}</span>}
      </span>
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {keys.map((key, index) => (
          <span key={index} className="flex items-center gap-1">
            <Kbd aria-hidden>{key.label}</Kbd>
            <span className="sr-only">{key.speech}</span>
            {key.note && <span className="text-xs text-muted-foreground">{key.note}</span>}
          </span>
        ))}
      </span>
    </li>
  );
}

function keyOf(chord: Chord, platform: Platform): ShortcutKey {
  return { label: formatChord(chord, platform), speech: chordSpeech(chord, platform) };
}

/** Fixed keys in chord grammar, one `Kbd` per chord, like the bound ones. */
function fixedKeysOf(chords: readonly string[], platform: Platform): ShortcutKey[] {
  return chords.map((text) => {
    const parsed = parseChord(text, platform);
    return parsed.ok ? keyOf(parsed.chord, platform) : { label: text, speech: text };
  });
}

/**
 * Bound commands per group, with their chords for this platform. A scope
 * shared by every chord of a row is named once beside the title. Mixed
 * scopes are named per chord. Global goes unsaid.
 */
function boundGroups(keymap: Keymap) {
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    rows: COMMAND_IDS.filter((id) => COMMAND_INFO[id].group === group.id).flatMap((id) => {
      const bindings = keymap.bindingsFor(id);
      if (!bindings.length) return [];
      const scope = bindings[0]?.scope ?? "global";
      const shared = bindings.every((binding) => binding.scope === scope);
      return [
        {
          id,
          description: COMMAND_INFO[id].title,
          note: shared && scope !== "global" ? SCOPE_LABELS[scope] : undefined,
          keys: bindings.map((binding) => ({
            ...keyOf(binding.chord, keymap.platform),
            note: shared ? undefined : SCOPE_LABELS[binding.scope],
          })),
        },
      ];
    }),
  })).filter((group) => group.rows.length > 0);
}

export function KeyboardShortcutsDialog() {
  const base = useId();
  const open = useShortcutsDialog((s) => s.open);
  const keymap = useKeybindingsStore((s) => s.keymap);
  const setOpen = (nextOpen: boolean) => useShortcutsDialog.setState({ open: nextOpen });
  const groups = open ? boundGroups(keymap) : [];
  // Set by Edit shortcuts. The dialog gives focus back to its opener as it
  // closes, so the section takes focus only after that.
  const revealOnClose = useRef(false);
  // A key or the palette opens the dialog, never a trigger, so Radix has no
  // element to give focus back to. Remember the one that had it.
  const opener = useRef<HTMLElement | null>(null);

  /** Opens Settings at its Keyboard shortcuts section. */
  const editShortcuts = () => {
    revealOnClose.current = true;
    setOpen(false);
    runCommand("settings.open");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto"
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          opener.current =
            active instanceof HTMLElement && active !== document.body ? active : null;
        }}
        onCloseAutoFocus={(event) => {
          const target = opener.current;
          opener.current = null;
          if (revealOnClose.current) {
            revealOnClose.current = false;
            event.preventDefault();
            revealSettingsSection(KEYBOARD_SHORTCUTS_SECTION);
            return;
          }
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts sync to every browser. Change them in Settings.
          </DialogDescription>
        </DialogHeader>
        <div>
          <section aria-labelledby={`${base}agent`}>
            <h3 id={`${base}agent`} className={HEADING_CLASS}>
              Agent CLIs
            </h3>
            <ul>
              {agentKeys.map(({ chords, description }) => (
                <ShortcutRow
                  key={description}
                  description={description}
                  keys={fixedKeysOf(chords, keymap.platform)}
                />
              ))}
            </ul>
          </section>
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={`${base}${group.id}`}>
              <h3 id={`${base}${group.id}`} className={HEADING_CLASS}>
                {group.title}
              </h3>
              <ul>
                {group.rows.map((row) => (
                  <ShortcutRow
                    key={row.id}
                    description={row.description}
                    keys={row.keys}
                    note={row.note}
                  />
                ))}
              </ul>
            </section>
          ))}
          <section aria-labelledby={`${base}other`}>
            <h3 id={`${base}other`} className={HEADING_CLASS}>
              Other keys
            </h3>
            <ul>
              {fixedKeys.map(({ chords, description }) => (
                <ShortcutRow
                  key={description}
                  description={description}
                  keys={fixedKeysOf(chords, keymap.platform)}
                />
              ))}
            </ul>
          </section>
        </div>
        <DialogFooter>
          <Button variant="outline" className="pointer-coarse:h-11" onClick={editShortcuts}>
            Edit shortcuts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
