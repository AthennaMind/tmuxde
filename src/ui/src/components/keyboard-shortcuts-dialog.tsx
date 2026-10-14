import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * On a phone every one of these is a button in the toolbar rather than a key
 * combination, because a soft keyboard has no modifiers to hold. The dialog
 * lists both so the answer to "how do I send Shift+Tab" is in one place.
 */
const agentKeys = [
  { keys: ["Shift", "Tab"], description: "Cycle Claude Code permission modes" },
  { keys: ["Alt", "Enter"], description: "Newline without sending" },
  { keys: ["Esc", "Esc"], description: "Rewind to edit the previous message" },
  { keys: ["Ctrl", "R"], description: "Expand the transcript" },
];

const shortcuts = [
  { keys: ["Ctrl/Cmd", "K"], description: "Open command palette" },
  { keys: ["Ctrl", "B"], description: "Toggle sidebar (outside the terminal)" },
  { keys: ["Ctrl", "E"], description: "Toggle files (outside the terminal)" },
  { keys: ["Ctrl/Cmd", "V"], description: "Paste a screenshot as a photo" },
  { keys: ["Ctrl", "Shift", "Space"], description: "Start or stop dictation" },
  { keys: ["Ctrl/Cmd", "+"], description: "Larger text, terminal or open file" },
  { keys: ["Ctrl/Cmd", "-"], description: "Smaller text, terminal or open file" },
  { keys: ["Ctrl/Cmd", "0"], description: "Reset text size" },
  { keys: ["Ctrl", "C"], description: "Interrupt" },
  { keys: ["Ctrl", "D"], description: "Send EOF" },
  { keys: ["Ctrl", "L"], description: "Clear terminal" },
  { keys: ["Ctrl", "Z"], description: "Suspend process" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
];

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "?" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.target as HTMLElement).tagName !== "INPUT" &&
        (e.target as HTMLElement).tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Agent CLIs
          </p>
          {agentKeys.map(({ keys, description }) => (
            <div
              key={description}
              className="flex items-center justify-between py-1"
            >
              <span className="text-sm text-muted-foreground">
                {description}
              </span>
              <div className="flex items-center gap-1">
                {keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono"
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
          <p className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            This app
          </p>
          {shortcuts.map(({ keys, description }) => (
            <div
              key={description}
              className="flex items-center justify-between py-1"
            >
              <span className="text-sm text-muted-foreground">
                {description}
              </span>
              <div className="flex items-center gap-1">
                {keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono"
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
