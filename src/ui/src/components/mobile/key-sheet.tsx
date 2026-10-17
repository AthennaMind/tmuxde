import { useState } from "react";
import { Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { GROUP_LABELS, useSettingsStore, type ToolbarKeyGroup } from "@/stores/settings-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { sendKeySequence } from "@/lib/send-key";

const groups: ToolbarKeyGroup[] = ["agent", "core", "edit", "nav", "symbol"];
const coreIds = new Set(["esc", "tab", "ctrl", "alt", "left", "down", "up", "right"]);
const labels: Record<string, string> = {
  "shift-tab": "Shift+Tab", "alt-enter": "Alt+Enter", "shift-enter": "Shift+Enter",
  "word-left": "Word left", "word-right": "Word right",
};
const keyLabel = (key: { id: string; label: string }) => labels[key.id] ?? key.label.replace(/^\^([A-Z])$/, "Ctrl+$1");

/** Complete sequences bypass sticky modifiers. Pinning never sends input. */
export function TerminalKeys() {
  const [group, setGroup] = useState<ToolbarKeyGroup | "pinned">("pinned");
  const keys = useSettingsStore((s) => s.toolbarKeys);
  const togglePin = useSettingsStore((s) => s.toggleToolbarKey);
  const connected = useConnectionStore((s) => s.status === "connected");
  const session = useSessionStore((s) => s.activeSessionId);
  const visible = keys.filter((key) => key.key !== "" && (group === "pinned" ? key.visible && !coreIds.has(key.id) : key.group === group));
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="terminal-key-group" className="text-sm font-medium">Key group</label>
        <select id="terminal-key-group" value={group} onChange={(event) => setGroup(event.target.value as typeof group)}
          className="h-11 min-w-0 rounded-xl border border-input bg-surface-panel px-3 text-base">
          <option value="pinned">Pinned keys</option>
          {groups.map((id) => <option key={id} value={id}>{GROUP_LABELS[id]}</option>)}
        </select>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{group === "core" ? "Basic keys always stay beside terminal." : "Tap to send. Pin keys for quick access."}</p>
      {visible.length ? <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {visible.map((key) => <li key={key.id} className="flex min-w-0 items-stretch rounded-xl bg-surface-panel">
          <button type="button" disabled={!connected || !session} title={key.hint}
            aria-label={key.hint ? `${keyLabel(key)}: ${key.hint}` : keyLabel(key)}
            className="min-h-14 min-w-0 flex-1 rounded-s-xl px-2 py-2 font-mono text-sm font-medium disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-surface-hover"
            onClick={() => sendKeySequence(key.key)}>{keyLabel(key)}</button>
          {!coreIds.has(key.id) && <button type="button" aria-pressed={key.visible} title={key.visible ? "Unpin key" : "Pin key"}
            aria-label={`${key.visible ? "Unpin" : "Pin"} ${keyLabel(key)}`}
            onClick={() => togglePin(key.id)}
            className={cn("flex min-h-11 w-11 shrink-0 items-center justify-center rounded-e-xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-surface-hover", key.visible ? "text-primary" : "text-muted-foreground")}>
            <Pin aria-hidden className="size-4" fill={key.visible ? "currentColor" : "none"} />
          </button>}
        </li>)}
      </ul> : <p role="status" className="py-4 text-sm text-muted-foreground">No pinned keys. Choose another group and pin keys you use often.</p>}
    </div>
  );
}
