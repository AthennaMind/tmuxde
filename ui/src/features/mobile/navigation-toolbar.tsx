import { useEffect, useMemo, type RefObject } from "react";
import { Keyboard, SlidersHorizontal } from "lucide-react";
import { createKeyRepeat } from "./key-repeat";
import { sendKeySequence } from "@/features/terminal/send-key";
import { useConnectionStore } from "@/features/connection/connection-store";
import { useSessionStore } from "@/features/session/session-store";
import { usePaneStore } from "@/features/panes/pane-store";

const keys = [
  { label: "Arrow left", text: "←", value: "\x1b[D" },
  { label: "Arrow down", text: "↓", value: "\x1b[B" },
  { label: "Arrow up", text: "↑", value: "\x1b[A" },
  { label: "Arrow right", text: "→", value: "\x1b[C" },
];

export function NavigationToolbar({
  onKeyboard,
  onMore,
  controlsTrigger,
  controlsOpen,
}: {
  onKeyboard: () => void;
  onMore: () => void;
  controlsTrigger: RefObject<HTMLButtonElement | null>;
  controlsOpen: boolean;
}) {
  const connected = useConnectionStore((s) => s.status === "connected");
  const session = useSessionStore((s) => s.activeSessionId);
  const pane = usePaneStore((s) => s.activePaneId);
  const repeat = useMemo(() => createKeyRepeat(sendKeySequence), []);
  const disabled = !connected || !session;
  useEffect(() => {
    const stop = () => repeat.stop();
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      stop();
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", stop);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [repeat, connected, session, pane, controlsOpen]);
  const keyClass =
    "flex h-11 min-w-0 items-center justify-center rounded-xl bg-surface-panel px-1 text-xs font-medium text-foreground active:bg-surface-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  return (
    <div
      role="group"
      aria-label="Terminal navigation"
      className="grid grid-cols-4 gap-1.5 px-2 pt-2 pb-1"
    >
      <button
        type="button"
        data-terminal-key
        className={keyClass}
        aria-label="Show keyboard"
        disabled={disabled}
        onClick={onKeyboard}
      >
        <Keyboard aria-hidden className="h-5 w-5" />
      </button>
      {[
        ["Esc", "\x1b"],
        ["Enter", "\r"],
      ].map(([label, value]) => (
        <button
          key={label}
          type="button"
          data-terminal-key
          className={keyClass}
          disabled={disabled}
          onClick={() => sendKeySequence(value!)}
        >
          {label}
        </button>
      ))}
      <button
        ref={controlsTrigger}
        type="button"
        className={`${keyClass} flex-col gap-0.5`}
        aria-label="Terminal controls"
        aria-haspopup="dialog"
        aria-expanded={controlsOpen}
        onClick={onMore}
      >
        <SlidersHorizontal aria-hidden className="size-4" />
        <span>Tools</span>
      </button>
      {keys.map((key) => (
        <button
          key={key.label}
          type="button"
          data-terminal-key
          className={`${keyClass} touch-none select-none`}
          aria-label={key.label}
          disabled={disabled}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            repeat.start(key.value);
          }}
          onPointerUp={() => repeat.stop()}
          onPointerCancel={() => repeat.stop()}
          onPointerLeave={() => repeat.stop()}
          onLostPointerCapture={() => repeat.stop()}
          onClick={(event) => {
            if (event.detail === 0) sendKeySequence(key.value);
          }}
        >
          {key.text}
        </button>
      ))}
    </div>
  );
}
